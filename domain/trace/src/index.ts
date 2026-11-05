// INT-TR1: the timelines, activity log, evidence pack and daily seal of the transaction journal (TR0).
// Reads the journal and a few allow-listed source columns; writes nothing except the seal row, through
// TR0's trace_seal. No hashing happens in TypeScript here: hashes come from SQL.
export { EVENT_TYPES, WORDS, wordsFor, wordsKeyOf } from './words';
export { TIMELINE_CAP, toRichEntries } from './timeline';
export type { RawEvent, RichEntry } from './timeline';
export {
  BUYER_TABLES,
  SELLER_TABLES,
  buyerTimeline,
  operatorView,
  opsTimeline,
  sellerTimeline,
} from './views';
export type { OperatorInput } from './views';
export { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, activityPage } from './activity';
export type { ActivityFilters, ActivityResult } from './activity';
export { SOURCE_ROW_TABLES, VERIFY_STEPS, evidenceHtml, evidencePack } from './evidence';
export type { EvidenceEvent, EvidencePack } from './evidence';
export { sealDue, sealPreviousDay, verifyJournal } from './seal';
export type { JournalVerdict, SealResult } from './seal';
