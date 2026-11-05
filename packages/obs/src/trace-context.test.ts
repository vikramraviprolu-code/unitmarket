// INT-TR0 / TR0.2: the context store. One context per request, job pass, webhook, CLI run or seed block,
// carried through async calls and never mixed between them.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TraceContext } from '@umsbx/contracts';
import {
  cliTraceContext,
  currentTraceContext,
  extendTraceContext,
  uaFamilyOf,
  withTraceContext,
} from './trace-context';

const base = (id: string, over: Partial<TraceContext> = {}): TraceContext => ({
  id,
  at: '2026-11-04T10:00:00.000Z',
  channel: 'web',
  actor_kind: 'buyer',
  actor_id: 'buy_1',
  on_behalf_of: null,
  mandate_id: null,
  mfa: false,
  req_id: null,
  ip_hash: null,
  ua_family: null,
  api_key_id: null,
  job: null,
  tool: null,
  ...over,
});

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('withTraceContext and currentTraceContext', () => {
  it('has no context outside a call and the given one inside it', async () => {
    expect(currentTraceContext()).toBeUndefined();
    const seen = await withTraceContext(base('ctx_a'), async () => {
      await tick(1);
      return currentTraceContext();
    });
    expect(seen?.id).toBe('ctx_a');
    expect(currentTraceContext()).toBeUndefined();
  });

  it('returns what the callback returns and passes its error on', async () => {
    expect(await withTraceContext(base('ctx_a'), async () => 42)).toBe(42);
    await expect(
      withTraceContext(base('ctx_a'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(currentTraceContext()).toBeUndefined();
  });

  it('100 interleaved promises never see another promise’s context', async () => {
    const wrong: string[] = [];
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        withTraceContext(base(`ctx_${i}`, { actor_id: `buy_${i}` }), async () => {
          for (let step = 0; step < 4; step += 1) {
            await tick((i * 7 + step * 3) % 5);
            const now = currentTraceContext();
            if (now?.id !== `ctx_${i}` || now.actor_id !== `buy_${i}`)
              wrong.push(`${i}:${now?.id}`);
          }
        }),
      ),
    );
    expect(wrong).toEqual([]);
  });

  it('a nested context hides the outer one only for its own call', async () => {
    await withTraceContext(base('ctx_outer'), async () => {
      await withTraceContext(base('ctx_inner'), async () => {
        expect(currentTraceContext()?.id).toBe('ctx_inner');
      });
      expect(currentTraceContext()?.id).toBe('ctx_outer');
    });
  });

  it('the stored context is a copy: changing the object afterwards changes nothing', async () => {
    const c = base('ctx_a');
    await withTraceContext(c, async () => {
      (c as { actor_id: string | null }).actor_id = 'someone_else';
      expect(currentTraceContext()?.actor_id).toBe('buy_1');
    });
  });
});

describe('extendTraceContext', () => {
  it('opens a child of the current context with a patch and a derived id', async () => {
    await withTraceContext(base('ctx_req', { req_id: 'r1', channel: 'api' }), async () => {
      await extendTraceContext(
        { channel: 'mcp', tool: 'buy_unit', mandate_id: 'man_1' },
        async () => {
          const c = currentTraceContext()!;
          expect(c.id).toBe('ctx_req:buy_unit');
          expect(c.channel).toBe('mcp');
          expect(c.tool).toBe('buy_unit');
          expect(c.mandate_id).toBe('man_1');
          expect(c.req_id).toBe('r1');
          expect(c.actor_id).toBe('buy_1');
        },
      );
      expect(currentTraceContext()?.id).toBe('ctx_req');
    });
  });

  it('runs the callback unchanged when no context is open', async () => {
    const r = await extendTraceContext({ tool: 'x' }, async () => currentTraceContext());
    expect(r).toBeUndefined();
  });
});

describe('uaFamilyOf', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'browser'],
    ['Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/121.0', 'browser'],
    ['curl/8.5.0', 'curl'],
    ['Wget/1.21', 'curl'],
    ['python-requests/2.31', 'sdk'],
    ['node-fetch/1.0', 'sdk'],
    ['okhttp/4.12', 'sdk'],
    ['unitmarket-agent/1.0 anthropic-sdk', 'sdk'],
    ['SomeRandomBot', 'other'],
    ['', 'other'],
  ])('%s is %s', (ua, family) => {
    expect(uaFamilyOf(ua)).toBe(family);
  });

  it('is other for a missing header and never returns any part of the header', () => {
    expect(uaFamilyOf(null)).toBe('other');
    const f = uaFamilyOf('CanaryBrowser/9.9 (secret-token-123)');
    expect(['browser', 'curl', 'sdk', 'other']).toContain(f);
  });
});

describe('cliTraceContext', () => {
  it('is an operator on the cli channel with an id that names the os user hash, never the name', () => {
    const c = cliTraceContext({
      id: 'ctx_cli_1',
      at: '2026-11-04T10:00:00.000Z',
      user_hash: 'ab'.repeat(8),
      job: 'safety:stop',
    });
    expect(c).toMatchObject({
      id: 'ctx_cli_1',
      channel: 'cli',
      actor_kind: 'operator',
      actor_id: `cli:${'ab'.repeat(8)}`,
      mfa: false,
      job: 'safety:stop',
      on_behalf_of: null,
      req_id: null,
    });
  });
});

// INT-TC1: Next bundles @umsbx/obs into each server compilation, so one process can hold more than one copy of
// this module. The store must be one per process. Vitest loads one module graph, so this block loads it twice.
describe('two copies of the module in one process (INT-TC1)', () => {
  type Copy = typeof import('./trace-context');
  let a: Copy;
  let b: Copy;
  beforeAll(async () => {
    a = await import('./trace-context');
    vi.resetModules();
    b = await import('./trace-context');
  });

  it('really are two copies', () => {
    expect(b).not.toBe(a);
    expect(b.withTraceContext).not.toBe(a.withTraceContext);
  });

  it('show no context outside a call', () => {
    expect(a.currentTraceContext()).toBeUndefined();
    expect(b.currentTraceContext()).toBeUndefined();
  });

  it('share a context opened by copy A with copy B, across an await', async () => {
    const seen = await a.withTraceContext(base('ctx_a'), async () => {
      await tick(1);
      return b.currentTraceContext();
    });
    expect(seen?.id).toBe('ctx_a');
    expect(b.currentTraceContext()).toBeUndefined();
  });

  it('share a context opened by copy B with copy A', async () => {
    const seen = await b.withTraceContext(base('ctx_b'), async () => a.currentTraceContext());
    expect(seen?.id).toBe('ctx_b');
  });

  it('extend a parent opened by the other copy', async () => {
    const seen = await a.withTraceContext(base('ctx_p'), () =>
      b.extendTraceContext({ tool: 'txn_query' }, async () => a.currentTraceContext()),
    );
    expect(seen?.id).toBe('ctx_p:txn_query');
    expect(seen?.tool).toBe('txn_query');
  });

  it('bind a mandate on the context the other copy opened', async () => {
    const seen = await a.withTraceContext(base('ctx_m'), async () => {
      b.bindTraceMandate('man_1');
      return a.currentTraceContext();
    });
    expect(seen?.mandate_id).toBe('man_1');
  });
});
