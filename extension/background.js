// The service worker owns every network call in this extension.
//
// This is the whole point of the architecture: requests issued from a content
// script show up in the inspected page's DevTools Network tab, requests issued
// from a service worker do not. So content.js never fetches anything — not card
// data, not logos, not the panel stylesheet. It asks here instead.
//
// See test/extension.test.js for the guard that enforces this.

import { resolveIdentifier } from './resolver.js';

const PROXY = 'https://fundable-extension-api.vercel.app';

// Nothing in here may hang: `lookup` awaits the decorative logos before it
// answers, so one stalled connection would leave the panel on "Loading…" until
// Chrome tears the worker down and the port closes under it.
const CARD_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 4000;

// PP Mori is hotlinked from Fundable's own CDN rather than bundled: the font is
// licensed to Fundable, not to this extension. Two weights exist, 400 and 600.
//
// The hashed filenames rotate on every Fundable deploy. When they go stale the
// fetch 404s, the panel keeps its Helvetica/Arial fallback, and nothing else
// changes — which is why none of this is allowed to throw. Refresh them with:
//
//   curl -s https://www.tryfundable.ai | grep -oE '/_next/static/css/[^"]+\.css'
//   curl -s https://www.tryfundable.ai/_next/static/css/<hash>.css | grep -o '@font-face{[^}]*otf[^}]*}'
//
// No host_permissions entry is needed for this origin: Vercel serves
// /_next/static with `access-control-allow-origin: *`.
const FONTS = [
  { weight: 400, url: 'https://www.tryfundable.ai/_next/static/media/8f65835aa057b6ed-s.p.otf' },
  { weight: 600, url: 'https://www.tryfundable.ai/_next/static/media/cb07cb684de218c2-s.p.otf' },
];

// Returning true keeps sendResponse alive across the await, which makes an
// unanswered message indistinguishable from a hang: the panel sits on "Loading…"
// until Chrome tears the worker down. resolver.js and the proxy are other
// crewmates' work, so a throw from either is a live possibility.
const respond = (work, sendResponse) =>
  work.then(sendResponse, () => sendResponse({ error: 'unavailable' }));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'init') {
    respond(init(msg.url), sendResponse);
    return true;
  }
  if (msg?.type === 'lookup') {
    respond(lookup(msg.identifier), sendResponse);
    return true;
  }
  if (msg?.type === 'fonts') {
    respond(fonts(), sendResponse);
    return true;
  }
});

// The content script has no way to read a packaged file without fetching, so it
// gets the identifier verdict and the panel stylesheet in one round trip.
async function init(url) {
  return { identifier: resolveIdentifier(url), css: await panelCss() };
}

let cssPromise;
function panelCss() {
  cssPromise ??= fetch(chrome.runtime.getURL('panel.css'))
    .then((r) => r.text())
    .then(sanitizeCss)
    .catch(() => '');
  return cssPromise;
}

// A stylesheet injected into the panel's shadow root is still a page stylesheet:
// the page fetches whatever it references, and that request lands in the
// inspected page's Network tab. panel.css belongs to another crewmate, so the
// rule is enforced here, at the boundary where the stylesheet enters the
// extension.
//
// One pattern covers every shape a reference can hide in, because enumerating
// the properties that can carry one (background, mask, border-image, cursor,
// list-style, …) is how this class of bug survives. In order: a comment, matched
// only so it is consumed, since nothing inside one is ever fetched; an @import,
// which always is; the url() construct; and a bare quoted URL, which is how
// image-set() — and whatever ships next — carries a reference with no url()
// token at all. Every branch runs to its own closing quote, so a data: URI is
// consumed whole wherever it sits and the quotes inside it — an inline SVG
// carries xmlns='http://www.w3.org/2000/svg' — are never read as references of
// their own.
//
// What survives is an allowlist rather than a list of dangerous schemes: a data:
// URI carries its own bytes, and a bare #fragment names a node in the tree it is
// already in. Everything else is a request — a relative icon.png resolves
// against the HOST page, //cdn is whatever scheme the page loaded under — so it
// is stripped and named in a warning, and the survivor warning below stays as
// the backstop for a construct this pattern does not know. A quoted string with
// no scheme is the one shape left unclassified: nothing can tell it from a
// content: string without parsing the CSS.
//
// test/extension.test.js checks panel.css through these same exports rather than
// its own copy: the two drifted into the identical blind spot twice.
const CSS_REFERENCE =
  /\/\*[\s\S]*?\*\/|(@import\b[^;]*;?)|url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]*))\s*\)|"((?:[a-z][a-z0-9+.-]*:[^\s"]|\/\/)[^"]*)"|'((?:[a-z][a-z0-9+.-]*:[^\s']|\/\/)[^']*)'/gi;

const target = (m) => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6])?.trim();

export const FETCHES_NOTHING = /^(?:data:|#)/i;

export const cssReferences = (css) =>
  [...css.matchAll(CSS_REFERENCE)].map(target).filter((ref) => ref !== undefined);

const REMOTE_LEFTOVER = /https?:\/\/[^\s'")]+/gi;

export function sanitizeCss(css) {
  const stripped = [];
  const drop = (token) => (stripped.push(token.trim()), '');
  const safe = css.replace(CSS_REFERENCE, (...m) => {
    const ref = target(m);
    return ref === undefined || FETCHES_NOTHING.test(ref) ? m[0] : drop(m[0]);
  });

  if (stripped.length) {
    console.warn(
      `[fundable] stripped page-visible reference(s) from panel.css: ${stripped.join(', ')}`,
    );
  }
  const survivors = safe.replace(CSS_REFERENCE, '').match(REMOTE_LEFTOVER);
  if (survivors) {
    console.warn(
      `[fundable] panel.css still references ${survivors.join(', ')} after sanitising; ` +
        'if the page fetches it, that request shows up in the inspected page\'s Network tab',
    );
  }
  return safe;
}

async function lookup({ kind, value }) {
  let res;
  try {
    res = await fetch(`${PROXY}/api/company?${kind}=${encodeURIComponent(value)}`, {
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    });
  } catch {
    return { error: 'network' };
  }
  if (res.status === 429) return { error: 'rate_limited' };
  if (!res.ok) return { error: 'unavailable' };

  let body;
  try {
    body = await res.json();
  } catch {
    return { error: 'unavailable' };
  }
  if (!body || body.found === false) return { found: false };

  // The proxy may hand back a bare card or a {card} envelope; accept either.
  const card = body.card ?? body;
  if (!card.name) return { found: false };

  await attachLogos(card);
  return { found: true, card };
}

// Logos are the easy place to leak a page-visible request, so they are fetched
// here and handed over as data URLs the panel can drop straight into an <img>.
async function attachLogos(card) {
  const investors = card.investors ?? [];
  const [logo, ...investorLogos] = await Promise.all([
    logoFor(card.domain),
    ...investors.map((i) => logoFor(i.domain)),
  ]);
  card.logo = logo;
  investors.forEach((investor, i) => {
    investor.logo = investorLogos[i];
  });
}

async function logoFor(domain) {
  if (!domain) return null;
  const asset = await fetchBase64(`${PROXY}/api/logo?domain=${encodeURIComponent(domain)}`);
  return asset && `data:${asset.type || 'image/png'};base64,${asset.base64}`;
}

// The font files are fetched here for the same reason the logos are: an
// @font-face inside a shadow root is ignored, and registering one on the
// document would make the page fetch the file where DevTools can see it. The
// content script gets bytes and builds a FontFace that loads no URL at all.
let fontsPromise;
function fonts() {
  fontsPromise ??= Promise.all(
    FONTS.map(async (font) => {
      const asset = await fetchBase64(font.url);
      return asset && { weight: font.weight, base64: asset.base64 };
    }),
  ).then((faces) => faces.filter(Boolean));
  return fontsPromise;
}

async function fetchBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { base64: btoa(binary), type: res.headers.get('content-type') };
  } catch {
    return null;
  }
}
