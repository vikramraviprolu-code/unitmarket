// @umsbx/rules: the pure resolver of configurable business rules (BR-1) and the append-only settings store
// (BR-2), and the refund deadline read from the frozen terms (BR-4). Package root only.
export { readSnapshotTerms, refundDeadline, refundWindowOpen } from './deadline';
export type { SnapshotTermsRead } from './deadline';
export { judgedAt, unitRefundWindows } from './unit-window';
export type { UnitFilter, UnitRefundWindow } from './unit-window';
export { resolveTerms } from './resolve';
export type { RulesContext } from './resolve';
export {
  BACKDATE_TOLERANCE_MS,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  activeRows,
  addRuleSetting,
  listRuleHistory,
} from './store';
export type {
  RuleHistoryFilter,
  RuleSettingInput,
  RuleStoreDeps,
  RuleStoreError,
  RuleStoreErrorCode,
} from './store';
