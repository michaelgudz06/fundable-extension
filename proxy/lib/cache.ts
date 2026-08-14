// Backing store for company cards, the daily credit counter and the per-IP rate limiter.
// Upstash REST when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, otherwise
// an in-process Map.
//
// ponytail: the Map fallback does not survive across serverless invocations — on Vercel it
// degrades to "no cache" (every request pays credits) and a per-instance rate limit.
// Setting the two env vars is the whole upgrade; no code change.

export type Cache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  incrByFloat(key: string, by: number, ttlSeconds: number): Promise<number>;
  /** Coverage-gap list: domains we were asked for and could not answer. */
  recordMiss(identifier: string): Promise<void>;
};

async function upstash(cmd: (string | number)[]): Promise<unknown> {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL!, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return ((await res.json()) as { result: unknown }).result;
}

const redis: Cache = {
  async get(key) {
    return ((await upstash(['GET', key])) as string | null) ?? null;
  },
  async set(key, value, ttlSeconds) {
    await upstash(['SET', key, value, 'EX', ttlSeconds]);
  },
  async incrByFloat(key, by, ttlSeconds) {
    const total = Number(await upstash(['INCRBYFLOAT', key, by]));
    await upstash(['EXPIRE', key, ttlSeconds, 'NX']);
    return total;
  },
  async recordMiss(identifier) {
    await upstash(['ZADD', 'misses', Date.now(), identifier]);
  },
};

const store = new Map<string, { value: string; expiresAt: number }>();

const memory: Cache = {
  async get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.value;
  },
  async set(key, value, ttlSeconds) {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  },
  async incrByFloat(key, by, ttlSeconds) {
    const total = Number((await memory.get(key)) ?? 0) + by;
    await memory.set(key, String(total), ttlSeconds);
    return total;
  },
  async recordMiss() {
    // No coverage-gap list without Redis; misses are still cached as `{found:false}`.
  },
};

export function getCache(): Cache {
  return process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? redis
    : memory;
}
