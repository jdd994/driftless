# CLAUDE.md — Driftless

Context for Claude Code working in this repo. Read this first.

## What this is

Driftless is a personal journaling PWA built around one job: **remove all
friction between a fleeting thought and its safe landing.** Open it, the cursor
is already waiting; type; it's kept, timestamped, and threaded onto a timeline.

It is **local-first** and **end-to-end encrypted**. It is **not** yet synced
across devices — that's the main open chapter (see Roadmap).

## Purpose (the north star)

Driftless is an **inward-facing "social" app.** Where social media is outward
performance rewarded by metrics — likes, followers, views, and the comparison
and extraction that follow — Driftless inverts it:

- **Inward first:** catch your own thoughts, remember, reflect. Taking your
  inner life seriously is loving yourself.
- **Then outward from love, not for validation:** share a story, or build one
  *together* with people you love (shared/family strands), openly.
- **No scoreboard:** no likes, follower counts, or rankings — the reward is
  connection and meaning, not dopamine.

**Love is the point — loving yourself, loving others, and sharing that love.**

Filter every feature through one question: *does this deepen love, reflection,
and genuine connection, or does it sneak in performance, comparison, or
extraction?* If the latter, don't build it — no matter how normal it is for a
"social" app. **Never** add likes, follower/vanity counts, public metrics,
algorithmic feeds, ads, or engagement hooks. This is *why* the app is E2E,
local-first, no-ads, no-analytics, and open-source: those choices serve
love-as-the-point, not extraction. And it must stay **easy and intuitive** —
presence shouldn't require effort.

## Design intent (don't flatten this)

- The feeling is a quiet, warm, lamplit room — calm at any hour, including 3am.
- Palette and type are deliberate (warm near-black, amber "lamplight" accent, a
  serif for written words, mono for timestamps). The tokens live in
  `src/styles.css`. Keep new UI consistent with them; don't introduce a generic
  blue/gray admin look.
- The **time rail** (vertical line with the amber "now" tick) is the signature
  element. Newest entry sits at the top, right under the capture box.

## Stack

- Vite + React 18 + TypeScript
- `vite-plugin-pwa` (Workbox) for manifest + offline service worker
- `idb` for IndexedDB
- WebCrypto (AES-GCM + PBKDF2) for encryption — no crypto dependencies

## Architecture

- `src/lib/crypto.ts` — passphrase → AES-GCM key; encrypt/decrypt; verifier.
- `src/lib/db.ts` — IndexedDB (v4). Stores: `vault` (salt + verifier),
  `entries` (ciphertext + plaintext timestamps + `deleted` tombstone + `dirty`
  outbox flag), `sync` (pull cursor + auth token; unused until the sync engine
  lands), `device` (per-device biometric enrollment: a passkey id + the vault
  key wrapped by its WebAuthn-PRF secret — device-local, never synced), and
  `strands` (named ordered collections; ciphertext of `{title, entryIds}`).
  Deletes are soft (tombstone), filtered out of the UI. See SYNC_PLAN.md.
- Three organizing axes for entries: capture time (Stream), lived/anchor time
  (Timeline — `anchor` lives inside the encrypted payload), and narrative order
  (Strands). Anchors and strand title/order are content, so both are encrypted
  and sync for free as ciphertext.
- `src/lib/journal.ts` — pure, IO-free logic (tags, grouping, search, export).
  Prefer adding logic here and unit-testing it.
- `src/hooks/useJournal.ts` — the only place state and IO meet. Holds decrypted
  entries + the session key (in a ref, never persisted). All CRUD goes through
  it so plaintext never leaks to storage.
- `src/components/*` — presentational; they receive data and callbacks.

### Invariants — please preserve

1. Plaintext entry content must never be written to storage, logs, or the
   network. Only ciphertext leaves memory.
2. The encryption key stays in memory only (a ref in `useJournal`). No writing
   it to IndexedDB/localStorage without an explicit, discussed "remember this
   device" decision.
3. Capture stays instant and offline-capable. Saving a thought must not depend
   on a network round-trip.
4. **Authentication and encryption stay separate.** Today there is no account
   of any kind — the passphrase is *only* a decryption key for the local vault;
   it is never sent anywhere and never checked against a server. When sync adds
   an account (to answer "whose ciphertext is this?"), the account secret and
   the encryption passphrase remain two different secrets doing two different
   jobs: the server authenticates the account and stores opaque blobs; the
   passphrase/derived key decrypts them and never leaves the device. Never
   collapse the two (e.g. don't derive the encryption key from the login
   credential, and don't transmit the passphrase or key). A server compromise
   must yield only unreadable ciphertext.

## Conventions

- TypeScript strict is on. Keep it green.
- Small, focused components. Pure logic → `lib/`. State/IO → the hook.
- Match existing class names and the token system in `styles.css`.
- Copy is plain, calm, second person. Errors say what happened and what to do.

## Commands

```bash
npm run dev      # local dev server (PWA enabled in dev for testing install)
npm run build    # tsc -b && vite build
npm run preview  # serve the built app
```

## Roadmap (in order)

1. **Sync backend — DECIDED (2026-06-30): a tiny custom server.** Chosen over a
   managed option (e.g. Supabase) for more control and the smallest trust
   surface. The model: the client encrypts, the server stores opaque ciphertext,
   devices reconcile. (Cloudflare Workers + D1 is a candidate host, since the
   app is already deployed on Cloudflare Pages — gives "your own server" with
   near-zero ops.) Not built yet.
2. **Sync engine.** Per-entry records already have `id`, `createdAt`,
   `updatedAt`. Add a `deleted` tombstone + a `syncedAt`/version field and do
   last-write-wins by `updatedAt` to start. Push/pull ciphertext on reconnect;
   the service worker can do background sync.
3. **Encrypt timestamps** before/when syncing if metadata privacy matters (today
   they're plaintext so local sort/group is cheap). Decide explicitly.
4. **Account + key portability.** To read the same journal on a new device, the
   user re-enters the passphrase there; the salt must travel with the account.
   Never transmit the passphrase or derived key — only the salt + ciphertext.
   The account (login) and the passphrase are deliberately separate secrets —
   see invariant 4: the account says *whose* ciphertext this is; the passphrase
   *decrypts* it and never leaves the device. Don't derive the key from the
   login credential.
5. Niceties (some done): named threads → **Strands (done)**, biometric →
   **Quick unlock (done)**, richer export → **encrypted Back up (done)**,
   media in entries/strands → **polaroids (done)**, co-authored shared/family
   strands → **Sharing S1–S4 (done)**, in-app landing → **warm first-run
   welcome (done)** — `Welcome.tsx`, the first setup step, states the "no reset"
   trade up front (the PWA link *is* the distribution; no separate marketing
   site). Still open: a **calm suggestion
   box** (GitHub Discussions now — zero-infra, engage at your pace; optional
   in-app box posting to our own D1 later — framed "read when I can, no
   obligation"); **media in entries/strands** (see SYNC_PLAN); pin/favorite;
   per-day word count; a **custom domain** (prettier/trustworthier link,
   DNS-only maintenance).
6. **Strand evolution — "substrands"/sections (idea, not now).** Composition at
   multiple scales: fragments → section → whole (chapters in a book, movements
   in a song). Avoid arbitrary recursive nesting (strand-in-strand trees drift
   toward a fiddly outliner and fight the "calm, easy, intuitive" pillar).
   Lightest, most on-brand approach: a **section is just a piece flagged as a
   heading** — everything until the next heading belongs to it. Keeps the flat
   model and "everything is a thought," gives grouped fragments + read-as-one
   flow, no new hierarchy to manage. ~90% of the value, little of the risk.
   Design carefully, after sync.

## Watch out for

- StrictMode double-invokes effects in dev — keep effects idempotent.
- IndexedDB calls are async; the UI updates optimistically in the hook, then
  persists. Keep that order so capture feels instant.
- Don't add analytics or any third-party script that could see entry content.
