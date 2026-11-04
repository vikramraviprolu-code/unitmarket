// What a buyer is shown for a price (MC2-L5, D-084 items 4 and 9, D-085). Server only: it asks the engine
// for the buyer's display currency and the stored rate, once for the request, and hands back a function that
// turns a seller amount into the lines a screen prints (lib/buyer-price.ts writes the words).
//
// It never decides anything that is bought or stored. A screen that cannot get a usable rate, or any error
// on the way, shows the seller's currency alone and the purchase goes on (a rate is a help, not a gate).
import 'server-only';
import type { Actor, Money } from '@umsbx/contracts';
import type { Engine } from './access';
import { effectiveDisplayCurrency, isDisplayCurrency, priceView } from '../lib/buyer-price';
import type { DisplayCurrency, PriceView } from '../lib/buyer-price';

/** The refresh may not hold a page longer than the transport deadline of the rate fetch (D-085): 3 seconds. */
export const FX_DEADLINE_MS = 3_000;

/** What the helper needs from the engine. */
export type DisplayEngine = Pick<Engine, 'fx' | 'displayCurrency'>;

export interface BuyerDisplay {
  /** The currency prices are converted into; null when nothing is converted for this viewer. */
  target: DisplayCurrency | null;
  /** The lines for one seller amount. Pure and instant after the helper returned. */
  view(price: Money): PriceView;
}

const plain = (price: Money): PriceView => priceView(price, null);
const NOTHING: BuyerDisplay = { target: null, view: plain };

/**
 * Asks the engine to refresh a stale rate, waits no longer than `deadline_ms`, and never throws. The fetch
 * itself keeps going in the background if it is slower; its answer is stored whenever it arrives.
 */
export async function refreshRatesOnce(
  engine: Pick<DisplayEngine, 'fx'>,
  deadline_ms: number = FX_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const refresh = Promise.resolve()
      .then(() => engine.fx.refreshIfStale())
      .catch(() => undefined);
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadline_ms);
    });
    await Promise.race([refresh, deadline]);
  } catch {
    /* a rate is a help, never a gate */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The display for one request. Call it once per request that renders a price.
 * `currencies` names the seller currencies the page will show: when none of them differs from the buyer's
 * display currency nothing is fetched or read. `refresh: false` is for a request that already refreshed.
 */
export async function buyerDisplay(
  engine: DisplayEngine,
  actor: Actor | null,
  opts: { currencies?: readonly string[]; refresh?: boolean; deadline_ms?: number } = {},
): Promise<BuyerDisplay> {
  if (actor === null || actor.kind !== 'buyer') return NOTHING;
  try {
    const settings = await engine.displayCurrency.get(actor);
    if (settings === null) return NOTHING;
    const target = effectiveDisplayCurrency(settings.country, settings.chosen);
    if (target === null) return NOTHING;
    const wanted = opts.currencies;
    if (wanted !== undefined && !wanted.some((c) => c !== target && isDisplayCurrency(c))) {
      return { target, view: plain };
    }
    if (opts.refresh !== false) await refreshRatesOnce(engine, opts.deadline_ms);
    const rates = await Promise.resolve()
      .then(() => engine.fx.getRates())
      .catch(() => null);
    return {
      target,
      view(price: Money): PriceView {
        try {
          if (price.currency === target || !isDisplayCurrency(price.currency)) return plain(price);
          const c = engine.fx.convert({
            minor: price.minor,
            from: price.currency,
            to: target,
            rates,
          });
          if (c === null || !c.approx || c.rate_date === null) return plain(price);
          return priceView(price, {
            minor: c.minor,
            currency: target,
            rate_date: c.rate_date,
            source: c.source === 'seed' ? 'seed' : 'ecb',
          });
        } catch {
          return plain(price);
        }
      },
    };
  } catch {
    return NOTHING;
  }
}

/**
 * Where the stored rate came from, for wording a figure ('seed' is a placeholder), or null when there is no
 * rate or the read fails. Never throws.
 */
export async function currentRateSource(
  engine: Pick<DisplayEngine, 'fx'>,
): Promise<'ecb' | 'seed' | null> {
  try {
    const rates = await engine.fx.getRates();
    return rates === null ? null : rates.source === 'seed' ? 'seed' : 'ecb';
  } catch {
    return null;
  }
}
