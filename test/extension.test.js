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
globalThis.chrome = {
  runtime: {
    getURL: (name) => `chrome-extension://test/${name}`,
    onMessage: { addListener: (fn) => (listener = fn) },
  },
};
globalThis.fetch = async (url, options) => route(url, options);

// Every reference a stylesheet makes, read with the worker's own extractor and
// judged by its own rule rather than a second copy of either: hand-copied
// regexes drifted into the identical blind spot twice. A stylesheet is a
// declarative artifact this repo owns, and what its references point at is the
// contract — anything the page would have to fetch is a request it issues on our
// behalf.
const { cssReferences: urlTargets, sanitizeCss, FETCHES_NOTHING } = await import(
  '../extension/background.js'
);

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
    assert.match(target, FETCHES_NOTHING, `panel.css points at ${target}; the page would fetch it`);
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
const ask = (message) =>
  new Promise((resolve) => {
    assert.equal(listener(message, null, resolve), true, 'listener must return true');
  });

// An inline SVG is the shape panel.css is most likely to reach for, since data:
// is the only scheme it is allowed — and it carries a quoted http(s) namespace
// that loads nothing. Eating it would blank the icon silently.
const SVG_URI =
  "data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e...";
const SVG_RULE = `.fx-icon{background-image:url("${SVG_URI}")}`;

// What survives is decided by what the reference points at, not by the construct
// carrying it and not by a list of dangerous schemes — enumerating either is how
// this class of bug kept coming back a round at a time. The invented function is
// the row that proves the carrier does not matter: nothing in the sanitizer has
// ever heard of paint-thing(). The relative and protocol-relative rows are the
// ones a scheme blocklist misses: both are page-visible requests, the first
// against LinkedIn's own origin.
const PNG_URI = 'data:image/png;base64,AAA';
const INERT = [PNG_URI, SVG_URI, '#blur'];
const FETCHED = [
  'https://cdn.example.com/logo.png',
  'http://cdn.example.com/logo.png',
  '//cdn.example.com/x.png',
  'icon.png',
];

// Each carrier lists what it can legally express: an unquoted url() token cannot
// hold raw quotes or spaces, a single-quoted string cannot hold the inline SVG's
// single-quoted attributes, and a bare quoted string with no scheme cannot be
// told from prose, so those rows carry no relative path or fragment.
const ALL = [...INERT, ...FETCHED];
const URL_SAFE = ALL.filter((ref) => ref !== SVG_URI);
const SCHEMED = [PNG_URI, SVG_URI, ...FETCHED.filter((ref) => ref !== 'icon.png')];
const CARRIERS = [
  ['url("…")', (ref) => `.a{background:url("${ref}")}`, ALL],
  ["url('…')", (ref) => `.b{background:url('${ref}')}`, URL_SAFE],
  ['url(…)', (ref) => `.c{background:url(${ref})}`, URL_SAFE],
  ['image-set()', (ref) => `.d{background-image:image-set("${ref}" 1x)}`, SCHEMED],
  ['paint-thing()', (ref) => `.e{background:paint-thing("${ref}" cover)}`, SCHEMED],
  ['a bare quoted string', (ref) => `.f{--fx-art:"${ref}"}`, SCHEMED],
  ['a rule below a comment', (ref) => `/* see https://wiki.example.com/panel */\n.g{background:url("${ref}")}`, ALL],
];

// A comment is never fetched by anything, so every reference inside one is left
// alone whatever it points at — including the shapes every row above strips.
const COMMENTS = [
  ['a commented-out rule', (ref) => `/* .h{background:url("${ref}")} */\n.i{color:red}`, ALL],
  ['a commented-out @import', (ref) => `/* @import "${ref}"; */\n.i{color:red}`, ALL],
  ['a note in a comment', (ref) => `/* icons from ${ref} */\n.i{color:red}`, ALL],
];

test('what the page would fetch is stripped and named; what it would not is kept whole', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    for (const [carrier, rule, refs] of [...CARRIERS, ...COMMENTS]) {
      const commented = COMMENTS.some(([name]) => name === carrier);
      for (const ref of refs) {
        const css = rule(ref);
        warnings.length = 0;
        const safe = sanitizeCss(css);

        if (commented || INERT.includes(ref)) {
          assert.equal(safe, css, `${carrier} must keep ${ref} byte for byte`);
          assert.deepEqual(warnings, [], `${carrier} warns about ${ref}, which fetches nothing`);
        } else {
          assert.ok(!safe.includes(ref), `${carrier} leaks ${ref}; the page would fetch it`);
          assert.ok(
            warnings.join('\n').includes(ref),
            `${carrier} strips ${ref} without saying so; a silent strip is a mystery`,
          );
          assert.ok(
            !warnings.join('\n').includes('wiki.example.com'),
            `${carrier} cries wolf over a URL in a comment, which nothing fetches`,
          );
        }
        assert.deepEqual(
          urlTargets(css),
          commented ? [] : [ref],
          `${carrier} misreads ${ref}; the panel.css guard reads it the same way`,
        );
      }
    }
  } finally {
    console.warn = realWarn;
  }
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
        // The same rule one keystroke from live, which is how a stylesheet under
        // review actually looks. A comment fetches nothing.
        '/* @import "https://commented.example.com/legacy.css"; */\n' +
        '.fx-panel{background:url("https://cdn.example.com/bg.png")}\n' +
        '.fx-logo{mask:url(/local/icon.svg)}\n' +
        // This one hides its remote source behind an earlier argument that closes
        // a paren of its own, which is why the strip is scoped to no construct.
        '.fx-tile{background-image:image-set(url("data:image/png;base64,AAA") 1x, "https://cdn.example.com/x@2x.png" 2x)}\n' +
        `${SVG_RULE}\n` +
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
  assert.deepEqual(urlTargets(res.css), [PNG_URI, SVG_URI]);
  assert.ok(!res.css.includes('reset.css'), 'a bare @import fetches too');
  assert.doesNotMatch(res.css, /cdn\.example\.com/, 'image-set carries a bare string, not a url()');
  assert.match(res.css, /\.fx-logo\{mask:/, 'only the references are stripped, not the rules');
  assert.ok(res.css.includes(SVG_RULE), 'a data: URI has to survive byte for byte, namespace and all');
  assert.match(res.css, /commented\.example\.com/, 'a commented-out rule is not a reference');

  assert.match(warnings.join('\n'), /https:\/\/cdn\.example\.com\/bg\.png/, 'a silent strip is a mystery');
  assert.doesNotMatch(warnings.join('\n'), /commented\.example\.com/, 'nothing fetches a comment');
  // The survivor warning is the durable half: the next construct nobody
  // anticipated stays diagnosable instead of leaking quietly.
  assert.match(warnings.join('\n'), /survivor\.example\.com/);
  assert.doesNotMatch(warnings.join('\n'), /w3\.org/, 'a namespace inside a data: URI fetches nothing');
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

// The listener has already returned true, so a handler that throws instead of
// answering is indistinguishable from a hang: the panel stays on "Loading…"
// until the port dies. The proxy is another crewmate's and does not exist yet,
// so a card shaped unlike the contract is a live possibility — investors as bare
// strings makes attachLogos throw on assignment under module strict mode.
test('a handler that throws still answers, rather than leaving the panel loading', async () => {
  route = (url) =>
    url.includes('/api/logo')
      ? bytes('image/png', 1)
      : body(200, { name: 'Acme', domain: 'acme.com', investors: ['Greylock'] });
  const res = await ask({ type: 'lookup', identifier: { kind: 'domain', value: 'acme.com' } });
  assert.deepEqual(res, { error: 'unavailable' });
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

// navigatesuccess fires for every same-document navigation, and most of them are
// not a new company: a replaceState adding a tracking param, scroll restoration,
// a hash change, LinkedIn's in-page tabs. Rebuilding on those destroys the card
// the reader is mid-way through, so the resolved identifier decides — an href
// compare cannot express "same company", which is why this kept coming back.
//
// The two guards do different jobs and both have to hold: the href skips the
// round trip for a navigation that did not move, and it names the URL in flight
// so arriving back at it is not swallowed; the identifier skips the rebuild for
// a URL that moved but stayed on the same company.
const SAME_COMPANY = [
  // [what moved, href, init round trips it should cost]
  ['nothing at all', 'https://www.linkedin.com/company/stripe', 0],
  ['an in-page tab', 'https://www.linkedin.com/company/stripe/about/', 1],
  ['a tracking param', 'https://www.linkedin.com/company/stripe?trk=nav', 1],
  ['a fragment', 'https://www.linkedin.com/company/stripe#people', 1],
];

test('the pill is rebuilt if and only if the resolved company changed', async () => {
  const listeners = {};
  globalThis.navigation = {
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)),
  };
  globalThis.location = { href: 'https://www.linkedin.com/company/stripe' };

  let inits = 0;
  let reachable = true;
  let gate = null;
  // Stands in for the resolver: every /company/<slug> path is one company,
  // whatever tab, query or fragment hangs off it.
  chrome.runtime.sendMessage = async (message) => {
    if (message.type === 'lookup') return { found: true, card: { name: 'Stripe' } };
    if (message.type !== 'init') return null;
    inits++;
    await gate;
    if (!reachable) throw new Error('Extension context invalidated');
    const slug = new URL(message.url).pathname.match(/^\/company\/([^/]+)/)?.[1];
    return { identifier: slug ? { kind: 'linkedin', value: slug } : null, css: '' };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const host = () => document.querySelector('#fundable-extension-root');
  const arrive = async (href = location.href) => {
    location.href = href;
    for (const fn of listeners.navigatesuccess ?? []) fn({});
    await settle();
  };

  try {
    panel.start();
    await settle();
    const mounted = host();
    assert.ok(mounted, 'the pill mounts on a company page');

    mounted.shadowRoot.querySelector('.fx-pill').click();
    await settle();
    const card = mounted.shadowRoot.querySelector('.fx-panel');
    assert.equal(card.style.display, '', 'the reader has the panel open');
    assert.equal(card.querySelector('.fx-name').textContent, 'Stripe');

    for (const [what, href, cost] of SAME_COMPANY) {
      const before = inits;
      await arrive(href);
      assert.equal(host(), mounted, `${what} changed, not the company; the pill must not be rebuilt`);
      assert.equal(card.style.display, '', `${what} changed; the open card must survive`);
      assert.equal(card.querySelector('.fx-name').textContent, 'Stripe');
      assert.equal(inits - before, cost, `${what} changed; wrong number of init round trips`);
    }

    await arrive('https://www.linkedin.com/company/ramp');
    assert.notEqual(host(), null, 'a different company still mounts a pill');
    assert.notEqual(host(), mounted, 'a different company rebuilds the pill');
    assert.equal(document.querySelectorAll('#fundable-extension-root').length, 1);

    await arrive('https://www.linkedin.com/feed/');
    assert.equal(host(), null, 'a page that resolves to nothing unmounts the pill, not just hides it');

    // A worker that never answered — restarting, or the context invalidated by
    // an extension reload — must leave no record, so the next navigation retries.
    // A deny-listed page is different: it answered, so it stays quiet.
    reachable = false;
    await arrive('https://www.linkedin.com/company/stripe');
    assert.equal(host(), null, 'a transport failure has nothing to mount');

    reachable = true;
    await arrive();
    const kept = host();
    assert.ok(kept, 'the same URL must be re-resolved after a transport failure');

    // Back to the mounted company while the init for the page just left is still
    // in flight — one runtime round trip wide, which is real against a cold
    // worker. The answer that lands names a URL the reader is no longer on, and
    // the guard has to have recorded the URL in flight or it swallows the return.
    let release;
    gate = new Promise((resolve) => (release = resolve));
    await arrive('https://www.linkedin.com/feed/');
    await arrive('https://www.linkedin.com/company/stripe');
    release();
    gate = null;
    await settle();
    assert.equal(host(), kept, 'coming back mid-flight must not take the pill with it');
  } finally {
    delete globalThis.navigation;
    delete globalThis.location;
    for (const node of document.querySelectorAll('#fundable-extension-root')) node.remove();
  }
});
