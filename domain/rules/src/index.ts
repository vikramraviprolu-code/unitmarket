// @umsbx/rules: the pure resolver of configurable business rules (BR-1) and the append-only settings store
// (BR-2). Package root only.
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
