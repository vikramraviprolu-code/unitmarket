# Lane 11: security middleware (route wrapper, sessions, CSRF, rate limits, headers, idempotency)

Task: one wrapper every route handler uses, plus sessions for passcode personas and the security headers.
Package: `packages/security` Owner: Sonnet worker W-11 Reviewer: Opus 5.5
Wave: 1 (needs lane 01 F1 and lane 12 tables `sessions`, `rate_buckets`, `api_idempotency`, `audit_log`; code against the column lists in lane 12 and rebase when it merges). Size: 7 h. Single owner of `withRoute` and `RouteMeta`.

## Goal
No route can exist without declared authentication, authorisation, CSRF, rate, body size and input schema; the metadata feeds the route inventory. Authorisation never relies on Next.js middleware alone. Another buyer's object is indistinguishable from a missing one.

## Inputs
- Architecture 9.8; nfr.md SOP 4, 5, 7, 8, 9, 10, 14, 15, P6, P10, P13, COST-3.
- Lane 01 F1: `Actor`, `Database`, `Clock`, `Ids`, `Logger`, `AuditSink`, `Secret`, `Result`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `apps/web/server/session.ts` (cookie parsing that never throws, token shape check before lookup), `apps/web/server/http.ts` (JSON error helper).
- Dependencies: none new (`node:crypto` for HMAC, scrypt, TOTP later).

## Outputs
`packages/security/src/{route.ts, session.ts, passcode.ts, csrf.ts, rate.ts, headers.ts, idempotency.ts, errors.ts, inventory.ts, index.ts}` and tests; `scripts/route-inventory.mjs` filled (reads `RouteMeta` exports from `apps/web/src/app/**/route.ts`).

## Interfaces
```ts
export type AuthRule = 'public' | 'buyer' | 'publisher' | 'operator' | 'webhook';
export interface RateRule { name: string; per: 'ip' | 'actor'; limit: number; window_ms: number }
export interface RouteMeta { path: string; method: 'GET' | 'POST'; auth: AuthRule; csrf: boolean; rate: RateRule | null; max_body_bytes: number; idempotent: boolean; risk: 'low' | 'medium' | 'high' }
export interface RouteContext<I> { actor: Actor; input: I; req_id: string; ip_hash: string; log: Logger }
export interface SecurityDeps { db: Database; clock: Clock; ids: Ids; log: Logger; audit: AuditSink; session_secret: Secret; passcode_hash: string | null; public_origin: string }
export function withRoute<I, O>(meta: RouteMeta, schema: ZodType<I>, handler: (ctx: RouteContext<I>) => Promise<HttpResult<O>>): (deps: SecurityDeps) => (req: Request) => Promise<Response>;
export type HttpResult<O> = { status: 200 | 201 | 202; body: O; headers?: Record<string, string> } | { status: 303; location: string } | { status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503; code: string; message: string };
export function createSession(deps: SecurityDeps, actor: Actor): Promise<{ cookie: string; csrf_token: string }>;   // __Host-ums_s, HttpOnly, Secure, SameSite=Lax, Path=/
export function resolveSession(deps: SecurityDeps, cookieHeader: string | null): Promise<Actor | null>;           // absolute 8 h, idle 30 min, revoked rows refused
export function revokeAllSessions(deps: SecurityDeps, actor: Actor): Promise<number>;
export function verifyPasscode(hash: string, attempt: string): Promise<boolean>;                                   // scrypt, timing-safe
export function hashPasscode(plain: string): Promise<string>;                                                      // used only by an operator CLI
export function securityHeaders(nonce: string): Record<string, string>;   // HSTS, CSP (default-src 'self'; script-src 'self' 'nonce-…'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; base-uri 'none'), nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy
export function notFoundUnlessOwner<T extends { buyer_id: Id }>(row: T | null, actor: Actor): Result<T, 'not_found'>;
```
Wrapper order: request id; body size check (413); rate limit (429, DB token bucket); session resolve; auth rule (401, or 404 for object routes); CSRF for state-changing routes (Origin equals `public_origin`, plus `x-csrf-token` equal to the session's token hash; 403); zod `.strict()` parse (422 with field names only); `Idempotency-Key` handling when `idempotent` (stored response replay; same key with another body 422); handler; generic error body with a support code on any throw (no stack, no message from inside). `webhook` auth skips session and CSRF but keeps size and rate rules (rate never drops validly signed webhooks: the limiter for `webhook` counts only rejected signatures, nfr.md SOP 9). Operator rule requires `mfa: true` from MVP-C; in MVP-A an operator persona has `mfa: false` and operator routes are read-only.

Default rate rules (COST-3, architecture 9.8): passcode 5 per 15 min per IP; quote 30 per min per actor; approval 10 per hour per actor; order 5 per min per actor; content 60 per hour per actor; discovery 20 per hour per actor; webhook-invalid 60 per min per IP.

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/security`: `headers contain every required header with a nonce`; `passcode scrypt verify is timing-safe and rejects wrong input`; `cookie has __Host- prefix, HttpOnly, Secure, SameSite=Lax`.
- `--project state packages/security`: `session expires at 8 h absolute and 30 min idle`; `revokeAll ends every session of the actor`; `rate limit returns 429 at limit + 1`; `idempotency replays the stored response and refuses a changed body with 422`.
- `--project adversarial packages/security`: `no session gives 401`; `buyer B on buyer A object gives 404` (A-20, P6); `POST without Origin or with a foreign Origin gives 403`; `missing csrf token gives 403`; `extra JSON field gives 422` (mass assignment); `65 KB body gives 413`; `handler throw returns a generic body without the error text`; `malformed cookie never throws`.
- `route_inventory`: `node scripts/route-inventory.mjs --check` fails when a route file lacks `RouteMeta` (SOP 5).

## Security and NFR gates
SOP 4, 5, 7, 8, 9, 10, 14, 15; P6, P10 (idempotent POST), P13; COST-3; A-20.

## Do not
Authorise in Next.js middleware only; read `process.env` (config arrives in `SecurityDeps`); add dependencies; store a plain passcode; log cookies or tokens; touch other packages.

Branch `feat/security-route-wrapper` Commit `feat(security): route wrapper, sessions, CSRF, rate limits, headers (SBX-A-11)`.
