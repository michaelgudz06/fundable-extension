# Fundable Chrome Extension

You're on a company's website, LinkedIn, or Crunchbase page. You click the pill and a
panel tells you who they are and what they raised.

```
extension/        MV3, plain JS, no build step
  manifest.json
  background.js   every network call in the extension
  content.js      pill + Shadow DOM panel, zero network calls
  resolver.js     URL -> identifier, plus the deny list
  panel.css       Fundable design tokens
  icons/
proxy/            Next.js on Vercel — holds the Fundable API key
test/             node --test
```

## The one hard requirement

**Every `fetch` happens in `background.js`. The content script makes none, ever.**

Requests issued from a content script appear in the inspected page's DevTools Network
tab. Requests issued from a service worker do not. Someone opening DevTools on LinkedIn
with this extension active should see nothing at all — no card lookup, no logos, no
fonts, no telemetry.

Logos are the easy place to leak one. `background.js` fetches `/api/logo?domain=` itself
and hands the panel a `data:` URL, because a bare `<img src="https://…">` in the panel
would be a page-visible request.

`test/extension.test.js` fails the build if `content.js` ever grows a `fetch`,
`XMLHttpRequest`, `sendBeacon`, `EventSource`, or a remote `src`. If that test goes red,
move the call into the worker — don't loosen the test.

The API key itself never reaches the extension: it lives in Vercel env vars, and the
proxy returns only trimmed card JSON.

## How the two halves talk

`content.js` sends messages; `background.js` answers.

```js
// on panel open — the URL is re-resolved every time because LinkedIn and
// Crunchbase are SPAs and may have navigated since the script ran
{ type: 'init', url }        -> { identifier: {kind, value} | null, css }

{ type: 'lookup', identifier } -> { found: true, card }
                                | { found: false }
                                | { error: 'rate_limited' | 'unavailable' | 'network' }

// once per mounted page — see "PP Mori" below
{ type: 'fonts' }            -> [{ weight, base64 }, …]
```

`identifier: null` means don't show a card here — deny-listed or unrecognised.
`init` also carries `panel.css` as text, since the content script can't read a packaged
file without fetching it. The panel adopts it into its shadow root.

## PP Mori

**An `@font-face` declared inside a shadow root is ignored by Chrome — the file is never
fetched.** So `panel.css` cannot load PP Mori on its own; the face has to be registered on
the document. `content.js` does that in `registerFonts()`.

Registering a face that points at a URL would make the *page* fetch the font, in full view
of its Network tab — the one thing this extension exists to avoid. So the worker fetches
the `.otf` bytes and the content script builds a `FontFace` from binary data, which loads
no URL at all. It also sidesteps the host page's `font-src` CSP, since nothing is fetched.

- Two weights exist, **400 and 600**, shipped as `.otf` (`format('opentype')`).
- The family is registered as **`PP Mori`** — `panel.css` must ask for that exact name.
- The URLs are hardcoded in `FONTS` at the top of `background.js` and their hashes rotate
  on every Fundable deploy. When they go stale the fetch 404s and the card falls back to
  Helvetica/Arial. That fallback is load-bearing: nothing in this path may throw, block, or
  blank the render. The comment above `FONTS` has the two commands that find the new hashes.
- The font is hotlinked rather than bundled because it's licensed to Fundable, not to this
  extension. No `host_permissions` entry is needed — Vercel serves `/_next/static` with
  `access-control-allow-origin: *`.

## Run it locally

```bash
npm install          # jsdom, for the render tests only — the extension has no deps
npm test
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

The proxy origin is the constant `PROXY` at the top of `extension/background.js`. It must
match `host_permissions` in `manifest.json` — change both together.

## The pinned extension ID

`manifest.json` carries a `key` so the ID stays the same across unpacked loads and the
Web Store listing. The proxy locks CORS to that ID, so it isn't cosmetic.

```
igahahnoenbdhhdpgedlncbhahnclokn
```

It was generated with:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out fundable-extension-key.pem
openssl rsa -in fundable-extension-key.pem -pubout -outform DER | base64 | tr -d '\n'   # -> manifest "key"
```

and the ID derived from it:

```bash
openssl rsa -in fundable-extension-key.pem -pubout -outform DER \
  | openssl dgst -sha256 -binary | xxd -p -c 32 | cut -c1-32 | tr '0-9a-f' 'a-p'
```

**The private key is not in this repo and must never be** (`.gitignore` covers `*.pem`).
Keep it in a password manager — it's what signs a `.crx` for self-hosted updates.
Regenerating it changes the extension ID, which breaks the proxy's CORS allowlist and
orphans an existing Web Store listing.

## Known limits

- The panel refetches when reopened. Cheap: the proxy caches cards in Redis for 24h.
- If a host page's CSP blocks `data:` images, logos are hidden and the rest still renders.
- Amounts are formatted as plain USD. If the proxy ever switches to millions, the
  formatter in `content.js` has to switch with it.
