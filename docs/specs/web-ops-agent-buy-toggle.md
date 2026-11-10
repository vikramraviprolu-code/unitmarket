# Agent buying On/Off on Operations Controls (OPS-SW-A)

Task: give the `agent_buy_enabled` switch a working On/Off button on Operations Controls.
Package: `apps/web` Owner: Vikram Reviewer: Sakthi

Goal: the Controls page showed `agent_buy_enabled` as Off with "Turn this on from its own control", and
no control existed on any page. The route `POST /api/ops/agent-buy` (API-B, authenticator code both ways,
a reason, CSRF) and the whole agent purchase path (`buy_unit`, mandates, `/buy/agent/[ref]`) were already
built and tested. This lane only wires the button to that route. The switch gets a label ("Agent buying")
and a hint. PayPal outbound keeps its rule (on only through Start PayPal); its dead-end note now names
that control. No route, engine, safety or database change.

Inputs: `apps/web/src/lib/switches-view.ts`, `apps/web/src/ui/ops/SwitchList.tsx`,
`apps/web/src/lib/ops-home-copy.ts`, `apps/web/src/app/api/ops/agent-buy/route.ts` (read only).
Outputs: the three files above, `apps/web/src/lib/switches-view.test.ts` (new), this spec.

Acceptance tests:

- `corepack pnpm vitest run --project unit apps/web/src/lib/switches-view.test.ts`: 5 passed.
- `corepack pnpm vitest run --project state --project adversarial --project integration apps/web/src/ops-agent-buy.state.test.ts apps/web/src/web-import-switch.state.test.ts apps/web/src/ops-switches.adversarial.test.ts apps/web/src/ops-start.integration.test.ts`: all pass.
- `corepack pnpm typecheck` and `corepack pnpm lint`: exit 0.

Do not: change any route, the safety package, the approval gate or the connect flag.
Branch: `feat/ops-switch-controls` Commit: `feat(web): agent buying toggle on Controls (OPS-SW-A)`
