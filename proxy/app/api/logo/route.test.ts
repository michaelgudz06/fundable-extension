import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

const req = (query: string) => new Request(`https://proxy.test/api/logo?${query}`);

/**
 * Decode the served fallback down to its actual pixel. Parsed from the bytes on the wire rather
 * than compared against the route's own constant — the bug this pins is a base64 string that was
 * trusted because it was labelled transparent, and a self-comparison would pass a green pixel too.
 */
async function fallbackPixel(res: Response) {
  const png = Buffer.from(await res.arrayBuffer());
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let ihdr: Record<string, number> | undefined;
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const length = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + length);
    if (type === 'IHDR')
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') idat.push(data);
    off += 12 + length;
  }
  // colorType 6 = truecolour with alpha, so there is an alpha channel to read at all.
  expect(ihdr).toEqual({ width: 1, height: 1, depth: 8, colorType: 6 });

  const raw = inflateSync(Buffer.concat(idat));
  expect(raw).toHaveLength(5); // filter byte + RGBA
  // On a 1x1 image every PNG filter type reduces to the identity: all predictors read
  // out-of-bounds neighbours, which are defined as zero. So the raw bytes are the pixel.
  const [r, g, b, a] = raw.subarray(1);
  return { r, g, b, a };
}

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/logo', () => {
  it.each([
    ['a malformed domain', 'domain=not a domain'],
    ['a missing domain', ''],
  ])('answers %s with a transparent PNG, without calling the provider', async (_case, query) => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    const res = await GET(req(query));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await fallbackPixel(res)).a).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('answers a provider failure with a transparent PNG instead of an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await fallbackPixel(res)).a).toBe(0);
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

  it('answers a provider timeout with a transparent PNG instead of an error', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await fallbackPixel(res)).a).toBe(0);

    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the PNG when the provider body fails mid-transfer', async () => {
    const truncated = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error('The operation was aborted due to timeout'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(truncated, { headers: { 'content-type': 'image/x-icon' } })),
    );
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await fallbackPixel(res)).a).toBe(0);
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
