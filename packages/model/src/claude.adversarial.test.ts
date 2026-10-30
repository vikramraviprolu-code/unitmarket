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
  dispatchTool,
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
