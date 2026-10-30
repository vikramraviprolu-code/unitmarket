// @umsbx/catalogue: publishers, articles, offers, corridors (lane 14a). Reads and seed only; no
// pricing rule, no universal floor, no substitution. PUB-B adds the publisher's offer writes (new versions only).
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
export {
  NEW_OFFER_RIGHTS,
  NEW_OFFER_TERMS,
  PUB_ATTEST_1,
  checkPrice,
  createOffer,
  getOwnOffer,
  listOfferableArticles,
  listOwnOffers,
  offerCurrencyFor,
  reviseOffer,
  withdrawOffer,
} from './write';
export type {
  OfferWriteDeps,
  OfferWriteError,
  OfferWriteErrorCode,
  OfferableArticle,
  CreateInput,
  OwnOffer,
  OwnOfferDetail,
  OwnOfferVersion,
  PriceCheck,
  PriceInput,
  ReviseInput,
} from './write';
export { setPublisherStatus } from './status';
export type { StatusDeps, StatusError, StatusErrorCode } from './status';
export { DEMO_AUDIT_REASON, DEMO_MAX_MINOR, DEMO_MIN_MINOR, applyDemoPrices } from './demo-prices';
export type { DemoRevision } from './demo-prices';
export { VISIT_GAP_MS, touchVisit } from './visits';
