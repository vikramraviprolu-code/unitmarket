// INT-AL / AL.2: the reasons a request is answered with while the outbound locks are not all open. One const,
// so the alert catalogue (domain/alerts) and the gate lines of /ops (apps/web/src/lib/gate-lines.ts) read the
// same list; a reason added here without a catalogue entry fails the golden test.
export const BLOCKED_BY = [
  'connect_off',
  'kill_switch',
  'no_approval',
  'budget',
  'egress',
] as const;
export type BlockedBy = (typeof BLOCKED_BY)[number];
