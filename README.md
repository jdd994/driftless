# Driftless

**A quiet place to catch thoughts before they vanish.**

Open it and the cursor is already waiting. Type; it's kept, timestamped, and
threaded onto your timeline — instantly, offline, and end-to-end encrypted so only
you can read it. Install it to your home screen and it opens like an app.

**→ [driftless.page](https://driftless.page)** — open it, and add it to your home
screen (see below). No sign-up, nothing to install from a store.

## What it's for

Driftless is an *inward-facing* place — the opposite of social media. Instead of
performing for an audience and chasing likes, you turn inward: catch your
thoughts, remember what matters, reflect, and build stories — alone or together
with the people you love. No metrics, no followers, no comparison, nothing to
perform.

**Love is the point: loving yourself, loving others, and sharing that love.**

## What it does

- **Capture, instantly.** The cursor waits; type and keep. Saved on your device
  the moment you do, online or off.
- **Three ways to see your thoughts.** *Stream* (in the order you wrote them),
  *Timeline* (arranged by when things actually happened — give a thought a place
  in time, even a fuzzy one like "childhood"), and *Strands* (gather pieces into a
  named, ordered whole — a memory, a song, a chapter — and read them as one).
- **Photos.** Attach encrypted images to a thought or a strand.
- **Sync across your devices.** Optionally connect an account and your journal
  travels — encrypted — to every device you sign in on. The server only ever
  stores unreadable ciphertext (see privacy, below).
- **Shared strands.** Build a story *together* — a co-authored, end-to-end
  encrypted strand only its members can read. A private, family memory keeper.
- **Quick unlock.** Optional Face ID / Touch ID / fingerprint on a device, on top
  of the passphrase.
- **Back up & export.** An encrypted backup file, or a plain readable Markdown
  export — your words are never trapped.

## Install to your home screen

Open **[driftless.page](https://driftless.page)**, then:

- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app / Add to Home Screen.
- **Desktop (Chrome/Edge):** the install icon in the address bar.

It then launches full-screen like a native app and works offline.

## How your privacy works

- Your passphrase is stretched into an encryption key in your browser (PBKDF2 →
  AES-GCM). Everything you write is only ever stored as ciphertext, in your
  device's local database (IndexedDB) and — if you sync — on the server.
- The key lives in memory for the session only. Closing or locking the app clears
  it, so reopening always asks for the passphrase.
- **There is no recovery.** If you forget the passphrase, nothing can decrypt your
  journal — not us, not anyone. That's the tradeoff for real privacy; keep it
  somewhere safe.
- **Accounts are optional, and separate from your passphrase.** You only need one
  to sync across devices. Even then, the account and the passphrase are two
  different secrets doing two different jobs: the account tells the server *whose*
  encrypted blobs these are; the passphrase decrypts them and **never leaves your
  device.** A breach of the server would expose only unreadable ciphertext.
- Timestamps are currently stored unencrypted (so the app can sort and group by
  time cheaply). This leaks *when* you write, never *what* — an explicit, revisit-
  able decision. See `SYNC_PLAN.md`.

For the full threat model, what a breach would and wouldn't expose, and how to
report a vulnerability, see **[SECURITY.md](SECURITY.md)**.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve the production build
```

The sync server is a separate tiny Cloudflare Worker in [`server/`](server/); the
app works fully without it (local-only).

## Where things live

```
src/
  lib/crypto.ts        encryption (passphrase → key, encrypt/decrypt, identity keys)
  lib/db.ts            IndexedDB (encrypted entries, strands, media, sync state)
  lib/journal.ts       pure logic: tags, time-grouping, strands, search, export
  lib/sync.ts          the reconcile engine (moves ciphertext; never the key)
  lib/api.ts           sync-server client
  hooks/useJournal.ts  the one stateful brain (unlock + CRUD + sync)
  components/          Stream, Timeline, StrandsView, SharedView, Capture, …
  App.tsx              wires it together
server/                Cloudflare Worker + D1: accounts, vault, sync, sharing
```

See `CLAUDE.md` for the architecture and invariants, `SYNC_PLAN.md` and
`SHARING_PLAN.md` for the build plans, and `HARDENING.md` for the cost/abuse model.

## Licence

Driftless is free software under the **GNU Affero General Public License v3.0**
(see `LICENSE`). That choice is deliberate and part of the point: a tool that
promises "no one, not even us, can read your journal" should be **verifiable, not
taken on faith.** The full source is open so anyone can audit the encryption, and
the AGPL guarantees that Driftless — and every fork or hosted version of it —
stays free and open, forever. Verify us; don't just trust us.

Copyright (C) 2026 Driftless contributors.
