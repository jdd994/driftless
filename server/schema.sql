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
  created_at  INTEGER NOT NULL
);

-- entries land here in Phase 3 (push/pull). Defined now so the schema is whole.
CREATE TABLE IF NOT EXISTS entries (
  user_id     TEXT NOT NULL REFERENCES users(id),
  id          TEXT NOT NULL,          -- client-assigned entry id
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  content     TEXT NOT NULL,          -- JSON CipherBlob (opaque)
  seq         INTEGER NOT NULL,       -- per-user monotonic; the pull cursor
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS entries_by_seq ON entries(user_id, seq);
