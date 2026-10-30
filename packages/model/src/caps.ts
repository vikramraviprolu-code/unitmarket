// AI-A (D-067, assumption 8). The spend rules for the Claude adapter, in micro USD (1 USD = 1,000,000).
// The worst case of a call is charged BEFORE it is sent; a call that would pass the day cap or the total
// cap is refused and the scripted model answers instead. Integer arithmetic only. The prices come from a
// cached reference dated 2026-10-06 (claude-haiku-5-5, prompts up to 100K tokens); the owner re-checks
// them before switching the adapter on, and the safety factor of 2 covers a price that moved.
import type { Clock, ModelSpendStore } from '@umsbx/contracts';

export const DAILY_CAP_MICRO_USD = 2_000_000;
export const TOTAL_CAP_MICRO_USD = 20_000_000;
export const MAX_INPUT_TOKENS = 8000;
export const MAX_OUTPUT_TOKENS = 800;
/** USD 0.10 per million input tokens. */
export const PRICE_INPUT_MICRO_PER_MTOK = 100_000;
/** USD 0.50 per million output tokens. */
export const PRICE_OUTPUT_MICRO_PER_MTOK = 500_000;
export const SAFETY_FACTOR = 2;

/** ceil(chars / 3) tokens. Not capped here: the adapter refuses an input above MAX_INPUT_TOKENS. */
export const estimateInputTokens = (chars: number): number => Math.ceil(chars / 3);

/** The most a call can cost: the estimate in, MAX_OUTPUT_TOKENS out, times the safety factor, rounded up. */
export function worstCaseMicroUsd(inputTokens: number): number {
  const tokens = Math.min(inputTokens, MAX_INPUT_TOKENS);
  return (
    SAFETY_FACTOR *
    Math.ceil(
      (tokens * PRICE_INPUT_MICRO_PER_MTOK + MAX_OUTPUT_TOKENS * PRICE_OUTPUT_MICRO_PER_MTOK) /
        1_000_000,
    )
  );
}

/** 00:00 UTC of the day the injected clock is in, as an ISO time. */
export function startOfUtcDayIso(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export interface SpendGuard {
  /** True when the charge was recorded; false when a cap, an unreadable total or a store error refused it. */
  reserve(micro_usd: number, note: string): Promise<boolean>;
}

/**
 * Checks both caps and records the charge, one reservation at a time, so two calls cannot both take the
 * last of the budget. Any failure of the store refuses (fail closed).
 */
export function createSpendGuard(spend: ModelSpendStore, clock: Clock): SpendGuard {
  let queue: Promise<unknown> = Promise.resolve();
  async function once(micro: number, note: string): Promise<boolean> {
    try {
      const day = await spend.spentMicroUsd(startOfUtcDayIso(clock.now()));
      const total = await spend.spentMicroUsd(null);
      if (!usable(day) || !usable(total)) return false;
      if (day + micro > DAILY_CAP_MICRO_USD || total + micro > TOTAL_CAP_MICRO_USD) return false;
      await spend.charge(micro, note);
      return true;
    } catch {
      return false;
    }
  }
  return {
    reserve(micro, note) {
      const run = queue.then(() => once(micro, note));
      queue = run;
      return run;
    },
  };
}
