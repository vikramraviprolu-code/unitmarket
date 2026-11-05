// Test helper only (never exported from index.ts): POB-M1 payout tests. Prices an offer with a fee, a scripted
// payout port that behaves like a provider that remembers idempotency keys, a recording audit sink, and the
// small reads the payout tests share. Synthetic rows only; no network.
import type {
  AuditEntry,
  Id,
  PaymentsDeps,
  PayoutPort,
  PayoutSendRequest,
  PayoutSendResult,
} from '@umsbx/contracts';
import { FIVE_DAYS_MS } from './support';
import type { OpsWorld } from './ops/support';

export { FIVE_DAYS_MS };

/**
 * Gives an offer (keep_retrieve, version 1) a fee split: seller plus fee equal its listed price. Call it before
 * the order is placed; an order copies the parts when it is created.
 */
export async function priced(
  w: OpsWorld,
  offer_id: string,
  seller_minor: number,
  fee_minor: number,
  fee_bps = 1000,
): Promise<void> {
  await w.insert('offer_price_parts', {
    offer_id,
    offer_version: '1',
    option: 'keep_retrieve',
    seller_minor,
    fee_minor,
    tax_minor: 0,
    fee_bps,
  });
}

export interface SpyPort extends PayoutPort {
  /** Every call, in order, including repeats of one key. */
  readonly calls: PayoutSendRequest[];
  /** What the provider "executed": one entry per distinct key (a repeat of a key is answered from memory). */
  readonly executed: PayoutSendRequest[];
  /** Whether each call was made inside a database transaction (it must not be). */
  readonly inTx: boolean[];
  /** The stored state of the payout row at the moment of each call. */
  readonly stateAtCall: (string | null)[];
  mode:
    'accept' | 'confirm' | 'reject' | 'blocked' | 'throw_after_execute' | 'throw_before_execute';
  /** The reason a `reject` answer gives. */
  reject_reason: string;
}

/** A provider double: accepts, remembers a key's answer (a repeat is not executed again). */
export function spyPort(w: OpsWorld, mode: SpyPort['mode'] = 'accept'): SpyPort {
  const memory = new Map<string, PayoutSendResult>();
  const port: SpyPort = {
    calls: [],
    executed: [],
    inTx: [],
    stateAtCall: [],
    mode,
    reject_reason: 'payee_unreachable',
    async send(req) {
      port.calls.push(req);
      port.inTx.push(w.inTx());
      const row = (
        await w.rows<{ state: string }>('SELECT state FROM payouts WHERE id = $1', [req.payout_id])
      )[0];
      port.stateAtCall.push(row?.state ?? null);
      const seen = memory.get(req.idempotency_key);
      if (seen !== undefined) return seen;
      if (port.mode === 'blocked') return { kind: 'blocked', by: 'kill_switch' };
      if (port.mode === 'throw_before_execute') {
        port.mode = 'accept';
        throw new Error('the process died before the provider got the payout');
      }
      const answer: PayoutSendResult =
        port.mode === 'reject'
          ? { kind: 'rejected', reason: port.reject_reason }
          : {
              kind: 'accepted',
              provider_ref: `SPY-${req.idempotency_key}`,
              status: port.mode === 'confirm' ? 'confirmed' : 'sent',
            };
      port.executed.push(req);
      memory.set(req.idempotency_key, answer);
      if (port.mode === 'throw_after_execute') {
        port.mode = 'accept';
        throw new Error('the process died after the provider got the payout');
      }
      return answer;
    },
  };
  return port;
}

export interface Recorded {
  deps: PaymentsDeps;
  audits: AuditEntry[];
}
/** The world's deps with an audit sink that keeps what it is given. */
export function recording(w: OpsWorld): Recorded {
  const audits: AuditEntry[] = [];
  const deps: PaymentsDeps = {
    ...w.deps,
    audit: {
      record: (_tx, e) => {
        audits.push(e);
        return Promise.resolve();
      },
    },
  };
  return { deps, audits };
}

/** The clock moved past the end of the five day window (and the hour rounding) of what was paid at START. */
export const pastWindow = (w: OpsWorld): string => w.tick(FIVE_DAYS_MS + 3_600_000);

/** The latest end of the access windows of a unit (what the payout waits for). */
export async function windowEnd(w: OpsWorld, unit_id: Id): Promise<number> {
  const r = await w.rows<{ ends_at: Date }>(
    `SELECT max(a.ends_at) AS ends_at FROM access_windows a JOIN entitlements e ON e.id = a.entitlement_id
      WHERE e.unit_id = $1`,
    [unit_id],
  );
  return r[0]!.ends_at.getTime();
}
/** Moves the clock to `offset_ms` after the end of the unit's window (it never goes back). */
export async function atEnd(w: OpsWorld, unit_id: Id, offset_ms: number): Promise<void> {
  const target = (await windowEnd(w, unit_id)) + offset_ms;
  const now = w.clock.now().getTime();
  if (target < now) throw new Error('atEnd: the clock is already past that moment');
  w.tick(target - now);
}

export interface PayoutRow {
  id: string;
  publisher_id: string;
  currency: string;
  amount_minor: number;
  state: string;
  environment: string;
  idempotency_key: string;
  payee_merchant_id: string;
  provider_ref: string | null;
  failure_reason: string | null;
}
export const payoutRows = (w: OpsWorld): Promise<PayoutRow[]> =>
  w.rows<PayoutRow>(
    `SELECT id, publisher_id, currency, amount_minor::int AS amount_minor, state, environment, idempotency_key,
            payee_merchant_id, provider_ref, failure_reason
       FROM payouts ORDER BY created_at, publisher_id, amount_minor, id`,
  );
export const itemsOf = (w: OpsWorld, payout_id: Id) =>
  w.rows<{ order_unit_id: string; seller_minor: number; live: boolean }>(
    `SELECT order_unit_id, seller_minor::int AS seller_minor, live FROM payout_items
      WHERE payout_id = $1 ORDER BY order_unit_id`,
    [payout_id],
  );
export const ledgerKinds = (w: OpsWorld, unit_id?: string) =>
  w.rows<{ kind: string; amount_minor: number; refund_id: string | null }>(
    `SELECT kind, amount_minor::int AS amount_minor, refund_id FROM ledger_entries
      ${unit_id === undefined ? '' : 'WHERE unit_id = $1'} ORDER BY created_at, kind, refund_id NULLS FIRST, id`,
    unit_id === undefined ? [] : [unit_id],
  );
export async function unitIdOf(w: OpsWorld, order_id: Id, publisher_id?: string): Promise<string> {
  const r = await w.rows<{ id: string }>(
    `SELECT id FROM order_units WHERE order_id = $1 ${publisher_id === undefined ? '' : 'AND publisher_id = $2'} ORDER BY id LIMIT 1`,
    publisher_id === undefined ? [order_id] : [order_id, publisher_id],
  );
  return r[0]!.id;
}
