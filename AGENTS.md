# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **There is no content script.** The UI is the toolbar popup (`extension/popup.html` +
  `popup.js`), opened by clicking the action; `activeTab` gives it the current tab's URL.
  Nothing is injected into any web page, so nothing this extension does can appear in an
  inspected page's DevTools Network tab. Do not reintroduce `content_scripts` — the pill
  is exactly what the user asked to have removed.
- **Every `fetch` still belongs in `extension/background.js`.** The popup asks the worker
  over `chrome.runtime` messaging and gets logos back as `data:` URLs. This is now one
  boundary rather than a privacy rule; keep it, because splitting network ownership across
  two files is how it rots. README.md § "The one hard requirement" has the history.
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
