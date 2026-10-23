# CO-7: hosting as code (Render blueprint), names only, checked by a script

Task: describe the hosted sandbox demo in `render.yaml` with env variable names and safe non-secret values only, and add a check that fails on any unsafe hosting setting.
Package: repository root (`render.yaml`, `scripts/`), `packages/security` (one test) Owner: Sonnet 5.5 builder, effort medium (configuration as data; safety is in the check) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W0, starts now. Assumptions: ASM-08, ASM-57 (new), ASM-30, D-022. Requirements: nfr.md REL-8, SOP 14, COST-4; architecture 8 (one process, persistent disk).

Goal: `render.yaml` declares one web service: Node `22.22.0` (`NODE_VERSION`), build `corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @umsbx/web build`, start `corepack pnpm --filter @umsbx/web start`, health check `/healthz`, exactly one instance, auto-deploy off (deploy only from a reviewed tag, RLR-1), a 1 GB disk mounted at `/var/data` with `UMS_PGLITE_DIR=/var/data/pglite`. Fixed values: `UMS_MODE=sandbox`, `UMS_PAYPAL_CONNECT=off` (the owner flips it in the dashboard after the approval row exists), `UMS_OUTBOUND_SCOPE=mvp_c_refunds`, `UMS_DB=pglite-disk`, `UMS_TRUSTED_PROXIES=1` (ASM-57; verify on first deploy), `NEXT_TELEMETRY_DISABLED=1`, `NEXT_PUBLIC_UMS_ENV_LABEL=Sandbox`, `NODE_ENV=production`. Every secret or owner-chosen value is `sync: false` with no value: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `UMS_OUTBOUND_APPROVAL_REF`, `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`, `UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH`, `UMS_OPERATOR_TOTP_KEYS`, `UMS_PUBLIC_ORIGIN`. `scripts/check-hosting.mjs` parses the YAML (a small parser for the subset used; no new dependency) and fails when: a key is not a name `packages/config` reads (or `NODE_VERSION`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED`); a secret name carries a value; any value contains `live`, `production` as a mode, or a PayPal host; `NEXT_PUBLIC_` is used for anything but the label; instances are not 1; the disk is missing or the PGlite dir is outside its mount; `NODE_OPTIONS` or a proxy variable is present; auto-deploy is on. Rendering's own field names that this lane could not verify are listed in the PR for the owner to confirm on import. Add `check:hosting` to root `package.json` and to `ci`. `packages/security/src/proxy.state.test.ts` pins D-022 with 1 proxy: the client address is the rightmost `X-Forwarded-For` entry and a client-supplied left entry cannot choose its bucket.

Inputs: `docs/design/hosting.md`, `packages/config/src/load.ts` (env name list), `.env.example`, D-022, `scripts/check-secrets-names.mjs` (pattern).

Outputs: `render.yaml`, `scripts/check-hosting.mjs`, `scripts/check-hosting.test.ts` with fixtures under `scripts/__fixtures__/hosting/`, root `package.json` (two script lines), `packages/security/src/proxy.state.test.ts`. A short "Deploying" section in `docs/design/hosting.md`.

Order: commit 1 is the tests and bad fixtures only, run red; then `render.yaml` and the script.

Acceptance tests:

- `corepack pnpm vitest run --project unit scripts/check-hosting.test.ts`: the real `render.yaml` passes; each bad fixture fails with its rule (secret with a value, `live` value, two instances, no disk, PGlite dir outside the mount, unknown name, `NODE_OPTIONS`, `NEXT_PUBLIC_` secret, auto-deploy on).
- `corepack pnpm check:hosting`: prints `hosting ok` and exits 0.
- `corepack pnpm vitest run --project state packages/security/src/proxy.state.test.ts`: with `UMS_TRUSTED_PROXIES=1`, `X-Forwarded-For: 6.6.6.6, 203.0.113.9` buckets by `203.0.113.9`; two clients that spoof the left entry share no bucket with each other's real address.
- `corepack pnpm ci && corepack pnpm check:secrets-names && corepack pnpm check:no-live-host`: exit 0.

Do not: put any value for a secret name anywhere; deploy; create an account; contact Render or PayPal; change `packages/config`; add a dependency (no YAML library).

Evidence for the PR: red summary; pass counts; the list of Render fields the owner must confirm; the env name list.

Branch: `feat/hosting-render-config` Commit: `feat(hosting): render blueprint with names only and a hosting check (CO-7)`
