# fundable-extension-api

Next.js proxy that holds the Fundable API key server-side and serves trimmed company cards
to the Chrome extension. The key exists only in this app's env — never in extension source,
never in a response.

## Endpoints

### `GET /api/company?domain=|linkedin=|crunchbase=`

Exactly one identifier — if several are sent, the first of `domain`, `linkedin`,
`crunchbase` wins and the rest are ignored. Values are normalized before they reach a cache
key or an upstream URL — a URL, a `www.` prefix, mixed case, a port or a path all collapse
to the same entry, and anything that isn't a valid hostname or slug is a `400`.

Hit — `200`:

```json
{ "found": true,
  "card": {
    "name": "", "domain": "", "website": "", "region": "", "ipo_status": "",
    "guru_permalink": "", "short_description": "",
    "links":   { "website": null, "linkedin": null, "twitter": null,
                 "facebook": null, "crunchbase": null, "pitchbook": null },
    "stats":   { "total_raised": null, "num_funding_rounds": null, "num_investors": null,
                 "num_employees": null, "latest_valuation_usd": null,
                 "latest_valuation_date": null },
    "latest_deal": { "type": null, "pre": false, "extension": false, "date": null,
                     "total_round_raised": null,
                     "financings": [ { "size_native": null, "currency": null } ],
                     "article_url": null },
    "investors": [ { "name": "", "domain": null, "lead_investor": false } ] } }
```

Miss — `200` `{"found": false}`. Fundable answers a miss with `200` and an empty
`data.companies`, not a `404`; both are misses here.

Errors are `{"error": "<code>"}`:

| Status | Code | Cause |
|---|---|---|
| 400 | `bad_request` | missing, unknown, or malformed identifier |
| 403 | `forbidden` | `Origin` present and not `ALLOWED_EXTENSION_ORIGIN` |
| 429 | `rate_limited` | per-IP limit, or upstream `429` (`Retry-After` forwarded) |
| 502 | `upstream_error` | anything else from Fundable, or the whole ladder exceeding its 5s deadline |
| 503 | `temporarily_unavailable` | daily credit ceiling (including when it cannot be counted), or upstream `402` |

`402` and `429` are never cached as misses, so a retry after recovery is a clean lookup. The
optional investors leg is the one failure that still returns `200`: the card is served with
`investors: []` and cached for an hour instead of 24h, so a blip there isn't pinned for a day
either.

### `GET /api/logo?domain=`

Proxies a favicon provider so the panel never hits a third party directly. Always `200`
with an image, so an `<img src>` never breaks: anything short of usable image bytes —
unknown domain, provider failure, non-image content type, empty body — falls back to a 1×1
transparent PNG rather than being passed through. A real logo is cached a week; the
fallback only an hour, so a transient provider failure isn't pinned. No CORS check — it
exposes nothing, and an `<img>` sends no `Origin`.

## Request ladder and cost

1. cache lookup by identifier (24h) — **0 credits**
2. `GET /company/search` — **0.1**; empty `data.companies` ⇒ record the miss, return `{found:false}`
3. `GET /company?id=` — **1**
4. `GET /deals/{id}/investors` when `latest_deal.id` exists — **1 per call**, not per row;
   any failure still bills the credit and keeps the card, cached 1h rather than 24h
5. trim to the card, cache, return

Full card 2.1 credits, miss 0.1, cached repeat 0.

## Environment

Copy `.env.example` to `.env.local` (gitignored) for local dev; set the same names in Vercel
for production.

| Variable | Required | Notes |
|---|---|---|
| `FUNDABLE_API_KEY` | yes | `vg_…`. Never commit it. |
| `FUNDABLE_BASE_URL` | no | defaults to `https://www.tryfundable.ai/api/v1` |
| `ALLOWED_EXTENSION_ORIGIN` | production | the extension's pinned origin, `chrome-extension://<id>`. **Unset means every request carrying an `Origin` header is refused** — set it once the MV3 build pins its ID. Requests with no `Origin` (curl, server-to-server) are allowed. |
| `UPSTASH_REDIS_REST_URL` | no | with the token below, switches the cache to Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | no | |
| `RATE_LIMIT_PER_MIN` | no | per IP, default 30. Blank or unset uses the default. The IP comes from `x-vercel-forwarded-for` / `x-real-ip`, never from the caller-written `x-forwarded-for` |
| `DAILY_CREDIT_LIMIT` | no | **the spend gate.** Default 500; over it, every lookup that would spend returns `temporarily_unavailable`. Blank or unset uses the default. `0` is the emergency stop |

### Stopping spend

`DAILY_CREDIT_LIMIT=0` is the whole brake — there is no separate `KILL_SWITCH`, and there
was never a reason for two levers with the same job and two ways to fail open. Set it to `0`
and no lookup reaches Fundable; cards already cached keep being served, because serving them
costs nothing. Vercel binds env vars per deployment, so a change needs a redeploy to take.

The ceiling reserves the worst-case ladder (2.1) before calling Fundable and settles it
against real spend afterwards, so a concurrent burst cannot all pass the same check, and
credits burned by a ladder that then failed are still billed against the day. If the counter
itself is unreachable the route returns `503` rather than spending money it cannot count —
the only place a cache failure is allowed to cost the caller an answer.

**Cache:** without the two Upstash variables the cache is an in-process `Map`, which does
not survive across serverless invocations — on Vercel that means no caching and a
per-instance rate limit. The daily credit counter is per-instance too, and with the cache
effectively disabled every request costs the full 2.1 credits, so real spend can exceed
`DAILY_CREDIT_LIMIT` by roughly the number of warm instances. Setting both variables is the
whole upgrade; no code change. The coverage-gap `misses` sorted set only exists on Upstash.

## Development

```bash
npm install
npm run dev                     # needs .env.local
npm test                        # unit tests, no network
PROXY=http://localhost:3000 npm run smoke   # live, spends ~4.3 credits
```
