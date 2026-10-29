// Type-only re-exports so client components can name the view shapes without importing a server
// module. Types are erased at build time; no server code reaches the browser bundle.
export type {
  ApprovalView,
  LibraryEntry,
  OfferPage,
  OpsSnapshot,
  OrderView,
  PackStep,
  RefundOverview,
  RefundUnitView,
} from '../server/access';
