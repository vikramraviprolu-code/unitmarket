// @umsbx/discovery: need-and-budget discovery over authorised offers (lane 14b). No order, no
// approval, no payment: the buyer picks one proposed quote and continues on the normal path.
export const PACKAGE_NAME = '@umsbx/discovery' as const;
export { parseNeed, MAX_BRIEF_CHARS } from './brief';
export type { ParseNeedError } from './brief';
export { discover, MAX_ITEMS } from './discover';
export type { DiscoveryResult, DiscoverError } from './discover';
