// The operator refund route's behaviour and the buyer's refund words (CO-8; nfr.md P9, P13, P16;
// architecture 9.5). Money rules live in payments (requestRefund, executeRefund, cancelRefundRequest);
// this file adds what a web route needs around them and nothing that moves money by itself:
//
//  - the operator facade: a refund goes through requestRefund and then executeRefund, never around them,
//    for an operator whose session carries the second factor (checked again here, on top of the route
//    wrapper), and every attempt that reaches it is written to the audit log with its outcome;
//  - the words for every refusal, in plain language (A11Y-7), and the HTTP answer for each;
//  - the refundable-units reader for /ops (second-factor sessions only);
//  - the buyer's status words, computed from stored facts only. Pages print them and compute nothing.
//
// The composition root binds the payments functions (this file imports contracts, the route
// wrapper's types and the money formatter only), so it can be tested without a database.
// Copy decisions: a partial refund is a price adjustment for the whole unit (ASM-61, open), so the
// words say access to every item in the order continues and no per-item refund state exists; a keep
// item says the links stopped and does not promise to recall a downloaded copy (ASM-59, C-07).
import { IdSchema, err, ok } from '@umsbx/contracts';
import type {
  Actor,
  AuditSink,
  Database,
  Id,
  Logger,
  Money,
  RefundStatus,
  Result,
} from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';
import { formatMinor } from '../lib/format';

// ---------------------------------------------------------------------------------------------
// Words for the operator
// ---------------------------------------------------------------------------------------------
export type RefusalCode =
  | 'mfa_required'
  | 'refunds_off'
  | 'not_captured'
  | 'over_refund'
  | 'refund_in_flight'
  | 'unit_frozen'
  | 'refund_failed'
  | 'refund_rejected';

export interface Refusal {
  http: 403 | 409 | 503;
  code: string;
  message: string;
}

/** One entry per refusal. The golden file refund-copy.golden.txt pins every word. */
export const REFUSALS: Record<RefusalCode, Refusal> = {
  mfa_required: {
    http: 403,
    code: 'mfa_required',
    message: 'Sign in again with your authenticator code. Refunds need the second factor.',
  },
  refunds_off: {
    http: 503,
    code: 'refunds_paused',
    message: 'Refunds paused. Nothing was refunded. Ask the owner to turn refunds on again.',
  },
  not_captured: {
    http: 409,
    code: 'not_captured',
    message: 'This payment has no captured money left to refund. Nothing was refunded.',
  },
  over_refund: {
    http: 409,
    code: 'over_refund',
    message:
      'That is more than is left to refund on this payment. Nothing was refunded. Check the amount left and try again.',
  },
  refund_in_flight: {
    http: 409,
    code: 'refund_in_flight',
    message:
      'A refund request is already open for this payment. Wait for it to finish, or withdraw it, then try again. Nothing new was requested.',
  },
  unit_frozen: {
    http: 409,
    code: 'unit_frozen',
    message:
      "This payment is frozen: a refund list from PayPal did not add up and a person must look. Nothing can be refunded until the flag is cleared. The buyer's access is unchanged.",
  },
  refund_failed: {
    http: 409,
    code: 'refund_failed',
    message:
      'The refund was not made: PayPal holds less than that, or did not complete it. A person has been alerted. Nothing was refunded.',
  },
  refund_rejected: {
    http: 409,
    code: 'refund_rejected',
    message: 'PayPal refused this refund. Nothing was refunded.',
  },
};

const FORBIDDEN: Refusal = {
  http: 403,
  code: 'forbidden',
  message: 'This account cannot do that.',
};

export const COMPLETED_PARTIAL = (amount: string, left: string): string =>
  `Refunded ${amount}. ${left} is left to refund. The buyer keeps access.`;
export const COMPLETED_FULL = (amount: string): string =>
  `Refunded ${amount}. This payment is now fully refunded and the buyer's access has ended.`;
export const PENDING_MESSAGE =
  "PayPal is still processing this refund. It is booked when PayPal confirms it, and the buyer's access does not change until then.";
export const UNKNOWN_MESSAGE =
  'We could not confirm this refund with PayPal yet. Do not send it again: the system keeps checking, and an alert shows if a person must look.';

export type CancelCode = 'not_operator' | 'mfa_required' | 'not_found' | 'wrong_state';
export function cancelRefusal(code: CancelCode): {
  http: 403 | 404 | 409;
  code: string;
  message: string;
} {
  switch (code) {
    case 'not_operator':
      return FORBIDDEN as { http: 403; code: string; message: string };
    case 'mfa_required':
      return REFUSALS.mfa_required as { http: 403; code: string; message: string };
    case 'not_found':
      return { http: 404, code: 'not_found', message: 'We could not find that refund request.' };
    case 'wrong_state':
      return {
        http: 409,
        code: 'wrong_state',
        message: 'That request can no longer be withdrawn: it was already sent or has finished.',
      };
  }
}

// ---------------------------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------------------------
export interface RefundDone {
  refund_request_id: Id;
  unit_id: Id;
  /** completed: booked. pending: PayPal is still processing. unknown: not confirmed yet. */
  state: 'completed' | 'pending' | 'unknown';
  amount_minor: number;
  currency: string;
  /** Booked refunds of the unit after this one, and what is left. */
  refunded_minor: number;
  remaining_minor: number;
  unit_status: string;
  message: string;
}

export type RefundFailure = { code: RefusalCode | 'not_operator' };

export interface RefundWiring {
  db: Database;
  audit: AuditSink;
  log: Logger;
  requestRefund(i: {
    unit_id: Id;
    amount: Money | null;
    reason: string;
    actor: Actor;
  }): Promise<Result<{ refund_request_id: Id }, { code: string }>>;
  executeRefund(i: {
    refund_request_id: Id;
  }): Promise<Result<{ status: RefundStatus }, { code: string }>>;
  cancelRefund(i: {
    refund_request_id: Id;
    actor: Actor;
  }): Promise<Result<{ refund_request_id: Id }, { code: string }>>;
}

export interface RefundFacade {
  /**
   * One operator refund: request, then execute. An explicit amount, or null for the rest. Never throws
   * for a refusal; a thrown error is audited and rethrown (the route keeps its idempotency key, so a
   * retry cannot send a second refund).
   */
  request(i: {
    actor: Actor;
    unit_id: Id;
    amount_minor: number | null;
    reason: string;
  }): Promise<Result<RefundDone, RefundFailure>>;
  /** Withdraws a request that is still `requested`. Works while refunds are paused. */
  cancel(i: {
    actor: Actor;
    refund_request_id: Id;
  }): Promise<Result<{ refund_request_id: Id; state: 'cancelled' }, { code: CancelCode }>>;
}

const REFUSAL_CODES = new Set<string>(Object.keys(REFUSALS));

export function createRefundFacade(w: RefundWiring): RefundFacade {
  // One audit row per attempt that reached this facade, with the outcome. An audit failure is logged
  // loudly and never thrown: the money may already have moved, and a throw would leave the route's
  // idempotency key pending, to be reclaimed later and replayed into a second refund.
  const audit = async (
    actor: Actor,
    unit_id: string | null,
    reason: string | null,
    detail: {
      outcome: string;
      amount_minor: number | null;
      refund_request_id: string | null;
    },
  ): Promise<void> => {
    try {
      await w.db.transaction((tx) =>
        w.audit.record(tx, {
          actor,
          action: 'refund.attempt',
          target: unit_id !== null && IdSchema.safeParse(unit_id).success ? unit_id : null,
          reason,
          detail,
        }),
      );
    } catch {
      w.log.log({
        msg: 'refund.audit_failed',
        level: 'error',
        fields: { outcome: detail.outcome },
      });
    }
  };

  const describe = async (
    request_id: Id,
    state: RefundDone['state'],
  ): Promise<RefundDone | null> => {
    try {
      const r = (
        await w.db.query<{
          unit_id: string;
          amount_minor: string | number;
          currency: string;
          total: string | number;
          refunded_minor: string | number;
          status: string;
        }>(
          `SELECT r.unit_id, r.amount_minor, r.currency, u.amount_minor AS total, u.refunded_minor, u.status
             FROM refund_requests r JOIN order_units u ON u.id = r.unit_id WHERE r.id = $1`,
          [request_id],
        )
      ).rows[0];
      if (r === undefined) return null;
      const amount = Number(r.amount_minor);
      const left = Number(r.total) - Number(r.refunded_minor);
      const message =
        state === 'pending'
          ? PENDING_MESSAGE
          : state === 'unknown'
            ? UNKNOWN_MESSAGE
            : r.status === 'refunded' || left <= 0
              ? COMPLETED_FULL(formatMinor(amount, r.currency))
              : COMPLETED_PARTIAL(formatMinor(amount, r.currency), formatMinor(left, r.currency));
      return {
        refund_request_id: request_id,
        unit_id: r.unit_id,
        state,
        amount_minor: amount,
        currency: r.currency,
        refunded_minor: Number(r.refunded_minor),
        remaining_minor: left,
        unit_status: r.status,
        message,
      };
    } catch {
      return null;
    }
  };

  return {
    async request({ actor, unit_id, amount_minor, reason }) {
      const finish = async (
        code: RefusalCode | 'not_operator',
        refund_request_id: string | null = null,
      ): Promise<Result<RefundDone, RefundFailure>> => {
        await audit(actor, unit_id, reason, { outcome: code, amount_minor, refund_request_id });
        return err({ code });
      };
      if (actor.kind !== 'operator') return finish('not_operator');
      // P9, again: the wrapper already refuses a session without the second factor.
      if (actor.mfa !== true) return finish('mfa_required');
      if (!IdSchema.safeParse(unit_id).success) return finish('not_captured');
      const unit = (
        await w.db.query<{ currency: string }>(
          'SELECT o.currency FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1',
          [unit_id],
        )
      ).rows[0];
      if (unit === undefined) return finish('not_captured');

      const requested = await w.requestRefund({
        unit_id,
        amount: amount_minor === null ? null : { currency: unit.currency, minor: amount_minor },
        reason,
        actor,
      });
      if (!requested.ok) {
        const code = requested.error.code;
        return finish(
          REFUSAL_CODES.has(code)
            ? (code as RefusalCode)
            : code === 'not_operator'
              ? 'not_operator'
              : 'not_captured',
        );
      }
      const request_id = requested.value.refund_request_id;

      let executed: Result<{ status: RefundStatus }, { code: string }>;
      try {
        executed = await w.executeRefund({ refund_request_id: request_id });
      } catch (e) {
        await audit(actor, unit_id, reason, {
          outcome: 'error',
          amount_minor,
          refund_request_id: request_id,
        });
        throw e;
      }

      if (executed.ok) {
        const status = executed.value.status;
        if (status === 'COMPLETED' || status === 'PENDING') {
          const state = status === 'COMPLETED' ? 'completed' : 'pending';
          const done = await describe(request_id, state);
          await audit(actor, unit_id, reason, {
            outcome: state === 'completed' ? 'refunded' : 'pending',
            amount_minor,
            refund_request_id: request_id,
          });
          if (done !== null) return ok(done);
          // The refund is booked or pending; only the description could not be read.
          return ok({
            refund_request_id: request_id,
            unit_id,
            state,
            amount_minor: amount_minor ?? 0,
            currency: unit.currency,
            refunded_minor: 0,
            remaining_minor: 0,
            unit_status: 'unknown',
            message: state === 'completed' ? 'Refunded.' : PENDING_MESSAGE,
          });
        }
        return finish('refund_failed', request_id);
      }
      if (executed.error.code === 'unknown') {
        const done = await describe(request_id, 'unknown');
        await audit(actor, unit_id, reason, {
          outcome: 'unknown',
          amount_minor,
          refund_request_id: request_id,
        });
        return ok(
          done ?? {
            refund_request_id: request_id,
            unit_id,
            state: 'unknown',
            amount_minor: amount_minor ?? 0,
            currency: unit.currency,
            refunded_minor: 0,
            remaining_minor: 0,
            unit_status: 'unknown',
            message: UNKNOWN_MESSAGE,
          },
        );
      }
      // rejected: PayPal said no, or refunds were switched off between the two steps. In the second
      // case the request is still `requested` and the operator can withdraw it.
      const left = (
        await w.db.query<{ state: string }>('SELECT state FROM refund_requests WHERE id = $1', [
          request_id,
        ])
      ).rows[0]?.state;
      return finish(left === 'requested' ? 'refunds_off' : 'refund_rejected', request_id);
    },

    async cancel({ actor, refund_request_id }) {
      const reason = null;
      const result = async (
        code: CancelCode,
      ): Promise<Result<{ refund_request_id: Id; state: 'cancelled' }, { code: CancelCode }>> => {
        await audit(actor, refund_request_id, reason, {
          outcome: `cancel_${code}`,
          amount_minor: null,
          refund_request_id,
        });
        return err({ code });
      };
      if (actor.kind !== 'operator') return result('not_operator');
      if (actor.mfa !== true) return result('mfa_required');
      const r = await w.cancelRefund({ refund_request_id, actor });
      if (!r.ok) {
        const c = r.error.code;
        return result(
          c === 'not_found' || c === 'wrong_state' || c === 'mfa_required' ? c : 'not_operator',
        );
      }
      // payments records refund.cancelled with the actor; this row records the attempt.
      await audit(actor, refund_request_id, reason, {
        outcome: 'cancelled',
        amount_minor: null,
        refund_request_id,
      });
      return ok({ refund_request_id, state: 'cancelled' as const });
    },
  };
}

/** The HTTP answer for a refund attempt. */
export function answerFor(r: Result<RefundDone, RefundFailure>): HttpResult<RefundDone> {
  if (r.ok) return { status: r.value.state === 'unknown' ? 202 : 200, body: r.value };
  if (r.error.code === 'not_operator')
    return { status: FORBIDDEN.http, code: FORBIDDEN.code, message: FORBIDDEN.message };
  const x = REFUSALS[r.error.code];
  return { status: x.http, code: x.code, message: x.message };
}

// ---------------------------------------------------------------------------------------------
// What /ops shows an operator whose session has the second factor
// ---------------------------------------------------------------------------------------------
export interface RefundUnitView {
  unit_id: Id;
  order_ref: string;
  titles: string[];
  currency: string;
  /** What the buyer paid for the unit. */
  amount_minor: number;
  /** Booked refunds (the ledger decides, D-019). */
  refunded_minor: number;
  /** Held by requests that can still become refunds. */
  reserved_minor: number;
  /** What a new request may ask for: paid, less booked, less held. */
  remaining_minor: number;
  frozen: boolean;
  open_requests: {
    refund_request_id: Id;
    amount_minor: number;
    state: string;
    /** Only a request still `requested` can be withdrawn. */
    can_withdraw: boolean;
  }[];
}
export interface RefundOverview {
  /** The refunds_enabled switch. Off: the form is hidden and requests can still be withdrawn. */
  enabled: boolean;
  units: RefundUnitView[];
}

const OPEN_STATES = ['requested', 'sent', 'unknown', 'pending', 'unresolved'];

export async function loadRefundOverview(db: Database, enabled: boolean): Promise<RefundOverview> {
  const units = await db.query<{
    unit_id: string;
    order_ref: string;
    currency: string;
    mismatch: boolean;
    amount_minor: string | number;
    refunded: string | number;
    reserved: string | number;
  }>(
    `SELECT u.id AS unit_id, o.order_ref, o.currency, o.mismatch, u.amount_minor,
            COALESCE((SELECT sum(l.amount_minor) FROM ledger_entries l
                       WHERE l.unit_id = u.id AND l.kind = 'refund'), 0) AS refunded,
            COALESCE((SELECT sum(r.amount_minor) FROM refund_requests r
                       WHERE r.unit_id = u.id AND r.state = ANY($1::text[])), 0) AS reserved
       FROM order_units u JOIN orders o ON o.id = u.order_id
      WHERE u.status IN ('captured_verified', 'partially_refunded') AND u.captured_verified_at IS NOT NULL
      ORDER BY o.created_at DESC, u.id
      LIMIT 50`,
    [OPEN_STATES],
  );
  const ids = units.rows.map((r) => r.unit_id);
  const titles = new Map<string, string[]>();
  const open = new Map<string, RefundUnitView['open_requests']>();
  if (ids.length > 0) {
    const t = await db.query<{ unit_id: string; title: string }>(
      `SELECT e.unit_id, a.title FROM entitlements e JOIN articles a ON a.id = e.article_id
        WHERE e.unit_id::text = ANY($1::text[]) ORDER BY e.id`,
      [ids],
    );
    for (const r of t.rows) titles.set(r.unit_id, [...(titles.get(r.unit_id) ?? []), r.title]);
    const q = await db.query<{
      id: string;
      unit_id: string;
      amount_minor: string | number;
      state: string;
    }>(
      `SELECT id, unit_id, amount_minor, state FROM refund_requests
        WHERE unit_id::text = ANY($1::text[]) AND state = ANY($2::text[]) ORDER BY created_at, id`,
      [ids, OPEN_STATES],
    );
    for (const r of q.rows)
      open.set(r.unit_id, [
        ...(open.get(r.unit_id) ?? []),
        {
          refund_request_id: r.id,
          amount_minor: Number(r.amount_minor),
          state: r.state,
          can_withdraw: r.state === 'requested',
        },
      ]);
  }
  return {
    enabled,
    units: units.rows.map((r) => {
      const amount = Number(r.amount_minor);
      const refunded = Number(r.refunded);
      const reserved = Number(r.reserved);
      return {
        unit_id: r.unit_id,
        order_ref: r.order_ref,
        titles: titles.get(r.unit_id) ?? [],
        currency: r.currency,
        amount_minor: amount,
        refunded_minor: refunded,
        reserved_minor: reserved,
        remaining_minor: Math.max(0, amount - refunded - reserved),
        frozen: r.mismatch === true,
        open_requests: open.get(r.unit_id) ?? [],
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Words for the buyer, from stored facts only
// ---------------------------------------------------------------------------------------------
export const REFUNDED_ONLINE = 'Refunded: access has ended';
export const REFUNDED_KEEP =
  'Refunded: links have stopped. The copy you downloaded cannot be recalled.';
export const PARTIAL = 'Partially refunded: your access continues';
export const PARTIAL_NOTE =
  'Part of this order was refunded as a price adjustment. Access to every item in the order continues.';

export interface BuyerFacts {
  /** The library read model's own words, used when no refund applies. */
  base: string;
  /** entitlements.money_state */
  money: string;
  /** access_windows.state (not_started, running, paused, ended, revoked) */
  window_state: string;
  /** keep_retrieve or online_read */
  option: string;
  /** order_units.status */
  unit_status: string;
}

export function buyerStatusText(f: BuyerFacts): string {
  if (f.money === 'reversed' || f.unit_status === 'reversed') return f.base;
  if (f.money === 'refunded' || f.unit_status === 'refunded')
    return f.option === 'keep_retrieve' ? REFUNDED_KEEP : REFUNDED_ONLINE;
  if (f.unit_status === 'partially_refunded' && f.money === 'captured') {
    return f.window_state === 'ended' || f.window_state === 'revoked'
      ? `Partially refunded. ${f.base}`
      : PARTIAL;
  }
  return f.base;
}

export function buyerRefundNote(f: Pick<BuyerFacts, 'money' | 'unit_status'>): string | null {
  return f.unit_status === 'partially_refunded' && f.money === 'captured' ? PARTIAL_NOTE : null;
}

/** One line for the order page: what has been refunded of what was paid. */
export function orderRefundLine(i: {
  total_minor: number;
  refunded_minor: number;
  currency: string;
}): string | null {
  if (i.refunded_minor <= 0) return null;
  return i.refunded_minor >= i.total_minor
    ? `Refunded ${formatMinor(i.refunded_minor, i.currency)}.`
    : `Partly refunded: ${formatMinor(i.refunded_minor, i.currency)} of ${formatMinor(i.total_minor, i.currency)}.`;
}
