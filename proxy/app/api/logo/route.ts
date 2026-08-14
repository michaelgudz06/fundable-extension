import { normalizeDomain } from '../../../lib/fundable';

// Fundable has no logo field, so logos come from a favicon provider. Proxied here so the
// panel never talks to a third party directly. No CORS check: this exposes nothing, and an
// <img src> sends no Origin anyway.

const BLANK = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** 1x1 transparent PNG — renders as empty rather than as a broken image. */
function blank() {
  return new Response(BLANK, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function GET(req: Request) {
  const domain = normalizeDomain(new URL(req.url).searchParams.get('domain') ?? '');
  if (!domain) return blank();

  try {
    const res = await fetch(`https://www.google.com/s2/favicons?sz=128&domain=${domain}`);
    if (!res.ok) return blank();
    const type = res.headers.get('content-type');
    return new Response(res.body, {
      headers: {
        'content-type': type?.startsWith('image/') ? type : 'image/png',
        'cache-control': 'public, max-age=604800, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return blank();
  }
}
