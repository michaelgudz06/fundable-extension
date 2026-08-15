#!/usr/bin/env node
// Live smoke test — the three verification calls from the spec, against a running proxy.
//
//   PROXY=http://localhost:3000 node scripts/smoke.mjs
//
// The proxy needs FUNDABLE_API_KEY in its own env (proxy/.env.local for `npm run dev`).
// This script never reads or prints the key. It spends real credits: ~4.3 per full run.

const proxy = (process.env.PROXY || 'http://localhost:3000').replace(/\/+$/, '');

const cases = [
  { query: 'domain=wealthsimple.com', expect: 'found' },
  { query: 'domain=definitely-not-a-startup-xyz.com', expect: 'miss' },
  { query: 'linkedin=https://linkedin.com/company/stripe', expect: 'found' },
];

let failed = 0;

for (const { query, expect } of cases) {
  const res = await fetch(`${proxy}/api/company?${query}`);
  const body = await res.json();
  const ok =
    res.status === 200 &&
    (expect === 'miss'
      ? body.found === false
      : body.found === true &&
        !!body.card?.name &&
        !!body.card?.website &&
        !!body.card?.guru_permalink &&
        Array.isArray(body.card?.investors));

  console.log(`${ok ? 'ok  ' : 'FAIL'} ${query} -> ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  if (!ok) failed++;
}

const logo = await fetch(`${proxy}/api/logo?domain=wealthsimple.com`);
const logoOk = logo.status === 200 && (logo.headers.get('content-type') || '').startsWith('image/');
console.log(`${logoOk ? 'ok  ' : 'FAIL'} /api/logo -> ${logo.status} ${logo.headers.get('content-type')}`);
if (!logoOk) failed++;

process.exit(failed ? 1 : 0);
