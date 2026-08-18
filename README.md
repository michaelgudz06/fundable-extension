# Fundable Chrome Extension

You're on a company's website, LinkedIn, or Crunchbase page. You click the Fundable icon
in the toolbar and a card slides in at the top-right telling you who they are and what
they raised.

```
extension/        MV3, plain JS, no build step
  manifest.json
  background.js   every network call in the extension
  inject.js       mounts the overlay iframe on click; no network
  popup.html      the overlay card shell
  popup.js        card rendering, zero network calls
  resolver.js     URL -> identifier, plus the deny list
  panel.css       Fundable design tokens
  icons/
proxy/            Next.js on Vercel — holds the Fundable API key
test/             node --test
```

The card is a transparent iframe, injected only when you click the icon — not a declared
content script, and not the always-on pill earlier versions put on every https page (that
pill is gone). Clicking the action fires `chrome.action.onClicked` (there is no
`default_popup`), and `background.js` runs `inject.js` into the active tab with
`chrome.scripting.executeScript` under `activeTab` — this tab only, on click only, no
broad host permission. `inject.js` mounts a transparent `<iframe src=popup.html>`; the
card is a cross-origin extension page, so its DOM never touches the host page. A toolbar
popup can't have transparent rounded corners — Chrome paints it opaque and rectangular —
which is why the card is an overlay. A second click toggles it off.

## The one hard requirement

**Every `fetch` happens in `background.js`. `popup.js` and `inject.js` make none, ever.**

This started as a privacy rule: requests issued from page-side script appear in the
inspected page's DevTools Network tab, and requests issued from a service worker do not.
The card runs in a cross-origin extension iframe now, so its requests would already be
invisible to the host page — but the rule stays anyway, because one file owning the
network is one place to audit, one place the proxy origin is named, and one place
`host_permissions` has to match. `inject.js`, the one file that does touch the host page,
issues no request at all; it only mounts the frame. Tests enforce the no-network rule on
both `popup.js` and `inject.js`.

`background.js` fetches `/api/logo?domain=` itself and hands the card a `data:` URL, so
the proxy origin never appears in the card's markup either.

The API key itself never reaches the extension: it lives in Vercel env vars, and the
proxy returns only trimmed card JSON.

## How the two halves talk

`popup.js` sends messages; `background.js` answers.

```js
// once per overlay open, against the active tab's URL (activeTab grants access,
// because clicking the icon is a user invocation)
{ type: 'init', url }          -> { identifier: {kind, value} | null }

{ type: 'lookup', identifier } -> { found: true, card }
                                | { found: false }
                                | { error: 'rate_limited' | 'unavailable' | 'network' }
```

`identifier: null` means this isn't a company page at all — a random site, a search page,
or a deny-listed one. The card says exactly that ("Sorry, we couldn't find a company on
this page.") and, crucially, does *not* promise coverage. The coverage promise ("Sorry,
this company isn't available yet — we'll work on adding it.") is shown only when a lookup
resolves and comes back `{ found: false }` — a page that really is a company Fundable
doesn't have yet. The two must never be swapped: a random page told "we'll add it" is a
claim that was never checked.

The overlay iframe is a fresh document each time it's mounted, so there is no SPA
navigation to follow and no stale-response race to guard: one open, one lookup, then a
second click (or the close button) tears it down.

## PP Mori

`panel.css` loads PP Mori with a plain `@font-face` against Fundable's CDN. That is fine
here — the card is a cross-origin extension page, so the font request comes from
`chrome-extension://` and touches no web page. (Inside the old shadow-root panel it was
not: Chrome ignores an `@font-face` declared in a shadow root outright, and registering
one on the host document would have made the *page* fetch the file.)

- Two weights exist, **400 and 600**, shipped as `.otf` (`format('opentype')`).
- The family is **`PP Mori`**.
- The hashed URLs are at the top of `panel.css` and rotate on every Fundable deploy. When
  they go stale the fetch 404s and the card falls back to Helvetica/Arial. That fallback
  is load-bearing — the type scale is set so the card still reads without PP Mori. The
  comment above the `@font-face` rules has the two commands that find the new hashes.
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

- The overlay refetches every time it opens. Cheap: the proxy caches cards in Redis for 24h.
- Amounts are formatted as plain USD. If the proxy ever switches to millions, the
  formatter in `popup.js` has to switch with it.
