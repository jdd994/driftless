# Refreshing the self-hosted fonts

The webfonts in `public/fonts/` and the `@font-face` rules in `src/fonts.css` are
generated, not hand-written. You should rarely need to touch them.

## Why they're self-hosted

They used to be pulled from Google Fonts with an `@import` at the top of
`styles.css`, and **they never loaded in production.** The CSP in
`public/_headers` says `style-src 'self'` and `font-src 'self'`, so the browser
refused both the Google stylesheet and the font files, and every page quietly fell
back to Georgia and system-ui. It looked correct in `npm run dev` only because
Vite's dev server doesn't apply `_headers`. See issue #1.

Self-hosting fixes it **without loosening the CSP**, which is the whole point:
allowlisting `fonts.googleapis.com` would place Google inside the trust boundary
of an end-to-end-encrypted journal, and give them a timestamped IP hit every time
someone opens their diary. `DEPLOY.md` already argues we serve our own JavaScript
because *"the host that serves the JavaScript is part of the trust boundary."* The
stylesheet and the fonts are no different.

It also fixes a second bug: Workbox only precaches **same-origin** assets, so a
cross-origin font could never be cached. Driftless is a PWA meant to work at 3am
with no signal — and it would have dropped to Georgia in exactly that moment.
These are same-origin `.woff2`, already matched by `globPatterns` in
`vite.config.ts`, so the typography is right offline.

## Regenerating

Only needed if you change a family, weight, or style.

1. Build the Google Fonts URL you want (the old `@import` is the reference):

   ```
   https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap
   ```

2. Fetch it **with a modern browser User-Agent** — Google serves older formats
   (and no variable fonts) to anything it doesn't recognise:

   ```bash
   curl -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" \
     "<the url>" > /tmp/gf.css
   ```

3. Keep only the `latin` and `latin-ext` subsets. Google returns ~40 `@font-face`
   blocks (cyrillic, greek, vietnamese…); we don't ship or precache those. Note
   that Inter and Newsreader are **variable** fonts — several weights point at one
   file, so download each unique URL once.

4. Rewrite each `src:` to `url('/fonts/<file>.woff2')`, keep the `unicode-range`
   (it's what stops the browser downloading latin-ext unless it's needed), and set
   `font-display: swap`.

5. Drop the files in `public/fonts/`, write the rules to `src/fonts.css`, and
   verify **against a build with the CSP applied** — not `npm run dev`, which
   won't show you the bug:

   ```bash
   npm run build && npx serve dist
   ```

   Then check `document.fonts.size > 0` in the console. Don't trust
   `document.fonts.check()`; it returns true even when the font is absent. The
   reliable test is to measure rendered text width against the fallback:

   ```js
   const w = (f) => { const s = document.createElement('span');
     s.style.cssText = `font-family:${f};font-size:80px;position:absolute;visibility:hidden`;
     s.textContent = 'Handgloves & 12345'; document.body.append(s);
     const x = s.getBoundingClientRect().width; s.remove(); return x; };
   w('"Newsreader", Georgia, serif') !== w('Georgia, serif')  // must be true
   ```

## Licences

All three families are under the SIL Open Font License 1.1, which permits
self-hosting and redistribution. Newsreader and Inter are by Rasmus Andersson /
Production Type et al.; IBM Plex Mono is by IBM.
