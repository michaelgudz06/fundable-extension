import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const path = (p) => new URL(`../extension/${p}`, import.meta.url);
const read = (p) => readFileSync(path(p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

// Every reference a stylesheet makes: url() targets first, then any quoted
// http(s) string, which is how image-set() and friends carry a URL with no
// url() token at all. A stylesheet is a declarative artifact this repo owns,
// and the schemes of its references are the contract: anything but data: is a
// request the host page issues on our behalf. This deliberately mirrors
// sanitizeCss() in background.js — they had the same blind spot because they
// had the same regex.
function urlTargets(css) {
  const quoted = [...css.matchAll(/(['"])\s*(https?:[^'"]*)\1/gi)].map((m) => m[2].trim());
  return [...css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)]
    .map((m) => m[2].trim())
    .concat(quoted);
}

// ---------------------------------------------------------------------------
// The one hard requirement: content.js never talks to the network.
//
// A request issued from a content script shows up in the inspected page's
// DevTools Network tab and gives the whole thing away. If this test fails, the
// fix is to move the call into background.js — never to loosen the test.
// ---------------------------------------------------------------------------

// Only whole-line comments are stripped, so a violation can't hide behind one.
const contentCode = read('content.js').replace(/^\s*\/\/.*$/gm, '');

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
  [/url\(\s*[`'"]?\s*https?:/i, 'a remote CSS url() — fonts and images must arrive as bytes'],
];

test('content.js makes no page-visible network calls', () => {
  for (const [pattern, what] of FORBIDDEN) {
    assert.equal(
      pattern.test(contentCode),
      false,
      `content.js uses ${what}; every network call belongs in background.js`,
    );
  }
});

// panel.css belongs to another crewmate and is not in this worktree yet. When it
// lands, its url() references have to obey the same rule content.js does.
test('panel.css references nothing the page would have to fetch', { skip: !existsSync(path('panel.css')) }, () => {
  for (const target of urlTargets(read('panel.css'))) {
    assert.match(target, /^data:/i, `panel.css points at ${target}; the page would fetch it`);
  }
});

test('manifest keeps network permission scoped and the extension ID pinned', () => {
  assert.ok(manifest.key, 'manifest needs a pinned key for a stable extension ID');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
  // The floor is the highest API the code uses: AbortSignal.timeout in the
  // worker's fetches (Chrome 103), above the Navigation API's 102.
  assert.equal(manifest.minimum_chrome_version, '103');
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(host, /<all_urls>|\*:\/\/\*\//, 'host_permissions must name the proxy only');
  }
});

// ---------------------------------------------------------------------------
// Message-passing contract
// ---------------------------------------------------------------------------

const PROXY = 'https://fundable-extension-api.vercel.app';
let route = () => {
  throw new Error('no route set');
};

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

let listener;
globalThis.chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener: (fn) => (listener = fn) },
  },
};
globalThis.fetch = async (url, options) => route(url, options);

await import('../extension/background.js');

// Also asserts the listener returns true, which is what keeps sendResponse
// alive across the await in MV3.
const ask = (message) =>
  new Promise((resolve) => {
    assert.equal(listener(message, null, resolve), true, 'listener must return true');
  });

// The stylesheet is injected into the panel's shadow root, which is still page
// CSS: whatever it references, the page fetches, in full view of its Network
// tab. Only a data: URI loads nothing. panel.css is another crewmate's file, so
// the worker strips the rest on the way through — the memoised css promise means
// this is the one place the round trip actually happens.
test('init hands back the resolver verdict and a stylesheet the page cannot fetch from', async () => {
  route = (url) => {
    assert.equal(url, 'chrome-extension://test/panel.css');
    return {
      text: async () =>
        '@import "https://cdn.example.com/reset.css";\n' +
        '.fx-panel{background:url("https://cdn.example.com/bg.png")}\n' +
        '.fx-logo{mask:url(/local/icon.svg)}\n' +
        '.fx-chip{background-image:-webkit-image-set("https://cdn.example.com/chip.png" 1x)}\n' +
        // Both of these hide the remote source behind an earlier argument that
        // closes a paren of its own, which is why the strip cannot be scoped to
        // the image-set() construct.
        '.fx-tile{background-image:image-set(url("data:image/png;base64,AAA") 1x, "https://cdn.example.com/x@2x.png" 2x)}\n' +
        '.fx-round{background-image:image-set(linear-gradient(red, blue) 1x, "https://cdn.example.com/y@2x.png" 2x)}\n' +
        '.fx-pill{background:url("data:image/gif;base64,R0lGOD")}\n' +
        // Unquoted and outside url(): nothing here understands it, which is the
        // whole reason the survivor warning exists.
        ':root{--fx-icons:https://survivor.example.com/sprite.svg}\n',
    };
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  let res;
  try {
    res = await ask({ type: 'init', url: 'https://www.linkedin.com/company/stripe' });
  } finally {
    console.warn = realWarn;
  }

  assert.ok('identifier' in res, 'init must report the resolver verdict');
  assert.deepEqual(urlTargets(res.css), ['data:image/png;base64,AAA', 'data:image/gif;base64,R0lGOD']);
  assert.doesNotMatch(res.css, /@import/, 'a bare @import fetches too');
  assert.doesNotMatch(res.css, /cdn\.example\.com/, 'image-set carries a bare string, not a url()');
  assert.match(res.css, /\.fx-pill\{background:/, 'only the references are stripped, not the rules');

  assert.match(warnings.join('\n'), /https:\/\/cdn\.example\.com\/bg\.png/, 'a silent strip is a mystery');
  // The survivor warning is the durable half: the next construct nobody
  // anticipated stays diagnosable instead of leaking quietly.
  assert.match(warnings.join('\n'), /survivor\.example\.com/);
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
// connection leaves Promise.all pending, sendResponse uncalled, and the panel on
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

test('fonts come back as bytes, and a stale filename drops just that weight', async () => {
  const FONT_400 = 'https://www.tryfundable.ai/_next/static/media/8f65835aa057b6ed-s.p.otf';
  let calls = 0;
  route = (url) => {
    calls++;
    return url === FONT_400 ? bytes('font/otf', 79, 84, 84, 79) : body(404, null);
  };
  assert.deepEqual(await ask({ type: 'fonts' }), [{ weight: 400, base64: 'T1RUTw==' }]);

  // Memoised: the worker fetches each face once per lifetime, not once per page.
  const before = calls;
  await ask({ type: 'fonts' });
  assert.equal(calls, before);
});

test('failures map to the three quiet error codes', async () => {
  const cases = [
    [() => body(429, null), 'rate_limited'],
    [() => body(500, null), 'unavailable'],
    [() => body(402, null), 'unavailable'],
    [() => body(200, 'bad-json'), 'unavailable'],
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

// ---------------------------------------------------------------------------
// card -> DOM
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html>');
globalThis.document = dom.window.document;

// content.js is a classic content script, so it has no exports to import. Run
// it as a function body and take the renderers off the end.
const panel = new Function(`${read('content.js')}\nreturn { renderCard, registerFonts, start };`)();

function render(card) {
  const node = document.createElement('div');
  node.append(...panel.renderCard(card));
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
    num_employees: 1200,
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
  for (const cls of ['fx-header', 'fx-chips', 'fx-tiles', 'fx-round', 'fx-investors', 'fx-footer']) {
    assert.ok(node.querySelector(`.${cls}`), `missing .${cls}`);
  }
  assert.equal(node.querySelector('.fx-name').textContent, 'Wealthsimple');
  assert.equal(node.querySelector('.fx-meta').textContent, 'Toronto, Canada · Private');
  assert.equal(node.querySelector('.fx-logo').getAttribute('src'), FULL.logo);
  assert.equal(node.querySelector('.fx-footer').href, 'https://www.tryfundable.ai/company/wealthsimple');
});

test('only non-null link chips render', () => {
  const labels = [...render(FULL).querySelectorAll('.fx-chip')].map((c) => c.textContent);
  assert.deepEqual(labels, ['Website', 'LinkedIn', 'Crunchbase']);
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
    'Employees',
  ]);
  const values = [...render(FULL).querySelectorAll('.fx-tile-value')].map((t) => t.textContent);
  assert.deepEqual(values, ['$900M', '$610M', '$4B', '9', '21', '1,200']);
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

test('a round raised in USD does not repeat itself in native currency', () => {
  const deal = { ...FULL.latest_deal, financings: [{ size_native: 610_000_000, currency: 'USD' }] };
  assert.equal(render({ latest_deal: deal }).querySelector('.fx-round-amount').textContent, '$610M');
});

test('investors carry a lead badge only when they led', () => {
  const rows = [...render(FULL).querySelectorAll('.fx-investor')];
  assert.deepEqual(rows.map((r) => r.querySelector('.fx-investor-name').textContent), ['Greylock', 'Meritech']);
  assert.equal(rows[0].querySelector('.fx-lead-badge').textContent, 'Lead');
  assert.equal(rows[1].querySelector('.fx-lead-badge'), null);
  assert.equal(rows[0].querySelector('.fx-investor-logo').getAttribute('src'), FULL.investors[0].logo);
  assert.equal(rows[1].querySelector('.fx-investor-logo'), null, 'no logo, no <img>');
});

test('every section disappears when its data is missing', () => {
  const node = render({ name: 'Ghost' });
  assert.equal(node.querySelector('.fx-name').textContent, 'Ghost');
  for (const cls of ['fx-logo', 'fx-meta', 'fx-chips', 'fx-tiles', 'fx-round', 'fx-investors', 'fx-footer']) {
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
// goes straight into the host page's DOM as something the reader can click.
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
  assert.deepEqual([...node.querySelectorAll('.fx-chip')].map((c) => c.textContent), ['Twitter']);
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

// ---------------------------------------------------------------------------
// PP Mori. An @font-face inside a shadow root is ignored by Chrome, so the face
// has to be registered on the document — but registering one that points at a
// URL would make the page fetch the file, in full view of its Network tab. So
// the worker sends bytes and the face is built from those.
// ---------------------------------------------------------------------------

const added = [];
const built = [];

function stubFontEnv(FontFaceImpl, reply) {
  added.length = built.length = 0;
  globalThis.FontFace = FontFaceImpl;
  Object.defineProperty(document, 'fonts', {
    value: { add: (font) => added.push(font) },
    configurable: true,
  });
  chrome.runtime.sendMessage = async (message) => {
    assert.deepEqual(message, { type: 'fonts' });
    return reply;
  };
}

class RecordingFontFace {
  constructor(family, source, descriptors) {
    built.push({ family, source, descriptors });
  }
  async load() {
    return this;
  }
}

test('PP Mori is registered on the document from bytes, never from a URL', async () => {
  stubFontEnv(RecordingFontFace, [
    { weight: 400, base64: btoa('regular-otf') },
    { weight: 600, base64: btoa('semibold-otf') },
  ]);

  await panel.registerFonts();

  assert.equal(added.length, 2);
  assert.deepEqual(built.map((f) => f.family), ['PP Mori', 'PP Mori']);
  assert.deepEqual(built.map((f) => f.descriptors.weight), ['400', '600']);
  for (const font of built) {
    assert.ok(
      ArrayBuffer.isView(font.source),
      'the face must be built from binary data — a string source would fetch a URL',
    );
  }
  assert.equal(new TextDecoder().decode(built[0].source), 'regular-otf');
});

test('a font that will not load leaves the Helvetica fallback in place', async () => {
  const cases = [
    [
      class {
        constructor() {
          throw new TypeError('unparseable font data');
        }
      },
      [{ weight: 400, base64: btoa('junk') }],
    ],
    [RecordingFontFace, []], // every filename rotated out from under us
    [RecordingFontFace, null], // worker unreachable
    [RecordingFontFace, { error: 'unavailable' }], // worker answered with junk
  ];
  for (const [impl, reply] of cases) {
    stubFontEnv(impl, reply);
    await panel.registerFonts(); // must resolve, never reject
    assert.equal(added.length, 0);
  }
});

test('card text is set as text, so a hostile name cannot inject markup', () => {
  const node = render({ name: '<img src=x onerror=alert(1)>' });
  assert.equal(node.querySelector('img'), null);
  assert.equal(node.querySelector('.fx-name').textContent, '<img src=x onerror=alert(1)>');
});

// ---------------------------------------------------------------------------
// SPA navigation. LinkedIn and Crunchbase route without reloading the document,
// so the content script runs once — on /feed, where no pill belongs — and the
// company page you click through to would never get one.
// ---------------------------------------------------------------------------

test('the pill follows same-document navigation without ever doubling up', async () => {
  const listeners = {};
  globalThis.navigation = {
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)),
  };
  globalThis.location = { href: 'https://www.linkedin.com/feed/' };

  const COMPANY = /\/company\//;
  let fontRequests = 0;
  chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'fonts') return fontRequests++, null;
    assert.equal(message.type, 'init');
    return { identifier: COMPANY.test(message.url) ? { kind: 'linkedin', value: message.url } : null, css: '' };
  };

  const hosts = () => document.querySelectorAll('#fundable-extension-root');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // The real platform ordering, which is the whole point of this stub:
  // `navigate` is the interception point and fires while location.href still
  // holds the page being LEFT — only `destination.url` names the target — and
  // `navigatesuccess` fires after the URL commits. A handler that reads
  // location.href from `navigate` resolves the wrong page in both directions.
  const go = async (url) => {
    for (const fn of listeners.navigate ?? []) fn({ destination: { url } });
    location.href = url;
    for (const fn of listeners.navigatesuccess ?? []) fn({});
    await settle();
  };

  try {
    panel.start();
    await settle();
    assert.equal(hosts().length, 0, 'no pill where the resolver says null');
    assert.equal(
      Object.values(listeners).flat().length,
      1,
      'exactly one navigation subscription — two would re-resolve every route twice',
    );

    await go('https://www.linkedin.com/company/stripe');
    assert.equal(hosts().length, 1, 'routing to a company page must mount the pill');

    await go('https://www.linkedin.com/company/ramp');
    assert.equal(hosts().length, 1, 'routing on must not leave the previous host behind');

    assert.equal(fontRequests, 1, 'the faces belong to the document, not to each mount');

    await go('https://www.linkedin.com/feed/');
    assert.equal(hosts().length, 0, 'routing away must unmount the pill, not just hide it');
  } finally {
    delete globalThis.navigation;
    delete globalThis.location;
  }
});

// navigatesuccess fires for every same-document navigation, including the ones
// that go nowhere: a replaceState adding a tracking param, scroll restoration, a
// hash change. Rebuilding on those destroys the card the reader is mid-way
// through — the goal was never to show a stale card for a NEW company.
test('a navigation that does not change the URL leaves the open card alone', async () => {
  const listeners = {};
  globalThis.navigation = {
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)),
  };
  globalThis.location = { href: 'https://www.linkedin.com/company/stripe' };

  let inits = 0;
  chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'init') {
      inits++;
      return { identifier: { kind: 'linkedin', value: message.url }, css: '' };
    }
    if (message.type === 'lookup') return { found: true, card: { name: 'Stripe' } };
    return null;
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const arrive = async () => {
    for (const fn of listeners.navigatesuccess ?? []) fn({});
    await settle();
  };

  try {
    panel.start();
    await settle();
    const host = document.querySelector('#fundable-extension-root');
    assert.ok(host, 'the pill mounts on a company page');

    host.shadowRoot.querySelector('.fx-pill').click();
    await settle();
    const card = host.shadowRoot.querySelector('.fx-panel');
    assert.equal(card.style.display, '', 'the reader has the panel open');
    assert.equal(card.querySelector('.fx-name').textContent, 'Stripe');

    const settled = inits;
    await arrive();
    await arrive();
    assert.equal(document.querySelector('#fundable-extension-root'), host, 'the host must not be rebuilt');
    assert.equal(card.style.display, '', 'the card the reader is looking at must survive');
    assert.equal(card.querySelector('.fx-name').textContent, 'Stripe');
    assert.equal(inits, settled, 'an unchanged URL is not a new company; do not re-resolve it');

    location.href = 'https://www.linkedin.com/company/ramp';
    await arrive();
    assert.equal(inits, settled + 1, 'a real URL change still re-resolves');
    const next = document.querySelector('#fundable-extension-root');
    assert.notEqual(next, host, 'a real URL change rebuilds the pill');
    assert.equal(document.querySelectorAll('#fundable-extension-root').length, 1);
  } finally {
    delete globalThis.navigation;
    delete globalThis.location;
    for (const node of document.querySelectorAll('#fundable-extension-root')) node.remove();
  }
});
