-- SBX migration 0018: buyers.display_currency (MC2-L5, D-084 item 4). Owned by SBX lane MC2-L5.
-- Forward-only: there is no down step. Adds one column to buyers; no change to any other table or column.
--
-- display_currency: the currency a buyer chose, in the account page, for the "about" figures shown beside the
-- binding seller amount. USD, EUR or GBP, or NULL. NULL means no choice: the screens derive it from the
-- buyer's country (US USD, GB GBP, DE EUR; any other country sees the seller's currency without conversion).
-- Nothing is stored for a buyer who never chose. The column is a display preference only: no order, approval,
-- quote, ledger entry or receipt reads it, and no stored amount is ever converted (D-084 items 2 and 4).
-- No default: the writer states the value, and NULL is the absence of a choice.
ALTER TABLE buyers ADD COLUMN display_currency text CHECK (display_currency IN ('USD', 'EUR', 'GBP'));
