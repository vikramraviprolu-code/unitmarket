// BU-3 (unit): the log-line parser and the verdict rules of scripts/next-start-proof.mjs, run on canned
// good and bad logs. Nothing here builds or starts Next, opens a socket or reads a credential. The
// secrets below are obviously fake placeholders assembled at run time, and no assertion message
// ever prints one.
import { describe, expect, it } from 'vitest';
import {
  analyseOverride,
  analyseStart,
  parseOutput,
  portCandidates,
  renderTable,
} from './next-start-proof.mjs';

const FAKE_ID = ['fake', 'client', 'id', 'bu3', 'canned'].join('-');
const FAKE_SECRET = ['fake', 'client', 'secret', 'bu3', 'canned'].join('-');
const BASIC = Buffer.from(`${FAKE_ID}:${FAKE_SECRET}`).toString('base64');
const SECRETS = [FAKE_ID, FAKE_SECRET, BASIC];

const j = (o: Record<string, unknown>): string =>
  JSON.stringify({ ts: '2026-10-23T20:00:00.000Z', env_label: 'sandbox', ...o });

const BANNER = [
  '   ▲ Next.js 15.5.28',
  '   - Local:        http://127.0.0.1:3187',
  ' ✓ Starting...',
  ' ✓ Ready in 396ms',
];
const SELFCHECK = j({
  level: 'info',
  msg: 'transport.selfcheck',
  wire_kind: 'production',
  impl: 'node-https',
  env_override: false,
  builtins_intact: true,
  global_fetch_changed: false,
});
const SEND = (operation: string, outcome: string): string =>
  j({
    level: 'info',
    msg: 'sandbox.send',
    operation,
    outcome,
    status: null,
    approval_ref: 'DL-bu3-canned',
    correlation_id: 'sbx-000001-abc',
    request_id: null,
    paypal_debug_id: null,
  });
const GOOD_SEND = SEND('oauth_token', 'blocked:no_approval');
const AFTER_LOAD = {
  impl: 'node-https',
  env_override: false,
  builtins_intact: true,
  global_fetch_changed_since_load: true,
};

type StartInput = Parameters<typeof analyseStart>[0];
const good = (over: Partial<StartInput> = {}): StartInput => ({
  stdout: [...BANNER, SELFCHECK, GOOD_SEND, GOOD_SEND].join('\n'),
  stderr: '',
  secrets: SECRETS,
  provider_calls: [
    { operation: 'oauth_token', outcome: 'blocked' },
    { operation: 'oauth_token', outcome: 'blocked' },
  ],
  listened: true,
  exit: { code: 0, signal: null },
  ops_selfcheck: AFTER_LOAD,
  checkout_status: 503,
  ...over,
});
const failed = (r: ReturnType<typeof analyseStart>): string[] =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('parseOutput', () => {
  it('splits JSON log lines from the plain lines Next prints', () => {
    const p = parseOutput([...BANNER, SELFCHECK, '', '   ', GOOD_SEND].join('\n'));
    expect(p.events.map((e) => e['msg'])).toEqual(['transport.selfcheck', 'sandbox.send']);
    expect(p.plain).toHaveLength(BANNER.length);
  });
  it('keeps a broken or message-less JSON line as a plain line, never throws', () => {
    const p = parseOutput(['{"msg":', '{"level":"info"}', '[1,2]', '{"msg":"x"}'].join('\n'));
    expect(p.events).toHaveLength(1);
    expect(p.plain).toEqual(['{"msg":', '{"level":"info"}', '[1,2]']);
  });
  it('handles CRLF and an empty text', () => {
    expect(parseOutput(`${SELFCHECK}\r\n${GOOD_SEND}\r\n`).events).toHaveLength(2);
    expect(parseOutput('')).toEqual({ events: [], plain: [] });
  });
});

describe('analyseStart: a good run', () => {
  it('passes every check and records the facts', () => {
    const r = analyseStart(good());
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.facts.selfcheck).toMatchObject({
      impl: 'node-https',
      env_override: false,
      builtins_intact: true,
    });
    expect(r.facts.global_fetch_changed_at_start).toBe(false);
    expect(r.facts.global_fetch_changed_after_load).toBe(true);
    expect(r.facts.sends).toBe(2);
    expect(r.facts.provider_calls).toBe(2);
  });
  it('the fetch-patch value is recorded whichever way it is (true or false)', () => {
    const t = analyseStart(good());
    const f = analyseStart(
      good({ ops_selfcheck: { ...AFTER_LOAD, global_fetch_changed_since_load: false } }),
    );
    expect(t.ok && f.ok).toBe(true);
    expect(f.facts.global_fetch_changed_after_load).toBe(false);
  });
  it('a SIGTERM stop and exit code 143 are clean stops', () => {
    expect(analyseStart(good({ exit: { code: null, signal: 'SIGTERM' } })).ok).toBe(true);
    expect(analyseStart(good({ exit: { code: 143, signal: null } })).ok).toBe(true);
  });
  it('renders a table that names every check and holds no secret', () => {
    const t = renderTable(analyseStart(good()));
    for (const id of analyseStart(good()).checks.map((c) => c.id)) expect(t).toContain(id);
    for (const s of SECRETS) expect(t.includes(s)).toBe(false);
  });
});

describe('analyseStart: the details a reviewer reads', () => {
  const detail = (r: ReturnType<typeof analyseStart>, id: string): string =>
    r.checks.find((c) => c.id === id)?.detail ?? '';
  it('counts the send lines and names the operation and outcome', () => {
    expect(detail(analyseStart(good()), 'sends_blocked')).toBe(
      '2 line(s): oauth_token:blocked:no_approval x2',
    );
  });
  it('one single blocked send line is enough to pass', () => {
    const one = analyseStart(good({ stdout: [...BANNER, SELFCHECK, GOOD_SEND].join('\n') }));
    expect(failed(one)).toEqual([]);
    expect(one.facts.sends).toBe(1);
  });
  it('says so when the gate was never reached, and when the server never listened', () => {
    const none = analyseStart(good({ stdout: [...BANNER, SELFCHECK].join('\n') }));
    expect(detail(none, 'sends_blocked')).toBe('no sandbox.send line: the gate was never reached');
    expect(detail(analyseStart(good({ listened: false })), 'listened')).toBe(
      'no 200 from /healthz',
    );
    expect(detail(analyseStart(good()), 'listened')).toContain('answered 200');
  });
});

describe('analyseStart: bad runs', () => {
  it('the server never listened', () => {
    expect(failed(analyseStart(good({ listened: false })))).toContain('listened');
  });
  it('the server exited on its own with 78 or another code', () => {
    expect(failed(analyseStart(good({ exit: { code: 78, signal: null } })))).toContain(
      'clean_stop',
    );
    expect(failed(analyseStart(good({ exit: { code: 1, signal: null } })))).toContain('clean_stop');
    expect(failed(analyseStart(good({ exit: { code: null, signal: 'SIGKILL' } })))).toContain(
      'clean_stop',
    );
  });
  it('no selfcheck line', () => {
    const r = analyseStart(good({ stdout: [...BANNER, GOOD_SEND].join('\n') }));
    expect(failed(r)).toContain('selfcheck_line');
    expect(r.facts.selfcheck).toBeNull();
  });
  it.each([
    ['env_override true', { env_override: true }],
    ['builtins_intact false', { builtins_intact: false }],
    ['impl not node-https', { impl: 'fetch' }],
    ['wire_kind injected', { wire_kind: 'injected' }],
  ])('selfcheck line with %s', (_name, change) => {
    const line = JSON.stringify({ ...JSON.parse(SELFCHECK), ...change });
    const r = analyseStart(good({ stdout: [...BANNER, line, GOOD_SEND].join('\n') }));
    expect(failed(r)).toContain('selfcheck_line');
  });
  it('the selfcheck after Next loaded its modules is missing or dirty', () => {
    expect(failed(analyseStart(good({ ops_selfcheck: null })))).toContain('selfcheck_after_load');
    expect(
      failed(analyseStart(good({ ops_selfcheck: { ...AFTER_LOAD, builtins_intact: false } }))),
    ).toContain('selfcheck_after_load');
    expect(
      failed(analyseStart(good({ ops_selfcheck: { ...AFTER_LOAD, env_override: true } }))),
    ).toContain('selfcheck_after_load');
  });
  it('the fetch-patch value is not recorded at all', () => {
    const line = JSON.stringify({ ...JSON.parse(SELFCHECK), global_fetch_changed: 'maybe' });
    const r = analyseStart(
      good({
        stdout: [...BANNER, line, GOOD_SEND].join('\n'),
        ops_selfcheck: { ...AFTER_LOAD, global_fetch_changed_since_load: undefined as never },
      }),
    );
    expect(failed(r)).toContain('global_fetch_recorded');
  });
  it('no sandbox.send line at all proves nothing', () => {
    const r = analyseStart(good({ stdout: [...BANNER, SELFCHECK].join('\n') }));
    expect(failed(r)).toContain('sends_blocked');
  });
  it.each([
    ['a response', SEND('oauth_token', 'response')],
    ['a network error', SEND('oauth_token', 'network_error:connect')],
    ['a timeout', SEND('oauth_token', 'timeout')],
    ['blocked for another reason', SEND('oauth_token', 'blocked:kill_switch')],
    ['blocked egress', SEND('oauth_token', 'blocked:egress')],
    ['another operation', SEND('get_capture', 'blocked:no_approval')],
    ['a create_order', SEND('create_order', 'blocked:no_approval')],
  ])('one send line is %s', (_name, bad) => {
    const r = analyseStart(good({ stdout: [...BANNER, SELFCHECK, GOOD_SEND, bad].join('\n') }));
    expect(failed(r)).toContain('sends_blocked');
  });
  it('a send line with no outcome fails', () => {
    const noOutcome = JSON.stringify({
      msg: 'sandbox.send',
      level: 'info',
      operation: 'oauth_token',
    });
    expect(
      failed(
        analyseStart(good({ stdout: [...BANNER, SELFCHECK, GOOD_SEND, noOutcome].join('\n') })),
      ),
    ).toContain('sends_blocked');
  });
  it('a send line on stderr counts too', () => {
    const r = analyseStart(good({ stderr: SEND('oauth_token', 'response') }));
    expect(failed(r)).toContain('sends_blocked');
  });
  it('provider_calls: none, unreadable, or one not blocked', () => {
    expect(failed(analyseStart(good({ provider_calls: [] })))).toContain('provider_calls_blocked');
    expect(failed(analyseStart(good({ provider_calls: null })))).toContain(
      'provider_calls_blocked',
    );
    expect(
      failed(
        analyseStart(
          good({
            provider_calls: [
              { operation: 'oauth_token', outcome: 'blocked' },
              { operation: 'oauth_token', outcome: 'ok' },
            ],
          }),
        ),
      ),
    ).toContain('provider_calls_blocked');
    expect(
      failed(
        analyseStart(
          good({ provider_calls: [{ operation: 'oauth_token', outcome: 'unavailable' }] }),
        ),
      ),
    ).toContain('provider_calls_blocked');
  });
  it('a blocked row with a reason suffix still counts as blocked', () => {
    const r = analyseStart(
      good({ provider_calls: [{ operation: 'oauth_token', outcome: 'blocked:no_approval' }] }),
    );
    expect(failed(r)).toEqual([]);
  });
  it('the checkout came back with a success', () => {
    expect(failed(analyseStart(good({ checkout_status: 200 })))).toContain(
      'checkout_not_completed',
    );
    expect(failed(analyseStart(good({ checkout_status: 201 })))).toContain(
      'checkout_not_completed',
    );
    expect(failed(analyseStart(good({ checkout_status: null })))).toContain(
      'checkout_not_completed',
    );
    expect(analyseStart(good({ checkout_status: 409 })).ok).toBe(true);
  });
  it.each([
    ['the client id in stdout', FAKE_ID, 'stdout'],
    ['the client secret in stderr', FAKE_SECRET, 'stderr'],
    ['the Basic value in stdout', BASIC, 'stdout'],
  ])('%s fails and the table does not repeat it', (_n, value, where) => {
    const leak = j({ level: 'info', msg: 'oops', note: `x ${value} y` });
    const base = good();
    const r = analyseStart(
      where === 'stdout' ? good({ stdout: `${base.stdout}\n${leak}` }) : good({ stderr: leak }),
    );
    expect(failed(r)).toContain('no_secret_in_output');
    const table = renderTable(r);
    for (const s of SECRETS) expect(table.includes(s)).toBe(false);
    expect(JSON.stringify(r).includes(value)).toBe(false);
  });
  it('an empty secrets list is an error, not a pass', () => {
    expect(failed(analyseStart(good({ secrets: [] })))).toContain('no_secret_in_output');
  });
  it('an overall verdict is false when any check fails', () => {
    expect(analyseStart(good({ listened: false })).ok).toBe(false);
  });
});

describe('analyseOverride (NODE_OPTIONS=--require)', () => {
  const refusal = 'boot refused: transport_env_override (NODE_OPTIONS); nothing was started';
  const run = (o: Partial<Parameters<typeof analyseOverride>[0]> = {}) =>
    analyseOverride({
      exit: { code: 78, signal: null },
      stdout: [...BANNER.slice(0, 3), refusal].join('\n'),
      stderr: '',
      secrets: SECRETS,
      timed_out: false,
      ...o,
    });
  it('exit 78 with transport_env_override and no app log line passes', () => {
    const r = run();
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'exit_78',
        'refusal_names_override',
        'nothing_served',
        'no_secret_in_output',
      ]),
    );
  });
  it('the refusal on stderr counts', () => {
    expect(run({ stdout: BANNER.join('\n'), stderr: refusal }).ok).toBe(true);
  });
  it('records whether Next printed Ready before the refusal (it does: register() runs after)', () => {
    expect(run({ stdout: [...BANNER, refusal].join('\n') }).facts.ready_line_seen).toBe(true);
    expect(run().facts.ready_line_seen).toBe(false);
  });
  it('another exit code fails', () => {
    for (const code of [0, 1, 143]) {
      const r = run({ exit: { code, signal: null } });
      expect(r.checks.find((c) => c.id === 'exit_78')?.ok).toBe(false);
      expect(r.ok).toBe(false);
    }
    expect(run({ exit: { code: null, signal: 'SIGKILL' } }).ok).toBe(false);
  });
  it('a timeout fails even with the right text', () => {
    expect(run({ timed_out: true }).ok).toBe(false);
  });
  it('exit 78 for another reason fails', () => {
    const r = run({
      stdout: 'boot refused: weak_secret (UMS_SESSION_SECRET); nothing was started',
    });
    expect(r.checks.find((c) => c.id === 'refusal_names_override')?.ok).toBe(false);
  });
  it('an app log line means the app started', () => {
    for (const line of [SELFCHECK, GOOD_SEND, j({ level: 'warn', msg: 'jobs.loop.paused' })]) {
      const r = run({ stdout: [...BANNER, refusal, line].join('\n') });
      expect(r.checks.find((c) => c.id === 'nothing_served')?.ok).toBe(false);
    }
  });
  it('says how many application log lines were written', () => {
    const r = run({ stdout: [...BANNER, refusal, SELFCHECK].join('\n') });
    expect(r.checks.find((c) => c.id === 'nothing_served')?.detail).toBe(
      '1 application log line(s) were written',
    );
    expect(run().checks.find((c) => c.id === 'nothing_served')?.detail).toContain(
      'no application log line',
    );
  });
  it('a secret in the output fails', () => {
    const r = run({ stderr: `${refusal} ${FAKE_SECRET}` });
    expect(r.checks.find((c) => c.id === 'no_secret_in_output')?.ok).toBe(false);
    expect(JSON.stringify(r).includes(FAKE_SECRET)).toBe(false);
  });
});

describe('portCandidates', () => {
  it('gives distinct, unprivileged ports from the pid, stable for one pid', () => {
    const a = portCandidates(4242, 5);
    expect(a).toEqual(portCandidates(4242, 5));
    expect(new Set(a).size).toBe(5);
    for (const p of a) {
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThan(60000);
    }
    expect(portCandidates(4243, 1)[0]).not.toBe(a[0]);
    expect(portCandidates(4242, 3)).toEqual([56954, 57055, 57156]);
  });
});
