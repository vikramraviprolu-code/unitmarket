// Owned by SBX lane 05b. The one job loop: recover after a start, then pass after pass run what is
// due (payments), end access windows that are over (access clock), sleep until the next due time
// but never longer than max_sleep_ms. It owns no rule: payments decides what is due and how.
// Provider calls happen inside runDue, one pass at a time, bounded by max_items. Dates come from
// the injected clock; only the waiting uses a timer.
// BU-5: with a `callBudget` (sandbox) each pass first works out what polling may spend of the day's
// calls; payments never gets more items than that, a spent allowance leaves only the money passes
// (unknown captures and read-backs), and every provider call keeps a gap of min_call_gap_ms.
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import type { PaymentsDeps } from '@umsbx/contracts';
import { DEFAULT_CALL_GAP_MS, pollAllowance, rateLimited } from './budget';
import type { CallBudget } from './budget';
import { recordPass } from './health';

/** A pass that finds more due work runs again soon, but never spins. */
const MIN_SLEEP_MS = 100;
/** With the polling allowance spent, overdue re-reads must not wake the loop every 100 ms. */
const BLOCKED_MIN_SLEEP_MS = 1_000;

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

  // With a budget the provider is held to min_call_gap_ms between calls (PERF-9, 2 a second).
  const run: typeof d =
    o.callBudget === undefined
      ? d
      : {
          ...d,
          paypal: rateLimited(d.paypal, {
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
          if (reading !== null && reading.snapshot === null) {
            // Unlimited (dry run): nothing is counted, so nothing is held back either.
            await runDue(d, { max_items: o.max_items });
          } else if (reading !== null) {
            const allowance = pollAllowance(reading.snapshot, d.config, o.max_items);
            if (allowance > 0) {
              await runDue(run, { max_items: allowance, allow: 'all' });
            } else {
              spent = true;
              await runDue(run, { max_items: o.max_items, allow: 'money_only' });
            }
          }
        }
        await d.sweepWindows({ max_items: o.max_items });
        recordPass(d, d.clock.now().toISOString());
        const next = paused || budgetUnknown ? null : await nextDueAt(d.db, d.config);
        if (next !== null) {
          const wait = Date.parse(next) - d.clock.now().getTime();
          const floor = spent ? Math.min(o.max_sleep_ms, BLOCKED_MIN_SLEEP_MS) : MIN_SLEEP_MS;
          delay = Math.min(o.max_sleep_ms, Math.max(floor, wait));
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
