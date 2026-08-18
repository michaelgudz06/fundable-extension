// inject.js — injected into the active tab by background.js when the toolbar icon
// is clicked (chrome.scripting.executeScript under activeTab, so only this tab and
// only on click; there is no declared content_scripts and no always-on presence).
//
// This does NO network. It mounts a transparent iframe that renders popup.html —
// an extension page, cross-origin to the host, so the card's DOM and the data in
// it are never exposed to the page. Every fetch still happens in background.js.
//
// It runs in the extension's isolated world, and re-running it (each click)
// toggles the overlay off if it is already open. An IIFE keeps it re-runnable:
// top-level `const`s would throw "already declared" on the second run in the same
// isolated world.
(() => {
  const HOST_ID = 'fundable-overlay-host';

  const open = document.getElementById(HOST_ID);
  if (open) {
    open.remove(); // toggle off
    return;
  }

  const frame = document.createElement('iframe');
  frame.id = HOST_ID;
  frame.src = chrome.runtime.getURL('popup.html');
  // Transparent, borderless, pinned top-right, above everything. The card inside
  // carries its own rounded corners and shadow; the iframe just gives it a
  // transparent stage. `color-scheme: normal` stops a dark host page from
  // inverting the frame. Height is a placeholder until the card reports its own.
  frame.setAttribute(
    'style',
    [
      'position: fixed',
      'top: 16px',
      'right: 16px',
      'width: 380px',
      'height: 540px',
      'max-width: calc(100vw - 32px)',
      'max-height: calc(100vh - 32px)',
      'border: 0',
      'background: transparent',
      'color-scheme: normal',
      'z-index: 2147483647',
    ].join(';'),
  );
  (document.body || document.documentElement).appendChild(frame);

  // One page-lifetime listener, wired once per isolated world. It looks the frame
  // up by id rather than closing over it, so it survives toggles and never needs
  // removing. `e.source !== frame.contentWindow` rejects anything not sent by our
  // own iframe — the host page cannot forge the source, so it cannot drive this.
  if (!window.__fundableOverlayWired) {
    window.__fundableOverlayWired = true;
    window.addEventListener('message', (e) => {
      const host = document.getElementById(HOST_ID);
      if (!host || e.source !== host.contentWindow) return;
      const data = e.data;
      if (data === 'fundable-close') {
        host.remove();
      } else if (data && data.type === 'fundable-size') {
        // Clamp: a compromised frame (or a bug) must not size the iframe to cover
        // the whole page. 540 default, 820 ceiling — taller than a Chrome popup,
        // still bounded.
        const h = Math.min(Math.max(Number(data.height) || 0, 0), 820);
        if (h) host.style.height = h + 'px';
      }
    });
  }
})();
