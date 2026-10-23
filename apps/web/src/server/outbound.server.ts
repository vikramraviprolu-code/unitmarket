// The unseal (BU-2). The one apps file that builds the approved sandbox transport. Everything here
// defaults to the sealed answer: a request is answered `blocked` and nothing is built until every
// lock is open at the time of the request (docs/design/mvpb-unseal-and-mvpc-offline.md section 2):
//   L1 mode is sandbox, L2 connect flag is on        -> else connect_off
//   L4 the paypal_outbound switch is on              -> else kill_switch
//   L3 an active approval row for the configured ref and scope, read by the real scoped gate -> else no_approval
//   L5 credentials are present and the production Wire's self-check is clean -> else egress
// Once a capability exists the approved transport is built once per process (single flight) and from
// then on the gate decides every request: expiry, switch and budget are read again each time.
//
// Rules this file keeps (pinned by tests/mvp-b/sealed-callers.test.ts and scripts/lint-rules.test.ts):
//   - it is the only apps file that names the approved factory, the production Wire token and the
//     scoped-gate factory, and composition names none of them;
//   - the production Wire is chosen only by an explicit `null`; an absent or invalid wire throws;
//   - it never reads the environment or the clock itself (config, clock and switches are injected).
import 'server-only';
import { createScopedGate } from '@umsbx/safety';
import type { ScopedGateHandle } from '@umsbx/safety';
import { PRODUCTION_WIRE, createApprovedSandboxTransport, wireSelfCheck } from '@umsbx/transport';
import type { SandboxTransport, Wire, WireSelfCheck } from '@umsbx/transport';
import type { Config } from '@umsbx/config';
import type {
  BlockReason,
  Clock,
  Database,
  Logger,
  SwitchReader,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import type { BlockedBy, OutboundStatusView } from '../lib/gate-lines';

export type OutboundStatus = OutboundStatusView;

export interface OutboundDeps {
  config: Pick<Config, 'mode' | 'connect' | 'outbound_approval_ref' | 'outbound_scope' | 'paypal'>;
  /** The database the app runs on: the scoped gate reads the approval row and the budget from it. */
  db: Database;
  clock: Clock;
  log: Logger;
  switches: SwitchReader;
  /**
   * Required. `null` selects the production Wire (the explicit choice composition makes unless a
   * test double is injected, which createApp allows only under NODE_ENV=test). Undefined, a string or
   * anything that is not a Wire throws.
   */
  wire: Wire | null;
  /** The production Wire's self-check; defaults to the transport's. Tests inject. */
  selfcheck?: () => WireSelfCheck;
}

export interface Outbound {
  /** Answers blocked until every lock is open; then the approved sandbox transport. */
  readonly transport: Transport;
  /** Which lock is open or missing, now. Booleans and the scope: never a value. Never throws. */
  status(): Promise<OutboundStatus>;
  /** The production Wire's self-check, or null when a test Wire is injected. Never throws. */
  selfcheck(): WireSelfCheck | null;
}

/**
 * Test-only seams. Composition never passes them (a text test pins that); a capability must still be
 * one the transport package minted, so a seam cannot forge one.
 */
export interface OutboundSeams {
  gate?: ScopedGateHandle;
}

/** The operations the app needs under any scope: token, create, get, capture, get capture (ASM-32). */
const PHASE_OPERATIONS: readonly string[] = [
  'oauth_token',
  'create_order',
  'get_order',
  'capture_order',
  'get_capture',
];

const FAIL_CLOSED_CHECK: WireSelfCheck = {
  impl: 'node-https',
  env_override: true,
  builtins_intact: false,
  global_fetch_changed_since_load: false,
};

export function buildOutbound(d: OutboundDeps, seams: OutboundSeams = {}): Outbound {
  const w: unknown = d.wire;
  if (w !== null && !(typeof w === 'object' && typeof (w as Wire).request === 'function'))
    throw new TypeError('buildOutbound: wire must be a Wire, or null for the production Wire');
  const { config, db, clock, log, switches } = d;
  const scope = config.outbound_scope;
  const production = d.wire === null;
  const gate: ScopedGateHandle =
    seams.gate ??
    createScopedGate(db, clock, {
      scope,
      switches,
      config: {
        mode: config.mode,
        connect: config.connect,
        outbound_approval_ref: config.outbound_approval_ref,
      },
    });

  const selfcheck = (): WireSelfCheck | null => {
    if (!production) return null;
    try {
      return (d.selfcheck ?? wireSelfCheck)();
    } catch {
      return FAIL_CLOSED_CHECK;
    }
  };
  const wireClean = (): boolean => {
    const c = selfcheck();
    return c === null || (!c.env_override && c.builtins_intact);
  };
  const credentialsAndWireOk = (): boolean => config.paypal !== null && wireClean();
  const switchOn = async (): Promise<boolean> => {
    try {
      return await switches.isOn('paypal_outbound');
    } catch {
      return false;
    }
  };

  let lastBlocked: BlockReason | null = null;
  const blocked = (by: BlockReason): TransportResult => {
    if (lastBlocked !== by) {
      lastBlocked = by;
      log.log({ msg: 'outbound.blocked', level: 'warn', fields: { by, scope } });
    }
    return { kind: 'blocked', by };
  };

  let built: SandboxTransport | null = null;
  let building: Promise<SandboxTransport | null> | null = null;
  type Capability = NonNullable<Awaited<ReturnType<ScopedGateHandle['approvalCapability']>>>;
  const ensureBuilt = (approval: Capability): Promise<SandboxTransport | null> => {
    if (built !== null) return Promise.resolve(built);
    building ??= (async (): Promise<SandboxTransport | null> => {
      try {
        const t = await createApprovedSandboxTransport({
          approval,
          scope,
          clock,
          log,
          wire: d.wire === null ? PRODUCTION_WIRE : d.wire,
        });
        built = t;
        log.log({
          msg: 'outbound.transport_built',
          level: 'info',
          fields: { scope, wire_kind: production ? 'production' : 'injected' },
        });
        return t;
      } catch (e) {
        log.log({
          msg: 'outbound.build_failed',
          level: 'error',
          fields: { scope, error: e instanceof Error ? e.name : 'unknown' },
        });
        return null;
      } finally {
        building = null;
      }
    })();
    return building;
  };

  const transport: Transport = {
    kind: 'sandbox',
    async send(r): Promise<TransportResult> {
      try {
        if (built !== null) return await built.send(r);
        if (config.mode !== 'sandbox' || !config.connect) return blocked('connect_off');
        if (!(await switchOn())) return blocked('kill_switch');
        let approval: Capability | null = null;
        try {
          approval = await gate.approvalCapability();
        } catch {
          approval = null;
        }
        if (approval === null) return blocked('no_approval');
        if (!credentialsAndWireOk()) return blocked('egress');
        const t = await ensureBuilt(approval);
        if (t === null) return blocked('no_approval');
        lastBlocked = null;
        return await t.send(r);
      } catch {
        // Nothing may throw out of a send: an unexpected failure is the kill switch's answer.
        return blocked('kill_switch');
      }
    },
  };

  // L3 for status(): the same row the gate reads (active now, for this ref and this scope).
  const approvalActive = async (): Promise<boolean> => {
    const ref = config.outbound_approval_ref;
    if (ref === null || ref === '') return false;
    try {
      const r = await db.query<{ scope: string; operations: string[] }>(
        'SELECT scope, operations FROM outbound_approvals WHERE approval_ref = $1 AND valid_until > $2',
        [ref, clock.now().toISOString()],
      );
      const row = r.rows[0];
      // The row must list the five operations of the polling phase (every scope includes them): a
      // row that lists fewer would be reported as open while most calls are blocked by the gate.
      return (
        row !== undefined &&
        row.scope === scope &&
        Array.isArray(row.operations) &&
        PHASE_OPERATIONS.every((o) => row.operations.includes(o))
      );
    } catch {
      return false;
    }
  };

  return {
    transport,
    selfcheck,
    async status(): Promise<OutboundStatus> {
      const locks = {
        l1_mode_sandbox: config.mode === 'sandbox',
        l2_connect_on: config.connect,
        l3_approval_active: await approvalActive(),
        l4_switch_on: await switchOn(),
        l5_credentials_and_wire_ok: credentialsAndWireOk(),
      };
      const blocked_by: BlockedBy | null =
        !locks.l1_mode_sandbox || !locks.l2_connect_on
          ? 'connect_off'
          : !locks.l4_switch_on
            ? 'kill_switch'
            : !locks.l3_approval_active
              ? 'no_approval'
              : !locks.l5_credentials_and_wire_ok
                ? 'egress'
                : null;
      return {
        scope,
        wire_kind: production ? 'production' : 'injected',
        locks,
        open: blocked_by === null,
        blocked_by,
        transport_built: built !== null,
      };
    },
  };
}
