import { getCache } from '../../../lib/cache';
import { fetchCard, normalizeIdentifier, UpstreamError, type IdKind } from '../../../lib/fundable';

const KINDS: IdKind[] = ['domain', 'linkedin', 'crunchbase'];
const CARD_TTL = 86400; // 24h, hits and misses alike

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

  if (process.env.KILL_SWITCH === '1') return json({ error: 'temporarily_unavailable' }, 503, cors);

  const params = new URL(req.url).searchParams;
  const kind = KINDS.find((k) => params.has(k));
  const id = kind && normalizeIdentifier(kind, params.get(kind)!);
  if (!id) return json({ error: 'bad_request' }, 400, cors);

  const cache = getCache();

  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const rateEnv = Number(process.env.RATE_LIMIT_PER_MIN?.trim() || NaN);
    const perMinute = Number.isFinite(rateEnv) && rateEnv >= 0 ? rateEnv : 30;
    const hits = await cache.incrByFloat(`rl:${ip}:${Math.floor(Date.now() / 60000)}`, 1, 120);
    if (hits > perMinute) return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': '60' });

    const cached = await cache.get(`company:${id.key}`);
    if (cached) return json(JSON.parse(cached), 200, cors);

    const creditKey = `credits:${new Date().toISOString().slice(0, 10)}`;
    const limitEnv = Number(process.env.DAILY_CREDIT_LIMIT?.trim() || NaN);
    const dailyLimit = Number.isFinite(limitEnv) && limitEnv >= 0 ? limitEnv : 500;
    if (Number((await cache.get(creditKey)) ?? 0) >= dailyLimit) {
      return json({ error: 'temporarily_unavailable' }, 503, cors);
    }

    const { found, card, credits } = await fetchCard(id);
    const payload = found ? { found: true, card } : { found: false };

    // Fundable has already billed for this card, so bookkeeping must never cost the caller
    // the answer: a failed write degrades to "not cached", not to an error.
    try {
      await cache.incrByFloat(creditKey, credits, 172800);
      if (!found) await cache.recordMiss(id.key);
      await cache.set(`company:${id.key}`, JSON.stringify(payload), CARD_TTL);
    } catch (e) {
      console.error('cache write failed', e instanceof Error ? e.message : e);
    }
    return json(payload, 200, cors);
  } catch (e) {
    if (e instanceof UpstreamError) {
      // 402/429 are not misses — never cached, so a retry after recovery is a clean lookup.
      if (e.status === 402) return json({ error: 'temporarily_unavailable' }, 503, cors);
      if (e.status === 429) {
        return json({ error: 'rate_limited' }, 429, { ...cors, 'retry-after': e.retryAfter ?? '60' });
      }
    }
    console.error('company lookup failed', e instanceof Error ? e.message : e);
    return json({ error: 'upstream_error' }, 502, cors);
  }
}
