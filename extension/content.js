// content.js — injects the pill and the Shadow DOM panel.
//
// NOTHING HERE TOUCHES THE NETWORK. No fetch, no XMLHttpRequest, no sendBeacon,
// no <img src="https://...">. Requests made from a content script land in the
// inspected page's DevTools Network tab and would give away that the extension
// is talking to Fundable. Every byte — card data, logos, even panel.css — comes
// from background.js over chrome.runtime messaging. Logos arrive as data: URLs.
//
// test/extension.test.js fails the build if that ever stops being true.

const MISS = "We're working on adding this company";

const ERRORS = {
  rate_limited: 'Too many lookups right now. Try again in a moment.',
  unavailable: 'Fundable is unavailable right now.',
  network: 'Could not reach Fundable.',
};

const CHIPS = [
  ['website', 'Website'],
  ['linkedin', 'LinkedIn'],
  ['twitter', 'Twitter'],
  ['facebook', 'Facebook'],
  ['crunchbase', 'Crunchbase'],
  ['pitchbook', 'PitchBook'],
];

// --- formatting -------------------------------------------------------------

const pretty = (s) => String(s).replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

function money(value, currency = 'USD') {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return null; // malformed currency code
  }
}

const count = (value) =>
  typeof value === 'number' && isFinite(value)
    ? new Intl.NumberFormat('en-US').format(value)
    : null;

function when(value) {
  if (!value) return null;
  const date = new Date(value);
  // The proxy sends date-only strings, which parse as UTC midnight. Formatting
  // them in the local zone would render 2021-01-01 as "Dec 2020" west of UTC.
  return isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// --- DOM helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Returns null for anything that isn't http(s) — a `javascript:` or `data:`
// href from a poisoned card would otherwise become a clickable anchor inside the
// host page. A dropped link hides its element, like any other missing value.
function link(className, href, text) {
  if (!/^https?:\/\//i.test(String(href))) return null;
  const anchor = el('a', className, text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

// `src` is always a data: URL produced by the service worker.
function logoImg(className, src, alt) {
  if (!src) return null;
  const img = el('img', className);
  img.alt = alt || '';
  img.src = src;
  img.onerror = () => img.remove();
  return img;
}

// --- card sections ----------------------------------------------------------
// Every section returns null when it has nothing to show, so missing data hides
// its element rather than rendering an empty box.

function header(card) {
  const node = el('div', 'fx-header');
  const logo = logoImg('fx-logo', card.logo, card.name);
  if (logo) node.append(logo);
  if (card.name) node.append(el('div', 'fx-name', card.name));
  const meta = [card.region, card.ipo_status && pretty(card.ipo_status)].filter(Boolean).join(' · ');
  if (meta) node.append(el('div', 'fx-meta', meta));
  return node.childNodes.length ? node : null;
}

function chips(card) {
  const links = { ...card.links };
  links.website ??= card.website;
  const nodes = CHIPS.map(([key, label]) => link('fx-chip', links[key], label)).filter(Boolean);
  if (!nodes.length) return null;
  const row = el('div', 'fx-chips');
  row.append(...nodes);
  return row;
}

function tiles(card) {
  const stats = card.stats ?? {};
  const valuationDate = when(stats.latest_valuation_date);
  const rows = [
    ['Total raised', money(stats.total_raised)],
    ['Latest round', money(card.latest_deal?.total_round_raised)],
    [valuationDate ? `Valuation · ${valuationDate}` : 'Valuation', money(stats.latest_valuation_usd)],
    ['Funding rounds', count(stats.num_funding_rounds)],
    ['Investors', count(stats.num_investors)],
    ['Employees', count(stats.num_employees)],
  ].filter(([, value]) => value);
  if (!rows.length) return null;

  const grid = el('div', 'fx-tiles');
  for (const [label, value] of rows) {
    const tile = el('div', 'fx-tile');
    tile.append(el('div', 'fx-tile-label', label), el('div', 'fx-tile-value', value));
    grid.append(tile);
  }
  return grid;
}

// The native amount is only worth showing when the round wasn't raised in USD.
function nativeAmount(deal) {
  const financing = (deal.financings ?? []).find(
    (f) => f?.size_native && f.currency && f.currency !== 'USD',
  );
  return financing ? money(financing.size_native, financing.currency) : null;
}

function round(card) {
  const deal = card.latest_deal;
  if (!deal) return null;
  const node = el('div', 'fx-round');

  if (deal.type) {
    let name = pretty(deal.type);
    if (deal.pre) name = `Pre-${name}`;
    if (deal.extension) name += ' extension';
    node.append(el('div', 'fx-round-head', name));
  }
  const amount = [money(deal.total_round_raised), nativeAmount(deal)].filter(Boolean).join(' · ');
  if (amount) node.append(el('div', 'fx-round-amount', amount));

  const date = when(deal.date);
  if (date) node.append(el('div', 'fx-round-date', date));
  const source = link('fx-round-source', deal.article_url, 'Source');
  if (source) node.append(source);

  return node.childNodes.length ? node : null;
}

function investors(card) {
  const list = (card.investors ?? []).filter((investor) => investor?.name);
  if (!list.length) return null;

  const wrap = el('div', 'fx-investors');
  for (const investor of list) {
    const row = el('div', 'fx-investor');
    const logo = logoImg('fx-investor-logo', investor.logo, investor.name);
    if (logo) row.append(logo);
    row.append(el('span', 'fx-investor-name', investor.name));
    if (investor.lead_investor) row.append(el('span', 'fx-lead-badge', 'Lead'));
    wrap.append(row);
  }
  return wrap;
}

function footer(card) {
  if (!card.guru_permalink) return null;
  const href = `https://www.tryfundable.ai/company/${encodeURIComponent(card.guru_permalink)}`;
  return link('fx-footer', href, 'View on Fundable');
}

function renderCard(card) {
  return [header, chips, tiles, round, investors, footer]
    .map((section) => section(card))
    .filter(Boolean);
}

// --- pill + panel -----------------------------------------------------------

const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

// PP Mori has to be registered on the document: an @font-face declared inside a
// shadow root is ignored and its file is never fetched, so panel.css cannot load
// the font by itself.
//
// The bytes come from the service worker, and a FontFace built from binary data
// loads no URL — so this costs the page zero network requests. Every failure
// path here is silent on purpose: a rotated filename, a page that forbids it, a
// font that won't parse. panel.css keeps its Helvetica/Arial fallback and the
// card renders either way.
//
// mount() runs once per resolving navigation, but the faces belong to the
// document, so the promise is memoised: FontFaceSet retains every distinct
// FontFace added to it, and browsing company pages in one tab is the primary use
// case.
const FONT_FAMILY = 'PP Mori'; // must match the family panel.css asks for

let fontsReady;

async function registerFonts() {
  const faces = await send({ type: 'fonts' });
  if (!Array.isArray(faces)) return;
  for (const face of faces) {
    try {
      const bytes = Uint8Array.from(atob(face.base64), (char) => char.charCodeAt(0));
      const font = new FontFace(FONT_FAMILY, bytes, {
        weight: String(face.weight),
        style: 'normal',
        display: 'swap',
      });
      document.fonts.add(await font.load());
    } catch {
      // keep the fallback
    }
  }
}

function mount(css) {
  const host = document.createElement('div');
  host.id = 'fundable-extension-root';
  const root = host.attachShadow({ mode: 'open' });

  if (css) root.append(el('style', null, css));

  const pill = el('button', 'fx-pill', 'Fundable');
  pill.type = 'button';
  pill.setAttribute('aria-expanded', 'false');

  const panel = el('section', 'fx-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Fundable company card');
  panel.style.display = 'none';

  root.append(pill, panel);
  document.documentElement.append(host);
  fontsReady ??= registerFonts(); // deliberately not awaited: never holds up a render

  const show = (...nodes) => panel.replaceChildren(...nodes);
  let seq = 0;

  // Neither handler calls preventDefault or stopPropagation: the page keeps its
  // own scrolling and keyboard behaviour while the panel is up.
  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };
  const onDocClick = (event) => {
    if (!event.composedPath().includes(host)) close();
  };

  function close() {
    seq++;
    panel.style.display = 'none';
    pill.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onDocClick);
  }

  async function open() {
    const me = ++seq;
    panel.style.display = '';
    pill.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onDocClick);
    show(el('div', 'fx-loading', 'Loading…'));

    // Re-resolve every time: LinkedIn and Crunchbase are single-page apps, so
    // the URL can have moved on since this script ran.
    const init = await send({ type: 'init', url: location.href });
    if (me !== seq) return;
    if (!init?.identifier) return show(el('div', 'fx-miss', MISS));

    const res = await send({ type: 'lookup', identifier: init.identifier });
    if (me !== seq) return;
    if (!res) return show(el('div', 'fx-error', ERRORS.network));
    if (res.error) return show(el('div', 'fx-error', ERRORS[res.error] ?? ERRORS.unavailable));
    if (!res.found) return show(el('div', 'fx-miss', MISS));
    show(...renderCard(res.card));
  }

  pill.addEventListener('click', () => (panel.style.display === 'none' ? open() : close()));

  return () => {
    close(); // drops the document-level keydown/click listeners too
    host.remove();
  };
}

// LinkedIn and Crunchbase route in the page without reloading, so the content
// script runs once and the pill would never appear on the company page you
// clicked through to. The Navigation API sees those same-document navigations;
// history.pushState cannot be observed from here because a content script runs
// in an isolated world and the page's router lives in the page world.
//
// It has to be `navigatesuccess`, not `navigate`: `navigate` is the interception
// point and fires BEFORE the URL commits, so location.href there is still the
// page being left. `navigatesuccess` fires after the commit, and a navigation
// that is cancelled or fails never fires it at all.
//
// Reading location.href is not a network call: the URL still goes to the worker
// to be resolved, so content.js stays at zero requests.
//
// `navigatesuccess` also fires where nothing changed company: a replaceState
// adding a tracking param, scroll restoration, a hash change, and LinkedIn's own
// in-page tabs (/company/stripe -> /company/stripe/about/, the most common
// navigation on the primary target site). Tearing the host down would take the
// card the reader is mid-way through with it, so the resolved identifier — not
// the href — decides whether anything is rebuilt. The href is only a cheap skip
// for a navigation that did not move at all, and it names the URL in flight so
// arriving back at it is not swallowed; a worker that never answered clears it
// and gets retried.
let unmount = null;
let mountedKey = null;
let navSeq = 0;
let syncedHref = null;

async function sync() {
  const href = location.href;
  if (href === syncedHref) return;
  syncedHref = href;
  const me = ++navSeq;
  const res = await send({ type: 'init', url: href });
  if (me !== navSeq) return; // a later navigation already owns the pill
  if (!res) {
    syncedHref = null;
    return;
  }
  const key = res.identifier ? `${res.identifier.kind}:${res.identifier.value}` : null;
  if (key === mountedKey) return;
  unmount?.();
  mountedKey = key;
  unmount = key ? mount(res.css) : null;
}

function start() {
  sync();
  globalThis.navigation?.addEventListener('navigatesuccess', () => sync());
}

if (typeof chrome === 'object' && chrome.runtime?.id) start();
