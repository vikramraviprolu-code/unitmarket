// The one door from pages and route handlers to the engine (architecture 2.3 Z1). Re-exports the
// lazy accessors of the composition root; marks the module server-only for the bundler.
import 'server-only';
export { BOOT_REFUSAL_EXIT_CODE, app, securityDeps } from '../../composition.server';
export type {
  App,
  ApprovalView,
  Engine,
  LibraryEntry,
  OfferPage,
  OpsSnapshot,
  OrderView,
  PackStep,
  RefundOverview,
  RefundUnitView,
} from '../../composition.server';
export { orderMessage, salesTotals } from '../../composition.server';
