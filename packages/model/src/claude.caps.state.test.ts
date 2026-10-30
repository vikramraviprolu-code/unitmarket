import { describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelRequest, ModelSpendStore, ModelWire } from '@umsbx/contracts';
import { BRIEF_SYSTEM, createClaudeModel, createScriptedModel } from './index';
import { DAILY_CAP_MICRO_USD, TOTAL_CAP_MICRO_USD, worstCaseMicroUsd } from './caps';

// AI-A. The spend caps, with a fake clock that crosses midnight. The store is an in-memory ledger
// that sums by time, as the composition's audit_log store does. No wire is real.
const IN = { raw_text: 'solar guide' };
const REQ: ModelRequest = { purpose: 'brief_parse', system: BRIEF_SYSTEM, input: IN };
const COST = worstCaseMicroUsd(Math.ceil((BRIEF_SYSTEM.length + JSON.stringify(IN).length) / 3));
const OK_BODY = JSON.stringify({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        need: 'solar guide',
        ceiling_minor: null,
        currency: null,
        option: null,
        language: null,
        terms: ['solar'],
      }),
    },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 10 },
});

function rig(startIso: string, rows: { at: string; micro: number }[] = []) {
  let now = new Date(startIso);
  const ledger = [...rows];
  const sinceCalls: (string | null)[] = [];
  const spend: ModelSpendStore = {
    async spentMicroUsd(since) {
      sinceCalls.push(since);
      return ledger.filter((r) => since === null || r.at >= since).reduce((a, r) => a + r.micro, 0);
    },
    async charge(micro) {
      ledger.push({ at: now.toISOString(), micro });
    },
  };
  const send = vi.fn<ModelWire['send']>(async () => ({ status: 200, body: OK_BODY }));
  const wire: ModelWire = { send };
  const scripted = createScriptedModel();
  const fallbackSpy = vi.fn((r: ModelRequest) => scripted.complete(r));
  const fallback: ModelPort = { model_id: scripted.model_id, complete: fallbackSpy };
  const model = createClaudeModel({
    wire,
    spend,
    clock: { now: () => now },
    fallback,
    live: async () => true,
  });
  return {
    model,
    send,
    fallbackSpy,
    ledger,
    sinceCalls,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe('the caps are the AI-A numbers', () => {
  it('USD 2.00 a day and USD 20.00 in total, in micro USD', () => {
    expect(DAILY_CAP_MICRO_USD).toBe(2_000_000);
    expect(TOTAL_CAP_MICRO_USD).toBe(20_000_000);
  });
});

describe('daily cap', () => {
  it('a call whose charge would pass the cap is refused; one that lands exactly on it goes', async () => {
    const exact = rig('2026-10-30T10:00:00Z', [
      { at: '2026-10-30T09:00:00.000Z', micro: DAILY_CAP_MICRO_USD - COST },
    ]);
    await exact.model.complete(REQ);
    expect(exact.send).toHaveBeenCalledTimes(1);

    const over = rig('2026-10-30T10:00:00Z', [
      { at: '2026-10-30T09:00:00.000Z', micro: DAILY_CAP_MICRO_USD - COST + 1 },
    ]);
    const out = await over.model.complete(REQ);
    expect(over.send).not.toHaveBeenCalled();
    expect(over.fallbackSpy).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe('ok');
  });
  it('a refused charge sends nothing and writes nothing', async () => {
    const r = rig('2026-10-30T10:00:00Z', [
      { at: '2026-10-30T09:00:00.000Z', micro: DAILY_CAP_MICRO_USD },
    ]);
    for (let i = 0; i < 5; i++) await r.model.complete(REQ);
    expect(r.send).not.toHaveBeenCalled();
    expect(r.ledger).toHaveLength(1);
  });
  it('spending accumulates call by call until the day is full, then the fallback answers', async () => {
    const r = rig('2026-10-30T10:00:00Z');
    const calls = Math.floor(DAILY_CAP_MICRO_USD / COST);
    for (let i = 0; i < calls + 3; i++) await r.model.complete(REQ);
    expect(r.send).toHaveBeenCalledTimes(calls);
    expect(r.fallbackSpy).toHaveBeenCalledTimes(3);
    expect(r.ledger.reduce((a, x) => a + x.micro, 0)).toBeLessThanOrEqual(DAILY_CAP_MICRO_USD);
  });
  it('the day is 00:00 UTC of the injected clock: full at 23:59:59, open again at 00:00:00', async () => {
    const r = rig('2026-10-30T23:59:59.000Z', [
      { at: '2026-10-30T23:00:00.000Z', micro: DAILY_CAP_MICRO_USD },
    ]);
    await r.model.complete(REQ);
    expect(r.send).not.toHaveBeenCalled();
    r.setNow('2026-10-31T00:00:00.000Z');
    await r.model.complete(REQ);
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.sinceCalls).toContain('2026-10-30T00:00:00.000Z');
    expect(r.sinceCalls).toContain('2026-10-31T00:00:00.000Z');
    expect(r.sinceCalls).toContain(null);
  });
  it('a charge one millisecond before midnight does not count on the next day', async () => {
    const r = rig('2026-10-31T00:30:00.000Z', [
      { at: '2026-10-30T23:59:59.999Z', micro: DAILY_CAP_MICRO_USD },
    ]);
    await r.model.complete(REQ);
    expect(r.send).toHaveBeenCalledTimes(1);
  });
});

describe('total cap', () => {
  it('stops at USD 20.00 over many days even when today is empty', async () => {
    const r = rig('2026-11-20T10:00:00Z', [
      { at: '2026-10-30T10:00:00.000Z', micro: 10_000_000 },
      { at: '2026-11-10T10:00:00.000Z', micro: TOTAL_CAP_MICRO_USD - 10_000_000 - COST + 1 },
    ]);
    await r.model.complete(REQ);
    expect(r.send).not.toHaveBeenCalled();
    expect(r.fallbackSpy).toHaveBeenCalledTimes(1);
  });
  it('one micro USD below the line goes', async () => {
    const r = rig('2026-11-20T10:00:00Z', [
      { at: '2026-10-30T10:00:00.000Z', micro: 10_000_000 },
      { at: '2026-11-10T10:00:00.000Z', micro: TOTAL_CAP_MICRO_USD - 10_000_000 - COST },
    ]);
    await r.model.complete(REQ);
    expect(r.send).toHaveBeenCalledTimes(1);
  });
});

describe('the store failing closed', () => {
  it('a read error sends nothing and the fallback answers', async () => {
    const send = vi.fn(async () => ({ status: 200, body: OK_BODY }));
    const scripted = createScriptedModel();
    const model = createClaudeModel({
      wire: { send },
      spend: {
        spentMicroUsd: async () => {
          throw new Error('db down');
        },
        charge: async () => undefined,
      },
      clock: { now: () => new Date('2026-10-30T10:00:00Z') },
      fallback: scripted,
      live: async () => true,
    });
    expect((await model.complete(REQ)).kind).toBe('ok');
    expect(send).not.toHaveBeenCalled();
  });
  it('a charge that fails sends nothing', async () => {
    const send = vi.fn(async () => ({ status: 200, body: OK_BODY }));
    const model = createClaudeModel({
      wire: { send },
      spend: {
        spentMicroUsd: async () => 0,
        charge: async () => {
          throw new Error('db down');
        },
      },
      clock: { now: () => new Date('2026-10-30T10:00:00Z') },
      fallback: createScriptedModel(),
      live: async () => true,
    });
    expect((await model.complete(REQ)).kind).toBe('ok');
    expect(send).not.toHaveBeenCalled();
  });
  it('a store that reports a negative or non-finite total is treated as full', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const send = vi.fn(async () => ({ status: 200, body: OK_BODY }));
      const model = createClaudeModel({
        wire: { send },
        spend: { spentMicroUsd: async () => bad, charge: async () => undefined },
        clock: { now: () => new Date('2026-10-30T10:00:00Z') },
        fallback: createScriptedModel(),
        live: async () => true,
      });
      await model.complete(REQ);
      expect(send).not.toHaveBeenCalled();
    }
  });
});

describe('parallel calls cannot both spend the last of the budget', () => {
  it('with room for one call, five at once send exactly one', async () => {
    const r = rig('2026-10-30T10:00:00Z', [
      { at: '2026-10-30T09:00:00.000Z', micro: DAILY_CAP_MICRO_USD - COST },
    ]);
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => r.model.complete(REQ)));
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.fallbackSpy).toHaveBeenCalledTimes(4);
    expect(outs.every((o) => o.kind === 'ok')).toBe(true);
  });
});
