# fundable-extension-api

Next.js proxy that holds the Fundable API key server-side and serves trimmed company cards
to the Chrome extension. The key exists only in this app's env — never in extension source,
never in a response.

## Endpoints

### `GET /api/company?domain=|linkedin=|crunchbase=`

Exactly one identifier. Values are normalized before they reach a cache key or an upstream
URL — a URL, a `www.` prefix, mixed case, a port or a path all collapse to the same entry,
and anything that isn't a valid hostname or slug is a `400`.

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
| 502 | `upstream_error` | anything else from Fundable |
| 503 | `temporarily_unavailable` | kill switch, daily credit ceiling, or upstream `402` |

`402` and `429` are never cached as misses, so a retry after recovery is a clean lookup.

### `GET /api/logo?domain=`

Proxies a favicon provider so the panel never hits a third party directly. Always `200`
with an image (a 1×1 transparent PNG when the domain is unknown or the provider fails), so
an `<img src>` never breaks. Cached a week. No CORS check — it exposes nothing, and an
`<img>` sends no `Origin`.

## Request ladder and cost

1. cache lookup by identifier (24h) — **0 credits**
2. `GET /company/search` — **0.1**; empty `data.companies` ⇒ record the miss, return `{found:false}`
3. `GET /company?id=` — **1**
4. `GET /deals/{id}/investors` when `latest_deal.id` exists — **1 per call**, not per row
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
| `RATE_LIMIT_PER_MIN` | no | per IP, default 30 |
| `DAILY_CREDIT_LIMIT` | no | default 500; over it, every lookup returns `temporarily_unavailable` |
| `KILL_SWITCH` | no | `1` makes every lookup return `temporarily_unavailable` without calling Fundable |

**Cache:** without the two Upstash variables the cache is an in-process `Map`, which does
not survive across serverless invocations — on Vercel that means no caching and a
per-instance rate limit. Setting both variables is the whole upgrade; no code change. The
coverage-gap `misses` sorted set only exists on Upstash.

## Development

```bash
npm install
npm run dev                     # needs .env.local
npm test                        # unit tests, no network
PROXY=http://localhost:3000 npm run smoke   # live, spends ~4.3 credits
```
