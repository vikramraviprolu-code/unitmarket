-- SBX migration 0011: one PayPal order per publisher, each with its own state (MVP-D, DP-2a, route D2).
-- Owned by SBX lane DP-2a. Forward-only; no clock, no default.
--
-- provider_orders gains position (1..N, ordered by publisher id), po_ref (the reference of this PayPal
-- order: the order_ref for a single order, <order_ref>-p<position> otherwise), publisher_id, state (the
-- engine's own state machine for the PayPal order; `status` stays PayPal's last-seen text) and
-- first_approved_at (the moment UnitMarket first saw an APPROVED read, not PayPal's time).
-- operations gains provider_order_ref: the PayPal order an operation belongs to (null for refunds).
--
-- Columns are added nullable, backfilled from the existing rows only, then made NOT NULL.
ALTER TABLE provider_orders ADD COLUMN position integer;
ALTER TABLE provider_orders ADD COLUMN po_ref ums_id;
ALTER TABLE provider_orders ADD COLUMN publisher_id ums_id REFERENCES publishers (id);
ALTER TABLE provider_orders ADD COLUMN state text;
ALTER TABLE provider_orders ADD COLUMN first_approved_at timestamptz;
ALTER TABLE operations ADD COLUMN provider_order_ref ums_id REFERENCES provider_orders (id);

-- Backfill. An old row is a single-route PayPal order: position 1, po_ref = order_ref, no publisher, and
-- the state its order status maps to (created -> prepared, paid and paid_partial -> captured, the rest
-- by name). A legacy order with several rows keeps the first at position 1 and numbers the others.
UPDATE provider_orders p
   SET position = r.pos,
       po_ref = CASE WHEN r.pos = 1 THEN o.order_ref ELSE o.order_ref || '-p' || r.pos END,
       publisher_id = CASE WHEN p.route = 'single' THEN NULL
                           ELSE (SELECT min(u.publisher_id) FROM order_units u WHERE u.provider_order_ref = p.id) END,
       state = CASE o.status
                 WHEN 'created' THEN 'prepared'
                 WHEN 'awaiting_buyer' THEN 'awaiting_buyer'
                 WHEN 'capture_requested' THEN 'capture_requested'
                 WHEN 'capture_claimed' THEN 'capture_claimed'
                 WHEN 'unresolved' THEN 'unresolved'
                 WHEN 'paid' THEN 'captured'
                 WHEN 'paid_partial' THEN 'captured'
                 WHEN 'failed' THEN 'failed'
                 WHEN 'abandoned' THEN 'abandoned'
                 WHEN 'frozen' THEN 'frozen'
               END
  FROM orders o,
       (SELECT id, row_number() OVER (PARTITION BY order_id ORDER BY created_at, id) AS pos FROM provider_orders) r
 WHERE o.id = p.order_id AND r.id = p.id;

-- The create, capture and read-back operations of an existing order belong to its first PayPal order.
UPDATE operations op
   SET provider_order_ref = p.id
  FROM provider_orders p
 WHERE p.order_id = op.order_id AND p.position = 1 AND op.kind IN ('create', 'capture', 'readback');

ALTER TABLE provider_orders ALTER COLUMN position SET NOT NULL;
ALTER TABLE provider_orders ALTER COLUMN po_ref SET NOT NULL;
ALTER TABLE provider_orders ALTER COLUMN state SET NOT NULL;

ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_position_check CHECK (position >= 1);
ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_order_position_key UNIQUE (order_id, position);
ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_po_ref_key UNIQUE (po_ref);
-- A publisher has one PayPal order per order. A single-route row has no publisher (NULLs are distinct).
ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_order_publisher_key UNIQUE (order_id, publisher_id);
ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_route_publisher_check
  CHECK (route = 'single' OR publisher_id IS NOT NULL);
ALTER TABLE provider_orders ADD CONSTRAINT provider_orders_state_check CHECK (state IN (
  'prepared', 'awaiting_buyer', 'approved', 'capture_requested', 'capture_claimed', 'unresolved',
  'captured', 'declined', 'frozen', 'failed', 'abandoned'
));
