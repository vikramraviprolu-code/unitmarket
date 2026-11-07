-- SBX migration 0032: one verified PayPal address belongs to one publisher (POB-LINKU, D-089 item 1).
-- Owned by SBX lane POB-LINKU. Forward-only: there is no down step. No table, column or row changes; one index.
--
-- The address in publisher_paypal_links is where a publisher is paid. A verified payout destination must belong
-- to exactly one publisher, so at most one `verified` link may exist per address, compared as
-- lower(btrim(paypal_email)) (the application already stores it trimmed and lower case). Several `requested`
-- links may share an address: a request proves nothing, and a publisher is never told an address is taken. The
-- refusal happens when an operator verifies (domain/catalogue paypal-link.ts, error email_in_use); this index is
-- the last line, and it also settles two operators verifying at the same moment.
--
-- Safe on a database that already holds duplicates. The DO block below runs first and counts the verified
-- addresses held by more than one publisher. If there are any it raises an exception that names the two counts
-- (never an address), so the deploy fails closed before anything is created. The migration runner applies each
-- file in one transaction and records it only on success, so a refusal leaves no index, no schema_migrations
-- row and nothing half done. The owner clears the duplicates (one of each group goes back to `requested` after a
-- decision about who owns the account) and runs the migration again. The read only pre-check, which returns
-- counts and no address, is in docs/specs/catalogue-paypal-link-unique.md.
--
-- Ordering: independent of 0031 (trace tracking, another lane). This file touches only publisher_paypal_links,
-- and the runner applies every unapplied file in name order, so the two may merge in either order.
DO $guard$
DECLARE
  shared_addresses bigint;
  rows_involved bigint;
BEGIN
  SELECT count(*), coalesce(sum(n), 0) INTO shared_addresses, rows_involved
    FROM (
      SELECT count(*) AS n
        FROM publisher_paypal_links
       WHERE state = 'verified'
       GROUP BY lower(btrim(paypal_email))
      HAVING count(*) > 1
    ) d;
  IF shared_addresses > 0 THEN
    RAISE EXCEPTION
      'publisher_paypal_links: % verified PayPal addresses are each held by more than one publisher (% rows). Resolve them first. Nothing was changed.',
      shared_addresses, rows_involved
      USING ERRCODE = 'unique_violation',
            HINT = 'Run the read only pre-check in docs/specs/catalogue-paypal-link-unique.md.';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX publisher_paypal_links_verified_email_key
  ON publisher_paypal_links (lower(btrim(paypal_email)))
  WHERE state = 'verified';
