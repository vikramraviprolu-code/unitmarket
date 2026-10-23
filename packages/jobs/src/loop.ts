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
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import type { PaymentsDeps } from '@umsbx/contracts';
import { DEFAULT_CALL_GAP_MS, moneyCalls, pollAllowance, rateLimited } from './budget';
import type { CallBudget, CallQuota } from './budget';
import { recordPass } from './health';

/** A pass that finds more due work runs again soon, but never spins. */
const MIN_SLEEP_MS = 100;
/** A paid order is re-read at most this often in sandbox mode (ASM-52) ... */
const SANDBOX_MIN_REREAD_MS = 21_600_000;
/** ... and a cadence above this would silently end the 7 day watch. */
const MAX_REREAD_MS = 86_400_000;

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
  },
): { stop(): Promise<void> } {
  let stopped = false;
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
  const run: typeof d =
    o.callBudget === undefined && !noBudget
      ? d
      : {
          ...d,
          paypal: rateLimited(d.paypal, {
            quota,
            gap_ms: d.config.min_call_gap_ms ?? DEFAULT_CALL_GAP_MS,
            now: () => d.clock.now().getTime(),
            sleep: o.gap_sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
          }),
        };

  const running = (async (): Promise<void> => {
    // Recovery runs once per process: a caller that has already run it (composition's startJobs)
    // passes recover_on_start: false. Run twice, it would take over operations of a live pass.
    if (o.recover_on_start !== false) {
      try {
        await recoverOnStartup(run);
      } catch (e) {
        fail('jobs.loop.recovery_failed', e);
      }
    }
    while (!stopped) {
      let delay = o.max_sleep_ms;
      let spent = false;
      let budgetUnknown = false;
      try {
        const paused = !(await d.switches.isOn('paypal_outbound'));
        if (paused) {
          d.log.log({ msg: 'jobs.loop.paused: outbound switch is off', level: 'warn', fields: {} });
        } else if (noBudget) {
          spent = true;
          quota.left = Number.POSITIVE_INFINITY; // the gate decides
          await runDue(run, { max_items: o.max_items, allow: 'money_only' });
        } else if (o.callBudget === undefined) {
          await runDue(d, { max_items: o.max_items });
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
            await runDue(run, { max_items: o.max_items, allow: 'money_only' });
          } else if (reading !== null && reading.snapshot === null) {
            // Unlimited (dry run): nothing is counted, so nothing is held back either.
            await runDue(d, { max_items: o.max_items });
          } else if (reading !== null) {
            const snapshot = reading.snapshot as NonNullable<typeof reading.snapshot>;
            const allowance = pollAllowance(snapshot, d.config, o.max_items);
            if (allowance > 0) {
              quota.left = allowance;
              await runDue(run, { max_items: allowance, allow: 'all' });
            } else {
              spent = true;
              quota.left = moneyCalls(snapshot);
              await runDue(run, { max_items: o.max_items, allow: 'money_only' });
            }
          }
        }
        await d.sweepWindows({ max_items: o.max_items });
        recordPass(d, d.clock.now().toISOString());
        // With the allowance spent, overdue polling work must not wake the loop every 100 ms: the
        // pass only does money work, which is looked for at the slow rhythm.
        const next = paused || budgetUnknown || spent ? null : await nextDueAt(d.db, d.config);
        if (next !== null) {
          const wait = Date.parse(next) - d.clock.now().getTime();
          delay = Math.min(o.max_sleep_ms, Math.max(MIN_SLEEP_MS, wait));
        }
      } catch (e) {
        fail('jobs.loop.pass_failed', e);
      }
      if (stopped) break;
      await sleep(delay);
    }
  })();

  return {
    async stop(): Promise<void> {
      stopped = true;
      wake?.();
      await running;
    },
  };
}
