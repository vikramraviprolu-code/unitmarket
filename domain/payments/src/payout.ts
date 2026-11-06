// POB-M1 (D-089): the payout to a publisher. The buyer paid UnitMarket (the collection account). After the access window of a
// sale has ended, with no refund open and no full refund, the publisher's share is paid out to them, in dry run only in this
// lane: the only port is the dry run (payout-dryrun.ts), nothing here knows a PayPal host.
//
// Crash safety and idempotency, in the order they matter:
//  - A payout is created `due` in one transaction with its items (a unit is in at most one live payout: a partial unique index).
//  - Before the port is called the payout is committed as `sending`. The call is outside any transaction. The answer is applied
//    in a second transaction. A crash between them leaves `sending`; the next pass sends the SAME payout with the SAME stored key
//    (umsP-<payout id>) and never makes a second one. A throwing or blocked send leaves it in `sending`.
//  - Cancel is allowed only from `due` or `failed` (the database refuses anything else). A refund booked while the payout is `due`
//    or `failed` cancels it, so the next pass pays the smaller amount; a refund booked on `sending`, `sent` or `confirmed` is a
//    payout_adjustment in the ledger (an alert for an operator), taken off the next payout (adjustment_settlements).
//  - A payout is never below 0: items minus open adjustments; a payout of 0 is `confirmed` with ref NETTED-<id> and never sent.
//  - A failed payout holds its units for 24 hours (PAYOUT_RETRY_AFTER_MS), then it is cancelled with an audit row and the units
//    are paid again in the same pass.
//
// Payee (POB-G, decision A3 of the journey spec): the publisher's own PayPal Business address, the one an operator verified
// (publisher_paypal_links, state `verified`). It is read when the payout is created and stored on the payout, and read again
// at send: no verified link is `no_payee`, a link that now holds another address is `payee_changed`, and the payout is
// refused in both. The old stub column (publishers.paypal_merchant_id) is not a payee any more; it still serves the buy path.
// A publisher with `payee_shared` (the shared owner account) or who is not active is refused, at creation and again at send.
import { PAYOUT_MAX_MINOR, PAYOUT_RETRY_AFTER_MS } from '@umsbx/contracts';
import type {
  CoreDeps,
  Id,
  PayoutPort,
  PayoutSendRequest,
  PayoutSendResult,
  PayoutState,
  SqlExecutor,
} from '@umsbx/contracts';
import { appendLedgerEntry } from '@umsbx/ledger';
import { raiseAlert } from './alerts';

type PayoutDeps = CoreDeps;

/** The request id of a payout: `umsP-<payout id>`, the same on every resend. PayPal allows 108 characters. */
export function payoutKey(payout_id: Id): string {
  if (payout_id.length === 0) throw new RangeError('payoutKey: empty payout id');
  const key = `umsP-${payout_id}`;
  if (key.length > 108) throw new RangeError('payoutKey: key longer than 108 characters');
  return key;
}

export interface PayoutCounts {
  /** Payouts made this pass (a netted one counts here too). */
  created: number;
  /** Of those, how many were netted to 0 against refunds and are never sent. */
  netted: number;
  /** Payouts the port accepted. */
  sent: number;
  /** Payouts the port refused. */
  failed: number;
  /** Sends the port answered `blocked` (nothing reached the provider). */
  blocked: number;
  /** Sends that threw. The payout stays `sending` and is sent again with the same key. */
  errored: number;
  /** Payouts not sent because the payee is no longer fine (shared account, not active, changed). */
  refused: number;
  /** Failed payouts cancelled after the 24 hour hold. */
  expired: number;
}
const zero = (): PayoutCounts => ({
  created: 0,
  netted: 0,
  sent: 0,
  failed: 0,
  blocked: 0,
  errored: 0,
  refused: 0,
  expired: 0,
});

export interface PayoutPassOptions {
  /** The most payouts sent in one pass. */
  max_items: number;
  /** Tests lower the ceiling of one payout (PAYOUT_MAX_MINOR); production never passes it. */
  max_minor?: number;
}

const OPEN_REFUND = "('requested', 'sent', 'unknown', 'pending', 'unresolved')";
const system = { kind: 'system' } as const;

// ---------------------------------------------------------------------------------------------
// Cancel (also used by the refund path)

/**
 * Cancels a payout that is `due` or `failed` and frees its units and the adjustments it had used. The database refuses any
 * other state. One audit event.
 */
export async function cancelPayoutTx(
  tx: SqlExecutor,
  d: PayoutDeps,
  payout_id: Id,
  reason: string,
): Promise<void> {
  const at = d.clock.now().toISOString();
  await tx.query("UPDATE payouts SET state = 'cancelled', updated_at = $2 WHERE id = $1", [
    payout_id,
    at,
  ]);
  await tx.query(
    'UPDATE payout_items SET live = false, updated_at = $2 WHERE payout_id = $1 AND live',
    [payout_id, at],
  );
  await tx.query(
    'UPDATE adjustment_settlements SET live = false, updated_at = $2 WHERE payout_id = $1 AND live',
    [payout_id, at],
  );
  await d.audit.record(tx, {
    actor: system,
    action: 'payout.cancelled',
    target: payout_id,
    reason,
    detail: {},
  });
}

/**
 * Called by the refund path in the transaction that booked a refund. If the unit is in a live payout: while the payout is `due` or
 * `failed` it is cancelled (the next pass pays what is left); once it is `sending`, `sent` or `confirmed` the publisher share of the
 * refund is booked as a payout_adjustment and an operator is alerted. Nothing happens when the refund did not touch the
 * publisher share (only the fee was reversed) or the unit is in no live payout.
 */
export async function onRefundBooked(
  tx: SqlExecutor,
  d: PayoutDeps,
  i: { unit_id: Id; order_id: Id; capture_id: string; refund_id: string; payable_minor: number },
): Promise<void> {
  if (i.payable_minor <= 0) return;
  const live = (
    await tx.query<{ id: string; state: PayoutState }>(
      `SELECT p.id, p.state FROM payout_items i JOIN payouts p ON p.id = i.payout_id
        WHERE i.order_unit_id = $1 AND i.live FOR UPDATE OF p`,
      [i.unit_id],
    )
  ).rows[0];
  if (live === undefined) return;
  if (live.state === 'due' || live.state === 'failed') {
    await cancelPayoutTx(tx, d, live.id, 'refund_booked');
    return;
  }
  const refundRow = (
    await tx.query<{ id: string }>(
      "SELECT id FROM ledger_entries WHERE capture_id = $1 AND kind = 'refund' AND refund_id = $2",
      [i.capture_id, i.refund_id],
    )
  ).rows[0];
  const currency = (
    await tx.query<{ currency: string }>(
      'SELECT o.currency FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.id = $1',
      [i.unit_id],
    )
  ).rows[0]!.currency;
  const adjustment = await appendLedgerEntry(tx, d, {
    unit_id: i.unit_id,
    capture_id: i.capture_id,
    kind: 'payout_adjustment',
    amount: { currency, minor: i.payable_minor },
    refund_id: i.refund_id,
    ref_entry_id: refundRow?.id ?? null,
  });
  // Review B1: remember which payout this adjustment was booked against. It is owed back only if that payout goes out;
  // if it fails the unit is paid again from the ledger net, which already has the payable reversal.
  const entry_id = adjustment.ok ? adjustment.value.id : adjustment.error.existing_entry_id;
  const at = d.clock.now().toISOString();
  await tx.query(
    `INSERT INTO payout_adjustment_sources (adjustment_entry_id, payout_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`,
    [entry_id, live.id, at],
  );
  await raiseAlert(tx, d, {
    kind: 'payout_adjustment',
    order_id: i.order_id,
    unit_id: i.unit_id,
    reason: `adjust_${i.refund_id}`,
    detail: { amount_minor: i.payable_minor, payout_id: live.id, payout_state: live.state },
  });
}

// ---------------------------------------------------------------------------------------------
// Creating payouts

interface DueUnit {
  unit_id: Id;
  order_id: Id;
  publisher_id: Id;
  currency: string;
  net_minor: number;
  ends_at: string;
  payee_merchant_id: string;
}

/**
 * The units whose publisher share is due: verified and captured, not refunded in full, no reversal, the access windows of all its
 * items ended, no refund request open, in no live payout, and the publisher active with a payee that is not the shared account.
 * `only` limits the read to some units (the re-check under lock).
 */
async function dueUnits(db: SqlExecutor, d: PayoutDeps, only: Id[] | null): Promise<DueUnit[]> {
  const params: unknown[] = [d.environment, d.clock.now().toISOString()];
  if (only !== null) params.push(only);
  const r = await db.query<{
    unit_id: string;
    order_id: string;
    publisher_id: string;
    currency: string;
    net_minor: string | number;
    ends_at: string;
    payee_merchant_id: string;
  }>(
    `SELECT u.id AS unit_id, u.order_id, u.publisher_id, o.currency, pay.net AS net_minor,
            to_char(win.max_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends_at,
            l.paypal_email AS payee_merchant_id
       FROM order_units u
       JOIN orders o ON o.id = u.order_id
       JOIN publishers p ON p.id = u.publisher_id
       JOIN publisher_paypal_links l ON l.publisher_id = p.id AND l.state = 'verified'
       JOIN order_unit_parts up ON up.unit_id = u.id
       CROSS JOIN LATERAL (
         SELECT count(*) AS n,
                count(*) FILTER (WHERE w.state IN ('running', 'ended') AND w.ends_at IS NOT NULL AND w.ends_at <= $2) AS done,
                max(w.ends_at) AS max_end
           FROM entitlements e LEFT JOIN access_windows w ON w.entitlement_id = e.id
          WHERE e.unit_id = u.id) win
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable'), 0)
                - coalesce(sum(l.amount_minor) FILTER (WHERE l.kind = 'payable_reversal'), 0) AS net,
                count(*) FILTER (WHERE l.kind = 'reversal') AS reversals
           FROM ledger_entries l WHERE l.unit_id = u.id) pay
      WHERE o.environment = $1
        AND u.captured_verified_at IS NOT NULL
        AND u.status IN ('captured_verified', 'partially_refunded')
        AND win.n > 0 AND win.n = win.done
        AND pay.net > 0 AND pay.reversals = 0
        AND p.status = 'active' AND NOT p.payee_shared
        AND NOT EXISTS (SELECT 1 FROM refund_requests rr WHERE rr.unit_id = u.id AND rr.state IN ${OPEN_REFUND})
        AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.order_unit_id = u.id AND i.live)
        ${only === null ? '' : 'AND u.id = ANY($3::text[])'}
      ORDER BY win.max_end, u.id`,
    params,
  );
  return r.rows.map((x) => ({
    unit_id: x.unit_id,
    order_id: x.order_id,
    publisher_id: x.publisher_id,
    currency: x.currency,
    net_minor: Number(x.net_minor),
    ends_at: x.ends_at,
    payee_merchant_id: x.payee_merchant_id,
  }));
}

interface OpenAdjustment {
  entry_id: string;
  open_minor: number;
}

/**
 * Payout adjustments of a publisher and currency not yet used up by a live settlement, oldest first. An adjustment whose
 * source payout failed, was cancelled or is still sending is left out (review B1): the unit of a failed payout is paid
 * again from a ledger net that already has the reversal, and one still sending is not settled yet. An adjustment with
 * no source row (booked before the link existed) counts.
 */
async function openAdjustments(
  tx: SqlExecutor,
  d: PayoutDeps,
  publisher_id: Id,
  currency: string,
): Promise<OpenAdjustment[]> {
  const r = await tx.query<{ id: string; open_minor: string | number }>(
    `SELECT l.id,
            l.amount_minor - coalesce((SELECT sum(s.amount_minor) FROM adjustment_settlements s
                                        WHERE s.adjustment_entry_id = l.id AND s.live), 0) AS open_minor
       FROM ledger_entries l
       JOIN order_units u ON u.id = l.unit_id
      WHERE l.kind = 'payout_adjustment' AND u.publisher_id = $1 AND l.currency = $2 AND l.environment = $3
        AND NOT EXISTS (SELECT 1 FROM payout_adjustment_sources s JOIN payouts sp ON sp.id = s.payout_id
                         WHERE s.adjustment_entry_id = l.id AND sp.state IN ('sending', 'failed', 'cancelled'))
      ORDER BY l.created_at, l.id`,
    [publisher_id, currency, d.environment],
  );
  return r.rows
    .map((x) => ({ entry_id: x.id, open_minor: Number(x.open_minor) }))
    .filter((x) => x.open_minor > 0);
}

/**
 * Creates the payouts that are due: one per publisher and currency per pass (more only when the sum is above the ceiling),
 * each in its own transaction with its items, the settlements that net it against open adjustments and one audit event.
 * Idempotent: a unit in a live payout is not due again.
 */
export async function createDuePayouts(
  d: PayoutDeps,
  o: { max_minor?: number } = {},
): Promise<{ created: number; netted: number }> {
  const max = o.max_minor ?? PAYOUT_MAX_MINOR;
  const out = { created: 0, netted: 0 };
  const scan = await dueUnits(d.db, d, null);
  const groups = new Map<string, { publisher_id: Id; currency: string }>();
  for (const u of scan)
    groups.set(`${u.publisher_id}\u0000${u.currency}`, {
      publisher_id: u.publisher_id,
      currency: u.currency,
    });
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    const ids = scan
      .filter((u) => u.publisher_id === g.publisher_id && u.currency === g.currency)
      .map((u) => u.unit_id);
    const r = await d.db.transaction(async (tx) => {
      // One creation at a time per publisher, so two passes never use the same adjustment twice.
      await tx.query('SELECT id FROM publishers WHERE id = $1 FOR NO KEY UPDATE', [g.publisher_id]);
      // The units are locked in id order; then what is due is read again, under the lock.
      await tx.query(
        'SELECT id FROM order_units WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
        [[...ids].sort()],
      );
      const units = (await dueUnits(tx, d, ids)).filter(
        (u) => u.publisher_id === g.publisher_id && u.currency === g.currency,
      );
      return makePayouts(tx, d, g, units, max);
    });
    out.created += r.created;
    out.netted += r.netted;
  }
  return out;
}

async function makePayouts(
  tx: SqlExecutor,
  d: PayoutDeps,
  g: { publisher_id: Id; currency: string },
  units: DueUnit[],
  max: number,
): Promise<{ created: number; netted: number }> {
  const out = { created: 0, netted: 0 };
  if (units.length === 0) return out;
  const at = d.clock.now().toISOString();
  const adjustments = await openAdjustments(tx, d, g.publisher_id, g.currency);
  const chunks: DueUnit[][] = [];
  let current: DueUnit[] = [];
  let sum = 0;
  for (const u of units) {
    if (u.net_minor > max) {
      // A single sale above the ceiling cannot be paid in one payout: an operator decides.
      await raiseAlert(tx, d, {
        kind: 'payout_failed',
        order_id: u.order_id,
        unit_id: u.unit_id,
        reason: `unit_too_large_${u.unit_id}`,
        detail: { amount_minor: u.net_minor },
      });
      continue;
    }
    if (current.length > 0 && sum + u.net_minor > max) {
      chunks.push(current);
      current = [];
      sum = 0;
    }
    current.push(u);
    sum += u.net_minor;
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) {
    const total = chunk.reduce((s, u) => s + u.net_minor, 0);
    // Net against open adjustments, oldest first, never below 0: an adjustment used in part keeps the rest.
    let toSettle = Math.min(
      total,
      adjustments.reduce((s, a) => s + a.open_minor, 0),
    );
    const settlements: { entry_id: string; minor: number }[] = [];
    for (const a of adjustments) {
      if (toSettle === 0) break;
      const take = Math.min(a.open_minor, toSettle);
      settlements.push({ entry_id: a.entry_id, minor: take });
      a.open_minor -= take;
      toSettle -= take;
    }
    const settled = settlements.reduce((s, x) => s + x.minor, 0);
    const amount = total - settled;
    const id = d.ids.next('pay');
    const key = payoutKey(id);
    const netted = amount === 0;
    await tx.query(
      `INSERT INTO payouts (id, publisher_id, currency, amount_minor, state, environment, idempotency_key,
          payee_merchant_id, provider_ref, failure_reason, sending_at, failed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, $10, $10)`,
      [
        id,
        g.publisher_id,
        g.currency,
        amount,
        netted ? 'confirmed' : 'due',
        d.environment,
        key,
        chunk[0]!.payee_merchant_id,
        netted ? `NETTED-${id}` : null,
        at,
      ],
    );
    for (const u of chunk) {
      await tx.query(
        `INSERT INTO payout_items (payout_id, order_unit_id, seller_minor, live, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)`,
        [id, u.unit_id, u.net_minor, at],
      );
    }
    for (const s of settlements) {
      await tx.query(
        `INSERT INTO adjustment_settlements (payout_id, adjustment_entry_id, amount_minor, live, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)`,
        [id, s.entry_id, s.minor, at],
      );
    }
    await d.audit.record(tx, {
      actor: system,
      action: 'payout.created',
      target: id,
      reason: null,
      detail: {
        publisher_id: g.publisher_id,
        currency: g.currency,
        amount_minor: amount,
        items: chunk.length,
        settled_minor: settled,
        netted,
      },
    });
    out.created += 1;
    if (netted) out.netted += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sending

/**
 * Cancels the failed payouts that have waited 24 hours; their units are free again and the same pass pays them.
 */
export async function expireFailedPayouts(d: PayoutDeps): Promise<number> {
  const cutoff = new Date(d.clock.now().getTime() - PAYOUT_RETRY_AFTER_MS).toISOString();
  const due = await d.db.query<{ id: string }>(
    "SELECT id FROM payouts WHERE state = 'failed' AND environment = $1 AND failed_at <= $2 ORDER BY failed_at, id",
    [d.environment, cutoff],
  );
  let n = 0;
  for (const row of due.rows) {
    const done = await d.db.transaction(async (tx) => {
      const p = (
        await tx.query<{ state: string }>('SELECT state FROM payouts WHERE id = $1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0];
      if (p === undefined || p.state !== 'failed') return false; // a refund cancelled it meanwhile
      await cancelPayoutTx(tx, d, row.id, 'retry_after_failure');
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

interface Prepared {
  request: PayoutSendRequest;
}

// Step one: re-check the payee and commit `sending`. Returns the request to make, or why not.
async function prepare(d: PayoutDeps, id: Id): Promise<Prepared | 'refused' | 'gone'> {
  return d.db.transaction(async (tx) => {
    const p = (
      await tx.query<{
        id: string;
        publisher_id: string;
        currency: string;
        amount_minor: string | number;
        state: string;
        idempotency_key: string;
        payee_merchant_id: string;
        environment: 'dryrun' | 'sandbox';
      }>(
        `SELECT id, publisher_id, currency, amount_minor, state, idempotency_key, payee_merchant_id, environment
           FROM payouts WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (p === undefined || (p.state !== 'due' && p.state !== 'sending')) return 'gone';
    // The verified PayPal address of an active publisher whose payee is not the shared account, as it is now.
    const pub = (
      await tx.query<{ status: string; payee_shared: boolean }>(
        'SELECT status, payee_shared FROM publishers WHERE id = $1',
        [p.publisher_id],
      )
    ).rows[0];
    // Locked for share, so an address change that is being verified or replaced right now finishes first (or waits for us).
    const link_email =
      (
        await tx.query<{ paypal_email: string }>(
          `SELECT paypal_email FROM publisher_paypal_links WHERE publisher_id = $1 AND state = 'verified' FOR SHARE`,
          [p.publisher_id],
        )
      ).rows[0]?.paypal_email ?? null;
    const why =
      pub === undefined || pub.status !== 'active'
        ? 'inactive'
        : pub.payee_shared
          ? 'shared'
          : link_email === null
            ? 'no_payee'
            : link_email !== p.payee_merchant_id
              ? 'payee_changed'
              : null;
    if (why !== null) {
      // Review M1: the payout stays where it is and an operator is told, once for each payout and reason.
      const first = (
        await tx.query<{ order_unit_id: string; order_id: string }>(
          `SELECT i.order_unit_id, u.order_id FROM payout_items i JOIN order_units u ON u.id = i.order_unit_id
            WHERE i.payout_id = $1 ORDER BY i.order_unit_id LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (first !== undefined) {
        await raiseAlert(tx, d, {
          kind: 'payout_failed',
          order_id: first.order_id,
          unit_id: first.order_unit_id,
          reason: `payout_refused_${id}_${why}`,
          detail: { payout_id: id, why },
        });
      }
      // POB-G review: a payout made to an address that is no longer the publisher's verified one will never be sent, and
      // while it stays `due` its units are held (live items), so the new address could never be paid. Cancel it here, in
      // this transaction: the units are free and a later pass pays them to the verified address, once one exists. A payout
      // in `sending` is never cancelled (the provider may already hold it). `inactive` and `shared` stay an operator decision.
      if ((why === 'payee_changed' || why === 'no_payee') && p.state === 'due')
        await cancelPayoutTx(tx, d, id, why);
      return 'refused';
    }
    if (p.state === 'due') {
      const at = d.clock.now().toISOString();
      await tx.query(
        "UPDATE payouts SET state = 'sending', sending_at = $2, updated_at = $2 WHERE id = $1",
        [id, at],
      );
    }
    return {
      request: {
        payout_id: p.id,
        idempotency_key: p.idempotency_key,
        publisher_id: p.publisher_id,
        payee_merchant_id: p.payee_merchant_id,
        amount: { currency: p.currency, minor: Number(p.amount_minor) },
        environment: p.environment,
      },
    };
  });
}

// Step three: apply the provider's answer to a payout that is still `sending`.
async function settle(
  d: PayoutDeps,
  id: Id,
  result: PayoutSendResult,
  counts: PayoutCounts,
): Promise<void> {
  if (result.kind === 'blocked') {
    counts.blocked += 1;
    return;
  }
  await d.db.transaction(async (tx) => {
    const p = (
      await tx.query<{ state: string }>('SELECT state FROM payouts WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];
    if (p === undefined || p.state !== 'sending') return;
    const at = d.clock.now().toISOString();
    if (result.kind === 'accepted') {
      await tx.query(
        'UPDATE payouts SET state = $2, provider_ref = $3, updated_at = $4 WHERE id = $1',
        [id, result.status, result.provider_ref.slice(0, 200), at],
      );
      await d.audit.record(tx, {
        actor: system,
        action: 'payout.sent',
        target: id,
        reason: null,
        detail: { state: result.status },
      });
      counts.sent += 1;
      return;
    }
    const reason = (result.reason.trim() === '' ? 'rejected' : result.reason).slice(0, 200);
    await tx.query(
      "UPDATE payouts SET state = 'failed', failure_reason = $2, failed_at = $3, updated_at = $3 WHERE id = $1",
      [id, reason, at],
    );
    const first = (
      await tx.query<{ order_unit_id: string; order_id: string }>(
        `SELECT i.order_unit_id, u.order_id FROM payout_items i JOIN order_units u ON u.id = i.order_unit_id
          WHERE i.payout_id = $1 ORDER BY i.order_unit_id LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (first !== undefined) {
      await raiseAlert(tx, d, {
        kind: 'payout_failed',
        order_id: first.order_id,
        unit_id: first.order_unit_id,
        reason: `payout_failed_${id}`,
        detail: { payout_id: id, failure_reason: reason },
      });
    }
    await d.audit.record(tx, {
      actor: system,
      action: 'payout.failed',
      target: id,
      reason,
      detail: {},
    });
    counts.failed += 1;
  });
}

/**
 * Sends the payouts that are `due` or still `sending`. For each: commit `sending`, call the port outside any transaction, apply
 * the answer. A throw leaves the payout in `sending` (counted as errored) and the next pass sends it again with the same key.
 */
export async function sendPayouts(
  d: PayoutDeps,
  port: PayoutPort,
  o: { max_items: number },
  counts: PayoutCounts = zero(),
): Promise<PayoutCounts> {
  const rows = await d.db.query<{ id: string }>(
    `SELECT id FROM payouts WHERE state IN ('due', 'sending') AND environment = $1 ORDER BY created_at, id LIMIT $2`,
    [d.environment, Math.max(0, Math.trunc(o.max_items))],
  );
  for (const row of rows.rows) {
    const prepared = await prepare(d, row.id);
    if (prepared === 'gone') continue;
    if (prepared === 'refused') {
      counts.refused += 1;
      continue;
    }
    let result: PayoutSendResult;
    try {
      result = await port.send(prepared.request);
    } catch (e) {
      counts.errored += 1;
      d.log.log({
        msg: 'payout.send_failed',
        level: 'error',
        fields: { payout_id: row.id, error: e instanceof Error ? e.name : 'unknown' },
      });
      continue;
    }
    await settle(d, row.id, result, counts);
  }
  return counts;
}

/**
 * One payout pass: cancel the failed payouts whose hold ended, create the payouts that are due, send them. With `port` null
 * (outbound switch off, or no payout port in this mode) payouts are still created and none is sent.
 */
export async function runPayoutPass(
  d: PayoutDeps,
  port: PayoutPort | null,
  o: PayoutPassOptions,
): Promise<PayoutCounts> {
  const counts = zero();
  counts.expired = await expireFailedPayouts(d);
  const made = await createDuePayouts(
    d,
    o.max_minor === undefined ? {} : { max_minor: o.max_minor },
  );
  counts.created = made.created;
  counts.netted = made.netted;
  if (port !== null) await sendPayouts(d, port, { max_items: o.max_items }, counts);
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Reads for Operations

export interface PayoutListRow {
  id: Id;
  publisher_id: Id;
  publisher_name: string;
  currency: string;
  amount_minor: number;
  state: PayoutState;
  environment: 'dryrun' | 'sandbox';
  provider_ref: string | null;
  failure_reason: string | null;
  items: number;
  created_at: string;
  updated_at: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** Newest first; at most `limit` (1..200). */
export async function listPayouts(db: SqlExecutor, limit = 50): Promise<PayoutListRow[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50;
  const r = await db.query<{
    id: string;
    publisher_id: string;
    publisher_name: string;
    currency: string;
    amount_minor: string | number;
    state: PayoutState;
    environment: 'dryrun' | 'sandbox';
    provider_ref: string | null;
    failure_reason: string | null;
    items: string | number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT p.id, p.publisher_id, pub.display_name AS publisher_name, p.currency, p.amount_minor, p.state,
            p.environment, p.provider_ref, p.failure_reason,
            (SELECT count(*) FROM payout_items i WHERE i.payout_id = p.id) AS items,
            to_char(p.created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
            to_char(p.updated_at AT TIME ZONE 'UTC', ${ISO}) AS updated_at
       FROM payouts p JOIN publishers pub ON pub.id = p.publisher_id
      ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
    [n],
  );
  return r.rows.map((x) => ({
    id: x.id,
    publisher_id: x.publisher_id,
    publisher_name: x.publisher_name,
    currency: x.currency,
    amount_minor: Number(x.amount_minor),
    state: x.state,
    environment: x.environment,
    provider_ref: x.provider_ref,
    failure_reason: x.failure_reason,
    items: Number(x.items),
    created_at: x.created_at,
    updated_at: x.updated_at,
  }));
}

/** How many payouts are in each state (every state is present, 0 when none). */
export async function payoutCounts(db: SqlExecutor): Promise<Record<PayoutState, number>> {
  const r = await db.query<{ state: PayoutState; n: string | number }>(
    'SELECT state, count(*) AS n FROM payouts GROUP BY state',
  );
  const out: Record<PayoutState, number> = {
    due: 0,
    sending: 0,
    sent: 0,
    confirmed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const x of r.rows) out[x.state] = Number(x.n);
  return out;
}
