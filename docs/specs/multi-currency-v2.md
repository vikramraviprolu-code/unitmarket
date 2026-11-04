# Spec: three transaction currencies, buyer-currency display, USD/EUR/GBP reporting (MC-V2 umbrella)

Decisions: D-083 (seller choice), D-084 (the rules), D-085 (rate source). This page is the plan; each lane has its own spec and branch.
Owner: coordinator Reviewer: Vikram. Freeze: lifted by the owner for this work (D-079, D-084).

Rules in one place (D-084): an offer's currency is its publisher's country currency (US USD, GB GBP, DE EUR) and is the only
transaction currency, through order, capture, refund, ledger and receipt. A buyer from any country may buy any offer; buyer
country is data, not a gate. Lists, quotes and the approve page show the buyer's own currency at the stored rate, labelled
"about" with the rate date, with the binding seller-currency amount beside it; the approval binds only the seller amount.
Reporting totals show USD, EUR and GBP at the latest stored rate. One `fx_rates` table serves display and reporting.

Lanes (wave 1 can run in parallel; each touches different packages):

| Lane | Spec                                                                     | Package                                  | Wave |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------- | ---- |
| L1   | `mc2-l1-buyer-country-gate.md`                                           | domain/discovery, offer-entry, approval  | 1    |
| L2   | `mc2-l2-de-eur-corridor.md`                                              | domain/catalogue (seed), a German seller | 1    |
| L3   | `mc2-l3-transport-currencies.md`                                         | packages/transport                       | 1    |
| L4   | fx table, ECB fetch (transport), convert function                        | db, transport, new domain/fx             | 2    |
| L5   | buyer display, agent ceiling on converted price                          | apps/web, domain/discovery               | 2    |
| L6   | state "awaiting seller acceptance" for a pending capture                 | domain/payments, apps/web                | 2    |
| L7   | reporting totals in USD, EUR, GBP on the operations screen               | apps/web, domain/publisher-console       | 2    |
| L8   | demo-prices filter, browser checks, deploy notes, egress allow-list step | docs, infra/gcp                          | 3    |

Then one real sandbox sitting (GBP and EUR orders of about 1.50), only after the owner's dashboard checks and a new approval row.
Not in scope: direct payee settlement, other eurozone sellers, automatic scheduled rate refresh, real conversion of any money.
