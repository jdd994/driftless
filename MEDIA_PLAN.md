# Media sync plan — encrypted photos across devices & shared strands

Status: **design; build M1 (personal) first, then M2 (shared).** Photos are the
last local-only piece. Text and a *reference* already sync; the image bytes stay
on the device they were added on (hence "photo added from another device"). This
adds an encrypted-blob road so photos travel — to your other devices, and into
shared strands — while the server still never sees an image.

Guiding pillars (unchanged):
- **End-to-end.** The server stores only opaque ciphertext. A breach yields no
  viewable image. Personal photos are encrypted with your vault key; shared
  photos with the strand DEK (so every member can see them, the server can't).
- **Local-first stays local-first.** Capture and attach never wait on a network
  round-trip; upload happens in the background sync, download is on demand.

---

## Why R2 (not D1)

Images are big binary blobs, not the tiny ciphertext the sync path carries. D1 is
the wrong tool (row/size limits, bloat). **Cloudflare R2** is object storage made
for exactly this, and the app already lives on Cloudflare. Photos are compressed
client-side (max ~1600px, JPEG ~0.85) so they're typically < 1 MB.

## Storage model

- **Bucket:** `driftless-media`.
- **Object = `iv (12 bytes) || ciphertext`** — self-contained; the object is the
  same AES-GCM ciphertext already produced on device, with its nonce prepended.
- **Content type** (`image/jpeg`…) stored as R2 metadata (not secret; needed to
  render). No plaintext, no dimensions beyond that.
- **Key scheme:**
  - Personal: `u/<userId>/<mediaId>` — encrypted with the vault key.
  - Shared: `s/<strandId>/<mediaId>` — encrypted with the strand DEK.
- **No D1 media table needed.** Entries already reference `mediaIds`; the client
  fetches by id when a referenced photo isn't local. Access is gated by the key
  prefix (own `userId`) or by `membership(strandId)`.

## Server endpoints (Worker + R2 binding `MEDIA`)

- `PUT /media/:id` (auth) — upload own photo. Body = `iv||ciphertext`; `?type=`
  → stored as R2 metadata. Key `u/<userId>/<id>`. Size-capped (e.g. 8 MB).
- `GET /media/:id` (auth) — download own photo (key `u/<userId>/<id>`).
- `PUT /shared/:strandId/media/:id` (auth + membership) — key `s/<strandId>/<id>`.
- `GET /shared/:strandId/media/:id` (auth + membership).
- `DELETE` variants (optional, for freeing space) — deferred; orphaned-blob GC is
  a later cleanup.

## Client changes

- **Upload:** attaching a photo stays instant (encrypt + store locally + mark
  `dirty`, as today). The background sync then uploads dirty media (`PUT`), and
  clears the flag — mirroring how entries/strands already sync.
- **Download on demand:** `getMediaUrl(id)` — if the bytes aren't on this device,
  fetch from R2, decrypt, cache in memory, and persist locally so it's there next
  time. This is what makes "photo added from another device" resolve itself.
- **Shared photos** need the strand DEK + strandId to encrypt/decrypt, so the
  shared media path is threaded through the shared-strand layer (M2).

## Phases (each shippable; test cross-device / with a 2nd person)

1. **M1 — Personal media sync.** R2 bucket + `PUT/GET /media/:id`; upload dirty
   media in the sync loop; download-on-demand in `getMediaUrl`. Fixes photos
   across *your own* devices. No change to shared strands. **Build first.**
2. **M2 — Shared strand photos.** Let a shared strand carry photos (it's text-only
   today): a shared piece may include `mediaIds`, encrypted with the strand DEK;
   `PUT/GET /shared/:id/media/:id` (membership-gated); the Shared view renders
   polaroids inline. Delivers the family vision — weave in photos together.
3. **M3 — housekeeping (later).** Delete-from-R2 on removal, orphaned-blob GC,
   per-strand/quota limits, and DEK-rotation handling for shared media (re-upload
   under the new epoch, like pieces).

## Decisions / limits (v1)

- **R2, `iv||ct` objects, type as metadata.** No separate media DB table.
- **Personal = vault key; shared = strand DEK.** Never mix.
- **Size cap** per image server-side (compression keeps them small anyway).
- **On-demand download + local cache** — a fresh device stays light and pulls
  photos only when actually viewed.
- **Deferred:** deletes/GC, quotas, shared-media re-key on rotation (M3).

## What you need to enable (one-time)

Turn on **R2** in the Cloudflare dashboard (free tier: 10 GB storage, generous
op limits — plenty for a family; enabling R2 may require a card on file). Then
the bucket + binding get wired and M1 ships.
