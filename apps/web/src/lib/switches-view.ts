// INT-CTL / CTL.3: the toggle of each safety switch on the Controls tab. Pure. Turning off is open to any
// operator session; turning on needs the authenticator code. Two switches keep their own controls and show no toggle.
import type { SwitchName } from '@umsbx/contracts';
import { switchView } from './ops-home-copy';
import type { SwitchView } from './ops-home-copy';

export const OWN_CONTROL: readonly SwitchName[] = ['paypal_outbound', 'agent_buy_enabled'];

export interface SwitchLine extends SwitchView {
  on: boolean;
  toggle: { action: 'on' | 'off'; needs_mfa: boolean; path: string } | null;
  note: string | null;
}

export function switchLines(switches: Record<string, boolean>, flagOff: boolean): SwitchLine[] {
  return Object.entries(switches).map(([name, on]) => {
    const own = (OWN_CONTROL as readonly string[]).includes(name);
    const action = on ? 'off' : 'on';
    // An own-control switch can still be turned off here, but never on: Start and agent buy keep that door.
    const toggle =
      own && !on
        ? null
        : {
            action: action as 'on' | 'off',
            needs_mfa: action === 'on',
            path: `/api/ops/switches/${name}/${action}`,
          };
    return {
      ...switchView(name, on, flagOff),
      on,
      toggle,
      note: own && !on ? 'Turn this on from its own control.' : null,
    };
  });
}
