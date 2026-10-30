// Token buckets in `rate_buckets` (bucket_key, tokens integer, refilled_at). One token returns
// every window_ms / limit; the bucket holds at most `limit` tokens. Integer tokens only, so the
// column type stays simple on PGlite and Postgres.
import type { Clock, Database } from '@umsbx/contracts';

export interface RateRule {
  name: string;
  per: 'ip' | 'actor';
  limit: number;
  window_ms: number;
}

// COST-3, architecture 9.8.
export const DEFAULT_RATES = {
  passcode: { name: 'passcode', per: 'ip', limit: 5, window_ms: 15 * 60_000 },
  quote: { name: 'quote', per: 'actor', limit: 30, window_ms: 60_000 },
  approval: { name: 'approval', per: 'actor', limit: 10, window_ms: 60 * 60_000 },
  order: { name: 'order', per: 'actor', limit: 5, window_ms: 60_000 },
  content: { name: 'content', per: 'actor', limit: 60, window_ms: 60 * 60_000 },
  discovery: { name: 'discovery', per: 'actor', limit: 20, window_ms: 60 * 60_000 },
  // AI-H: the buyer personas are shared, so the actor rule alone lets one visitor use up the allowance of
  // every judge. This rule adds a per-address bucket (twice the per-persona figure: one household or
  // office behind one address may share it).
  discovery_ip: { name: 'discovery-ip', per: 'ip', limit: 40, window_ms: 60 * 60_000 },
  webhook_invalid: { name: 'webhook-invalid', per: 'ip', limit: 60, window_ms: 60_000 },
} as const satisfies Record<string, RateRule>;

export interface RateVerdict {
  allowed: boolean;
  retry_after_ms: number;
}

const bucketKey = (rule: RateRule, subject: string): string =>
  `${rule.name}:${rule.per}:${subject}`.slice(0, 190);

/** Gives a bucket its full tokens back (a successful sign-in resets the failures that preceded it). */
export async function resetBucket(
  deps: { db: Database; clock: Clock },
  rule: RateRule,
  subject: string,
): Promise<void> {
  const stamp = deps.clock.now().toISOString();
  await deps.db.query(
    'UPDATE rate_buckets SET tokens = $2, refilled_at = $3, updated_at = $3 WHERE bucket_key = $1',
    [bucketKey(rule, subject), rule.limit, stamp],
  );
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export async function takeToken(
  deps: { db: Database; clock: Clock },
  rule: RateRule,
  subject: string,
  mode: 'take' | 'peek' = 'take',
): Promise<RateVerdict> {
  const key = bucketKey(rule, subject);
  const interval = rule.window_ms / rule.limit;
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now().getTime();
    const stamp = new Date(now).toISOString();
    if (mode === 'take') {
      // M1: make sure the row exists, then read it under a row lock so concurrent attempts
      // queue up instead of all reading the same token count.
      await tx.query(
        `INSERT INTO rate_buckets (bucket_key, tokens, refilled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $3, $3) ON CONFLICT (bucket_key) DO NOTHING`,
        [key, rule.limit, stamp],
      );
    }
    const res = await tx.query<{ tokens: number | string; refilled_at: unknown }>(
      `SELECT tokens, refilled_at FROM rate_buckets WHERE bucket_key = $1${mode === 'take' ? ' FOR UPDATE' : ''}`,
      [key],
    );
    const row = res.rows[0];
    let tokens = rule.limit;
    let refilled = now;
    if (row !== undefined) {
      tokens = Number(row.tokens);
      refilled = ms(row.refilled_at);
      const add = Math.max(0, Math.floor((now - refilled) / interval));
      tokens = Math.min(rule.limit, tokens + add);
      refilled = tokens >= rule.limit ? now : refilled + Math.round(add * interval);
    }
    if (tokens < 1) {
      return { allowed: false, retry_after_ms: Math.max(1, Math.ceil(refilled + interval - now)) };
    }
    if (mode === 'peek') return { allowed: true, retry_after_ms: 0 };
    await tx.query(
      'UPDATE rate_buckets SET tokens = $2, refilled_at = $3, updated_at = $4 WHERE bucket_key = $1',
      [key, tokens - 1, new Date(refilled).toISOString(), stamp],
    );
    return { allowed: true, retry_after_ms: 0 };
  });
}
