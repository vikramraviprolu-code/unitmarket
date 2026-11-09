-- SBX migration 0033: the India USD corridor (COR-IN, docs/specs/db-in-usd-corridor.md).
-- Owned by SBX lane COR-IN. Forward-only: there is no down step. No table or column changes; one seed row.
--
-- Until now one corridor is on, us-usd (payee US). A publisher whose payee country is India could not set prices.
-- This row lets an India publisher price and sell in USD to buyers anywhere (buyer_countries '*', buyer country is
-- data, not a gate) except India: domestic_supported is false, and the offer entry refuses a buyer whose country
-- equals the publisher's country. Enabled on arrival; the owner decided on 9 Nov 2026 ("go on the India corridor,
-- outside india buyers only").
--
-- The timestamps are the fixed seed constant of 0001 because migrations take no clock. ON CONFLICT DO NOTHING:
-- a row that already exists (a seed, or an operator's switch) is never overwritten. No other corridor row changes.
INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
VALUES ('in-usd', 'USD', 2, ARRAY['*'], ARRAY['IN'], false, NULL, true, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;
