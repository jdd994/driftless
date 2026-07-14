# Hardening & cost safety

The threat/cost model for the sync backend, what's in place, and what's next.
Applies to **Driftless**, to **Ballast** once its server exists, and to any future
sharable app — the server pattern (and these protections) are meant to be reused.

## Why this matters

The Cloudflare account has a **real credit card** on it, and **Cloudflare has no
hard spend cap** — you cannot tell it "stop at $50." So the strategy is: bound
what any single actor can cost (quotas), make abuse expensive to attempt
(signup friction), drop floods before they bill you (edge rules), and make sure
you *find out fast* if something runs away (billing alerts).

## The cost model (what actually costs money)

Most of the app is naturally cheap, by design:

- **Static PWA on Pages/CDN** — millions of downloads is effectively free.
- **Local-first** — anyone who never enables sync costs ~$0 of server.
- **R2 egress is free** — photo downloads don't rack up bandwidth bills.
- **The server stores opaque ciphertext and does no computation** — cheap per
  request, shards perfectly per user.

So the real risk is not success; it's **malice and runaway**:
- unbounded storage per account (D1 rows/bytes, R2 media),
- mass account creation (bots),
- request floods (Workers bill per invocation; D1 per read/write).

## In place

| Protection | Where | Notes |
|---|---|---|
| Rate limit: register 10/hr/IP, login 30/15min/IP, feedback 8/hr | `withinRateLimit` | D1-backed fixed window, keyed by action+IP+bucket |
| Per-photo size cap (8 MB) | `/media` PUT | images are compressed client-side first |
| Push/pull caps (1000 / 500) | `/sync/push`, `/sync/pull` | bounds a single request |
| 30-day signed tokens (HMAC) | `auth.ts` | opaque bearer token, not the key |
| PBKDF2 password hashing | `auth.ts` | login secret only; never the encryption key |
| **Per-user object quota** (100k rows / 100 MB text) | `/sync/push` | **added — bounds D1 growth per account** |
| **Per-user media quota** (2 GB) | `/media` PUT + `user_usage` | **added — bounds R2 growth per account** |

Worst case per maxed account ≈ 100 MB D1 + 2 GB R2 ≈ pennies/month of storage,
free egress. Combined with the register rate limit, total cost stays bounded and
predictable.

## Next, in priority order

### 1. Billing alerts — do this now (dashboard, no code)
Cloudflare → Notifications → billing/usage alerts at a threshold you'd want to
know about. This is the smoke detector. Nothing below matters as much as knowing
early. **Only you can set this** (account owner).

### 2. Turnstile on signup (bots)
Cloudflare's free, privacy-friendly CAPTCHA. The register rate limit is per-IP,
so a botnet with many IPs walks past it; Turnstile stops mass signup at the door.
- Create a Turnstile widget (dashboard) → site key + secret key.
- Client: render the widget on the account-create screen; send the token with
  `/auth/register`.
- Server: verify the token against Turnstile's `siteverify` before creating the
  user. Reject on failure.
Highest-leverage anti-abuse move after quotas.

### 3. Edge rate limiting / WAF (floods)
Cloudflare rules that drop abusive traffic **before it invokes the Worker**, so a
flood costs nothing. A WAF rate-limiting rule on `/auth/*` and `/sync/*` per IP is
a second layer under the in-Worker limiter (which still bills the invocation).
Dashboard config.

### 4. Global signup circuit-breaker
A ceiling on *total* new accounts per hour/day (not just per IP) as a blunt
backstop: if signups spike 100× (attack or unexpected virality), pause new
registrations and alert, rather than absorb unbounded new accounts. Small D1
counter, same shape as `withinRateLimit` but un-keyed by IP.

### 5. Token rotation + shorter TTL
30-day tokens are long. Add refresh + shorter access-token TTL, and a way to
revoke (a token version on the user row, or a sessions table). Limits the blast
radius of a leaked token.

### 6. Shared-strand media quota
Personal media is now quota'd; **shared** media (`/shared/:id/media`) is not.
Lower risk (membership-gated, small groups), but a shared strand could still grow
unbounded. Attribute shared-media bytes to the uploader's `user_usage` (or the
strand owner's), same pattern.

### 7. Tombstone content purge
Deletes are soft — the ciphertext stays in `objects` with `deleted=1`. The client
never decrypts a tombstone's content, so the server can store deleted rows with
**empty content** to reclaim bytes (the object quota already counts tombstones, so
this also lets a user free space by deleting). Purge on delete, or sweep old
tombstones past a horizon.

### 8. Privacy-preserving abuse monitoring
Per-user request/error metrics to spot abuse — **never logging entry content**
(invariant #1). Alert on anomalies (one account pushing constantly, a spike in
413s).

## Deploying the quota change (ordering matters)

The media quota needs the `user_usage` table to exist **before** the new code
runs, or its queries fail. So:

1. Apply the schema (idempotent — `CREATE TABLE IF NOT EXISTS`):
   ```
   cd server && npm run db:init          # --remote, production D1
   ```
2. Then deploy the Worker (merging to `main` auto-deploys via the GitHub Action,
   or `npm run deploy` from `server/`).

The object quota needs no migration and is safe to deploy any time. Doing the
migration first makes the whole change safe to ship together.

## Cross-app note

When Ballast's sync server is built, start from this checklist — quotas,
Turnstile, billing alerts, and the rate limiter should be in its first commit, not
retrofitted. Same for any future app. The cheapest time to add cost safety is
before there are users, not after a surprise bill.
