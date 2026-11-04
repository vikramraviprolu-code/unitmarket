-- SBX migration 0017: fx_rates (MC2-L4, D-084 items 4, 5 and 8, D-085). Owned by SBX lane MC2-L4.
-- Forward-only: there is no down step. Adds one table and its seed rows; no change to any other table.
--
-- fx_rates: the euro reference rates, one row per ECB date and quote. base is always EUR and quote is
-- USD or GBP, so 1 EUR = rate quote. A cross rate (GBP to USD) is derived from the two rows of ONE date,
-- never stored. `date` is the date the ECB publishes the rate for; `fetched_at` is when this app stored
-- it (from the injected Clock). `source` is 'ecb' for a stored fetch and 'seed' for the rows below.
-- rate is numeric(12,6) and above zero; the ECB gives at most four decimals for these two currencies.
--
-- APPEND-ONLY: no UPDATE, no DELETE, no TRUNCATE (the same guard as the ledger). A new day is a new row;
-- the newest date wins. Display and reporting figures built on these rows are labelled "about" with the
-- rate date (D-085); PayPal converts a real payment at its own rate.
--
-- SEED ROWS (source = 'seed'): one set of round numbers for one recent ECB date, so a fresh database has a
-- rate before the first fetch. They are made-up placeholders, NOT real ECB publications. fetched_at is a
-- fixed instant (migrations take no clock), so a fresh database counts as stale and the first page that
-- needs a rate fetches the real one. A seed row is replaced in use by any newer ECB row; it is never edited.
--
-- No defaults: the writer states every value. System only: the server reads and writes it with its own
-- connection; the table holds no personal data. The Supabase policy is a listed follow-up (Supabase is
-- unused, D-049).
CREATE TABLE fx_rates (
  date date NOT NULL,
  base text NOT NULL CHECK (base = 'EUR'),
  quote text NOT NULL CHECK (quote IN ('USD', 'GBP')),
  rate numeric(12, 6) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (source IN ('ecb', 'seed')),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (date, quote)
);
CREATE TRIGGER fx_rates_append_only BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER fx_rates_no_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- Seed: 2026-11-03 (a Tuesday, an ECB working day). 1 EUR = 1.15 USD, 1 EUR = 0.87 GBP. Round numbers.
INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at) VALUES
  ('2026-11-03', 'EUR', 'USD', 1.15, 'seed', '2026-11-03T16:00:00Z'),
  ('2026-11-03', 'EUR', 'GBP', 0.87, 'seed', '2026-11-03T16:00:00Z');
