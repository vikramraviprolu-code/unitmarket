# unitmarket-sandbox

The PayPal sandbox track (SBX) of UnitMarket: a buyer purchases just the article or content they
need, a publisher is paid, and access opens only after verified payment and verified-possible delivery.

**This repository is NOT connected to any PayPal account.** It holds no credentials and makes no
network payment call. The default mode is `offline`: a dry-run transport answers from recorded or
synthetic fixtures. Any connection to the PayPal sandbox needs the owner's explicit written approval
(`docs/decision-log.md`) and a two-key gate (see `CLAUDE.md` and `docs/design/architecture.md`
section 7). It is separate from the simulation repository and shares no code, packages or lockfile with it.

## Status

Lane 00 scaffold: tooling, lint layering rules, guard scripts and placeholder packages only. No
domain code yet. Package layout: `apps/web`, `domain/*`, `packages/*`, `tools/spike-kit`
(architecture section 10).

## Run the offline checks

```sh
nvm use                           # Node 22.22.0
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test                         # unit, state, contract, integration, adversarial, golden
pnpm check:isolation              # no reference to the simulation repo, its paths or scopes
pnpm check:no-live-host           # no live PayPal hostname; sandbox host only in the constant module
pnpm check:secrets-names          # no client-exposed secret names; .env.example is names only
pnpm ci                           # all of the above
```

Copy `.env.example` to `.env.local` only when the owner has approved a session; fill values locally and never paste them anywhere.

## Docs

`CLAUDE.md` (rules), `docs/design/` (baseline snapshot of architecture, MVP plan, non-functional
requirements), `docs/decision-log.md`, `docs/PROVENANCE.md`.
