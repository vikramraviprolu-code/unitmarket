// CO-5 (ASM-59) golden: the R1 to R6 window table, rendered one line per scenario and compared
// with the hand-written file golden/refund-window-table.golden.txt. Times are hours after T0 (the
// moment access_ready is first possible); the window is five days (120 h). The file is reviewed by
// hand: a change to it is a change to the refund rules and needs the owner's decision (ASM-59).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccessEvent, AccessEventKind, AccessPolicy, MoneyState } from '@umsbx/contracts';
import { computeWindow, deriveAccessState } from './compute';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const H = 3_600_000;
const policy: AccessPolicy = {
  id: 'pol_1',
  version: 'v1',
  option: 'keep_retrieve',
  window_ms: 120 * H,
  start_rule: 'payment_verified_and_delivery_ready',
};

type Spec = [kind: AccessEventKind, atHours: number, creditHours?: number];
interface Scenario {
  id: string;
  money: MoneyState;
  events: Spec[];
  now: number;
}
const SCENARIOS: Scenario[] = [
  {
    id: 'R1-credit-running',
    money: 'captured',
    events: [
      ['access_ready', 0],
      ['credit_granted', 24, 2],
    ],
    now: 48,
  },
  {
    id: 'R1-paused',
    money: 'captured',
    events: [
      ['access_ready', 0],
      ['delivery_failed', 24],
    ],
    now: 48,
  },
  {
    id: 'R2-refunded-running',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['revoked', 24],
    ],
    now: 48,
  },
  {
    id: 'R2-reversed-paused',
    money: 'reversed',
    events: [
      ['access_ready', 0],
      ['delivery_failed', 24],
      ['revoked', 48],
    ],
    now: 72,
  },
  { id: 'R2-refunded-not-started', money: 'refunded', events: [['revoked', 24]], now: 48 },
  {
    id: 'R2-refunded-ended',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['window_ended', 120],
      ['revoked', 144],
    ],
    now: 168,
  },
  {
    id: 'R3-credit-after-revoke',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['revoked', 24],
      ['credit_granted', 48, 4],
    ],
    now: 72,
  },
  {
    id: 'R3-credit-before-revoke',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['credit_granted', 24, 4],
      ['revoked', 48],
    ],
    now: 72,
  },
  {
    id: 'R3-credit-after-end',
    money: 'captured',
    events: [
      ['access_ready', 0],
      ['credit_granted', 144, 4],
    ],
    now: 168,
  },
  { id: 'R4-pending-refund', money: 'captured', events: [['access_ready', 0]], now: 24 },
  { id: 'R5-starts-after-partial', money: 'captured', events: [['access_ready', 24]], now: 48 },
  { id: 'R5-never-starts-after-full', money: 'refunded', events: [], now: 48 },
  {
    id: 'R6-paused-revoked-restored',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['delivery_failed', 24],
      ['revoked', 72],
      ['delivery_restored', 96],
    ],
    now: 120,
  },
  {
    id: 'R6-credit-before-pause',
    money: 'refunded',
    events: [
      ['access_ready', 0],
      ['credit_granted', 1, 3],
      ['delivery_failed', 24],
      ['revoked', 48],
      ['credit_granted', 72, 5],
    ],
    now: 96,
  },
];

const hours = (iso: string | null): string =>
  iso === null ? '-' : `T+${(Date.parse(iso) - T0) / H}h`;

function render(s: Scenario): string {
  const events: AccessEvent[] = s.events.map(([kind, at, credit]) => ({
    entitlement_id: 'ent_1',
    kind,
    at: new Date(T0 + at * H).toISOString(),
    source: kind === 'credit_granted' ? 'operator' : 'system',
    evidence: credit === undefined ? {} : { credit_ms: credit * H, case_id: 'cas_1' },
  }));
  const w = computeWindow(events, policy, new Date(T0 + s.now * H));
  return [
    s.id,
    s.money,
    w.state,
    `ends_at=${hours(w.ends_at)}`,
    `credit=${w.credit_ms / H}h`,
    `paused_at=${hours(w.paused_at)}`,
    `access=${deriveAccessState(s.money, w)}`,
  ].join(' | ');
}

describe('R1 to R6 window table (golden)', () => {
  it('matches golden/refund-window-table.golden.txt line for line', () => {
    const expected = readFileSync(
      new URL('./golden/refund-window-table.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(SCENARIOS.map(render)).toEqual(expected);
  });
});
