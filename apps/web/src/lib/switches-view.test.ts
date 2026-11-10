// OPS-SW: the Controls page gives every safety switch a working control. Agent buying gets an on and an off
// button that posts to its own route; PayPal outbound, when off, points to Start PayPal on the same page.
import { describe, expect, it } from 'vitest';
import { switchLines } from './switches-view';

const ALL = {
  paypal_outbound: false,
  checkout_enabled: true,
  agent_buy_enabled: false,
  web_import_enabled: true,
};

describe('switchLines', () => {
  it('agent buying off shows a Turn on button that posts to /api/ops/agent-buy and needs the code', () => {
    const line = switchLines(ALL, false).find((l) => l.name === 'agent_buy_enabled')!;
    expect(line.toggle).toEqual({
      action: 'on',
      needs_mfa: true,
      path: '/api/ops/agent-buy',
      body: 'agent_buy',
    });
    expect(line.note).toBeNull();
  });

  it('agent buying on shows a Turn off button on the same route', () => {
    const line = switchLines({ ...ALL, agent_buy_enabled: true }, false).find(
      (l) => l.name === 'agent_buy_enabled',
    )!;
    expect(line.toggle).toEqual({
      action: 'off',
      needs_mfa: true,
      path: '/api/ops/agent-buy',
      body: 'agent_buy',
    });
  });

  it('PayPal outbound off has no generic toggle and names the control that turns it on', () => {
    const line = switchLines(ALL, false).find((l) => l.name === 'paypal_outbound')!;
    expect(line.toggle).toBeNull();
    expect(line.note).toBe('Turn this on with Start PayPal under Gateway locks on this page.');
  });

  it('PayPal outbound on can still be turned off here, without the code', () => {
    const line = switchLines({ ...ALL, paypal_outbound: true }, false).find(
      (l) => l.name === 'paypal_outbound',
    )!;
    expect(line.toggle).toEqual({
      action: 'off',
      needs_mfa: false,
      path: '/api/ops/switches/paypal_outbound/off',
    });
  });

  it('other switches keep the generic routes', () => {
    const line = switchLines(ALL, false).find((l) => l.name === 'checkout_enabled')!;
    expect(line.toggle).toEqual({
      action: 'off',
      needs_mfa: false,
      path: '/api/ops/switches/checkout_enabled/off',
    });
  });
});
