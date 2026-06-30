# Deploying Driftless (Cloudflare Pages)

Driftless builds to static files (`dist/`), so hosting is just serving that
folder over HTTPS. We use Cloudflare Pages: free, HTTPS by default, and you own
the origin — which matters, because for any end-to-end-encrypted web app the
host that serves the JavaScript is part of the trust boundary. The strict
Content-Security-Policy in `public/_headers` blocks any external script or
network connection, so even the host can't quietly exfiltrate a passphrase.

## One-time setup

1. Create a free Cloudflare account: https://dash.cloudflare.com/sign-up
2. Authenticate the CLI (opens a browser once):

   ```bash
   npx wrangler login
   ```

## Deploy

```bash
npm run deploy
```

This builds and uploads `dist/` to a Pages project named `driftless`. The first
run creates the project and asks which branch is production (pick `main` or
`production`). When it finishes, Wrangler prints your URL, e.g.
`https://driftless.pages.dev` — that's the link you and your friend open and
install to your home screens.

To redeploy after changes, just run `npm run deploy` again.

## Notes

- **Each person's journal is independent and device-local.** Visiting the same
  URL gives each browser its own encrypted vault. There is no shared data and no
  sync yet (see the roadmap in `CLAUDE.md`).
- **Back up occasionally.** The only backup today is the in-app Export button
  (downloads a Markdown copy). Do this now and then until sync exists.
- **When sync is added,** add the API origin to `connect-src` in
  `public/_headers` — and nothing else.
- A custom domain can be attached later in the Cloudflare Pages dashboard; the
  security headers apply there automatically.
