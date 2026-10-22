// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/receipts/receipts.ts. Adapted; owned by SBX.
// The receipt body: canonical JSON of { order_id, snapshot, content_hash, lines, refunds,
// debug_ids, environment }. Built only from stored facts (order, frozen approval snapshot,
// entitlement windows, access events, ledger rows, provider call debug ids); the hash of the
// canonical text is what the buyer sees and what is stored.
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
        ORDER BY a.at, a.kind, a.id`,
      [order_id],
    )
  ).rows;

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
      return {
        article_id: item.article_id,
        article_sha256: item.article_sha256,
        option: item.option,
        amount_minor: item.amount_minor,
        capture_id: ent?.capture_id ?? null,
        window,
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
      WHERE o.order_id = $1 AND p.debug_id IS NOT NULL`,
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
