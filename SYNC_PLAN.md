# Sync plan — Driftless

Status: **Sync is BUILT, deployed, and verified end-to-end (2026-07-14).**
Phases 1–5 are done: client engine, account UI, media sync over R2, sharing S2,
and a two-device bidirectional test passed (write on device A → appears on device
B after sign-in + unlock; and back). Backend live at
`https://driftless-server.jdd994.workers.dev`, auto-deploys from `main`.
**Phase 6 (hardening) is the remaining work — see `HARDENING.md`.** Per-user
storage quotas (the first Phase-6 item) are now added.

> The phase checklist below is kept for history; the top status is the source of
> truth. This document is the build spec, edited as we learn.

> **Why sync is the gateway.** The longer-term vision (see the
> "Sharing & family strands" appendix below, and the `sharing-family-vision`
> memory) is a private, co-authored, multi-generational family memory keeper:
> shared strands everyone contributes to, end-to-end encrypted, with *social
> recovery*. All of that rests on sync + a per-user **identity keypair**. So we
> build sync now with identity keys baked in from day one, even though nothing
> uses them until sharing lands — retrofitting identity later is painful.

## The one idea that makes this simple

**Sync moves ciphertext and never touches the key.** Entries are already
encrypted at write time and decrypted only for display (`loadEntries`). A
`StoredEntry` is `{ id, createdAt, updatedAt, content: CipherBlob }` — opaque
bytes plus metadata. So the sync engine lives *below* the crypto boundary: it
pushes and pulls `StoredEntry` blobs and reconciles them by `id` + `updatedAt`,
without ever needing the passphrase or key.

Consequences that fall out of this for free:
- The server only ever sees ciphertext + non-secret metadata (invariant #1 holds
  by construction).
- Background sync can run **while the app is locked** — it just writes ciphertext
  to IndexedDB; it becomes visible after the next unlock + decrypt.
- The encryption key still lives only in memory and is re-derived from the
  passphrase each session (invariant #2). The sync **account** is a *separate*
  secret (invariant #4) — never used to derive the key.

## Two secrets, two jobs (invariant #4)

| | Account (new) | Passphrase (exists) |
|---|---|---|
| Purpose | Authenticate to the sync server; say *whose* blobs these are | Derive the AES key that decrypts entries |
| Lives | Server stores a password **hash**; client keeps a session **token** | Never stored, never sent; key is in-memory only |
| On new device | Log in → server returns your `salt`+`verifier` | Re-enter passphrase → derive key locally → verify → decrypt |

Never derive the encryption key from the login password. Never transmit the
passphrase or key. The `salt` + `verifier` are non-secret and *do* travel (so a
new device can re-derive), exactly as in the backup file today.

## Data model changes (client)

Entries become sync-aware. Add to `Entry` / `StoredEntry`:
- `deleted: boolean` — tombstone. Delete becomes a **soft delete** (set
  `deleted=true`, bump `updatedAt`) so the deletion can propagate; the UI filters
  tombstones out. Purge confirmed-synced tombstones after a horizon later.
- `dirty: boolean` — set on every local mutation, cleared after a successful
  push. This is the outbox: "needs upload."

New IndexedDB meta store `sync` (one row): `{ cursor, token, accountEmail }`.
- `cursor` — highest server change-sequence pulled so far.
- `token` — the **auth** token (not the key; persisting it is allowed).

Bump the DB to **version 2** with an `upgrade()` migration: default existing
entries to `deleted:false, dirty:true` (so everything already on the device
uploads on first sync), and create the `sync` store.

## Conflict resolution

**Last-write-wins by `updatedAt`** to start (CLAUDE.md roadmap #2). On pull, a
remote record replaces the local one only if `remote.updatedAt > local.updatedAt`
(or the local copy is absent). If the local copy is `dirty` and newer, it wins
and will be pushed. Ties → server copy. This can lose the older of two truly
concurrent edits to the *same* entry on two devices; acceptable for v1, revisit
with "conflict copies" if it ever bites.

## Server (Cloudflare Workers + D1)

A separate sub-project (e.g. `/server`) with its own `wrangler.toml` and a D1
binding. Router via Hono. Password hashing via WebCrypto PBKDF2 (no native deps
needed on Workers). Auth via a signed token (HMAC/JWT) or an opaque token in a
`sessions` table.

D1 schema (sketch):
```sql
CREATE TABLE users   (id TEXT PRIMARY KEY, email TEXT UNIQUE, pw_hash TEXT,
                      pw_salt TEXT,
                      identity_pub TEXT,   -- public half of the user's identity
                                           -- keypair (sharing/recovery use it;
                                           -- the private half never leaves the
                                           -- device). Stored from day one.
                      created_at INTEGER);
CREATE TABLE vaults  (user_id TEXT PRIMARY KEY, salt TEXT, verifier TEXT,
                      iterations INTEGER, created_at INTEGER);
CREATE TABLE entries (user_id TEXT, id TEXT, created_at INTEGER,
                      updated_at INTEGER, deleted INTEGER,
                      content TEXT,        -- base64(iv)|base64(data)
                      seq INTEGER,         -- monotonic per user, set on write
                      PRIMARY KEY (user_id, id));
CREATE INDEX entries_by_seq ON entries(user_id, seq);
```
`seq` is a per-user monotonically increasing counter assigned on every
insert/update; the pull cursor is "give me everything with `seq > since`." This
is robust against device clock skew (unlike pulling by `updated_at`).

**Identity keypair (baked in now, used later).** At signup the client generates
an asymmetric identity keypair; the **public** key is sent and stored in
`users.identity_pub`, the **private** key stays on the device (wrapped by the
vault key, like everything else). Nothing uses it in the sync-only phase — but
it's the anchor that shared strands (encrypt a strand key to each member's
public key) and social recovery (split a member's recovery across other
members) will need. Cheap to add now, painful to retrofit.

### Endpoints
- `POST /auth/register`
  `{ email, password, vault:{salt,verifier,iterations}, identityPublicKey }`
  → creates user + vault, stores the public key, returns `{ token }`.
- `POST /auth/login` `{ email, password }` → `{ token }`.
- `GET  /vault` (auth) → `{ salt, verifier, iterations }` — for new-device key
  derivation.
- `GET  /keys?email=…` or `/keys/:userId` (auth) → `{ identityPublicKey }` — the
  public-key directory. Unused until sharing, but the endpoint + storage exist
  from the start so invites can look up who they're sharing with.
- `POST /sync/push` (auth) `{ changes:[{id,createdAt,updatedAt,deleted,content}] }`
  → upsert with LWW (`incoming.updatedAt >= stored.updatedAt`), assign new
  `seq`s, return `{ cursor }`.
- `GET  /sync/pull?since=<cursor>` (auth) → `{ changes:[...], cursor }` (rows with
  `seq > since`).

CORS must allow the Pages origin, and we must add the server origin to
`connect-src` in `public/_headers` (today it's locked to `'self'`).

## Client sync engine

New `lib/sync.ts` (API client + pure reconcile helpers) and `lib/api.ts` (fetch
wrappers that attach the token). Integrate triggers in `useJournal`:
- **on unlock** — pull, then push the dirty set.
- **after each local mutation** — debounced push.
- **on `online` event and on visibility/regain focus** — pull + push.
- **periodic** — a gentle interval while open.

v1 runs sync **in the page**, not the service worker. True background sync needs
switching the PWA build from `generateSW` to `injectManifest` and a custom SW;
that's a later enhancement, not a v1 requirement. Capture stays 100% local and
instant regardless — sync is always a background reconcile, never in the write
path (invariant #3).

Decryption note: pulled ciphertext can be written to IndexedDB even while
locked; it surfaces on the next `loadEntries`. The key is only needed to
*encrypt* new local writes (already have it when unlocked) and to *decrypt for
display*.

## Timestamp privacy (roadmap #3) — decision needed

`createdAt`/`updatedAt` are plaintext on the server, which leaks *when* you
journal (not *what*). v1 recommendation: **keep them plaintext** — `updatedAt`
is needed for LWW and `seq`/cursor handles ordering. If timing metadata matters
later, move `updatedAt` to a logical per-record version counter and encrypt
`createdAt` inside the blob. Flagged, not silently chosen.

## Phasing (each phase is shippable; capture never breaks)

1. ✅ **Client groundwork, no server.** Add `deleted` + `dirty` + `sync` store + DB
   v2 migration; soft-delete; `loadEntries` filters tombstones. No user-visible
   change, but now sync-ready. Low risk. **(done)**
2. ✅ **Server skeleton.** Workers + D1, schema (incl. `users.identity_pub`),
   `/auth/register`, `/auth/login`, `/vault`, `/keys`. **(done — deployed.**
   Client identity-keypair generation still happens with the account UI in
   Phase 4; the server already stores the public key.)
3. ✅ **Sync endpoints.** `/sync/push`, `/sync/pull` with LWW + `seq` cursor.
   **(done — verified with curl.** Note: entries only so far; **strands** sync is
   the same pattern and gets added in Phase 4, via a `strands` table + the same
   push/pull, or a shared table with a `kind` column.)
4. **Client engine + account UI.** `lib/sync.ts`, `lib/api.ts`, a "Connect an
   account" panel (register/login). Wire the triggers. Gate behind opt-in so
   local-only keeps working untouched. Add server origin to CSP `connect-src`.
5. **Key portability test.** New device → log in → fetch vault `salt` → enter
   passphrase → pull → decrypt. This is the acceptance test for the whole thing.
6. **Hardening (current).** See `HARDENING.md` for the full threat/cost model and
   the prioritized checklist. Done so far: rate limiting (register/login/feedback),
   size caps, **per-user storage quotas** (objects + media). Next: billing alerts,
   Turnstile on signup, edge/WAF rate limiting, global signup circuit-breaker,
   token rotation, shared-media quota, tombstone purge, privacy-preserving abuse
   monitoring. Also still open: timestamp encryption decision; optional custom SW
   for true background sync.

## Decisions (resolved 2026-06-30)

- **Account identity: email + password.** The server stores a password hash
  (WebCrypto PBKDF2) and the client keeps a session token. Enables clean
  new-device login and leaves room for a future *account* recovery email. This
  is the login secret only — it never derives or touches the encryption key, and
  forgetting it never risks the entries (those rest on the un-resettable
  passphrase). Distinct from the passphrase per invariant #4.
- **Timestamp privacy: plaintext for v1.** `updatedAt` is needed for LWW and the
  `seq` cursor handles ordering. Leaks *when* you write, not *what*. Revisit by
  moving `updatedAt` to a logical version counter + encrypting `createdAt` if it
  matters later.
- **Background sync: in-page for v1.** Sync runs from the page (unlock /
  mutation / `online` / interval). Moving to a custom service worker for true
  background/periodic sync is a Phase 6 enhancement, not required for v1.
- **Identity keypair from day one.** Generate at signup, store the public key
  server-side, keep the private key on-device (wrapped by the vault key). Unused
  until sharing, but the foundation for it. See appendix.

---

## Appendix — Sharing & family strands (future chapter, after sync)

> **Full build plan: see `SHARING_PLAN.md`** — concrete phases (S1–S5), the
> server shared-access model, and the invite/key-exchange flow. The summary
> below remains as the why.

The long-term vision: a **private, co-authored, multi-generational family memory
keeper.** Decided in conversation (2026-06-30); recorded so the sync build above
is shaped to support it. None of this is built; it comes *after* sync.

### What it is
- **Family/shared strands are co-authored.** Every member can add pieces and
  arrange them — a memory assembled by the whole family, not published by one.
- **End-to-end encrypted to the members only.** The server (and whoever runs it)
  can never read a shared strand — only its members can.
- **Social recovery.** If a member forgets their passphrase, the *family
  together* can restore their access; no server or outsider ever can.
- **Calm collaboration, NOT a notification engine.** Updates should simply *be
  there when you visit the strand* (at most a soft "N new pieces" marker), with —
  if any — only gentle, opt-in notifications. Never messenger-style pings,
  unread badges, "typing…", or pressure to respond. A slow, loving shared story,
  not a chat. Optional live refresh only while members *both* have it open, so
  weaving together in the moment flows. This is a hard line, per the purpose
  north star — don't let "engagement" reasoning erode it.

### How it works (sketch)
- **Shared strand key.** Each shared strand gets its own symmetric key (a DEK).
  Pieces in the strand are encrypted to that key, not to one person's vault key.
- **Membership = key distribution.** The strand DEK is wrapped to each member's
  **identity public key** (hence baking identity keys in now). Adding a member
  wraps the DEK to their key; removing a member ideally **rotates** the DEK so
  they can't read future pieces (post-compromise security).
- **Invites/onboarding.** A humane invite (link or short code) that, under the
  hood, does the identity-key exchange — "tap, set your passphrase, you're in" —
  without exposing any crypto to the user. This onboarding *is* most of the work
  and most of the magic.
- **Co-authoring merges.** Concurrent edits/reorders of a shared strand reconcile
  with the same last-write-wins-by-`updatedAt` model as entries, to start.
- **Social recovery.** Split a member's recovery secret across other members
  (K-of-N secret sharing), each share wrapped to a member's public key. K members
  combining their shares can re-grant access. The server holds no usable share.

### Other vision items
- **Media in entries/strands (not just pictures).** Attach encrypted blobs of
  any kind — **images, video, audio/music, other files** — to an entry, so they
  can live in a strand (e.g. add a song to a strand, or a video to a memory).
  Same model as text: encrypted (invariant #1), decrypt-to-blob-URL for
  playback. Local-first is feasible before sharing; *syncing* media pushes the
  server toward object storage (Cloudflare **R2**), since D1 isn't for large
  blobs. **Video especially** is large — storage size + iOS eviction get sharper,
  so per-item/per-account size limits matter.
- **Always free, no ads, donations.** Already the ethos (no third-party scripts
  that can see content). Donations must be a **plain outbound link** (Ko-fi /
  GitHub Sponsors / Stripe link), never an embedded widget (those load trackers).
  **Crypto/Bitcoin fits best of all:** just *display* a wallet address + QR in a
  quiet "Support" panel — no processor, no tracker, no redirect, no fees/KYC, no
  CSP change. Offer crypto addresses alongside one fiat outbound link. (Caveat: a
  reused address is public and links donations together — fine for a tip jar.)
  "Free forever" = cheap enough that donations sustain it → reinforces the lean
  own-your-server choice.

### Dependency order
sync (with identity keys) → sharing (shared strand keys + invites) → family
strands (co-authoring) + social recovery. Pictures and the donation link can ride
alongside independently.

---

## Appendix — Scaling (how millions of users are absorbed)

The two foundational choices already make scale a non-event for most of the app:
**a static PWA on a CDN + local-first.** Don't over-build for millions now (~2
users today); the point is that growth is *adding capacity*, never re-architecting.

### Where the load actually goes
- **The app (static PWA)** — served from Cloudflare Pages' global CDN, edge-cached
  everywhere. Millions of downloads of static files is a solved, near-free problem.
- **Capture / storage / reading / search** — all on the user's **device**
  (local-first). Users who never enable sync cost ~$0 of server. The work is
  distributed across devices by design.
- **Sync server (Workers)** — serverless, auto-scales at the edge, no machines to
  manage. Only sync users ever touch it.
- **Database / blobs** — the one thing that grows with users. See below.

### Why the E2E/sync server scales unusually well
The server stores **opaque ciphertext** and does **no computation on content** —
no search, no processing, no cross-user joins. Just "store blob for user X, give
me user X's blobs since cursor N." It **shards perfectly by `user_id`** (every row
is per-user; no global index). Shared/family strands are **small bounded groups**,
so nothing ever becomes a viral hot object.

### What we account for as it grows
- **D1 limits** (serverless SQLite has per-DB size/throughput ceilings) →
  **partition users across many D1 databases** (trivial, data is per-user and
  independent), and move large blobs — encrypted entries and especially **photos**
  — to **Cloudflare R2** (effectively unlimited, cheap), keeping only small
  metadata/pointers in D1. An additive evolution, not a rewrite.
- **Storage + bandwidth cost** — the *real* constraint (money, not capability).
  Local-first means non-sync users are ~free; sync-with-photos users cost storage.
- **Fairness/abuse** — per-account **rate limits + storage quotas**, enforced at
  the Cloudflare edge; sign-up abuse prevention.
- **Observability** — monitoring + error tracking that is **privacy-preserving**
  (never log entry content — invariant #1).

### The one genuine future decision (not technical)
At millions of **sync-with-photos** users, **"always free" meets storage cost.**
Local-first softens it enormously, but decide early **where the free-tier storage
line sits** so donations can realistically cover it. Keep the sync schema
shardable-by-user (it already is) and blob-friendly so this stays a capacity
question, never an architecture one.

---

## Appendix — Longevity (and why not blockchain)

The goal is an archive that **survives decades — outliving devices, the company,
even the original host.** Decided (2026-07-01): longevity comes from three things
already in place, *not* from a blockchain:

- **Local-first** — the data lives on the family's own devices; no single server
  is a point of failure.
- **Open source (AGPL)** — anyone can run the server forever; it can't be killed
  by a company folding.
- **Portability** — export/backup means the data is never trapped in one place or
  format. (Habitually keeping a Back up file *is* the longevity plan.)

**Why not blockchain (for the data):** immutability fights the app's editing /
soft-delete / privacy-delete; a public, permanent ledger is a privacy time bomb
(harvest-now-decrypt-later on public ciphertext); on-chain writes cost money per
byte (kills "always free"); and E2E small-group sharing needs no trustless global
consensus. It would be worse on privacy, editability, cost, *and* simplicity.

If maximal durability is ever wanted, the sensible option is **opt-in permanent /
decentralized storage of *encrypted* blobs** (e.g. Arweave "pay once, store
forever", or IPFS) — with the same can't-delete + public-ciphertext caveat, so a
deliberate user choice, never the foundation. Crypto stays where it's the right
tool: **donations** (value transfer).
