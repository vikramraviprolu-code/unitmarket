// The gate block of /ops as plain lines (BU-2). One pure function builds the text the operator reads,
// so a golden test pins it and the page only renders the lines. It carries no value: lock states are
// yes or NO, the scope is a name, and the Wire self-check is four facts. No import: a plain data file.

/** Which reason a request is answered with while the locks are not all open. */
export type BlockedBy = 'connect_off' | 'kill_switch' | 'no_approval' | 'budget' | 'egress';

/** The five locks of docs/design/mvpb-unseal-and-mvpc-offline.md section 2, read now. */
export interface LockView {
  l1_mode_sandbox: boolean;
  l2_connect_on: boolean;
  l3_approval_active: boolean;
  l4_switch_on: boolean;
  l5_credentials_and_wire_ok: boolean;
}

export interface OutboundStatusView {
  scope: string;
  /** Which Wire the transport stands on: the production one, or an injected test double. */
  wire_kind: 'production' | 'injected';
  locks: LockView;
  open: boolean;
  /** The reason the next call would be answered with, or null when all locks are open. */
  blocked_by: BlockedBy | null;
  transport_built: boolean;
}

export interface SelfCheckView {
  impl: string;
  env_override: boolean;
  builtins_intact: boolean;
  global_fetch_changed_since_load: boolean;
}

export interface OpsGate {
  mode: string;
  connect: boolean;
  approval_ref_set: boolean;
  /** The transport line for modes that have no lock block (dry run). */
  transport: string;
  outbound: OutboundStatusView | null;
  selfcheck: SelfCheckView | null;
}

const yn = (v: boolean): string => (v ? 'yes' : 'NO');

export function gateLines(g: OpsGate): string[] {
  const head = [
    `Mode: ${g.mode}`,
    `Connect flag: ${g.connect ? 'on' : 'off'}`,
    `Approval reference set: ${g.approval_ref_set ? 'yes' : 'no'}`,
  ];
  const o = g.outbound;
  if (o === null) return [...head, `Transport: ${g.transport}`, 'No PayPal contact in this mode.'];
  const sc = g.selfcheck;
  return [
    ...head,
    `Scope served: ${o.scope}`,
    `L1 mode is sandbox: ${yn(o.locks.l1_mode_sandbox)}`,
    `L2 connect flag is on: ${yn(o.locks.l2_connect_on)}`,
    `L3 active approval for this scope: ${yn(o.locks.l3_approval_active)}`,
    `L4 kill switch is on: ${yn(o.locks.l4_switch_on)}`,
    `L5 credentials present and Wire self-check clean: ${yn(o.locks.l5_credentials_and_wire_ok)}`,
    o.open ? 'PayPal calls: allowed by the five locks' : `PayPal calls: blocked (${o.blocked_by})`,
    o.transport_built
      ? 'Transport: approved sandbox transport, built'
      : 'Transport: sealed, not built yet (every call is answered blocked until a request finds all locks open)',
    ...(sc === null
      ? []
      : [
          `Wire self-check: impl ${sc.impl}, override ${sc.env_override ? 'yes' : 'no'}, builtins intact ${sc.builtins_intact ? 'yes' : 'no'}, global fetch changed ${sc.global_fetch_changed_since_load ? 'yes' : 'no'}`,
        ]),
  ];
}
