# UnitMarket Sandbox (SBX): rules for every coding session

SBX is the PayPal sandbox track of UnitMarket. It is a separate repository from the simulation
(`AIC_Hackathon_UnitMarket`). The design baseline is in `docs/design/` (architecture.md, mvp-plan.md,
nfr.md). Decisions are in `docs/decision-log.md`. Package scope: `@umsbx/*`.

## Absolute rules

1. **Nothing connects to PayPal** (or any payment API) without the owner's explicit written approval,
   recorded as a row in `docs/decision-log.md`. Default mode is `offline`: dry-run transport,
   recorded or synthetic fixtures, scripted model. Workers never create accounts, never hold
   credentials, never run sandbox calls.
2. **Two-key outbound approval** (architecture 7): reaching the sandbox needs `UMS_PAYPAL_CONNECT=on`
   AND an active `outbound_approvals` row inserted by the owner with `pnpm safety:approve` (TTY only,
   refuses in CI), whose scope, amount cap and call budget cover the call. Plus the kill switches.
3. **Live mode is fail-closed.** There is no `live` value anywhere. Boot refuses any value naming live
   or production. No live PayPal hostname in code, fixtures or config (`pnpm check:no-live-host`).
   The sandbox base URL is one constant in `packages/paypal/src/endpoints.ts`, not configurable.
4. **Secrets only server-side**, in the owner's local env file (ignored by git) or the host's
   settings. Never in the repository, a log, a PR, a doc, a chat message or a client bundle. The only
   public variable is `NEXT_PUBLIC_UMS_ENV_LABEL`. `.env.example` holds names only.
5. **Isolation from the simulation.** Never import, depend on, symlink or path-reference the
   simulation repo or its scopes (`@unitmarket/*`, `@unitmarket-sim/*`, any `simulation/` path). The
   simulation repo is read-only reference material. Copy and adapt by hand.
6. **Copy-and-adapt provenance.** A copied file belongs to SBX and starts with
   `// Origin: AIC_Hackathon_UnitMarket@<sha>:<path>. Adapted; owned by SBX.` Files that cannot hold
   a comment are listed in `docs/PROVENANCE.md`.
7. **Labels come from data.** The UI shows "Sandbox" or "Dry-run" from the stored `environment`
   (`dryrun` or `sandbox`), never from a hard-coded string or a guess. Simulation results prove
   modelled cases only, not PayPal compatibility.

## Import and runtime rules (lint-enforced, `eslint.config.mjs`)

S1 `domain/*` imports only `@umsbx/contracts` and sibling domain roots. Only a package root is
public (`@umsbx/x`, never `@umsbx/x/y`); a relative import may not leave its package.
S2 Only `packages/transport` uses fetch, `node:http(s)`, `net`, `tls`, `dns`, `undici`. Only
`packages/paypal` (and `safety`, composition) import transport; only composition and `packages/jobs`
import paypal. S3 Only `packages/config` reads `process.env`. S4 discovery, fit and model never
import payments, approval, entitlements, paypal, safety or transport. S6 No `Date.now()`,
`new Date()` without an argument, `Math.random()`, `performance.now()`, `crypto.randomUUID()` outside
`packages/runtime`: inject Clock, Ids and Rng. No `NEXT_PUBLIC_` secrets.

## Spec protocol

One task, one spec, one branch, one PR, one review. Spec in `docs/specs/<package>-<task>.md`, under
a page, with acceptance tests as commands and expected output. Branch `feat/<package>-<task>`.
Commit format: `type(<package>): <what> (<lane id>)`. Tests first: commit 1 holds only tests and
data and is run red; then implement to green. Never edit a test to make it pass unless it
contradicts the spec, and say so. Touch only the files the spec lists. No new dependency beyond
the approved list (decision D-008). A missing interface is a stop-and-report.

## Roles

Sonnet builds; Opus verifies. Nobody merges their own work; the reviewer merges. Workers use their
own git worktree (`git worktree add ../sbx-wt-<lane> -b <branch> main`), never the main checkout.

## Commands

`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (all six suites), `pnpm
test:unit|state|contract|integration|adversarial|golden`, `pnpm check:isolation`, `pnpm
check:no-live-host`, `pnpm check:secrets-names`, `pnpm format`, `pnpm ci`. Test file names pick the
suite: `*.test.ts`, `*.state.test.ts`, `*.contract.test.ts`, `*.integration.test.ts`,
`*.adversarial.test.ts`, `*.golden.test.ts`. CI runs offline checks only; sandbox tests never run in CI.
Runtimes: Node 22.22.0, pnpm 10.34.7 (`corepack pnpm` if the global differs).
