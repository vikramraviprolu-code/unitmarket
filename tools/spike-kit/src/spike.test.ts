// Spike kit tests (lane B-L6). Every test here runs with no network: the spies below fail the test
// if net, tls, http, https, dns or fetch is touched. Credentials are placeholders built at runtime
// and are never real. The kit is exercised through an injected fake wire or the dry-run replay.
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_CALLS,
  CALL_CAP,
  REFUSAL_CODES,
  SANDBOX_API,
  SANDBOX_HOST,
  assertAllowedCall,
  assertModeAllows,
  createSpikeFetchWire,
  createRedactor,
  createReplayWire,
  main,
  preflight,
  redactionSelfTest,
  runSpike,
} from './spike';
import type { Deps, Wire, WireRequest } from './spike';

// ---- no-network spies ----------------------------------------------------------------------------
const spies: Array<{ name: string; spy: ReturnType<typeof vi.fn> }> = [];
function spyOn(name: string, target: object, key: string) {
  const spy = vi.fn(() => {
    throw new Error(`network use forbidden: ${name}`);
  });
  const spyOnAny = vi.spyOn as unknown as (
    t: object,
    k: string,
  ) => { mockImplementation: (f: () => never) => unknown };
  spyOnAny(target, key).mockImplementation(spy as () => never);
  spies.push({ name, spy });
}
beforeEach(() => {
  spies.length = 0;
  spyOn('net.connect', net, 'connect');
  spyOn('net.createConnection', net, 'createConnection');
  spyOn('tls.connect', tls, 'connect');
  spyOn('http.request', http, 'request');
  spyOn('http.get', http, 'get');
  spyOn('https.request', https, 'request');
  spyOn('https.get', https, 'get');
  spyOn('dns.lookup', dns, 'lookup');
  spyOn('dns.resolve', dns, 'resolve');
  spyOn('dns.promises.lookup', dns.promises, 'lookup');
  spyOn('dns.promises.resolve', dns.promises, 'resolve');
  const f = vi.fn(() => {
    throw new Error('network use forbidden: fetch');
  });
  vi.stubGlobal('fetch', f);
  spies.push({ name: 'fetch', spy: f });
});
afterEach(() => {
  const used = spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.name);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(used, 'network functions touched').toEqual([]);
});

// ---- helpers --------------------------------------------------------------------------------------
const part = (...p: string[]) => p.join('');
const FAKE_ID = part('fake', '-client-', 'id-0001');
const FAKE_SECRET = part('fake', '-client-', 'secret-0002-zzzz');
const FAKE_TOKEN = part('A21AA', 'FAKETOKEN', 'abcdefghijklmnopqrstuvwxyz0123456789');
const REPO = path.resolve(new URL('../../..', import.meta.url).pathname);
const FIXTURES = path.join(REPO, 'fixtures/paypal/docs-examples');
const LOG = [
  '| Id | Date | Decision | Owner | Notes |',
  '| D-023 | 2026-10-22 | Sandbox accounts. This decision does not authorise any outbound call. | Owner | x |',
  '| D-004 | 2026-10-01 | Some unrelated decision about money handling. | Owner | x |',
  '| D-011 | 2026-10-05 | Another unrelated decision. | Owner | x |',
  '| D-013 | 2026-10-06 | The sandbox host constant lives in one module. | Owner | x |',
  // Synthetic well-formed rows for tests only. They are NOT in docs/decision-log.md.
  '| D-024 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-12-31; approved in writing 2026-10-25 | Owner | x |',
  '| D-025 | 2026-10-25 | SPIKE GO: scope=spike-read; operator=vikram; valid_until=2026-12-31; approved in writing 2026-10-25 | Owner | x |',
  '| D-026 | 2026-10-25 | SPIKE GO: scope=spike-read; operator=sakthi; valid_until=2026-12-31; approved in writing 2026-10-25 | Owner | x |',
  '| D-027 | 2026-10-01 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-10-25; approved in writing 2026-10-01 | Owner | x |',
  '| D-028 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-10-26; approved in writing 2026-10-25 | Owner | x |',
  '| D-029 | 2026-10-25 | SPIKE GO: scope=everything; operator=vikram; valid_until=2026-12-31; approved in writing 2026-10-25 | Owner | x |',
  '| D-030 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-13-45; approved in writing 2026-10-25 | Owner | x |',
  '| D-031 | 2026-10-25 | Owner written go for the read-only spike. | Owner | x |',
  '| D-032 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-12-31 | Owner | x |',
].join('\n');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Harness {
  deps: Deps;
  outLines: string[];
  errLines: string[];
  prompts: string[];
  answers: string[];
}
function harness(over: Partial<Deps> & { answers?: string[] } = {}): Harness {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const prompts: string[] = [];
  const answers = over.answers ?? [];
  const deps: Deps = {
    env: {},
    argv: [],
    stdinIsTTY: false,
    nowIso: () => '2026-10-26T10:00:00.000Z',
    homeDir: path.join(tmp, 'home'),
    tmpDir: path.join(tmp, 'tmp'),
    repoRoot: REPO,
    readText: (p) => {
      if (p.endsWith('decision-log.md')) return LOG;
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    fixtureDir: FIXTURES,
    ask: async (q) => {
      prompts.push(q);
      return answers.length > 0 ? (answers.shift() as string) : 'y';
    },
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    fs: {
      mkdirp: (p) => void fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, t) => fs.writeFileSync(p, t),
      exists: (p) => fs.existsSync(p),
      realpath: (p) => fs.realpathSync(p),
    },
    ...over,
  };
  return { deps, outLines, errLines, prompts, answers };
}

const realEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  SPIKE_OPERATOR: 'vikram',
  SPIKE_APPROVAL_REF: 'D-024',
  SPIKE_MODE: 'read',
  PAYPAL_CLIENT_ID: FAKE_ID,
  PAYPAL_CLIENT_SECRET: FAKE_SECRET,
  ...extra,
});

function readOut(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir)) out[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}

// A scripted fake wire for non-dry runs. No socket exists behind it.
function fakeWire(opts: { pending?: boolean; log?: WireRequest[]; failAt?: number } = {}): Wire {
  let n = 0;
  let orders = 0;
  const idOf = (k: number) => `FAKE${String(k).padStart(13, '0')}`;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg123abc456', ...headers },
    text: JSON.stringify(body),
  });
  return async (req) => {
    n += 1;
    opts.log?.push(req);
    if (opts.failAt === n) throw new Error('socket hang up');
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === '/v1/oauth2/token')
      return json(200, {
        access_token: FAKE_TOKEN,
        token_type: 'Bearer',
        expires_in: 32400,
        nonce: 'canary-nonce-123',
        scope: 'https://uri.example.invalid/services/payments/payment',
      });
    if (/\/v2\/checkout\/orders\/[A-Z0-9]+$/.test(p) && req.method === 'GET') {
      if (p.endsWith('AAAAAAAAAAAAAAAAA'))
        return json(404, {
          name: 'RESOURCE_NOT_FOUND',
          details: [{ issue: 'INVALID_RESOURCE_ID' }],
          debug_id: 'dbg404',
        });
      return json(200, {
        id: p.split('/').pop(),
        status: 'APPROVED',
        payer: { email_address: 'canary.payer@example.test', name: { given_name: 'Canary' } },
        purchase_units: [
          { reference_id: 'spike-A', amount: { currency_code: 'USD', value: '1.00' } },
        ],
      });
    }
    if (p === '/v2/checkout/orders') {
      orders += 1;
      return json(201, {
        id: idOf(orders),
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { rel: 'self', href: `${SANDBOX_API}/v2/checkout/orders/${idOf(orders)}` },
          {
            rel: 'payer-action',
            href: `https://www.sandbox.example.invalid/checkoutnow?token=${idOf(orders)}`,
          },
        ],
        purchase_units: [{ reference_id: 'spike-A', custom_id: 'spike-custom-1' }],
      });
    }
    if (p.endsWith('/capture'))
      return json(201, {
        id: idOf(orders),
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'CAP00000000000001',
                  status: opts.pending ? 'PENDING' : 'COMPLETED',
                  status_details: opts.pending
                    ? { reason: 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION' }
                    : {},
                  amount: { currency_code: 'USD', value: '1.00' },
                },
              ],
            },
          },
        ],
      });
    if (p.includes('/v2/payments/captures/') && p.endsWith('/refund'))
      return json(201, {
        id: 'REF00000000000001',
        status: 'COMPLETED',
        links: [{ rel: 'up', href: '/x' }],
      });
    return json(200, {
      id: 'GEN00000000000001',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '1.00' },
    });
  };
}

// ---- allow-list and constants ---------------------------------------------------------------------
describe('constants and allow-list', () => {
  it('has its own sandbox host constant and a 40 call cap', () => {
    expect(SANDBOX_HOST).toBe('api-m.sandbox.' + 'paypal.com');
    expect(SANDBOX_API).toBe(`https://${SANDBOX_HOST}`);
    expect(CALL_CAP).toBe(40);
  });
  it('lists exactly the runbook calls', () => {
    expect(ALLOWED_CALLS.map((c) => `${c.method} ${c.template}`).sort()).toEqual(
      [
        'GET /v2/checkout/orders/{id}',
        'GET /v2/payments/captures/{id}',
        'GET /v2/payments/refunds/{id}',
        'POST /v1/oauth2/token',
        'POST /v2/checkout/orders',
        'POST /v2/checkout/orders/{id}/capture',
        'POST /v2/payments/captures/{id}/refund',
      ].sort(),
    );
  });
  it.each([
    ['GET', '/v1/payments/payment'],
    ['POST', '/v1/payments/payouts'],
    ['POST', '/v2/customer/partner-referrals'],
    ['GET', '/v1/identity/oauth2/userinfo'],
    ['POST', '/v1/notifications/webhooks'],
    ['GET', '/v2/checkout/orders/lowercase'],
    ['GET', '/v2/checkout/orders/' + 'A'.repeat(37)],
    ['DELETE', '/v2/checkout/orders/ABC'],
    ['GET', '/v2/checkout/orders/ABC/../../v1/payments'],
    ['GET', '/v2/checkout/orders/ABC?x=1'],
    ['POST', '/v2/checkout/orders/ABC'],
  ])('refuses %s %s', (m, p) => {
    expect(() => assertAllowedCall(m, p)).toThrow(/path_not_allowed/);
  });
  it('accepts a runbook path', () => {
    expect(
      assertAllowedCall('POST', '/v2/checkout/orders/5O190127TN364715T/capture').template,
    ).toBe('/v2/checkout/orders/{id}/capture');
  });
});

// ---- preflight refusals ---------------------------------------------------------------------------
describe('preflight refusals', () => {
  const good = () => harness({ env: realEnv(), stdinIsTTY: true });
  it('passes with every gate satisfied', () => {
    const r = preflight(good().deps);
    expect(r.ok).toBe(true);
  });
  it('accepts a well-formed SPIKE GO row: read mode with spike-read, read mode with spike-write, write mode with spike-write', () => {
    const readOnly = good();
    readOnly.deps.env['SPIKE_APPROVAL_REF'] = 'D-025';
    expect(preflight(readOnly.deps).ok).toBe(true);
    expect(preflight(good().deps).ok).toBe(true); // D-024 spike-write, read mode
    const w = good();
    w.deps.env['SPIKE_MODE'] = 'write';
    expect(preflight(w.deps).ok).toBe(true);
    const s = good();
    s.deps.env['SPIKE_OPERATOR'] = 'sakthi';
    s.deps.env['SPIKE_APPROVAL_REF'] = 'D-026';
    expect(preflight(s.deps).ok).toBe(true);
  });
  it('accepts a row on its last valid day', () => {
    const h = good();
    h.deps.env['SPIKE_APPROVAL_REF'] = 'D-028';
    h.deps.nowIso = () => '2026-10-26T23:59:59.000Z';
    expect(preflight(h.deps).ok).toBe(true);
  });
  const cases: Array<[string, (h: Harness) => void]> = [
    ['ci_set', (h) => void (h.deps.env['CI'] = 'true')],
    ['transport_env_override', (h) => void (h.deps.env['HTTPS_PROXY'] = 'http://127.0.0.1:9')],
    ['not_tty', (h) => void (h.deps.stdinIsTTY = false)],
    ['bad_operator', (h) => void (h.deps.env['SPIKE_OPERATOR'] = 'mallory')],
    ['bad_operator', (h) => void delete h.deps.env['SPIKE_OPERATOR']],
    ['bad_mode', (h) => void (h.deps.env['SPIKE_MODE'] = 'delete')],
    ['bad_mode', (h) => void delete h.deps.env['SPIKE_MODE']],
    ['approval_ref_missing', (h) => void delete h.deps.env['SPIKE_APPROVAL_REF']],
    ['approval_ref_pattern', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'whatever')],
    ['approval_ref_pattern', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-24')],
    ['approval_ref_unknown', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-099')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-023')],
    // H1: allow-list. Rows without the structured SPIKE GO marker never authorise.
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-011')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-004')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-013')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-031')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-032')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-029')],
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-030')],
    ['approval_expired', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-027')],
    [
      'approval_expired',
      (h) => {
        h.deps.env['SPIKE_APPROVAL_REF'] = 'D-028';
        h.deps.nowIso = () => '2026-10-27T00:00:00.000Z';
      },
    ],
    [
      'approval_scope_mismatch',
      (h) => {
        h.deps.env['SPIKE_APPROVAL_REF'] = 'D-025';
        h.deps.env['SPIKE_MODE'] = 'write';
      },
    ],
    ['approval_operator_mismatch', (h) => void (h.deps.env['SPIKE_OPERATOR'] = 'sakthi')],
    ['approval_operator_mismatch', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-026')],
    ['decision_log_unreadable', (h) => void (h.deps.readText = () => null)],
    ['credentials_missing', (h) => void delete h.deps.env['PAYPAL_CLIENT_ID']],
    ['credentials_missing', (h) => void (h.deps.env['PAYPAL_CLIENT_SECRET'] = '')],
    ['live_value', (h) => void (h.deps.env['PAYPAL_CLIENT_ID'] = 'abc-LIVE-def')],
    ['live_value', (h) => void (h.deps.env['SPIKE_OPERATOR'] = 'vikram-production')],
    ['live_value', (h) => void (h.deps.env['PAYPAL_ENVIRONMENT'] = 'Production')],
    ['live_value', (h) => void (h.deps.env['PAYPAL_LIVE_CLIENT_ID'] = 'x')],
    [
      'non_sandbox_host',
      (h) => void (h.deps.env['PAYPAL_API_BASE'] = 'https://api-m.' + 'paypal.com'),
    ],
    ['non_sandbox_host', (h) => void (h.deps.env['SPIKE_NOTE'] = 'http://evil.example.org/x')],
    ['bad_args', (h) => void (h.deps.argv = ['--yolo'])],
    ['output_in_repo', (h) => void (h.deps.argv = ['--out', path.join(REPO, 'spike-out')])],
    ['output_in_repo', (h) => void (h.deps.argv = ['--out', path.join(REPO, 'docs')])],
  ];
  it.each(cases)('refuses with %s', (code, mutate) => {
    const h = good();
    mutate(h);
    const r = preflight(h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(code);
      expect(REFUSAL_CODES).toContain(r.code);
      // The refusal never echoes a credential value.
      expect(r.message).not.toContain(FAKE_SECRET);
      expect(r.message).not.toContain(FAKE_ID);
    }
  });
  it('covers every refusal code in the table above', () => {
    const covered = new Set(cases.map((c) => c[0]));
    for (const code of REFUSAL_CODES) expect(covered.has(code), code).toBe(true);
  });
  it('main exits 2 on a refusal, writes nothing and never calls the wire', async () => {
    const h = harness({
      env: realEnv({ CI: '1' }),
      stdinIsTTY: true,
      argv: ['--out', path.join(tmp, 'out')],
    });
    const code = await main(h.deps);
    expect(code).toBe(2);
    expect(h.errLines.join('\n')).toMatch(/REFUSED ci_set/);
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false);
    expect(h.prompts).toEqual([]);
  });
  it('real mode in main refuses without fetch for dry runs: fetch is never given to a dry run', async () => {
    const h = harness({
      argv: ['--dry-run', '--out', path.join(tmp, 'out')],
      fetchImpl: vi.fn() as never,
    });
    expect(await main(h.deps)).toBe(0);
  });
});

// ---- redaction ------------------------------------------------------------------------------------
describe('redaction', () => {
  it('self-test passes for the real redactor', () => {
    expect(redactionSelfTest(createRedactor)).toEqual([]);
  });
  it('self-test reports survivors for a broken redactor', () => {
    const identity = () => {
      const r = createRedactor();
      return { ...r, redact: <T>(v: T) => v, text: (s: string) => s };
    };
    expect(redactionSelfTest(identity).length).toBeGreaterThan(5);
  });
  it('redacts by key', () => {
    const r = createRedactor();
    const out = JSON.parse(
      JSON.stringify(
        r.redact({
          access_token: 'x1',
          client_secret: 'x2',
          nonce: 'n',
          payer: {
            email_address: 'a@b.test',
            payer_id: 'PID',
            name: { given_name: 'A', surname: 'B' },
          },
          shipping: { address: { address_line_1: '1 Road' } },
          phone: { national_number: '123' },
          name: 'RESOURCE_NOT_FOUND',
          debug_id: 'dbg',
          reference_id: 'spike-A',
        }),
      ),
    );
    expect(out.access_token).toBe('[redacted]');
    expect(out.nonce).toBe('[redacted]');
    expect(JSON.stringify(out.payer)).not.toMatch(/PID|a@b|"A"|"B"/);
    expect(JSON.stringify(out.shipping)).not.toContain('Road');
    expect(out.name).toBe('RESOURCE_NOT_FOUND');
    expect(out.debug_id).toBe('dbg');
    expect(out.reference_id).toBe('spike-A');
  });
  it('shortens ids: order and capture ids to 6, merchant ids to 4', () => {
    const r = createRedactor();
    const out = r.redact({
      id: '5O190127TN364715T',
      payee: { merchant_id: 'YXZY75W2GKDQE' },
      links: [{ href: '/v2/payments/captures/74L756601X447022Y/refund' }],
    });
    expect(out.id).toBe('***64715T');
    expect(out.payee.merchant_id).toBe('***KDQE');
    expect(out.links[0]?.href).toBe('/v2/payments/captures/***47022Y/refund');
  });
  it('is idempotent', () => {
    const r = createRedactor();
    const once = r.redact({ id: '5O190127TN364715T', m: 'Bearer abcdefghijklmnop', e: 'a@b.test' });
    expect(r.redact(once)).toEqual(once);
  });
  it('redacts by pattern in free text and urls', () => {
    const r = createRedactor();
    const s = r.text(
      `mail a.b@c.example.test token=${FAKE_TOKEN} Bearer ${FAKE_TOKEN} https://x.example.invalid/c?token=5O190127TN364715T&PayerID=ABC123`,
    );
    expect(s).not.toMatch(/@c\.example|FAKETOKEN|5O190127TN364715T|ABC123/);
  });
  it('scrubs registered secrets by literal value, including the basic header', () => {
    const r = createRedactor();
    r.addSecret(FAKE_SECRET);
    const basic = Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64');
    r.addSecret(basic);
    const out = r.text(`oops ${FAKE_SECRET} and ${basic}`);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).not.toContain(basic);
  });
});

// ---- dry run --------------------------------------------------------------------------------------
describe('--dry-run', () => {
  it('replays fixtures through the same code, with no TTY, CI set and no credentials', async () => {
    const out = path.join(tmp, 'out');
    const h = harness({ env: { CI: 'true' }, argv: ['--dry-run', '--out', out] });
    const code = await main(h.deps);
    expect(code, h.errLines.join('\n')).toBe(0);
    const files = readOut(out);
    const names = Object.keys(files).sort();
    for (const n of [
      '03-token.json',
      '04-not-found.json',
      '05-webhooks.json',
      '06-create-order.json',
      '07-create-replay.json',
      '08-get-before-approval.json',
      '09-capture-before-approval.json',
      '10-approve-and-get.json',
      '11-capture.json',
      '12-read-back.json',
      '14-refunds.json',
      '15-two-unit.json',
      '17-late-capture.json',
      '18-webhook-cert.json',
      'summary.md',
    ])
      expect(names, n).toContain(n);
    const summary = files['summary.md'] as string;
    expect(summary).toMatch(/DRY RUN/);
    expect(summary).toMatch(/not PayPal evidence/i);
    // runbook order
    const order = [
      'Step 3',
      'Step 4',
      'Step 5',
      'Step 6',
      'Step 9',
      'Step 11',
      'Step 14',
      'Step 15',
      'Step 17',
      'Step 18',
    ].map((s) => summary.indexOf(s));
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const f of Object.values(files)) {
      expect(f).not.toMatch(/Bearer\s+[A-Za-z0-9]{8,}/);
      expect(f).not.toMatch(/@/);
    }
    const first = JSON.parse(files['03-token.json'] as string);
    expect(first.meta.dry_run).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/DRYRUN-FAKE-TOKEN/);
  });
  it('ignores credentials found in the environment and never prints them', async () => {
    const out = path.join(tmp, 'out');
    const h = harness({
      env: { PAYPAL_CLIENT_ID: FAKE_ID, PAYPAL_CLIENT_SECRET: FAKE_SECRET },
      argv: ['--dry-run', '--out', out],
    });
    expect(await main(h.deps)).toBe(0);
    const all = [...h.outLines, ...h.errLines, ...Object.values(readOut(out))].join('\n');
    expect(all).not.toContain(FAKE_SECRET);
    expect(all).not.toContain(FAKE_ID);
  });
  it('asks nothing: prompts are answered automatically and labelled', async () => {
    const h = harness({ argv: ['--dry-run', '--out', path.join(tmp, 'out')] });
    await main(h.deps);
    expect(h.prompts).toEqual([]);
    expect(h.outLines.join('\n')).toMatch(/dry-run auto/);
  });
  it('stays within the call cap', async () => {
    const h = harness({ argv: ['--dry-run', '--out', path.join(tmp, 'out')] });
    await main(h.deps);
    const m = h.outLines.join('\n').match(/Calls used: (\d+) of 40/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeLessThanOrEqual(40);
    expect(Number(m?.[1])).toBeGreaterThan(10);
  });
  it('still refuses a live value, a bad mode and an output dir inside the repo', async () => {
    for (const [env, argv, re] of [
      [{ PAYPAL_MODE: 'live' }, ['--dry-run'], /live_value/],
      [{ SPIKE_MODE: 'nope' }, ['--dry-run'], /bad_mode/],
      [{}, ['--dry-run', '--out', path.join(REPO, 'x')], /output_in_repo/],
    ] as const) {
      const h = harness({ env, argv: [...argv] });
      expect(await main(h.deps)).toBe(2);
      expect(h.errLines.join('\n')).toMatch(re);
    }
  });
  it('replay wire misses are errors, not network calls', async () => {
    const wire = createReplayWire(FIXTURES, (p) => fs.readFileSync(p, 'utf8'));
    await expect(
      wire(
        { method: 'GET', url: `${SANDBOX_API}/v2/checkout/orders/ABC`, headers: {}, body: null },
        'no_such_fixture',
      ),
    ).rejects.toThrow(/fixture/i);
  });
});

// ---- real mode through a fake wire ----------------------------------------------------------------
describe('real mode (fake wire, no socket)', () => {
  async function run(mode: 'read' | 'write', answers: string[] = [], wireOpts = {}) {
    const log: WireRequest[] = [];
    const out = path.join(tmp, 'out');
    const h = harness({
      env: realEnv({ SPIKE_MODE: mode }),
      stdinIsTTY: true,
      argv: ['--out', out],
      answers,
    });
    const pre = preflight(h.deps);
    if (!pre.ok) throw new Error(pre.message);
    const res = await runSpike(pre.cfg, h.deps, fakeWire({ log, ...wireOpts }));
    return { h, log, res, out };
  }
  it('read mode sends only the token call and the 404 read, and never writes', async () => {
    const { log, res, h, out } = await run('read');
    expect(res.exitCode).toBe(0);
    expect(log.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /v1/oauth2/token',
      'GET /v2/checkout/orders/AAAAAAAAAAAAAAAAA',
    ]);
    expect(Object.keys(readOut(out))).not.toContain('06-create-order.json');
    expect(h.prompts.length).toBeGreaterThanOrEqual(3);
    for (const r of log) expect(new URL(r.url).host).toBe(SANDBOX_HOST);
  });
  it('the mode guard allows only GET and the token POST in read mode', () => {
    expect(() => assertModeAllows('read', 'GET', '/v2/checkout/orders/ABC')).not.toThrow();
    expect(() => assertModeAllows('read', 'POST', '/v1/oauth2/token')).not.toThrow();
    expect(() => assertModeAllows('read', 'POST', '/v2/checkout/orders')).toThrow(/mode_violation/);
    expect(() => assertModeAllows('read', 'POST', '/v2/payments/captures/ABC/refund')).toThrow(
      /mode_violation/,
    );
    expect(() => assertModeAllows('write', 'POST', '/v2/checkout/orders')).not.toThrow();
  });
  it('write mode runs Part W after the token and asks twice before each write', async () => {
    const { log, h, res } = await run('write');
    expect(res.exitCode).toBe(0);
    const paths = log.map(
      (r) => `${r.method} ${new URL(r.url).pathname.replace(/[A-Z0-9]{17}/g, '{id}')}`,
    );
    expect(paths[0]).toBe('POST /v1/oauth2/token');
    expect(paths).toContain('POST /v2/checkout/orders');
    expect(paths.some((p) => p.endsWith('/capture'))).toBe(true);
    expect(log.length).toBeLessThanOrEqual(CALL_CAP);
    const second = h.prompts.filter((p) => /second confirmation/i.test(p));
    const writes = log.filter(
      (r) => r.method === 'POST' && !r.url.endsWith('/v1/oauth2/token'),
    ).length;
    expect(second.length).toBeGreaterThanOrEqual(writes);
  });
  it('write mode never reaches Part R steps 4 and 5', async () => {
    const { log } = await run('write');
    expect(log.some((r) => r.url.endsWith('AAAAAAAAAAAAAAAAA'))).toBe(false);
  });
  it('a no answer skips the call and sends nothing', async () => {
    const { log, res } = await run('read', ['n', 'n', 'n']);
    expect(log).toEqual([]);
    expect(res.calls).toBe(0);
  });
  it('quit stops the run and still writes a summary', async () => {
    const { out, log } = await run('read', ['y', 'q']);
    expect(log.length).toBe(1);
    expect(fs.existsSync(path.join(out, 'summary.md'))).toBe(true);
  });
  it('enforces the call cap and writes a summary naming it', async () => {
    const out = path.join(tmp, 'out');
    const h = harness({
      env: realEnv({ SPIKE_MODE: 'write' }),
      stdinIsTTY: true,
      argv: ['--out', out],
    });
    const pre = preflight(h.deps);
    if (!pre.ok) throw new Error('pre');
    const log: WireRequest[] = [];
    const res = await runSpike(pre.cfg, h.deps, fakeWire({ log }), { callCap: 3 });
    expect(res.exitCode).toBe(5);
    expect(log.length).toBe(3);
    expect(readOut(out)['summary.md']).toMatch(/call cap/i);
  });
  it('does not retry: one transport failure is one attempt and ends the run', async () => {
    const log: WireRequest[] = [];
    const { res, out } = await run('read', [], { log, failAt: 2 });
    expect(res.exitCode).toBe(4);
    expect(log.length).toBe(2);
    expect(readOut(out)['summary.md']).toMatch(/transport error/i);
  });
  it('keeps the token and secrets out of the screen and the files', async () => {
    const { h, out } = await run('write');
    const all = [...h.outLines, ...h.errLines, ...h.prompts, ...Object.values(readOut(out))].join(
      '\n',
    );
    for (const s of [
      FAKE_TOKEN,
      FAKE_SECRET,
      FAKE_ID,
      'canary-nonce-123',
      'canary.payer@example.test',
    ]) {
      expect(all, s).not.toContain(s);
    }
    expect(all).not.toContain(Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64'));
  });
  it('sends the basic header only on the token call and bearer elsewhere', async () => {
    const { log } = await run('read');
    expect(log[0]?.headers['authorization']).toMatch(/^Basic /);
    expect(log[1]?.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });
  it('records PENDING and repeats in EUR when the first capture is pending', async () => {
    const { log, out } = await run('write', [], { pending: true });
    expect(log.some((r) => (r.body ?? '').includes('"EUR"'))).toBe(true);
    expect(Object.keys(readOut(out))).toContain('13-eur-comparison.json');
  });
  it('uses the runbook idempotency keys', async () => {
    const { log } = await run('write');
    const keys = log.map((r) => r.headers['paypal-request-id']).filter(Boolean);
    for (const k of ['spike-K1', 'spike-K2', 'spike-K3', 'spike-K4', 'spike-K5', 'spike-K6'])
      expect(keys).toContain(k);
  });
  it('creates orders with the example.invalid return urls and no payee', async () => {
    const { log } = await run('write');
    const create = log.find((r) => r.method === 'POST' && r.url.endsWith('/v2/checkout/orders'));
    const body = JSON.parse(create?.body ?? '{}');
    expect(JSON.stringify(body)).toContain('https://example.invalid/');
    expect(body.purchase_units[0].payee).toBeUndefined();
    expect(create?.headers['prefer']).toBe('return=representation');
  });
  it('refuses to start when the output directory is inside a git repository', () => {
    const repo = path.join(tmp, 'work');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const h = harness({ env: realEnv(), stdinIsTTY: true, argv: ['--out', path.join(repo, 'o')] });
    const r = preflight(h.deps);
    expect(r.ok).toBe(false);
  });
  it('picks a fresh directory instead of overwriting earlier evidence', async () => {
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'summary.md'), 'earlier');
    const h = harness({ env: realEnv(), stdinIsTTY: true, argv: ['--out', out] });
    const pre = preflight(h.deps);
    if (!pre.ok) throw new Error('pre');
    const res = await runSpike(pre.cfg, h.deps, fakeWire());
    expect(res.outDir).not.toBe(out);
    expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toBe('earlier');
  });
});

// ---- the fetch wire is guarded ---------------------------------------------------------------------
describe('fetch wire guards', () => {
  const fetchOk = () =>
    vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new TextEncoder().encode('{}').buffer,
    }));
  it('sends only to the sandbox host, https, no redirects, with a timeout signal', async () => {
    const f = fetchOk();
    const wire = createSpikeFetchWire(f as never);
    await wire(
      { method: 'GET', url: `${SANDBOX_API}/v2/checkout/orders/ABC`, headers: {}, body: null },
      'x',
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
  it.each([
    'http://api-m.sandbox.' + 'paypal.com/v2/checkout/orders/ABC',
    'https://api-m.' + 'paypal.com/v2/checkout/orders/ABC',
    'https://evil.example.org/v2/checkout/orders/ABC',
    `https://${SANDBOX_HOST}:8443/v2/checkout/orders/ABC`,
    `https://user@${SANDBOX_HOST}/v2/checkout/orders/ABC`,
    `${SANDBOX_API}/v1/payments/payouts`,
  ])('refuses %s before calling fetch', async (url) => {
    const f = fetchOk();
    const wire = createSpikeFetchWire(f as never);
    await expect(wire({ method: 'GET', url, headers: {}, body: null }, 'x')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it('caps the response size', async () => {
    const big = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array(1_048_577).buffer,
    }));
    const wire = createSpikeFetchWire(big as never);
    await expect(
      wire(
        { method: 'GET', url: `${SANDBOX_API}/v2/checkout/orders/ABC`, headers: {}, body: null },
        'x',
      ),
    ).rejects.toThrow(/too large/i);
  });
});

// ---- FIX-BPREP M1, L1, L4, L5 -----------------------------------------------------------------------
describe('M1: proxy, certificate and Node-option overrides are refused in real modes', () => {
  const names = [
    'NODE_USE_ENV_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
  ];
  const real = () => harness({ env: realEnv(), stdinIsTTY: true });
  it.each(names.flatMap((n) => [n, n.toLowerCase()]))('refuses %s with its name', (name) => {
    const h = real();
    h.deps.env[name] = '1';
    const r = preflight(h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('transport_env_override');
      expect(r.message).toContain(name.toUpperCase());
      expect(r.message).not.toContain(FAKE_SECRET);
    }
  });
  it.each([
    '--use-env-proxy',
    '--require',
    '-r',
    '--import',
    '--inspect',
    '--inspect=0.0.0.0:9229',
  ])('refuses execArgv %s', (flag) => {
    const h = real();
    h.deps.execArgv = ['--max-old-space-size=512', flag];
    const r = preflight(h.deps);
    expect(!r.ok && r.code).toBe('transport_env_override');
  });
  it('accepts harmless execArgv and empty override values', () => {
    const h = real();
    h.deps.execArgv = ['--max-old-space-size=512'];
    h.deps.env['HTTPS_PROXY'] = '';
    expect(preflight(h.deps).ok).toBe(true);
  });
  it('a dry run does not refuse them (the cloud container sets HTTPS_PROXY)', () => {
    const h = harness({
      env: { HTTPS_PROXY: 'http://127.0.0.1:9', NODE_OPTIONS: '--max-old-space-size=512' },
      argv: ['--dry-run', '--out', path.join(tmp, 'out')],
      execArgv: ['--inspect'],
    });
    expect(preflight(h.deps).ok).toBe(true);
  });
  it('main refuses and prints the code, never a value', async () => {
    const h = harness({
      env: realEnv({ HTTPS_PROXY: 'http://user:pw-canary@127.0.0.1:9' }),
      stdinIsTTY: true,
      argv: ['--out', path.join(tmp, 'out')],
      fetchImpl: vi.fn() as never,
    });
    expect(await main(h.deps)).toBe(2);
    const text = h.errLines.join('\n');
    expect(text).toMatch(/REFUSED transport_env_override/);
    expect(text).not.toContain('pw-canary');
    expect(fs.existsSync(path.join(tmp, 'out'))).toBe(false);
  });
});

describe('L5: every common CI marker is refused; the response is capped while streaming', () => {
  it.each([
    'CI',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'JENKINS_URL',
    'CIRCLECI',
    'TF_BUILD',
    'CODESPACES',
  ])('refuses %s', (name) => {
    const h = harness({ env: realEnv({ [name]: 'true' }), stdinIsTTY: true });
    const r = preflight(h.deps);
    expect(!r.ok && r.code).toBe('ci_set');
  });
  it('a dry run still works under a CI marker', () => {
    const h = harness({
      env: { GITHUB_ACTIONS: 'true' },
      argv: ['--dry-run', '--out', path.join(tmp, 'out')],
    });
    expect(preflight(h.deps).ok).toBe(true);
  });
  const url = `${SANDBOX_API}/v2/checkout/orders/ABC`;
  const streaming = (chunks: number, size: number, cancelled: { n: number }) => ({
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => {
      throw new Error('arrayBuffer must not be used when a body stream exists');
    },
    body: {
      getReader() {
        let sent = 0;
        return {
          async read() {
            if (sent >= chunks) return { done: true as const, value: undefined };
            sent += 1;
            return { done: false as const, value: new Uint8Array(size) };
          },
          async cancel() {
            cancelled.n += 1;
          },
        };
      },
    },
  });
  it('stops reading and cancels as soon as the cap is passed', async () => {
    const cancelled = { n: 0 };
    const wire = createSpikeFetchWire((async () => streaming(1000, 500_000, cancelled)) as never);
    await expect(wire({ method: 'GET', url, headers: {}, body: null }, 'x')).rejects.toThrow(
      /too large/i,
    );
    expect(cancelled.n).toBe(1);
  });
  it('refuses on a declared content-length over the cap without reading', async () => {
    const cancelled = { n: 0 };
    const res = {
      ...streaming(1, 10, cancelled),
      headers: new Headers({ 'content-length': '5000000' }),
    };
    const wire = createSpikeFetchWire((async () => res) as never);
    await expect(wire({ method: 'GET', url, headers: {}, body: null }, 'x')).rejects.toThrow(
      /too large/i,
    );
  });
  it('reads a small streamed body in full', async () => {
    const wire = createSpikeFetchWire((async () => streaming(3, 4, { n: 0 })) as never);
    const r = await wire({ method: 'GET', url, headers: {}, body: null }, 'x');
    expect(r.text.length).toBe(12);
  });
});

describe('L4: the output directory is checked by real path', () => {
  const real = (out: string) => {
    const h = harness({ env: realEnv(), stdinIsTTY: true, argv: ['--out', out] });
    return preflight(h.deps);
  };
  it('refuses a symlink that leads into the repository', () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(path.join(REPO, 'docs'), link);
    const r = real(path.join(link, 'sub', 'deeper'));
    expect(!r.ok && r.code).toBe('output_in_repo');
    const r2 = real(link);
    expect(!r2.ok && r2.code).toBe('output_in_repo');
  });
  it('refuses a chain of two symlinks', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.symlinkSync(path.join(REPO, 'docs'), a);
    fs.symlinkSync(a, b);
    const r = real(path.join(b, 'x'));
    expect(!r.ok && r.code).toBe('output_in_repo');
  });
  it('accepts a plain folder outside every repository', () => {
    expect(real(path.join(tmp, 'plain', 'out')).ok).toBe(true);
  });
});

describe('L1: account and other id keys are redacted', () => {
  it('redacts payment_source.paypal.account_id and related keys', () => {
    const r = createRedactor();
    const out = JSON.stringify(
      r.redact({
        payment_source: {
          paypal: {
            account_id: 'CANARYACCT' + 'ID99',
            email_address: 'a@b.test',
            name: { given_name: 'X' },
          },
        },
        payer: { payer_id: 'CANARYPAYER' + 'ID2', account_id: 'CANARYACCT' + 'ID98' },
        payee: { merchant_id: 'CANARYMERCH' + 'ANT2', display_name: 'Canary Shop' },
        customer: { id: 'CANARYCUST' + 'ID7' },
      }),
    );
    expect(out).not.toMatch(/CANARYACCT|CANARYPAYER|Canary Shop/);
    expect(out).toContain('***ANT2');
  });
  it('the self-test canary list carries an account id and reports it when a redactor lets it through', () => {
    const identity = () => ({
      ...createRedactor(),
      redact: <T>(v: T) => v,
      text: (x: string) => x,
    });
    expect(redactionSelfTest(identity)).toContain('account id');
    expect(redactionSelfTest(createRedactor)).toEqual([]);
  });
});
