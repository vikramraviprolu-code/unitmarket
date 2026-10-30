import { describe, expect, it, vi } from 'vitest';
import type { Clock, ModelPort, ModelRequest, ModelSpendStore, ModelWire } from '@umsbx/contracts';
import {
  BRIEF_SYSTEM,
  COMPOSE_SYSTEM,
  createClaudeModel,
  createScriptedModel,
  CLAUDE_MODEL_ID,
} from './index';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  PRICE_INPUT_MICRO_PER_MTOK,
  PRICE_OUTPUT_MICRO_PER_MTOK,
  SAFETY_FACTOR,
  estimateInputTokens,
  worstCaseMicroUsd,
} from './caps';

// AI-A. The Claude adapter against a fake wire. No key, no socket, no real answer: every answer here
// is a synthetic envelope written by the test.
const clock: Clock = { now: () => new Date('2026-10-30T12:00:00.000Z') };
const BRIEF_IN = { raw_text: 'I need a solar guide under $5, english, keep it' };
const COMPOSE_IN = {
  need: 'solar',
  terms: ['solar'],
  ceiling_minor: 600,
  candidates: [
    {
      offer_id: 'ofr_a',
      title: 'Solar guide',
      abstract: 'Basics of solar power.',
      topics: ['solar'],
    },
    { offer_id: 'ofr_b', title: 'Wind guide', abstract: 'Basics of wind power.', topics: ['wind'] },
  ],
};
const briefReq = (input: unknown = BRIEF_IN): ModelRequest => ({
  purpose: 'brief_parse',
  system: BRIEF_SYSTEM,
  input,
});
const composeReq = (input: unknown = COMPOSE_IN): ModelRequest => ({
  purpose: 'pack_compose',
  system: COMPOSE_SYSTEM,
  input,
});
const BRIEF_OUT = {
  need: 'solar guide',
  ceiling_minor: 500,
  currency: 'USD',
  option: 'keep_retrieve',
  language: 'en',
  terms: ['solar', 'guide'],
};
const COMPOSE_OUT = { picks: [{ offer_id: 'ofr_a', reason: 'Matches solar.' }], tool_calls: [] };

const envelope = (
  text: string,
  over: { stop_reason?: string; status?: number; usage?: unknown; content?: unknown } = {},
) => ({
  status: over.status ?? 200,
  body: JSON.stringify({
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    content: over.content ?? [{ type: 'text', text }],
    stop_reason: over.stop_reason ?? 'end_turn',
    usage: over.usage ?? { input_tokens: 11, output_tokens: 22 },
  }),
});

function rig(
  answer: (body: string) => { status: number; body: string } | Promise<never>,
  live: () => Promise<boolean> = async () => true,
) {
  const events: string[] = [];
  const sent: string[] = [];
  const wire: ModelWire = {
    async send(body) {
      events.push('send');
      sent.push(body);
      return answer(body);
    },
  };
  const charges: { micro: number; note: string }[] = [];
  const spend: ModelSpendStore = {
    async spentMicroUsd() {
      return 0;
    },
    async charge(micro, note) {
      events.push('charge');
      charges.push({ micro, note });
    },
  };
  const scripted = createScriptedModel();
  const fallbackSpy = vi.fn((r: ModelRequest) => scripted.complete(r));
  const fallback: ModelPort = { model_id: scripted.model_id, complete: fallbackSpy };
  const model = createClaudeModel({ wire, spend, clock, fallback, live });
  return { model, events, sent, charges, fallbackSpy, scripted };
}

describe('the adapter', () => {
  it('is named for the model it calls', () => {
    expect(CLAUDE_MODEL_ID).toBe('claude-haiku-5-5');
    expect(rig(() => envelope('{}')).model.model_id).toBe('claude-haiku-5-5');
  });
});

describe('the request body', () => {
  it('brief_parse: model, 800 tokens, thinking off, low effort, BRIEF_SYSTEM, input as JSON text', async () => {
    const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await r.model.complete(briefReq());
    expect(r.sent).toHaveLength(1);
    const body = JSON.parse(r.sent[0]!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'].sort(),
    );
    expect(body['model']).toBe('claude-haiku-5-5');
    expect(body['max_tokens']).toBe(800);
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body['system']).toBe(BRIEF_SYSTEM);
    expect(body['messages']).toEqual([{ role: 'user', content: JSON.stringify(BRIEF_IN) }]);
  });
  it('pack_compose: COMPOSE_SYSTEM and the candidates as JSON text', async () => {
    const r = rig(() => envelope(JSON.stringify(COMPOSE_OUT)));
    await r.model.complete(composeReq());
    const body = JSON.parse(r.sent[0]!) as Record<string, unknown>;
    expect(body['system']).toBe(COMPOSE_SYSTEM);
    expect(body['messages']).toEqual([{ role: 'user', content: JSON.stringify(COMPOSE_IN) }]);
  });
  it('sends no tools, no tool choice, no temperature, and the system text is the request system', async () => {
    const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await r.model.complete(briefReq());
    const text = r.sent[0]!;
    for (const k of ['tools', 'tool_choice', 'temperature', 'top_p', 'top_k', 'stream'])
      expect(JSON.parse(text)).not.toHaveProperty(k);
  });
  it('sends the system text the caller gave, not a stored copy', async () => {
    const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await r.model.complete({ ...briefReq(), system: 'custom system text' });
    expect((JSON.parse(r.sent[0]!) as { system: string }).system).toBe('custom system text');
  });
});

describe('a good answer', () => {
  it('brief_parse: parsed, schema-checked, with the usage the API reported; fallback unused', async () => {
    const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    expect(await r.model.complete(briefReq())).toEqual({
      kind: 'ok',
      output: BRIEF_OUT,
      input_tokens: 11,
      output_tokens: 22,
    });
    expect(r.fallbackSpy).not.toHaveBeenCalled();
  });
  it('pack_compose: ids kept, price and payee keys dropped by sanitiseModelOutput', async () => {
    const r = rig(() =>
      envelope(
        JSON.stringify({
          picks: [{ offer_id: 'ofr_a', reason: 'Matches solar.', price: 1, payee: 'X' }],
          tool_calls: [{ tool: 'search_catalogue', args: { query: 'solar', price: 0 } }],
        }),
      ),
    );
    const out = await r.model.complete(composeReq());
    expect(out).toEqual({
      kind: 'ok',
      output: {
        picks: [{ offer_id: 'ofr_a', reason: 'Matches solar.' }],
        tool_calls: [{ tool: 'search_catalogue', args: { query: 'solar' } }],
      },
      input_tokens: 11,
      output_tokens: 22,
    });
    expect(r.fallbackSpy).not.toHaveBeenCalled();
  });
  // Review fix 1: this replaces an earlier test that accepted a null budget when the text states one.
  // That contradicted the spec goal (the model must not silently drop or change the reader's budget).
  it('the budget and its currency must equal what the text states: null, other number, other currency all fall back', async () => {
    for (const over of [
      { ceiling_minor: null },
      { ceiling_minor: null, currency: null },
      { ceiling_minor: 400 },
      { currency: 'EUR' },
      { currency: null },
    ]) {
      const r = rig(() => envelope(JSON.stringify({ ...BRIEF_OUT, ...over })));
      await r.model.complete(briefReq());
      expect(r.fallbackSpy, JSON.stringify(over)).toHaveBeenCalledTimes(1);
    }
    const ok = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await ok.model.complete(briefReq());
    expect(ok.fallbackSpy).not.toHaveBeenCalled();
  });
  it('a text with no budget needs a null budget and null currency', async () => {
    const noBudget = { raw_text: 'a guide to solar panels' };
    const good = rig(() =>
      envelope(JSON.stringify({ ...BRIEF_OUT, ceiling_minor: null, currency: null })),
    );
    await good.model.complete(briefReq(noBudget));
    expect(good.fallbackSpy).not.toHaveBeenCalled();
    const invented = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await invented.model.complete(briefReq(noBudget));
    expect(invented.fallbackSpy).toHaveBeenCalledTimes(1);
  });
  it('kill switch: live false or a rejecting live means no charge, no send, the scripted answer', async () => {
    for (const live of [async () => false, async () => Promise.reject(new Error('db down'))]) {
      const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)), live);
      const req = briefReq();
      expect(await r.model.complete(req)).toEqual(await r.scripted.complete(req));
      expect(r.events).toEqual([]);
      expect(r.fallbackSpy).toHaveBeenCalledTimes(1);
    }
  });
  it('kill switch is read on every call: off after a good call stops the next one', async () => {
    let on = true;
    const r = rig(
      () => envelope(JSON.stringify(BRIEF_OUT)),
      async () => on,
    );
    await r.model.complete(briefReq());
    on = false;
    await r.model.complete(briefReq());
    expect(r.sent).toHaveLength(1);
    expect(r.fallbackSpy).toHaveBeenCalledTimes(1);
  });
  it('accepts one code fence around the JSON, nothing else around it', async () => {
    const fenced = rig(() => envelope('```json\n' + JSON.stringify(BRIEF_OUT) + '\n```'));
    expect((await fenced.model.complete(briefReq())).kind).toBe('ok');
    expect(fenced.fallbackSpy).not.toHaveBeenCalled();
    const chatty = rig(() => envelope('Here you go: ' + JSON.stringify(BRIEF_OUT)));
    await chatty.model.complete(briefReq());
    expect(chatty.fallbackSpy).toHaveBeenCalledTimes(1);
  });
});

describe('each cause of fallback hands the same request to the scripted model, once', () => {
  const causes: [string, () => ReturnType<typeof envelope> | Promise<never>][] = [
    ['HTTP 400', () => envelope('{}', { status: 400 })],
    ['HTTP 401', () => envelope('{}', { status: 401 })],
    ['HTTP 429', () => envelope('{}', { status: 429 })],
    ['HTTP 500', () => envelope('{}', { status: 500 })],
    ['a redirect', () => ({ status: 302, body: '' })],
    ['a refusal', () => envelope('', { stop_reason: 'refusal' })],
    ['max_tokens', () => envelope('{"need":"x', { stop_reason: 'max_tokens' })],
    ['tool_use', () => envelope(JSON.stringify(BRIEF_OUT), { stop_reason: 'tool_use' })],
    ['pause_turn', () => envelope(JSON.stringify(BRIEF_OUT), { stop_reason: 'pause_turn' })],
    ['no stop_reason', () => ({ status: 200, body: JSON.stringify({ content: [] }) })],
    ['a body that is not JSON', () => ({ status: 200, body: 'upstream connect error' })],
    ['an empty body', () => ({ status: 200, body: '' })],
    ['text that is not JSON', () => envelope('I will not do that.')],
    ['empty content', () => envelope('', { content: [] })],
    ['a non-text block', () => envelope('', { content: [{ type: 'thinking', thinking: 'x' }] })],
    [
      'two text blocks',
      () =>
        envelope('', {
          content: [
            { type: 'text', text: '{}' },
            { type: 'text', text: '{}' },
          ],
        }),
    ],
    ['an answer of the wrong shape', () => envelope(JSON.stringify({ need: 5 }))],
    [
      'a budget the text does not state',
      () => envelope(JSON.stringify({ ...BRIEF_OUT, ceiling_minor: 100 })),
    ],
    ['an answer with an extra key', () => envelope(JSON.stringify({ ...BRIEF_OUT, price: 1 }))],
    ['a timeout', () => Promise.reject(new Error('timeout'))],
    [
      'a network error',
      () => Promise.reject(Object.assign(new Error('boom'), { kind: 'network' })),
    ],
  ];
  it.each(causes)('brief_parse: %s', async (_name, answer) => {
    const r = rig(answer);
    const req = briefReq();
    const out = await r.model.complete(req);
    expect(r.fallbackSpy).toHaveBeenCalledTimes(1);
    expect(r.fallbackSpy).toHaveBeenCalledWith(req);
    expect(out).toEqual(await r.scripted.complete(req));
    expect(out.kind).toBe('ok');
  });
  it.each([
    [
      'an unknown offer id',
      JSON.stringify({ picks: [{ offer_id: 'ofr_zzz', reason: 'x' }], tool_calls: [] }),
    ],
    [
      'six picks',
      JSON.stringify({
        picks: Array.from({ length: 6 }, (_, i) => ({ offer_id: `ofr_${i}`, reason: 'x' })),
        tool_calls: [],
      }),
    ],
    [
      'a duplicate pick',
      JSON.stringify({
        picks: [
          { offer_id: 'ofr_a', reason: 'x' },
          { offer_id: 'ofr_a', reason: 'y' },
        ],
        tool_calls: [],
      }),
    ],
    ['no tool_calls key', JSON.stringify({ picks: [{ offer_id: 'ofr_a', reason: 'x' }] })],
  ])('pack_compose: %s', async (_name, text) => {
    const r = rig(() => envelope(text));
    const req = composeReq();
    const out = await r.model.complete(req);
    expect(r.fallbackSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual(await r.scripted.complete(req));
  });
});

describe('input checks happen before anything is charged or sent', () => {
  it('an input the scripted model would reject never leaves', async () => {
    const r = rig(() => envelope('{}'));
    for (const req of [
      briefReq({ raw_text: 5 }),
      briefReq('text'),
      briefReq(null),
      briefReq({ raw_text: 'x'.repeat(2001) }),
      composeReq({ need: 'x' }),
      composeReq({ ...COMPOSE_IN, extra: 1 }),
      { ...briefReq(), purpose: 'other' } as unknown as ModelRequest,
    ]) {
      const out = await r.model.complete(req);
      expect(out).toEqual(await r.scripted.complete(req));
    }
    expect(r.events).toEqual([]);
  });
  it('an input over 8000 estimated tokens answers from the fallback with no charge and no call', async () => {
    const big = {
      ...COMPOSE_IN,
      candidates: Array.from({ length: 6 }, (_, i) => ({
        offer_id: `ofr_${i}`,
        title: 'Solar',
        abstract: 'solar '.repeat(800),
        topics: ['solar'],
      })),
    };
    const r = rig(() => envelope(JSON.stringify(COMPOSE_OUT)));
    const out = await r.model.complete(composeReq(big));
    expect(r.events).toEqual([]);
    expect(out).toEqual(await r.scripted.complete(composeReq(big)));
  });
});

describe('the worst case is charged before the call', () => {
  it('prices are the AI-A constants and the estimate is ceil(chars / 3), capped at 8000', () => {
    expect(PRICE_INPUT_MICRO_PER_MTOK).toBe(100_000);
    expect(PRICE_OUTPUT_MICRO_PER_MTOK).toBe(500_000);
    expect(SAFETY_FACTOR).toBe(2);
    expect(MAX_INPUT_TOKENS).toBe(8000);
    expect(MAX_OUTPUT_TOKENS).toBe(800);
    expect(estimateInputTokens(0)).toBe(0);
    expect(estimateInputTokens(1)).toBe(1);
    expect(estimateInputTokens(3)).toBe(1);
    expect(estimateInputTokens(4)).toBe(2);
    expect(estimateInputTokens(1_000_000)).toBe(333_334); // not capped here: the adapter refuses above 8000
  });
  it('worst case is the safety factor times (input at 0.10 plus 800 output at 0.50) per million', () => {
    expect(worstCaseMicroUsd(0)).toBe(800);
    expect(worstCaseMicroUsd(30)).toBe(806);
    expect(worstCaseMicroUsd(8000)).toBe(2400);
  });
  it('one charge, before the send, for the estimate of system plus input', async () => {
    const r = rig(() => envelope(JSON.stringify(BRIEF_OUT)));
    await r.model.complete(briefReq());
    expect(r.events).toEqual(['charge', 'send']);
    const chars = BRIEF_SYSTEM.length + JSON.stringify(BRIEF_IN).length;
    expect(r.charges).toEqual([
      {
        micro: worstCaseMicroUsd(Math.ceil(chars / 3)),
        note: expect.stringContaining('brief_parse'),
      },
    ]);
  });
  it('a fallback after the call is still charged: the charge is not refunded', async () => {
    const r = rig(() => envelope('', { stop_reason: 'refusal' }));
    await r.model.complete(briefReq());
    expect(r.charges).toHaveLength(1);
  });
  it('the note names the purpose and holds no input text', async () => {
    const r = rig(() => envelope(JSON.stringify(COMPOSE_OUT)));
    await r.model.complete(composeReq());
    expect(r.charges[0]!.note).toContain('pack_compose');
    expect(r.charges[0]!.note).not.toContain('Solar');
    expect(r.charges[0]!.note.length).toBeLessThan(80);
  });
});

describe('the adapter never throws', () => {
  it('a wire that rejects with a plain string still gets an answer from the fallback', async () => {
    const r = rig(() => Promise.reject('plain string'));
    expect((await r.model.complete(briefReq())).kind).toBe('ok');
  });
});
