// TEMP-until-lane-01: local stand-in for the @umsbx/contracts F1/F2 types this lane needs.
// Copied verbatim from docs/design/lanes/01-contracts.md (F1 primitives, ports; F2 transport).
// Delete this file and import from '@umsbx/contracts' once lane 01 F1 and F2 are on main.
export type Id = string;
export type MinorUnits = number;
export type IsoUtc = string;
export type EnvironmentLabel = 'dryrun' | 'sandbox';
export interface Clock {
  now(): Date;
}
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEvent {
  msg: string;
  level: LogLevel;
  fields: Record<string, string | number | boolean | null>;
}
export interface Logger {
  log(e: LogEvent): void;
  child(fields: LogEvent['fields']): Logger;
}
export type PayPalOperation =
  | 'oauth_token'
  | 'create_order'
  | 'get_order'
  | 'capture_order'
  | 'get_capture'
  | 'refund_capture'
  | 'get_refund'
  | 'verify_webhook_postback'
  | 'fetch_webhook_cert';
export interface OutboundRequest {
  operation: PayPalOperation;
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body: string | null;
  order_ref: Id | null;
  amount_minor: MinorUnits | null;
  scenario: string | null /* dry-run fixture selector; ignored by the sandbox transport */;
}
export type BlockReason =
  'connect_off' | 'kill_switch' | 'no_approval' | 'budget' | 'egress' | 'dry_run_miss';
export type TransportResult =
  | {
      kind: 'response';
      status: number;
      headers: Record<string, string>;
      body: string;
      duration_ms: number;
    }
  | { kind: 'timeout' }
  | { kind: 'network_error'; code: string }
  | { kind: 'blocked'; by: BlockReason };
export interface Transport {
  readonly kind: EnvironmentLabel;
  send(r: OutboundRequest): Promise<TransportResult>;
}
export type GateVerdict =
  | { allowed: true; approval_ref: string }
  | { allowed: false; by: 'connect_off' | 'kill_switch' | 'no_approval' | 'budget' };
export interface OutboundGate {
  check(c: { operation: PayPalOperation; amount_minor: MinorUnits | null }): Promise<GateVerdict>;
}
