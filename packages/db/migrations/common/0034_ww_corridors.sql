-- SBX migration 0034: worldwide payee corridors (WW-COR, docs/specs/db-ww-corridors.md, owner rule D-113 of 9 Nov 2026).
-- Owned by SBX lane L3. Forward-only: there is no down step. No table or column changes; one trigger and five rows.
--
-- The owner rule: only USD, EUR and GBP; a publisher in ANY country may sell in all three; the seller picks the
-- currency per offer; the buyer pays in the offer's currency; no FX by UnitMarket. India stays apart: an Indian
-- publisher sells through in-usd, in-eur and in-gbp to buyers outside India only (domestic_supported false).
-- Ids and currencies never change (quotes, approvals and orders reference a corridor by id). Deploy after lane L1.
--
-- 1. Disjointness guard. Two enabled corridors of one currency must not share a payee country, because the
--    engine finds a corridor by (currency, payee country) and must find exactly one. Constraint trigger, so an
--    operator can swap two rows inside one transaction; it fires after the statement, on the final rows.
-- 2. Upsert, not DO NOTHING: migrate() runs BEFORE the boot seed, and a deployed database already holds narrow and
--    switched-off gb-gbp and de-eur rows. Only currency, payee_countries, buyer_countries, enabled and
--    updated_at are set, so minor_units, domestic_supported, min_charge_minor and created_at are kept as they are.
--    The boot seed uses ON CONFLICT DO NOTHING, so it can never narrow these rows again.
-- 3. in-eur and in-gbp are new rows shaped like in-usd (0033), switched on, plain INSERT (a clash is a fault).
--
-- The country literal below is every ISO 3166-1 alpha-2 code except IN (248). It is generated from the one
-- constant ISO_3166_1_ALPHA2 in packages/contracts/src/countries.ts, and packages/db/src/migration-0034.state.test.ts
-- proves the two equal. Timestamps are the fixed seed constant of 0001 because migrations take no clock.
CREATE FUNCTION ums_corridor_payee_disjoint() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other text;
BEGIN
  IF NEW.enabled THEN
    SELECT c.id INTO other FROM corridors c
     WHERE c.id <> NEW.id AND c.enabled AND c.currency = NEW.currency
       AND c.payee_countries && NEW.payee_countries
     ORDER BY c.id LIMIT 1;
    IF other IS NOT NULL THEN
      RAISE EXCEPTION 'corridor % overlaps corridor % in currency %: enabled corridors of one currency need disjoint payee countries',
        NEW.id, other, NEW.currency USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER corridors_payee_disjoint AFTER INSERT OR UPDATE ON corridors
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION ums_corridor_payee_disjoint();

DO $$
DECLARE
  world text[] := ARRAY[
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
    'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
    'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
    'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
    'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
    'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
    'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO',
    'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI',
    'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML',
    'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC',
    'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH',
    'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA',
    'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST',
    'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
    'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN',
    'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  ]::text[];
BEGIN
  INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
  VALUES
    ('us-usd', 'USD', 2, ARRAY['*'], world, true, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('gb-gbp', 'GBP', 2, ARRAY['*'], world, true, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('de-eur', 'EUR', 2, ARRAY['*'], world, true, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')
  ON CONFLICT (id) DO UPDATE SET
    currency = EXCLUDED.currency,
    payee_countries = EXCLUDED.payee_countries,
    buyer_countries = EXCLUDED.buyer_countries,
    enabled = true,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
  VALUES
    ('in-eur', 'EUR', 2, ARRAY['*'], ARRAY['IN'], false, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('in-gbp', 'GBP', 2, ARRAY['*'], ARRAY['IN'], false, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
END
$$;
