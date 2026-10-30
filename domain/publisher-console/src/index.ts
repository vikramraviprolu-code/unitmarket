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
export { COMMISSION_LINE, SETTLEMENT_SENTENCE, settlementMode } from './settlement';
export type { Settlement, SettlementFacts, SettlementMode } from './settlement';
export { publisherExposure } from './exposure';
export type { ExposureBlock, PublisherExposure, PublisherStatusValue } from './exposure';
