// @umsbx/fx: EUR based exchange rates (D-084 items 4, 5 and 8, D-085): read the stored rates, refresh them
// on demand from an injected fetch, and convert minor units between USD, EUR and GBP. The engine only:
// no screen, no scheduled job. Figures it makes are approximate and always carry the rate date.
export const PACKAGE_NAME = '@umsbx/fx' as const;
export { convert, FX_MAX_RATE_AGE_DAYS } from './convert';
export type { ConvertResult, FxCurrency } from './convert';
export { getRates } from './rates';
export type { FxRates } from './rates';
export { FX_RETRY_AFTER_MS, FX_STALE_AFTER_MS, refreshIfStale } from './refresh';
export type { FetchedRates, RefreshResult } from './refresh';
