# Integrated story and tamper demo (INT-E2E)

The whole UnitMarket story, offline, in dry-run mode. Nothing reaches PayPal or any network. The proof is `tests/int/` (spec `int-e2e.md`).

## Run it

```
corepack pnpm vitest run tests/int/integrated-story.integration.test.ts tests/int/offline.adversarial.test.ts
corepack pnpm vitest run tests/int/tamper.adversarial.test.ts scripts/demo-tamper.test.ts
node --env-file-if-exists=.env.local scripts/demo-tamper.mjs
```

The demo script needs the offline env the app needs (`UMS_MODE=offline` and the three `UMS_*_SECRET` values). It refuses any database except `pglite-memory` with exit 2, and it never opens or creates another one.

## The story, step by step, and what each screen shows

| Step | What happens                                                                                                                                                                  | Where to see it                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1    | A buyer finds two articles from two sellers with discovery and pays for both as a person (order P1, two PayPal orders)                                                        | Buyer, order page of P1: two items, both ready. Timeline: "You" placed the order, both items captured    |
| 2    | The buyer makes an agent key                                                                                                                                                  | Buyer, Keys: one agent key. Ops, Activity, chain `key:<id>`: buyer created it                            |
| 3    | An operator with the second factor turns agent buying on                                                                                                                      | Ops, Controls: agent buying on. Activity, chain `plat`: operator, MFA                                    |
| 4    | The buyer gives the key a cap: $5.00 and 10 purchases                                                                                                                         | Buyer, Agents: the cap with 10 purchases left                                                            |
| 5    | The agent buys three $0.10 units over MCP (A1 to A3)                                                                                                                          | Ops, order timeline of each: agent, mcp, on behalf of the buyer, under the cap                           |
| 6    | The buyer downloads A1                                                                                                                                                        | Buyer, timeline of A1: "A link to the item was issued"                                                   |
| 7    | An operator with the second factor refunds P1's second item                                                                                                                   | Buyer, order page of P1: one item refunded. Ops timeline: refund requested and completed by the operator |
| 8    | A second person order (P2) stays pending. A `payment_unresolved` alert is raised for it, acknowledged by the operator, and closed by the system once a job pass finds P2 paid | Ops, Alerts: acknowledged, then auto-resolved. Activity, chain of P2                                     |
| 9    | The agent buys six more (9 of 10). The next job pass raises "cap nearly used"                                                                                                 | Ops, Alerts: `mandate_near_cap`                                                                          |
| 10   | The 10th purchase uses the cap up. The next pass closes the near-cap alert                                                                                                    | Buyer, Agents: cap used up. Ops, Alerts: auto-resolved                                                   |
| 11   | The 11th purchase is refused (`cap_exhausted`) and no money row is written                                                                                                    | Agent answer: cap_exhausted. Buyer: no new order                                                         |
| 12   | The operator makes an `ops:read` key, and the seller makes a `sales:read` key                                                                                                 | Activity: two key rows                                                                                   |

After the story:

- The journal table holds exactly.
- No seller answer and no operator API answer shows the buyer, the agent key, request ids, address hashes or PayPal ids.
- No journal row lacks an actor.
- `trace:verify` exits 0.

## The tamper demo, for the video

`scripts/demo-tamper.mjs` makes one purchase on a fresh in-memory database, then runs three steps.

1. **Ledger edit.** It turns off the ledger guards and changes one amount behind the app's back. Verify exits 1 and prints `drift ledger_entries <id> amount_minor`.
2. **Ledger restored.** It puts the amount back and turns the guards on again. Verify exits 0.
3. **Journal edit.** It rewrites one row of the journal itself. Verify exits 1 and names that row's chain and seq. When the row is put back, verify exits 0.

Each step prints one plain sentence and the verifier's lines. The last line reads "demo done: every edit was caught, and every restore came back clean".
