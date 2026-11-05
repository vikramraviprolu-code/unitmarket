// INT-E2E support: the helpers the integrated story, the offline proof and the tamper proof share. Nothing here
// is product code and nothing here reaches a network. Every helper either calls a public route handler the way a
// browser or an API client would, reads (never writes) the database for evidence, or opens a trace context for
// one of the three direct writes the spec allows (the seed offers, the forced alert of step 8, the tamper edits).
//
//   - verifyInProcess: the verifier of `scripts/trace-verify.mjs` (verifyTrace and traceInvariants from
//     packages/db/src/trace-verify.ts) run in-process on the rig's database, with the CLI's exit code and lines.
//     A spawned `pnpm trace:verify` would open a fresh empty database, so it is never used as proof (F1).
//   - runJobPass: startJobs, wait until engine.health().last_pass_at moves past its previous value, stop
//     (the pattern of apps/web/src/refund.integration.test.ts:188-192, R2-3).
//   - asSeed / asJob: the two system contexts of the spec's ground rules (F2).
import { formatTraceFinding, traceInvariants, verifyTrace } from '@umsbx/db';
import { withTraceContext } from '@umsbx/obs';
import type { TraceContext } from '@umsbx/contracts';
import { expect, vi } from 'vitest';
import type { App } from '../../apps/web/composition.server';
import { call } from '../../apps/web/src/support';
import type { Session } from '../../apps/web/src/support';

export type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export const ORIGIN = 'http://localhost:3000';

/** The story's clock starts here; Date is faked (only Date) so the injected system clock reads it. */
export const STORY_START = '2026-11-05T09:00:00.000Z';

let counter = 0;
/** A fresh Idempotency-Key. Synthetic and obviously not a secret. */
export const idem = (p: string): string => `${p}-${String(++counter).padStart(6, '0')}-intstory`;

/** Moves the faked Date forward. The app reads time only through its injected clock, which reads Date. */
export function tick(ms = 1_000): void {
  const now = vi.getMockedSystemTime();
  if (now === null)
    throw new Error('tick needs the faked Date (vi.useFakeTimers({ toFake: ["Date"] }))');
  vi.setSystemTime(new Date(now.getTime() + ms));
}

// ---------------------------------------------------------------------------------------------
// Trace contexts for the allowed direct writes.
// ---------------------------------------------------------------------------------------------
let ctxN = 0;
function systemContext(app: App, channel: 'seed' | 'job', job: string): TraceContext {
  ctxN += 1;
  return {
    id: `ctx_int_${channel}_${job}_${String(ctxN).padStart(4, '0')}`,
    at: app.security.clock.now().toISOString(),
    channel,
    actor_kind: 'system',
    actor_id: null,
    on_behalf_of: null,
    mandate_id: null,
    mfa: false,
    req_id: null,
    ip_hash: null,
    ua_family: null,
    api_key_id: null,
    job,
    tool: null,
  };
}
/** A test seed write (the $0.10 offers), journaled as system on the seed channel. */
export const asSeed = <T>(app: App, job: string, fn: () => Promise<T>): Promise<T> =>
  withTraceContext(systemContext(app, 'seed', job), fn);
/** The forced alert of step 8, journaled as system on the job channel (the one named seam). */
export const asJob = <T>(app: App, job: string, fn: () => Promise<T>): Promise<T> =>
  withTraceContext(systemContext(app, 'job', job), fn);

// ---------------------------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------------------------
/** A session-signed POST (cookie, CSRF token, origin, Idempotency-Key), the way the web pages call routes. */
export const sessionPost = (
  handler: Handler,
  session: Session,
  url: string,
  body: unknown,
  params: Record<string, string> = {},
): Promise<Response> =>
  call(handler, {
    url,
    method: 'POST',
    body,
    session,
    params,
    headers: { 'idempotency-key': idem('web') },
  });

/** A session-signed GET. */
export const sessionGet = (
  handler: Handler,
  session: Session,
  url: string,
  params: Record<string, string> = {},
): Promise<Response> => call(handler, { url, session, params });

/** One request with a bearer key, the way a partner or an agent calls /api/v1. */
export async function bearer(
  handler: Handler,
  token: string,
  o: { method?: 'GET' | 'POST'; url: string; body?: unknown; params?: Record<string, string> },
): Promise<Response> {
  const method = o.method ?? 'GET';
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (method !== 'GET') headers['idempotency-key'] = idem('v1');
  const init: RequestInit = { method, headers };
  if (o.body !== undefined) {
    init.body = JSON.stringify(o.body);
    headers['content-type'] = 'application/json';
  }
  return handler(new Request(`${ORIGIN}${o.url}`, init), {
    params: Promise.resolve(o.params ?? {}),
  });
}

/** The JSON body of a response, after asserting its status. */
export async function json<T = Record<string, unknown>>(
  res: Response | Promise<Response>,
  status: number,
  what: string,
): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, `${what}: ${text.slice(0, 400)}`).toBe(status);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------------------------
// Job passes and verify.
// ---------------------------------------------------------------------------------------------
/** One pass of the job loop: start, wait until the last pass time moves, stop. */
export async function runJobPass(app: App): Promise<void> {
  const before = (await app.engine.health()).last_pass_at;
  const jobs = await app.startJobs();
  try {
    await vi.waitFor(
      async () => {
        const now = (await app.engine.health()).last_pass_at;
        expect(now).not.toBeNull();
        expect(now).not.toBe(before);
      },
      { timeout: 60_000, interval: 25 },
    );
  } finally {
    await jobs.stop();
  }
}

export interface VerifyResult {
  code: 0 | 1;
  lines: string[];
  unattributed: number;
  /** INV-T1 and INV-T2 lines, empty when both hold. */
  invariants: string[];
}

/**
 * The verifier of scripts/trace-verify.mjs, in-process on this database: the same two calls (verifyTrace,
 * traceInvariants), the same lines and the same exit code (0 ok, 1 findings or a broken invariant).
 */
export async function verifyInProcess(app: App): Promise<VerifyResult> {
  const report = await verifyTrace(app.db);
  const invariants = await traceInvariants(app.db);
  const lines = [
    `chains ${report.chains}, rows ${report.rows}, seals ${report.seals}, checked ${report.checked}, unattributed ${report.unattributed}`,
    ...report.findings.map(formatTraceFinding),
    ...invariants,
  ];
  const ok = report.findings.length === 0 && invariants.length === 0;
  if (ok) lines.push('ok');
  return { code: ok ? 0 : 1, lines, unattributed: report.unattributed, invariants };
}

/** Rows of the journal written with no context (INV-T2), as `table id`. */
export const unattributed = async (app: App): Promise<string[]> =>
  (
    await app.db.query<{ t: string }>(
      "SELECT source_table || ' ' || source_id AS t FROM trace_events WHERE actor_kind = 'unattributed' ORDER BY 1",
    )
  ).rows.map((r) => r.t);

/** A read-only count for the evidence. */
export const count = async (app: App, sql: string, p: unknown[] = []): Promise<number> =>
  Number((await app.db.query<{ c: string | number }>(sql, p)).rows[0]?.c ?? 0);
