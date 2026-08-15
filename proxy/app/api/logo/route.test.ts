import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

const req = (query: string, init?: RequestInit) =>
  new Request(`https://proxy.test/api/logo?${query}`, init);

/**
 * The route's promise: always 200 with an image, served from this origin, so an <img src> never
 * breaks and the panel never follows us to a third party.
 */
function expectRenderableImage(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^image\//);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('location')).toBeNull();
}

/**
 * Decode the served fallback down to its actual pixel. Parsed from the bytes on the wire rather
 * than compared against the route's own constant — the bug this pins is a base64 string that was
 * trusted because it was labelled transparent, and a self-comparison would pass a green pixel too.
 */
async function expectTransparentFallback(res: Response) {
  expectRenderableImage(res);
  expect(res.headers.get('content-type')).toBe('image/png');
  // An hour, not the week a real logo gets: a transient provider failure must not pin the blank.
  expect(res.headers.get('cache-control')).toBe('public, max-age=3600');

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
  expect(raw[4]).toBe(0); // alpha
}

const truncated = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error('The operation was aborted due to timeout'));
    },
  });

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/logo', () => {
  it.each([
    ['a malformed domain', 'domain=not a domain'],
    ['a path-traversal domain', 'domain=..%2Fetc%2Fpasswd'],
    ['a missing domain', ''],
  ])('answers %s with a transparent PNG, without calling the provider', async (_case, query) => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    await expectTransparentFallback(await GET(req(query)));
    expect(upstream).not.toHaveBeenCalled();
  });

  // Every one of these would otherwise reach the panel as a broken-image icon.
  it.each<[string, () => Response]>([
    ['fails', () => new Response('nope', { status: 502 })],
    ['answers HTML', () => new Response('<script>x</script>', { headers: { 'content-type': 'text/html' } })],
    ['sends no content-type', () => new Response(new Uint8Array([1, 2, 3]))],
    ['sends an empty body', () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })],
    ['truncates the body', () => new Response(truncated(), { headers: { 'content-type': 'image/png' } })],
    [
      'throws',
      () => {
        throw new Error('ECONNREFUSED');
      },
    ],
  ])('answers a transparent PNG when the provider %s', async (_case, upstream) => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream()));
    const { GET } = await loadRoute();

    await expectTransparentFallback(await GET(req('domain=wealthsimple.com')));
  });

  it('passes the provider image through, cached a week', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('icon-bytes', { headers: { 'content-type': 'image/x-icon' } })),
    );
    const { GET } = await loadRoute();

    const res = await GET(req('domain=https://WWW.wealthsimple.com/invest'));
    expectRenderableImage(res);
    expect(res.headers.get('content-type')).toBe('image/x-icon');
    expect(res.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
    expect(await res.text()).toBe('icon-bytes');
  });

  it('answers a provider timeout with a transparent PNG instead of an error', async () => {
    const upstream = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    await expectTransparentFallback(await GET(req('domain=wealthsimple.com')));

    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves any Origin — unlike /api/company, there is no CORS check here', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('icon-bytes', { headers: { 'content-type': 'image/x-icon' } })),
    );
    const { GET } = await loadRoute();
    const headers = { origin: 'https://evil.example' };

    const hit = await GET(req('domain=wealthsimple.com', { headers }));
    expectRenderableImage(hit);
    expect(await hit.text()).toBe('icon-bytes');
    expect(hit.headers.get('vary')).toBeNull();

    await expectTransparentFallback(await GET(req('domain=not a domain', { headers })));
  });
});
