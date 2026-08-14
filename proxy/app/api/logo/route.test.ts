import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

const req = (query: string) => new Request(`https://proxy.test/api/logo?${query}`);

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/logo', () => {
  it('answers a malformed domain with a PNG instead of an error', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    const res = await GET(req('domain=not a domain'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers a provider failure with a PNG instead of an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('passes the provider image through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('icon-bytes', { headers: { 'content-type': 'image/x-icon' } })),
    );
    const { GET } = await loadRoute();

    const res = await GET(req('domain=https://WWW.wealthsimple.com/invest'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/x-icon');
    expect(await res.text()).toBe('icon-bytes');
  });

  it('does not serve a non-image content-type from the proxy origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<script>x</script>', { headers: { 'content-type': 'text/html' } })),
    );
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com'));
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
