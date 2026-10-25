-- SBX migration 0010: publishers may share one payee merchant id only when both carry the explicit
-- payee_shared flag (MVP-D, DP-1, decision D-041). Owned by SBX lane DP-1. Forward-only.
-- Under D-041 both fictional publishers are paid into the owner's own sandbox Business account, so two
-- publisher rows hold the same merchant id. The publisher row stays the unit of attribution.
--
-- The flag is false for every existing row and is never set by a route or a buyer; only the audited
-- seeding step of DP-5 sets it. The plain UNIQUE on paypal_merchant_id (publishers_paypal_merchant_id_key)
-- is dropped and replaced by a unique index over the unflagged rows. That index alone would still let one
-- flagged and one unflagged row share an id, so a row trigger refuses any pair that is not flagged on
-- both sides, on INSERT and on UPDATE, with the same unique_violation (23505).
ALTER TABLE publishers ADD COLUMN payee_shared boolean NOT NULL DEFAULT false;

ALTER TABLE publishers DROP CONSTRAINT publishers_paypal_merchant_id_key;

CREATE UNIQUE INDEX publishers_merchant_unshared ON publishers (paypal_merchant_id) WHERE NOT payee_shared;

-- SECURITY DEFINER with search_path = pg_catalog, pg_temp: the check must see every publisher row, also when
-- row-level security (the supabase set) would hide other publishers from the calling role, and a temporary
-- table named publishers must not shadow the real one (every table below is schema-qualified as well).
-- The check is correct under READ COMMITTED and SERIALIZABLE. A REPEATABLE READ writer can race (the second
-- writer commits a mixed pair), so the trigger refuses a REPEATABLE READ writer with serialization_failure.
CREATE FUNCTION ums_publisher_payee_guard() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.paypal_merchant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'publishers: a merchant id cannot be written under REPEATABLE READ'
      USING ERRCODE = 'serialization_failure';
  END IF;
  -- One merchant id at a time: two concurrent writers of the same id cannot both pass the check below.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ums.publishers.merchant:' || NEW.paypal_merchant_id, 0));
  IF EXISTS (
    SELECT 1 FROM public.publishers p
     WHERE p.paypal_merchant_id = NEW.paypal_merchant_id
       AND p.id <> NEW.id
       AND NOT (p.payee_shared AND NEW.payee_shared)
  ) THEN
    RAISE EXCEPTION 'merchant id is already held by another publisher; both rows need payee_shared'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publishers_payee_guard BEFORE INSERT OR UPDATE OF paypal_merchant_id, payee_shared ON publishers
  FOR EACH ROW EXECUTE FUNCTION ums_publisher_payee_guard();
