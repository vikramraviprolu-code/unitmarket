import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VERBS,
  ago,
  isRead,
  makeKit,
  mutating,
  setStackEnv,
  type Kit,
  type Scenario,
} from './cloud-kit-support';
import { REPO_ROOT } from './test-helpers';

// INT-CL1 (F8): the hostile cases. stack.env is parsed, never sourced; every verb with --dry-run only reads; the
// flag-off step of `down` cannot be skipped, reordered or half done; and a planted-defect table proves the
// tests would catch a broken lib/cloud-lib.sh. All against the fake gcloud (cloud-kit-support.ts).
const goodEnv = (): string => readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'stack.env'), 'utf8');
const DOWN: Scenario = { sqlPolicy: 'NEVER', web: { min: 0, ingress: 'internal' } };

const argsOf = (verb: string): string[] =>
  verb === 'deploy' ? ['deploy', 't1'] : verb === 'down' ? ['down', '--yes'] : [verb];

/** The files a hostile line could have created: none may appear. */
const strays = (k: Kit): string[] =>
  [k.repo, k.gcp, k.root, k.stub].flatMap((d) => readdirSync(d).filter((f) => f === 'pwn'));

describe('stack.env is parsed as KEY=value lines and never sourced', () => {
  const HOSTILE = [
    "SERVICE='x;touch pwn'",
    'SERVICE=$(touch pwn)',
    'SERVICE=`touch pwn`',
    'SERVICE=x;touch pwn',
    'SERVICE="x"',
    'SERVICE = x',
    'SERVICE=x y',
    'SERVICE=x\ttouch pwn',
    'export SERVICE=x',
    'SERVICE=${IFS}x',
    'SERVICE=../x',
    'FOO=bar',
    'service=lower',
  ];
  for (const line of HOSTILE) {
    for (const verb of ['status', 'up', 'down', 'doctor']) {
      it(`refuses (2) with no gcloud call and no file made: ${JSON.stringify(line)} on ${verb}`, () => {
        const k = makeKit();
        const clean = goodEnv()
          .split('\n')
          .filter((l) => !l.startsWith('SERVICE='));
        setStackEnv(k, [...clean, line, ''].join('\n'));
        const r = k.run(argsOf(verb));
        expect(r.status, r.out).toBe(2);
        expect(k.gcloud()).toEqual([]);
        expect(strays(k)).toEqual([]);
      });
    }
  }

  it('a missing name, a missing file and a CRLF line each refuse (2)', () => {
    const noService = makeKit();
    setStackEnv(
      noService,
      goodEnv()
        .split('\n')
        .filter((l) => !l.startsWith('SERVICE='))
        .join('\n'),
    );
    expect(noService.run(['status']).status).toBe(2);
    const crlf = makeKit();
    setStackEnv(crlf, goodEnv().replace(/\n/g, '\r\n'));
    expect(crlf.run(['status']).status).toBe(2);
    expect(crlf.gcloud()).toEqual([]);
    const gone = makeKit();
    spawnSync('rm', [join(gone.gcp, 'stack.env')]);
    expect(gone.run(['status']).status).toBe(2);
    expect(gone.gcloud()).toEqual([]);
  });

  it('a project or region that fails the deploy.sh patterns refuses (2)', () => {
    for (const [name, value] of [
      ['PROJECT_ID', 'Bad_Project'],
      ['PROJECT_ID', 'x'],
      ['PROJECT_ID', '1abc-def-ghi'],
      ['REGION', 'europe_west3'],
      ['REGION', 'Europe-west3'],
      ['REGION', 'europe'],
    ] as const) {
      const k = makeKit();
      setStackEnv(
        k,
        goodEnv()
          .split('\n')
          .map((l) => (l.startsWith(`${name}=`) ? `${name}=${value}` : l))
          .join('\n'),
      );
      const r = k.run(['status']);
      expect(r.status, `${name}=${value}`).toBe(2);
      expect(k.gcloud(), `${name}=${value}`).toEqual([]);
    }
  });

  it('stack.env is never sourced by the kit scripts', () => {
    for (const f of ['cloud.sh', join('lib', 'cloud-lib.sh')]) {
      const t = readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
      expect(t, f).not.toMatch(/^\s*(?:source|\.)\s+[^\n]*stack\.env/m);
      expect(t, f).not.toMatch(/\beval\b/);
    }
  });
});

describe('a deploy tag with metacharacters is a usage error (64)', () => {
  for (const tag of [
    't1;touch pwn',
    '$(touch pwn)',
    '`touch pwn`',
    'a b',
    '--help',
    '-rf',
    '../t1',
    't1\nx',
    "t1'",
    't1|ls',
  ]) {
    it(`refuses ${JSON.stringify(tag)}`, () => {
      const k = makeKit();
      const r = k.run(['deploy', tag]);
      expect(r.status, r.out).toBe(64);
      expect(k.gcloud().some((c) => /^run deploy/.test(c))).toBe(false);
      expect(strays(k)).toEqual([]);
    });
  }
});

describe('--dry-run on every verb only reads', () => {
  const scenarios: Array<[string, Scenario]> = [
    ['a running stack', {}],
    ['a stopped stack', DOWN],
    ['an old backup', { backupAt: ago(40) }],
    ['a flag that reads on', { web: { flag: 'on' } }],
  ];
  for (const [label, s] of scenarios) {
    for (const verb of VERBS) {
      it(`${verb} --dry-run on ${label}: describe and list calls only, no curl, no change`, () => {
        const k = makeKit(s);
        const before = JSON.stringify(k.read('web.json')) + k.read('sql_policy');
        const r = k.run([...argsOf(verb).filter((a) => a !== '--yes'), '--dry-run']);
        expect([0, 2], `${verb}: ${r.out}`).toContain(r.status);
        for (const c of k.gcloud()) expect(isRead(c), c).toBe(true);
        expect(k.curl()).toEqual([]);
        expect(JSON.stringify(k.read('web.json')) + k.read('sql_policy')).toBe(before);
      });
    }
  }
});

describe('down: the flag-off step cannot be skipped or half done', () => {
  it('when the flag-off update fails: exit 1 and no SQL or Run call follows it', () => {
    const k = makeKit({ failOn: ['UMS_PAYPAL_CONNECT=off'] });
    const r = k.run(['down', '--yes']);
    expect(r.status, r.out).toBe(1);
    const m = mutating(k.gcloud());
    expect(m).toHaveLength(1);
    expect(m[0]).toContain('UMS_PAYPAL_CONNECT=off');
    expect(k.gcloud().some((c) => /sql instances patch/.test(c))).toBe(false);
    expect(r.stderr).toMatch(/^cloud: /m);
  });

  it('when the service stop fails: exit 1 and the database is not stopped', () => {
    const k = makeKit({ failOn: ['--ingress=internal'] });
    const r = k.run(['down', '--yes']);
    expect(r.status, r.out).toBe(1);
    expect(k.gcloud().some((c) => /sql instances patch/.test(c))).toBe(false);
  });

  it('down never sets the flag on, and up and restart never touch it', () => {
    const k = makeKit({ web: { flag: 'on' } });
    k.run(['down', '--yes']);
    k.run(['up']);
    k.run(['restart']);
    for (const c of k.gcloud()) expect(c).not.toMatch(/UMS_PAYPAL_CONNECT=(?!off)/);
  });

  it('typed confirmation is not skipped by an empty or wrong standard input without --yes', () => {
    const k = makeKit();
    for (const input of ['', 'yes\n', 'unitmarket-sandbo\n', 'UNITMARKET-SANDBOX\n']) {
      const r = k.run(['down'], { input });
      expect(r.status, JSON.stringify(input)).toBe(2);
    }
    expect(mutating(k.gcloud())).toEqual([]);
  });
});

describe('planted defects in lib/cloud-lib.sh turn a named case red', () => {
  const realLib = (): string =>
    readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'lib', 'cloud-lib.sh'), 'utf8');

  /** The named cases. Each returns normally when the kit is right and throws when it is wrong. */
  const CASES: Record<string, (k: Kit) => void> = {
    'down: the flag-off update is the first mutating call': (k) => {
      const r = k.run(['down', '--yes']);
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.out}`);
      const m = mutating(k.gcloud());
      if (!/--update-env-vars=UMS_PAYPAL_CONNECT=off( |$)/.test(m[0] ?? ''))
        throw new Error(`first mutating call: ${m[0]}`);
    },
    'down: the database is stopped with --activation-policy=NEVER': (k) => {
      const r = k.run(['down', '--yes']);
      if (r.status !== 0) throw new Error(`exit ${r.status}`);
      if (
        !mutating(k.gcloud()).some((c) => /sql instances patch.*--activation-policy=NEVER/.test(c))
      )
        throw new Error('no NEVER patch');
      if (k.read('sql_policy').trim() !== 'NEVER') throw new Error('policy not NEVER');
    },
    'down: an old backup warns': (k) => {
      const r = k.run(['down', '--yes']);
      if (!/WARN.*older than 24 hours/.test(r.out)) throw new Error('no warning');
    },
    'down: no terminal and no --yes refuses': (k) => {
      const r = k.run(['down']);
      if (r.status !== 2) throw new Error(`exit ${r.status}`);
      if (mutating(k.gcloud()).length !== 0) throw new Error('changed something');
    },
    'down: --yes goes ahead without a prompt': (k) => {
      const r = k.run(['down', '--yes']);
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.out}`);
    },
  };
  const SCENARIO: Record<string, Scenario> = {
    'down: an old backup warns': { backupAt: ago(30) },
  };

  /** The kit with lib/cloud-lib.sh replaced by `lib`. */
  const withLib = (name: string, lib: string): Kit => {
    const k = makeKit(SCENARIO[name] ?? {});
    writeFileSync(join(k.gcp, 'lib', 'cloud-lib.sh'), lib);
    return k;
  };
  const passes = (name: string, lib: string): boolean => {
    try {
      CASES[name]!(withLib(name, lib));
      return true;
    } catch {
      return false;
    }
  };

  /** Replace the one line that contains `needle` (it must be unique). */
  const replaceLine = (lib: string, needle: string, to: string | null): string => {
    const lines = lib.split('\n');
    const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1)
      throw new Error(`lib must contain exactly one line with ${needle}; found ${hits.length}`);
    if (to === null) lines.splice(hits[0]!, 1);
    else lines[hits[0]!] = to;
    return lines.join('\n');
  };
  const lineWith = (lib: string, needle: string): string => {
    const l = lib.split('\n').filter((x) => x.includes(needle));
    if (l.length !== 1)
      throw new Error(`lib must contain exactly one line with ${needle}; found ${l.length}`);
    return l[0]!;
  };

  const DEFECTS: Array<[defect: string, apply: (lib: string) => string, redCase: string]> = [
    [
      'flag-off removed',
      (lib) => replaceLine(lib, '--update-env-vars=UMS_PAYPAL_CONNECT=off', ':'),
      'down: the flag-off update is the first mutating call',
    ],
    [
      'flag-off moved after the SQL stop',
      (lib) => {
        const flag = lineWith(lib, '--update-env-vars=UMS_PAYPAL_CONNECT=off');
        const without = replaceLine(lib, '--update-env-vars=UMS_PAYPAL_CONNECT=off', ':');
        return replaceLine(
          without,
          '--activation-policy=NEVER',
          `${lineWith(without, '--activation-policy=NEVER')}\n${flag}`,
        );
      },
      'down: the flag-off update is the first mutating call',
    ],
    [
      '--activation-policy=NEVER dropped',
      (lib) => lib.replace('--activation-policy=NEVER', '--quiet'),
      'down: the database is stopped with --activation-policy=NEVER',
    ],
    [
      'backup warning removed',
      (lib) => replaceLine(lib, 'older than 24 hours', ':'),
      'down: an old backup warns',
    ],
    [
      '--yes check inverted',
      (lib) =>
        replaceLine(
          lib,
          '[ "$YES" = "1" ]',
          lineWith(lib, '[ "$YES" = "1" ]').replace('[ "$YES" = "1" ]', '[ "$YES" != "1" ]'),
        ),
      'down: --yes goes ahead without a prompt',
    ],
  ];

  it('the real lib passes every named case (the table is not vacuous)', () => {
    for (const name of Object.keys(CASES)) expect(passes(name, realLib()), name).toBe(true);
  });

  for (const [defect, apply, redCase] of DEFECTS) {
    it(`${defect}: the lib still parses, and "${redCase}" goes red`, () => {
      const lib = apply(realLib());
      expect(lib).not.toBe(realLib());
      const tmp = mkdtempSync(join(tmpdir(), 'sbx-planted-'));
      const file = join(tmp, 'lib.sh');
      writeFileSync(file, lib);
      const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(passes(redCase, lib), `${defect} must turn "${redCase}" red`).toBe(false);
    });
  }

  it('the inverted --yes check also turns the refusal case red', () => {
    const lib = DEFECTS[4]![1](realLib());
    expect(passes('down: no terminal and no --yes refuses', lib)).toBe(false);
  });
});
