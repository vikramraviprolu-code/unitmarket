// Owned by SBX lane BU-5. What polling may spend of the day's call budget, and the gap between two
// provider calls. Both are pure decisions with injected time: the budget itself is read by the
// caller (composition passes `callBudget`, built from the safety status), so jobs never imports
// safety. Fail closed: a reading that is not a sane number allows nothing.

/** The approval's call budget as the safety status reports it. */
export interface CallBudgetSnapshot {
  remaining_today: number;
  max_calls_per_day: number;
}
/** `null` means unlimited (dry run: nothing is counted). */
export type CallBudget = () => Promise<CallBudgetSnapshot | null>;

export interface AllowanceConfig {
  /** 0.5: the share of the day's calls polling may use */
  poll_budget_share?: number | undefined;
  /** 30: calls polling never takes */
  capture_reserve_calls?: number | undefined;
}

const DEFAULT_SHARE = 0.5;
const DEFAULT_RESERVE = 30;
export const DEFAULT_CALL_GAP_MS = 500;

const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * How many items a polling pass may start. Nothing when `remaining_today` is at or below the line
 * `max(capture_reserve_calls, (1 - poll_budget_share) * max_calls_per_day)`, else the difference,
 * capped by `max_items`. A null budget is unlimited. A reading that is not a finite number, a
 * negative maximum, or a bad `max_items` gives 0.
 */
export function pollAllowance(
  budget: CallBudgetSnapshot | null,
  config: AllowanceConfig,
  max_items: number,
): number {
  if (!Number.isInteger(max_items) || max_items <= 0) return 0;
  if (budget === null) return max_items;
  if (typeof budget !== 'object') return 0;
  const { remaining_today, max_calls_per_day } = budget as Partial<CallBudgetSnapshot>;
  if (!number(remaining_today) || !number(max_calls_per_day) || max_calls_per_day < 0) return 0;
  const share = number(config.poll_budget_share)
    ? Math.min(1, Math.max(0, config.poll_budget_share))
    : DEFAULT_SHARE;
  const reserve =
    number(config.capture_reserve_calls) && config.capture_reserve_calls >= 0
      ? config.capture_reserve_calls
      : DEFAULT_RESERVE;
  // The epsilon keeps 0.9 * 300 style products from landing a hair above their whole number.
  const untouched = Math.ceil((1 - share) * max_calls_per_day - 1e-9);
  const line = Math.max(reserve, untouched);
  if (remaining_today <= line) return 0;
  return Math.min(max_items, Math.floor(remaining_today - line));
}

export interface GapOptions {
  gap_ms: number;
  /** milliseconds on the injected clock */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The same object with every method held back until `gap_ms` after the previous call (PERF-9: at
 * most 2 calls a second). A slot is taken before the wait, in one synchronous step, so callers
 * that run at once get slots one gap apart. A call that fails keeps its slot.
 */
export function rateLimited<T extends object>(port: T, o: GapOptions): T {
  const gap = Number.isFinite(o.gap_ms) && o.gap_ms > 0 ? o.gap_ms : 0;
  let next = Number.NEGATIVE_INFINITY;
  const slot = async (): Promise<void> => {
    if (gap === 0) return;
    const now = o.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await o.sleep(at - now);
  };
  return new Proxy(port, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]): Promise<unknown> => {
        await slot();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
