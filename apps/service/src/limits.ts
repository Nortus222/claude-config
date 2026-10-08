import { ServiceFailure } from './errors.ts';

// Replica-local token buckets expire once an idle bucket has fully refilled.
export function tokenBucket(capacity: number, periodMs: number, now: () => number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string): void => {
    const time = now();
    for (const [id, bucket] of buckets) if (time - bucket.at >= periodMs) buckets.delete(id);
    const bucket = buckets.get(key) ?? { tokens: capacity, at: time };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, time - bucket.at) * capacity / periodMs);
    bucket.at = time;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) throw new ServiceFailure({ code: 'rate_limited', retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) * periodMs / capacity / 1000)) });
    bucket.tokens--;
  };
}
