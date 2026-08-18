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

// "Open on…" destinations, rendered as a row of brand icons (see LINKS styling
// in panel.css). Fundable's own profile is one of them; the aggregators it
// competes with — Crunchbase, PitchBook — stay off. The label is the aria-label
// and tooltip, so it carries brand casing ("LinkedIn") a derived one would flatten.
// [key on card.links, icon name, label].
const LINKS = [
  ['website', 'globe', 'Website'],
  ['linkedin', 'linkedin', 'LinkedIn'],
  ['twitter', 'twitter', 'Twitter'],
  ['facebook', 'facebook', 'Facebook'],
  ['fundable', 'fundable', 'Fundable'],
];

// Investor rows shown before the "Show N more" button. Leads sort first, so the
// preview is the ones that matter; the rest are one click away.
const INVESTOR_PREVIEW = 5;

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

// "1001-5000" -> "1K–5K", to match the headcount pill on Fundable's own card.
// Compacts each number in the bucket and leaves small ones and any "+" alone.
const compactInt = (n) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
function abbrevRange(text) {
  if (!text) return null;
  return text.replace(/[\d,]+/g, (m) => compactInt(Number(m.replace(/,/g, '')))).replace(/-/g, '–');
}

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

// Inline SVGs — the icon row and metadata pills draw locally, no network. `fill`
// entries are brand marks painted in the current colour; the rest are line icons
// stroked in it. Fundable's own mark is the bundled PNG, handled in links().
const ICONS = {
  linkedin: {
    fill: true,
    d: ['M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45C23.2 24 24 23.23 24 22.27V1.73C24 .77 23.2 0 22.22 0z'],
  },
  twitter: {
    fill: true,
    d: ['M18.24 2.25h3.31l-7.23 8.26 8.5 11.24H16.17l-5.21-6.82L4.99 21.75H1.68l7.73-8.84L1.25 2.25H8.08l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z'],
  },
  facebook: {
    fill: true,
    d: ['M24 12.07C24 5.44 18.63.07 12 .07S0 5.44 0 12.07c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08v-3.47h3.05V9.43c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87v2.25h3.33l-.53 3.47h-2.8v8.38C19.61 23.02 24 18.06 24 12.07z'],
  },
  globe: { d: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 0 20', 'M12 2a15.3 15.3 0 0 0 0 20'] },
  pin: { d: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', 'M15 10a3 3 0 1 0-6 0 3 3 0 0 0 6 0z'] },
  users: {
    d: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  },
  building: { d: ['M5 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18', 'M3 22h18', 'M9 6h.01M13 6h.01M9 10h.01M13 10h.01M9 14h.01M13 14h.01'] },
};

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(name, className) {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  if (spec.fill) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const d of spec.d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// --- card sections ----------------------------------------------------------
// Every section returns null when it has nothing to show, so missing data hides
// its element rather than rendering an empty box.

// This company's public Fundable profile. Used by the Fundable chip and the
// brand mark; null when the card has no permalink, which drops both.
function fundableUrl(card) {
  return card.guru_permalink
    ? `https://www.tryfundable.ai/company/${encodeURIComponent(card.guru_permalink)}`
    : null;
}

// Fundable brand mark, top-right of the header — the bundled toolbar icon, so
// it costs no network request. Links to the company's Fundable page when there
// is one, otherwise it's just the stamp.
function brandMark(card) {
  const href = fundableUrl(card);
  const node = (href && link('fx-brand', href, null)) || el('div', 'fx-brand');
  const img = el('img', 'fx-brand-logo');
  img.src = 'icons/icon128.png';
  img.alt = 'Fundable';
  node.append(img);
  return node;
}

function header(card) {
  const node = el('div', 'fx-header');
  const logo = logoImg('fx-logo', card.logo, card.name);
  if (logo) node.append(logo);
  if (card.name) node.append(el('div', 'fx-name', card.name));
  if (card.name) node.append(brandMark(card));
  return node.childNodes.length ? node : null;
}

// Location · status · headcount as icon pills, the treatment Fundable's own card
// uses. Headcount lived in a stat tile before; it moves here so the tiles hold
// only money and counts.
function metaPills(card) {
  const items = [
    ['pin', card.region],
    ['building', card.ipo_status && pretty(card.ipo_status)],
    ['users', abbrevRange(count(card.stats?.num_employees))],
  ].filter(([, text]) => text);
  if (!items.length) return null;

  const row = el('div', 'fx-metapills');
  for (const [icon, text] of items) {
    const pill = el('span', 'fx-pill');
    pill.append(svgIcon(icon, 'fx-pill-icon'), el('span', 'fx-pill-text', text));
    row.append(pill);
  }
  return row;
}

function links(card) {
  const href = { ...card.links };
  href.website ??= card.website;
  href.fundable = fundableUrl(card);

  const row = el('div', 'fx-links');
  for (const [key, icon, label] of LINKS) {
    const a = link('fx-ico', href[key], null);
    if (!a) continue;
    a.setAttribute('aria-label', label);
    a.title = label;
    // Fundable's own mark is the bundled PNG; the rest are inline brand SVGs.
    a.append(key === 'fundable' ? Object.assign(el('img', 'fx-ico-img'), { src: 'icons/icon128.png', alt: '' }) : svgIcon(icon, 'fx-ico-svg'));
    row.append(a);
  }
  return row.childNodes.length ? row : null;
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

  const rows = list.map((investor) => {
    const row = el('div', 'fx-investor');
    const logo = logoImg('fx-investor-logo', investor.logo, investor.name);
    if (logo) row.append(logo);
    row.append(el('span', 'fx-investor-name', investor.name));
    if (investor.lead_investor) row.append(el('span', 'fx-lead-badge', 'Lead'));
    return row;
  });

  wrap.append(...rows.slice(0, INVESTOR_PREVIEW));

  // A long list (Stripe ships 16) turns the card into a scroll. Show the first
  // few — leads already sort first — and hold the rest behind one button that
  // reveals them all in place.
  const rest = rows.slice(INVESTOR_PREVIEW);
  if (rest.length) {
    const more = el('button', 'fx-more', 'Show more');
    more.type = 'button';
    more.addEventListener('click', () => {
      more.replaceWith(...rest);
    });
    wrap.append(more);
  }
  return wrap;
}

export function renderCard(card) {
  return [header, metaPills, links, tiles, round, investors]
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
