// @umsbx/discovery: need-and-budget discovery over authorised offers (lane 14b). No order, no
// approval, no payment: the buyer picks one proposed quote and continues on the normal path.
export const PACKAGE_NAME = '@umsbx/discovery' as const;
export { parseNeed, MAX_BRIEF_CHARS } from './brief';
export type { ParseNeedError } from './brief';
export { discover, MAX_ITEMS } from './discover';
export type { CeilingCheck, ConvertFn, DiscoveryResult, DiscoverError } from './discover';
export { MIN_BUYERS, demandForPublisher, demandTerms } from './demand';
export type { DemandBand, DemandTerm, PublisherDemand } from './demand';
export { collectionFacts, collectionsOf } from './collections';
export type { Collection, CollectionRow, TopicCounts } from './collections';
