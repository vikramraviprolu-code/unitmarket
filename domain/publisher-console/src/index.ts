// @umsbx/publisher-console: pure read models for the publisher's own sales and statement (PUB-C).
// Read only. Every query filters by the actor's publisher id; no function takes any other id.
export const PACKAGE_NAME = '@umsbx/publisher-console' as const;
export { UNIT_STATUS_TEXT, salesFor } from './sales';
export type { PublisherActor, SaleItem, SaleRow, UnitStatus } from './sales';
export { buildStatement, statementFor } from './statement';
export type {
  PublisherStatement,
  StatementBlock,
  StatementContext,
  StatementFacts,
  StatementKind,
  StatementLine,
  StatementRow,
} from './statement';
export {
  COMMISSION_LINE,
  NOTHING_SOLD_SENTENCE,
  PAYEE_DIRECT_SENTENCE,
  SETTLEMENT_SENTENCE,
  blockSettlement,
  payeeSettlement,
  settlementMode,
} from './settlement';
export type { BlockFacts, Settlement, SettlementFacts, SettlementMode } from './settlement';
export { salesTotals } from './totals';
export type { SalesTotal } from './totals';
export { publisherExposure } from './exposure';
export type {
  ExposureBlock,
  ExposureContext,
  PublisherExposure,
  PublisherStatusValue,
} from './exposure';
