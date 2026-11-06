// INT-OPS-C / OPS-C.5: the money-flow strip on operator Home. Pure: the window is the 24 hours ending at the
// injected `now` (open at the start, closed at the end); the counts come from the read in composition/ops-home.ts.
export const FLOW_WINDOW_MS = 86_400_000;

export const FLOW_STAGES = [
  { key: 'find', label: 'Find' },
  { key: 'quote', label: 'Quote' },
  { key: 'approve', label: 'Approve' },
  { key: 'pay', label: 'Pay' },
  { key: 'unlock', label: 'Unlock' },
  { key: 'refund', label: 'Refund' },
] as const;
export type FlowStage = (typeof FLOW_STAGES)[number]['key'];

export interface FlowWindow {
  from: string;
  to: string;
}

export function flowWindow(now: string): FlowWindow {
  return { from: new Date(Date.parse(now) - FLOW_WINDOW_MS).toISOString(), to: now };
}

export interface MoneyFlowView {
  stages: { key: FlowStage; label: string; count: number }[];
  stuck: { sent: number; unknown: number };
  stuckAny: boolean;
  window: FlowWindow;
}

export function moneyFlowView(i: {
  counts: Record<FlowStage, number>;
  stuck: { sent: number; unknown: number };
  window: FlowWindow;
}): MoneyFlowView {
  return {
    stages: FLOW_STAGES.map((s) => ({ key: s.key, label: s.label, count: i.counts[s.key] })),
    stuck: { sent: i.stuck.sent, unknown: i.stuck.unknown },
    stuckAny: i.stuck.sent + i.stuck.unknown > 0,
    window: i.window,
  };
}

export const MONEY_FLOW_HEADING = 'Money flow, last 24 hours';
export const MONEY_FLOW_LEDE =
  'How many buyers reached each step in the 24 hours up to now, and how many PayPal calls are stuck.';
