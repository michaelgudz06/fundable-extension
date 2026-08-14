# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Never add a network call to `extension/content.js`.** Content-script requests show up
  in the inspected page's DevTools Network tab; service-worker requests do not, and hiding
  them is the reason this extension is built the way it is. Every `fetch` — card data,
  logos, anything — belongs in `extension/background.js`. `test/extension.test.js` greps
  for violations; if it goes red, move the call, don't loosen the test. README.md § "The
  one hard requirement" has the full rationale.
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
