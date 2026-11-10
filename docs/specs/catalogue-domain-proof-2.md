# Spec: web import site proof, round 2 (DOMAIN-PROOF-2)

Task: one permanent code per publisher, an operator vouch, removal of an address, and a truthful "could not reach" message.
Package: `domain/catalogue` (domain-proof, import-stage, import-types), `packages/db` (migration 0037), `apps/web` (routes, publisher import page, Operations publishers page, copy). Owner: builder (Sonnet). Reviewer: other than the author.
Branch: `feat/catalogue-domain-proof-2` Commit: `type(<package>): <what> (DOMAIN-PROOF-2)`. Decision: owner approved on 10 Nov 2026 ("go, A+B plus remove address"); recorded as D-116.

Goal: a publisher whose site address changes (a temporary tunnel) no longer needs a new code per address, an operator can vouch for an address, and dead addresses can be removed. Nothing here touches PayPal, approval, payments, ledger or entitlements.

Behaviour:

- A. Table `publisher_proof_codes` (publisher_id PK, code UNIQUE, created_at). The code is `umv-<nonce>`, made the first time the publisher asks (code page or first address), stored in clear (it is a public value), never logged or put in an audit row. The publisher import page shows it at any time with "Put this code once on each of your sites". `requestDomain` for a new address stores the hash of this code; the answer carries the code. `proveDomain` and the import-start re-check accept the row's own hash OR the hash of the publisher's permanent code, so old per-address rows keep working. Two publishers never share a code. No route or view returns another publisher's code.
- B. `publisher_domains` gains `verified_by` (`proof` or `operator`, null on old rows = proof), `vouched_by`, `vouch_reason`. Operator vouch: operator with the second factor and a reason (3 to 200 chars) sets a pending row verified with those markers and writes audit `domain.vouched`. The import-start re-check does not fetch the code for an operator-vouched row (the switch and the item fetches are unchanged). The publisher sees "Verified by UnitMarket".
- C. State `removed` (soft). Publisher (own address, by host) or operator (second factor and reason) removes a pending or verified address; audit `domain.removed`. Removed rows do not count toward the 10, free the host, cannot begin an import, and are not listed. Removal is refused while an import from that host is queued or running. Published offers stay on sale. Asking for a removed host again makes it pending again.
- D. Import start: a re-check that could not read the site answers `site_unreachable` ("We could not reach your site at that address. Check that it is online."); a read page without the code still answers `proof_lost`.
- Migration `0037_domain_proof_2.sql`: additive; widens the state CHECK, replaces the verified_at CHECK and the guard trigger (verified may become removed, nothing else changes). No tracked (0023) table is written.

Do not: touch PayPal, approval, payments, ledger, entitlements, safety; add a dependency; put a code or secret in a log or audit row.

Acceptance tests (commit 1 red, commit 2 green; one vitest command at a time):

- `corepack pnpm vitest run domain/catalogue/src/domain-proof-2.state.test.ts`: permanent code reused across two addresses and proves both; old tokens still prove; vouch needs operator, second factor and reason, audits, and import start skips the code fetch; removal frees slot and host, blocks import, audits; unreachable vs missing copy codes; other publisher cannot claim a verified host.
- `corepack pnpm vitest run packages/db/src/migration-0037.state.test.ts`: columns, CHECKs, guard.
- `corepack pnpm vitest run apps/web/src/domain-proof-2.state.test.ts`: routes (publisher vouch refused, operator without second factor 403), page source, copy strings.
- `corepack pnpm vitest run apps/web/src/domain-proof-2.adversarial.test.ts`: no publisher sees or uses another's code; no PayPal, approval, payments or ledger row changes.

Evidence for the PR: red run, green run, every check with counts, edited existing tests with reasons, owner steps after deploy.
