import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCard, normalizeIdentifier, UpstreamError } from './fundable';

const COMPANY = {
  id: 'uuid-1',
  name: 'Wealthsimple',
  domain: 'wealthsimple.com',
  region: 'North America',
  ipo_status: 'private',
  guru_permalink: 'wealthsimple',
  short_description: 'Investing for humans.',
  // No `website` key here on purpose — /company genuinely omits it.
  linkedin: 'https://linkedin.com/company/wealthsimple',
  twitter: null,
  crunchbase: 'https://crunchbase.com/organization/wealthsimple',
  pitchbook: null,
  total_raised: 900,
  num_funding_rounds: 9,
  num_investors: 20,
  num_employees: 1200,
  latest_valuation_usd: 5000,
  latest_valuation_date: '2021-05-03',
  latest_deal: {
    id: 'deal-1',
    type: 'series_f',
    pre: false,
    extension: true,
    date: '2021-05-03',
    total_round_raised: 610,
    financings: [{ size_native: 750, currency: 'CAD', junk: 'drop me' }],
    articles: [{ link: 'https://example.com/article' }],
  },
};

type Routes = Record<string, [status: number, body: unknown, headers?: Record<string, string>]>;

/** Routes upstream URLs to canned responses by substring match. */
function stubFetch(routes: Routes) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string) => {
      const url = String(input);
      calls.push(url);
      const match = Object.keys(routes).find((k) => url.includes(k));
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      const [status, body, headers] = routes[match];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    }),
  );
  return calls;
}

const hitRoutes: Routes = {
  '/company/search': [
    200,
    {
      success: true,
      // Live shape: the search row carries `website`, the /company detail does not.
      data: { companies: [{ id: 'uuid-1', website: 'https://www.wealthsimple.com', relevance_score: 0.9 }] },
      meta: { credits_used: 0.1 },
    },
  ],
  '/company?': [200, { success: true, data: { company: COMPANY }, meta: { credits_used: 1 } }],
  '/investors': [
    200,
    {
      success: true,
      data: { investors: [{ name: 'Meritech', domain: 'meritechcapital.com', lead_investor: true }, { name: 'Greylock' }] },
      meta: { credits_used: 1 },
    },
  ],
};

process.env.FUNDABLE_API_KEY = 'test-key';
process.env.FUNDABLE_BASE_URL = 'https://api.test/v1';

afterEach(() => vi.unstubAllGlobals());

describe('normalizeIdentifier', () => {
  it.each([
    ['wealthsimple.com', 'domain:wealthsimple.com'],
    ['WWW.Wealthsimple.COM', 'domain:wealthsimple.com'],
    ['https://www.wealthsimple.com/en-ca/invest?a=1', 'domain:wealthsimple.com'],
    ['http://user:pw@wealthsimple.com:8443/path', 'domain:wealthsimple.com'],
    ['  wealthsimple.com.  ', 'domain:wealthsimple.com'],
    // Traversal and query junk are stripped, not passed through: they cannot reach the key.
    ['evil.com/../../secret', 'domain:evil.com'],
    ['evil.com?id=../admin', 'domain:evil.com'],
    ['evil.com#/../admin', 'domain:evil.com'],
  ])('normalizes domain %s', (raw, key) => {
    expect(normalizeIdentifier('domain', raw)?.key).toBe(key);
  });

  it.each([
    '',
    '   ',
    'localhost',
    'not a domain.com',
    'a..b.com',
    '-lead.com',
    'exa mple.com',
    'company.com\nx',
    `${'a'.repeat(300)}.com`,
    'https://evil.com@fundable.ai/x'.replace('@', '%40'),
  ])('rejects domain %j', (raw) => {
    expect(normalizeIdentifier('domain', raw)).toBeNull();
  });

  it('normalizes linkedin URLs and bare slugs to one canonical value', () => {
    const fromUrl = normalizeIdentifier('linkedin', 'https://www.linkedin.com/company/Stripe/about?x=1');
    expect(fromUrl).toEqual({
      kind: 'linkedin',
      key: 'linkedin:stripe',
      upstream: 'https://www.linkedin.com/company/stripe',
    });
    expect(normalizeIdentifier('linkedin', 'stripe')).toEqual(fromUrl);
  });

  it('normalizes crunchbase URLs', () => {
    expect(normalizeIdentifier('crunchbase', 'https://www.crunchbase.com/organization/stripe')).toEqual({
      kind: 'crunchbase',
      key: 'crunchbase:stripe',
      upstream: 'https://www.crunchbase.com/organization/stripe',
    });
  });

  it.each(['', 'a b', 'slug/with/extra', 'x'.repeat(200), '../../etc/passwd'])(
    'rejects slug %j',
    (raw) => {
      expect(normalizeIdentifier('linkedin', raw)).toBeNull();
    },
  );
});

describe('fetchCard ladder', () => {
  const id = normalizeIdentifier('domain', 'wealthsimple.com')!;

  it('walks search -> company -> investors and bills 2.1 credits', async () => {
    const calls = stubFetch(hitRoutes);
    const result = await fetchCard(id);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe('https://api.test/v1/company/search?domain=wealthsimple.com');
    expect(calls[1]).toBe('https://api.test/v1/company?id=uuid-1');
    expect(calls[2]).toBe('https://api.test/v1/deals/deal-1/investors');
    expect(result.credits).toBeCloseTo(2.1);
    expect(result.found).toBe(true);
  });

  it('trims to the card contract and drops every unlisted upstream field', async () => {
    stubFetch(hitRoutes);
    const { card } = await fetchCard(id);

    expect(card).toEqual({
      name: 'Wealthsimple',
      domain: 'wealthsimple.com',
      website: 'https://www.wealthsimple.com',
      region: 'North America',
      ipo_status: 'private',
      guru_permalink: 'wealthsimple',
      short_description: 'Investing for humans.',
      links: {
        website: 'https://www.wealthsimple.com',
        linkedin: 'https://linkedin.com/company/wealthsimple',
        twitter: null,
        facebook: null,
        crunchbase: 'https://crunchbase.com/organization/wealthsimple',
        pitchbook: null,
      },
      stats: {
        total_raised: 900,
        num_funding_rounds: 9,
        num_investors: 20,
        num_employees: 1200,
        latest_valuation_usd: 5000,
        latest_valuation_date: '2021-05-03',
      },
      latest_deal: {
        type: 'series_f',
        pre: false,
        extension: true,
        date: '2021-05-03',
        total_round_raised: 610,
        financings: [{ size_native: 750, currency: 'CAD' }],
        article_url: 'https://example.com/article',
      },
      investors: [
        { name: 'Meritech', domain: 'meritechcapital.com', lead_investor: true },
        { name: 'Greylock', domain: null, lead_investor: false },
      ],
    });
    expect(JSON.stringify(card)).not.toContain('uuid-1');
    expect(JSON.stringify(card)).not.toContain('drop me');
    expect(JSON.stringify(card)).not.toContain('relevance_score');
  });

  it('falls back to the domain when neither response carries a website', async () => {
    stubFetch({ ...hitRoutes, '/company/search': [200, { data: { companies: [{ id: 'uuid-1' }] } }] });
    const { card } = await fetchCard(id);
    expect(card!.website).toBe('https://wealthsimple.com');
    expect(card!.links.website).toBe('https://wealthsimple.com');
  });

  it('treats 200 with an empty companies array as a miss costing 0.1 credits', async () => {
    const calls = stubFetch({
      '/company/search': [200, { success: true, data: { companies: [] }, meta: { credits_used: 0.1 } }],
    });
    expect(await fetchCard(id)).toEqual({ found: false, credits: 0.1 });
    expect(calls).toHaveLength(1);
  });

  it('treats 404 on the company lookup as a miss', async () => {
    stubFetch({ ...hitRoutes, '/company?': [404, { error: 'COMPANY_NOT_FOUND' }] });
    expect(await fetchCard(id)).toEqual({ found: false, credits: 1.1 });
  });

  // The company legs are paid for by the time this one runs, so no status may discard the
  // card. 404 was always tolerated; 402/429/500 used to rethrow and throw the card away.
  it.each([404, 402, 429, 500])('still returns a card when the investor call %is', async (status) => {
    stubFetch({ ...hitRoutes, '/investors': [status, { error: 'nope' }, { 'retry-after': '12' }] });
    const result = await fetchCard(id);
    expect(result.found).toBe(true);
    expect(result.card!.name).toBe(COMPANY.name);
    expect(result.card!.investors).toEqual([]);
    expect(result.credits).toBeCloseTo(2.1);
  });

  it('still returns a card when the investor call fails outside the upstream contract', async () => {
    // No `/investors` route: the stub throws a plain Error, standing in for an abort.
    stubFetch({ '/company/search': hitRoutes['/company/search'], '/company?': hitRoutes['/company?'] });
    const result = await fetchCard(id);
    expect(result.found).toBe(true);
    expect(result.card!.investors).toEqual([]);
  });

  // Without this the daily ceiling is blind to the failure paths that waste the most money.
  it.each([
    ['/company/search', 0],
    ['/company?', 0.1],
  ])('carries the credits already burned when %s throws', async (route, burned) => {
    stubFetch({ ...hitRoutes, [route]: [500, { error: 'boom' }] });
    const err = await fetchCard(id).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.credits).toBeCloseTo(burned);
  });

  it('carries the credits already burned when the detail body has no company', async () => {
    stubFetch({ ...hitRoutes, '/company?': [200, { success: true, data: {}, meta: { credits_used: 1 } }] });
    const err = await fetchCard(id).catch((e) => e);
    expect(err.credits).toBeCloseTo(1.1);
  });

  it.each([402, 429, 500])('throws UpstreamError on %i rather than reporting a miss', async (status) => {
    stubFetch({ '/company/search': [status, { error: 'nope' }, { 'retry-after': '12' }] });
    const err = await fetchCard(id).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(status);
    expect(err.retryAfter).toBe('12');
  });

  it('treats a 200 detail body with no company as an upstream error, not a miss', async () => {
    stubFetch({ ...hitRoutes, '/company?': [200, { success: true, data: {}, meta: { credits_used: 1 } }] });
    const err = await fetchCard(id).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(502);
  });

  it('spends one deadline across the whole ladder, not one per call', async () => {
    stubFetch(hitRoutes);
    await fetchCard(id);

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [unknown, RequestInit][];
    const signals = calls.map(([, init]) => init.signal);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(new Set(signals).size).toBe(1);
  });

  it('falls back to documented per-call costs when meta.credits_used is missing', async () => {
    stubFetch({
      '/company/search': [200, { data: { companies: [{ id: 'uuid-1' }] } }],
      '/company?': [200, { data: { company: { ...COMPANY, latest_deal: null } } }],
    });
    expect((await fetchCard(id)).credits).toBeCloseTo(1.1);
  });

  it('sends the API key as a bearer token and nothing else', async () => {
    stubFetch(hitRoutes);
    await fetchCard(id);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers).toEqual({ authorization: 'Bearer test-key' });
  });
});
