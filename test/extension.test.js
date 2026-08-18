import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const path = (p) => new URL(`../extension/${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

// The worker registers its listener and reads chrome.* as it loads, so the stubs
// have to be standing before the import.
let route = () => {
  throw new Error('no route set');
};
let listener;
let clickListener;
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (name) => `chrome-extension://test/${name}`,
    onMessage: { addListener: (fn) => (listener = fn) },
  },
  // background.js registers an onClicked handler at load to inject the overlay.
  action: { onClicked: { addListener: (fn) => (clickListener = fn) } },
  scripting: { executeScript: async () => {} },
};
globalThis.fetch = async (url, options) => route(url, options);

await import('../extension/background.js');

// The popup is a document, so jsdom has to be standing before popup.js loads
// too. Its auto-run is guarded on chrome.tabs, which nothing has defined yet.
const dom = new JSDOM('<!doctype html>');
globalThis.document = dom.window.document;
const popup = await import('../extension/popup.js');

// ---------------------------------------------------------------------------
// The one hard requirement, re-expressed for the popup.
//
// It used to be a privacy rule: a request issued from a content script shows up
// in the inspected page's DevTools Network tab and gives the whole thing away.
// The content script is gone, so that leak is gone with it — a popup is an
// extension page and nothing it fetches is visible to any web page. The rule
// stays anyway, one rung weaker but still absolute: popup.js builds no remote
// URL and issues no request. Card data and logos arrive over chrome.runtime
// messaging (logos already inlined as data: URLs), and the stylesheet arrives
// through <link> from the extension's own package. One file owning the network
// is one place to audit, one place the proxy origin is named, and one place
// host_permissions has to match. If this fails, the fix is to move the call into
// background.js — never to loosen the test.
// ---------------------------------------------------------------------------

// Only whole-line comments are stripped, so a violation can't hide behind one.
const popupCode = read('popup.js').replace(/^\s*\/\/.*$/gm, '');

const FORBIDDEN = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/sendBeacon/, 'navigator.sendBeacon()'],
  [/EventSource/, 'EventSource'],
  [/WebSocket/, 'WebSocket'],
  [/importScripts/, 'importScripts()'],
  [/\bnew\s+Worker\b/, 'new Worker()'],
  [/\binnerHTML\b/, 'innerHTML (also an XSS hole)'],
  [/\bsrc\s*=\s*[`'"]\s*https?:/i, 'a remote src= URL'],
  [/<img[^>]*\bsrc\s*=\s*[`'"]?\s*https?:/i, 'a remote <img src>'],
  [/createElement\(\s*[`'"]link[`'"]/, "createElement('link') — a remote stylesheet"],
  [/url\(\s*[`'"]?\s*https?:/i, 'a remote CSS url() — assets must arrive as data: URLs'],
];

test('popup.js issues no network calls of its own', () => {
  for (const [pattern, what] of FORBIDDEN) {
    assert.equal(
      pattern.test(popupCode),
      false,
      `popup.js uses ${what}; every network call belongs in background.js`,
    );
  }
});

// ---------------------------------------------------------------------------
// panel.css is no longer page CSS. It is loaded by <link> into an extension
// page, so whatever it references is fetched from chrome-extension:// and no web
// page's Network tab can see it. The old rule — "a data: URI or nothing, ever" —
// is therefore genuinely relaxed here, and this test is that relaxation written
// down rather than quietly deleted.
//
// What replaces it is still narrower than "anything goes": a reference must be
// inert (data:, a fragment) or Fundable's own CDN, which is where the documented
// PP Mori @font-face points. A third-party origin in this file would tell that
// third party who opens the popup and when, and a typo'd path ships broken.
//
// One extractor, in one place: nothing in the extension parses CSS any more, so
// there is no second copy for this one to drift away from.
// ---------------------------------------------------------------------------

const FONT_ORIGIN = 'https://www.tryfundable.ai/_next/static/';

// url() in any quoting, plus any quoted absolute or protocol-relative URL —
// which is how image-set(), @import and a custom property each carry one.
// Comments go first: nothing fetches a comment.
const rules = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const cssReferences = (css) =>
  [
    ...rules(css).matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|["']((?:https?:)?\/\/[^"']*)["']/g,
    ),
  ].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);

test('panel.css fetches only inert data or Fundable’s own CDN', () => {
  const refs = cssReferences(read('panel.css'));
  assert.ok(refs.length, 'the extractor matched nothing; a guard that reads nothing guards nothing');
  for (const ref of refs) {
    if (/^(data:|#)/.test(ref)) continue;
    assert.ok(
      ref.startsWith(FONT_ORIGIN),
      `panel.css points at ${ref}; the popup would fetch it from a third party`,
    );
  }
});

// The hashed font filenames rotate on every Fundable deploy, so a 404 is the
// normal steady state, not an edge case. What has to survive it is the fallback.
test('PP Mori is declared for both weights, behind a fallback that survives a 404', () => {
  // Comments off first: the header above the rules documents @font-face and the
  // curl commands that refresh the hashes, and prose is not a declaration.
  const css = rules(read('panel.css'));
  // Scoped to the @font-face blocks: `font-weight: 600` also styles half the
  // card, and counting those would pass whatever the faces actually declare.
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(faces.length, 2, 'PP Mori ships as 400 and 600');
  assert.deepEqual(faces.map((f) => f.match(/font-weight:\s*(\d+)/)?.[1]), ['400', '600']);
  for (const face of faces) assert.match(face, /font-family:\s*'PP Mori'/);
  assert.match(
    css,
    /font-family:\s*'PP Mori',\s*Helvetica,\s*Arial,\s*sans-serif/,
    'the Helvetica/Arial fallback is load-bearing — the filenames go stale',
  );
});

test('manifest injects the overlay on click, declares no content script, and pins the ID', () => {
  assert.ok(manifest.key, 'manifest needs a pinned key for a stable extension ID');
  assert.equal(manifest.background.type, 'module');
  assert.ok(
    !('content_scripts' in manifest),
    'nothing is injected declaratively — the overlay mounts only on click, via scripting+activeTab',
  );
  // No default_popup: with it set, chrome.action.onClicked never fires and the
  // worker could not inject the overlay. Its absence is what makes the click
  // reach background.js.
  assert.ok(!manifest.action?.default_popup, 'a default_popup would suppress onClicked; the overlay needs the click');
  assert.ok(existsSync(path('popup.html')), 'the overlay renders popup.html, so it has to exist');
  assert.ok(existsSync(path('inject.js')), 'the click injects inject.js, so it has to exist');
  assert.deepEqual(
    manifest.permissions,
    ['activeTab', 'scripting'],
    'activeTab grants this tab on click; scripting runs inject.js into it — no broad host permission',
  );
  // popup.html is framed by inject.js from the host page, so it must be a
  // web-accessible resource. use_dynamic_url rotates the URL per load, which
  // stops a page from fingerprinting the extension by a static resource URL.
  const war = manifest.web_accessible_resources ?? [];
  const entry = war.find((e) => e.resources?.includes('popup.html'));
  assert.ok(entry, 'popup.html must be web-accessible for inject.js to frame it');
  assert.equal(entry.use_dynamic_url, true, 'a static resource URL is a fingerprinting handle; rotate it');
  // The floor is the oldest Chrome that can *run* the extension. scripting
  // .executeScript with `files` is old, but web_accessible_resources v3 objects
  // (matches + use_dynamic_url) need Chrome 102, and AbortSignal.timeout in the
  // worker's fetches needs 103 — so 103 remains the true floor. panel.css also
  // uses color-mix() (Chrome 111), which is not a dependency: below 111 the lead
  // badge simply loses its tint and keeps its green label.
  assert.equal(manifest.minimum_chrome_version, '103');
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(host, /<all_urls>|\*:\/\/\*\//, 'host_permissions must name the proxy only');
  }
});

// The shell is the entry point and nothing else covers it: a renamed file or a
// dropped type="module" would leave a permanently blank overlay with a green suite.
test('popup.html loads the packaged stylesheet and the module, with no close button', () => {
  const html = read('popup.html');
  assert.match(html, /<link rel="stylesheet" href="panel\.css"/);
  assert.match(html, /<script type="module" src="popup\.js"/);
  assert.match(html, /class="fx-panel"/, 'popup.js renders into .fx-panel');
  // No visible close button: the overlay is dismissed with Esc or a second click
  // on the toolbar icon (inject.js toggles it off), so the shell ships no fx-close.
  assert.doesNotMatch(html, /fx-close/, 'the X close button was removed');
  for (const file of ['panel.css', 'popup.js']) assert.ok(existsSync(path(file)));
});

// ---------------------------------------------------------------------------
// inject.js — the only code that touches a host page. It runs in the extension's
// isolated world on click, mounts the transparent iframe that renders popup.html,
// toggles off on a second click, and closes/resizes on messages from its own
// frame. It does no network; the network guard on popup.js/background.js covers
// that boundary, and this covers the mount/toggle/close/clamp behaviour.
// ---------------------------------------------------------------------------

// inject.js is an IIFE that closes over `window`, `document` and `chrome`. jsdom's
// own eval does not bind those in the eval scope, so run it as a Function with the
// jsdom window's globals passed in — the IIFE then reads/writes the real window.
const injectCode = read('inject.js');
const injectFn = new Function('window', 'document', 'chrome', injectCode);
const CHROME_STUB = { runtime: { getURL: (name) => `chrome-extension://test/${name}` } };
function inject(win) {
  injectFn(win, win.document, CHROME_STUB);
  return win.document.getElementById('fundable-overlay-host');
}

// The listener gates on `e.source === host.contentWindow`. jsdom does not give a
// framed extension URL a real contentWindow, so pin a sentinel as the frame's
// contentWindow and return a `fire` that can post as the frame (default) or as an
// impostor. getElementById hands back this same node, so the listener sees it too.
function framed(win, frame) {
  const contentWindow = {};
  Object.defineProperty(frame, 'contentWindow', { value: contentWindow, configurable: true });
  return (data, source = contentWindow) => {
    const e = new win.MessageEvent('message', { data });
    Object.defineProperty(e, 'source', { value: source });
    win.dispatchEvent(e);
  };
}

test('inject.js does no network of its own', () => {
  // Same rule as popup.js: this file runs on the host page, so a fetch here would
  // be the exact leak the whole architecture avoids. Whole-line comments stripped.
  const code = injectCode.replace(/^\s*\/\/.*$/gm, '');
  for (const [pattern, what] of FORBIDDEN) {
    assert.equal(pattern.test(code), false, `inject.js uses ${what}; it must only mount the frame`);
  }
});

test('the first click mounts a transparent iframe rendering popup.html', () => {
  const win = new JSDOM('<!doctype html><body>').window;
  const frame = inject(win);
  assert.ok(frame, 'the overlay host must be created');
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.src, 'chrome-extension://test/popup.html', 'it frames the extension page, cross-origin to the host');
  assert.match(frame.getAttribute('style'), /background:\s*transparent/);
  assert.match(frame.getAttribute('style'), /position:\s*fixed/);
});

test('a second click toggles the overlay off', () => {
  const win = new JSDOM('<!doctype html><body>').window;
  inject(win);
  assert.ok(win.document.getElementById('fundable-overlay-host'), 'first click mounts');
  inject(win); // second click, same isolated world
  assert.equal(win.document.getElementById('fundable-overlay-host'), null, 'second click removes it');
});

test('a fundable-close message from the frame removes the overlay', () => {
  const win = new JSDOM('<!doctype html><body>').window;
  const frame = inject(win);
  framed(win, frame)('fundable-close');
  assert.equal(win.document.getElementById('fundable-overlay-host'), null, 'close removes the frame');
});

test('a size message resizes the frame but is clamped against a page-cover attack', () => {
  const win = new JSDOM('<!doctype html><body>').window;
  const frame = inject(win);
  const fire = framed(win, frame);
  fire({ type: 'fundable-size', height: 480 });
  assert.equal(frame.style.height, '480px', 'a sane height is honoured');
  fire({ type: 'fundable-size', height: 999999 });
  assert.equal(frame.style.height, '820px', 'an absurd height is clamped, not allowed to cover the page');
});

test('a message not sourced from the frame cannot drive the overlay', () => {
  const win = new JSDOM('<!doctype html><body>').window;
  const frame = inject(win);
  framed(win, frame)('fundable-close', {}); // an impostor source, not the frame
  assert.ok(win.document.getElementById('fundable-overlay-host'), 'a forged source is ignored; the frame stays');
});

// The toolbar click is the overlay's only entry point. It injects inject.js into
// the active tab on a web page, and skips chrome://, the Web Store, blank tabs and
// anything without an http(s) URL, where executeScript would throw and there is no
// company to show anyway.
test('clicking the action injects only into a real web page', async () => {
  const injected = [];
  chrome.scripting.executeScript = async (opts) => (injected.push(opts), {});
  const click = (tab) => clickListener(tab);

  await click({ id: 7, url: 'https://wealthsimple.com/en-ca' });
  assert.deepEqual(injected, [{ target: { tabId: 7 }, files: ['inject.js'] }]);

  injected.length = 0;
  for (const tab of [
    { id: 7, url: 'chrome://newtab/' },
    { id: 7, url: 'about:blank' },
    { id: 7, url: 'file:///Users/x/notes.txt' },
    { id: 7 }, // restricted page: activeTab yields no url
    { id: undefined, url: 'https://x.com' }, // no tab id to target
  ]) {
    await click(tab);
  }
  assert.deepEqual(injected, [], 'no injection where there is no web page to inject into');
});

// ---------------------------------------------------------------------------
// Message-passing contract
// ---------------------------------------------------------------------------

const PROXY = 'https://fundable-extension-api.vercel.app';

const body = (status, json) => ({
  status,
  ok: status < 400,
  json: async () => {
    if (json === 'bad-json') throw new SyntaxError('unexpected token');
    return json;
  },
});

const bytes = (contentType, ...octets) => ({
  status: 200,
  ok: true,
  headers: { get: () => contentType },
  arrayBuffer: async () => new Uint8Array(octets).buffer,
});

// Also asserts the listener returns true, which is what keeps sendResponse
// alive across the await in MV3.
// The sender is this extension itself — the worker drops anything else, so the
// stub has to model a real one rather than pass null.
const ask = (message, sender = { id: chrome.runtime.id }) =>
  new Promise((resolve) => {
    assert.equal(listener(message, sender, resolve), true, 'listener must return true');
  });

// The worker is not a lookup service for whoever can reach it. Chrome already
// routes foreign senders to onMessageExternal, which this extension does not
// implement, so this pins the belt as well as the braces.
test('a message from anything but this extension is ignored outright', () => {
  let answered = false;
  const returned = listener(
    { type: 'init', url: 'https://stripe.com/' },
    { id: 'some-other-extension' },
    () => (answered = true),
  );
  assert.notEqual(returned, true, 'must not hold the channel open for a foreign sender');
  assert.equal(answered, false, 'must not answer a foreign sender');
});

// deepEqual on the whole answer, not just `identifier`: the popup loads its CSS
// through <link>, so the `css` this used to carry is dead weight that must not
// creep back. `route` still throws here, which pins that init costs no fetch.
test('init hands back the resolver verdict, and nothing else', async () => {
  assert.deepEqual(await ask({ type: 'init', url: 'https://www.linkedin.com/company/stripe' }), {
    identifier: { kind: 'linkedin', value: 'https://www.linkedin.com/company/stripe' },
  });
  assert.deepEqual(await ask({ type: 'init', url: 'https://mail.google.com/mail/u/0' }), {
    identifier: null,
  });
});

const CARD = {
  name: 'Wealthsimple',
  domain: 'wealthsimple.com',
  investors: [{ name: 'Greylock', domain: 'greylock.com', lead_investor: true }],
};

test('lookup returns the card with logos already inlined as data URLs', async () => {
  route = (url) => {
    if (url === `${PROXY}/api/company?domain=wealthsimple.com`) {
      return body(200, structuredClone(CARD));
    }
    if (url === `${PROXY}/api/logo?domain=wealthsimple.com`) return bytes('image/png', 1, 2);
    if (url === `${PROXY}/api/logo?domain=greylock.com`) return bytes('image/svg+xml', 3);
    throw new Error(`unexpected ${url}`);
  };
  const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'wealthsimple.com' } });
  assert.equal(res.found, true);
  assert.equal(res.card.name, 'Wealthsimple');
  assert.equal(res.card.logo, 'data:image/png;base64,AQI=');
  assert.equal(res.card.investors[0].logo, 'data:image/svg+xml;base64,Aw==');
});

test('a logo that fails to load leaves the card intact', async () => {
  route = (url) =>
    url.includes('/api/logo') ? body(404, null) : body(200, { name: 'Acme', domain: 'acme.com' });
  const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'acme.com' } });
  assert.equal(res.found, true);
  assert.equal(res.card.logo, null);
});

// `lookup` awaits the logos before it answers, so without a deadline one stalled
// connection leaves Promise.all pending, sendResponse uncalled, and the popup on
// "Loading…" until Chrome tears the worker down and the port dies under it.
test('a logo that never answers cannot hold the card hostage', async () => {
  const realTimeout = AbortSignal.timeout;
  const deadlines = [];
  // The worker's own AbortSignal.timeout call still drives the abort; it is only
  // shortened so this does not sit through the real four seconds. Hand back a
  // controller rather than realTimeout(20): the real one fires on an unref'd
  // timer, which lets the event loop drain out from under the pending fetch.
  AbortSignal.timeout = (ms) => {
    deadlines.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('TimeoutError')), 20);
    return controller.signal;
  };
  route = (url, options) =>
    url.includes('/api/logo')
      ? new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason)),
        )
      : body(200, { name: 'Acme', domain: 'acme.com' });
  try {
    const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'acme.com' } });
    assert.equal(res.found, true, 'a decorative logo must not gate the card');
    assert.equal(res.card.logo, null);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  assert.equal(deadlines.length, 2, 'the card fetch needs a deadline too, not just the logo');
  assert.ok(deadlines.every((ms) => ms > 0 && isFinite(ms)));
});

test('lookup accepts both a bare card and a {card} envelope', async () => {
  route = () => body(200, { found: true, card: { name: 'Acme' } });
  const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'acme.com' } });
  assert.deepEqual(res, { found: true, card: { name: 'Acme', logo: null } });
});

test('identifier values are escaped into the proxy query', async () => {
  let seen;
  route = (url) => ((seen = url), body(200, { found: false }));
  await ask({ type: 'lookup', identifier: { kind: 'linkedin', value: 'https://x.co/a b' } });
  assert.equal(seen, `${PROXY}/api/company?linkedin=https%3A%2F%2Fx.co%2Fa%20b`);
});

test('a miss is a miss, not an error', async () => {
  for (const miss of [{ found: false }, {}, { name: '' }]) {
    route = () => body(200, miss);
    const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'nope.com' } });
    assert.deepEqual(res, { found: false });
  }
});

// The listener has already returned true, so a handler that throws instead of
// answering is indistinguishable from a hang: the popup stays on "Loading…"
// until the port dies. A card shaped unlike the contract is a live possibility —
// investors as bare strings makes attachLogos throw on assignment under module
// strict mode.
test('a handler that throws still answers, rather than leaving the popup loading', async () => {
  route = (url) =>
    url.includes('/api/logo')
      ? bytes('image/png', 1)
      : body(200, { name: 'Acme', domain: 'acme.com', investors: ['Greylock'] });
  const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'acme.com' } });
  assert.deepEqual(res, { error: 'unavailable' });
});

// The proxy sends a JSON {error: code} body on every non-ok status, so the
// worker passes that code straight through — a 502 timeout and a 503 ceiling
// used to both read "unavailable", which is why a bug report from the popup
// couldn't be told apart. Only an unparseable or code-less body falls back.
test('failures pass the proxy error code through, falling back to unavailable', async () => {
  const cases = [
    [() => body(429, { error: 'rate_limited' }), 'rate_limited'],
    [() => body(502, { error: 'upstream_error' }), 'upstream_error'],
    [() => body(503, { error: 'temporarily_unavailable' }), 'temporarily_unavailable'],
    [() => body(403, { error: 'forbidden' }), 'forbidden'],
    [() => body(500, {}), 'unavailable'], // non-ok but no code -> fallback
    [() => body(500, null), 'unavailable'], // non-ok, no body -> fallback
    [() => body(200, 'bad-json'), 'unavailable'], // ok but unparseable -> fallback
    [
      () => {
        throw new TypeError('Failed to fetch');
      },
      'network',
    ],
  ];
  for (const [handler, error] of cases) {
    route = handler;
    const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'x.com' } });
    assert.deepEqual(res, { error });
  }
});

// The click that opens the overlay warms the card in the worker, so the popup's
// lookup — arriving from the overlay iframe with sender.tab set to the host tab —
// is served from that in-flight prefetch, not a second round-trip.
test('a click warms the card and the matching lookup reuses it', async () => {
  let companyFetches = 0;
  route = (url) => {
    if (url.includes('/api/company')) return companyFetches++, body(200, structuredClone(CARD));
    return bytes('image/png', 1); // logos
  };
  await clickListener({ id: 99, url: 'https://wealthsimple.com/en-ca' });
  await Promise.resolve(); // let the prefetch reach its fetch

  const res = await ask(
    { type: 'lookup', identifier: { kind: 'domain', value: 'wealthsimple.com' } },
    { id: chrome.runtime.id, tab: { id: 99 } },
  );
  assert.equal(res.found, true);
  assert.equal(companyFetches, 1, 'the lookup reused the prefetch instead of fetching the company again');
});

// A prefetch is a per-tab, per-company hint, not a blanket cache: a lookup for a
// different company (the tab navigated after the click) or from a tab that was
// never warmed must go fresh, never be handed the warmed card.
test('a prefetch is only served for the same tab and the same company', async () => {
  route = (url) =>
    url.includes('/api/company') ? body(200, structuredClone({ ...CARD, name: 'Fresh' })) : bytes('image/png', 1);
  await clickListener({ id: 100, url: 'https://wealthsimple.com/' });
  await Promise.resolve();

  // Same tab, different company -> fresh (not the warmed wealthsimple card).
  const other = await ask(
    { type: 'lookup', identifier: { kind: 'domain', value: 'stripe.com' } },
    { id: chrome.runtime.id, tab: { id: 100 } },
  );
  assert.equal(other.card.name, 'Fresh');

  // No sender.tab (as under test without a host frame) -> never matches a warm.
  route = () => body(200, structuredClone({ ...CARD, name: 'Untabbed' }));
  const untabbed = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'wealthsimple.com' } });
  assert.equal(untabbed.card.name, 'Untabbed');
});

// ---------------------------------------------------------------------------
// card -> DOM
// ---------------------------------------------------------------------------

function render(card) {
  const node = document.createElement('div');
  node.append(...popup.renderCard(card));
  return node;
}

const FULL = {
  name: 'Wealthsimple',
  domain: 'wealthsimple.com',
  website: 'https://wealthsimple.com',
  region: 'Toronto, Canada',
  ipo_status: 'private',
  guru_permalink: 'wealthsimple',
  logo: 'data:image/png;base64,AQI=',
  links: {
    website: 'https://wealthsimple.com',
    linkedin: 'https://linkedin.com/company/wealthsimple',
    twitter: null,
    facebook: null,
    crunchbase: 'https://crunchbase.com/organization/wealthsimple',
    pitchbook: null,
  },
  stats: {
    total_raised: 900_000_000,
    num_funding_rounds: 9,
    num_investors: 21,
    num_employees: '501-1000', // a bucket string, which is what the API really sends
    latest_valuation_usd: 4_000_000_000,
    latest_valuation_date: '2021-05-03',
  },
  latest_deal: {
    type: 'series_d',
    pre: false,
    extension: false,
    date: '2021-05-03',
    total_round_raised: 610_000_000,
    financings: [{ size_native: 750_000_000, currency: 'CAD' }],
    article_url: 'https://example.com/story',
  },
  investors: [
    { name: 'Greylock', domain: 'greylock.com', lead_investor: true, logo: 'data:image/png;base64,Aw==' },
    { name: 'Meritech', domain: null, lead_investor: false },
  ],
};

test('a full card renders every section', () => {
  const node = render(FULL);
  for (const cls of ['fx-header', 'fx-metapills', 'fx-links', 'fx-tiles', 'fx-round', 'fx-investors']) {
    assert.ok(node.querySelector(`.${cls}`), `missing .${cls}`);
  }
  assert.equal(node.querySelector('.fx-name').textContent, 'Wealthsimple');
  // Location · status ride in meta pills; headcount is the third (tested on its own below).
  const pills = [...node.querySelectorAll('.fx-pill-text')].map((p) => p.textContent);
  assert.deepEqual(pills, ['Toronto, Canada', 'Private', '501–1K']);
  assert.equal(node.querySelector('.fx-logo').getAttribute('src'), FULL.logo);
  // The header carries no brand mark — the Fundable link lives in the row of
  // link icons, so a second Fundable mark in the header would just duplicate it.
  assert.equal(node.querySelector('.fx-brand'), null, 'no duplicate Fundable mark in the header');
  const fundable = [...node.querySelectorAll('.fx-ico')].find((a) => a.getAttribute('aria-label') === 'Fundable');
  assert.equal(fundable.href, 'https://www.tryfundable.ai/company/wealthsimple');
});

// FULL has linkedin, crunchbase, website and a guru_permalink but null
// twitter/facebook/pitchbook, so the row renders exactly those four, in LINKS
// order (linkedin, crunchbase, website, fundable). Links are icon anchors now,
// identified by their aria-label.
test('only non-null links render, as labelled icon anchors', () => {
  const labels = [...render(FULL).querySelectorAll('.fx-ico')].map((a) => a.getAttribute('aria-label'));
  assert.deepEqual(labels, ['LinkedIn', 'Crunchbase', 'Website', 'Fundable']);
});

test('links open in a new tab without leaking the referrer window', () => {
  for (const a of render(FULL).querySelectorAll('a')) {
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer');
  }
});

test('tiles render only the stats that have values', () => {
  const labels = [...render(FULL).querySelectorAll('.fx-tile-label')].map((t) => t.textContent);
  assert.deepEqual(labels, [
    'Total raised',
    'Latest round',
    'Valuation · May 2021',
    'Funding rounds',
    'Investors',
  ]);
  const values = [...render(FULL).querySelectorAll('.fx-tile-value')].map((t) => t.textContent);
  assert.deepEqual(values, ['$900M', '$610M', '$4B', '9', '21']);
});

// Every real company returns num_employees as a bucket string. Headcount is a
// meta pill now — abbreviated the way Fundable's own card shows it ("501–1K"),
// not a stat tile. A numeric-only count() dropped it silently in production while
// the fixture's plain number kept the suite green, so both shapes are pinned here.
test('a headcount bucket renders in the meta pill, abbreviated', () => {
  // The headcount pill is the one carrying digits — region and status never do.
  const headcount = (employees) => {
    const card = { ...FULL, stats: { ...FULL.stats, num_employees: employees } };
    const pills = [...render(card).querySelectorAll('.fx-pill-text')].map((p) => p.textContent);
    return pills.find((t) => /\d/.test(t));
  };
  assert.equal(headcount('5001-10000'), '5K–10K');
  assert.equal(headcount(1200), '1.2K');
  assert.equal(headcount('   '), undefined, 'a blank bucket drops the pill');
  assert.equal(headcount(null), undefined, 'a missing headcount drops the pill');
});

test('the round block names the type, amount, date and source', () => {
  const node = render(FULL);
  assert.equal(node.querySelector('.fx-round-head').textContent, 'Series D');
  assert.equal(node.querySelector('.fx-round-amount').textContent, '$610M · CA$750M');
  assert.equal(node.querySelector('.fx-round-date').textContent, 'May 2021');
  assert.equal(node.querySelector('.fx-round-source').href, 'https://example.com/story');
});

test('pre and extension rounds are named as such', () => {
  const deal = { ...FULL.latest_deal, type: 'series_a', pre: true, extension: true };
  assert.equal(render({ latest_deal: deal }).querySelector('.fx-round-head').textContent, 'Pre-Series A extension');
});

// Both cases of the code, because the API normalises neither and Intl accepts
// either: pinning only 'USD' left a lowercase 'usd' through the de-dupe, and
// Intl then canonicalised it into a second identical "$610M · $610M".
test('a round raised in USD does not repeat itself in native currency', () => {
  for (const currency of ['USD', 'usd']) {
    const deal = { ...FULL.latest_deal, financings: [{ size_native: 610_000_000, currency }] };
    assert.equal(render({ latest_deal: deal }).querySelector('.fx-round-amount').textContent, '$610M');
  }
  const cad = { ...FULL.latest_deal, financings: [{ size_native: 750_000_000, currency: 'cad' }] };
  assert.equal(
    render({ latest_deal: cad }).querySelector('.fx-round-amount').textContent,
    '$610M · CA$750M',
    'a lowercase non-USD code is still a real second currency',
  );
});

test('investors carry a lead badge only when they led', () => {
  const rows = [...render(FULL).querySelectorAll('.fx-investor')];
  assert.deepEqual(rows.map((r) => r.querySelector('.fx-investor-name').textContent), ['Greylock', 'Meritech']);
  assert.equal(rows[0].querySelector('.fx-lead-badge').textContent, 'Lead');
  assert.equal(rows[1].querySelector('.fx-lead-badge'), null);
  assert.equal(rows[0].querySelector('.fx-investor-logo').getAttribute('src'), FULL.investors[0].logo);
  assert.equal(rows[1].querySelector('.fx-investor-logo'), null, 'no logo, no <img>');
});

// The section carries an overline like every other block, in both states: a
// named list, and the count-but-no-names note. The note case is the one that
// vanished as a bug before, so it is pinned to still render — now with a header.
test('the investors section is headed in both the list and the note state', () => {
  assert.equal(render(FULL).querySelector('.fx-investors-head').textContent, 'Investors');

  const unnamed = { ...FULL, investors: [], stats: { ...FULL.stats, num_investors: 26 } };
  const section = render(unnamed).querySelector('.fx-investors');
  assert.equal(section.querySelector('.fx-investors-head').textContent, 'Investors');
  assert.match(section.querySelector('.fx-note').textContent, /doesn't name/);
  assert.equal(section.querySelector('.fx-investor'), null, 'no rows when there are no names');
});

// A long list scrolls inside a height-capped region rather than growing the card,
// so the overlay is one fixed size and expanding it never pulls the host page.
// Every investor renders up front; the cap and overflow live in panel.css. FULL
// has only two investors, so this needs its own card. The old "Show more" button
// is gone — it grew the card, which is the exact behaviour being removed here.
test('a long investor list renders every row in a scroll region, not a Show more button', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `Fund ${i + 1}` }));
  const section = render({ ...FULL, investors: many }).querySelector('.fx-investors');
  const scroll = section.querySelector('.fx-investor-list');
  assert.ok(scroll, 'rows live in a .fx-investor-list scroll region');
  assert.equal(scroll.querySelectorAll('.fx-investor').length, 7, 'every investor renders up front');
  assert.equal(section.querySelector('.fx-more'), null, 'no Show more button — the region scrolls instead');
});

// The scroll region is only half the fix — the JS builds the container, the CSS
// caps it. jsdom can't measure layout, so pin the cap on the rule text: without
// max-height + overflow-y the card grows with the list again and the render test
// above still passes, so this is the guard that actually holds Change 1 in place.
test('the investor list rule caps its height and scrolls, so the card cannot grow', () => {
  const block = rules(read('panel.css')).match(/\.fx-investor-list\s*\{([^}]*)\}/)?.[1];
  assert.ok(block, '.fx-investor-list rule is missing — the list would grow the card');
  assert.match(block, /max-height:\s*\d+px/, 'needs a height cap');
  assert.match(block, /overflow-y:\s*auto/, 'needs to scroll rather than clip or grow');
});

// The list is capped to a scroll region, so only the first few show without
// scrolling — the lead has to be one of them. This fixture puts the lead second
// in API order, so it fails if investors() renders in API order (as it did before).
test('a lead investor is pulled to the front, above an earlier non-lead', () => {
  const card = {
    name: 'X',
    investors: [{ name: 'Follower' }, { name: 'The Lead', lead_investor: true }],
  };
  const names = [...render(card).querySelectorAll('.fx-investor-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['The Lead', 'Follower'], 'the lead sorts ahead of an earlier non-lead');
});

test('every section disappears when its data is missing', () => {
  const node = render({ name: 'Ghost' });
  assert.equal(node.querySelector('.fx-name').textContent, 'Ghost');
  for (const cls of ['fx-logo', 'fx-metapills', 'fx-links', 'fx-tiles', 'fx-round', 'fx-investors']) {
    assert.equal(node.querySelector(`.${cls}`), null, `.${cls} should not render`);
  }
});

test('an all-null card renders nothing rather than empty boxes', () => {
  const nulled = {
    name: 'Blank Co',
    domain: null,
    website: null,
    region: null,
    ipo_status: null,
    guru_permalink: null,
    links: { website: null, linkedin: null, twitter: null, facebook: null, crunchbase: null, pitchbook: null },
    stats: {
      total_raised: null,
      num_funding_rounds: null,
      num_investors: null,
      num_employees: null,
      latest_valuation_usd: null,
      latest_valuation_date: null,
    },
    latest_deal: {
      type: null,
      pre: false,
      extension: false,
      date: null,
      total_round_raised: null,
      financings: [{ size_native: null, currency: null }],
      article_url: null,
    },
    investors: [],
  };
  const node = render(nulled);
  assert.deepEqual([...node.children].map((c) => c.className), ['fx-header']);
  assert.doesNotMatch(node.textContent, /null|undefined|NaN|Invalid/i);
});

// Date-only strings parse as UTC midnight. Formatted in the reader's own zone,
// anything on a month boundary lands in the previous month west of UTC.
test('a month-boundary date is not shifted into the previous month', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const node = render({
      name: 'Edge Co',
      stats: { latest_valuation_usd: 1e9, latest_valuation_date: '2021-01-01' },
      latest_deal: { type: 'seed', date: '2021-01-01' },
    });
    assert.equal(node.querySelector('.fx-tile-label').textContent, 'Valuation · Jan 2021');
    assert.equal(node.querySelector('.fx-round-date').textContent, 'Jan 2021');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

// The card comes from the proxy; its text is set with textContent, but an href
// goes straight into the popup's DOM as something the reader can click.
test('a non-http href is dropped rather than made clickable', () => {
  const node = render({
    name: 'Evil Co',
    links: {
      website: 'javascript:alert(1)',
      linkedin: 'data:text/html;base64,PHNjcmlwdD4=',
      twitter: 'https://twitter.com/evilco',
    },
    latest_deal: { type: 'seed', article_url: 'javascript:alert(1)' },
  });
  assert.deepEqual(
    [...node.querySelectorAll('.fx-ico')].map((a) => a.getAttribute('aria-label')),
    ['X'],
  );
  assert.equal(node.querySelector('.fx-round-source'), null, 'a hostile source link hides itself');
  assert.doesNotMatch(node.innerHTML, /javascript:|data:text/i);
});

test('unparseable dates and currencies are dropped, not rendered raw', () => {
  const node = render({
    name: 'Odd Co',
    stats: { latest_valuation_usd: 1e9, latest_valuation_date: 'not a date' },
    latest_deal: { type: 'seed', financings: [{ size_native: 5e6, currency: 'US$' }], date: 'nope' },
  });
  assert.equal(node.querySelector('.fx-tile-label').textContent, 'Valuation');
  assert.equal(node.querySelector('.fx-round-date'), null);
  assert.equal(node.querySelector('.fx-round-amount'), null);
});

test('card text is set as text, so a hostile name cannot inject markup', () => {
  const node = render({ name: '<img src=x onerror=alert(1)>' });
  // A hostile name must never become a node under .fx-name — it stays text.
  assert.equal(node.querySelector('.fx-name img'), null);
  assert.equal(node.querySelector('.fx-name').textContent, '<img src=x onerror=alert(1)>');
});

// ---------------------------------------------------------------------------
// Opening the popup. A popup is a fresh document every time, so there is no SPA
// navigation to follow and no stale-response race to guard — the two tests that
// chased the pill across LinkedIn's router are gone with the pill. What is left
// is one flow, active tab -> init -> lookup -> render, and its four endings.
//
// sendMessage is wired straight into the worker's real listener, so these run
// the actual protocol rather than a second description of it.
// ---------------------------------------------------------------------------

const MISS = "Sorry, this company isn't available yet — we'll work on adding it.";
// Shown when the URL is not a company page at all (non-http, or the resolver
// returns null for a random/deny-listed site). Distinct from MISS, which promises
// coverage and so may only follow a page that actually resolved to a company.
const NO_PAGE = "Sorry, we couldn't find a company on this page.";

function openPopup({ url = 'https://www.linkedin.com/company/stripe', reachable = true } = {}) {
  let sent = 0;
  chrome.tabs = { query: async () => [{ url }] };
  chrome.runtime.sendMessage = (message) => {
    sent++;
    return reachable ? ask(message) : Promise.reject(new Error('Extension context invalidated'));
  };
  // Pre-filled exactly as popup.html ships it — the loading state carries the
  // shared Möbius mark, so "replaced the loading state" is a real assertion and
  // the miss/error states have a mark to clone.
  const panel = document.createElement('div');
  const loading = document.createElement('div');
  loading.className = 'fx-loading';
  loading.innerHTML = '<svg class="fx-mark"></svg>';
  panel.append(loading);
  return { panel, done: popup.open(panel), sends: () => sent };
}

test('the active tab resolves to a card, which replaces the loading state', async () => {
  route = (url) =>
    url.includes('/api/logo')
      ? bytes('image/png', 1)
      : body(200, structuredClone({ ...CARD, guru_permalink: 'wealthsimple' }));
  const { panel, done, sends } = openPopup({ url: 'https://wealthsimple.com/en-ca' });
  await done;
  assert.equal(panel.querySelector('.fx-loading'), null, 'the loading state has to be replaced');
  assert.equal(panel.querySelector('.fx-name').textContent, 'Wealthsimple');
  assert.equal(sends(), 2, 'one init, one lookup, and that is the whole popup');
});

// A deny-listed page resolves to no identifier, so it is NO_PAGE, not MISS: it
// must not be told Fundable is "working on adding" it — there is no company here,
// and the promise belongs only to a page that resolved and came back not-found.
test('a tab the resolver denies is no-company, and never reaches the network', async () => {
  route = () => {
    throw new Error('a deny-listed page must not be looked up');
  };
  const { panel, done, sends } = openPopup({ url: 'https://mail.google.com/mail/u/0' });
  await done;
  assert.equal(panel.querySelector('.fx-miss').textContent, NO_PAGE);
  assert.equal(sends(), 1, 'no identifier, no lookup');
});

test('a company Fundable has never heard of is a miss, not an error', async () => {
  route = () => body(200, { found: false });
  const { panel, done } = openPopup();
  await done;
  assert.equal(panel.querySelector('.fx-miss').textContent, MISS);
  assert.ok(panel.querySelector('.fx-miss .fx-mark'), 'the miss state clones in the Fundable mark');
});

test('an error code becomes its own quiet line of copy', async () => {
  route = () => body(429, { error: 'rate_limited' });
  const { panel, done } = openPopup();
  await done;
  assert.equal(panel.querySelector('.fx-error').textContent, 'Too many lookups right now. Try again in a moment.');
});

// An extension reload invalidates the context mid-flight and sendMessage rejects.
// Unhandled, that leaves the popup on "Loading…" forever with nothing in the UI
// to say why.
test('a worker that cannot be reached says so instead of loading forever', async () => {
  const { panel, done } = openPopup({ reachable: false });
  await done;
  assert.equal(panel.querySelector('.fx-error').textContent, 'Could not reach Fundable.');
});

// The action is clickable on every tab now, not just the https pages the old
// content script matched. None of these is a company Fundable is "working on
// adding" — there is no page to have an opinion about, and on most of them
// activeTab grants no URL at all, so tab.url is undefined.
test('a page that cannot hold a company says so, rather than claiming coverage', async () => {
  route = () => {
    throw new Error('a non-web page must not be looked up');
  };
  // '' stands in for the tab Chrome hands back with no `url` at all, which is
  // what activeTab yields on a restricted page. It cannot be written as
  // `undefined` here: openPopup's default parameter would swallow it.
  for (const url of ['chrome://newtab/', 'about:blank', 'file:///Users/x/notes.txt', '']) {
    const { panel, done, sends } = openPopup({ url });
    await done;
    assert.equal(panel.querySelector('.fx-miss').textContent, NO_PAGE);
    assert.equal(sends(), 0, `${url}: nothing to resolve, so nothing is asked`);
  }
});

// background.js answers a throw from either handler with {error: 'unavailable'},
// init included. That object has no `identifier`, so an unchecked init error
// reads as the miss copy — telling the reader Fundable is adding a company whose
// coverage was never checked, which is the one thing the network guard beside it
// exists to prevent.
test('a worker that fails during init reports the failure, not a miss', async () => {
  chrome.tabs = { query: async () => [{ url: 'https://wealthsimple.com' }] };
  chrome.runtime.sendMessage = async () => ({ error: 'unavailable' });
  const panel = document.createElement('div');
  await popup.open(panel);
  assert.equal(panel.querySelector('.fx-error').textContent, 'Fundable is unavailable right now.');
});

// The timeout code the worker now passes through must reach copy that invites a
// retry — the failure is a cold-cache coin flip, so the next click often works.
// An unmapped code (forbidden) still falls back to the generic sentence.
test('the passed-through error code selects the copy the user sees', async () => {
  chrome.tabs = { query: async () => [{ url: 'https://wealthsimple.com' }] };
  const render = async (error) => {
    chrome.runtime.sendMessage = async (msg) =>
      msg.type === 'init' ? { identifier: { kind: 'domain', value: 'x.com' } } : { error };
    const panel = document.createElement('div');
    await popup.open(panel);
    return panel.querySelector('.fx-error').textContent;
  };
  assert.equal(await render('upstream_error'), 'Fundable took too long to respond. Try again.');
  assert.equal(await render('temporarily_unavailable'), 'Fundable is at capacity right now. Try again shortly.');
  assert.equal(await render('forbidden'), 'Fundable is unavailable right now.');
});
