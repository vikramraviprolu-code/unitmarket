# Security model: UnitMarket

Drafted by Devin from this repository's code and documentation on 2026-11-15, as the threat model for a Devin security scan. Nothing here is owner-confirmed yet: edit it to record which assets matter most, which attackers are realistic, and what is out of scope or accepted risk, so future scans can prioritise findings against those facts.

## Components and trust boundaries

| Component                  | Code                                                       | Boundary                                                                               |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **UnitMarket web**         | `apps/web`                                                 | Next.js app and API routes for buyers, publishers, agents and the operator console.    |
| **Domain**                 | `domain/`                                                  | Catalogue, discovery, payments and business rules; lint-restricted imports.            |
| **Payments and transport** | `packages/paypal`, `packages/transport`, `packages/safety` | The only code that reaches PayPal, sandbox only, behind the two-key outbound approval. |
| **Data and journal**       | `packages/db`                                              | PostgreSQL with an append-only, hash-chained journal.                                  |
| **Infrastructure**         | `infra/gcp`, `render.yaml`                                 | Container deployment for the hosted demo.                                              |

## Entry points and who reaches them

- Public internet: the hosted demo and its public API routes, browser sign-in.
- Authenticated users: buyers, publishers and operators; AI agents with API keys and spending caps.
- Operators: Operations Controls, sittings opened with an authenticator code.
- Outbound: PayPal sandbox only, through the sealed transport.

## Assets (inferred sensitivity)

- High: operator access and the outbound approval path; sandbox credentials held server-side; journal integrity.
- Medium: agent API keys and spending caps; account sessions.
- Low: fictional publishers, articles and test money.

## Attacker profiles (inferred)

- Unauthenticated internet visitor to the demo.
- Buyer, publisher or agent key holder escalating to operator or exceeding a spending cap.
- Anyone trying to make the app reach PayPal outside an approved sitting.

## Existing controls (from code and docs)

- Two-key outbound approval (`UMS_PAYPAL_CONNECT` plus an active `outbound_approvals` row) and kill switches.
- Live mode is fail-closed; one sandbox base URL constant (`packages/transport/src/endpoints.ts`); `pnpm check:no-live-host`.
- Only `packages/config` reads `process.env`; only `packages/transport` uses the network (lint-enforced).
- Secrets server-side only; `.env.example` holds names only.

## Out of scope / accepted risk

- Not stated by the owner yet.

## Open questions

1. Is the hosted demo the only deployment, and is test money the only money at stake?
2. Which matters most: operator console access, agent spending caps, or journal integrity?
