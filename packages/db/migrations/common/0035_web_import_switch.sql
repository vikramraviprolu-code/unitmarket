-- SBX migration 0035: the web_import_enabled switch (WEB-IMPORT-SW, docs/specs/web-import-switch.md). Forward-only:
-- there is no down step. The number is the next free one on main at merge time (0034 belongs to another lane; the
-- runner applies every unapplied file in name order with no contiguity or checksum check, so either order works).
--
-- The web import (domain proof "Check my site", feed fetch, the queued run) reads a seller's website, never PayPal.
-- It used to be gated by paypal_outbound, so with PayPal closed (the normal state) it was paused and the resume
-- command, which needs an active PayPal approval, could not reopen it. It now has its own switch. A missing or
-- unreadable row reads off (the switch reader fails closed).
--
-- The eighth switch. Off at seed: nothing is fetched from a seller's site until an operator turns it on (MFA) from
-- the Controls tab. The name list is a CHECK, so the list is widened here and nowhere else; any other name stays
-- refused.
ALTER TABLE safety_switches DROP CONSTRAINT safety_switches_name_check;
ALTER TABLE safety_switches ADD CONSTRAINT safety_switches_name_check CHECK (name IN (
  'paypal_outbound', 'checkout_enabled', 'refunds_enabled', 'unlock_enabled', 'ai_enabled', 'webhook_enabled',
  'agent_buy_enabled', 'web_import_enabled'
));
-- safety_switches is a tracked table (0023). A seed row is not a request: the capture trigger is told it is a restore
-- load for this one insert (as 0023 does for a restore), and the row lands in the journal as a system/backfill
-- safety_switches.imported event, like every other seed row. A fresh database then holds no non-backfill event.
SELECT set_config('ums.trace', '{"mode":"restore"}', true);
INSERT INTO safety_switches (name, "on", changed_by, changed_at, reason, created_at, updated_at) VALUES
  ('web_import_enabled', false, 'seed', '1970-01-01T00:00:00Z', 'seed: web import off until an operator turns it on', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');
SELECT set_config('ums.trace', '', true);
SELECT trace_backfill();
