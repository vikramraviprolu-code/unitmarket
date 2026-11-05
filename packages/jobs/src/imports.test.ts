// POB-I1 (D-089): the background run of a web import. The loop knows nothing of the import rules: it gets an
// `imports` runner with two calls, recover and runNext. recover runs once at the start of the loop (or of a
// leadership term); runNext runs in a worker that the loop kicks after every pass, never inside the pass, so
// a batch that takes a minute does not hold up the payments work. One chain at a time. A throw is logged and
// ends the chain; the next kick tries again. stop() waits for the batch that is running.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsDeps } from '@umsbx/contracts';
import { nextDueAt, recoverOnStartup, runDue } from '@umsbx/payments';
import { fakeClock } from '@umsbx/runtime';
import { startLoop } from './loop';
import { createImportWorker } from './imports';
import type { ImportRunner } from './imports';

vi.mock('@umsbx/payments', () => ({
  runDue: vi.fn(),
  recoverOnStartup: vi.fn(),
  nextDueAt: vi.fn(),
}));

const logs: { msg: string; level: string; fields: Record<string, unknown> }[] = [];
const log = {
  log: (e: { msg: string; level: string; fields: Record<string, unknown> }) => {
    logs.push(e);
  },
  child: () => log,
};
const zero = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

function makeDeps() {
  return {
    db: { query: vi.fn(), exec: vi.fn(), transaction: vi.fn(), dialect: 'pglite' },
    clock: fakeClock('2026-11-05T10:00:00.000Z'),
    ids: { next: () => 'x', nonce: () => 'n' },
    log,
    audit: { record: () => Promise.resolve() },
    switches: { isOn: () => Promise.resolve(true) },
    config: { abandoned_checkout_ms: 86_400_000 },
    environment: 'dryrun',
    paypal: {},
    content: {},
    sweepWindows: () => Promise.resolve({ ended: 0 }),
  } as unknown as PaymentsDeps & { sweepWindows: () => Promise<{ ended: number }> };
}

beforeEach(() => {
  logs.length = 0;
  vi.mocked(runDue).mockReset().mockResolvedValue(zero);
  vi.mocked(recoverOnStartup).mockReset().mockResolvedValue({ resumed: 0, repaired: 0 });
  vi.mocked(nextDueAt).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

const runner = (
  queue: boolean[],
): ImportRunner & { runNext: ReturnType<typeof vi.fn>; recover: ReturnType<typeof vi.fn> } => ({
  recover: vi.fn(async () => ({ interrupted: 0 })),
  runNext: vi.fn(async () => ({ ran: queue.shift() ?? false })),
});

describe('createImportWorker', () => {
  it('a kick runs batches until none is left, then stops', async () => {
    const r = runner([true, true, true]);
    const w = createImportWorker(r, log);
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(4); // three batches and the empty answer
    await w.stop();
  });

  it('a kick with nothing queued asks once and goes idle', async () => {
    const r = runner([]);
    const w = createImportWorker(r, log);
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(1);
  });

  it('kicks while a chain is running do not start a second chain', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    let active = 0;
    let peak = 0;
    const r: ImportRunner = {
      recover: async () => ({ interrupted: 0 }),
      runNext: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return { ran: false };
      }),
    };
    const w = createImportWorker(r, log);
    w.kick();
    w.kick();
    w.kick();
    await Promise.resolve();
    release();
    await w.idle();
    expect(peak).toBe(1);
    expect(r.runNext).toHaveBeenCalledTimes(1);
  });

  it('a kick after the chain ended starts a new one', async () => {
    const r = runner([]);
    const w = createImportWorker(r, log);
    w.kick();
    await w.idle();
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(2);
  });

  it('a throw is logged without the text of the error beyond its message, ends the chain and the next kick tries again', async () => {
    let n = 0;
    const r: ImportRunner = {
      recover: async () => ({ interrupted: 0 }),
      runNext: vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error('database gone');
        return { ran: false };
      }),
    };
    const w = createImportWorker(r, log);
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      { msg: 'jobs.imports.failed', level: 'error', fields: { error: 'database gone' } },
    ]);
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(2);
  });

  it('stop waits for the batch in progress and later kicks do nothing', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    let finished = false;
    const r: ImportRunner = {
      recover: async () => ({ interrupted: 0 }),
      runNext: vi.fn(async () => {
        await gate;
        finished = true;
        return { ran: true };
      }),
    };
    const w = createImportWorker(r, log);
    w.kick();
    const stopping = w.stop();
    release();
    await stopping;
    expect(finished).toBe(true);
    // the chain ended at stop: it did not ask for another batch
    expect(r.runNext).toHaveBeenCalledTimes(1);
    w.kick();
    await w.idle();
    expect(r.runNext).toHaveBeenCalledTimes(1);
  });
});

describe('startLoop imports option', () => {
  it('recovers once at the start, then kicks the worker after each pass', async () => {
    const r = runner([]);
    const loop = startLoop(makeDeps(), { max_sleep_ms: 5, max_items: 7, imports: r });
    await vi.waitFor(() => expect(r.runNext.mock.calls.length).toBeGreaterThanOrEqual(3));
    await loop.stop();
    expect(r.recover).toHaveBeenCalledTimes(1);
    expect(logs.filter((l) => l.msg === 'jobs.loop.pass_failed')).toEqual([]);
  });

  it('a slow batch does not hold the next pass: payments passes go on while it runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const r: ImportRunner = {
      recover: async () => ({ interrupted: 0 }),
      runNext: vi.fn(async () => {
        await gate;
        return { ran: false };
      }),
    };
    const loop = startLoop(makeDeps(), { max_sleep_ms: 5, max_items: 7, imports: r });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(5));
    expect(r.runNext).toHaveBeenCalledTimes(1);
    release();
    await loop.stop();
  });

  it('a recover that throws is logged and the loop still runs', async () => {
    const r: ImportRunner = {
      recover: vi.fn(async () => {
        throw new Error('no table');
      }),
      runNext: vi.fn(async () => ({ ran: false })),
    };
    const loop = startLoop(makeDeps(), { max_sleep_ms: 5, max_items: 7, imports: r });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
    expect(logs.find((l) => l.msg === 'jobs.loop.imports_recover_failed')).toMatchObject({
      level: 'error',
      fields: { error: 'no table' },
    });
  });

  it('runs while the outbound switch is off: the import has its own may-fetch check, not the loop', async () => {
    const d = makeDeps();
    (d as unknown as { switches: { isOn: () => Promise<boolean> } }).switches = {
      isOn: () => Promise.resolve(false),
    };
    const r = runner([]);
    const loop = startLoop(d, { max_sleep_ms: 5, max_items: 7, imports: r });
    await vi.waitFor(() => expect(r.runNext.mock.calls.length).toBeGreaterThanOrEqual(2));
    await loop.stop();
  });

  it('kickImports on the handle starts the worker at once', async () => {
    const r = runner([]);
    const loop = startLoop(makeDeps(), { max_sleep_ms: 60_000, max_items: 7, imports: r });
    await vi.waitFor(() => expect(r.runNext).toHaveBeenCalledTimes(1));
    loop.kickImports();
    await vi.waitFor(() => expect(r.runNext).toHaveBeenCalledTimes(2));
    await loop.stop();
  });

  it('without the option the loop is as before and the handle can still be kicked', async () => {
    const loop = startLoop(makeDeps(), { max_sleep_ms: 5, max_items: 7 });
    await vi.waitFor(() => expect(vi.mocked(runDue).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(() => loop.kickImports()).not.toThrow();
    await loop.stop();
  });
});
