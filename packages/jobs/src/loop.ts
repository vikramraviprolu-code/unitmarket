// Owned by SBX lane 05b. The one job loop: recover after a start, then pass after pass run what is
// due (payments), end access windows that are over (access clock), sleep until the next due time
// but never longer than max_sleep_ms. It owns no rule: payments decides what is due and how.
// Provider calls happen inside runDue, one pass at a time, bounded by max_items. Dates come from
// the injected clock; only the waiting uses a timer.
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import type { PaymentsDeps } from '@umsbx/contracts';
import { recordPass } from './health';

/** A pass that finds more due work runs again soon, but never spins. */
const MIN_SLEEP_MS = 100;

export function startLoop(
  d: PaymentsDeps & { sweepWindows: (x: { max_items: number }) => Promise<{ ended: number }> },
  o: { max_sleep_ms: number; max_items: number; recover_on_start?: boolean },
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

  const running = (async (): Promise<void> => {
    // Recovery runs once per process: a caller that has already run it (composition's startJobs)
    // passes recover_on_start: false. Run twice, it would take over operations of a live pass.
    if (o.recover_on_start !== false) {
      try {
        await recoverOnStartup(d);
      } catch (e) {
        fail('jobs.loop.recovery_failed', e);
      }
    }
    while (!stopped) {
      let delay = o.max_sleep_ms;
      try {
        const paused = !(await d.switches.isOn('paypal_outbound'));
        if (paused) {
          d.log.log({ msg: 'jobs.loop.paused: outbound switch is off', level: 'warn', fields: {} });
        } else {
          await runDue(d, { max_items: o.max_items });
        }
        await d.sweepWindows({ max_items: o.max_items });
        recordPass(d, d.clock.now().toISOString());
        const next = paused ? null : await nextDueAt(d.db, d.config);
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
