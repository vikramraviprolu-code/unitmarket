# Spec: the German euro corridor and a German seller (MC2-L2)

Task: add corridor `de-eur` and a fictional German publisher with offers in EUR, switched off by default like `gb-gbp`.
Package: `domain/catalogue` (`src/seed-data.ts`, `src/seed.ts`, related seed tests; payee seeding only as the existing pattern requires) Owner: Sonnet builder Reviewer: Opus, then the coordinator merges
Branch: `feat/mc2-l2-de-eur-corridor` Commit: `feat(catalogue): de-eur corridor and a German seller, off by default (MC2-L2)` Decision: D-084 (6)

Goal: seed data gains corridor `de-eur` (currency EUR, minor units 2, payee countries `['DE']`, `buyer_countries: ['*']` as a documentation
value, domestic supported, `enabled: false`), one fictional publisher with country `DE`, and two or three team-written articles with offers
in EUR (prices 1.00 to 2.00 EUR, the same two options as the others). A booted live database must receive the corridor, publisher and offers
without a migration: confirm in `seed.ts` that corridor, publisher and offer inserts are idempotent for existing databases, say so in the PR, and
add a test that runs the seed twice and once on a database that already holds the old seed. Payee: follow the existing `seedSandboxPayees` pattern
(D-041, migration 0010 guard) so the new publisher is `payee_shared` with the owner's sandbox account like the others; do not invent ids.

Inputs: `seed-data.ts`, `seed.ts`, `seed-lock.ts` (keep the advisory lock), migration 0010. Outputs: seed data and code, tests, one line in `docs/PROVENANCE.md` if a copied file is added.
Do not: enable the corridor, touch the transport, contracts, other packages, real names or real content, any credential.

Acceptance tests (tests first, commit 1 red):

- After seed, `de-eur` exists, `enabled` is false; the German publisher and its EUR offers exist and are authorised and current.
- With `de-eur` enabled in a test, a US buyer can be quoted and approved the EUR offer (needs MC2-L1; if L1 is not merged, mark that test skipped with a reference and say so).
- Seeding twice, and seeding over the previous seed, leaves counts unchanged and loses nothing; the race test in `seed-lock.state.test.ts` still passes.
- `pnpm lint && pnpm typecheck && pnpm test` pass; show the output.
