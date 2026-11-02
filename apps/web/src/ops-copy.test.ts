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
  'switch_changed',
  'start_unknown',
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
  it('Stop is always the form: it is idempotent and needs no code', () => {
    for (const outboundOn of [true, false])
      for (const hasCode of [true, false])
        for (const activeScope of ['mvp_b_polling', null])
          expect(v({ outboundOn, hasCode, activeScope }).stop).toBe('form');
  });
  it('switch On: Start says it is already on', () => {
    expect(v({ outboundOn: true, hasCode: true, activeScope: 'mvp_b_polling' }).start).toBe(
      'already_on',
    );
    expect(v({ outboundOn: true, hasCode: false, activeScope: null }).start).toBe('already_on');
  });
  it('switch Off: Start is the form only with the code and an active approval', () => {
    expect(v({ outboundOn: false, hasCode: true, activeScope: 'mvp_b_polling' }).start).toBe(
      'form',
    );
    expect(v({ outboundOn: false, hasCode: false, activeScope: 'mvp_b_polling' }).start).toBe(
      'needs_code',
    );
    expect(v({ outboundOn: false, hasCode: true, activeScope: null }).start).toBe('no_approval');
    expect(v({ outboundOn: false, hasCode: false, activeScope: null }).start).toBe('needs_code');
  });
});

describe('what the screen says when the start is unsure', () => {
  it('says the start may not have happened and to reload, for the lock and for the lost answer', () => {
    for (const code of ['switch_locked', 'switch_changed', 'start_unknown']) {
      const s = copy.startRefusalText(code);
      expect(s, code).toMatch(/Reload the page/);
    }
    expect(copy.startRefusalText('switch_locked')).toMatch(/may not have happened/);
    expect(copy.startRefusalText('start_unknown')).toMatch(/may not have happened/);
  });
  it('adds the switch state that was read back', () => {
    expect(copy.switchNowText(true)).toBe('The switch reads On now.');
    expect(copy.switchNowText(false)).toBe('The switch reads Off now.');
    expect(copy.switchNowText(null)).toBe('The switch could not be read.');
  });
});

// WEB-POLISH-2: the sentence under the kill switch badge after a start, and the words after a stop.
describe('what the screen says after a start or a stop', () => {
  it('switch On and flag On: today words', () => {
    expect(copy.startDoneText(120, false)).toBe(
      'PayPal calls are on (in force within 5 seconds). 120 calls are left today.',
    );
    expect(copy.startDoneText(120)).toBe(copy.startDoneText(120, false));
    expect(copy.startDoneText(1, false)).toMatch(/1 call is left today\.$/);
  });
  it('switch On and flag Off: says the switch is on, the flag is off and no PayPal call goes out', () => {
    const s = copy.startDoneText(120, true);
    expect(s).toBe(
      'The switch is on, but the connection flag is off, so no PayPal call goes out. 120 calls are left today.',
    );
    expect(s).not.toMatch(/PayPal calls are on|in force/);
  });
  it('the Stop result names Start PayPal while signed in with the code, and the owner command', () => {
    expect(copy.OPS_STOP_DONE).toBe(
      'PayPal calls are stopped (in force within 5 seconds). To turn them on again, use Start PayPal while signed in with your authenticator code, or the owner runs pnpm safety:resume at their terminal.',
    );
    // Start has a reason and a typed scope, and no code field: the code is carried by the sign-in.
    expect(copy.OPS_STOP_DONE).not.toMatch(/Start PayPal with your authenticator code/);
  });
});
