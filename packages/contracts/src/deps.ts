// Dependency bundles. Interfaces only: they hold ports (functions), not data.
import type { DomainConfig } from './config';
import type {
  ContentStore,
  AuditSink,
  Clock,
  Database,
  EventOutbox,
  Ids,
  Logger,
  ModelPort,
  SwitchReader,
} from './ports';
import type { EnvironmentLabel } from './primitives';
import type { PayPalPort } from './paypal';

export interface CoreDeps {
  db: Database;
  clock: Clock;
  ids: Ids;
  log: Logger;
  audit: AuditSink;
  switches: SwitchReader;
  config: DomainConfig;
  environment: EnvironmentLabel;
  /**
   * API-C: where domain state changes append their events, inside the same transaction. Optional so a
   * rig without webhooks still builds; composition always sets it.
   */
  outbox?: EventOutbox;
}
export interface PaymentsDeps extends CoreDeps {
  paypal: PayPalPort;
  content: ContentStore;
}
/** never carries paypal or content */
export interface AgentDeps extends CoreDeps {
  model: ModelPort;
}
