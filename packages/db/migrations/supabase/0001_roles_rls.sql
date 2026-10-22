-- SBX supabase migration 0001: roles, grants and row-level security.
-- Written in MVP-A, NOT run there (the app is the only client of PGlite and owns every table).
-- Applied only when the target is Supabase Postgres. Policies follow docs/design/architecture.md
-- section 8: every request transaction starts with
--   select set_config('ums.actor_kind', $1, true), set_config('ums.actor_id', $2, true)
-- and policies read those two settings. No Supabase-only function (auth.uid()) is used, so the
-- policies can move to auth.uid() later without a schema change. Owned by SBX lane 12.

-- 1. Roles. ums_app serves requests, ums_worker runs jobs. Neither bypasses RLS and neither is
-- postgres or service_role. Passwords are set in the hosting provider's settings, never here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ums_app') THEN
    CREATE ROLE ums_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ums_worker') THEN
    CREATE ROLE ums_worker LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- 2. Supabase's browser-facing roles get nothing. Policies do not take grants back, so revoke
-- explicitly. Skipped where the roles do not exist (PGlite, stock Postgres).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- 3. Grants: the verbs the app needs and no more.
GRANT USAGE ON SCHEMA public TO ums_app, ums_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ums_app, ums_worker;
-- Append-only tables: no UPDATE or DELETE for the app roles (the triggers are the second lock).
REVOKE UPDATE, DELETE ON
  ledger_entries, receipts, provider_calls, access_events, audit_log, outbound_approvals,
  publisher_authorisations, recovery_actions
FROM ums_app, ums_worker;
-- Approvals: insert, and set used_at once. Never delete, never change the frozen columns.
REVOKE UPDATE, DELETE ON approvals FROM ums_app, ums_worker;
GRANT UPDATE (used_at, updated_at) ON approvals TO ums_app, ums_worker;
REVOKE DELETE ON orders, order_units, entitlements, access_windows FROM ums_app, ums_worker;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM ums_app, ums_worker;

-- 4. Row-level security on every table (schema_migrations is bookkeeping, left to the owner).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- System actor (jobs, composition code acting for the platform): everything.
    EXECUTE format(
      'CREATE POLICY ums_system_all ON %I FOR ALL TO ums_app, ums_worker
         USING (current_setting(''ums.actor_kind'', true) = ''system'')
         WITH CHECK (current_setting(''ums.actor_kind'', true) = ''system'')', t);
    -- Operator (MFA checked in the app): read everything. Writes are listed below.
    EXECUTE format(
      'CREATE POLICY ums_operator_read ON %I FOR SELECT TO ums_app
         USING (current_setting(''ums.actor_kind'', true) = ''operator'')', t);
  END LOOP;
END
$$;

-- 5. Operator writes: recovery, refunds, switches, audit.
CREATE POLICY ums_operator_cases ON recovery_cases FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'operator')
  WITH CHECK (current_setting('ums.actor_kind', true) = 'operator');
CREATE POLICY ums_operator_actions ON recovery_actions FOR INSERT TO ums_app
  WITH CHECK (current_setting('ums.actor_kind', true) = 'operator');
CREATE POLICY ums_operator_refunds ON refund_requests FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'operator')
  WITH CHECK (current_setting('ums.actor_kind', true) = 'operator');
CREATE POLICY ums_operator_switches ON safety_switches FOR UPDATE TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'operator')
  WITH CHECK (current_setting('ums.actor_kind', true) = 'operator');
CREATE POLICY ums_operator_audit ON audit_log FOR INSERT TO ums_app
  WITH CHECK (current_setting('ums.actor_kind', true) = 'operator');

-- 6. Reference data readable by any signed-in actor kind.
CREATE POLICY ums_read_corridors ON corridors FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) IN ('buyer', 'publisher'));
CREATE POLICY ums_read_access_policies ON access_policies FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) IN ('buyer', 'publisher'));

-- 7. Buyer-scoped tables: buyer_id = ums.actor_id for kind buyer.
CREATE POLICY ums_buyer_self ON buyers FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_orders ON orders FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_orders_insert ON orders FOR INSERT TO ums_app
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_approvals ON approvals FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_approvals_insert ON approvals FOR INSERT TO ums_app
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_entitlements ON entitlements FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_links ON links FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_cases ON recovery_cases FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_consents ON consents FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_identity ON identity_links FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_quotes ON quotes FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_briefs ON briefs FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_buyer_proposals ON proposals FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer' AND buyer_id = current_setting('ums.actor_id', true));
-- Child tables reach the buyer through their parent.
CREATE POLICY ums_buyer_provider_orders ON provider_orders FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM orders o WHERE o.id = provider_orders.order_id AND o.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_units ON order_units FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM orders o WHERE o.id = order_units.order_id AND o.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_receipts ON receipts FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM orders o WHERE o.id = receipts.order_id AND o.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_windows ON access_windows FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM entitlements e WHERE e.id = access_windows.entitlement_id AND e.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_access_events ON access_events FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM entitlements e WHERE e.id = access_events.entitlement_id AND e.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_refunds ON refund_requests FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM order_units u JOIN orders o ON o.id = u.order_id
                WHERE u.id = refund_requests.unit_id AND o.buyer_id = current_setting('ums.actor_id', true)));
CREATE POLICY ums_buyer_refunds_insert ON refund_requests FOR INSERT TO ums_app
  WITH CHECK (current_setting('ums.actor_kind', true) = 'buyer'
    AND EXISTS (SELECT 1 FROM order_units u JOIN orders o ON o.id = u.order_id
                WHERE u.id = refund_requests.unit_id AND o.buyer_id = current_setting('ums.actor_id', true)));
-- The public catalogue: a buyer reads publishers, articles and authorised offers.
CREATE POLICY ums_buyer_catalogue_publishers ON publishers FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer');
CREATE POLICY ums_buyer_catalogue_articles ON articles FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer');
CREATE POLICY ums_buyer_catalogue_offers ON offers FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'buyer' AND status = 'authorised');

-- 8. Publisher-scoped tables: ums.actor_id is the publisher id for kind publisher.
CREATE POLICY ums_publisher_self ON publishers FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher' AND id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'publisher' AND id = current_setting('ums.actor_id', true));
CREATE POLICY ums_publisher_articles ON articles FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher' AND publisher_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'publisher' AND publisher_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_publisher_offers ON offers FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher' AND publisher_id = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'publisher' AND publisher_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_publisher_authorisations ON publisher_authorisations FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher' AND authorised_by = current_setting('ums.actor_id', true))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'publisher' AND authorised_by = current_setting('ums.actor_id', true));
CREATE POLICY ums_publisher_blobs ON content_blobs FOR ALL TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher'
    AND EXISTS (SELECT 1 FROM articles a WHERE a.content_key = content_blobs.content_key AND a.publisher_id = current_setting('ums.actor_id', true)))
  WITH CHECK (current_setting('ums.actor_kind', true) = 'publisher');
CREATE POLICY ums_publisher_units ON order_units FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher' AND publisher_id = current_setting('ums.actor_id', true));
CREATE POLICY ums_publisher_ledger ON ledger_entries FOR SELECT TO ums_app
  USING (current_setting('ums.actor_kind', true) = 'publisher'
    AND EXISTS (SELECT 1 FROM order_units u WHERE u.id = ledger_entries.unit_id AND u.publisher_id = current_setting('ums.actor_id', true)));

-- 9. System-only tables (operations, provider_calls, webhook_events, alerts, safety_switches,
-- outbound_approvals, audit_log, api_idempotency, sessions, rate_buckets) get no buyer or
-- publisher policy above, so those actors see no rows.
