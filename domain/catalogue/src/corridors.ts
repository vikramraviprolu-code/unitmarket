// Corridor lookup (architecture 12). Corridors are configuration rows; the engine reads only the row.
// Adapted in shape from the offers query style of AIC_Hackathon_UnitMarket packages/core/catalogue/offers.ts
// at a36ddc03fd0b962000f686291c145b50ee337f90. Owned by SBX.
import { CorridorSchema } from '@umsbx/contracts';
import type { Corridor, CorridorId, CurrencyCode, SqlExecutor } from '@umsbx/contracts';

const COLUMNS =
  'id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled';

export async function getCorridor(db: SqlExecutor, id: CorridorId): Promise<Corridor | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM corridors WHERE id = $1`, [id]);
  return rows[0] ? CorridorSchema.parse(rows[0]) : null;
}

// The corridor for a currency, a payee country and (when known) the buyer's country. A disabled
// corridor is returned as it is, so the caller can tell "off" from "none"; enabled ones come first.
export async function corridorFor(
  db: SqlExecutor,
  i: { currency: CurrencyCode; payee_country: string; buyer_country: string | null },
): Promise<Corridor | null> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM corridors
      WHERE currency = $1 AND $2 = ANY (payee_countries)
        AND ($3::text IS NULL OR '*' = ANY (buyer_countries) OR $3 = ANY (buyer_countries))
      ORDER BY enabled DESC, id
      LIMIT 1`,
    [i.currency, i.payee_country, i.buyer_country],
  );
  return rows[0] ? CorridorSchema.parse(rows[0]) : null;
}
