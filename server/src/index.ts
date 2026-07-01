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

// ---- Sync (Phase 3) ------------------------------------------------------
// The server stores each entry's ciphertext + metadata and assigns a per-user
// monotonic `seq`. Push upserts with last-write-wins by updatedAt; pull returns
// everything with seq greater than the client's cursor. No plaintext is ever
// seen — content is an opaque CipherBlob.

const PULL_LIMIT = 500;
const MAX_PUSH = 1000;

// SQLite upsert that applies last-write-wins: an incoming row only overwrites a
// stored one when its updatedAt is newer-or-equal. created_at is preserved.
const UPSERT_ENTRY = `
INSERT INTO entries (user_id, id, created_at, updated_at, deleted, content, seq)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id, id) DO UPDATE SET
  updated_at = excluded.updated_at,
  deleted    = excluded.deleted,
  content    = excluded.content,
  seq        = excluded.seq
WHERE excluded.updated_at >= entries.updated_at`;

function isCipherBlob(x: any): boolean {
  return x && Array.isArray(x.iv) && Array.isArray(x.data);
}
function validChange(ch: any): boolean {
  return (
    ch &&
    typeof ch.id === "string" &&
    typeof ch.createdAt === "number" &&
    typeof ch.updatedAt === "number" &&
    typeof ch.deleted === "boolean" &&
    isCipherBlob(ch.content)
  );
}
async function maxSeq(db: D1Database, userId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM entries WHERE user_id = ?")
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
      c.env.DB.prepare(UPSERT_ENTRY).bind(
        userId,
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
    "SELECT id, created_at, updated_at, deleted, content, seq FROM entries WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?"
  )
    .bind(userId, since, PULL_LIMIT)
    .all<{
      id: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      content: string;
      seq: number;
    }>();
  const results = rows.results ?? [];
  const changes = results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deleted: r.deleted === 1,
    content: JSON.parse(r.content),
  }));
  const cursor = results.length ? results[results.length - 1].seq : since;
  return c.json({ changes, cursor, more: results.length === PULL_LIMIT });
});

// Create an account + store the vault metadata and identity public key.
app.post("/auth/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = (body?.email ?? "").trim().toLowerCase();
  const password = body?.password ?? "";
  const vault = body?.vault;
  const identityPublicKey = body?.identityPublicKey ?? null;

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
      "INSERT INTO vaults (user_id, salt, verifier, iterations, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, JSON.stringify(vault.salt), JSON.stringify(vault.verifier), vault.iterations ?? 600000, now),
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

// The vault metadata, so a new device can re-derive the key from the passphrase.
app.get("/vault", requireAuth, async (c) => {
  const v = await c.env.DB.prepare(
    "SELECT salt, verifier, iterations FROM vaults WHERE user_id = ?"
  )
    .bind(c.get("userId"))
    .first<{ salt: string; verifier: string; iterations: number }>();
  if (!v) return c.json({ error: "No vault found." }, 404);
  return c.json({
    salt: JSON.parse(v.salt),
    verifier: JSON.parse(v.verifier),
    iterations: v.iterations,
  });
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
