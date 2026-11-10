// @umsbx/catalogue: publishers, articles, offers, corridors (lane 14a). Reads and seed only; no
// pricing rule, no universal floor, no substitution. PUB-B adds the publisher's offer writes (new versions only).
export const PACKAGE_NAME = '@umsbx/catalogue' as const;
export { getOffer, listAuthorisedOffers, listAuthorisedOffersMatching, offerIdFor } from './read';
export { needWords, searchOffers, type SearchCandidate, type SearchQuery } from './search';
export type { OfferView } from './read';
export { getCorridor, corridorFor } from './corridors';
export { seedCatalogue, seedSupplement } from './seed';
export { SEED_DATA, SEED_SUPPLEMENT_COMPOSITE, SEED_SUPPLEMENT_DE } from './seed-data';
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
  offerCurrenciesFor,
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
export {
  APPLICATION_CAP,
  DUPLICATE_NOTE_PREFIX,
  ANONYMOUS_APPLICATION_ACTOR,
  REF_NONCE_PATTERN,
  SLUG_PATTERN,
  addApplicant,
  applicationReference,
  applicationStatus,
  checkApplicationInput,
  decideApplicant,
  listApplicants,
  slugBase,
  submitApplication,
} from './applicants';
export type {
  Applicant,
  ApplicantDeps,
  ApplicantError,
  ApplicantErrorCode,
  ApplicantState,
  ApplicationState,
} from './applicants';
export { setPublisherStatus } from './status';
export type { StatusDeps, StatusError, StatusErrorCode } from './status';
export { DEMO_AUDIT_REASON, DEMO_MAX_MINOR, DEMO_MIN_MINOR, applyDemoPrices } from './demo-prices';
export type { DemoRevision } from './demo-prices';
export { VISIT_GAP_MS, touchVisit } from './visits';
export { acceptTerms, listAgreements, ownAgreement, seedAgreements } from './agreements';
export type {
  Agreement,
  SeedAgreementsInput,
  TermsDeps,
  TermsError,
  TermsErrorCode,
} from './agreements';
export {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_TTL_MS,
  hashInviteCode,
  inviteCodeFromNonce,
  issueInvite,
  listPublisherAccess,
  normalizeInviteCode,
  resetPublisherSignIn,
} from './publisher-invites';
export type {
  InviteDeps,
  InviteError,
  InviteErrorCode,
  InviteState,
  IssuedInvite,
  PublisherAccessRow,
} from './publisher-invites';
export {
  decidePaypalLink,
  maskEmail,
  normalizePaypalEmail,
  ownPaypalLink,
  requestPaypalLink,
} from './paypal-link';
export type {
  LinkDeps,
  LinkError,
  LinkErrorCode,
  PaypalLinkState,
  PaypalLinkView,
} from './paypal-link';
// POB-M1 (D-089): the fee on top. One function, one port, the setting and the parts of an offer version.
export {
  FEE_BPS_MAX,
  applyFee,
  currentFee,
  fixedFeePolicy,
  listFeeHistory,
  loadFeePolicy,
  recordOfferParts,
  setFee,
} from './fee';
export type {
  FeeDeps,
  FeeError,
  FeeErrorCode,
  FeeParts,
  FeePolicy,
  FeeSetting,
  FeeSplit,
} from './fee';

// POB-I1 (D-089): the web import. A publisher proves a domain, begins an import, a background run stages the
// items, the publisher reviews and publishes. The fetcher and the fee are ports; nothing here opens a socket.
export {
  MAX_DOMAINS_PER_PUBLISHER,
  checkDomain,
  getProofCode,
  listDomains,
  listDomainsForOperator,
  removeDomain,
  requestDomain,
  vouchDomain,
} from './domain-proof';
export type { DomainView, OperatorDomainView } from './domain-proof';
export {
  UNREADABLE_FEE_POLICY,
  ZERO_FEE_POLICY,
  buyerPriceOf,
  importFeeFrom,
  resolveImportFee,
} from './import-fee';
export type { ImportFeePolicy } from './import-fee';
export {
  BATCH_DEADLINE_MS,
  IMAGE_MAX_BYTES,
  MAX_BATCH_ITEMS,
  editItem,
  getBatch,
  listBatches,
  recoverImports,
  runNextBatch,
  startVerifiedImport,
} from './import-stage';
export type { BatchView, EditInput, ItemView } from './import-stage';
export { publishBatch } from './import-publish';
export type { PublishSummary } from './import-publish';
export type {
  ImportDeps,
  ImportError,
  ImportErrorCode,
  ImportFetchOptions,
  ImportFetchOutcome,
  ImportFetcherPort,
} from './import-types';
