// INT-SR1 (SR1.3): the four saved views of the operator list, as literal TxnQuery values. The clock is
// injected (rule S6): "Refunds today" is the UTC day of `now`. No view carries a default `from` of its own:
// Needs attention must stay the plain attention query so SR0's fast path answers it (SR0 gate note N1).
import type { TxnQuery } from '@umsbx/contracts';

export const VIEW_IDS = [
  'needs_attention',
  'refunds_today',
  'agent_purchases',
  'sandbox_only',
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const isViewId = (v: unknown): v is ViewId =>
  typeof v === 'string' && (VIEW_IDS as readonly string[]).includes(v);

/** The UTC day of `now` as YYYY-MM-DD. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export function savedView(id: ViewId, now: Date): TxnQuery {
  switch (id) {
    case 'needs_attention':
      return { status: ['attention'] };
    case 'refunds_today':
      return { refund: ['partial', 'full'], from: utcDay(now) };
    case 'agent_purchases':
      return { channel: 'agent' };
    case 'sandbox_only':
      return { environment: 'sandbox' };
  }
}

export function savedViews(now: Date): Record<ViewId, TxnQuery> {
  return {
    needs_attention: savedView('needs_attention', now),
    refunds_today: savedView('refunds_today', now),
    agent_purchases: savedView('agent_purchases', now),
    sandbox_only: savedView('sandbox_only', now),
  };
}
