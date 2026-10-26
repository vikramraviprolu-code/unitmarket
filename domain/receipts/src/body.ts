// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/receipts/receipts.ts. Adapted; owned by SBX.
// The receipt body: canonical JSON of { order_id, snapshot, content_hash, lines, refunds,
// debug_ids, environment }. Built only from stored facts (order, frozen approval snapshot,
// entitlement windows, access events, ledger rows, provider call debug ids); the hash of the
// canonical text is what the buyer sees and what is stored. Anything a buyer can trigger by
// reading or re-requesting (beacons, link re-issues, buyer-sourced events, read-back calls) stays
// out of the hashed body, so such actions never create a receipt version.
import { canonicalJson, minorUnitsFor, sha256Hex } from '@umsbx/approval';
import { ApprovalSnapshotSchema, WindowStateSchema, err, ok } from '@umsbx/contracts';
import type {
  EnvironmentLabel,
  Id,
  Receipt,
  ReceiptLine,
  Result,
  Sha256Hex,
  SqlExecutor,
  WindowState,
} from '@umsbx/contracts';
import { listLedger } from '@umsbx/ledger';

export type ReceiptBody = Omit<Receipt, 'receipt_id' | 'version' | 'sha256' | 'created_at'>;
export type BodyError = { code: 'unknown_order' | 'no_verified_capture' };

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ts = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', ${ISO})`;

// PayPal debug ids are support handles for the operator; the buyer sees only the last 6 characters.
export function sanitiseDebugId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

export function receiptBodyHash(body: ReceiptBody): Sha256Hex {
  const digits = minorUnitsFor(body.snapshot.currency);
  if (digits === null) {
    throw new TypeError(`receipt: no minor-unit digits for ${body.snapshot.currency}`);
  }
  return sha256Hex(canonicalJson(body, digits));
}

const NOT_STARTED: WindowState = {
  state: 'not_started',
  started_at: null,
  base_ends_at: null,
  ends_at: null,
  paused_at: null,
  credit_ms: 0,
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type PaymentOutcome = NonNullable<ReceiptLine['outcome']>;

// What the buyer is told about the payment of one item of a two-publisher order (MVP-D, OQ-16, OQ-8).
// Cautious by order: a unit or a PayPal order on hold is `on_hold` whatever else is true (money may
// have moved, and "not charged" would be a claim we cannot make); then a verified capture is paid
// or refunded by what the unit says; only a declined, failed or abandoned PayPal order is
// `not_charged`; everything else has not happened yet and is `waiting`.
const UNIT_ON_HOLD: ReadonlySet<string> = new Set(['mismatch', 'reversal_suspected', 'reversed']);
const NOT_CHARGED: ReadonlySet<string> = new Set(['declined', 'failed', 'abandoned']);

export function paymentOutcome(f: {
  unit_status: string;
  po_state: string | null;
  verified: boolean;
  amount_minor: number;
  refunded_minor: number;
}): PaymentOutcome {
  if (UNIT_ON_HOLD.has(f.unit_status) || f.po_state === 'frozen') return 'on_hold';
  const notCharged = f.po_state !== null && NOT_CHARGED.has(f.po_state);
  // A verified capture under a PayPal order we closed as not charged contradicts itself: say neither.
  if (f.verified && notCharged) return 'on_hold';
  if (f.verified) {
    if (f.refunded_minor <= 0) return 'paid';
    return f.refunded_minor >= f.amount_minor ? 'refunded' : 'partially_refunded';
  }
  if (notCharged) return 'not_charged';
  return 'waiting';
}

export async function buildReceiptBody(
  db: SqlExecutor,
  order_id: Id,
): Promise<Result<ReceiptBody, BodyError>> {
  const order = (
    await db.query<{
      approval_id: string;
      content_hash: string;
      environment: EnvironmentLabel;
    }>('SELECT approval_id, content_hash, environment FROM orders WHERE id = $1', [order_id])
  ).rows[0];
  if (order === undefined) return err({ code: 'unknown_order' });

  // A receipt exists only after a verified capture: some unit holds a capture id and the time it
  // was verified.
  const verified = await db.query(
    `SELECT 1 FROM order_units WHERE order_id = $1 AND capture_id IS NOT NULL
        AND captured_verified_at IS NOT NULL LIMIT 1`,
    [order_id],
  );
  if (verified.rows.length === 0) return err({ code: 'no_verified_capture' });

  const approval = (
    await db.query<{ snapshot: unknown }>('SELECT snapshot FROM approvals WHERE id = $1', [
      order.approval_id,
    ])
  ).rows[0];
  const snapshot = ApprovalSnapshotSchema.parse(
    typeof approval?.snapshot === 'string' ? JSON.parse(approval.snapshot) : approval?.snapshot,
  );

  const ents = (
    await db.query<{
      id: string;
      article_id: string;
      capture_id: string | null;
      w_state: string | null;
      started_at: string | null;
      base_ends_at: string | null;
      ends_at: string | null;
      paused_at: string | null;
      credit_ms: number | null;
    }>(
      `SELECT e.id, e.article_id, u.capture_id, w.state AS w_state, w.credit_ms,
              ${ts('w.started_at')} AS started_at, ${ts('w.base_ends_at')} AS base_ends_at,
              ${ts('w.ends_at')} AS ends_at, ${ts('w.paused_at')} AS paused_at
         FROM entitlements e
         JOIN order_units u ON u.id = e.unit_id
         LEFT JOIN access_windows w ON w.entitlement_id = e.id
        WHERE u.order_id = $1`,
      [order_id],
    )
  ).rows;
  const events = (
    await db.query<{ entitlement_id: string; kind: string; at: string }>(
      `SELECT a.entitlement_id, a.kind, ${ts('a.at')} AS at
         FROM access_events a
         JOIN entitlements e ON e.id = a.entitlement_id
         JOIN order_units u ON u.id = e.unit_id
        WHERE u.order_id = $1
          AND a.source <> 'buyer'
          AND a.kind NOT IN ('reader_beacon', 'link_issued')
        ORDER BY a.at, a.kind, a.id`,
      [order_id],
    )
  ).rows;

  // A two-publisher order (the snapshot says so) names the publisher on each line and says what
  // happened to that payment. A one-publisher order is written exactly as before.
  const composite = snapshot.settlement !== undefined;
  const facts = new Map<
    string,
    {
      unit_status: string;
      po_state: string | null;
      verified: boolean;
      amount_minor: number;
      refunded_minor: number;
    }
  >();
  const names = new Map<string, string>();
  if (composite) {
    const rows = await db.query<{
      article_id: string;
      unit_status: string;
      po_state: string | null;
      verified: boolean;
      amount_minor: number | string;
      refunded_minor: number | string;
    }>(
      `SELECT e.article_id, u.status AS unit_status, p.state AS po_state,
              (u.captured_verified_at IS NOT NULL) AS verified, u.amount_minor, u.refunded_minor
         FROM entitlements e
         JOIN order_units u ON u.id = e.unit_id
         LEFT JOIN provider_orders p ON p.id = u.provider_order_ref
        WHERE u.order_id = $1`,
      [order_id],
    );
    for (const r of rows.rows) {
      facts.set(r.article_id, {
        unit_status: r.unit_status,
        po_state: r.po_state,
        verified: r.verified,
        amount_minor: Number(r.amount_minor),
        refunded_minor: Number(r.refunded_minor),
      });
    }
    const publishers = snapshot.publishers.map((p) => p.publisher_id);
    const found = await db.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM publishers WHERE id IN (${publishers.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
      publishers,
    );
    for (const r of found.rows) names.set(r.id, r.display_name);
  }

  const lines: ReceiptLine[] = [...snapshot.items]
    .sort((a, b) => byText(a.article_id, b.article_id))
    .map((item) => {
      const ent = ents.find((e) => e.article_id === item.article_id);
      const window: WindowState =
        ent === undefined || ent.w_state === null
          ? NOT_STARTED
          : WindowStateSchema.parse({
              state: ent.w_state,
              started_at: ent.started_at,
              base_ends_at: ent.base_ends_at,
              ends_at: ent.ends_at,
              paused_at: ent.paused_at,
              credit_ms: Number(ent.credit_ms),
            });
      const f = facts.get(item.article_id);
      return {
        article_id: item.article_id,
        article_sha256: item.article_sha256,
        option: item.option,
        amount_minor: item.amount_minor,
        capture_id: ent?.capture_id ?? null,
        window,
        ...(composite
          ? {
              publisher_display_name: names.get(item.publisher_id) ?? item.publisher_id,
              outcome: paymentOutcome(
                f ?? {
                  unit_status: 'expected',
                  po_state: null,
                  verified: false,
                  amount_minor: item.amount_minor,
                  refunded_minor: 0,
                },
              ),
            }
          : {}),
        delivery:
          ent === undefined
            ? []
            : events
                .filter((ev) => ev.entitlement_id === ent.id)
                .map((ev) => ({
                  kind: ev.kind as ReceiptLine['delivery'][number]['kind'],
                  at: ev.at,
                })),
      };
    });

  // Refunds by refund id. A reversal has no refund id, so it is listed as `reversal:<capture>`
  // (the Receipt contract has one list for money returned; ASM-08-3).
  const refunds: ReceiptBody['refunds'] = [];
  for (const row of await listLedger(db, { order_id })) {
    if (row.kind === 'refund' && row.refund_id !== null) {
      refunds.push({ refund_id: row.refund_id, amount: row.amount, at: row.created_at });
    } else if (row.kind === 'reversal') {
      refunds.push({
        refund_id: `reversal:${row.capture_id}`,
        amount: row.amount,
        at: row.created_at,
      });
    }
  }

  const debug = await db.query<{ debug_id: string }>(
    `SELECT DISTINCT p.debug_id FROM provider_calls p
       JOIN operations o ON o.id = p.operation_id
      WHERE o.order_id = $1 AND p.debug_id IS NOT NULL
        AND p.operation IN ('capture_order', 'refund_capture')`,
    [order_id],
  );
  const debug_ids = [...new Set(debug.rows.map((r) => sanitiseDebugId(r.debug_id)))].sort(byText);

  return ok({
    order_id,
    snapshot,
    content_hash: order.content_hash,
    lines,
    refunds,
    debug_ids,
    environment: order.environment,
  });
}
