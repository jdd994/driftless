# Sharing plan — connected & family strands

Status: **S1–S4 done (family strands + rotation proven end-to-end); S5 (social
recovery) is the remaining frontier.** The sharing chapter — co-authored,
end-to-end-encrypted strands shared with people you love. It builds on the sync
engine (done; see SYNC_PLAN.md) and is the most security-critical work in the
app. Design it fully before building; build it foundation-first; test each slice
with a *real second person* (it can't be verified single-device).

Guiding pillars (non-negotiable — see the `purpose-and-soul` memory):
- **End-to-end: members only.** The server (and its operator) can never read a
  shared strand. A breach yields only ciphertext.
- **Calm, not a notification engine.** Updates are *there when you visit*; at
  most gentle opt-in notifications. Never pings/badges/pressure.
- **Love is the point.** No metrics, no performance, no comparison.

---

## The crypto model

**Identity keys.** Each user has an **ECDH P-256 keypair**. The *public* key is
stored server-side (`users.identity_pub`) and fetchable by others; the *private*
key is exported (PKCS8), **encrypted with the vault key**, and stored (a) on the
device and (b) server-side *wrapped* — so a new device recovers the identity
after unlocking with the passphrase. The server never sees the private key.

**Shared strand key (DEK).** Each shared strand has a random **AES-256 key**.
The strand's pieces are encrypted with *this* key — not any member's vault key —
so every member can decrypt them.

**Handing out the DEK (ECIES-style wrap).** To share the DEK with a member:
generate an ephemeral ECDH keypair → `ECDH(ephemeralPriv, memberPub)` → HKDF →
AES-GCM-wrap the DEK. Store `{ ephemeralPub, iv, wrappedDEK }` for that member.
The member unwraps with `ECDH(theirPriv, ephemeralPub)`. Only they can.

**Personal vs shared, kept clean.** Personal entries stay encrypted with your
vault key and live in your Stream. **Shared-strand pieces are separate objects
encrypted with the strand DEK** — they live in the shared strand, not your
private Stream. This avoids dual-encrypting the same object and keeps the two
worlds cleanly separated. (A "also keep a copy in my journal" nicety can come
later.)

---

## The server's shared-access model (the key new piece)

Today the server is strictly **per-user and private** — you can only pull your
own objects. Sharing needs a **membership-gated shared space**. New tables:

```sql
CREATE TABLE shared_strands (
  strand_id  TEXT PRIMARY KEY,   -- client-generated id
  owner_id   TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- one row per member; carries THAT member's wrapped copy of the DEK
CREATE TABLE strand_members (
  strand_id     TEXT NOT NULL REFERENCES shared_strands(strand_id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL,        -- 'owner' | 'member'
  ephemeral_pub TEXT NOT NULL,        -- for unwrapping the DEK
  wrapped_dek   TEXT NOT NULL,
  dek_epoch     INTEGER NOT NULL,     -- which DEK version this wrap is for
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (strand_id, user_id)
);

-- the shared pieces (DEK-encrypted). seq is per-strand → the pull cursor.
CREATE TABLE shared_objects (
  strand_id  TEXT NOT NULL REFERENCES shared_strands(strand_id),
  kind       TEXT NOT NULL,           -- 'piece' | 'meta' (title/order) | 'media'
  id         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL,           -- opaque, DEK-encrypted
  dek_epoch  INTEGER NOT NULL,        -- which DEK version encrypted this
  seq        INTEGER NOT NULL,
  PRIMARY KEY (strand_id, id)
);
CREATE INDEX shared_objects_by_seq ON shared_objects(strand_id, seq);
```

**Every shared endpoint checks membership** (requester is in `strand_members`
for that `strand_id`). Endpoints:
- `POST /shared/create` `{ strandId }` → owner creates a shared strand + self-membership.
- `POST /shared/:id/invite` `{ memberEmail, ephemeralPub, wrappedDEK, dekEpoch }`
  → server resolves the email to a user, inserts their member row. (The inviter
  fetched their public key via `/keys` and did the wrap client-side.)
- `GET /shared/:id/members` → members + public keys (for re-wraps / rotation).
- `GET /shared/mine` → strands I'm a member of, each with *my* `ephemeralPub +
  wrappedDEK + dekEpoch` so I can unwrap the DEK.
- `POST /shared/:id/push` / `GET /shared/:id/pull?since=` → member-scoped object
  sync (same LWW + per-strand `seq` cursor as personal sync).
- `POST /shared/:id/leave`, `POST /shared/:id/remove` `{ userId }` (owner) →
  membership changes; removal triggers **DEK rotation** (below).

---

## The invite / key-exchange flow (humane)

1. You share a strand with someone **by their email**. (v1: they must already
   have a Driftless account, so the server has their public key. Invite-by-link
   for non-users is deferred.)
2. Your client: `GET /keys?email=` → their public key → **wrap the DEK** to it
   (ephemeral ECDH) → `POST /shared/:id/invite`.
3. Their client: `/shared/mine` now lists the strand with their wrapped DEK →
   **unwrap with their private key** → pull + decrypt → they can read and
   co-author.

Under the hood it's key exchange; on the surface it should feel like *"share
with mom@… → she opens the app and it's there."*

**Removal + re-keying.** Removing a member generates a **new DEK (epoch+1)**,
re-wrapped to the remaining members; new pieces use the new epoch. Old pieces
stay under the old epoch (the removed member could already read those). This
gives forward secrecy for *future* content.

---

## Phases (foundation-first; each shippable; test with a real 2nd person)

1. ✅ **S1 — Identity keys.** ECDH keypair at account setup; migrates existing
   accounts on next unlock; public uploaded, private wrapped by the vault key,
   stored locally + server-side. **Done & deployed; verified 8/8.**
2. ✅ **S2 — Server shared model.** `shared_strands` / `strand_members` /
   `shared_objects` + membership-gated endpoints (`/shared/create`, `/invite`,
   `/members`, `/mine`, `/push`, `/pull`, `/leave`, `/remove`) with DEK epochs.
   **Done & deployed; verified 11/11** (owner creates, invites by public key,
   member unwraps + co-authors, non-member 403, owner-only remove).
3. ✅ **S3 — Share one strand with one person (client).** A **Shared** lens:
   start a shared strand (mints a DEK, wrapped to yourself) → write text pieces
   → invite by email (fetch their public key, wrap the DEK, register them) →
   they see it in their Shared area, unwrap, pull, decrypt, co-author. Meta
   object carries title + order (LWW); pieces are DEK-encrypted `encodePayload`
   text; content lives server-side (opaque) and is re-fetched + decrypted per
   session (in-memory only). **Done & deployed; client flow verified 11/11**
   against the live server (create → meta → invite → unwrap → pull → decode →
   co-author, order preserved). Still worth a real 2-person device test.
   *v1 scope:* text pieces only; no reorder/delete/media in shared yet; leave/
   remove/rotation is S4.
4. ✅ **S4 — Family strands (N members) + membership UI.** Invite many (repeat
   invite), a **People** panel (member list + roles), **Leave** (member) and
   **Remove** (owner). Removal triggers **client-driven DEK rotation**: mint a
   new DEK at the next epoch, **re-encrypt the meta + every piece under it**, and
   re-wrap it to the remaining members (via the UPSERT `invite`). Remaining
   members detect the epoch bump on their next load, re-unwrap, and rebuild from
   scratch (cursor reset). The removed member is 403'd, dropped from `/mine`, and
   their old DEK decrypts nothing on the server. No server changes were needed —
   all S2 endpoints. **Done & deployed; verified 13/13** (3-member strand,
   co-author, remove+rotate, old-key lockout, transparent rebuild, leave).
   *Chose re-encryption over multi-epoch key history:* one active DEK at a time,
   no schema change, same forward-secrecy property (family strands are small, so
   re-encrypting all pieces on the rare removal is cheap). *Deferred:* ownership
   transfer (owner can't leave yet); reorder/delete of shared pieces.
5. ✅ **S6 — Invite by link (build a family painlessly).** A private link you send
   through your own channel lets someone join a strand without you knowing their
   email or them pre-registering. Link secret rides in the URL fragment; HKDF →
   wrapKey (encrypts DEK, opaque to server) + joinProof (server stores only its
   hash). Opening the link stashes it, guides the newcomer through setup, then
   auto-joins (claim → unwrap → re-wrap to self → finish). Reusable, revocable,
   7-day expiry; removal/re-key auto-revokes outstanding links. **No user search,
   ever.** **Done & deployed; verified 11/11** against the live server (create,
   bad-proof reject, join+decrypt, co-author, reusable, revoke, expiry, used-up,
   removal-revokes-links). Design details below.
6. **S5 — Social recovery.** The family together restores a member who lost their
   passphrase — K-of-N Shamir secret sharing of a recovery secret, each share
   wrapped to a member's public key; the server holds no usable share. The
   frontier; design in detail when we reach it.

---

## S6 design — invite by link

**The problem.** Email-invite (S3/S4) needs the invitee to already have an
account *and* you to know its exact email. For gathering a family that's clunky.
We want: send a link → they open it → they're in. Without a searchable user
directory (which would betray the whole ethos).

**The crypto (server never learns the strand key).** The link carries a random
32-byte **link secret**, placed in the URL **fragment** (`#…`), which browsers
never send to a server. From it the client derives two independent sub-keys with
HKDF:
- `wrapKey = HKDF(linkSecret, "…wrap")` — AES-GCM-encrypts the strand DEK. Stored
  on the server as opaque ciphertext. The server never sees `wrapKey` or the DEK.
- `joinProof = HKDF(linkSecret, "…proof")` — the server stores only
  `SHA-256(joinProof)`. A joiner proves possession of the link by sending
  `joinProof`; because HKDF outputs are independent, the server learning
  `joinProof` reveals nothing about `wrapKey`. So a server breach yields neither
  the DEK nor a way to join.

**Server (new `strand_invites` table + endpoints).**
```sql
CREATE TABLE strand_invites (
  invite_id       TEXT PRIMARY KEY,
  strand_id       TEXT NOT NULL REFERENCES shared_strands(strand_id),
  created_by      TEXT NOT NULL,      -- user_id
  wrapped_dek     TEXT NOT NULL,      -- DEK encrypted with the link's wrapKey (JSON CipherBlob)
  join_proof_hash TEXT NOT NULL,      -- SHA-256(joinProof), base64
  dek_epoch       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked         INTEGER NOT NULL DEFAULT 0,
  max_uses        INTEGER NOT NULL DEFAULT 20,
  uses            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
```
- `POST /shared/:id/invite-link` (member) `{ inviteId, wrappedDEK, joinProofHash, dekEpoch, expiresAt, maxUses }` → create.
- `POST /shared/join/claim` (auth) `{ inviteId, joinProof }` → verify hash + not
  expired/revoked/used-up → return `{ strandId, wrappedDEK, dekEpoch }`.
- `POST /shared/join/finish` (auth) `{ inviteId, joinProof, ephemeralPub, wrappedDEK }`
  → verify again → insert the caller as a member with the DEK re-wrapped to *their*
  identity key; `uses++`. Idempotent if already a member.
- `GET /shared/:id/invites` + `POST /shared/:id/invites/:inviteId/revoke` (owner)
  → list / revoke. **`/remove` (rotation) revokes all of a strand's invites**, so
  a re-key kills outstanding links (the old link's `wrappedDEK` is a stale epoch).

**Client — owner creates a link.** Generate `linkSecret`; derive `wrapKey`,
`joinProof`; encrypt the DEK with `wrapKey`; `POST /invite-link`; hand back
`https://<app>/#join=<inviteId>.<linkSecretB64>`. (Copyable + Web Share.)

**Client — joiner opens the link.** Detect `#join=…` on load. They need a vault +
account (identity key) to hold a membership, so the pending invite is stashed and
the join **resumes automatically after first-run setup / unlock** — the guided
setup already makes an account easy. Then: `claim` → decrypt DEK with `wrapKey` →
re-wrap to own identity → `finish` → refresh Shared → "You've joined …".

**Decisions (defaults, easily changed):**
- **Reusable link, revocable, 7-day expiry, `max_uses` ~20** — one link you send
  to several family members; owner sees join count and can revoke. (Single-use is
  a future toggle.)
- **Joining requires an account** — a membership must belong to someone with an
  identity key. The link makes that onboarding one smooth path.
- **Link = a capability** (like a house key). Framed to share privately; expiry +
  revoke + rotation-kills-links bound the exposure. Intercepting the fragment ==
  access, inherent to any invite link.
- **No user search / directory.** Locked.

---

## Decisions locked here
- **Members need a Driftless account** (a membership must belong to an identity
  key). Invite-by-**link** (S6, designed above) removes the need to *know* their
  email or have them pre-register — the link guides them through setup, then
  joins. Still no user search / directory.
- **Shared pieces are separate DEK-encrypted objects**, distinct from personal
  vault-encrypted entries — clean separation of personal vs shared.
- **ECDH P-256** identity keys; **ECIES-style** DEK wrapping (ephemeral ECDH +
  HKDF + AES-GCM). WebCrypto throughout, no new deps.
- **Private identity key** stored wrapped by the vault key — on device + server
  (portable, server can't read).
- **DEK rotation on removal** (epochs) for forward secrecy of future content.
- **LWW co-authoring merge**, same as base sync.
- **Calm updates only** — no notification engine.

## Open questions (resolve as we build)
- **Shared media.** Photos in a shared strand need DEK-encrypted blobs in object
  storage — this waits on personal media sync (R2), which isn't built yet. v1
  shared strands are **text pieces only**; shared photos come with the R2 work.
- **Non-user invites** (invite someone who hasn't signed up) — deferred; needs a
  pending-invite + deferred-wrap flow.
- **Social recovery specifics** (S5) — K-of-N mechanics, who holds shares, how
  restore is authorized — designed at S5.
- **Abuse/limits** for shared storage — per-strand size/member caps at hardening.
