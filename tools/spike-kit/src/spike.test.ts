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
  captureNetworkBaseline,
  main,
  networkOverride,
  networkTampered,
  parseSpikeGo,
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
// Host names are assembled from fragments so this file carries no PayPal host text (A-26).
const hostFrom = (...p: string[]) => p.join('.');
const FAKE_ID = part('fake', '-client-', 'id-0001');
const FAKE_SECRET = part('fake', '-client-', 'secret-0002-zzzz');
const FAKE_TOKEN = part('A21AA', 'FAKETOKEN', 'abcdefghijklmnopqrstuvwxyz0123456789');
const REPO = path.resolve(new URL('../../..', import.meta.url).pathname);
const FIXTURES = path.join(REPO, 'fixtures/paypal/docs-examples');
// A well-formed SPIKE GO decision cell; the dates default to an 11 day window around 2026-10-26.
const MARK = (o: { approved?: string; until?: string } = {}): string =>
  `SPIKE GO: scope=spike-read; operator=vikram; valid_until=${o.until ?? '2026-11-05'}; approved in writing ${o.approved ?? '2026-10-25'}`;
const LOG = [
  '| Id | Date | Decision | Owner | Notes |',
  '| D-023 | 2026-10-22 | Sandbox accounts. This decision does not authorise any outbound call. | Owner | PR #1 |',
  '| D-004 | 2026-10-01 | Some unrelated decision about money handling. | Owner | PR #1 |',
  '| D-011 | 2026-10-05 | Another unrelated decision. | Owner | PR #1 |',
  '| D-013 | 2026-10-06 | The sandbox host constant lives in one module. | Owner | PR #1 |',
  // Synthetic well-formed rows for tests only. They are NOT in docs/decision-log.md.
  '| D-024 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-11-05; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-025 | 2026-10-25 | SPIKE GO: scope=spike-read; operator=vikram; valid_until=2026-11-05; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-026 | 2026-10-25 | SPIKE GO: scope=spike-read; operator=sakthi; valid_until=2026-11-05; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-027 | 2026-10-20 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-10-25; approved in writing 2026-10-20 | Owner | PR #1 |',
  '| D-028 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-10-26; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-029 | 2026-10-25 | SPIKE GO: scope=everything; operator=vikram; valid_until=2026-11-05; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-030 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-13-45; approved in writing 2026-10-25 | Owner | PR #1 |',
  '| D-031 | 2026-10-25 | Owner written go for the read-only spike. | Owner | PR #1 |',
  '| D-032 | 2026-10-25 | SPIKE GO: scope=spike-write; operator=vikram; valid_until=2026-12-31 | Owner | PR #1 |',
  // FIX-MVPB-SEAL2 M1: rows that quote, negate or only look like a grant. None may authorise.
  `| D-040 | 2026-10-25 | Example only, NOT yet granted: "${MARK()}" | Owner | PR #1 |`,
  `| D-041 | 2026-10-25 | ${MARK()} REVOKED | Owner | PR #1 |`,
  `| D-042 | 2026-10-25 | This is not authorised: ${MARK()} | Owner | PR #1 |`,
  `| D-043 | 2026-10-25 | ${MARK({ until: '9999-12-31' })} | Owner | PR #1 |`,
  `| D-044 | 2026-10-25 | ${MARK({ until: '2026-10-24' })} | Owner | PR #1 |`,
  `| D-046 | 2026-10-25 | ${MARK()} | Owner | first |`,
  `| D-046 | 2026-10-25 | ${MARK()} | Owner | second |`,
  `| D-047 | 2026-10-10 | ${MARK({ approved: '2026-10-10', until: '2026-10-20' })} | Owner | PR #1 |`,
  `| D-048 | 2026-10-25 | ${MARK()} | Owner | template |`,
  `| D-049 | 2026-10-25 | ${MARK()} | Owner | superseded by D-050 |`,
  `| D-051 | 2026-10-25 | ${MARK()} | Owner | withdrawn |`,
  `| D-052 | 2026-10-25 | ${MARK()} | Owner | e.g. a test run |`,
  `| D-053 | 2026-10-25 | ${MARK()} | Owner | see the runbook example |`,
  `| D-054 | 2026-10-25 | ${MARK({ until: '2026-11-08' })} | Owner | PR #1 |`,
  `| D-055 | 2026-10-25 | ${MARK({ until: '2026-11-09' })} | Owner | PR #1 |`,
  `| D-056 | 2026-10-30 | ${MARK({ approved: '2026-10-30', until: '2026-11-05' })} | Owner | PR #1 |`,
  `| D-057 | 2026-10-25 | ${MARK()} and more | Owner | PR #1 |`,
  `| D-058 | 2026-10-25 | Owner go: ${MARK()} | Owner | PR #1 |`,
  `| D-059 | 2026-10-25 | spike go: scope=spike-read; operator=vikram; valid_until=2026-11-05; approved in writing 2026-10-25 | Owner | lower case |`,
  `| D-060 | 2026-10-25 | ${MARK()} | Owner | cannot be used |`,
  // FIX-MVPB-SEAL3 M-B: the row is an allow-list, not a deny-list.
  `| D-070 | 2026-10-25 | ${MARK().replace('operator', 'operat\u043er')} | Owner | PR #1 |`, // Cyrillic o
  `| D-071 | 2026-10-25 | ${MARK()} | Owner | PR #1\u200b |`, // zero-width space
  `| D-072 | 2026-10-25 | ${MARK()} | Owner | PR #1 \\| second |`, // escaped pipe
  `| D-073 | 2026-10-25 | ${MARK()} | Owner | <b>PR #1</b> |`, // HTML in a cell
  `| D-074 | 2026-10-25 | ${MARK()} | Owner | PR #12 |`, // allowed note
  `| D-075 | 2026-10-25 | ${MARK()} | Owner | issue #7 |`, // allowed note
  `| D-076 | 2026-10-25 | ${MARK()} | Owner | approved by the owner on a call |`, // free text
  `| D-077 | 2026-10-25 | ${MARK()} | Mallory | PR #1 |`, // owner cell
  `| D-078 | 2026-10-25 | ${MARK()} | Owner | PR #1 | extra |`, // six cells
  `| D-079 | 2026-10-25 | ${MARK()} | Owner |`, // four cells
  `| D-080 | 2026-10-25 | ${MARK()} | Owner | |`, // empty notes: allowed
  `| D-081 | 2026-10-25 | ${MARK()} | Owner | \u0420R #1 |`, // Cyrillic P
  `| D-082 | 26-10-25 | ${MARK()} | Owner | PR #1 |`, // date cell
].join('\n');
// Rows inside a code fence, an HTML comment or an indented code block are not decisions.
const FENCED_LOG = [
  LOG,
  '```',
  `| D-045 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '```',
  '<!--',
  `| D-061 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '-->',
  `    | D-062 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '~~~',
  `| D-063 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '~~~',
  // A closing fence must use the same character and be at least as long as the opener.
  '````',
  '```',
  `| D-064 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '```',
  '````',
  '~~~~',
  '~~~',
  `| D-065 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '```',
  '~~~~',
  '<pre>',
  `| D-067 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '</pre>',
  '<DETAILS>',
  `| D-068 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '</DETAILS>',
  '   ```',
  `| D-069 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
  '   ```',
  // An opening fence that is never closed runs to the end of the file.
  '```',
  `| D-066 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`,
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
function harness(rest: Partial<Deps> & { answers?: string[]; log?: string } = {}): Harness {
  const { log: logText = LOG, ...over } = rest;
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
      if (p.endsWith('decision-log.md')) return logText;
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    fixtureDir: FIXTURES,
    // The committed copy of the log; equal to the working copy unless a test says otherwise.
    gitShowHead: (rel) => (rel === 'docs/decision-log.md' ? logText : null),
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
    expect(SANDBOX_HOST).toBe(hostFrom('api-m', 'sandbox', 'paypal', 'com'));
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
    // FIX-MVPB-SEAL2 M1: the review table.
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-040')], // quoted example, "NOT yet granted"
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-041')], // marker then REVOKED
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-042')], // "This is not authorised: <marker>"
    ['approval_window_invalid', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-043')], // valid_until=9999-12-31
    ['approval_window_invalid', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-044')], // approved after valid_until
    ['approval_ref_duplicate', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-046')], // two rows with one id
    ['approval_expired', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-047')], // past valid_until
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-048')], // template
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-049')], // superseded
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-051')], // withdrawn
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-052')], // e.g.
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-053')], // example
    ['approval_window_invalid', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-055')], // 15 days
    ['approval_window_invalid', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-056')], // approved in the future
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-057')], // trailing text in the cell
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-058')], // leading text in the cell
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-059')], // lower case marker
    ['approval_ref_not_authorising', (h) => void (h.deps.env['SPIKE_APPROVAL_REF'] = 'D-060')], // "cannot"
    [
      'decision_log_unverified',
      (h) =>
        void (h.deps.gitShowHead = () =>
          LOG + '\n| D-099 | 2026-10-25 | an uncommitted line | Owner | PR #1 |'),
    ], // working tree differs from HEAD
    ['decision_log_unverified', (h) => void (h.deps.gitShowHead = () => null)], // git unavailable
    ['decision_log_unverified', (h) => void delete h.deps.gitShowHead], // no git reader supplied
    ['ai_environment', (h) => void (h.deps.env['CLAUDECODE'] = '1')],
    ['ai_environment', (h) => void (h.deps.env['CLAUDE_CODE_REMOTE'] = 'true')],
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
      (h) => void (h.deps.env['PAYPAL_API_BASE'] = 'https://' + hostFrom('api-m', 'paypal', 'com')),
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

// ---- FIX-MVPB-SEAL2 M1: the SPIKE GO row must be a whole, current, committed, unambiguous grant --------
describe('M1 (SEAL2): SPIKE GO rows that only look like a grant never authorise', () => {
  const real = (ref: string, over: Partial<Deps> & { log?: string } = {}) => {
    const h = harness({ env: realEnv({ SPIKE_APPROVAL_REF: ref }), stdinIsTTY: true, ...over });
    return preflight(h.deps);
  };
  it.each([
    'D-045',
    'D-061',
    'D-062',
    'D-063',
    'D-064',
    'D-065',
    'D-066',
    'D-067',
    'D-068',
    'D-069',
  ])(
    'a row in a code fence, an HTML comment or an indented block (%s) is not a decision',
    (ref) => {
      const r = real(ref, { log: FENCED_LOG });
      expect(!r.ok && r.code).toBe('approval_ref_not_authorising');
    },
  );
  it('the same log still authorises a plain row outside every fence', () => {
    expect(real('D-024', { log: FENCED_LOG }).ok).toBe(true);
  });
  it('the same log still authorises a plain row after the closed fences and blocks (D-024)', () => {
    expect(real('D-054', { log: FENCED_LOG }).ok).toBe(true);
  });
  it.each(['D-074', 'D-075', 'D-080'])('an allowed notes cell (%s) grants', (ref) => {
    expect(real(ref).ok).toBe(true);
  });
  it.each([
    ['D-070', 'a Cyrillic lookalike letter in the marker'],
    ['D-071', 'a zero-width space in the notes'],
    ['D-072', 'an escaped pipe'],
    ['D-073', 'HTML in a cell'],
    ['D-076', 'free text in the notes'],
    ['D-077', 'an owner cell that is not Owner, Vikram or Sakthi'],
    ['D-078', 'a sixth cell'],
    ['D-079', 'only four cells'],
    ['D-081', 'a Cyrillic letter in an otherwise allowed note'],
    ['D-082', 'a malformed date cell'],
  ])('%s (%s) never grants', (ref) => {
    const r = real(ref);
    expect(!r.ok && r.code).toBe('approval_ref_not_authorising');
  });
  it('a non-ASCII character anywhere in the row is refused, whatever the character', () => {
    for (const ch of [
      '\u200b',
      '\u200d',
      '\ufeff',
      '\u202e',
      '\u00a0',
      '\u0430',
      '\u03bf',
      '\uff5c',
      '\u2063',
    ])
      for (const where of ['id', 'decision', 'notes', 'owner']) {
        const cells: Record<string, string> = {
          id: 'D-024',
          decision: MARK(),
          owner: 'Owner',
          notes: 'PR #1',
        };
        cells[where] = `${cells[where]}${ch}`;
        const row = `| ${cells['id']} | 2026-10-25 | ${cells['decision']} | ${cells['owner']} | ${cells['notes']} |`;
        expect(parseSpikeGo(row), `${where} U+${ch.codePointAt(0)?.toString(16)}`).toBeNull();
      }
  });
  it('the notes allow-list is exactly empty, PR #n or issue #n', () => {
    const row = (notes: string) => `| D-024 | 2026-10-25 | ${MARK()} | Owner | ${notes} |`;
    for (const ok of ['', 'PR #1', 'PR #123456', 'issue #7'])
      expect(parseSpikeGo(row(ok)), ok).not.toBeNull();
    for (const bad of [
      'pr #1',
      'PR #1234567',
      'PR 1',
      'PR #1 ok',
      'see PR #1',
      'x',
      'none',
      '-',
      'PR #',
      'issue #a',
    ])
      expect(parseSpikeGo(row(bad)), bad).toBeNull();
  });
  it('accepts a window of exactly 14 days and refuses 15 (D-054, D-055)', () => {
    expect(real('D-054').ok).toBe(true);
    const r = real('D-055');
    expect(!r.ok && r.code).toBe('approval_window_invalid');
  });
  it('accepts a row on the day it is approved and on its last day', () => {
    const h = harness({ env: realEnv({ SPIKE_APPROVAL_REF: 'D-024' }), stdinIsTTY: true });
    h.deps.nowIso = () => '2026-10-25T00:00:00.000Z';
    expect(preflight(h.deps).ok).toBe(true);
    h.deps.nowIso = () => '2026-11-05T23:59:59.000Z';
    expect(preflight(h.deps).ok).toBe(true);
    h.deps.nowIso = () => '2026-11-06T00:00:00.000Z';
    const r = preflight(h.deps);
    expect(!r.ok && r.code).toBe('approval_expired');
  });
  it('a row approved after today is refused even though it has not expired', () => {
    const r = real('D-056');
    expect(!r.ok && r.code).toBe('approval_window_invalid');
  });
  it('a duplicate id is refused even when one of the rows is a perfect grant', () => {
    const log = [LOG, `| D-024 | 2026-10-25 | not a grant | Owner | PR #1 |`].join('\n');
    const r = real('D-024', { log });
    expect(!r.ok && r.code).toBe('approval_ref_duplicate');
  });
  it('a duplicate id with one copy in a fence is refused as a duplicate too', () => {
    const log = [LOG, '```', `| D-024 | 2026-10-25 | ${MARK()} | Owner | PR #1 |`, '```'].join(
      '\n',
    );
    const r = real('D-024', { log });
    expect(!r.ok && r.code).toBe('approval_ref_duplicate');
  });
  it('asks git for docs/decision-log.md at HEAD and compares byte for byte', () => {
    const asked: string[] = [];
    const ok = harness({ env: realEnv(), stdinIsTTY: true });
    const inner = ok.deps.gitShowHead;
    ok.deps.gitShowHead = (rel) => {
      asked.push(rel);
      return inner?.(rel) ?? null;
    };
    expect(preflight(ok.deps).ok).toBe(true);
    expect(asked).toEqual(['docs/decision-log.md']);
    // One extra trailing newline in the working tree is a difference.
    const dirty = harness({ env: realEnv(), stdinIsTTY: true });
    dirty.deps.readText = (p) => (p.endsWith('decision-log.md') ? LOG + '\n' : null);
    const r = preflight(dirty.deps);
    expect(!r.ok && r.code).toBe('decision_log_unverified');
  });
  it('a git reader that throws is a refusal, not a crash', () => {
    const h = harness({ env: realEnv(), stdinIsTTY: true });
    h.deps.gitShowHead = () => {
      throw new Error('git exploded');
    };
    const r = preflight(h.deps);
    expect(!r.ok && r.code).toBe('decision_log_unverified');
  });
  it('the real docs/decision-log.md: D-004, D-011, D-013 and D-023 stay refused', () => {
    const real_ = fs.readFileSync(path.join(REPO, 'docs/decision-log.md'), 'utf8');
    for (const ref of ['D-004', 'D-011', 'D-013', 'D-023']) {
      const r = real(ref, { log: real_ });
      expect(!r.ok && r.code, ref).toBe('approval_ref_not_authorising');
    }
    expect(real_).not.toContain('SPIKE GO:');
  });
  it('never reads the runbook, whose template row is not a decision', () => {
    const read: string[] = [];
    const h = harness({ env: realEnv(), stdinIsTTY: true });
    const inner = h.deps.readText;
    h.deps.readText = (p) => {
      read.push(p);
      return inner(p);
    };
    expect(preflight(h.deps).ok).toBe(true);
    expect(read.filter((p) => /runbook|owner/i.test(p))).toEqual([]);
    // The template's placeholder id is not even a well-formed reference.
    const t = harness({ env: realEnv({ SPIKE_APPROVAL_REF: 'D-nnn' }), stdinIsTTY: true });
    const r = preflight(t.deps);
    expect(!r.ok && r.code).toBe('approval_ref_pattern');
  });
  it('parseSpikeGo reads the marker only from the whole decision cell', () => {
    const row = (cell: string, notes = 'PR #1') =>
      `| D-024 | 2026-10-25 | ${cell} | Owner | ${notes} |`;
    expect(parseSpikeGo(row(MARK()))).toEqual({
      scope: 'spike-read',
      operator: 'vikram',
      validUntil: '2026-11-05',
      approved: '2026-10-25',
    });
    for (const bad of [
      row(`"${MARK()}"`),
      row(`${MARK()}.`),
      row(`> ${MARK()}`),
      row(`${MARK()} (revoked)`),
      row(MARK(), 'NOT granted'),
      row(MARK(), 'Template'),
      row(MARK(), 'E.G.'),
      '',
      '|',
      `| D-024 | ${MARK()} |`,
    ])
      expect(parseSpikeGo(bad), bad).toBeNull();
  });
});

describe('LOW (SEAL2): AI and cloud-session markers refuse a real run, not a dry run', () => {
  it.each(['CLAUDECODE', 'CLAUDE_CODE_REMOTE'])(
    '%s refuses a real run with ai_environment',
    (name) => {
      const h = harness({ env: realEnv({ [name]: '1' }), stdinIsTTY: true });
      const r = preflight(h.deps);
      expect(!r.ok && r.code).toBe('ai_environment');
      expect(!r.ok && r.message).toContain(name);
    },
  );
  it.each(['CLAUDECODE', 'CLAUDE_CODE_REMOTE'])('%s: an empty value is not a marker', (name) => {
    const h = harness({ env: realEnv({ [name]: '' }), stdinIsTTY: true });
    expect(preflight(h.deps).ok).toBe(true);
  });
  it.each(['CLAUDECODE', 'CLAUDE_CODE_REMOTE'])('%s: --dry-run still works', async (name) => {
    const h = harness({
      env: { [name]: '1' },
      argv: ['--dry-run', '--out', path.join(tmp, 'out')],
    });
    expect(preflight(h.deps).ok).toBe(true);
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
    const wire = createSpikeFetchWire(f as never, () => null);
    await wire(
      { method: 'GET', url: `${SANDBOX_API}/v2/checkout/orders/ABC`, headers: {}, body: null },
      'x',
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
  it.each([
    'http://' + hostFrom('api-m', 'sandbox', 'paypal', 'com') + '/v2/checkout/orders/ABC',
    'https://' + hostFrom('api-m', 'paypal', 'com') + '/v2/checkout/orders/ABC',
    'https://evil.example.org/v2/checkout/orders/ABC',
    `https://${SANDBOX_HOST}:8443/v2/checkout/orders/ABC`,
    `https://user@${SANDBOX_HOST}/v2/checkout/orders/ABC`,
    `${SANDBOX_API}/v1/payments/payouts`,
  ])('refuses %s before calling fetch', async (url) => {
    const f = fetchOk();
    const wire = createSpikeFetchWire(f as never, () => null);
    await expect(wire({ method: 'GET', url, headers: {}, body: null }, 'x')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it('caps the response size', async () => {
    const big = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array(1_048_577).buffer,
    }));
    const wire = createSpikeFetchWire(big as never, () => null);
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
    // FIX-MVPB-SEAL2 M3
    'NODE_USE_SYSTEM_CA',
    'OPENSSL_CONF',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
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
    '--loader',
    '--loader=./x.mjs',
    '--experimental-loader',
    '--experimental-loader=./x.mjs',
    '--use-system-ca',
    '--use-openssl-ca',
    '--openssl-config',
    '--openssl-config=/tmp/x.cnf',
    '--openssl-shared-config',
    '--tls-keylog',
    '--heapsnapshot-signal',
    '--heapsnapshot-near-heap-limit',
    '--inspect-port',
    '--inspect-wait',
    '--experimental-network-inspection',
    '--secure-heap',
    '--tls-min-v1.0',
    '--tls-min-v1.1',
    '--conditions',
    '-C',
    '--tls-keylog=/tmp/k.log',
    '--inspect-port=9230',
    '--secure-heap=1048576',
    '--conditions=dev',
    '--report-signal',
    '--report-on-signal',
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    '--report-compact',
    '--report-dir',
    '--report-directory',
    '--report-filename',
    '--report-exclude-network',
    '--report-exclude-env',
    '--snapshot-blob',
    '--build-snapshot',
    '--snapshot-blob=/tmp/x.blob',
    '--report-dir=/tmp/r',
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

describe('M3 (SEAL2): the override check runs again on every request', () => {
  const url = `${SANDBOX_API}/v2/checkout/orders/ABC`;
  const call = { method: 'GET', url, headers: {}, body: null } as const;
  const ok = () =>
    vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new TextEncoder().encode('{}').buffer,
    }));
  it('asks the check before each request and never reaches fetch when it reports an override', async () => {
    const f = ok();
    let reason: string | null = null;
    const wire = createSpikeFetchWire(f as never, () => reason);
    await wire(call, 'x');
    expect(f).toHaveBeenCalledTimes(1);
    reason = 'NODE_TLS_REJECT_UNAUTHORIZED';
    await expect(wire(call, 'x')).rejects.toThrow(
      /transport_env_override.*NODE_TLS_REJECT_UNAUTHORIZED/,
    );
    expect(f).toHaveBeenCalledTimes(1);
    reason = null;
    await wire(call, 'x');
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('a throwing check refuses the request (fail closed)', async () => {
    const f = ok();
    const wire = createSpikeFetchWire(f as never, () => {
      throw new Error('boom');
    });
    await expect(wire(call, 'x')).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it('networkOverride reports the first override in env or Node flags, by name and never by value', () => {
    expect(networkOverride({}, [])).toBeNull();
    expect(networkOverride({ HTTPS_PROXY: '' }, ['--max-old-space-size=1'])).toBeNull();
    expect(networkOverride({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, [])).toBe(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
    expect(networkOverride({ https_proxy: 'http://u:pw-canary@h:1' }, [])).toBe('HTTPS_PROXY');
    expect(networkOverride({}, ['--loader=./x'])).toBe('execArgv');
  });
  it('main: an override that appears after boot stops the run at the next request, before fetch', async () => {
    const h = harness({
      env: realEnv(),
      stdinIsTTY: true,
      argv: ['--out', path.join(tmp, 'out')],
    });
    const token = JSON.stringify({ access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 1 });
    const f = vi.fn(async () => {
      // Something flips the TLS check off while the run is in progress.
      h.deps.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => new TextEncoder().encode(token).buffer,
      };
    });
    h.deps.fetchImpl = f as never;
    expect(await main(h.deps)).toBe(4);
    expect(f).toHaveBeenCalledTimes(1);
    const text = [...h.outLines, ...h.errLines].join('\n');
    expect(text).toMatch(/Stopped:.*transport/i);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_TOKEN);
    // The summary names the override, by name only.
    const summary = fs.readFileSync(path.join(tmp, 'out', 'summary.md'), 'utf8');
    expect(summary).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(summary).not.toContain(FAKE_SECRET);
  });
});

describe('M-C (SEAL3): a swapped global fetch or undici dispatcher stops the run', () => {
  const KEY = Symbol.for('undici.globalDispatcher.1');
  it('networkTampered compares the fetch and the dispatcher with the baseline', () => {
    const f = () => undefined;
    const g: Record<string | symbol, unknown> = { fetch: f, [KEY]: { name: 'Agent' } };
    const b = captureNetworkBaseline(g);
    expect(networkTampered(b, g)).toBeNull();
    g['fetch'] = () => undefined;
    expect(networkTampered(b, g)).toBe('globalThis.fetch');
    g['fetch'] = f;
    expect(networkTampered(b, g)).toBeNull();
    g[KEY] = { name: 'ProxyAgent' };
    expect(networkTampered(b, g)).toBe('the undici global dispatcher');
    delete g[KEY];
    expect(networkTampered(b, g)).toBe('the undici global dispatcher');
  });
  it('the real baseline holds Node default dispatcher, taken without any request', () => {
    const b = captureNetworkBaseline();
    expect(b.dispatcher).toBeDefined();
    expect(networkTampered(b)).toBeNull();
  });
  it('main: an integrity failure after the first request stops the run before the next fetch', async () => {
    const h = harness({
      env: realEnv(),
      stdinIsTTY: true,
      argv: ['--out', path.join(tmp, 'out')],
    });
    let tampered: string | null = null;
    h.deps.integrity = () => tampered;
    const token = JSON.stringify({ access_token: FAKE_TOKEN, token_type: 'Bearer', expires_in: 1 });
    const f = vi.fn(async () => {
      tampered = 'the undici global dispatcher';
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => new TextEncoder().encode(token).buffer,
      };
    });
    h.deps.fetchImpl = f as never;
    expect(await main(h.deps)).toBe(4);
    expect(f).toHaveBeenCalledTimes(1);
    const summary = fs.readFileSync(path.join(tmp, 'out', 'summary.md'), 'utf8');
    expect(summary).toContain('the undici global dispatcher');
    expect(summary).not.toContain(FAKE_SECRET);
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
    const wire = createSpikeFetchWire(
      (async () => streaming(1000, 500_000, cancelled)) as never,
      () => null,
    );
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
    const wire = createSpikeFetchWire((async () => res) as never, () => null);
    await expect(wire({ method: 'GET', url, headers: {}, body: null }, 'x')).rejects.toThrow(
      /too large/i,
    );
  });
  it('reads a small streamed body in full', async () => {
    const wire = createSpikeFetchWire((async () => streaming(3, 4, { n: 0 })) as never, () => null);
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
