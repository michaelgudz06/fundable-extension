// popup.js — the whole UI. Clicking the toolbar icon opens popup.html, this
// resolves the active tab's URL to a company and renders the card.
//
// NOTHING HERE TOUCHES THE NETWORK. Card data and logos come from background.js
// over chrome.runtime messaging; logos arrive as data: URLs. The popup is an
// extension page, so a request from here would not show up in any web page's
// DevTools Network tab — but the worker already owns every fetch, and splitting
// that ownership is how the rule rots. panel.css is loaded by <link>, which the
// extension page fetches from its own package.

const MISS = "We're working on adding this company";

// Not the same sentence as MISS: the toolbar icon is clickable on chrome://
// pages, the New Tab page and the Web Store, where there is no company to have
// an opinion about. See open().
const NO_PAGE = 'No company on this page';

const ERRORS = {
  rate_limited: 'Too many lookups right now. Try again in a moment.',
  // The upstream ran past its deadline. It's transient — the very next click
  // often lands under the wall — so this one asks for the retry that works.
  upstream_error: 'Fundable took too long to respond. Try again.',
  temporarily_unavailable: 'Fundable is at capacity right now. Try again shortly.',
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

// Live cards SHOUT: the API sends SERIES_H, EQUITY, SECONDARY, and the old
// implementation only ever fixed the case of the fixtures' lowercase `series_d`,
// so every real card rendered "SERIES H". Title-case either shape, but leave
// short all-caps tokens alone — the H of SERIES_H, and an ipo_status of IPO,
// which lowercasing first would have turned into "Ipo".
const pretty = (s) =>
  String(s)
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) =>
      w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');

// Two round types are nouns rather than round names, and title-casing alone
// leaves them reading like enum values: a header saying "Equity" or "Secondary"
// is not a sentence a human would write. Everything else — SEED, SERIES_C — is
// already its own name.
const DEAL_NAMES = { equity: 'Equity round', secondary: 'Secondary transaction' };

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

// Fundable sends num_employees as a bucket string ("501-1000"), not a number,
// while the other counts are numbers. A string is already display-ready, so it
// passes through rather than being dropped — this tile rendered for nobody until
// live data showed the fixture's plain 1200 was not the shape the API returns.
const count = (value) => {
  if (typeof value === 'string') return value.trim() || null;
  return typeof value === 'number' && isFinite(value)
    ? new Intl.NumberFormat('en-US').format(value)
    : null;
};

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
// href from a poisoned card would otherwise become a clickable anchor in the
// popup. A dropped link hides its element, like any other missing value.
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
    // Notion raised exactly one round and Retool has exactly one investor, so
    // these two labels are the only ones that can ever read "1 rounds".
    [stats.num_funding_rounds === 1 ? 'Funding round' : 'Funding rounds', count(stats.num_funding_rounds)],
    [stats.num_investors === 1 ? 'Investor' : 'Investors', count(stats.num_investors)],
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
  // Case-folded: the API does not normalise the code, and a lowercase "usd"
  // slipping past this filter prints the same figure twice ("$610M · $610M"),
  // because Intl canonicalises the code it is handed and we do not.
  const financing = (deal.financings ?? []).find(
    (f) => f?.size_native && f.currency && f.currency.toUpperCase() !== 'USD',
  );
  return financing ? money(financing.size_native, financing.currency) : null;
}

function round(card) {
  const deal = card.latest_deal;
  if (!deal) return null;
  const node = el('div', 'fx-round');

  if (deal.type) {
    let name = DEAL_NAMES[String(deal.type).toLowerCase()] ?? pretty(deal.type);
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

  // stats.num_investors and investors[] are separately sourced and disagree in
  // both directions — Stripe says 26 and ships none, Telli says 2 and ships
  // four — so neither can be used to describe the other. "Showing 8 of 15" is
  // therefore unwriteable: on Telli it would read "4 of 2". Instead the tile
  // keeps the API's number untouched and this section only ever speaks for the
  // names it actually has. Vanishing outright was the bug: it left a tile
  // boasting 26 investors above nothing at all, which reads as a failed render.
  if (!list.length && !(card.stats?.num_investors > 0)) return null;

  // Overline heading, same treatment as the round block — every section on the
  // card names itself, so the investor list doesn't start cold under the round.
  const wrap = el('div', 'fx-investors');
  wrap.append(el('div', 'fx-investors-head', 'Investors'));

  if (!list.length) {
    wrap.append(el('div', 'fx-note', "Fundable doesn't name this company's investors."));
    return wrap;
  }

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

export function renderCard(card) {
  return [header, chips, tiles, round, investors, footer]
    .map((section) => section(card))
    .filter(Boolean);
}

// --- the popup ---------------------------------------------------------------

const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

// The popup is opened by a click on the action, which is what grants activeTab —
// so `url` is readable here without the broad "tabs" permission. It is also a
// fresh document every time, so there is no SPA navigation to follow and no
// stale-response race to guard: one open, one lookup, then the popup is gone.
export async function open(panel) {
  const show = (...nodes) => panel.replaceChildren(...nodes);

  const [tab] = (await chrome.tabs.query({ active: true, currentWindow: true })) ?? [];
  // The action is enabled on every tab now, not just the https pages the old
  // content script matched. On a chrome:// page, the New Tab page or the Web
  // Store, activeTab grants nothing and there is no URL to read — which is not
  // a company Fundable is "working on adding", it is not a company at all.
  const url = tab?.url ?? '';
  if (!/^https?:\/\//i.test(url)) return show(el('div', 'fx-miss', NO_PAGE));

  const init = await send({ type: 'init', url });
  // No answer at all is a transport failure — an extension reload invalidates
  // the context mid-flight and sendMessage rejects. It is not the same as an
  // answer of `null`, which is the resolver saying this page has no company:
  // reporting a broken worker as "we're adding this company" sends the reader
  // away believing a fact that was never checked.
  if (!init) return show(el('div', 'fx-error', ERRORS.network));
  // background.js answers a throw in *either* handler with {error}, so init can
  // carry one too. Unchecked it has no `identifier` and falls into the miss line
  // below — the same false claim the guard above exists to prevent.
  if (init.error) return show(el('div', 'fx-error', ERRORS[init.error] ?? ERRORS.unavailable));
  if (!init.identifier) return show(el('div', 'fx-miss', MISS));

  const res = await send({ type: 'lookup', identifier: init.identifier });
  if (!res) return show(el('div', 'fx-error', ERRORS.network));
  if (res.error) return show(el('div', 'fx-error', ERRORS[res.error] ?? ERRORS.unavailable));
  if (!res.found) return show(el('div', 'fx-miss', MISS));
  show(...renderCard(res.card));
}

// Guarded the way content.js was, so importing this module under test does not
// fire a lookup. chrome.tabs exists only in an extension page.
if (globalThis.chrome?.tabs && chrome.runtime?.id) {
  open(document.querySelector('.fx-panel'));
}
