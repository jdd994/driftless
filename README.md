# Driftless

A quiet place to catch thoughts before they vanish.

Quick journaling that opens instantly, organizes everything by time, works
offline, installs to your home screen, and encrypts every entry so only you can
read it.

## What it's for

Driftless is an *inward-facing* place — the opposite of social media. Instead of
performing for an audience and chasing likes, you turn inward: catch your
thoughts, remember what matters, and build stories — alone or together with the
people you love. No metrics, no followers, no comparison, nothing to perform.

**Love is the point: loving yourself, loving others, and sharing that love.**

## Run it

```bash
npm install
npm run dev
```

Open the URL it prints (usually http://localhost:5173). On first launch you'll
set a passphrase — this encrypts your journal.

```bash
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## Install to your home screen

Once it's running (dev or a deployed build over HTTPS):

- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app / Add to Home Screen.
- **Desktop (Chrome/Edge):** the install icon in the address bar.

After installing, it launches full-screen like a native app and works offline —
new thoughts save locally and are there when you reopen it.

## How your privacy works

- Your passphrase is stretched into an encryption key in your browser (PBKDF2 →
  AES-GCM). Entry text is only ever stored as ciphertext, in your device's local
  database (IndexedDB).
- The key is held in memory for the session only. Closing or locking the app
  clears it, so reopening always asks for the passphrase.
- **There is no recovery.** If you forget the passphrase, the entries cannot be
  decrypted by anyone, including the developer. That's the tradeoff for real
  privacy — keep your passphrase somewhere safe.
- **There are no accounts.** Nothing asks who you are; there's no sign-up, no
  email, no server record of you. The passphrase isn't a login — it only
  decrypts the journal on this device. Each device you open the app on gets its
  own independent vault. (When cross-device sync arrives it will add an account,
  but only to identify *which* encrypted blobs are yours — that account and your
  passphrase stay separate secrets, and the passphrase still never leaves your
  device, so the server can store your entries but never read them.)
- Timestamps are currently stored unencrypted (so the app can sort and group by
  time efficiently). This is fine while everything stays on your device; revisit
  it before adding sync. See `CLAUDE.md`.

## Where things live

```
src/
  lib/crypto.ts      encryption (passphrase → key, encrypt/decrypt)
  lib/db.ts          IndexedDB (encrypted entries + vault metadata)
  lib/journal.ts     pure logic: tags, time-grouping, search, export
  hooks/useJournal.ts  the one stateful brain (unlock + CRUD)
  components/        LockScreen, Capture, Toolbar, TagBar, Stream, EntryItem, Toast
  App.tsx            wires it together
```

## Not done yet (on purpose)

Cross-device sync. The app is local-first today: rock-solid on one device,
offline-ready, encrypted. Syncing across devices is the next chapter and needs a
deliberate backend choice — see the roadmap in `CLAUDE.md`.

## License

Driftless is free software under the **GNU Affero General Public License v3.0**
(see `LICENSE`). That choice is deliberate and part of the point: a tool that
promises "no one, not even us, can read your journal" should be **verifiable, not
taken on faith.** The full source is open so anyone can audit the encryption,
and the AGPL guarantees that Driftless — and every fork or hosted version of it —
**stays free and open**, forever. Verify us; don't just trust us.

Copyright (C) 2026 Driftless contributors.
