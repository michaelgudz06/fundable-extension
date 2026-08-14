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
  return isNaN(date.getTime())
    ? null
    : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// --- DOM helpers ------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function link(className, href, text) {
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
  const nodes = CHIPS.filter(([key]) => links[key]).map(([key, label]) =>
    link('fx-chip', links[key], label),
  );
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
  if (deal.article_url) node.append(link('fx-round-source', deal.article_url, 'Source'));

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
}

async function start() {
  const res = await send({ type: 'init', url: location.href });
  if (res?.identifier) mount(res.css);
}

if (typeof chrome === 'object' && chrome.runtime?.id) start();
