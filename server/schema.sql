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
  wrapped_dek TEXT,                   -- envelope: the data key (DEK) wrapped by the
                                      -- passphrase-derived KEK (opaque). Null on
                                      -- legacy vaults; set on register/passphrase change.
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

-- ---- Sharing (S2) --------------------------------------------------------
-- Shared strands: end-to-end encrypted, readable only by members. The server
-- gates access by membership and stores opaque ciphertext + each member's
-- wrapped copy of the strand key. See SHARING_PLAN.md.

CREATE TABLE IF NOT EXISTS shared_strands (
  strand_id  TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strand_members (
  strand_id     TEXT NOT NULL REFERENCES shared_strands(strand_id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL,        -- 'owner' | 'member'
  ephemeral_pub TEXT NOT NULL,        -- for unwrapping the DEK
  wrapped_dek   TEXT NOT NULL,        -- this member's wrapped strand key (JSON)
  dek_epoch     INTEGER NOT NULL,     -- which DEK version this wrap is for
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (strand_id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_objects (
  strand_id  TEXT NOT NULL REFERENCES shared_strands(strand_id),
  kind       TEXT NOT NULL,           -- 'piece' | 'meta' | 'media'
  id         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL,           -- opaque, DEK-encrypted
  dek_epoch  INTEGER NOT NULL,
  seq        INTEGER NOT NULL,        -- per-strand monotonic; the pull cursor
  PRIMARY KEY (strand_id, id)
);
CREATE INDEX IF NOT EXISTS shared_objects_by_seq ON shared_objects(strand_id, seq);

-- ---- Invite links (S6) ---------------------------------------------------
-- A shareable link that lets someone join a shared strand without an email
-- exchange. The link's secret lives in the URL fragment (never sent here); the
-- client derives a wrapKey (encrypts the DEK below — opaque to us) and a
-- joinProof (we store only its hash). So a breach yields neither the strand key
-- nor a way to join. See SHARING_PLAN.md (S6).
CREATE TABLE IF NOT EXISTS strand_invites (
  invite_id       TEXT PRIMARY KEY,
  strand_id       TEXT NOT NULL REFERENCES shared_strands(strand_id),
  created_by      TEXT NOT NULL,
  wrapped_dek     TEXT NOT NULL,       -- DEK encrypted with the link's wrapKey (JSON CipherBlob)
  join_proof_hash TEXT NOT NULL,       -- base64(SHA-256(joinProof))
  dek_epoch       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked         INTEGER NOT NULL DEFAULT 0,
  max_uses        INTEGER NOT NULL DEFAULT 20,
  uses            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS strand_invites_by_strand ON strand_invites(strand_id);

-- ---- Feedback ------------------------------------------------------------
-- A calm "note to the maker" box in the app. NOT part of the journal and NOT
-- end-to-end encrypted — it's a plain message the writer chose to send. Kept
-- separate from everything above so it can never touch journal ciphertext.
CREATE TABLE IF NOT EXISTS feedback (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  message    TEXT NOT NULL,
  contact    TEXT,                    -- optional, if they want a reply
  user_id    TEXT                     -- set only if they happened to be signed in
);

-- ---- Rate limiting -------------------------------------------------------
-- Fixed-window counters keyed by action + IP + time-bucket, to blunt abuse of
-- the open endpoints (register / login / feedback). Only these low-frequency
-- paths are limited; the authenticated sync path is not. Rows expire with their
-- window and are swept opportunistically.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,        -- "<action>:<ip>:<windowBucket>"
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_by_expiry ON rate_limits(expires_at);

-- ---- Per-user usage (storage quotas) -------------------------------------
-- A running byte total for a user's media in R2, which (unlike the objects
-- table) can't be cheaply SUMmed. Incremented on upload, credited back on
-- delete. Object-count/bytes are computed live from `objects`, so they need no
-- row here. Bounds the worst-case storage cost of any single account. See
-- ../HARDENING.md.
CREATE TABLE IF NOT EXISTS user_usage (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  media_bytes INTEGER NOT NULL DEFAULT 0
);
