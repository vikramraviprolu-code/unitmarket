// Supply rows the offline journey needs: verified payees (a synthetic label, not a PayPal
// account) and the two demo buyers. Same shape the composition seeds in dry run.
import type { Database } from '@umsbx/contracts';

export async function approveRowsFor(db: Database, nowIso: string): Promise<void> {
  await db.query(
    `UPDATE publishers SET paypal_merchant_id = 'DRYRUN' || upper(left(md5(slug), 7)),
            payee_verified_at = $1, updated_at = $1
      WHERE paypal_merchant_id IS NULL`,
    [nowIso],
  );
  for (const [id, name] of [
    ['buy_A', 'Buyer A (gate)'],
    ['buy_B', 'Buyer B (gate)'],
  ] as const) {
    await db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ($1, $2, $3, 'US', $4, $4) ON CONFLICT (auth_subject) DO NOTHING`,
      [id, name, `gate:${id}`, nowIso],
    );
  }
}
