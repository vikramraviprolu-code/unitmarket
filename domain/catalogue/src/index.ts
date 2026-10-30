// @umsbx/catalogue: publishers, articles, offers, corridors (lane 14a). Reads and seed only; no
// pricing rule, no universal floor, no substitution.
export const PACKAGE_NAME = '@umsbx/catalogue' as const;
export { getOffer, listAuthorisedOffers, offerIdFor } from './read';
export type { OfferView } from './read';
export { getCorridor, corridorFor } from './corridors';
export { seedCatalogue, seedSupplement } from './seed';
export { SEED_DATA, SEED_SUPPLEMENT_COMPOSITE } from './seed-data';
export {
  MERCHANT_ID_PATTERN,
  decidePayeeRequest,
  listOpenRequests,
  payeeView,
  requestPayeeChange,
} from './payee';
export type {
  OpenRequest,
  PayeeDeps,
  PayeeError,
  PayeeErrorCode,
  PayeeHistoryRow,
  PayeeView,
  RequestState,
} from './payee';
