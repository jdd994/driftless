# Security & staying safe

Driftless is built so that **only you can read what you write** — not us, not
whoever runs the server, not anyone who breaches it. This page explains, plainly,
how that protection works, what it does and doesn't cover, and the few simple
habits that keep *you* safe. Same guidance for everyone, in the open — no
secrets, because the security shouldn't depend on hiding how it works.

## The one thing to understand: two separate secrets

Driftless deliberately uses **two different secrets that do two different jobs**.
Keeping them separate is the whole point — never merge or reuse them.

| Secret | What it's for | If it leaks | If you forget it |
| --- | --- | --- | --- |
| **Passphrase** | Encrypts/decrypts your journal on your device. Never leaves your device, never sent anywhere. | Someone could read your journal. | **It's gone — no reset, by design.** No one, including us, can recover your entries. |
| **Account password** | Logs in to the sync server (so it knows *whose* encrypted blobs are whose). | The server only ever holds ciphertext, so your entries stay unreadable. | Recoverable via the account — your data is safe. |

The passphrase is the crown jewel and it is **unrecoverable**. That's not a bug;
it's what makes the journal truly yours. So protect it accordingly (below).

## How the protection works

- **Local-first & end-to-end encrypted.** Entries are encrypted in your browser
  with AES-GCM using a key stretched from your passphrase (PBKDF2, 600k
  iterations). Only ciphertext is ever written to storage or sent to the server.
- **The key lives in memory only.** Close the app and it's gone; unlocking
  re-derives it from your passphrase. It is never written to disk unsynced or
  transmitted.
- **Sharing stays end-to-end.** A shared/family strand has its own key; members
  exchange it using public-key cryptography (ECDH). The server stores only
  ciphertext and never sees any key. Removing someone re-keys the strand so they
  can't read anything added afterward.
- **Invite links** carry their secret in the part of the URL the browser never
  sends to a server; the server stores only a hash and ciphertext. A link is a
  capability — treat it like a house key (below).
- **No analytics, no third-party scripts, no ads.** A strict Content-Security
  -Policy blocks anything that could read your entries. This is *why* the app is
  the way it is.

## What a server breach would — and wouldn't — expose

Being honest about the threat model matters more than reassuring noise.

**A full server compromise would expose:** account emails, password *hashes*
(PBKDF2, not the passwords), the opaque encrypted blobs, and entry *timestamps*
(these are currently plaintext so the app can sort/group cheaply — see the
roadmap), plus any feedback notes you chose to send.

**It would NOT expose:** your passphrase, your encryption keys, or a single word
of any journal entry or shared strand. Those never reach the server in readable
form.

The realistic risks are therefore *not* the cryptography. They are: a forgotten
passphrase, an unlocked or compromised device, a phished account password, or a
leaked invite link. All four are things good habits prevent.

## Staying safe — the short list

1. **Use a password manager.** Bitwarden (free, open source), 1Password, or
   KeePassXC (offline) all work. It fixes weak and reused passwords in one move.
2. **Store your passphrase in two places:** your password manager *and* on paper
   somewhere safe. Because if you forget it, it's gone for good. Never screenshot
   it (screenshots sync to cloud photo backups), never text or email it, and
   never reuse it anywhere else.
3. **Make your account password different** from your passphrase, strong, and
   unique — and turn on **two-factor authentication on your email account**.
   That email is the real front door to account recovery.
4. **Lock your devices.** Use a strong screen lock and keep your OS and browser
   updated. Quick unlock (biometrics) is great — it just means device security is
   what stands between an unlocked app and your entries.
5. **Treat invite links like keys.** Share them privately (a text, in person),
   not on public posts. If one might have leaked, remove that member — it
   automatically re-keys the strand.
6. **Keep backup files private.** Exported backups and any database dumps hold
   account metadata and password hashes; store them offline, not on shared drives.

## For self-hosters / operators

If you run your own server, also: enable 2FA on your Cloudflare (or host)
account; keep deploy/API tokens scoped and secret; and remember the database
backup (`npm run backup`) contains emails, password hashes, and feedback — keep
it somewhere safe. Cloudflare D1 keeps 30 days of automatic point-in-time
recovery on top of that.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Instead, use GitHub's
private vulnerability reporting on this repository (the **Security** tab →
*Report a vulnerability*). If that isn't available to you, send a note through
the in-app "note to the maker" box and say it's security-sensitive, and we'll
follow up privately.

Responsible disclosure is genuinely appreciated — this is an app people trust
with their inner lives, and reports that help keep that trust are a gift.
