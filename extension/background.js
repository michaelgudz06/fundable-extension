// The service worker owns every network call in this extension.
//
// popup.js fetches nothing — not card data, not logos. It asks here instead.
// The worker is also the only place the proxy origin appears, so there is one
// place to change it and one place `host_permissions` has to match.
//
// See test/extension.test.js for the guard that enforces this.

import { resolveIdentifier } from './resolver.js';

const PROXY = 'https://fundable-extension-api.vercel.app';

// Nothing in here may hang: `lookup` awaits the decorative logos before it
// answers, so one stalled connection would leave the popup on "Loading…" until
// Chrome tears the worker down and the port closes under it.
const CARD_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 4000;

// Returning true keeps sendResponse alive across the await, which makes an
// unanswered message indistinguishable from a hang: the popup sits on "Loading…"
// until Chrome tears the worker down. resolver.js and the proxy are
// separate moving parts, so a throw from either is a live possibility.
const respond = (work, sendResponse) =>
  work.then(sendResponse, () => sendResponse({ error: 'unavailable' }));

// A click both mounts the overlay and warms its card. The slow part of an open is
// the proxy round-trip; onClicked already has the tab's URL, so start the lookup
// now — in parallel with the iframe booting — and let the popup's `lookup` message
// consume the in-flight result instead of opening a second round-trip. This runs
// only on the click that already grants activeTab, never on page load, so it adds
// no per-page traffic or credit spend — it just moves the same one lookup earlier.
// ponytail: 60s per-tab TTL; a close-click after it expires re-warms once (cheap,
// the proxy caches cards 24h). Keyed by tab AND identifier so a tab that navigated
// to another company after the click is never handed the previous card.
const PREFETCH_TTL_MS = 60_000;
const prefetches = new Map(); // tabId -> { key, promise }

function warm(tab) {
  const id = resolveIdentifier(tab.url);
  if (!id) return;
  const key = `${id.kind}:${id.value}`;
  if (prefetches.get(tab.id)?.key === key) return; // already warming this company
  const entry = { key, promise: lookup(id).catch(() => ({ error: 'unavailable' })) };
  prefetches.set(tab.id, entry);
  const timer = setTimeout(() => {
    if (prefetches.get(tab.id) === entry) prefetches.delete(tab.id);
  }, PREFETCH_TTL_MS);
  timer.unref?.(); // node holds the process open for a pending timer; a worker has no unref
}

// Clicking the toolbar icon toggles the overlay on the active tab. There is no
// default_popup, so onClicked fires. activeTab (granted by the click) is what lets
// executeScript reach just this tab with no broad host permission; inject.js does
// no network — it only mounts the transparent iframe that renders popup.html.
chrome.action.onClicked.addListener((tab) => {
  // executeScript throws on chrome://, the Web Store, the New Tab page and other
  // restricted URLs. There is no company on those anyway, so skip them quietly
  // rather than surfacing an error the user cannot act on.
  if (!tab.id || !/^https?:\/\//i.test(tab.url ?? '')) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['inject.js'] }).catch(() => {});
  warm(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Today this is redundant: onMessage never fires for web pages or other
  // extensions (those need onMessageExternal, which is deliberately absent) and
  // there are no content scripts. It is here so that adding either later does
  // not silently turn the worker into an open lookup service for any caller.
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'init') {
    respond(init(msg.url), sendResponse);
    return true;
  }
  if (msg?.type === 'lookup') {
    // Serve the click-time prefetch when it is for this tab and still the same
    // company; otherwise (a different tab, a navigation, an expired warm) look it
    // up fresh. sender.tab is the host tab the overlay iframe lives in.
    const key = `${msg.identifier.kind}:${msg.identifier.value}`;
    const warmed = prefetches.get(sender.tab?.id);
    respond(warmed?.key === key ? warmed.promise : lookup(msg.identifier), sendResponse);
    return true;
  }
});

async function init(url) {
  return { identifier: resolveIdentifier(url) };
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
  let body;
  try {
    body = await res.json();
  } catch {
    // No parseable body — the one case where the status is all we know.
    return { error: 'unavailable' };
  }
  // A non-ok status still carries the proxy's {error} code. Pass it through:
  // collapsing a timeout (502 upstream_error), a spend ceiling (503) and a
  // rate-limit (429) into one "unavailable" sentence is why the last report
  // couldn't be diagnosed, and why a transient timeout gave no hint to retry.
  if (!res.ok) return { error: body?.error ?? 'unavailable' };
  if (!body || body.found === false) return { found: false };

  // The proxy may hand back a bare card or a {card} envelope; accept either.
  const card = body.card ?? body;
  if (!card.name) return { found: false };

  await attachLogos(card);
  return { found: true, card };
}

// Logos are fetched here and handed over as data URLs the popup can drop
// straight into an <img>, so the proxy is never named in the popup's markup.
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
