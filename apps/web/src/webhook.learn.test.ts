// CO-1d (D-038): the learn path of the webhook route's behaviour, with stub seams (no database, no
// network). While the window is open a delivery is answered 503 `learning` and ONLY the learn seam
// is touched: verification, intake and the allowed-check are never called. Window closed or no learn
// seam: the behaviour is exactly the one of CO-3.
import { describe, expect, it, vi } from 'vitest';
import type { Clock, IsoUtc, LogEvent, Logger, WebhookVerdict } from '@umsbx/contracts';
import { answerFor, createLearnRecorder, receiveWebhook } from './server/webhook';
import type { LearnedFacts, LearnOutcome, WebhookWiring } from './server/webhook';

const clock: Clock = { now: () => new Date('2026-10-25T12:00:00Z') };
const logs = (): Logger & { events: LogEvent[] } => {
  const events: LogEvent[] = [];
  const make = (): Logger => ({
    log: (e) => {
      events.push(e);
    },
    child: () => make(),
  });
  return Object.assign(make(), { events });
};
const HEADERS = {
  'paypal-transmission-id': 'SENTINEL-TRANSMISSION-ID',
  'paypal-transmission-sig': 'SENTINEL-SIGNATURE==',
  'paypal-cert-url': 'https://certs.example.invalid/v1/notifications/certs/CERT-1',
};
const DELIVERY = { headers: HEADERS, raw_body: '{"SENTINEL":"BODY"}' };
const verified: WebhookVerdict = { kind: 'unverifiable' };

function wiring(over: Partial<WebhookWiring> = {}) {
  const log = logs();
  const calls = { allowed: 0, verify: 0, intake: 0 };
  const w: WebhookWiring = {
    clock,
    log,
    allowed: async () => {
      calls.allowed += 1;
      return true;
    },
    verify: async () => {
      calls.verify += 1;
      return verified;
    },
    intake: async () => {
      calls.intake += 1;
      return { http: 503, outcome: 'unverifiable' };
    },
    ...over,
  };
  return { w, log, calls };
}

describe('receiveWebhook with an open learn window', () => {
  it('answers 503 learning, calls the learn seam with the headers and nothing else', async () => {
    const record = vi.fn(async (): Promise<LearnOutcome> => 'recorded');
    const { w, calls } = wiring({ learn: { open: () => true, record } });
    const res = await receiveWebhook(w, DELIVERY);
    expect(res).toEqual({ http: 503, outcome: 'learning' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(HEADERS);
    expect(calls).toEqual({ allowed: 0, verify: 0, intake: 0 });
  });
  it('the answer is the same empty 503 as any refusal (it says nothing about learning)', async () => {
    const { w } = wiring({ learn: { open: () => true, record: async () => 'recorded' } });
    const res = await receiveWebhook(w, DELIVERY);
    expect(answerFor(res)).toEqual({
      status: 503,
      code: 'unavailable',
      message: 'Try again later.',
    });
  });
  it.each<LearnOutcome>(['recorded', 'known', 'nothing', 'switch_off', 'error', 'unrecordable'])(
    'learn outcome %s: still 503, still nothing verified or stored',
    async (outcome) => {
      const { w, calls } = wiring({ learn: { open: () => true, record: async () => outcome } });
      expect(await receiveWebhook(w, DELIVERY)).toEqual({ http: 503, outcome: 'learning' });
      expect(calls).toEqual({ allowed: 0, verify: 0, intake: 0 });
    },
  );
  it('a throwing learn seam is still 503 and still verifies nothing', async () => {
    const { w, calls, log } = wiring({
      learn: {
        open: () => true,
        record: async () => {
          throw new Error('SENTINEL-ERROR-TEXT');
        },
      },
    });
    expect(await receiveWebhook(w, DELIVERY)).toEqual({ http: 503, outcome: 'learning' });
    expect(calls).toEqual({ allowed: 0, verify: 0, intake: 0 });
    expect(JSON.stringify(log.events)).not.toContain('SENTINEL');
  });
  it('the delivery log line holds class fields only', async () => {
    const { w, log } = wiring({ learn: { open: () => true, record: async () => 'recorded' } });
    await receiveWebhook(w, DELIVERY);
    const line = log.events.find((e) => e.msg === 'webhook.delivery');
    expect(line?.fields).toEqual({
      http: 503,
      outcome: 'learning',
      verdict: 'not_checked',
      learn: 'recorded',
    });
    expect(JSON.stringify(log.events)).not.toContain('SENTINEL');
  });
  it('the window is asked per delivery: it can close between two of them', async () => {
    let open = true;
    const record = vi.fn(async (): Promise<LearnOutcome> => 'recorded');
    const { w, calls } = wiring({ learn: { open: () => open, record } });
    await receiveWebhook(w, DELIVERY);
    open = false;
    const second = await receiveWebhook(w, DELIVERY);
    expect(record).toHaveBeenCalledTimes(1);
    expect(second.outcome).toBe('unverifiable');
    expect(calls).toEqual({ allowed: 1, verify: 1, intake: 1 });
  });
});

describe('receiveWebhook with the window closed or absent', () => {
  it('closed: the CO-3 path, and the learn seam is never called', async () => {
    const record = vi.fn(async (): Promise<LearnOutcome> => 'recorded');
    const { w, calls } = wiring({ learn: { open: () => false, record } });
    const res = await receiveWebhook(w, DELIVERY);
    expect(res).toEqual({ http: 503, outcome: 'unverifiable' });
    expect(record).not.toHaveBeenCalled();
    expect(calls).toEqual({ allowed: 1, verify: 1, intake: 1 });
  });
  it('absent: the CO-3 path', async () => {
    const { w, calls } = wiring();
    expect((await receiveWebhook(w, DELIVERY)).outcome).toBe('unverifiable');
    expect(calls).toEqual({ allowed: 1, verify: 1, intake: 1 });
  });
  it('closed and webhook not allowed: 503 disabled, no learn, no verify', async () => {
    const record = vi.fn(async (): Promise<LearnOutcome> => 'recorded');
    const { w, calls } = wiring({
      allowed: async () => false,
      learn: { open: () => false, record },
    });
    expect(await receiveWebhook(w, DELIVERY)).toEqual({ http: 503, outcome: 'disabled' });
    expect(record).not.toHaveBeenCalled();
    expect(calls.verify).toBe(0);
  });
});

describe('createLearnRecorder', () => {
  const facts = (n = 1): LearnedFacts => ({
    host: 'certs.example.invalid',
    path: `/v1/notifications/certs/CERT-${n}`,
    subject: 'CN=a.invalid, O=Org',
    subject_cn: 'a.invalid',
    issuer: 'CN=Issuer',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: '2027-01-01T00:00:00.000Z',
    fingerprint_sha256: `AA:BB:${String(n).padStart(2, '0')}`,
  });
  const make = (over: Partial<Parameters<typeof createLearnRecorder>[0]> = {}) => {
    const log = logs();
    const audited: LearnedFacts[] = [];
    const order: string[] = [];
    const lookup = vi.fn(async (): Promise<LearnedFacts | null> => facts());
    const switchOn = vi.fn(async () => true);
    const record = createLearnRecorder({
      log,
      switchOn,
      lookup,
      recordable: () => true,
      audit: async (f) => {
        order.push('audit');
        audited.push(f);
      },
      ...over,
    });
    return { record, log, audited, lookup, switchOn, order };
  };

  it('writes one audit row and one log line with exactly the facts, audit first', async () => {
    const { record, log, audited, order } = make();
    const orig = log.log;
    log.log = (e) => {
      order.push(e.msg);
      orig(e);
    };
    expect(await record(HEADERS)).toBe('recorded');
    expect(audited).toEqual([facts()]);
    const lines = log.events.filter((e) => e.msg === 'webhook.cert_learned');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual(facts());
    expect(order).toEqual(['audit', 'webhook.cert_learned']);
  });
  it('hands the lookup the headers it was given', async () => {
    const { record, lookup } = make();
    await record(HEADERS);
    expect(lookup).toHaveBeenCalledWith(HEADERS);
  });
  it('the webhook switch off: nothing is looked up, nothing is written', async () => {
    const { record, lookup, audited } = make({ switchOn: async () => false });
    expect(await record(HEADERS)).toBe('switch_off');
    expect(lookup).not.toHaveBeenCalled();
    expect(audited).toEqual([]);
  });
  it('no facts (nothing learnable): nothing is written', async () => {
    const { record, audited, log } = make({ lookup: async () => null });
    expect(await record(HEADERS)).toBe('nothing');
    expect(audited).toEqual([]);
    expect(log.events).toEqual([]);
  });
  it('one row per distinct certificate: the same one again is `known`, nothing more is written', async () => {
    const { record, audited, log } = make();
    expect(await record(HEADERS)).toBe('recorded');
    expect(await record(HEADERS)).toBe('known');
    expect(await record(HEADERS)).toBe('known');
    expect(audited).toHaveLength(1);
    expect(log.events.filter((e) => e.msg === 'webhook.cert_learned')).toHaveLength(1);
  });
  it('a different certificate is recorded; at most 8 rows per process, then nothing is even looked up', async () => {
    let n = 0;
    const { record, audited } = make({ lookup: async () => facts(++n) });
    const results: LearnOutcome[] = [];
    for (let i = 0; i < 12; i++) results.push(await record(HEADERS));
    expect(results.filter((r) => r === 'recorded')).toHaveLength(8);
    expect(audited).toHaveLength(8);
    expect(results.slice(8)).toEqual(['nothing', 'nothing', 'nothing', 'nothing']);
    expect(n).toBe(8);
  });
  it('an audit failure is `error`, writes no log line, and the next delivery tries again', async () => {
    let fail = true;
    const audited: LearnedFacts[] = [];
    const { record, log } = make({
      audit: async (f) => {
        if (fail) throw new Error('db down');
        audited.push(f);
      },
    });
    expect(await record(HEADERS)).toBe('error');
    expect(log.events.filter((e) => e.msg === 'webhook.cert_learned')).toEqual([]);
    fail = false;
    expect(await record(HEADERS)).toBe('recorded');
    expect(audited).toHaveLength(1);
  });
  it('facts that redaction would change are `unrecordable`: no audit row, one line with host, path and fingerprint only', async () => {
    const { record, audited, log } = make({ recordable: () => false });
    expect(await record(HEADERS)).toBe('unrecordable');
    expect(audited).toEqual([]);
    expect(log.events.filter((e) => e.msg === 'webhook.cert_learned')).toEqual([]);
    const lines = log.events.filter((e) => e.msg === 'webhook.cert_learn_unrecordable');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({
      host: facts().host,
      path: facts().path,
      fingerprint_sha256: facts().fingerprint_sha256,
    });
  });
  it('recordable facts are recorded as before; the check sees exactly the eight facts', async () => {
    const seen: LearnedFacts[] = [];
    const { record, audited } = make({
      recordable: (f) => {
        seen.push(f);
        return true;
      },
    });
    expect(await record(HEADERS)).toBe('recorded');
    expect(seen).toEqual([facts()]);
    expect(audited).toHaveLength(1);
  });
  it('twelve deliveries at once for twelve different certificates record at most 8 rows (F4)', async () => {
    let n = 0;
    const { record, audited } = make({
      lookup: async () => {
        const mine = ++n;
        await new Promise((r) => setTimeout(r, 5)); // all twelve are past the first size check
        return facts(mine);
      },
    });
    const all = await Promise.all(Array.from({ length: 12 }, () => record(HEADERS)));
    expect(all.filter((r) => r === 'recorded')).toHaveLength(8);
    expect(audited).toHaveLength(8);
    expect(all.filter((r) => r === 'nothing')).toHaveLength(4);
  });
  it('a lookup that throws is `error`, never a throw', async () => {
    const { record } = make({
      lookup: async () => {
        throw new Error('boom');
      },
    });
    expect(await record(HEADERS)).toBe('error');
  });
  it('writes only the eight listed fields even if the lookup returns more', async () => {
    const extra = { ...facts(), body: 'SENTINEL-BODY', signature: 'SENTINEL-SIG', url: 'SENTINEL' };
    const { record, audited, log } = make({ lookup: async () => extra as LearnedFacts });
    await record(HEADERS);
    expect(Object.keys(audited[0] as object).sort()).toEqual(Object.keys(facts()).sort());
    expect(JSON.stringify(log.events)).not.toContain('SENTINEL');
  });
});

describe('time and ids in this file', () => {
  it('uses an injected clock only', () => {
    expect(clock.now().toISOString() as IsoUtc).toBe('2026-10-25T12:00:00.000Z');
  });
});
