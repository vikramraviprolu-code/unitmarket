import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRecordings, writeRecordings } from './recorder';
import { exchange, hostileExchange, makeCanaries } from './recorder-corpus';

const OPTS = {
  recorded_at: '2026-10-23T09:30:00Z',
  origin: 'sandbox-recording: adversarial corpus run, no network',
};

afterEach(() => vi.restoreAllMocks());

describe('recorder opens no connection (B-L3, MVP-B offline rule)', () => {
  it('build and write call no socket, no http(s) request, no dns lookup and no fetch', async () => {
    const spies = [
      vi.spyOn(net, 'connect'),
      vi.spyOn(net, 'createConnection'),
      vi.spyOn(tls, 'connect'),
      vi.spyOn(http, 'request'),
      vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'),
      vi.spyOn(https, 'get'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns, 'resolve'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(globalThis, 'fetch'),
    ];
    const c = makeCanaries();
    const root = await mkdtemp(join(tmpdir(), 'umsbx-rec-net-'));
    await mkdir(join(root, 'fixtures', 'paypal'), { recursive: true });
    const r = await buildRecordings([hostileExchange(c), exchange({ scenario: 'second' })], {
      ...OPTS,
      canaries: c.all,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((await writeRecordings(root, r.files)).ok).toBe(true);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('hostile corpus end to end', () => {
  it('no canary reaches disk, in any case or encoding, after a full write', async () => {
    const c = makeCanaries();
    const root = await mkdtemp(join(tmpdir(), 'umsbx-rec-adv-'));
    await mkdir(join(root, 'fixtures', 'paypal'), { recursive: true });
    const r = await buildRecordings([hostileExchange(c)], { ...OPTS, canaries: c.all });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await writeRecordings(root, r.files);
    const dir = join(root, 'fixtures', 'paypal', 'sandbox-recordings');
    for (const name of await readdir(dir)) {
      const disk = (await readFile(join(dir, name), 'utf8')).toLowerCase();
      for (const v of c.all) {
        for (const form of [v, encodeURIComponent(v), Buffer.from(v).toString('base64')]) {
          expect(disk).not.toContain(form.toLowerCase());
        }
      }
    }
  });

  it('is idempotent: recording an already redacted exchange changes nothing but the bookkeeping', async () => {
    const c = makeCanaries();
    const first = await buildRecordings([hostileExchange(c)], OPTS);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const fx = JSON.parse(first.files[0]!.text) as { request: unknown; response: unknown };
    const again = await buildRecordings(
      [
        {
          scenario: 'hostile',
          operation: 'get_order',
          request: { ...(fx.request as object), path: '/v2/checkout/orders/5O190127TN364715T' },
          response: fx.response,
        },
      ],
      OPTS,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const a = JSON.parse(again.files[0]!.text) as { response: unknown };
    expect(a.response).toEqual(fx.response);
  });

  it('handles very deep and very wide values without hanging or leaking', async () => {
    const c = makeCanaries();
    let deep: unknown = { leaf: c.email };
    for (let i = 0; i < 60; i += 1) deep = { n: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`k${i}`, i % 7 === 0 ? c.token : 'v']),
    );
    const r = await buildRecordings(
      [
        exchange({
          response: { status: 200, headers: {}, body: { id: '5O190127TN364715T', deep, wide } },
        }),
      ],
      { ...OPTS, canaries: c.all },
    );
    // either a clean redaction or an honest refusal; never a leak
    if (r.ok) for (const f of r.files) for (const v of c.all) expect(f.text).not.toContain(v);
    else expect(['too_deep', 'residue', 'canary_survived', 'bad_input']).toContain(r.refusal.code);
  });
});
