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
// in panel.css). The brand marks are the exact Simple Icons glyphs react-icons/si
// ships (SiLinkedin, SiX, SiFacebook, SiCrunchbase); Crunchbase is included by
// request, PitchBook stays off. The label is the aria-label and tooltip, so it
// carries brand casing ("LinkedIn") a derived one would flatten.
// [key on card.links, icon name, label].
const LINKS = [
  ['website', 'globe', 'Website'],
  ['linkedin', 'linkedin', 'LinkedIn'],
  ['twitter', 'x', 'X'],
  ['facebook', 'facebook', 'Facebook'],
  ['crunchbase', 'crunchbase', 'Crunchbase'],
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
    d: ['M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z'],
  },
  x: {
    fill: true,
    d: ['M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z'],
  },
  facebook: {
    fill: true,
    d: ['M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z'],
  },
  crunchbase: {
    fill: true,
    d: ['M21.6 0H2.4A2.41 2.41 0 0 0 0 2.4v19.2A2.41 2.41 0 0 0 2.4 24h19.2a2.41 2.41 0 0 0 2.4-2.4V2.4A2.41 2.41 0 0 0 21.6 0zM7.045 14.465A2.11 2.11 0 0 0 9.84 13.42h1.66a3.69 3.69 0 1 1 0-1.75H9.84a2.11 2.11 0 1 0-2.795 2.795zm11.345.845a3.55 3.55 0 0 1-1.06.63 3.68 3.68 0 0 1-3.39-.38v.38h-1.51V5.37h1.5v4.11a3.74 3.74 0 0 1 1.8-.63H16a3.67 3.67 0 0 1 2.39 6.46zm-.223-2.766a2.104 2.104 0 1 1-4.207 0 2.104 2.104 0 0 1 4.207 0z'],
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

// This company's public Fundable profile, reached from the Fundable icon in the
// links row; null when the card has no permalink, which drops that icon.
function fundableUrl(card) {
  return card.guru_permalink
    ? `https://www.tryfundable.ai/company/${encodeURIComponent(card.guru_permalink)}`
    : null;
}

// No brand mark in the header any more: the overlay's close control owns the
// top-right corner, and the Fundable page it used to link to is one tap away from
// the ⚡ in the links row — a second mark 50px above it only crowded the corner.
function header(card) {
  const node = el('div', 'fx-header');
  const logo = logoImg('fx-logo', card.logo, card.name);
  if (logo) node.append(logo);
  if (card.name) node.append(el('div', 'fx-name', card.name));
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

// --- overlay plumbing --------------------------------------------------------
// popup.html renders inside the transparent iframe inject.js mounts, not a
// toolbar popup. Two things a popup never needed: a way to dismiss (there is no
// visible close button — Esc, or a second click on the toolbar icon, tears the
// overlay down), and telling the host iframe how tall to be so the card is
// neither clipped nor boxed in dead space. Both are guarded on actually being
// framed, so importing this module under test (window.parent === window) is inert.
export function wireOverlay() {
  if (typeof window === 'undefined' || window.parent === window) return;

  const close = () => window.parent.postMessage('fundable-close', '*');
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());

  // The card's own height drives the iframe's, remeasured whenever it changes
  // (a lookup resolving, "Show more" expanding the investor list).
  const postSize = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height) window.parent.postMessage({ type: 'fundable-size', height }, '*');
  };
  postSize();
  if (typeof ResizeObserver === 'function') new ResizeObserver(postSize).observe(document.body);
}

// Guarded the way content.js was, so importing this module under test does not
// fire a lookup. chrome.tabs exists only in an extension page.
if (globalThis.chrome?.tabs && chrome.runtime?.id) {
  wireOverlay();
  open(document.querySelector('.fx-panel'));
}
