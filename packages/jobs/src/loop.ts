// Owned by SBX lane 05b. The one job loop: recover after a start, then pass after pass run what is
// due (payments), end access windows that are over (access clock), sleep until the next due time
// but never longer than max_sleep_ms. It owns no rule: payments decides what is due and how.
// Provider calls happen inside runDue, one pass at a time, bounded by max_items. Dates come from
// the injected clock; only the waiting uses a timer.
// BU-5: with a `callBudget` (sandbox) each pass first works out what polling may spend of the day's
// calls. The allowance is in CALLS, the unit the gate counts: the port handed to payments answers
// `blocked` once the pass has used it, so an item that costs 3 or 4 calls cannot overdraw it. A spent
// allowance leaves only the money passes (unknown captures and read-backs, closings that need no
// resend), bounded by the calls left, and every provider call keeps a gap of min_call_gap_ms.
// Sandbox mode refuses to run without a call budget (money_only passes only) and refuses a re-read
// cadence outside 1 ms to 24 h.
// BU-9: a pass whose counts are all zero did nothing, so an overdue `nextDueAt` is no reason to wake
// again after MIN_SLEEP_MS: the item that keeps it overdue is one the pass could not settle (an
// unreadable or blocked order), and waking at once only reads it again. Such a pass sleeps up to
// max_sleep_ms. A future due time is still waited for, and a pass that did something still comes
// back after MIN_SLEEP_MS.
// POB-M1: with a `payouts` option each pass also runs one payout pass (create the payouts that are due, send them), after the
// windows are swept and before webhooks are delivered, in its own try/catch (a failure is logged as jobs.loop.payouts_failed).
// With the paypal_outbound switch off the pass gets NO port: due payouts are still created and none is sent. Otherwise the
// port is wrapped with the lease guard, so a lost lease answers `blocked` and the provider is never reached. A configured
// port of null (no payout port in this mode) behaves like the switch being off.
// PG-2 (D-049): with a `leader` election (Postgres only) the body runs only while this process holds
// the lease. Without the lease the loop retries the election every few seconds and runs nothing, not
// even recovery. Recovery runs once per leadership term. A lease that is lost ends the term at once:
// no new pass starts, and a pass already running can no longer reach the provider (its calls answer
// `blocked`), so a successor never works beside a predecessor's tail. stop() gives the lease back.
import { nextDueAt, recoverOnStartup, runDue, runPayoutPass } from '@umsbx/payments';
import type { PaymentsDeps, PayoutPort, TraceContext } from '@umsbx/contracts';
import { withTraceContext } from '@umsbx/obs';
import { sealDue, sealPreviousDay } from '@umsbx/trace';
import { DEFAULT_CALL_GAP_MS, moneyCalls, pollAllowance, rateLimited } from './budget';
import type { CallBudget, CallQuota } from './budget';
import { recordPass } from './health';
import { createImportWorker } from './imports';
import type { ImportRunner } from './imports';

/** A leader lease as the loop needs it. @umsbx/db's AdvisoryLease fits this shape. */
export interface LeaderLease {
  held(): boolean;
  /** Resolves once the lease is gone, whatever the reason. */
  readonly lost: Promise<void>;
  release(): Promise<void>;
}
/** Tries once, without waiting, to become the one loop. null: another process leads. */
export interface LeaderElection {
  tryAcquire(): Promise<LeaderLease | null>;
}
/** The session advisory lock key of the one job loop (PG-2). */
export const LEADER_LOCK_KEY = 'umsbx:job-loop-leader';
/** How long a process that is not the leader waits before asking again. */
export const DEFAULT_LEADER_RETRY_MS = 3_000;

/**
 * Wraps the provider port so that, once the lease is gone, every call answers `blocked` without
 * reaching the provider. Payments treats `blocked` as a pause: no attempt is spent, nothing is sent.
 */
function ledBy<T extends object>(port: T, leading: () => boolean): T {
  return new Proxy(port, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        if (!leading()) return { kind: 'blocked', by: 'kill_switch' };
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The payout port behind the same lease guard: once the lease is gone every send answers `blocked` and nothing is sent. */
function ledPayoutPort(port: PayoutPort, leading: () => boolean): PayoutPort {
  return {
    send: (req) =>
      leading()
        ? port.send(req)
        : Promise.resolve({ kind: 'blocked' as const, by: 'lease' as const }),
  };
}

/** A pass that finds more due work runs again soon, but never spins. */
const MIN_SLEEP_MS = 100;
/** A paid order is re-read at most this often in sandbox mode (ASM-52) ... */
const SANDBOX_MIN_REREAD_MS = 21_600_000;
/** ... and a cadence above this would silently end the 7 day watch. */
const MAX_REREAD_MS = 86_400_000;

/** True when a pass of runDue did nothing at all: no item taken, nothing left unknown, closed or abandoned. */
function idlePass(c: Awaited<ReturnType<typeof runDue>>): boolean {
  return c.processed === 0 && c.still_unknown === 0 && c.expired === 0 && c.abandoned === 0;
}

export function startLoop(
  d: PaymentsDeps & { sweepWindows: (x: { max_items: number }) => Promise<{ ended: number }> },
  o: {
    max_sleep_ms: number;
    max_items: number;
    recover_on_start?: boolean;
    /** The day's call budget; null means unlimited. Without it the loop behaves as before. */
    callBudget?: CallBudget;
    /** Waiting between two provider calls (default: a timer). Tests move the fake clock here. */
    gap_sleep?: (ms: number) => Promise<void>;
    /** Postgres only: the loop runs only while it holds the lease (PG-2). */
    leader?: LeaderElection;
    /** Wait between two elections of a process that is not the leader (default 3 s). */
    leader_retry_ms?: number;
    /**
     * API-C: one webhook delivery pass, called after the windows are swept in its own try/catch. It
     * talks to subscribers, not to PayPal, so it also runs while the outbound switch is off. A throw is
     * logged as jobs.loop.deliver_failed and does not fail the pass.
     */
    deliver?: () => Promise<unknown>;
    /**
     * POB-I1: the web import. `recover` runs once at the start of the loop (or of a leadership term); a worker
     * runs `runNext` OFF the pass, kicked after every pass and by kickImports(), so a long batch never holds up
     * the payments work. The import has its own may-fetch check, so it is kicked while the outbound switch is off.
     */
    imports?: ImportRunner;
    /**
     * POB-M1: one payout pass per loop pass. `port` is the only way money goes out (the dry run in this lane); null means
     * this mode has no payout port, so payouts are created and not sent.
     */
    payouts?: { port: PayoutPort | null };
  },
): { stop(): Promise<void>; kickImports(): void } {
  let stopped = false;
  let term: LeaderLease | null = null;
  const leading = (): boolean => o.leader === undefined || (term !== null && term.held());
  let wake: (() => void) | null = null;
  const fail = (msg: string, e: unknown): void => {
    d.log.log({
      msg,
      level: 'error',
      fields: { error: e instanceof Error ? e.message : 'unknown' },
    });
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const sandbox = d.environment === 'sandbox';
  if (sandbox) {
    const every = d.config.reread_paid_every_ms;
    if (
      every !== undefined &&
      !(Number.isSafeInteger(every) && every > 0 && every <= MAX_REREAD_MS)
    ) {
      d.log.log({
        msg: 'jobs.loop.bad_config',
        level: 'error',
        fields: { field: 'reread_paid_every_ms', detail: 'out of range, the loop does not start' },
      });
      throw new Error(
        'jobs.loop: reread_paid_every_ms must be a whole number of milliseconds from 1 to 86400000',
      );
    }
    if (every === undefined || every < SANDBOX_MIN_REREAD_MS) {
      d.log.log({
        msg: 'jobs.loop.reread_too_frequent',
        level: 'warn',
        fields: {
          reread_paid_every_ms: every ?? 3_600_000,
          wanted_at_least_ms: SANDBOX_MIN_REREAD_MS,
        },
      });
    }
  }
  // No budget in sandbox mode: nothing can tell how many calls polling may use, so it does none.
  const noBudget = sandbox && o.callBudget === undefined;
  if (noBudget) {
    d.log.log({
      msg: 'jobs.loop.no_call_budget',
      level: 'error',
      fields: { detail: 'sandbox mode without a call budget, only money passes run' },
    });
  }

  // With a budget the provider is held to min_call_gap_ms between calls (PERF-9, 2 a second) and
  // to the calls the pass was allowed.
  let nullLogged = false;
  const quota: CallQuota = { left: Number.POSITIVE_INFINITY };
  // Every provider call of every pass, recovery included, goes through this guard in leader mode.
  const led: typeof d = o.leader === undefined ? d : { ...d, paypal: ledBy(d.paypal, leading) };
  const run: typeof d =
    o.callBudget === undefined && !noBudget
      ? led
      : {
          ...led,
          paypal: rateLimited(led.paypal, {
            quota,
            gap_ms: d.config.min_call_gap_ms ?? DEFAULT_CALL_GAP_MS,
            now: () => d.clock.now().getTime(),
            sleep: o.gap_sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
          }),
        };

  // INT-TR0: every recovery and every pass writes under its own journal context, system on the job channel.
  let contexts = 0;
  const jobContext = (job: string): TraceContext => {
    contexts += 1;
    return {
      id: `ctx_job_${d.ids.nonce()}_${contexts}`,
      at: d.clock.now().toISOString(),
      channel: 'job',
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
  };

  // POB-I1: the import runner, under its own journal context (system, job channel). The worker's chain may be
  // started from a request or from a pass; the run it makes is neither, so it never takes their context.
  const importWorker =
    o.imports === undefined
      ? null
      : createImportWorker(
          {
            recover: () =>
              withTraceContext(jobContext('import_recovery'), () => o.imports!.recover()),
            runNext: () => withTraceContext(jobContext('import'), () => o.imports!.runNext()),
          },
          d.log,
        );

  // INT-TR1: the first pass at or after 00:05 UTC seals the previous UTC day, once. The seal is not a provider
  // call, so it runs while the outbound switch is off. It has its own context (system, job, seal); a failure
  // is logged and never fails the pass.
  let sealChecked = '';
  const sealStep = async (): Promise<void> => {
    if (!sealDue(d.clock)) return;
    const today = d.clock.now().toISOString().slice(0, 10);
    if (sealChecked === today) return;
    try {
      await withTraceContext(jobContext('seal'), () => sealPreviousDay(d.db, d.clock));
      sealChecked = today;
    } catch (e) {
      fail('jobs.loop.seal_failed', e);
    }
  };

  /** Recovery and passes for as long as this process may run them (the whole life without a leader). */
  const body = async (): Promise<void> => {
    if (importWorker !== null) {
      try {
        await importWorker.recover();
      } catch (e) {
        fail('jobs.loop.imports_recover_failed', e);
      }
    }
    // Recovery runs once per process, or once per leadership term: a caller that has already run it
    // (composition's startJobs, no leader) passes recover_on_start: false. Run twice, it would take
    // over operations of a live pass.
    if (o.recover_on_start !== false) {
      try {
        await withTraceContext(jobContext('recovery'), () => recoverOnStartup(run));
      } catch (e) {
        fail('jobs.loop.recovery_failed', e);
      }
    }
    while (!stopped && leading()) {
      let delay = o.max_sleep_ms;
      let spent = false;
      let budgetUnknown = false;
      // What the pass did; stays null when no pass ran or the counts are not readable.
      let did: Awaited<ReturnType<typeof runDue>> | null = null;
      await withTraceContext(jobContext('pass'), async () => {
        try {
          const paused = !(await d.switches.isOn('paypal_outbound'));
          if (paused) {
            d.log.log({
              msg: 'jobs.loop.paused: outbound switch is off',
              level: 'warn',
              fields: {},
            });
          } else if (noBudget) {
            spent = true;
            quota.left = Number.POSITIVE_INFINITY; // the gate decides
            did = await runDue(run, { max_items: o.max_items, allow: 'money_only' });
          } else if (o.callBudget === undefined) {
            did = await runDue(led, { max_items: o.max_items });
          } else {
            let reading: { snapshot: Awaited<ReturnType<CallBudget>> } | null = null;
            try {
              reading = { snapshot: await o.callBudget() };
            } catch (e) {
              // Fail closed: without a reading nothing is spent this pass, and a broken source is
              // asked again at the slow rhythm, not every 100 ms.
              fail('jobs.loop.call_budget_failed', e);
              budgetUnknown = true;
            }
            if (reading !== null && reading.snapshot === null && sandbox) {
              // A null reading means "unlimited" in dry run only. In sandbox it is no budget at all:
              // the same fail-closed path as having no callBudget (money passes, the gap on).
              if (!nullLogged) {
                nullLogged = true;
                d.log.log({
                  msg: 'jobs.loop.no_call_budget',
                  level: 'error',
                  fields: {
                    detail: 'callBudget returned null in sandbox mode, only money passes run',
                  },
                });
              }
              spent = true;
              quota.left = Number.POSITIVE_INFINITY; // the gate decides
              did = await runDue(run, { max_items: o.max_items, allow: 'money_only' });
            } else if (reading !== null && reading.snapshot === null) {
              // Unlimited (dry run): nothing is counted, so nothing is held back either.
              did = await runDue(led, { max_items: o.max_items });
            } else if (reading !== null) {
              const snapshot = reading.snapshot as NonNullable<typeof reading.snapshot>;
              const allowance = pollAllowance(snapshot, d.config, o.max_items);
              if (allowance > 0) {
                quota.left = allowance;
                did = await runDue(run, { max_items: allowance, allow: 'all' });
              } else {
                spent = true;
                quota.left = moneyCalls(snapshot);
                did = await runDue(run, { max_items: o.max_items, allow: 'money_only' });
              }
            }
          }
          await d.sweepWindows({ max_items: o.max_items });
          if (o.payouts !== undefined) {
            try {
              const port =
                paused || o.payouts.port === null ? null : ledPayoutPort(o.payouts.port, leading);
              await runPayoutPass(d, port, { max_items: o.max_items });
            } catch (e) {
              fail('jobs.loop.payouts_failed', e);
            }
          }
          if (o.deliver !== undefined) {
            try {
              await o.deliver();
            } catch (e) {
              fail('jobs.loop.deliver_failed', e);
            }
          }
          importWorker?.kick();
          recordPass(d, d.clock.now().toISOString());
          // With the allowance spent, overdue polling work must not wake the loop every 100 ms: the
          // pass only does money work, which is looked for at the slow rhythm.
          const next = paused || budgetUnknown || spent ? null : await nextDueAt(d.db, d.config, d.clock.now().toISOString());
          if (next !== null) {
            const wait = Date.parse(next) - d.clock.now().getTime();
            // BU-9: a pass that did nothing and still finds work overdue cannot settle it; do not
            // spin on it. Without readable counts the old rule stands.
            const idle = did !== null && did !== undefined && idlePass(did);
            if (idle && wait <= 0) delay = o.max_sleep_ms;
            else delay = Math.min(o.max_sleep_ms, Math.max(MIN_SLEEP_MS, wait));
          }
        } catch (e) {
          fail('jobs.loop.pass_failed', e);
        }
      });
      if (stopped || !leading()) break;
      await sealStep();
      await sleep(delay);
    }
  };

  const running = (async (): Promise<void> => {
    if (o.leader === undefined) {
      await body();
      return;
    }
    const retryMs = o.leader_retry_ms ?? DEFAULT_LEADER_RETRY_MS;
    while (!stopped) {
      let lease: LeaderLease | null = null;
      try {
        lease = await o.leader.tryAcquire();
      } catch (e) {
        // Not elected: never run as if elected. The error text is the driver's scrubbed message.
        fail('jobs.loop.leader_election_failed', e);
      }
      if (lease === null) {
        if (!stopped) await sleep(retryMs);
        continue;
      }
      if (stopped) {
        await lease.release().catch(() => undefined);
        break;
      }
      term = lease;
      void lease.lost.then(() => wake?.());
      d.log.log({ msg: 'jobs.loop.leader_acquired', level: 'info', fields: {} });
      try {
        await body();
      } finally {
        if (!lease.held() && !stopped) {
          d.log.log({
            msg: 'jobs.loop.leader_lost',
            level: 'warn',
            fields: { detail: 'the lock connection ended; the loop stops and asks again' },
          });
        }
        await lease.release().catch((e: unknown) => fail('jobs.loop.leader_release_failed', e));
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      wake?.();
      await running;
      await importWorker?.stop();
    },
    kickImports(): void {
      importWorker?.kick();
    },
  };
}
