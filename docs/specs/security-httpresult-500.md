# Spec: HttpResult names the 500 answer (SEC-HTTP500)

Task: let a route handler return a typed 500 answer instead of casting it through the 503 shape.
Package: `packages/security` (type) and `apps/web/src/app/api/ops/start/route.ts` (remove the cast) Owner: coordinator Reviewer: Vikram
Branch: `feat/security-httpresult-500` Commit: `feat(security): HttpResult accepts 500 (SEC-HTTP500)`

Goal: `HttpResult` lists 500 among its error statuses, so the Start PayPal route returns `{ status: 500, code: 'start_unknown', message }` with no `as unknown as 503`. Behaviour does not change: `withRoute` already sends `result.status` with the standard error envelope (code, message, support code). The old cast stays valid at runtime; this removes a type lie only.

Inputs: `packages/security/src/route.ts` (the `HttpResult` type), `apps/web/src/app/api/ops/start/route.ts`.
Outputs: those two files; a new test `packages/security/src/route.error500.state.test.ts`.

Acceptance tests:

- `corepack pnpm typecheck`: fails before the change (the new test returns a 500 `HttpResult`), passes after.
- `corepack pnpm exec vitest run --project state packages/security/src/route.error500.state.test.ts`: a handler answering `{ status: 500, code, message }` gives HTTP 500 with the error envelope, the same code and message, and a support code.
- `grep -rn "as unknown as 503" apps packages` prints nothing.
- `corepack pnpm lint`, `format:check`, `check:routes`, and the `apps/web` Start route tests pass.

Do not: change any other status, the maintenance or webhook rules, or the generic 500 for a thrown error; add a dependency; touch money, safety or transport code.
Evidence: red then green output.
