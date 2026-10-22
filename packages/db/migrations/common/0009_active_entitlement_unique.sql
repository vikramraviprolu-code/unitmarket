-- SBX migration 0009: one active entitlement per buyer and article (FIX-05A H3). Owned by SBX lane 05a.
-- An article is held while its money is pending, unknown or captured and its access is locked or
-- available (locked includes a capture in flight and access paused by the unlock switch). Denied,
-- refunded and reversed money, and ended or revoked access, free the article for a new purchase.
-- placeOrder (domain/payments) and startFromOffer (domain/offer-entry) test the same set before
-- this index is reached; the index is what stops two requests that race past those checks.
-- Existing data: refuse the migration with a clear error if duplicates already exist, instead of
-- failing on an index build message.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entitlements
     WHERE money_state IN ('pending', 'captured', 'unknown') AND access_state IN ('locked', 'available')
     GROUP BY buyer_id, article_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 0009: a buyer holds the same article twice; resolve the duplicates first';
  END IF;
END
$$;

CREATE UNIQUE INDEX entitlements_one_active_per_buyer_article
  ON entitlements (buyer_id, article_id)
  WHERE money_state IN ('pending', 'captured', 'unknown') AND access_state IN ('locked', 'available');
