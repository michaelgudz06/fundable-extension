import { getCache } from '../../../lib/cache';
import { fetchCard, normalizeIdentifier, UpstreamError, type IdKind } from '../../../lib/fundable';

const KINDS: IdKind[] = ['domain', 'linkedin', 'crunchbase'];
const CARD_TTL = 86400; // 24h, hits and misses alike
// A card whose investors leg failed is short a section the next lookup could fill, so it
// gets the hour the logo route gives its fallback rather than being pinned for a day.
const DEGRADED_CARD_TTL = 3600;
const CREDIT_TTL = 172800;
const RESERVE = 2.1; // the priciest ladder: search 0.1 + company 1 + investors 1

function corsHeaders(req: Request): Record<string, string> | null {
  const origin = req.headers.get('origin');
  if (!origin) return {}; // no browser to protect (curl, server-to-server)
  const allowed = process.env.ALLOWED_EXTENSION_ORIGIN;
  if (!allowed || origin !== allowed) return null;
  return { 'access-control-allow-origin': allowed, vary: 'origin' };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export async function OPTIONS(req: Request) {
  const cors = corsHeaders(req);
  if (!cors) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' },
  });
}

export async function GET(req: Request) {
  const cors = corsHeaders(req);
  if (!cors) return json({ error: 'forbidden' }, 403, {});

  const params = new URL(req.url).searchParams;
  const kind = KINDS.find((k) => params.has(k));
  const id = kind && normalizeIdentifier(kind, params.get(kind)!);
  if (!id) return json({ error: 'bad_request' }, 400, cors);

  const cache = getCache();
  const creditKey = `credits:${new Date().toISOString().slice(0, 10)}`;
  let reserved = 0;
  let spent = RESERVE; // assume the worst until a leg tells us what it actually burned

  try {
    // Platform-set headers only. `x-forwarded-for` is written by the caller, so its leftmost
    // entry buys a fresh bucket per request and the limit stops existing.
    const ip =
      req.headers.get('x-vercel-forwarded-for')?.trim() || req.headers.get('x-real-ip')?.trim() || 'unknown';
    const rateEnv = Number(process.env.RATE_LIMIT_PER_MIN?.trim() || NaN);
    const perMinute = Number.isFinite(rateEnv) && rateEnv >= 0 ? rateEnv : 30;
    // The limiter and the card cache are optimisations: when the backing store blips they
    // degrade to a slower correct answer, never to an outage.
    const hits = await cache.incrByFloat(`rl:${ip}:${Math.floor(Date.now() / 60000)}`, 1, 120).catch(() => 0);
    if (hits > perMinute) return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': '60' });

    const cached = await cache.get(`company:${id.key}`).catch(() => null);
    if (cached) return json(JSON.parse(cached), 200, cors);

    const limitEnv = Number(process.env.DAILY_CREDIT_LIMIT?.trim() || NaN);
    const dailyLimit = Number.isFinite(limitEnv) && limitEnv >= 0 ? limitEnv : 500;
    // The one spend gate: `DAILY_CREDIT_LIMIT=0` is the hard stop. Reserve the worst-case
    // ladder first and check what the reservation displaced, so a concurrent burst gets
    // distinct totals — reading then writing let every request in the burst pass at once.
    // Unlike the two calls above this one degrades *closed*: spend we cannot count is the
    // single failure the ceiling exists to prevent.
    reserved = await cache.incrByFloat(creditKey, RESERVE, CREDIT_TTL).catch(() => Infinity);
    if (reserved - RESERVE >= dailyLimit) {
      spent = 0;
      return json({ error: 'temporarily_unavailable' }, 503, cors);
    }

    const { found, card, credits, degraded } = await fetchCard(id);
    spent = credits;
    const payload = found ? { found: true, card } : { found: false };

    // Fundable has already billed for this card, so bookkeeping must never cost the caller
    // the answer: a failed write degrades to "not cached", not to an error.
    try {
      if (!found) await cache.recordMiss(id.key);
      await cache.set(
        `company:${id.key}`,
        JSON.stringify(payload),
        degraded ? DEGRADED_CARD_TTL : CARD_TTL,
      );
    } catch (e) {
      console.error('cache write failed', e instanceof Error ? e.message : e);
    }
    return json(payload, 200, cors);
  } catch (e) {
    if (e instanceof UpstreamError) {
      spent = e.credits; // what the earlier legs burned before this one threw
      // 402/429 are not misses — never cached, so a retry after recovery is a clean lookup.
      if (e.status === 402) return json({ error: 'temporarily_unavailable' }, 503, cors);
      if (e.status === 429) {
        return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': e.retryAfter ?? '60' });
      }
    }
    console.error('company lookup failed', e instanceof Error ? e.message : e);
    return json({ error: 'upstream_error' }, 502, cors);
  } finally {
    // Settle the reservation against what the ladder really burned — on the failure paths
    // too, or the ceiling under-reports exactly where the money goes. An error we cannot
    // price keeps the full reservation.
    if (Number.isFinite(reserved) && spent !== RESERVE) {
      await cache
        .incrByFloat(creditKey, spent - RESERVE, CREDIT_TTL)
        .catch((e) => console.error('credit reconcile failed', e instanceof Error ? e.message : e));
    }
  }
}
