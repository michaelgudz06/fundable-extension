// popup.js — the whole UI. Clicking the toolbar icon opens popup.html, this
// resolves the active tab's URL to a company and renders the card.
//
// NOTHING HERE TOUCHES THE NETWORK. Card data and logos come from background.js
// over chrome.runtime messaging; logos arrive as data: URLs. The popup is an
// extension page, so a request from here would not show up in any web page's
// DevTools Network tab — but the worker already owns every fetch, and splitting
// that ownership is how the rule rots. panel.css is loaded by <link>, which the
// extension page fetches from its own package.

const MISS = "Sorry, this company isn't available yet — we'll work on adding it.";

// Not the same sentence as MISS, and the distinction is the whole point: MISS is
// a promise ("we'll add this company"), so it may only be shown for a page that
// actually resolved to a company Fundable happens not to have yet. Everything
// else — a chrome:// page, a random site, a search result, a deny-listed page —
// is not a company at all and must never be told it is on the roadmap. See open().
const NO_PAGE = "Sorry, we couldn't find a company on this page.";

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
// ships (SiLinkedin, SiX, SiFacebook, SiCrunchbase). react-icons/si has no
// PitchBook mark, so that one is a line "book" glyph (ICONS.pitchbook). The label
// is the aria-label and tooltip, so it carries brand casing ("LinkedIn") a derived
// one would flatten. The order here is the render order of the row.
// [key on card.links, icon name, label].
const LINKS = [
  ['linkedin', 'linkedin', 'LinkedIn'],
  ['twitter', 'x', 'X'],
  ['crunchbase', 'crunchbase', 'Crunchbase'],
  ['pitchbook', 'pitchbook', 'PitchBook'],
  ['facebook', 'facebook', 'Facebook'],
  ['website', 'globe', 'Website'],
  ['fundable', 'fundable', 'Fundable'],
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
  // react-icons/si ships no PitchBook mark, so a line "book" glyph stands in for
  // it (Lucide book, matching the other line icons — pin, users, building).
  pitchbook: { d: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'] },
  pin: { d: ['M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', 'M15 10a3 3 0 1 0-6 0 3 3 0 0 0 6 0z'] },
  users: {
    d: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  },
  building: { d: ['M5 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18', 'M3 22h18', 'M9 6h.01M13 6h.01M9 10h.01M13 10h.01M9 14h.01M13 14h.01'] },
  fundable: {
    fill: true,
    viewBox: '0 0 218 220',
    // The Möbius mark inline (same paths as popup.html's loading .fx-mark),
    // so it inherits the link row's currentColor — muted grey, ink on hover —
    // like every sibling, instead of standing out as a solid-black PNG.
    d: [
      'M107.211 0H111.219L119.658 0.626673L125.777 1.46224L131.262 2.50669L139.279 4.5956L146.663 7.10229L153.203 9.81788L161.22 13.7868L165.44 16.2935L171.769 20.4713L175.355 23.1869L178.942 26.1114L181.052 27.9914L182.739 29.4536L189.702 36.347L191.178 38.0182L194.132 41.5693L196.242 44.2849L198.984 48.0449L200.461 50.3427L202.782 54.1028L204.892 57.8628L207.001 61.8317L209.955 68.3074L211.854 73.3207L214.174 80.6319L215.651 86.4809L216.706 91.912L217.55 98.1788L217.972 102.774V117.397L217.339 123.872L216.495 129.304L215.44 134.735L213.753 141.001L211.643 147.268L209.322 153.117L206.368 159.384L203.837 164.188L201.305 168.366L198.351 172.753L195.82 176.095L193.71 178.811L191.811 181.109L189.702 183.406L188.225 185.077L185.06 188.42L181.685 191.553L179.364 193.642L174.09 197.82L171.769 199.491L167.338 202.415L164.385 204.295L161.431 205.967L156.579 208.473L151.304 210.98L144.342 213.696L137.802 215.784L130.207 217.664L122.612 218.918L117.127 219.544L110.798 219.962H107.211L107 219.544V182.153L107.422 181.944L112.485 181.735L119.447 180.9L125.355 179.646L131.473 177.766L135.692 176.095L140.756 173.797L144.764 171.5L147.718 169.62L150.039 167.948L152.992 165.651L155.735 163.353L158.899 160.428L161.853 157.295L163.963 154.788L166.494 151.446L168.604 148.313L171.136 143.926L173.879 138.286L176.199 132.228L177.676 127.215L178.942 120.948L179.575 114.89V105.072L178.731 98.1788L177.465 92.1209L175.988 87.1076L173.879 81.6764L172.191 77.9164L169.87 73.7385L167.338 69.7696L164.596 66.0096L162.064 63.0851L160.587 61.414L155.524 56.4006L153.203 54.5206L150.672 52.4316L147.296 50.1338L143.287 47.6272L138.646 45.1205L133.583 43.0316L128.941 41.3604L123.667 39.8982L117.76 38.8537L114.384 38.4359L107 38.0182V1.04446L107.211 0Z',
      'M106.035 37H106.455L106.666 38.4882V180.503L106.455 182.203L99.515 181.566L94.0469 180.715L88.5787 179.44L81.0074 176.889L76.8011 174.975L73.436 173.274L69.2297 170.723L66.075 168.597L62.71 166.046L59.7656 163.495L53.8768 157.542L51.9839 155.204L49.4602 152.015L47.357 148.826L45.0436 144.999L42.5198 140.109L40.2063 134.369L38.5238 129.054L37.4722 124.59L36.631 119.7L36 113.322V106.094L36.4207 100.992L37.2619 95.6767L38.5238 90.1492L41.0476 82.4957L43.361 77.3934L45.2539 73.7792L47.988 69.5273L49.6705 66.9761L51.7736 64.2124L53.6665 62.0864L56.4005 58.8975L58.714 56.5589L60.3965 55.0707L63.9719 52.0944L67.5472 49.5432L71.1226 47.2046L75.1185 44.8661L79.7455 42.7401L85.6343 40.6141L88.9993 39.5512L94.8881 38.2756L101.408 37.4252L106.035 37Z',
    ],
  },
};

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(name, className) {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', spec.viewBox ?? '0 0 24 24');
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
    // Every mark is an inline currentColor SVG, Fundable's included, so the whole
    // row shares one muted-grey palette and inks together on hover.
    a.append(svgIcon(icon, 'fx-ico-svg'));
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
  // Leads to the front, stably (API order holds within each group). The list is
  // capped to a scroll region below, so only the first few show without
  // scrolling — the investor who led the round has to be one of them. Neither the
  // API nor the proxy orders them, so it happens here.
  const list = (card.investors ?? [])
    .filter((investor) => investor?.name)
    .sort((a, b) => (b.lead_investor ? 1 : 0) - (a.lead_investor ? 1 : 0));

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

  // Every investor renders, but inside a height-capped scroll region
  // (.fx-investor-list in panel.css) rather than behind a "Show more" button that
  // grew the card. Leads are pulled to the front (above), so the names that
  // matter stay visible without scrolling, and the card never grows past that cap
  // no matter how many investors a company has — a long list (Stripe ships 16)
  // scrolls in place instead of growing the card and pulling the host page.
  const listEl = el('div', 'fx-investor-list');
  for (const investor of list) {
    const row = el('div', 'fx-investor');
    const logo = logoImg('fx-investor-logo', investor.logo, investor.name);
    if (logo) row.append(logo);
    row.append(el('span', 'fx-investor-name', investor.name));
    if (investor.lead_investor) row.append(el('span', 'fx-lead-badge', 'Lead'));
    listEl.append(row);
  }
  wrap.append(listEl);
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

  // The Fundable mark already sits in the panel (popup.html's loading state);
  // clone it so the miss and error states are the same branded card — mark
  // centred over a line of copy — not a bare sentence in a box. Captured before
  // the first show() detaches the original. Under test the fake panel ships no
  // mark, and the guard simply leaves it out.
  const mark = panel.querySelector('.fx-mark');
  const state = (className, message) => {
    const node = el('div', className);
    if (mark) node.append(mark.cloneNode(true));
    node.append(el('p', 'fx-state-text', message));
    return node;
  };

  const [tab] = (await chrome.tabs.query({ active: true, currentWindow: true })) ?? [];
  // The action is enabled on every tab now, not just the https pages the old
  // content script matched. On a chrome:// page, the New Tab page or the Web
  // Store, activeTab grants nothing and there is no URL to read — which is not
  // a company Fundable is "working on adding", it is not a company at all.
  const url = tab?.url ?? '';
  if (!/^https?:\/\//i.test(url)) return show(state('fx-miss', NO_PAGE));

  const init = await send({ type: 'init', url });
  // No answer at all is a transport failure — an extension reload invalidates
  // the context mid-flight and sendMessage rejects. It is not the same as an
  // answer of `null`, which is the resolver saying this page has no company:
  // reporting a broken worker as "we're adding this company" sends the reader
  // away believing a fact that was never checked.
  if (!init) return show(state('fx-error', ERRORS.network));
  // background.js answers a throw in *either* handler with {error}, so init can
  // carry one too. Unchecked it has no `identifier` and falls into the miss line
  // below — the same false claim the guard above exists to prevent.
  if (init.error) return show(state('fx-error', ERRORS[init.error] ?? ERRORS.unavailable));
  // A null identifier is the resolver saying this URL is not a company page — a
  // random site, a search page, or one on the deny list. That is NO_PAGE, not
  // MISS: MISS below promises to add the company, and there is no company here to
  // add. Only a page that resolved and then came back `found:false` earns MISS.
  if (!init.identifier) return show(state('fx-miss', NO_PAGE));

  const res = await send({ type: 'lookup', identifier: init.identifier });
  if (!res) return show(state('fx-error', ERRORS.network));
  if (res.error) return show(state('fx-error', ERRORS[res.error] ?? ERRORS.unavailable));
  if (!res.found) return show(state('fx-miss', MISS));
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

  // The card's own height drives the iframe's, remeasured whenever it changes —
  // in practice once, when the lookup resolves. The investor list scrolls inside
  // a height-capped region rather than growing the card, so expanding it never
  // resizes the frame or pulls the host page.
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
