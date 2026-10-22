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
  webhook_invalid: { name: 'webhook-invalid', per: 'ip', limit: 60, window_ms: 60_000 },
} as const satisfies Record<string, RateRule>;

export interface RateVerdict {
  allowed: boolean;
  retry_after_ms: number;
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

export async function takeToken(
  deps: { db: Database; clock: Clock },
  rule: RateRule,
  subject: string,
  mode: 'take' | 'peek' = 'take',
): Promise<RateVerdict> {
  const key = `${rule.name}:${rule.per}:${subject}`.slice(0, 190);
  const interval = rule.window_ms / rule.limit;
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now().getTime();
    const res = await tx.query<{ tokens: number | string; refilled_at: unknown }>(
      'SELECT tokens, refilled_at FROM rate_buckets WHERE bucket_key = $1',
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
    const iso = new Date(refilled).toISOString();
    await tx.query(
      `INSERT INTO rate_buckets (id, bucket_key, tokens, refilled_at, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, $4)
       ON CONFLICT (bucket_key) DO UPDATE SET tokens = $2, refilled_at = $3, updated_at = $4`,
      [key, tokens - 1, iso, new Date(now).toISOString()],
    );
    return { allowed: true, retry_after_ms: 0 };
  });
}
