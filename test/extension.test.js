import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

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

test('background.js is where the network calls live', () => {
  assert.match(read('background.js'), /\bfetch\s*\(/);
});

test('manifest keeps network permission scoped and the extension ID pinned', () => {
  assert.ok(manifest.key, 'manifest needs a pinned key for a stable extension ID');
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
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
globalThis.fetch = async (url) => route(url);

await import('../extension/background.js');

// Also asserts the listener returns true, which is what keeps sendResponse
// alive across the await in MV3.
const ask = (message) =>
  new Promise((resolve) => {
    assert.equal(listener(message, null, resolve), true, 'listener must return true');
  });

test('init hands back the resolver verdict and the packaged stylesheet', async () => {
  route = (url) => {
    assert.equal(url, 'chrome-extension://test/panel.css');
    return { text: async () => '.fx-panel{}' };
  };
  const res = await ask({ type: 'init', url: 'https://www.linkedin.com/company/stripe' });
  assert.ok('identifier' in res, 'init must report the resolver verdict');
  assert.equal(res.css, '.fx-panel{}');
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
const panel = new Function(`${read('content.js')}\nreturn { renderCard };`)();

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
  assert.equal(node.querySelector('img'), null);
  assert.equal(node.querySelector('.fx-name').textContent, '<img src=x onerror=alert(1)>');
});
