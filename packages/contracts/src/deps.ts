// Dependency bundles. Interfaces only: they hold ports (functions), not data.
import type { DomainConfig } from './config';
import type {
  ContentStore,
  AuditSink,
  Clock,
  Database,
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
}
export interface PaymentsDeps extends CoreDeps {
  paypal: PayPalPort;
  content: ContentStore;
}
/** never carries paypal or content */
export interface AgentDeps extends CoreDeps {
  model: ModelPort;
}
