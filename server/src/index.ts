// index.ts
// Driftless sync server (Phase 2: accounts + vault + key directory).
// The server stores opaque ciphertext + non-secret metadata only. It never sees
// plaintext, the passphrase, or any encryption key. See ../SYNC_PLAN.md.

import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth";

type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  TOKEN_SECRET: string;
  ALLOWED_ORIGIN: string;
};

const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8 MB — per photo (images are compressed client-side)

// ---- Per-user storage quotas --------------------------------------------
// The point of these is cost safety, not stinginess: they are set far above any
// plausible human use, but they bound the worst case a single account (or a bot
// that slipped past the signup rate limit) can cost the person paying the
// Cloudflare bill. See ../HARDENING.md for the whole threat/cost model.
//
// Worst case per maxed account ≈ 100 MB (D1 text) + 2 GB (R2 media). R2 egress
// is free, so a maxed account costs pennies/month of storage; combined with the
// register rate limit that keeps the total bounded and predictable.
const MAX_USER_OBJECTS = 100_000; // entries + strands (incl. tombstones)
const MAX_USER_CONTENT_BYTES = 100 * 1024 * 1024; // 100 MB of text ciphertext
const MAX_USER_MEDIA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB of photos

// Current object footprint for a user: row count + total ciphertext bytes.
// One indexed query; runs once per push. Counts tombstones too, so a
// create/delete loop can't accumulate unbounded rows.
async function objectUsage(db: D1Database, userId: string): Promise<{ n: number; bytes: number }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM objects WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number; bytes: number }>();
  return { n: row?.n ?? 0, bytes: row?.bytes ?? 0 };
}

// Running media byte total, kept in user_usage (R2 has no cheap SUM). Absent row
// means zero.
async function mediaUsage(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT media_bytes AS b FROM user_usage WHERE user_id = ?")
    .bind(userId)
    .first<{ b: number }>();
  return row?.b ?? 0;
}

async function addMediaUsage(db: D1Database, userId: string, delta: number): Promise<void> {
  // Upsert, clamped at zero so a stray decrement can never go negative.
  await db
    .prepare(
      "INSERT INTO user_usage (user_id, media_bytes) VALUES (?, MAX(0, ?)) " +
        "ON CONFLICT(user_id) DO UPDATE SET media_bytes = MAX(0, media_bytes + ?)"
    )
    .bind(userId, delta, delta)
    .run();
}

type Vars = { userId: string };
type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ALLOWED_ORIGIN is a comma-separated allowlist, so the app can live on more
// than one origin at once — e.g. during a domain move (driftless-8nc.pages.dev →
// driftless.page), both keep working, so nobody's sync breaks mid-migration.
// Empty (dev) reflects any origin.
app.use("*", (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    origin: (origin) => (allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })(c, next);
});

// Bearer-token auth. Sets `userId` on success.
async function requireAuth(c: AppContext, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;
  if (!userId) return c.json({ error: "Not signed in." }, 401);
  c.set("userId", userId);
  await next();
}

// Fixed-window rate limit for the open endpoints. Returns true if the request
// is within the limit. Keyed by action + client IP + time bucket; one upsert
// (RETURNING the running count) plus an occasional sweep of expired rows. Only
// guards low-frequency abuse surfaces — never the authenticated sync path.
async function withinRateLimit(
  c: AppContext,
  action: string,
  limit: number,
  windowMs: number
): Promise<boolean> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = `${action}:${ip}:${Math.floor(Date.now() / windowMs)}`;
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
    )
      .bind(key, Date.now() + windowMs)
      .first<{ count: number }>();
    if (Math.random() < 0.02) {
      await c.env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(Date.now()).run();
    }
    return (row?.count ?? 1) <= limit;
  } catch {
    return true; // never let the limiter itself take the service down
  }
}
const TOO_MANY = "Too many attempts from here — please wait a little and try again.";

app.get("/health", (c) => c.json({ ok: true, service: "driftless-server" }));

// Who am I? (the token's user id) — used to mark authorship of shared pieces.
app.get("/me", requireAuth, (c) => c.json({ userId: c.get("userId") }));

// Delete every R2 object under a prefix, paginating through the listing. Used to
// sweep a user's private photos (u/<userId>/) or a strand's photos (s/<id>/).
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// Delete the account and everything the server holds for it. The passphrase was
// never here, so this is the whole server-side footprint: private objects, the
// vault record, private photos in R2, and shared-strand membership. Local data
// on the device is untouched — this only clears the cloud copy.
//
// It refuses to run while the user still OWNS a shared strand that other people
// are in: deleting that would quietly destroy someone else's copy of a shared
// memory. They must hand it over or remove the other members first. Strands they
// own alone are deleted in full.
app.delete("/me", requireAuth, async (c) => {
  const userId = c.get("userId");

  const owned = (await c.env.DB.prepare("SELECT strand_id FROM shared_strands WHERE owner_id = ?")
    .bind(userId).all<{ strand_id: string }>()).results ?? [];

  const blocking: string[] = [];
  const soloOwned: string[] = [];
  for (const { strand_id } of owned) {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM strand_members WHERE strand_id = ? AND user_id <> ?")
      .bind(strand_id, userId).first<{ n: number }>();
    ((row?.n ?? 0) > 0 ? blocking : soloOwned).push(strand_id);
  }
  if (blocking.length > 0) {
    return c.json({
      error: "You still own shared strand(s) that other people are in. Hand them over or remove the other members first, so nobody else loses a shared strand.",
      strands: blocking,
    }, 409);
  }

  // Strands they own alone: delete the photos, then every DB row.
  for (const strandId of soloOwned) {
    await deleteR2Prefix(c.env.MEDIA, `s/${strandId}/`);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM shared_objects WHERE strand_id = ?").bind(strandId),
      c.env.DB.prepare("DELETE FROM strand_invites WHERE strand_id = ?").bind(strandId),
      c.env.DB.prepare("DELETE FROM strand_members WHERE strand_id = ?").bind(strandId),
      c.env.DB.prepare("DELETE FROM shared_strands WHERE strand_id = ?").bind(strandId),
    ]);
  }

  // Their private photos, then the private DB footprint + any lingering
  // memberships in other people's strands.
  await deleteR2Prefix(c.env.MEDIA, `u/${userId}/`);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM strand_members WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM objects WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM vaults WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM user_usage WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);

  return c.json({ ok: true });
});

// ---- Media (M1: personal photos) -----------------------------------------
// R2 stores an opaque blob: iv||ciphertext, already encrypted on the device
// with the vault key. Keyed by owner; only the owner can read it back. Type is
// non-secret metadata so the client can render it. See MEDIA_PLAN.md.

app.put("/media/:id", requireAuth, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id")!;
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty upload" }, 400);
  if (body.byteLength > MAX_MEDIA_BYTES) return c.json({ error: "image too large" }, 413);
  const type = c.req.query("type") || "application/octet-stream";
  const key = `u/${userId}/${id}`;

  // Idempotent: photos are write-once (a client uuid per image), so a retried
  // upload of one already stored must not be double-counted against the quota.
  const already = await c.env.MEDIA.head(key);
  if (already) return c.json({ ok: true });

  if ((await mediaUsage(c.env.DB, userId)) + body.byteLength > MAX_USER_MEDIA_BYTES) {
    return c.json({ error: "This account has reached its photo storage limit." }, 413);
  }

  await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: type } });
  await addMediaUsage(c.env.DB, userId, body.byteLength);
  return c.json({ ok: true });
});

app.get("/media/:id", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const obj = await c.env.MEDIA.get(`u/${c.get("userId")}/${id}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=31536000",
    },
  });
});

// Free the storage when a photo is removed (M3). Idempotent.
app.delete("/media/:id", requireAuth, async (c) => {
  const userId = c.get("userId");
  const key = `u/${userId}/${c.req.param("id")!}`;
  // Read the size before deleting so the quota counter can be credited back.
  const obj = await c.env.MEDIA.head(key);
  await c.env.MEDIA.delete(key);
  if (obj) await addMediaUsage(c.env.DB, userId, -obj.size);
  return c.json({ ok: true });
});

// Shared-strand photos (M2): same as above but encrypted with the strand DEK
// and gated by membership. Keyed s/<strandId>/<mediaId>.
app.put("/shared/:id/media/:mid", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  const mid = c.req.param("mid")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "empty upload" }, 400);
  if (body.byteLength > MAX_MEDIA_BYTES) return c.json({ error: "image too large" }, 413);
  const type = c.req.query("type") || "application/octet-stream";
  await c.env.MEDIA.put(`s/${strandId}/${mid}`, body, { httpMetadata: { contentType: type } });
  return c.json({ ok: true });
});

app.get("/shared/:id/media/:mid", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  const mid = c.req.param("mid")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const obj = await c.env.MEDIA.get(`s/${strandId}/${mid}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=31536000",
    },
  });
});

app.delete("/shared/:id/media/:mid", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  const mid = c.req.param("mid")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  await c.env.MEDIA.delete(`s/${strandId}/${mid}`);
  return c.json({ ok: true });
});

// A calm "note to the maker". Open (no account needed) so even a first-time
// visitor can send a word. Stored separately from journal data; it's a plain
// message, never touching any ciphertext. Optional token just attributes it.
app.post("/feedback", async (c) => {
  if (!(await withinRateLimit(c, "feedback", 8, 3_600_000))) return c.json({ error: TOO_MANY }, 429);
  const b = await c.req.json().catch(() => null);
  const message = (b?.message ?? "").toString().trim();
  if (!message) return c.json({ error: "Say a little something first." }, 400);
  if (message.length > 4000) return c.json({ error: "That's a bit long — trim it a touch." }, 400);
  const contact = (b?.contact ?? "").toString().trim().slice(0, 200) || null;
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;
  await c.env.DB.prepare(
    "INSERT INTO feedback (id, created_at, message, contact, user_id) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), Date.now(), message.slice(0, 4000), contact, userId)
    .run();
  return c.json({ ok: true });
});

// ---- Sync (Phase 3) ------------------------------------------------------
// The server stores each entry's ciphertext + metadata and assigns a per-user
// monotonic `seq`. Push upserts with last-write-wins by updatedAt; pull returns
// everything with seq greater than the client's cursor. No plaintext is ever
// seen — content is an opaque CipherBlob.

const PULL_LIMIT = 500;
const MAX_PUSH = 1000;

const KINDS = ["entry", "strand"];

// SQLite upsert that applies last-write-wins: an incoming row only overwrites a
// stored one when its updatedAt is newer-or-equal. created_at is preserved.
const UPSERT_OBJECT = `
INSERT INTO objects (user_id, kind, id, created_at, updated_at, deleted, content, seq)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id, kind, id) DO UPDATE SET
  updated_at = excluded.updated_at,
  deleted    = excluded.deleted,
  content    = excluded.content,
  seq        = excluded.seq
WHERE excluded.updated_at >= objects.updated_at`;

function isCipherBlob(x: any): boolean {
  return x && Array.isArray(x.iv) && Array.isArray(x.data);
}
function validChange(ch: any): boolean {
  return (
    ch &&
    KINDS.includes(ch.kind) &&
    typeof ch.id === "string" &&
    typeof ch.createdAt === "number" &&
    typeof ch.updatedAt === "number" &&
    typeof ch.deleted === "boolean" &&
    isCipherBlob(ch.content)
  );
}
async function maxSeq(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM objects WHERE user_id = ?")
    .bind(userId)
    .first<{ m: number }>();
  return r?.m ?? 0;
}

app.post("/sync/push", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const changes = body?.changes;
  if (!Array.isArray(changes)) return c.json({ error: "changes must be an array" }, 400);
  if (changes.length > MAX_PUSH) return c.json({ error: `too many changes (max ${MAX_PUSH})` }, 400);
  for (const ch of changes) {
    if (!validChange(ch)) return c.json({ error: "malformed change" }, 400);
  }

  // Quota check before applying. We compare current stored footprint plus the
  // incoming batch against the caps. Incoming is counted in full (updates to
  // existing rows are over-counted as new) — deliberately conservative, and
  // irrelevant far below the ceiling where real journals live. A rejected push
  // leaves the client's data intact locally; it just can't upload more.
  const usage = await objectUsage(c.env.DB, userId);
  let addRows = 0;
  let addBytes = 0;
  for (const ch of changes) {
    addRows += 1;
    addBytes += JSON.stringify(ch.content).length;
  }
  if (usage.n + addRows > MAX_USER_OBJECTS || usage.bytes + addBytes > MAX_USER_CONTENT_BYTES) {
    return c.json(
      { error: "This account has reached its storage limit. Nothing was lost — it stays on your device." },
      413
    );
  }

  let applied = 0;
  if (changes.length > 0) {
    const base = await maxSeq(c.env.DB, userId);
    const stmts = changes.map((ch, i) =>
      c.env.DB.prepare(UPSERT_OBJECT).bind(
        userId,
        ch.kind,
        ch.id,
        ch.createdAt,
        ch.updatedAt,
        ch.deleted ? 1 : 0,
        JSON.stringify(ch.content),
        base + i + 1
      )
    );
    const res = await c.env.DB.batch(stmts);
    // meta.changes is 0 for rows skipped by the last-write-wins WHERE clause.
    applied = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return c.json({ applied, cursor: await maxSeq(c.env.DB, userId) });
});

app.get("/sync/pull", requireAuth, async (c) => {
  const userId = c.get("userId");
  const since = Math.max(0, Number(c.req.query("since") ?? "0") || 0);
  const rows = await c.env.DB.prepare(
    "SELECT kind, id, created_at, updated_at, deleted, content, seq FROM objects WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"
  )
    .bind(userId, since, PULL_LIMIT)
    .all<{
      kind: string;
      id: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      content: string;
      seq: number;
    }>();
  const results = rows.results ?? [];
  const changes = results.map((r) => ({
    kind: r.kind,
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted === 1,
    content: JSON.parse(r.content),
  }));
  const cursor = results.length ? results[results.length - 1].seq : since;
  return c.json({ changes, cursor, more: results.length === PULL_LIMIT });
});

// ---- Sharing (S2): membership-gated shared strands ----------------------

async function membership(db: D1Database, strandId: string, userId: string) {
  return db
    .prepare("SELECT role FROM strand_members WHERE strand_id = ? AND user_id = ?")
    .bind(strandId, userId)
    .first<{ role: string }>();
}
async function maxSharedSeq(db: D1Database, strandId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM shared_objects WHERE strand_id = ?")
    .bind(strandId)
    .first<{ m: number }>();
  return r?.m ?? 0;
}
function validSharedChange(ch: any): boolean {
  return (
    ch &&
    typeof ch.kind === "string" &&
    typeof ch.id === "string" &&
    typeof ch.createdAt === "number" &&
    typeof ch.updatedAt === "number" &&
    typeof ch.deleted === "boolean" &&
    typeof ch.dekEpoch === "number" &&
    isCipherBlob(ch.content)
  );
}
const UPSERT_SHARED = `
INSERT INTO shared_objects (strand_id, kind, id, created_at, updated_at, deleted, content, dek_epoch, seq)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(strand_id, id) DO UPDATE SET
  updated_at = excluded.updated_at,
  deleted    = excluded.deleted,
  content    = excluded.content,
  dek_epoch  = excluded.dek_epoch,
  seq        = excluded.seq
WHERE excluded.updated_at >= shared_objects.updated_at`;

// Create a shared strand + the owner's own membership (their wrapped DEK).
app.post("/shared/create", requireAuth, async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json().catch(() => null);
  const { strandId, ephemeralPub, wrappedDEK } = b ?? {};
  if (typeof strandId !== "string" || typeof ephemeralPub !== "string" || !wrappedDEK) {
    return c.json({ error: "missing fields" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT strand_id FROM shared_strands WHERE strand_id = ?")
    .bind(strandId)
    .first();
  if (exists) return c.json({ error: "strand already exists" }, 409);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO shared_strands (strand_id, owner_id, created_at) VALUES (?, ?, ?)").bind(
      strandId,
      userId,
      now
    ),
    c.env.DB.prepare(
      "INSERT INTO strand_members (strand_id, user_id, role, ephemeral_pub, wrapped_dek, dek_epoch, added_at) VALUES (?, ?, 'owner', ?, ?, 1, ?)"
    ).bind(strandId, userId, ephemeralPub, JSON.stringify(wrappedDEK), now),
  ]);
  return c.json({ ok: true });
});

// Invite a member (any member can; they hold the DEK to wrap for the invitee).
app.post("/shared/:id/invite", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const b = await c.req.json().catch(() => null);
  const email = (b?.memberEmail ?? "").trim().toLowerCase();
  const { ephemeralPub, wrappedDEK, dekEpoch } = b ?? {};
  if (!email || typeof ephemeralPub !== "string" || !wrappedDEK || typeof dekEpoch !== "number") {
    return c.json({ error: "missing fields" }, 400);
  }
  const member = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!member) return c.json({ error: "No Driftless account for that email." }, 404);
  await c.env.DB.prepare(
    `INSERT INTO strand_members (strand_id, user_id, role, ephemeral_pub, wrapped_dek, dek_epoch, added_at)
     VALUES (?, ?, 'member', ?, ?, ?, ?)
     ON CONFLICT(strand_id, user_id) DO UPDATE SET ephemeral_pub = excluded.ephemeral_pub, wrapped_dek = excluded.wrapped_dek, dek_epoch = excluded.dek_epoch`
  )
    .bind(strandId, member.id, ephemeralPub, JSON.stringify(wrappedDEK), dekEpoch, Date.now())
    .run();
  return c.json({ ok: true, userId: member.id });
});

// Members + their public keys (for re-wrapping / rotation).
app.get("/shared/:id/members", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT m.user_id, m.role, u.email, u.identity_pub FROM strand_members m JOIN users u ON u.id = m.user_id WHERE m.strand_id = ?"
  )
    .bind(strandId)
    .all<{ user_id: string; role: string; email: string; identity_pub: string | null }>();
  return c.json({
    members: (rows.results ?? []).map((r) => ({
      userId: r.user_id,
      role: r.role,
      email: r.email,
      identityPublicKey: r.identity_pub,
    })),
  });
});

// Strands I'm a member of, each with MY wrapped DEK.
app.get("/shared/mine", requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT s.strand_id, s.owner_id, m.role, m.ephemeral_pub, m.wrapped_dek, m.dek_epoch FROM strand_members m JOIN shared_strands s ON s.strand_id = m.strand_id WHERE m.user_id = ?"
  )
    .bind(c.get("userId"))
    .all<{ strand_id: string; owner_id: string; role: string; ephemeral_pub: string; wrapped_dek: string; dek_epoch: number }>();
  return c.json({
    strands: (rows.results ?? []).map((r) => ({
      strandId: r.strand_id,
      ownerId: r.owner_id,
      role: r.role,
      ephemeralPub: r.ephemeral_pub,
      wrappedDEK: JSON.parse(r.wrapped_dek),
      dekEpoch: r.dek_epoch,
    })),
  });
});

app.post("/shared/:id/push", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const b = await c.req.json().catch(() => null);
  const changes = b?.changes;
  if (!Array.isArray(changes)) return c.json({ error: "changes must be an array" }, 400);
  if (changes.length > MAX_PUSH) return c.json({ error: `too many changes (max ${MAX_PUSH})` }, 400);
  for (const ch of changes) if (!validSharedChange(ch)) return c.json({ error: "malformed change" }, 400);
  let applied = 0;
  if (changes.length > 0) {
    const base = await maxSharedSeq(c.env.DB, strandId);
    const stmts = changes.map((ch, i) =>
      c.env.DB.prepare(UPSERT_SHARED).bind(
        strandId,
        ch.kind,
        ch.id,
        ch.createdAt,
        ch.updatedAt,
        ch.deleted ? 1 : 0,
        JSON.stringify(ch.content),
        ch.dekEpoch,
        base + i + 1
      )
    );
    const res = await c.env.DB.batch(stmts);
    applied = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return c.json({ applied, cursor: await maxSharedSeq(c.env.DB, strandId) });
});

app.get("/shared/:id/pull", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const since = Math.max(0, Number(c.req.query("since") ?? "0") || 0);
  const rows = await c.env.DB.prepare(
    "SELECT kind, id, created_at, updated_at, deleted, content, dek_epoch, seq FROM shared_objects WHERE strand_id = ? AND seq > ? ORDER BY seq LIMIT ?"
  )
    .bind(strandId, since, PULL_LIMIT)
    .all<{
      kind: string;
      id: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      content: string;
      dek_epoch: number;
      seq: number;
    }>();
  const results = rows.results ?? [];
  const changes = results.map((r) => ({
    kind: r.kind,
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted === 1,
    content: JSON.parse(r.content),
    dekEpoch: r.dek_epoch,
  }));
  const cursor = results.length ? results[results.length - 1].seq : since;
  return c.json({ changes, cursor, more: results.length === PULL_LIMIT });
});

app.post("/shared/:id/leave", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  await c.env.DB.prepare("DELETE FROM strand_members WHERE strand_id = ? AND user_id = ?")
    .bind(strandId, c.get("userId"))
    .run();
  return c.json({ ok: true });
});

// Owner removes a member. (DEK rotation for future secrecy is client-driven — S4.)
app.post("/shared/:id/remove", requireAuth, async (c) => {
  const userId = c.get("userId");
  const strandId = c.req.param("id")!;
  const s = await c.env.DB.prepare("SELECT owner_id FROM shared_strands WHERE strand_id = ?")
    .bind(strandId)
    .first<{ owner_id: string }>();
  if (!s || s.owner_id !== userId) return c.json({ error: "only the owner can remove members" }, 403);
  const b = await c.req.json().catch(() => null);
  const target = b?.userId;
  if (typeof target !== "string" || target === userId) return c.json({ error: "bad target" }, 400);
  await c.env.DB.prepare("DELETE FROM strand_members WHERE strand_id = ? AND user_id = ?")
    .bind(strandId, target)
    .run();
  // A removal triggers a client-side re-key, so any outstanding invite links
  // (which carry the OLD DEK) must die — a new one can be made after.
  await c.env.DB.prepare("UPDATE strand_invites SET revoked = 1 WHERE strand_id = ?").bind(strandId).run();
  return c.json({ ok: true });
});

// ---- Invite links (S6) ---------------------------------------------------
// The server holds only opaque ciphertext (the DEK wrapped with the link's
// wrapKey) + a hash of the joinProof. It can neither read the strand nor forge
// a join. See SHARING_PLAN.md.

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function sha256B64(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let s = "";
  for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
  return btoa(s);
}

type InviteRow = {
  invite_id: string;
  strand_id: string;
  wrapped_dek: string;
  join_proof_hash: string;
  dek_epoch: number;
  expires_at: number;
  revoked: number;
  max_uses: number;
  uses: number;
};

// Member creates a shareable invite link for their strand.
app.post("/shared/:id/invite-link", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const b = await c.req.json().catch(() => null);
  const { inviteId, wrappedDEK, joinProofHash, dekEpoch, expiresAt, maxUses } = b ?? {};
  if (
    typeof inviteId !== "string" ||
    !isCipherBlob(wrappedDEK) ||
    typeof joinProofHash !== "string" ||
    typeof dekEpoch !== "number" ||
    typeof expiresAt !== "number"
  ) {
    return c.json({ error: "missing fields" }, 400);
  }
  const mu = typeof maxUses === "number" && maxUses > 0 ? Math.min(Math.floor(maxUses), 1000) : 20;
  await c.env.DB.prepare(
    `INSERT INTO strand_invites (invite_id, strand_id, created_by, wrapped_dek, join_proof_hash, dek_epoch, expires_at, revoked, max_uses, uses, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`
  )
    .bind(inviteId, strandId, c.get("userId"), JSON.stringify(wrappedDEK), joinProofHash, dekEpoch, expiresAt, mu, Date.now())
    .run();
  return c.json({ ok: true, inviteId });
});

// A signed-in user redeems a link: prove possession of the joinProof, get back
// the wrapped DEK to unwrap client-side.
app.post("/shared/join/claim", requireAuth, async (c) => {
  const b = await c.req.json().catch(() => null);
  const { inviteId, joinProof } = b ?? {};
  if (typeof inviteId !== "string" || typeof joinProof !== "string") return c.json({ error: "missing fields" }, 400);
  const inv = await c.env.DB.prepare("SELECT * FROM strand_invites WHERE invite_id = ?").bind(inviteId).first<InviteRow>();
  if (!inv) return c.json({ error: "This invite link isn't valid." }, 404);
  if (inv.revoked) return c.json({ error: "This invite link was turned off." }, 410);
  if (inv.expires_at < Date.now()) return c.json({ error: "This invite link has expired." }, 410);
  if (inv.uses >= inv.max_uses) return c.json({ error: "This invite link has been used up." }, 410);
  if ((await sha256B64(b64ToBytes(joinProof))) !== inv.join_proof_hash)
    return c.json({ error: "This invite link isn't valid." }, 403);
  return c.json({ strandId: inv.strand_id, wrappedDEK: JSON.parse(inv.wrapped_dek), dekEpoch: inv.dek_epoch });
});

// …then registers their membership (DEK re-wrapped to their own identity key).
app.post("/shared/join/finish", requireAuth, async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json().catch(() => null);
  const { inviteId, joinProof, ephemeralPub, wrappedDEK } = b ?? {};
  // wrappedDEK here is the DEK re-wrapped to the joiner's identity key — a
  // WrappedKey (base64 strings), like every member wrap, not a CipherBlob.
  if (typeof inviteId !== "string" || typeof joinProof !== "string" || typeof ephemeralPub !== "string" || !wrappedDEK) {
    return c.json({ error: "missing fields" }, 400);
  }
  const inv = await c.env.DB.prepare("SELECT * FROM strand_invites WHERE invite_id = ?").bind(inviteId).first<InviteRow>();
  if (!inv) return c.json({ error: "This invite link isn't valid." }, 404);
  if (inv.revoked || inv.expires_at < Date.now() || inv.uses >= inv.max_uses)
    return c.json({ error: "This invite link is no longer valid." }, 410);
  if ((await sha256B64(b64ToBytes(joinProof))) !== inv.join_proof_hash)
    return c.json({ error: "This invite link isn't valid." }, 403);
  const already = await membership(c.env.DB, inv.strand_id, userId);
  if (!already) {
    await c.env.DB.prepare(
      `INSERT INTO strand_members (strand_id, user_id, role, ephemeral_pub, wrapped_dek, dek_epoch, added_at)
       VALUES (?, ?, 'member', ?, ?, ?, ?)
       ON CONFLICT(strand_id, user_id) DO UPDATE SET ephemeral_pub = excluded.ephemeral_pub, wrapped_dek = excluded.wrapped_dek, dek_epoch = excluded.dek_epoch`
    )
      .bind(inv.strand_id, userId, ephemeralPub, JSON.stringify(wrappedDEK), inv.dek_epoch, Date.now())
      .run();
    await c.env.DB.prepare("UPDATE strand_invites SET uses = uses + 1 WHERE invite_id = ?").bind(inviteId).run();
  }
  return c.json({ ok: true, strandId: inv.strand_id });
});

// List a strand's active invite links (for showing / revoking). No secrets here.
app.get("/shared/:id/invites", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT invite_id, expires_at, revoked, max_uses, uses, created_at FROM strand_invites WHERE strand_id = ? ORDER BY created_at DESC"
  )
    .bind(strandId)
    .all<{ invite_id: string; expires_at: number; revoked: number; max_uses: number; uses: number; created_at: number }>();
  return c.json({
    invites: (rows.results ?? []).map((r) => ({
      inviteId: r.invite_id,
      expiresAt: r.expires_at,
      revoked: r.revoked === 1,
      maxUses: r.max_uses,
      uses: r.uses,
      createdAt: r.created_at,
    })),
  });
});

app.post("/shared/:id/invites/:inviteId/revoke", requireAuth, async (c) => {
  const strandId = c.req.param("id")!;
  const inviteId = c.req.param("inviteId")!;
  if (!(await membership(c.env.DB, strandId, c.get("userId")))) return c.json({ error: "not a member" }, 403);
  await c.env.DB.prepare("UPDATE strand_invites SET revoked = 1 WHERE invite_id = ? AND strand_id = ?")
    .bind(inviteId, strandId)
    .run();
  return c.json({ ok: true });
});

// Create an account + store the vault metadata and identity public key.
app.post("/auth/register", async (c) => {
  if (!(await withinRateLimit(c, "register", 10, 3_600_000))) return c.json({ error: TOO_MANY }, 429);
  const body = await c.req.json().catch(() => null);
  const email = (body?.email ?? "").trim().toLowerCase();
  const password = body?.password ?? "";
  const vault = body?.vault;
  const identityPublicKey = body?.identityPublicKey ?? null;
  const identityPrivWrapped = body?.identityPrivWrapped ?? null;

  if (!email || !password || !vault || !Array.isArray(vault.salt) || !vault.verifier) {
    return c.json({ error: "Missing email, password, or vault." }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return c.json({ error: "That email is already registered." }, 409);

  const userId = crypto.randomUUID();
  const { saltB64, hashB64 } = await hashPassword(password);
  const now = Date.now();

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id, email, pw_hash, pw_salt, identity_pub, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, email, hashB64, saltB64, identityPublicKey, now),
    c.env.DB.prepare(
      "INSERT INTO vaults (user_id, salt, verifier, iterations, identity_priv_wrapped, wrapped_dek, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, JSON.stringify(vault.salt), JSON.stringify(vault.verifier), vault.iterations ?? 600000, identityPrivWrapped ? JSON.stringify(identityPrivWrapped) : null, vault.wrappedDEK ? JSON.stringify(vault.wrappedDEK) : null, now),
  ]);

  const token = await signToken(userId, c.env.TOKEN_SECRET);
  return c.json({ token, userId });
});

app.post("/auth/login", async (c) => {
  if (!(await withinRateLimit(c, "login", 30, 900_000))) return c.json({ error: TOO_MANY }, 429);
  const body = await c.req.json().catch(() => null);
  const email = (body?.email ?? "").trim().toLowerCase();
  const password = body?.password ?? "";
  if (!email || !password) return c.json({ error: "Missing email or password." }, 400);

  const user = await c.env.DB.prepare(
    "SELECT id, pw_hash, pw_salt FROM users WHERE email = ?"
  )
    .bind(email)
    .first<{ id: string; pw_hash: string; pw_salt: string }>();

  // Same response whether the email exists or the password is wrong.
  if (!user || !(await verifyPassword(password, user.pw_salt, user.pw_hash))) {
    return c.json({ error: "Wrong email or password." }, 401);
  }

  const token = await signToken(user.id, c.env.TOKEN_SECRET);
  return c.json({ token, userId: user.id });
});

// The vault metadata, so a new device can re-derive the key from the passphrase
// and recover the (wrapped) identity private key + public key.
app.get("/vault", requireAuth, async (c) => {
  const userId = c.get("userId");
  const v = await c.env.DB.prepare(
    "SELECT salt, verifier, iterations, identity_priv_wrapped, wrapped_dek FROM vaults WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ salt: string; verifier: string; iterations: number; identity_priv_wrapped: string | null; wrapped_dek: string | null }>();
  if (!v) return c.json({ error: "No vault found." }, 404);
  const u = await c.env.DB.prepare("SELECT identity_pub FROM users WHERE id = ?")
    .bind(userId)
    .first<{ identity_pub: string | null }>();
  return c.json({
    salt: JSON.parse(v.salt),
    verifier: JSON.parse(v.verifier),
    iterations: v.iterations,
    identityPublicKey: u?.identity_pub ?? null,
    identityPrivWrapped: v.identity_priv_wrapped ? JSON.parse(v.identity_priv_wrapped) : null,
    wrappedDEK: v.wrapped_dek ? JSON.parse(v.wrapped_dek) : null,
  });
});

// Update the vault after a passphrase change: new salt, verifier, iterations,
// and re-wrapped DEK. Envelope-only — the entry/strand ciphertext is untouched
// (the DEK didn't change), so no re-upload is needed. This is what makes another
// device require the new passphrase the next time it signs in.
app.put("/vault", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.salt) || !body.verifier || !body.wrappedDEK) {
    return c.json({ error: "Missing salt, verifier, or wrappedDEK." }, 400);
  }
  const res = await c.env.DB.prepare(
    "UPDATE vaults SET salt = ?, verifier = ?, iterations = ?, wrapped_dek = ? WHERE user_id = ?"
  ).bind(
    JSON.stringify(body.salt), JSON.stringify(body.verifier),
    body.iterations ?? 600000, JSON.stringify(body.wrappedDEK), userId
  ).run();
  if (!res.meta.changes) return c.json({ error: "No vault found." }, 404);
  return c.json({ ok: true });
});

// Set/update this account's identity keypair (public + wrapped private). Used to
// migrate accounts created before identity keys existed, and for rotation.
app.post("/identity", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const pub = body?.identityPublicKey;
  const wrapped = body?.identityPrivWrapped;
  if (typeof pub !== "string" || !wrapped) return c.json({ error: "missing identity keys" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET identity_pub = ? WHERE id = ?").bind(pub, userId),
    c.env.DB.prepare("UPDATE vaults SET identity_priv_wrapped = ? WHERE user_id = ?").bind(
      JSON.stringify(wrapped),
      userId
    ),
  ]);
  return c.json({ ok: true });
});

// Public-key directory — unused until sharing, but live from the start.
app.get("/keys", requireAuth, async (c) => {
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  if (!email) return c.json({ error: "email required" }, 400);
  const u = await c.env.DB.prepare("SELECT identity_pub FROM users WHERE email = ?")
    .bind(email)
    .first<{ identity_pub: string | null }>();
  if (!u) return c.json({ error: "No such user." }, 404);
  return c.json({ identityPublicKey: u.identity_pub });
});

export default app;
