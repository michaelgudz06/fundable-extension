# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **The UI is a transparent overlay iframe, injected on click — not a toolbar popup and
  not a declared content script.** Clicking the action fires `chrome.action.onClicked`
  (there is deliberately no `action.default_popup`, which would suppress it); the worker
  runs `extension/inject.js` into the active tab via `chrome.scripting.executeScript`
  under `activeTab` — on click only, this tab only, no broad host permission. `inject.js`
  mounts a transparent `<iframe>` whose src is `popup.html` (a `web_accessible_resource`
  with `use_dynamic_url`), so the card is a cross-origin extension page: its DOM and data
  never touch the host page. A popup could not have true rounded/transparent corners
  (Chrome paints action popups opaque and rectangular), which is why it is an overlay.
  `inject.js` does **no** network — it only mounts the frame and toggles it off on a
  second click. Do **not** add a declared `content_scripts` entry: injection is on-click
  only, which is what keeps the extension off every page.
- **Every `fetch` still belongs in `extension/background.js`.** `popup.js` and `inject.js`
  issue none — the overlay asks the worker over `chrome.runtime` messaging and gets logos
  back as `data:` URLs. Tests enforce the no-network rule on both files. Keep it: splitting
  network ownership is how it rots. README.md § "The one hard requirement" has the history.
- `extension/panel.css` is an ordinary extension-page stylesheet loaded by `<link>`, so it
  may reference remote assets — PP Mori is a plain `@font-face` against Fundable's CDN.
  Helvetica/Arial fallback is load-bearing: the hashed font filenames rotate on every
  Fundable deploy and nothing may break when they 404.
- The extension ID is pinned by `key` in `extension/manifest.json` and the proxy's CORS
  allowlist depends on it. Do not regenerate it. See README.md § "The pinned extension ID".
- `npm install` / `npm test` at the repo root are for the extension only (jsdom for render
  tests). The extension itself has no dependencies and no build step — plain MV3 JS.
  `proxy/` is a separate Next.js app with its own package.json.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
