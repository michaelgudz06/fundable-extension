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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'init') {
    init(msg.url).then(sendResponse);
    return true;
  }
  if (msg?.type === 'lookup') {
    lookup(msg.identifier).then(sendResponse);
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
    .catch(() => '');
  return cssPromise;
}

async function lookup({ kind, value }) {
  let res;
  try {
    res = await fetch(`${PROXY}/api/company?${kind}=${encodeURIComponent(value)}`);
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
  try {
    const res = await fetch(`${PROXY}/api/logo?domain=${encodeURIComponent(domain)}`);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${res.headers.get('content-type') || 'image/png'};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
