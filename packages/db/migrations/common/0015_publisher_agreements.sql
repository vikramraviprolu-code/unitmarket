-- SBX migration 0015: publisher agreements (AGREE-1, memo Q1 and Q27). Owned by SBX lane AGREE-1.
-- Forward-only: there is no down step. Adds one table and nothing else: no change to publishers, orders,
-- the ledger, units, approvals or the Supabase set (the policy for the new table is a listed follow-up,
-- Supabase is unused, D-049). 0014 belongs to PUB-E1 and is not required.
--
-- publisher_agreements: the record that a demo publisher accepted a version of the publisher terms.
-- Append-only, no defaults. Written only by the boot seed (method seeded_demo); there is no click-through
-- and no route that writes it. At most one row per publisher and terms version (UNIQUE), so a later
-- version is a new row and the old one stays. accepted_by_label is a demo label, not a person.
CREATE TABLE publisher_agreements (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL REFERENCES publishers (id),
  terms_version text NOT NULL CHECK (length(terms_version) > 0),
  accepted_at timestamptz NOT NULL,
  accepted_by_label text NOT NULL CHECK (length(accepted_by_label) > 0),
  method text NOT NULL CHECK (method IN ('seeded_demo')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (publisher_id, terms_version)
);
CREATE TRIGGER publisher_agreements_append_only BEFORE UPDATE OR DELETE ON publisher_agreements
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER publisher_agreements_no_truncate BEFORE TRUNCATE ON publisher_agreements
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
