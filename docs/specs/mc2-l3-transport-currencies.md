# Spec: the sealed transport may move all three currencies in every scope (MC2-L3)

Task: allow USD, EUR and GBP in both approval scopes.
Package: `packages/transport` (`src/sandbox.ts`, `src/sandbox.binding.test.ts`) Owner: Sonnet builder Reviewer: Opus (security read), then the coordinator merges
Branch: `feat/mc2-l3-transport-currencies` Commit: `feat(transport): USD, EUR and GBP in every scope (MC2-L3)` Decision: D-084 (1)

Goal: `SCOPE_CURRENCIES` becomes `{ mvp_b_polling: ['USD','EUR','GBP'], mvp_c_refunds: ['USD','EUR','GBP'] }`. JPY, XAU and any other code stay
refused. Nothing else changes: the gate, the amount binding, payee rules (`PAYEE_SCOPES`), the operation list, the host constant and the five locks.
A refund keeps the currency of the capture it refunds.

Acceptance tests (tests first, commit 1 red):

- create_order and refund bodies in EUR and in GBP are sent under both scopes; USD unchanged.
- JPY, XAU, INR and a lowercase `eur` are still refused before any send, in both scopes.
- The pin test now reads `{ mvp_b_polling: ['USD','EUR','GBP'], mvp_c_refunds: ['USD','EUR','GBP'] }`.
- `pnpm check:no-live-host`, `pnpm lint && pnpm typecheck && pnpm test` pass; show the output.
  Do not: touch endpoints, the sandbox host, locks, approvals, other packages; run any sandbox call.
