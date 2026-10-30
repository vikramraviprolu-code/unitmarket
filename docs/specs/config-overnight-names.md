# Spec: config names for the overnight lanes (CFG-0)

Task: add the four new configuration names every later overnight lane reads, in one lane, so no two lanes edit
`packages/config` at once.
Package: `packages/config` (plus `.env.example`) Owner: builder (Sonnet) Reviewer: Opus, one round (D-048)
Branch: `feat/config-overnight-names` Commit: `feat(config): <what> (CFG-0)` Decisions: D-065 items 15, 16, 34, 35; D-066.
Common rules: `docs/specs/overnight-plan.md` section 2.

Goal: `loadConfig` parses four new names, each with a safe default, and nothing else changes. An app booted
without any of them behaves exactly as on `main` today.

| Name                          | Type, default                    | Rule                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UMS_PUBLISHER_PASSCODE_HASH` | passcode hash, default `null`    | Same format and checks as `UMS_DEMO_PASSCODE_HASH` (`passcode-hash-env-safe.md`). Refused at boot when it equals the demo hash (a separate hash is the point, decision 34). Stored as `publisher_passcode_hash: string \| null`.                                                                                                             |
| `UMS_OFFER_MAX_MINOR`         | integer, default `2000`          | 1 to 2000 inclusive (decision 35: tied to the approval cap). Anything else refuses boot. Stored as `offer_max_minor: number`.                                                                                                                                                                                                                |
| `UMS_AI_ADAPTER`              | `scripted` (default) or `claude` | Any other value refuses boot. Stored as `ai_adapter`.                                                                                                                                                                                                                                                                                        |
| `UMS_ANTHROPIC_API_KEY`       | Secret, default `null`           | Read only when `UMS_AI_ADAPTER=claude`; then required (boot refuses `claude` without it). Wrapped as a `Secret`, never logged, never in `NEXT_PUBLIC_*`. Not named `ANTHROPIC_API_KEY` on purpose: the coordinating session's own environment may hold that name, and the app must never pick it up. Stored as `ai_api_key: Secret \| null`. |

Inputs: `packages/config/src/schema.ts`, `load.ts`, `secret.ts`, `refusal.ts`, `config.test.ts`,
`passcode-hash.contract.test.ts`; `.env.example`; `scripts/check-hosting.mjs`, `scripts/check-hosting-gcp.mjs` (read
only, to see whether they pin the env name list).
Outputs: `packages/config/src/schema.ts` (Config fields, `ENV_NAMES`), `load.ts`, a new
`packages/config/src/overnight-names.test.ts`, `.env.example` (names only, with a comment each). If
`check-hosting*.mjs` or their tests pin `ENV_NAMES` exactly, update the pin and name it in the hand-back.

Tests first (commit 1, run red): defaults when unset; each refusal (cap 0, 2001, `abc`; adapter `live`; `claude`
without key; publisher hash equal to demo hash; publisher hash malformed); the key never appears in
`JSON.stringify(config)` or in a refusal message; `ENV_NAMES` contains the four names; `.env.example` holds them with
empty values.

Acceptance (run, paste output):

- `corepack pnpm test:unit packages/config` and `corepack pnpm test:contract packages/config` : all pass, the new file included.
- `corepack pnpm check:secrets-names` : passes (no value in `.env.example`, no public name added).
- `corepack pnpm check:hosting && corepack pnpm check:hosting-gcp` : pass.
- The common check list in the plan, section 3.

Do not: read any `.env*` file other than `.env.example`; add the new secrets to `infra/gcp/*` (separate owner decision,
see the plan, section 6); wire any name into composition (each consuming lane does that); add a dependency.
Evidence: command output (counts), the list of pinned tests changed and why, cost line.
