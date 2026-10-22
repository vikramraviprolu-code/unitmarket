// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/receipts/receipts.ts. Adapted; owned by SBX.
// Immutable, versioned receipts. A new version exists only when the body hash changes; an old
// version is never edited (the table refuses UPDATE and DELETE). The hash shown to the buyer is
// the stored hash, and a read recomputes it from the stored body (PAY-09).
import { IdSchema, ReceiptSchema, err, ok } from '@umsbx/contracts';
import type { CoreDeps, Id, Receipt, Result, Sha256Hex, SqlExecutor } from '@umsbx/contracts';
import { buildReceiptBody, receiptBodyHash } from './body';
import type { ReceiptBody } from './body';

type ReceiptDeps = Pick<CoreDeps, 'clock' | 'ids' | 'environment'>;

export async function issueReceiptIfChanged(
  tx: SqlExecutor,
  d: ReceiptDeps,
  i: { order_id: Id },
): Promise<
  Result<
    { receipt_id: Id; version: number; sha256: Sha256Hex; changed: boolean },
    { code: 'unknown_order' | 'no_verified_capture' }
  >
> {
  // Serialise issuers of one order; the unique (order_id, version) key is the backstop.
  await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [i.order_id]);
  const built = await buildReceiptBody(tx, i.order_id);
  if (!built.ok) return err(built.error);
  const body = built.value;
  const sha256 = receiptBodyHash(body);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = (
      await tx.query<{ id: string; version: number; sha256: string }>(
        'SELECT id, version, sha256 FROM receipts WHERE order_id = $1 ORDER BY version DESC LIMIT 1',
        [i.order_id],
      )
    ).rows[0];
    if (latest?.sha256 === sha256) {
      return ok({ receipt_id: latest.id, version: Number(latest.version), sha256, changed: false });
    }
    const version = latest === undefined ? 1 : Number(latest.version) + 1;
    const id = d.ids.next('rct');
    const now = d.clock.now().toISOString();
    const inserted = await tx.query(
      `INSERT INTO receipts (id, order_id, version, body, sha256, environment, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)
       ON CONFLICT DO NOTHING RETURNING id`,
      [id, i.order_id, version, JSON.stringify(body), sha256, body.environment, now],
    );
    if (inserted.rows.length > 0) return ok({ receipt_id: id, version, sha256, changed: true });
  }
  throw new Error(`receipts: could not book a version for ${i.order_id}`);
}

// null for another buyer's receipt, an unknown order or an unknown version: the same answer, so
// a probe learns nothing.
export async function getReceiptForBuyer(
  db: SqlExecutor,
  i: { order_id: Id; buyer_id: Id; version?: number },
): Promise<Receipt | null> {
  if (!IdSchema.safeParse(i.order_id).success || !IdSchema.safeParse(i.buyer_id).success) {
    return null;
  }
  if (i.version !== undefined && (!Number.isSafeInteger(i.version) || i.version < 1)) return null;
  const params: unknown[] = [i.order_id, i.buyer_id];
  if (i.version !== undefined) params.push(i.version);
  const row = (
    await db.query<{
      id: string;
      version: number;
      body: unknown;
      sha256: string;
      environment: string;
      created_at: string;
    }>(
      `SELECT r.id, r.version, r.body, r.sha256, r.environment,
              to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM receipts r JOIN orders o ON o.id = r.order_id
        WHERE r.order_id = $1 AND o.buyer_id = $2 ${i.version !== undefined ? 'AND r.version = $3' : ''}
        ORDER BY r.version DESC LIMIT 1`,
      params,
    )
  ).rows[0];
  if (row === undefined) return null;

  const stored = (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) as ReceiptBody;
  const receipt = ReceiptSchema.parse({
    ...stored,
    receipt_id: row.id,
    version: Number(row.version),
    sha256: row.sha256,
    created_at: row.created_at,
  });
  const body: ReceiptBody = {
    order_id: receipt.order_id,
    snapshot: receipt.snapshot,
    content_hash: receipt.content_hash,
    lines: receipt.lines,
    refunds: receipt.refunds,
    debug_ids: receipt.debug_ids,
    environment: receipt.environment,
  };
  if (receiptBodyHash(body) !== row.sha256) {
    throw new Error(`receipts: stored body of ${row.id} does not match its hash`);
  }
  if (body.environment !== row.environment) {
    throw new Error(`receipts: stored environment of ${row.id} differs from its body`);
  }
  return receipt;
}
