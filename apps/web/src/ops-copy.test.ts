// WEB-OPS-START: the words of the Start control and the section tabs. Plain sentences, no dashes, no
// stack text, one answer for every refusal the route can give (D-051).
import { describe, expect, it } from 'vitest';
import * as copy from './lib/ops-copy';

const REFUSALS = [
  'mfa_required',
  'no_active_approval',
  'scope_mismatch',
  'budget_used_up',
  'scope_not_confirmed',
  'already_on',
  'switch_locked',
  'reason_required',
  'operator_required',
] as const;

describe('ops-copy', () => {
  it('has a plain sentence for every refusal of the start route', () => {
    for (const code of REFUSALS) {
      const s = copy.startRefusalText(code);
      expect(s.length, code).toBeGreaterThan(25);
      expect(s, code).toMatch(/[.]$/);
      expect(s, code).not.toMatch(/stack|Error|undefined|null|[–—]|\bat \w+ \(/);
    }
    expect(new Set(REFUSALS.map((c) => copy.startRefusalText(c))).size).toBe(REFUSALS.length);
  });

  it('keeps the key sentences the screen and the spec promise', () => {
    expect(copy.OPS_START_BUTTON).toBe('Start PayPal');
    expect(copy.OPS_START_NEEDS_CODE).toBe('Sign in with your authenticator code to start PayPal.');
    expect(copy.OPS_CONNECT_FLAG_OFF).toBe(
      'The connection flag is off. No PayPal call goes out until the owners turn it on in Cloud Run.',
    );
  });

  it('names no dash and no italics in any exported sentence', () => {
    for (const [k, v] of Object.entries(copy)) {
      const texts =
        typeof v === 'string'
          ? [v]
          : Array.isArray(v)
            ? v.map((i) => (i as { label?: string }).label ?? '')
            : [];
      for (const t of texts) expect(t, k).not.toMatch(/[–—]|<em>|<i>/);
    }
  });

  it('lists the tabs of each operator page with unique ids and short labels', () => {
    for (const items of [
      copy.OPS_HOME_SECTIONS,
      copy.OPS_PUBLISHERS_SECTIONS,
      copy.OPS_PAYEE_SECTIONS,
      copy.OPS_EVALS_SECTIONS,
    ]) {
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
      for (const i of items) {
        expect(i.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(i.label.length).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe('killControlsView', () => {
  const v = copy.killControlsView;
  it('switch On: Stop is the form and Start says it is already on', () => {
    expect(v({ outboundOn: true, hasCode: true, activeScope: 'mvp_b_polling' })).toEqual({
      start: 'already_on',
      stop: 'form',
    });
    expect(v({ outboundOn: true, hasCode: false, activeScope: null })).toEqual({
      start: 'already_on',
      stop: 'form',
    });
  });
  it('switch Off: Start is the form only with the code and an active approval', () => {
    expect(v({ outboundOn: false, hasCode: true, activeScope: 'mvp_b_polling' })).toEqual({
      start: 'form',
      stop: 'already_off',
    });
    expect(v({ outboundOn: false, hasCode: false, activeScope: 'mvp_b_polling' })).toEqual({
      start: 'needs_code',
      stop: 'already_off',
    });
    expect(v({ outboundOn: false, hasCode: true, activeScope: null })).toEqual({
      start: 'no_approval',
      stop: 'already_off',
    });
    expect(v({ outboundOn: false, hasCode: false, activeScope: null }).start).toBe('needs_code');
  });
});
