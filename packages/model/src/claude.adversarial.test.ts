import { describe, expect, it, vi } from 'vitest';
import type { ModelRequest, ModelWire } from '@umsbx/contracts';
import cases from '../test-data/injection-cases.json';
import recorded from '../test-data/claude-recorded.json';
import {
  AGENT_TOOLS,
  BRIEF_SYSTEM,
  BriefParseOutputSchema,
  COMPOSE_SYSTEM,
  ComposeOutputSchema,
  createClaudeModel,
  createScriptedModel,
  DAILY_CAP_MICRO_USD,
  dispatchTool,
  EXPLAIN_SYSTEM,
  TXN_QUERY_SYSTEM,
} from './index';

// AI-A adversarial. Every case of the AI-1 injection set is run against the Claude adapter, with the
// recorded answers in test-data/claude-recorded.json (SYNTHETIC: hand-made patterns, not captured
// from any call). A hostile answer never adds an offer id, a price, a payee or an accepted tool.
const FORBIDDEN_KEY = /price|payee|payer|amount|total|cents|minor|approval|email|secret|token/i;
const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  return out;
};
type Rec = { status: number; body: unknown };
const asWire = (answer: Rec): { wire: ModelWire; send: ReturnType<typeof vi.fn> } => {
  const send = vi.fn(async () => ({ status: answer.status, body: JSON.stringify(answer.body) }));
  return { wire: { send }, send };
};
const build = (answer: Rec) => {
  const { wire, send } = asWire(answer);
  const model = createClaudeModel({
    wire,
    spend: { spentMicroUsd: async () => 0, charge: async () => undefined },
    clock: { now: () => new Date('2026-10-30T10:00:00Z') },
    fallback: createScriptedModel(),
    live: async () => true,
  });
  return { model, send };
};
const listings = cases.listing_injections;
const jailbreaks = cases.brief_jailbreaks;
const compose = recorded.compose as Record<string, Rec>;
const brief = recorded.brief as Record<string, Rec>;

describe('the recorded answers cover the whole injection set', () => {
  it('are labelled synthetic and have one answer per case id, no more', () => {
    expect(recorded._label).toMatch(/^SYNTHETIC/);
    expect(Object.keys(compose).sort()).toEqual(listings.map((l) => l.id).sort());
    expect(Object.keys(brief).sort()).toEqual(jailbreaks.map((j) => j.id).sort());
    expect(listings.length).toBeGreaterThanOrEqual(30);
    expect(jailbreaks.length).toBeGreaterThanOrEqual(20);
  });
  it('hold no real host, no key-like string and the payee only as the synthetic marker', () => {
    const text = JSON.stringify(recorded);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{8}|https?:\/\/|Bearer\s/);
  });
});

describe('AI-1 injected listings through the Claude adapter', () => {
  it.each(listings.map((l) => [l.id, l.text] as const))('%s', async (id, text) => {
    const candidates = [
      {
        offer_id: 'ofr_clean',
        title: 'Solar guide',
        abstract: 'Basics of solar power.',
        topics: ['solar'],
      },
      {
        offer_id: 'ofr_inj',
        title: 'Solar listing',
        abstract: `Basics of solar. ${text}`,
        topics: ['solar'],
      },
    ];
    const ids = new Set(candidates.map((c) => c.offer_id));
    const input = { need: 'solar', terms: ['solar'], ceiling_minor: 600, candidates };
    const req: ModelRequest = { purpose: 'pack_compose', system: COMPOSE_SYSTEM, input };
    const { model, send } = build(compose[id]!);
    const out = await model.complete(req);

    // The listing text travels as data inside the one user message, never as the system text.
    const sent = JSON.parse(String(send.mock.calls[0]?.[0] ?? '{}')) as {
      system?: string;
      messages?: { role: string; content: string }[];
    };
    if (send.mock.calls.length > 0) {
      expect(sent.system).toBe(COMPOSE_SYSTEM);
      expect(sent.system).not.toContain(text);
      expect(sent.messages).toHaveLength(1);
      expect(sent.messages![0]!.role).toBe('user');
      expect(sent.messages![0]!.content).toContain(JSON.stringify(text).slice(1, -1));
    }

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const parsed = ComposeOutputSchema.safeParse(out.output);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.picks.every((p) => ids.has(p.offer_id))).toBe(true);
    expect(keysOf(parsed.data).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(parsed.data)).not.toMatch(/EVIL/);
    expect(parsed.data.picks.length).toBeLessThanOrEqual(5);
    // Nothing outside the read-only list is accepted, and no tool call is executed here.
    for (const c of parsed.data.tool_calls)
      expect(dispatchTool(c).accepted).toBe((AGENT_TOOLS as readonly string[]).includes(c.tool));
    expect(
      parsed.data.tool_calls
        .filter((c) => /order|pay|capture|refund/i.test(c.tool))
        .every((c) => !dispatchTool(c).accepted),
    ).toBe(true);
  });
  it('a hostile answer that names an offer outside the list always falls back to the scripted pick', async () => {
    const hostile = compose['L01']!; // pattern 0: obeys the injection
    const scripted = createScriptedModel();
    const input = {
      need: 'solar',
      terms: ['solar'],
      ceiling_minor: 600,
      candidates: [
        {
          offer_id: 'ofr_clean',
          title: 'Solar guide',
          abstract: 'Basics of solar power.',
          topics: ['solar'],
        },
      ],
    };
    const req: ModelRequest = { purpose: 'pack_compose', system: COMPOSE_SYSTEM, input };
    const { model } = build(hostile);
    expect(await model.complete(req)).toEqual(await scripted.complete(req));
  });
});

describe('AI-2 jailbreak briefs through the Claude adapter', () => {
  it.each(
    jailbreaks.map((j) => {
      const r = (j as { repeat?: { unit: string; times: number } }).repeat;
      const text = 'text' in j ? j.text : r!.unit.repeat(r!.times);
      return [j.id, text] as const;
    }),
  )('%s', async (id, text) => {
    const req: ModelRequest = {
      purpose: 'brief_parse',
      system: BRIEF_SYSTEM,
      input: { raw_text: text },
    };
    const { model, send } = build(brief[id]!);
    const out = await model.complete(req);
    if (text.length > 2000) {
      // Over the brief cap: refused before anything is charged or sent.
      expect(send).not.toHaveBeenCalled();
      expect(out).toEqual({ kind: 'error', reason: 'too_long' });
      return;
    }
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const parsed = BriefParseOutputSchema.safeParse(out.output);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.keys(parsed.data).sort()).toEqual(
      ['ceiling_minor', 'currency', 'language', 'need', 'option', 'terms'].sort(),
    );
    expect(parsed.data.need.length).toBeLessThanOrEqual(2000);
    if (parsed.data.ceiling_minor !== null)
      expect(parsed.data.ceiling_minor).toBeGreaterThanOrEqual(0);
  });
});

describe('a key or secret in an answer is not copied anywhere by the adapter', () => {
  it('an answer that echoes a key-like string does not reach the output when it fails the schema', async () => {
    const echo = {
      status: 200,
      body: {
        content: [{ type: 'text', text: 'key SYNTHETIC-MODEL-KEY-echo' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const { model } = build(echo);
    const out = await model.complete({
      purpose: 'brief_parse',
      system: BRIEF_SYSTEM,
      input: { raw_text: 'solar' },
    });
    expect(JSON.stringify(out)).not.toContain('SYNTHETIC-MODEL-KEY');
  });
});

// INT-GA / GA-L1, GA-L2, GA-L3, GA-L6: the two assist purposes through the Claude adapter, over a fake wire only.
// A well-formed answer is used; an extra key, an unknown field, a long value or an action outside fix_ids falls
// back to the scripted model; an input that carries any identity key is refused before the wire is called; a
// spent daily cap sends nothing. The system prompt is the adapter's own constant, whatever the caller passed.
describe('GA: txn_query and explain_order through the Claude adapter', () => {
  const envelope = (output: unknown) => ({
    status: 200,
    body: {
      model: 'claude-haiku-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(output) }],
      usage: { input_tokens: 40, output_tokens: 20 },
    },
  });
  const txn = (rest: unknown): ModelRequest => ({
    purpose: 'txn_query',
    system: 'caller text is ignored',
    input: { rest },
  });
  const projection = {
    entries: [
      {
        seq: 1,
        event_type: 'orders.update',
        words_key: 'orders.unresolved',
        actor_kind: 'system',
        channel: 'job',
        state_from: 'capture_requested',
        state_to: 'unresolved',
      },
    ],
    alert_kinds: ['payment_unresolved'],
    fix_ids: ['frozen_order', 'payment_unresolved'],
  };
  const explain = (input: unknown): ModelRequest => ({
    purpose: 'explain_order',
    system: '',
    input,
  });
  const goodExplain = {
    what_happened: 'Unclear capture.',
    safe_now: 'Wait.',
    action_id: 'payment_unresolved',
  };

  it('a well-formed txn_query answer is used, and the system prompt is TXN_QUERY_SYSTEM', async () => {
    const { model, send } = build(envelope({ status: 'attention', channel: 'agent' }));
    const r = await model.complete(txn('stuck by my agent'));
    expect(r).toMatchObject({
      kind: 'ok',
      output: { status: 'attention', channel: 'agent' },
      served_model: 'claude-haiku-5-5',
    });
    const body = JSON.parse(send.mock.calls[0]![0] as string) as {
      system: string;
      messages: { content: string }[];
    };
    expect(body.system).toBe(TXN_QUERY_SYSTEM);
    expect(JSON.parse(body.messages[0]!.content)).toEqual({ rest: 'stuck by my agent' });
  });

  it('a well-formed explain_order answer is used, and the system prompt is EXPLAIN_SYSTEM', async () => {
    const { model, send } = build(envelope(goodExplain));
    const r = await model.complete(explain(projection));
    expect(r).toMatchObject({ kind: 'ok', output: goodExplain });
    const body = JSON.parse(send.mock.calls[0]![0] as string) as { system: string };
    expect(body.system).toBe(EXPLAIN_SYSTEM);
  });

  it.each([
    ['an unknown field', { status: 'paid', password: 'x' }],
    ['a long value', { q: 'x'.repeat(101) }],
    ['a non-string value', { min_minor: 500 }],
    [
      'too many keys',
      Object.fromEntries(
        [
          'from',
          'to',
          'min_minor',
          'max_minor',
          'currency',
          'status',
          'refund',
          'case',
          'buyer',
          'seller',
          'q',
          'ref',
          'channel',
        ].map((k) => [k, 'x']),
      ),
    ],
    ['an array', ['status', 'paid']],
  ])('txn_query: %s falls back to the scripted answer', async (_n, output) => {
    const { model, send } = build(envelope(output));
    const r = await model.complete(txn('stuck'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: 'ok', served_model: 'scripted-v1' });
    const scripted = await createScriptedModel().complete(txn('stuck'));
    expect(r).toEqual(scripted);
  });

  it.each([
    ['an extra key', { ...goodExplain, link: 'https://example.invalid' }],
    ['an action outside fix_ids', { ...goodExplain, action_id: 'refund_failed' }],
    ['a long text', { ...goodExplain, what_happened: 'x'.repeat(401) }],
    ['a missing text', { action_id: 'none', safe_now: 'Wait.' }],
  ])('explain_order: %s falls back to the scripted answer', async (_n, output) => {
    const { model, send } = build(envelope(output));
    const r = await model.complete(explain(projection));
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: 'ok', served_model: 'scripted-v1' });
  });

  it.each([
    ['txn_query with a second key', txn('x'), { rest: 'stuck', order_ref: 'ord_x' }],
    ['txn_query over 500 characters', txn('x'.repeat(501)), null],
    ['explain with order_ref', explain({ ...projection, order_ref: 'ord_x' }), null],
    ['explain with buyer', explain({ ...projection, buyer: 'Alice' }), null],
    [
      'explain with an entry actor_id',
      explain({ ...projection, entries: [{ ...projection.entries[0], actor_id: 'buy_1' }] }),
      null,
    ],
    [
      'explain with an entry at',
      explain({
        ...projection,
        entries: [{ ...projection.entries[0], at: '2026-11-05T10:00:00Z' }],
      }),
      null,
    ],
    [
      'explain with an entry amount',
      explain({ ...projection, entries: [{ ...projection.entries[0], amount: 500 }] }),
      null,
    ],
  ])('%s is refused before the wire is called', async (_n, req, input) => {
    const { model, send } = build(envelope({ status: 'paid' }));
    await model.complete(input === null ? req : { ...req, input });
    expect(send).not.toHaveBeenCalled();
  });

  it('a spent daily cap sends nothing for either purpose', async () => {
    const send = vi.fn(async () => ({ status: 200, body: '{}' }));
    const model = createClaudeModel({
      wire: { send },
      spend: { spentMicroUsd: async () => DAILY_CAP_MICRO_USD, charge: async () => undefined },
      clock: { now: () => new Date('2026-10-30T10:00:00Z') },
      fallback: createScriptedModel(),
      live: async () => true,
    });
    expect(await model.complete(txn('stuck'))).toMatchObject({
      kind: 'ok',
      served_model: 'scripted-v1',
    });
    expect(await model.complete(explain(projection))).toMatchObject({
      kind: 'ok',
      served_model: 'scripted-v1',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('the kill switch off sends nothing', async () => {
    const send = vi.fn(async () => ({ status: 200, body: '{}' }));
    const model = createClaudeModel({
      wire: { send },
      spend: { spentMicroUsd: async () => 0, charge: async () => undefined },
      clock: { now: () => new Date('2026-10-30T10:00:00Z') },
      fallback: createScriptedModel(),
      live: async () => false,
    });
    await model.complete(txn('stuck'));
    await model.complete(explain(projection));
    expect(send).not.toHaveBeenCalled();
  });
});
