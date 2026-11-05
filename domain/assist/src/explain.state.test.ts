// INT-GA / GA.4 (F4, F7): "explain this problem order". The port gets the identity-free projection only: per entry
// seq, event_type, words_key, actor kind, channel, state_from and state_to, plus the alert kinds and the fix ids.
// No source id, actor id or label, provider tail, amount, time, ref, buyer, seller, request id or address, even when
// the entries come from an MFA view. The answer's action is always one of the fix ids or `none`; its two texts are
// plain strings cut at 400 characters.
import { describe, expect, it } from 'vitest';
import type { ModelPort, ModelRequest, ModelResponse, OpsTimelineEntry } from '@umsbx/contracts';
import { EXPLAIN_TEXT_MAX, explainOrder, explainProjection, orderFixIds } from './index';

/** An entry as operatorView gives it to an MFA session: every identity field filled. */
const mfaEntry = (seq: number, over: Partial<OpsTimelineEntry> = {}): OpsTimelineEntry => ({
  at: '2026-11-05T10:00:00.000Z',
  seq,
  event_type: 'order_units.update',
  words_key: 'order_units.captured_verified',
  actor: { kind: 'buyer', label: 'Buyer Alice Smith' },
  channel: 'web',
  amount_minor: 4242,
  state_from: 'pending',
  state_to: 'mismatch',
  source: { table: 'order_units', id: 'unt_hiddensrc1' },
  verified: true,
  chain_key: 'ord_hiddenchain9',
  job: null,
  tool: null,
  details: { capture_id: '3C679366HH908993F', buyer_display_name: 'Alice Smith' },
  actor_id: 'buy_hiddenactor7',
  req_id: 'req_hiddenreq5',
  ip_hash: 'abcdef12',
  ua_family: 'firefox',
  api_key_id: 'apk_hiddenkey3',
  mfa: true,
  ...over,
});

const HIDDEN_VALUES = [
  'Alice',
  'Smith',
  'unt_hiddensrc1',
  'ord_hiddenchain9',
  '3C679366HH908993F',
  '993F',
  'buy_hiddenactor7',
  'req_hiddenreq5',
  'abcdef12',
  'firefox',
  'apk_hiddenkey3',
  '4242',
  '2026-11-05',
];

function spyPort(output: unknown): { port: ModelPort; seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  return {
    seen,
    port: {
      model_id: 'spy',
      async complete(r: ModelRequest): Promise<ModelResponse> {
        seen.push(structuredClone(r));
        return { kind: 'ok', output, input_tokens: 0, output_tokens: 0 };
      },
    },
  };
}

const FIX = ['frozen_order', 'payment_unresolved', 'create_rejected'];
const good = { what_happened: 'It stopped.', safe_now: 'Wait.', action_id: 'payment_unresolved' };

const keysDeep = (v: unknown, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (typeof v === 'object' && v !== null)
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  return out;
};

describe('the projection (F7)', () => {
  it('a deep scan of the request finds only the seven entry fields, alert kinds and fix ids, on an MFA view', async () => {
    const { port, seen } = spyPort(good);
    await explainOrder(
      [mfaEntry(1), mfaEntry(2, { state_to: 'captured_verified' })],
      ['payment_unresolved'],
      FIX,
      port,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.purpose).toBe('explain_order');
    expect([...keysDeep(seen[0]!.input)].sort()).toEqual(
      [
        'entries',
        'alert_kinds',
        'fix_ids',
        'seq',
        'event_type',
        'words_key',
        'actor_kind',
        'channel',
        'state_from',
        'state_to',
      ].sort(),
    );
    const sent = JSON.stringify(seen[0]);
    for (const s of HIDDEN_VALUES) expect(sent, s).not.toContain(s);
  });

  it('missing states are null, not absent', () => {
    const e = mfaEntry(1);
    delete (e as Partial<OpsTimelineEntry>).state_from;
    delete (e as Partial<OpsTimelineEntry>).state_to;
    const p = explainProjection([e], [], FIX);
    expect(p.entries[0]).toEqual({
      seq: 1,
      event_type: 'order_units.update',
      words_key: 'order_units.captured_verified',
      actor_kind: 'buyer',
      channel: 'web',
      state_from: null,
      state_to: null,
    });
  });

  it('alert kinds are deduplicated and anything that is not a plain kind is left out', () => {
    const p = explainProjection([], ['reversal', 'reversal', 'Alice Smith', 'x'.repeat(80)], FIX);
    expect(p.alert_kinds).toEqual(['reversal']);
  });
});

describe('the answer (F4)', () => {
  it('a good answer is used as it is', async () => {
    const { port } = spyPort(good);
    expect(await explainOrder([mfaEntry(1)], ['payment_unresolved'], FIX, port)).toEqual(good);
  });

  it('an action id outside the fix ids becomes none', async () => {
    const { port } = spyPort({ ...good, action_id: 'refund_everything_now' });
    expect((await explainOrder([mfaEntry(1)], [], FIX, port)).action_id).toBe('none');
  });

  it('none stays none', async () => {
    const { port } = spyPort({ ...good, action_id: 'none' });
    expect((await explainOrder([mfaEntry(1)], [], FIX, port)).action_id).toBe('none');
  });

  it('injected HTML is kept as text, not removed and not rendered (the view prints it as text)', async () => {
    const html = '<img src=x onerror=alert(1)><b>bold</b>';
    const { port } = spyPort({ ...good, what_happened: html });
    expect((await explainOrder([mfaEntry(1)], [], FIX, port)).what_happened).toBe(html);
  });

  it('over-long text is cut at 400 characters', async () => {
    const { port } = spyPort({
      ...good,
      what_happened: 'a'.repeat(1000),
      safe_now: 'b'.repeat(401),
    });
    const r = await explainOrder([mfaEntry(1)], [], FIX, port);
    expect(EXPLAIN_TEXT_MAX).toBe(400);
    expect(r.what_happened).toHaveLength(400);
    expect(r.safe_now).toHaveLength(400);
  });

  it.each([
    ['an error answer', { kind: 'error', reason: 'x' }],
    [
      'an error answer that still carries texts',
      {
        kind: 'error',
        reason: 'x',
        output: { what_happened: 'w', safe_now: 's', action_id: 'frozen_order' },
      },
    ],
    [
      'an array that carries the text fields',
      {
        kind: 'ok',
        output: Object.assign([], { what_happened: 'w', safe_now: 's', action_id: 'frozen_order' }),
        input_tokens: 0,
        output_tokens: 0,
      },
    ],
    ['a non-object', { kind: 'ok', output: 'free text', input_tokens: 0, output_tokens: 0 }],
    [
      'missing texts',
      { kind: 'ok', output: { action_id: 'frozen_order' }, input_tokens: 0, output_tokens: 0 },
    ],
  ])('%s gives the safe fallback with no action', async (_n, answer) => {
    const port: ModelPort = { model_id: 'x', complete: async () => answer as ModelResponse };
    const r = await explainOrder([mfaEntry(1)], ['frozen_order'], FIX, port);
    expect(r.action_id).toBe('none');
    expect(r.what_happened.length).toBeGreaterThan(0);
    expect(r.safe_now.length).toBeGreaterThan(0);
  });

  it('a throwing port gives the safe fallback', async () => {
    const port: ModelPort = {
      model_id: 'x',
      complete: async () => {
        throw new Error('down');
      },
    };
    expect((await explainOrder([], [], FIX, port)).action_id).toBe('none');
  });
});

describe('fix ids come in catalogue severity order', () => {
  it('critical first, then high, medium and info; ties keep the catalogue order', () => {
    const sev: Record<string, string> = {
      a: 'info',
      b: 'critical',
      c: 'high',
      d: 'critical',
      e: 'medium',
    };
    expect(orderFixIds(['a', 'b', 'c', 'd', 'e'], (k) => sev[k] ?? null)).toEqual([
      'b',
      'd',
      'c',
      'e',
      'a',
    ]);
  });
  it('a kind with no severity is left out', () => {
    expect(orderFixIds(['a', 'z'], (k) => (k === 'a' ? 'high' : null))).toEqual(['a']);
  });
});
