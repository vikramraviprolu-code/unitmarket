// @umsbx/approval: frozen snapshot, canonical hash and single-use approval token (lane 06).
export const PACKAGE_NAME = '@umsbx/approval' as const;
export { canonicalJson, sha256Hex } from './canonical';
export type { MinorUnits } from './canonical';
export { makeToken, tokenMatches } from './token';
export type { TokenParts } from './token';
export { contentHash, minorUnitsFor } from './snapshot';
export type { ApprovalError, VerifyError } from './errors';
export { requestApproval, verifyApproval, markUsed } from './approval';
export type { Selection, ApprovalGranted } from './approval';
