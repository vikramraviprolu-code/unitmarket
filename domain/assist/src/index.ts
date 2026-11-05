// INT-GA: plain-words search (GA.1, GA.2) and "explain this problem order" (GA.4). Pure: it imports only
// @umsbx/contracts and reaches the model through the ModelPort it is given.
export const PACKAGE_NAME = '@umsbx/assist' as const;
export { LIST_FIELDS } from './chips';
export type { AssistRole } from './chips';
export { ASK_TEXT_MAX, FILLER, parseRules } from './parse-rules';
export type { AssistContext, RuleResult } from './parse-rules';
export { assistQuery, parseWithModel } from './parse-model';
export type { AssistAnswer, ScopeCheck } from './parse-model';
export {
  EXPLAIN_FALLBACK,
  EXPLAIN_TEXT_MAX,
  explainOrder,
  explainProjection,
  orderFixIds,
} from './explain';
export type { ExplainAnswer, ExplainEntry, ExplainInput } from './explain';
