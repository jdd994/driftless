-- Driftless sync server schema.
-- The server stores OPAQUE CIPHERTEXT and non-secret metadata only. It never
-- sees plaintext, the passphrase, or any encryption key. See ../SYNC_PLAN.md.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,     -- random uuid
  email         TEXT UNIQUE NOT NULL,
  pw_hash       TEXT NOT NULL,        -- PBKDF2(password) — login secret only
  pw_salt       TEXT NOT NULL,
  identity_pub  TEXT,                 -- public half of the identity keypair;
                                      -- private half never leaves the device.
                                      -- Unused until sharing, stored from day 1.
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  salt        TEXT NOT NULL,          -- JSON number[] — non-secret KDF salt
  verifier    TEXT NOT NULL,          -- JSON CipherBlob — checks the passphrase
  iterations  INTEGER NOT NULL,
  identity_priv_wrapped TEXT,         -- identity private key, wrapped by the
                                      -- vault key (opaque; for new-device recovery)
  created_at  INTEGER NOT NULL
);

-- Synced objects (Phase 3/4). One table for all record kinds — 'entry',
-- 'strand', and later media pointers — so the sync path is uniform. content is
-- always an opaque JSON CipherBlob. seq is a per-user monotonic counter across
-- all kinds; the pull cursor is "everything with seq > since".
CREATE TABLE IF NOT EXISTS objects (
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,          -- 'entry' | 'strand' | ...
  id          TEXT NOT NULL,          -- client-assigned id
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  content     TEXT NOT NULL,          -- JSON CipherBlob (opaque)
  seq         INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS objects_by_seq ON objects(user_id, seq);
