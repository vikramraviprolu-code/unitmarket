-- SBX migration 0013: publisher applicants (PUB-E2, proposal 3A and 3I). Owned by SBX lane PUB-E2.
-- Forward-only: there is no down step. Adds one table and nothing else: no change to publishers (the 0012
-- CHECK has no 'rejected' status, so a rejection is a decision row and the publisher stays 'applied'), to the
-- ledger, orders, units, approvals, the payee tables or the Supabase set (the policy for the new table is a
-- listed follow-up, Supabase is unused, D-049).
--
-- publisher_applicant_decisions: the operator's one answer to one applicant. At most one per publisher
-- (UNIQUE), append-only like payee_decisions, no defaults.
CREATE TABLE publisher_applicant_decisions (
  id ums_id PRIMARY KEY,
  publisher_id ums_id NOT NULL UNIQUE REFERENCES publishers (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  operator_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TRIGGER publisher_applicant_decisions_append_only BEFORE UPDATE OR DELETE ON publisher_applicant_decisions
  FOR EACH ROW EXECUTE FUNCTION ums_deny_mutation();
CREATE TRIGGER publisher_applicant_decisions_no_truncate BEFORE TRUNCATE ON publisher_applicant_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION ums_deny_truncate();
