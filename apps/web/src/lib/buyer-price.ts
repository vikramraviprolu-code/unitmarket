// The buyer's display currency and the one formatter for a converted price (MC2-L5, D-084 item 4, D-085,
// autonomy ledger A1 and A5). Pure: no server module, no clock, no rate arithmetic. The conversion itself is
// done by engine.fx; this file only decides which currency a buyer sees and writes the words.
//
// The rule in one place: a converted figure is a help, never a price. It is led by "about", the binding
// seller-currency amount is shown beside it with the rate date, and nothing that is approved, paid or stored
// ever uses the converted figure. Wording rules: D-051 (plain words, no italics, no dashes).
import type { Money } from '@umsbx/contracts';
import { formatMinor } from './format';

export type DisplayCurrency = 'USD' | 'EUR' | 'GBP';
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['USD', 'EUR', 'GBP'];

export function isDisplayCurrency(v: unknown): v is DisplayCurrency {
  return v === 'USD' || v === 'EUR' || v === 'GBP';
}

const BY_COUNTRY: Record<string, DisplayCurrency> = { US: 'USD', GB: 'GBP', DE: 'EUR' };

/** US USD, GB GBP, DE EUR; any other country has none (the seller's currency is shown as it is). */
export function currencyForCountry(country: string): DisplayCurrency | null {
  return typeof country === 'string' ? (BY_COUNTRY[country.toUpperCase()] ?? null) : null;
}

/** A chosen currency wins; otherwise it comes from the country. A stored value that is not one of the three is ignored. */
export function effectiveDisplayCurrency(
  country: string,
  chosen: string | null,
): DisplayCurrency | null {
  return isDisplayCurrency(chosen) ? chosen : currencyForCountry(country);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-03" as "3 Nov 2026". */
export function formatRateDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${String(Number(d))} ${MONTHS[Number(m) - 1] ?? ''} ${y ?? ''}`;
}

/** What the fx engine made of a seller amount, in the buyer's display currency. */
export interface ConvertedFigure {
  minor: number;
  currency: DisplayCurrency;
  /** The date of the rate used, YYYY-MM-DD. */
  rate_date: string;
  /** 'seed' is a placeholder shipped with the build and is worded "sample rate" (A1). */
  source: 'ecb' | 'seed';
}

/**
 * One price as a screen shows it.
 * seller: the binding amount in the seller's currency, always.
 * lead: what leads the line: "about £1.28" when converted, otherwise the seller amount.
 * binding: the line beside a converted lead, or null when nothing was converted.
 */
export interface PriceView {
  seller: string;
  lead: string;
  binding: string | null;
}

export function priceView(price: Money, converted: ConvertedFigure | null): PriceView {
  const seller = formatMinor(price.minor, price.currency);
  if (converted === null) return { seller, lead: seller, binding: null };
  const word = converted.source === 'seed' ? 'sample rate' : 'rate';
  return {
    seller,
    lead: `about ${formatMinor(converted.minor, converted.currency)}`,
    binding: `Binding: ${seller} (${word} of ${formatRateDate(converted.rate_date)})`,
  };
}

/** The lead of a list line: "from about £1.28", or "from $0.40" when nothing was converted. */
export const fromLead = (v: PriceView): string => `from ${v.lead}`;

/**
 * The proposal line for an agent ceiling that was compared on the converted price. A placeholder (seed) rate
 * is said to be one, in the words of the binding line (A1); the bank is never named.
 */
export function ceilingLine(
  ceiling: Money,
  price: Money,
  source: 'ecb' | 'seed' | null = null,
): string {
  const tail = source === 'seed' ? ' (sample rate)' : '';
  return `Against your ceiling of ${formatMinor(ceiling.minor, ceiling.currency)}: about ${formatMinor(price.minor, price.currency)}${tail}.`;
}

/** Said when a search found nothing because some prices could not be compared with the ceiling. */
export const NO_RATE_NOTE =
  "We could not compare some prices with your ceiling because no current exchange rate is available. Try a ceiling in the seller's currency.";

/** The prices of one option list, by option. */
export function optionPrices(
  offer: { currency: string; options: readonly { option: string; price_minor: number }[] },
  view: (price: Money) => PriceView,
): Record<string, PriceView> {
  return Object.fromEntries(
    offer.options.map((o) => [o.option, view({ currency: offer.currency, minor: o.price_minor })]),
  );
}

export interface ApprovePrices {
  /** By article id. */
  items: Record<string, PriceView>;
  /** By publisher name. */
  blocks: Record<string, PriceView>;
  total: PriceView;
}

/** Every figure the approve page shows, through the one formatter. The approval itself is never touched. */
export function approvePrices(
  view: {
    currency: string;
    total_minor: number;
    items: readonly { article_id: string; amount_minor: number }[];
    blocks: readonly { publisher: string; subtotal_minor: number }[];
  },
  price: (money: Money) => PriceView,
): ApprovePrices {
  const m = (minor: number): Money => ({ currency: view.currency, minor });
  return {
    items: Object.fromEntries(view.items.map((i) => [i.article_id, price(m(i.amount_minor))])),
    blocks: Object.fromEntries(view.blocks.map((b) => [b.publisher, price(m(b.subtotal_minor))])),
    total: price(m(view.total_minor)),
  };
}

// The account setting. Copy lives here with the formatter so the golden test pins it with the rest.
export const DISPLAY_CURRENCY_TITLE = 'Price display';
export const DISPLAY_CURRENCY_LEDE =
  "Prices can be shown in your own currency as an estimate. You always pay the amount marked Binding, in the seller's currency.";
export const DISPLAY_CURRENCY_LABEL = 'Show prices in';
export const DISPLAY_CURRENCY_OPTION: Record<DisplayCurrency, string> = {
  USD: 'US dollars (USD)',
  EUR: 'Euros (EUR)',
  GBP: 'British pounds (GBP)',
};
const AUTO_NAME: Record<DisplayCurrency, string> = {
  USD: 'US dollars',
  EUR: 'euros',
  GBP: 'British pounds',
};
/** The "automatic" choice, worded with what it means for this buyer's country. */
export function autoOptionLabel(country: string): string {
  const c = currencyForCountry(country);
  return c === null ? "Automatic, the seller's currency" : `Automatic, ${AUTO_NAME[c]}`;
}
export const DISPLAY_CURRENCY_SAVE = 'Save';
export const DISPLAY_CURRENCY_SAVING = 'Saving';
export const DISPLAY_CURRENCY_SAVED = 'Saved.';
export const DISPLAY_CURRENCY_FAILED = 'We could not save that. Please try again.';
