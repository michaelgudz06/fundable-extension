import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache } from './cache';

async function freshMemoryCache(): Promise<Cache> {
  vi.resetModules();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return (await import('./cache')).getCache();
}

afterEach(() => vi.useRealTimers());

describe('memory cache', () => {
  let cache: Cache;
  beforeEach(async () => {
    cache = await freshMemoryCache();
  });

  it('round-trips a value and misses on an unknown key', async () => {
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    expect(await cache.get('other')).toBeNull();
  });

  it('expires a value once its TTL passes', async () => {
    vi.useFakeTimers();
    await cache.set('k', 'v', 60);
    vi.advanceTimersByTime(59_000);
    expect(await cache.get('k')).toBe('v');
    vi.advanceTimersByTime(2_000);
    expect(await cache.get('k')).toBeNull();
  });

  it('keeps live entries when a write sweeps expired ones', async () => {
    vi.useFakeTimers();
    await cache.set('card', 'v', 86_400);
    for (let i = 0; i < 10_001; i++) await cache.set(`rl:${i}`, '1', 120);
    vi.advanceTimersByTime(121_000);
    await cache.set('another', 'v', 86_400);

    expect(await cache.get('card')).toBe('v');
    expect(await cache.get('rl:0')).toBeNull();
  });

  it('accumulates fractional credits', async () => {
    expect(await cache.incrByFloat('credits', 0.1, 60)).toBeCloseTo(0.1);
    expect(await cache.incrByFloat('credits', 2, 60)).toBeCloseTo(2.1);
    expect(Number(await cache.get('credits'))).toBeCloseTo(2.1);
  });
});

describe('upstash cache', () => {
  it('is selected only when both env vars are set, and speaks Redis commands', async () => {
    vi.resetModules();
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    const fetchMock = vi.fn(async () => Response.json({ result: 'cached' }));
    vi.stubGlobal('fetch', fetchMock);

    const cache = (await import('./cache')).getCache();
    expect(await cache.get('company:domain:x')).toBe('cached');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://redis.test');
    expect(JSON.parse(init.body as string)).toEqual(['GET', 'company:domain:x']);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token');

    vi.unstubAllGlobals();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
});
