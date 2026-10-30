-- SBX migration 0012: the publisher side (PUB-A1, decisions D-065 items 27 and 34). Owned by SBX lane PUB-A1.
-- Forward-only: there is no down step. No change to the ledger, orders, units, operations, migration 0010 or
-- its payee guard, or the Supabase set (Supabase is unused, D-049; the policies for the new tables are a
-- listed follow-up).
--
-- 1. publishers.status. Every existing row is active. The one allowed DEFAULT of this file.
ALTER TABLE publishers ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('applied', 'active', 'suspended'));

-- 2. payee_change_requests: a publisher asks to be paid into another merchant id. Append-only, like the
-- other history tables of 0001: a request is never edited or removed. A request is open while it has no
-- row in payee_decisions.
CREATE TABLE payee_change_requests (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  requested_merchant_id ums_id NOT NULL,
  note text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER payee_change_requests_append_only BEFORE UPDATE OR DELETE ON payee_change_requests
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER payee_change_requests_no_truncate BEFORE TRUNCATE ON payee_change_requests
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- 3. payee_decisions: the operator's answer to one request. At most one per request (UNIQUE), append-only.
CREATE TABLE payee_decisions (
  id ums_id PRIMARY KEY,
  request_id ums_id NOT NULL UNIQUE REFERENCES payee_change_requests (id),
  decision text NOT NULL CHECK (decision IN ('verified', 'rejected')),
  operator_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER payee_decisions_append_only BEFORE UPDATE OR DELETE ON payee_decisions
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER payee_decisions_no_truncate BEFORE TRUNCATE ON payee_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();

-- 4. The attestation text version a publisher accepted when authorising an offer. NULL for existing rows.
-- Adding a column fires no row trigger, so the append-only guard on publisher_authorisations is untouched.
ALTER TABLE publisher_authorisations ADD COLUMN attestation_version text;

-- 5. articles.created_by (NULL for existing rows) and the content freeze: while an authorised offer uses
-- an article, the bytes it was authorised against (sha256, content_key) cannot change. A write that sets a
-- column to the value it already has changes nothing and is allowed. SECURITY DEFINER with a fixed
-- search_path, as in 0010, so the check sees every offer also under row-level security.
ALTER TABLE articles ADD COLUMN created_by text;

CREATE FUNCTION ums_article_content_frozen() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.content_key IS DISTINCT FROM OLD.content_key)
     AND EXISTS (
       SELECT 1 FROM public.offers o WHERE o.article_id = OLD.id AND o.status = 'authorised'
     ) THEN
    RAISE EXCEPTION 'articles: sha256 and content_key cannot change while an authorised offer uses the article'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER articles_content_frozen BEFORE UPDATE OF sha256, content_key ON articles
  FOR EACH ROW EXECUTE FUNCTION ums_article_content_frozen();
