// Test helper only: a copy of domain/catalogue/src/wide-corridors-support.ts (only a package root is public, so
// the web tests cannot import it). Simulates the corridor rows migration 0034 will leave (OFFER-CUR,
// docs/specs/catalogue-offer-currency.md): us-usd, gb-gbp and de-eur widened to many payee countries (every one
// except IN) and enabled, in-usd (migration 0033) plus in-eur and in-gbp for India. The ids sort de-eur < gb-gbp
// < us-usd and in-eur < in-gbp < in-usd, so a derivation by `ORDER BY id` gives EUR where USD is meant.
import type { SqlExecutor } from '@umsbx/contracts';

/** A wide sample of payee countries, India left out on purpose. */
export const WIDE_PAYEE_COUNTRIES = [
  'US',
  'GB',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'IE',
  'CA',
  'AU',
  'NZ',
  'JP',
  'SE',
  'NO',
  'DK',
  'FI',
  'PT',
  'BE',
  'AT',
  'CH',
  'PL',
  'MX',
  'BR',
  'SG',
  'ZA',
  'AE',
] as const;

const AT = '1970-01-01T00:00:00Z';
const upsert = `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
  VALUES ($1,$2,2,ARRAY['*'],$3,$4,NULL,true,$5,$5)
  ON CONFLICT (id) DO UPDATE SET currency = $2, buyer_countries = ARRAY['*'], payee_countries = $3,
    domestic_supported = $4, enabled = true, updated_at = $5`;

export async function installWideCorridors(db: SqlExecutor): Promise<void> {
  for (const [id, currency] of [
    ['us-usd', 'USD'],
    ['gb-gbp', 'GBP'],
    ['de-eur', 'EUR'],
  ] as const)
    await db.query(upsert, [id, currency, [...WIDE_PAYEE_COUNTRIES], true, AT]);
  for (const [id, currency] of [
    ['in-usd', 'USD'],
    ['in-eur', 'EUR'],
    ['in-gbp', 'GBP'],
  ] as const)
    await db.query(upsert, [id, currency, ['IN'], false, AT]);
}

/** Adds an active publisher in `country` (fictional) and returns its id. */
export async function addPublisher(
  db: SqlExecutor,
  slug: string,
  country: string,
): Promise<string> {
  const id = `pub_${slug.replace(/-/g, '_')}`;
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [id, slug, `${slug} (fictional)`, country, '2026-10-21T10:00:00Z'],
  );
  return id;
}
