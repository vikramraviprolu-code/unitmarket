-- SBX migration 0024: the indexes and the read view behind transaction search (INT-SR0, decision D-098).
-- Owned by SBX lane INT-SR0. Forward-only: there is no down step. The number is the next free one on main
-- at merge time (consolidation.md, section 2: 0023 is the trace journal, 0024 is this lane).
--
-- Adds ten indexes and one view, nothing else: no extension (no pg_trgm), no table, no column, no trigger, no
-- change to a money table or its guards. Plain SQL that runs unchanged on PGlite and stock Postgres 15+.
-- Four indexes the search proposal listed already exist as constraints or indexes and are not repeated:
-- order_units (order_id) is UNIQUE (order_id, reference_id) in 0004, entitlements (unit_id) is UNIQUE
-- (unit_id, article_id) in 0005, provider_orders (order_id) is UNIQUE (order_id, position) in 0011, and the
-- mandate link is mandate_reservations_order_idx in 0021. sort=amount and sort=status have no index: they are
-- always bounded by a date range and are not in the plan test.

-- "My orders, newest first", operator time scans, and the orders that need attention.
CREATE INDEX orders_buyer_time ON orders (buyer_id, created_at DESC, id DESC);
CREATE INDEX orders_time ON orders (created_at DESC, id DESC);
CREATE INDEX orders_attention ON orders (created_at DESC) WHERE status IN ('unresolved', 'frozen');

-- A seller's lines, and the unit states that need attention.
CREATE INDEX order_units_pub_time ON order_units (publisher_id, created_at DESC, id DESC);
CREATE INDEX order_units_problem ON order_units (updated_at DESC)
  WHERE status IN ('pending', 'mismatch', 'reversal_suspected');

-- The lateral joins and counts of the view, one index each.
CREATE INDEX refund_requests_unit ON refund_requests (unit_id, created_at DESC, id DESC);
CREATE INDEX recovery_cases_order ON recovery_cases (order_id, created_at DESC, id DESC);
CREATE INDEX ledger_entries_unit ON ledger_entries (unit_id);
CREATE INDEX entitlements_buyer ON entitlements (buyer_id, created_at DESC);
CREATE INDEX alerts_order ON alerts (order_id);

-- txn_rows: one row per order unit, for the buyer, seller and operator lists. The money tables stay
-- untouched and no write path feeds it. security_invoker makes it run with the caller's rights, so a row
-- level policy on the tables below still applies to a reader of the view (Postgres 15+). The application
-- scope (domain/txn-search) stays the main control: a buyer or seller query always pins its own id, and the
-- seller projection leaves out the buyer columns and the order total.
--   titles            the article titles of the unit (entitlements), in title order; empty when none
--   provider_order_id the PayPal order of the unit: provider_orders.id = order_units.provider_order_ref, so a
--                     single-route order (no publisher on its provider order) and each line of a split order
--                     both carry theirs
--   refund_*          the latest refund request of the unit by (created_at, id)
--   case_*            the latest recovery case of the order by (created_at, id)
--   The seller, buyer, provider order, refund, case and mandate columns are scalar subqueries, not joins. A
--   query that does not name one of them does not pay for it: txn-search first picks the page ids from the
--   few columns its filters and sort need, then reads the full columns for those ids. Every key they read is
--   a NOT NULL foreign key or a primary key, so a subquery gives the same value a join would.
--   channel           'agent' when a mandate reservation holds this order, else 'human'
CREATE VIEW txn_rows WITH (security_invoker = true) AS
SELECT
  u.id AS unit_id,
  o.id AS order_id,
  o.order_ref,
  right(o.order_ref, 6) AS order_ref6,
  o.status AS order_status,
  o.mismatch AS order_mismatch,
  u.status AS unit_status,
  u.updated_at AS unit_updated_at,
  o.created_at,
  u.captured_verified_at,
  o.currency,
  u.amount_minor,
  o.total_minor AS order_total_minor,
  u.refunded_minor,
  o.environment,
  u.publisher_id,
  (SELECT p.display_name FROM publishers p WHERE p.id = u.publisher_id) AS seller_name,
  (SELECT p.slug FROM publishers p WHERE p.id = u.publisher_id) AS seller_slug,
  (SELECT po.provider_order_id FROM provider_orders po WHERE po.id = u.provider_order_ref) AS provider_order_id,
  u.capture_id,
  o.buyer_id,
  (SELECT b.display_name FROM buyers b WHERE b.id = o.buyer_id) AS buyer_display_name,
  ARRAY(
    SELECT a.title
      FROM entitlements e
      JOIN articles a ON a.id = e.article_id
     WHERE e.unit_id = u.id
     ORDER BY a.title
  ) AS titles,
  (SELECT r.state FROM refund_requests r WHERE r.unit_id = u.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS refund_state,
  (SELECT r.refund_id FROM refund_requests r WHERE r.unit_id = u.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS refund_id,
  (SELECT r.amount_minor FROM refund_requests r WHERE r.unit_id = u.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS refund_amount_minor,
  (SELECT c.state FROM recovery_cases c WHERE c.order_id = o.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS case_state,
  (SELECT c.kind FROM recovery_cases c WHERE c.order_id = o.id ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS case_kind,
  (SELECT count(*)::int FROM alerts al WHERE al.order_id = o.id) AS alert_count,
  EXISTS (SELECT 1 FROM operations op WHERE op.order_id = o.id AND op.state = 'unknown') AS has_unknown_op,
  CASE WHEN EXISTS (SELECT 1 FROM mandate_reservations mr WHERE mr.order_id = o.id) THEN 'agent' ELSE 'human' END AS channel,
  (SELECT m.agent_key_id FROM mandates m WHERE m.id = (
     SELECT r.mandate_id FROM mandate_reservations r WHERE r.order_id = o.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1
  )) AS agent_key_id,
  (SELECT r.mandate_id FROM mandate_reservations r WHERE r.order_id = o.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS mandate_id
FROM order_units u
JOIN orders o ON o.id = u.order_id;
