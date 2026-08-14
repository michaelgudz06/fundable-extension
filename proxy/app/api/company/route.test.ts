import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const SEARCH_HIT = { success: true, data: { companies: [{ id: 'uuid-1' }] }, meta: { credits_used: 0.1 } };
const SEARCH_MISS = { success: true, data: { companies: [] }, meta: { credits_used: 0.1 } };
const COMPANY = {
  success: true,
  data: { company: { name: 'Wealthsimple', domain: 'wealthsimple.com', latest_deal: { id: 'deal-1' } } },
  meta: { credits_used: 1 },
};
const INVESTORS = {
  success: true,
  data: { investors: [{ name: 'Meritech', lead_investor: true }] },
  meta: { credits_used: 1 },
};

/** Fresh module graph per test, so the in-process cache starts empty. */
async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

function stubUpstream(...responses: [status: number, body: unknown, headers?: Record<string, string>][]) {
  const fetchMock = vi.fn(async () => {
    const [status, body, headers] = responses.shift() ?? [200, SEARCH_MISS];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const req = (query = 'domain=wealthsimple.com', headers: Record<string, string> = {}) =>
  new Request(`https://proxy.test/api/company?${query}`, { headers });

beforeEach(() => {
  process.env.FUNDABLE_API_KEY = 'test-key';
  process.env.FUNDABLE_BASE_URL = 'https://api.test/v1';
  process.env.ALLOWED_EXTENSION_ORIGIN = EXTENSION_ORIGIN;
  delete process.env.KILL_SWITCH;
  delete process.env.RATE_LIMIT_PER_MIN;
  delete process.env.DAILY_CREDIT_LIMIT;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/company', () => {
  it('returns the card contract on a hit and never the raw upstream shape', async () => {
    const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.found).toBe(true);
    expect(Object.keys(body)).toEqual(['found', 'card']);
    expect(Object.keys(body.card).sort()).toEqual(
      ['domain', 'guru_permalink', 'investors', 'ipo_status', 'latest_deal', 'links', 'name', 'region', 'short_description', 'stats', 'website'].sort(),
    );
    expect(body.card.investors).toEqual([{ name: 'Meritech', domain: null, lead_investor: true }]);
    expect(JSON.stringify(body)).not.toContain('test-key');
    expect(JSON.stringify(body)).not.toContain('credits_used');
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('serves a second identical request from cache with zero upstream calls', async () => {
    const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
    const { GET } = await loadRoute();

    const first = await (await GET(req())).json();
    const second = await (await GET(req('domain=https://WWW.wealthsimple.com/invest'))).json();

    expect(second).toEqual(first);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('returns {found:false} on an empty companies array and caches that too', async () => {
    const upstream = stubUpstream([200, SEARCH_MISS]);
    const { GET } = await loadRoute();

    const res = await GET(req('domain=definitely-not-a-startup-xyz.com'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });

    await GET(req('domain=definitely-not-a-startup-xyz.com'));
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('maps upstream 402 to a clean 503 and does not cache it as a miss', async () => {
    const upstream = stubUpstream([402, { error: 'insufficient credits' }], [200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });

    expect((await (await GET(req())).json()).found).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it('maps upstream 429 to 429 and forwards Retry-After', async () => {
    stubUpstream([429, { error: 'slow down' }, { 'retry-after': '17' }]);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  it('maps any other upstream failure to 502 without leaking its body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubUpstream([500, { error: 'boom', key: 'test-key' }]);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });

  it.each(['', 'domain=', 'domain=not a domain', 'domain=..', 'linkedin=a b', 'name=stripe'])(
    'rejects %j with 400 before touching upstream',
    async (query) => {
      const upstream = stubUpstream();
      const { GET } = await loadRoute();

      const res = await GET(req(query));
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('refuses a browser request from an unknown origin', async () => {
    const upstream = stubUpstream();
    const { GET } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com', { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses every origin-bearing request when ALLOWED_EXTENSION_ORIGIN is unset', async () => {
    delete process.env.ALLOWED_EXTENSION_ORIGIN;
    const { GET } = await loadRoute();
    stubUpstream();

    expect((await GET(req('domain=wealthsimple.com', { origin: EXTENSION_ORIGIN }))).status).toBe(403);
  });

  it('echoes the allowed origin back to the extension', async () => {
    stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
    const { GET, OPTIONS } = await loadRoute();

    const res = await GET(req('domain=wealthsimple.com', { origin: EXTENSION_ORIGIN }));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);

    const preflight = await OPTIONS(req('', { origin: EXTENSION_ORIGIN }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
    expect((await OPTIONS(req('', { origin: 'https://evil.example' }))).status).toBe(403);
  });

  it('returns temporarily_unavailable without calling Fundable when the kill switch is on', async () => {
    process.env.KILL_SWITCH = '1';
    const upstream = stubUpstream();
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rate limits per IP', async () => {
    process.env.RATE_LIMIT_PER_MIN = '2';
    stubUpstream([200, SEARCH_MISS], [200, SEARCH_MISS], [200, SEARCH_MISS]);
    const { GET } = await loadRoute();
    const from = (ip: string, domain: string) => GET(req(`domain=${domain}`, { 'x-forwarded-for': `${ip}, 10.0.0.1` }));

    expect((await from('1.1.1.1', 'a-one.com')).status).toBe(200);
    expect((await from('1.1.1.1', 'a-two.com')).status).toBe(200);
    const limited = await from('1.1.1.1', 'a-three.com');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await from('2.2.2.2', 'b-one.com')).status).toBe(200);
  });

  it('returns the error envelope, not a crash, when the cache backend fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    stubUpstream([500, { error: 'redis down' }]);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });
  });

  it('still returns the paid card when the cache write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const fundable = [SEARCH_HIT, COMPANY, INVESTORS];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init: RequestInit) => {
        if (!String(input).startsWith('https://redis.test')) return Response.json(fundable.shift());
        const [cmd] = JSON.parse(init.body as string) as string[];
        if (cmd === 'SET') return new Response('down', { status: 500 });
        return Response.json({ result: cmd === 'GET' ? null : 1 });
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).found).toBe(true);
  });

  it('does not cache an empty company detail as a miss', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const upstream = stubUpstream(
      [200, SEARCH_HIT],
      [200, { success: true, data: {}, meta: { credits_used: 1 } }],
      [200, SEARCH_HIT],
      [200, COMPANY],
      [200, INVESTORS],
    );
    const { GET } = await loadRoute();

    expect((await GET(req())).status).toBe(502);
    expect((await (await GET(req())).json()).found).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(5);
  });

  it('returns the error envelope when an upstream request aborts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const upstream = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    vi.stubGlobal('fetch', upstream);
    const { GET } = await loadRoute();

    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error' });

    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  describe('guard env values', () => {
    it('halts every lookup when DAILY_CREDIT_LIMIT is 0', async () => {
      process.env.DAILY_CREDIT_LIMIT = '0';
      const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      const { GET } = await loadRoute();

      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses every request when RATE_LIMIT_PER_MIN is 0', async () => {
      process.env.RATE_LIMIT_PER_MIN = '0';
      const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      const { GET } = await loadRoute();

      const res = await GET(req('domain=wealthsimple.com', { 'x-forwarded-for': '1.1.1.1' }));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
      expect(upstream).not.toHaveBeenCalled();
    });

    it('uses the default per-minute limit when RATE_LIMIT_PER_MIN is blank', async () => {
      process.env.RATE_LIMIT_PER_MIN = '';
      stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      const { GET } = await loadRoute();

      expect((await GET(req())).status).toBe(200);
    });

    it('uses the default credit ceiling when DAILY_CREDIT_LIMIT is whitespace', async () => {
      process.env.DAILY_CREDIT_LIMIT = '   ';
      stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      const { GET } = await loadRoute();

      expect((await GET(req())).status).toBe(200);
    });

    it('falls back to both defaults when the values are negative', async () => {
      process.env.RATE_LIMIT_PER_MIN = '-5';
      process.env.DAILY_CREDIT_LIMIT = '-1';
      stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      const { GET } = await loadRoute();

      expect((await GET(req())).status).toBe(200);
    });

    it('falls back to 30/min when RATE_LIMIT_PER_MIN is not a number', async () => {
      process.env.RATE_LIMIT_PER_MIN = 'thirty';
      stubUpstream();
      const { GET } = await loadRoute();
      const nth = (n: number) => GET(req(`domain=d${n}.com`, { 'x-forwarded-for': '9.9.9.9' }));

      for (let i = 0; i < 30; i++) expect((await nth(i)).status).toBe(200);
      expect((await nth(30)).status).toBe(429);
    });

    it('falls back to 500 credits when DAILY_CREDIT_LIMIT is not a number', async () => {
      process.env.DAILY_CREDIT_LIMIT = 'five hundred';
      const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
      vi.resetModules();
      const { getCache } = await import('../../../lib/cache');
      const { GET } = await import('./route');
      await getCache().incrByFloat(`credits:${new Date().toISOString().slice(0, 10)}`, 501, 60);

      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  it('stops calling Fundable once the daily credit ceiling is reached', async () => {
    process.env.DAILY_CREDIT_LIMIT = '2';
    const upstream = stubUpstream([200, SEARCH_HIT], [200, COMPANY], [200, INVESTORS]);
    const { GET } = await loadRoute();

    expect((await GET(req('domain=first.com'))).status).toBe(200); // spends 2.1
    const res = await GET(req('domain=second.com'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(upstream).toHaveBeenCalledTimes(3);
  });
});
