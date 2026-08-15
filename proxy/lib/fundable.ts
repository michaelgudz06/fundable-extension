// Fundable API client: identifier normalization, the request ladder, and trimming the
// upstream response down to the card contract the extension consumes.
// The API key is read from env here and never leaves this module.

export type IdKind = 'domain' | 'linkedin' | 'crunchbase';

/** A validated identifier: `key` is safe for a cache key, `upstream` is safe for a query param. */
export type Identifier = { kind: IdKind; key: string; upstream: string };

export type Card = {
  name: string;
  domain: string;
  website: string;
  region: string;
  ipo_status: string;
  guru_permalink: string;
  short_description: string;
  links: Record<'website' | 'linkedin' | 'twitter' | 'facebook' | 'crunchbase' | 'pitchbook', string | null>;
  stats: Record<
    | 'total_raised'
    | 'num_funding_rounds'
    | 'num_investors'
    | 'num_employees'
    | 'latest_valuation_usd'
    | 'latest_valuation_date',
    number | string | null
  >;
  latest_deal: {
    type: string | null;
    pre: boolean;
    extension: boolean;
    date: string | null;
    total_round_raised: number | null;
    financings: { size_native: number | null; currency: string | null }[];
    article_url: string | null;
  };
  investors: { name: string; domain: string | null; lead_investor: boolean }[];
};

export class UpstreamError extends Error {
  /** Credits the earlier legs of the ladder already burned before this one failed. */
  credits = 0;
  constructor(readonly status: number, readonly retryAfter?: string) {
    super(`fundable upstream ${status}`);
  }
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Strips scheme/userinfo/port/path and validates, so a crafted value cannot reach a cache key or an upstream URL. */
export function normalizeDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .split('@')
    .pop()!
    .split(':')[0]
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return DOMAIN.test(host) ? host : null;
}

function normalizeSlug(raw: string, path: string): string | null {
  const s = raw.trim().toLowerCase().split(/[?#]/)[0];
  const slug = (s.match(new RegExp(`${path}/([^/]+)`))?.[1] ?? s).replace(/\/+$/, '');
  return SLUG.test(slug) ? slug : null;
}

export function normalizeIdentifier(kind: IdKind, raw: string): Identifier | null {
  if (kind === 'domain') {
    const domain = normalizeDomain(raw);
    return domain ? { kind, key: `domain:${domain}`, upstream: domain } : null;
  }
  const [path, base] =
    kind === 'linkedin'
      ? ['company', 'https://www.linkedin.com/company/']
      : ['organization', 'https://www.crunchbase.com/organization/'];
  const slug = normalizeSlug(raw, path);
  return slug ? { kind, key: `${kind}:${slug}`, upstream: base + slug } : null;
}

// Must stay strictly under the extension's own card timeout (`CARD_TIMEOUT_MS`, 8s) with room
// for the cache round trips either side, or the client always aborts first and the user sees
// "could not reach Fundable" instead of the real cause this route worked out.
const UPSTREAM_TIMEOUT_MS = 5000;

async function call(
  path: string,
  params: Record<string, string>,
  fallbackCredits: number,
  signal: AbortSignal,
) {
  const key = process.env.FUNDABLE_API_KEY;
  if (!key) throw new Error('FUNDABLE_API_KEY is not set');
  const base = (process.env.FUNDABLE_BASE_URL || 'https://www.tryfundable.ai/api/v1').replace(/\/+$/, '');
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw new UpstreamError(res.status, res.headers.get('retry-after') ?? undefined);
  const body = (await res.json()) as { data?: any; meta?: { credits_used?: number } };
  const used = Number(body.meta?.credits_used);
  return { data: body.data ?? {}, credits: Number.isFinite(used) ? used : fallbackCredits };
}

function toCard(c: any, investors: any[]): Card {
  const deal = c.latest_deal ?? {};
  const article = (deal.articles ?? [])[0];
  // /company omits `website` — it only comes back from /company/search, so the caller
  // merges the search row in. Fall back to the domain rather than shipping an empty chip.
  const website = c.website || (c.domain ? `https://${c.domain}` : '');
  return {
    name: c.name ?? '',
    domain: c.domain ?? '',
    website,
    region: c.region ?? '',
    ipo_status: c.ipo_status ?? '',
    guru_permalink: c.guru_permalink ?? '',
    short_description: c.short_description ?? '',
    links: {
      website: website || null,
      linkedin: c.linkedin ?? null,
      twitter: c.twitter ?? null,
      facebook: c.facebook ?? null,
      crunchbase: c.crunchbase ?? null,
      pitchbook: c.pitchbook ?? null,
    },
    stats: {
      total_raised: c.total_raised ?? null,
      num_funding_rounds: c.num_funding_rounds ?? null,
      num_investors: c.num_investors ?? null,
      num_employees: c.num_employees ?? null,
      latest_valuation_usd: c.latest_valuation_usd ?? null,
      latest_valuation_date: c.latest_valuation_date ?? null,
    },
    latest_deal: {
      type: deal.type ?? null,
      pre: deal.pre === true,
      extension: deal.extension === true,
      date: deal.date ?? null,
      total_round_raised: deal.total_round_raised ?? null,
      financings: (deal.financings ?? []).map((f: any) => ({
        size_native: f?.size_native ?? null,
        currency: f?.currency ?? null,
      })),
      article_url: article?.link ?? article?.url ?? null,
    },
    investors: investors.map((i: any) => ({
      name: i?.name ?? '',
      domain: i?.domain ?? null,
      lead_investor: i?.lead_investor === true,
    })),
  };
}

/**
 * search (0.1cr) -> company (1cr) -> investors (1cr). A `200` with no companies, or a `404`
 * on the company lookup, is a genuine miss; a `402`/`429` on either of those two throws and
 * must not be cached as one. The investors leg never throws — see below.
 *
 * Whatever the ladder burned before a throw rides out on `UpstreamError.credits`, so the
 * daily ceiling can bill the failure paths that waste the most money.
 */
export async function fetchCard(id: Identifier): Promise<{ found: boolean; card?: Card; credits: number }> {
  const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let credits = 0;
  try {
    const search = await call('/company/search', { [id.kind]: id.upstream }, 0.1, deadline);
    credits = search.credits;

    const match = search.data.companies?.[0];
    if (!match?.id) return { found: false, credits };

    let company;
    try {
      const res = await call('/company', { id: match.id }, 1, deadline);
      credits += res.credits;
      company = res.data.company;
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return { found: false, credits: credits + 1 };
      throw e;
    }
    if (!company) throw new UpstreamError(502);

    let investors: any[] = [];
    const dealId = company.latest_deal?.id;
    if (dealId) {
      try {
        const res = await call(`/deals/${encodeURIComponent(dealId)}/investors`, {}, 1, deadline);
        credits += res.credits;
        investors = res.data.investors ?? [];
      } catch {
        // The card is already bought and paid for by the two legs above, and one without
        // investors is still usable — so no failure of this optional leg may throw it away.
        // Bill the leg anyway: over-counting is the safe direction for a spend ceiling.
        credits += 1;
      }
    }

    // Search row first: the detail response wins on every shared field but has no `website`.
    return { found: true, card: toCard({ ...match, ...company }, investors), credits };
  } catch (e) {
    if (e instanceof UpstreamError) e.credits = credits;
    throw e;
  }
}
