// index.ts
// Driftless sync server (Phase 2: accounts + vault + key directory).
// The server stores opaque ciphertext + non-secret metadata only. It never sees
// plaintext, the passphrase, or any encryption key. See ../SYNC_PLAN.md.

import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth";

type Env = {
  DB: D1Database;
  TOKEN_SECRET: string;
  ALLOWED_ORIGIN: string;
};

type Vars = { userId: string };
type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", (c, next) =>
  cors({
    origin: c.env.ALLOWED_ORIGIN || "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })(c, next)
);

// Bearer-token auth. Sets `userId` on success.
async function requireAuth(c: AppContext, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? await verifyToken(token, c.env.TOKEN_SECRET) : null;
  if (!userId) return c.json({ error: "Not signed in." }, 401);
  c.set("userId", userId);
  await next();
}

app.get("/health", (c) => c.json({ ok: true, service: "driftless-server" }));

// A calm "note to the maker". Open (no account needed) so even a first-time
// visitor can send a word. Stored separately from journal data; it's a plain
// message, never touching any ciphertext. Optional token just attributes it.
app.post("/feedback", async (c) => {
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
      "INSERT INTO vaults (user_id, salt, verifier, iterations, identity_priv_wrapped, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, JSON.stringify(vault.salt), JSON.stringify(vault.verifier), vault.iterations ?? 600000, identityPrivWrapped ? JSON.stringify(identityPrivWrapped) : null, now),
  ]);

  const token = await signToken(userId, c.env.TOKEN_SECRET);
  return c.json({ token, userId });
});

app.post("/auth/login", async (c) => {
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
    "SELECT salt, verifier, iterations, identity_priv_wrapped FROM vaults WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ salt: string; verifier: string; iterations: number; identity_priv_wrapped: string | null }>();
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
  });
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
