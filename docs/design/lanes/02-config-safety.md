# Lane 02: configuration and connection safety (boot refusal, kill switches, outbound approval gate)

Task: the only reader of `process.env`, which refuses unsafe boots, and the safety package that decides whether any PayPal call may leave.
Package: `packages/config`, `packages/safety` Owner: Sonnet worker W-02 Reviewer: Opus 5.5 ($)
Wave: 2 (needs lane 01 F1 and F2, lane 12 tables `safety_switches`, `outbound_approvals`, `provider_calls`, `audit_log`). Size: 6 h. Single owner of `Config` and of the switch and approval semantics.

## Goal
Reaching PayPal needs five independent things: sandbox mode, `UMS_PAYPAL_CONNECT=on`, credentials, a matching active outbound approval with budget left, and the `paypal_outbound` switch on. Reaching live PayPal is impossible without a source change CI rejects. Any unsafe configuration stops the process before it listens.

## Inputs
- Architecture sections 6 and 7; nfr.md P7, P15, RLR-3, RLR-4, D-9.
- Lane 01: `Secret`, `SwitchName`, `SwitchReader`, `OutboundGate`, `GateVerdict`, `PayPalOperation`, `Database`, `Clock`, `AuditSink`, `Actor`, `DomainConfig`.
- `.env.example` names from lane 00 (exact): `UMS_MODE`, `UMS_PAYPAL_CONNECT`, `UMS_OUTBOUND_APPROVAL_REF`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `UMS_DB`, `UMS_PGLITE_DIR`, `DATABASE_URL`, `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`, `UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH`, `UMS_PUBLIC_ORIGIN`, `UMS_CORRIDORS`, `NEXT_PUBLIC_UMS_ENV_LABEL`.

## Outputs
`packages/config/src/{schema.ts, load.ts, secret.ts, refusal.ts, index.ts}`; `packages/safety/src/{switches.ts, gate.ts, budget.ts, cli-approve.ts, cli-stop.ts, index.ts}`; root scripts `safety:stop`, `safety:approve`, `safety:status` (TTY-only CLIs).

## Interfaces
```ts
// config
export type Mode = 'offline' | 'sandbox';
export interface Config {
  mode: Mode; connect: boolean; outbound_approval_ref: string | null;
  paypal: { client_id: Secret; client_secret: Secret; webhook_id: string | null } | null;   // null in offline
  db: { kind: 'pglite-memory' } | { kind: 'pglite-disk'; dir: string } | { kind: 'postgres'; url: Secret };
  session_secret: Secret; approval_secret: Secret; link_secret: Secret; passcode_hash: string | null;
  public_origin: string; corridors: string[]; env_label: 'Dry run' | 'Sandbox'; node_env: 'development' | 'test' | 'production';
}
export type BootRefusal = { code: 'live_not_available' | 'unknown_mode' | 'missing_value' | 'weak_secret' | 'equal_secrets' | 'insecure_origin' | 'non_sandbox_host' | 'unknown_corridor'; name: string };
export function loadConfig(env: Record<string, string | undefined>): Result<Config, BootRefusal>;
export function bootOrExit(env: Record<string, string | undefined>, exit: (code: number) => never, write: (line: string) => void): Config; // exit code 78; message names the variable, never its value
export function makeSecret(value: string): Secret;
// safety
export function createSwitchReader(db: Database, clock: Clock, cache_ms?: number /* default 5000, max 5000 */): SwitchReader;
export function setSwitch(db: Database, audit: AuditSink, clock: Clock, i: { name: SwitchName; on: boolean; by: Actor; reason: string; approval_ref: string | null }): Promise<Result<void, 'reason_required' | 'approval_ref_required'>>; // turning paypal_outbound on needs approval_ref
export function createOutboundGate(d: { db: Database; clock: Clock; switches: SwitchReader; config: Pick<Config, 'mode' | 'connect' | 'outbound_approval_ref'> }): OutboundGate;
```
Gate order (first failing wins): mode offline or connect false: `connect_off`; switch `paypal_outbound` off: `kill_switch`; no `outbound_approvals` row with `approval_ref` equal to config, `valid_until > now`, and the operation in `operations`: `no_approval`; amount above `max_amount_minor` or calls today (count of `provider_calls` rows with that approval since UTC midnight) at `max_calls_per_day`: `budget`; else allowed. Boot refusal rules: architecture 6 (any value containing `live` or `production` as a mode word, or a PayPal hostname other than `api-m.sandbox.paypal.com`; sandbox mode without credentials or approval ref; non-https origin outside `http://localhost`; secret under 32 bytes; two equal secrets; production with offline mode and no passcode hash; unknown corridor id). CLIs: refuse when `process.stdin.isTTY` is false or `CI` is set; `safety:approve` asks the operator to type the scope name and writes one append-only row; `safety:stop` sets `paypal_outbound` off with a reason.

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/config`: `UMS_MODE=live refuses live_not_available`; `unknown mode refuses`; `a value containing api-m.paypal.com (built at runtime) refuses non_sandbox_host`; `sandbox without approval ref refuses`; `31-byte secret refuses`; `equal secrets refuse`; `http origin refuses except localhost`; `refusal text never contains the value`; `Secret toString and JSON.stringify give [redacted]` (P7, P15, RLR-4, A-01).
- `--project state packages/safety`: `offline mode gives connect_off`; `switch off gives kill_switch`; `no row, expired row, wrong scope give no_approval`; `amount over cap and daily calls at cap give budget`; `all open gives allowed with approval_ref` (A-03); `switch cache never older than 5 s`; `setSwitch writes audit_log`; `turning paypal_outbound on without approval_ref is refused`.
- `--project adversarial packages/safety`: `CLI refuses without a TTY and with CI set`.

## Security and NFR gates
P7, P15, RLR-3, RLR-4, SOP 2, SOP 11, A-01, A-03, D-9.

## Do not
Read `process.env` anywhere but `load.ts` (tests pass objects); log any value; add a base-URL setting; add dependencies; insert an approval row from code paths other than the CLI; touch other packages.

Branch `feat/config-safety` Commit `feat(config): fail-closed boot, kill switches, outbound approval gate (SBX-A-02)`.
