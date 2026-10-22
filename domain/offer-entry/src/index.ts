// @umsbx/offer-entry: startFromOffer, the publisher article-specific entry (lane 14a).
export const PACKAGE_NAME = '@umsbx/offer-entry' as const;
export { startFromOffer, QUOTE_TTL_MS } from './start';
export type { StartFromOfferInput, EntryError, OfferRef } from './start';
export { noMatch } from './reasons';
