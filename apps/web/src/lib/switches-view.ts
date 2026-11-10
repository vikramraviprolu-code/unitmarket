// INT-CTL / CTL.3: the toggle of each safety switch on the Controls tab. Pure. Turning off is open to any
// operator session; turning on needs the authenticator code. OPS-SW: agent buying posts to its own route
// (POST /api/ops/agent-buy, the code both ways); PayPal outbound is turned on only by Start PayPal, under
// Gateway locks on the same page, because Start checks the approval row.
import type { SwitchName } from '@umsbx/contracts';
import { switchView } from './ops-home-copy';
import type { SwitchView } from './ops-home-copy';

export const OWN_CONTROL: readonly SwitchName[] = ['paypal_outbound', 'agent_buy_enabled'];

export const PAYPAL_START_NOTE = 'Turn this on with Start PayPal under Gateway locks on this page.';

export interface SwitchToggle {
  action: 'on' | 'off';
  needs_mfa: boolean;
  path: string;
  /** Present only for agent buying: the route takes `{ on, reason }` instead of `{ reason_code }`. */
  body?: 'agent_buy';
}

export interface SwitchLine extends SwitchView {
  on: boolean;
  toggle: SwitchToggle | null;
  note: string | null;
}

function toggleOf(name: string, on: boolean): SwitchToggle | null {
  const action: 'on' | 'off' = on ? 'off' : 'on';
  if (name === 'agent_buy_enabled')
    return { action, needs_mfa: true, path: '/api/ops/agent-buy', body: 'agent_buy' };
  // PayPal outbound can be turned off here, but never on: Start keeps that door.
  if (name === 'paypal_outbound' && !on) return null;
  return { action, needs_mfa: action === 'on', path: `/api/ops/switches/${name}/${action}` };
}

export function switchLines(switches: Record<string, boolean>, flagOff: boolean): SwitchLine[] {
  return Object.entries(switches).map(([name, on]) => ({
    ...switchView(name, on, flagOff),
    on,
    toggle: toggleOf(name, on),
    note: name === 'paypal_outbound' && !on ? PAYPAL_START_NOTE : null,
  }));
}
