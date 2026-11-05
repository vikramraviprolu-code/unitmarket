// INT-CTL / CTL.1: the words of the gateway panel on /ops/controls. A plain data file built on gate-lines.ts
// (LockView) and the BLOCKED_BY const of the contracts. Each closed lock has one sentence and one owner action,
// fixed here (F9, V4). The owner actions name a setting or a command at a terminal, never a value: nothing in
// this file can turn a lock on, set the connect flag or hold an approval ref.
import type { BlockedBy, LockView } from './gate-lines';

export type LockId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

const ORDER: readonly LockId[] = ['L1', 'L2', 'L3', 'L4', 'L5'];

/** The line shown for a lock that is closed. */
const CLOSED_LINE: Record<LockId, string> = {
  L1: 'The app runs offline (mode is not sandbox).',
  L2: 'The connect flag is off.',
  L3: 'No active approval covers this call.',
  L4: 'PayPal calls are switched off.',
  L5: 'Credentials or the wire self-check failed.',
};

/** The line shown for a lock that is open. */
const OPEN_LINE: Record<LockId, string> = {
  L1: 'The app runs in sandbox mode.',
  L2: 'The connect flag is on.',
  L3: 'An active approval covers this call.',
  L4: 'PayPal calls are switched on.',
  L5: 'Credentials are present and the wire self-check is clean.',
};

/** What the owner does about a closed lock. Fixed text; the panel adds no command and no value to it. */
export const OWNER_ACTIONS: Readonly<Record<LockId, string>> = {
  L1: "Owner sets the host's mode setting `UMS_MODE`.",
  L2: 'Owner only: see the owner runbook.',
  L3: 'Owner runs `corepack pnpm safety:approve` at a terminal.',
  L4: 'Use the Start button below.',
  L5: 'Owner checks the host secrets by name.',
};

/** The lock a BLOCKED_BY reason belongs to. A spent budget is a limit of the approval, so it reads as L3. */
const LOCK_OF_REASON: Readonly<Record<BlockedBy, LockId>> = {
  connect_off: 'L2',
  kill_switch: 'L4',
  no_approval: 'L3',
  budget: 'L3',
  egress: 'L5',
};

export interface GatewayLockLine {
  lock: LockId;
  open: boolean;
  line: string;
  /** Null when the lock is open. */
  owner_action: string | null;
}

export interface GatewayView {
  summary: string;
  all_open: boolean;
  locks: GatewayLockLine[];
}

const openOf = (l: LockView): Record<LockId, boolean> => ({
  L1: l.l1_mode_sandbox,
  L2: l.l2_connect_on,
  L3: l.l3_approval_active,
  L4: l.l4_switch_on,
  L5: l.l5_credentials_and_wire_ok,
});

/** `locks` is null in a mode that has no lock block (offline: nothing can reach PayPal). */
export function gatewayView(i: { mode: string; locks: LockView | null }): GatewayView {
  if (i.locks === null)
    return {
      summary: 'No PayPal contact in this mode. The app runs offline.',
      all_open: false,
      locks: [],
    };
  const open = openOf(i.locks);
  const locks = ORDER.map((lock): GatewayLockLine => ({
    lock,
    open: open[lock],
    line: open[lock] ? OPEN_LINE[lock] : CLOSED_LINE[lock],
    owner_action: open[lock] ? null : OWNER_ACTIONS[lock],
  }));
  const closed = locks.filter((l) => !l.open).length;
  const all_open = closed === 0;
  return {
    summary: all_open
      ? 'All five locks are open: PayPal calls are allowed.'
      : `PayPal calls are blocked: ${String(closed)} of 5 locks closed.`,
    all_open,
    locks,
  };
}

/** The sentence and the owner action for the reason the next call would be answered with. */
export function blockedByView(by: BlockedBy): {
  lock: LockId;
  line: string;
  owner_action: string;
} {
  const lock = LOCK_OF_REASON[by];
  return { lock, line: CLOSED_LINE[lock], owner_action: OWNER_ACTIONS[lock] };
}
