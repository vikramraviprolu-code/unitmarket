import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './test-helpers';

// INFRA-A: run the two real deploy scripts against a STUB gcloud (a bash file placed first on PATH) in a
// throwaway git repository holding a copy of infra/gcp at a tag. No real gcloud is ever started and no
// network is touched. The stub answers the read-only questions the scripts ask, records every call, and
// exits 97 on any command the scripts are not expected to run (create, access, add, set-iam...).
const REQUIRED = [
  'DATABASE_URL',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'UMS_OUTBOUND_APPROVAL_REF',
  'UMS_SESSION_SECRET',
  'UMS_APPROVAL_SECRET',
  'UMS_LINK_SECRET',
  'UMS_DEMO_PASSCODE_HASH',
  'UMS_OWN_MERCHANT_ID',
  'UMS_OPERATOR_TOTP_KEYS',
];
const OPTIONAL = [
  'UMS_PUBLISHER_PASSCODE_HASH',
  'UMS_OFFER_MAX_MINOR',
  'UMS_AI_ADAPTER',
  'UMS_ANTHROPIC_API_KEY',
];
const OFFLINE = [
  'UMS_OFFLINE_SESSION_SECRET',
  'UMS_OFFLINE_APPROVAL_SECRET',
  'UMS_OFFLINE_LINK_SECRET',
  'UMS_OFFLINE_DEMO_PASSCODE_HASH',
];

const STUB = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$DIR/calls.txt"
case "$1 $2 $3" in
  "auth list "*) echo "tester" ;;
  "secrets versions list")
    if grep -qxF "$4" "$DIR/fail.txt"; then exit 1; fi
    if grep -qxF "$4" "$DIR/has.txt"; then echo "1"; fi ;;
  "sql instances describe") echo "RUNNABLE" ;;
  "artifacts docker images") exit 0 ;;
  "run deploy "*)
    for a in "$@"; do
      case "$a" in --env-vars-file=*) cp "\${a#*=}" "$DIR/envfile.out" ;; esac
    done ;;
  "run services describe") echo "https://stub.invalid" ;;
  *) echo "stub gcloud: unexpected call: $*" >&2; exit 97 ;;
esac
`;

interface Run {
  status: number | null;
  out: string;
  calls: string[];
  deploy: string | undefined;
  envFile: string;
}

function setup(): { repo: string; stub: string } {
  const root = mkdtempSync(join(tmpdir(), 'sbx-deploy-kit-'));
  const repo = join(root, 'repo');
  const stub = join(root, 'stub');
  mkdirSync(join(repo, 'infra'), { recursive: true });
  mkdirSync(stub);
  cpSync(join(REPO_ROOT, 'infra', 'gcp'), join(repo, 'infra', 'gcp'), { recursive: true });
  writeFileSync(join(stub, 'gcloud'), STUB);
  chmodSync(join(stub, 'gcloud'), 0o755);
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], {
      cwd: repo,
      encoding: 'utf8',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'kit');
  git('tag', 't1');
  return { repo, stub };
}

function run(script: string, has: string[], fail: string[] = []): Run {
  const { repo, stub } = setup();
  writeFileSync(join(stub, 'has.txt'), has.join('\n') + '\n');
  writeFileSync(join(stub, 'fail.txt'), fail.join('\n') + '\n');
  writeFileSync(join(stub, 'calls.txt'), '');
  writeFileSync(join(stub, 'envfile.out'), '');
  // The stub directory goes first on PATH; $0 of the wrapper is that directory.
  const r = spawnSync(
    'bash',
    ['-c', 'PATH="$0:$PATH"; exec bash "$@"', stub, join(repo, 'infra', 'gcp', script), 'ums-test-project', 'europe-west3', 't1'],
    { cwd: repo, encoding: 'utf8' },
  );
  const calls = readFileSync(join(stub, 'calls.txt'), 'utf8').split('\n').filter(Boolean);
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    calls,
    deploy: calls.find((c) => c.startsWith('run deploy ')),
    envFile: readFileSync(join(stub, 'envfile.out'), 'utf8'),
  };
}

const secretsOf = (deploy: string | undefined): string[] =>
  (/--set-secrets=(\S+)/.exec(deploy ?? '')?.[1] ?? '').split(',').filter(Boolean);

describe('INFRA-A deploy.sh against a stub gcloud', () => {
  it('no optional secret has a value: the deploy still runs and maps only the eleven required', () => {
    const r = run('deploy.sh', REQUIRED);
    expect(r.status, r.out).toBe(0);
    expect(secretsOf(r.deploy).sort()).toEqual(REQUIRED.map((n) => `${n}=${n}:latest`).sort());
    for (const n of OPTIONAL) expect(r.out).toContain(`off: ${n} has no value`);
  });

  it('all four optional secrets have values: all four are mapped by name', () => {
    const r = run('deploy.sh', [...REQUIRED, ...OPTIONAL]);
    expect(r.status, r.out).toBe(0);
    const got = secretsOf(r.deploy);
    for (const n of OPTIONAL) expect(got).toContain(`${n}=${n}:latest`);
    expect(got).toHaveLength(REQUIRED.length + OPTIONAL.length);
  });

  it('each optional secret alone is mapped alone', () => {
    for (const n of ['UMS_PUBLISHER_PASSCODE_HASH', 'UMS_OFFER_MAX_MINOR']) {
      const r = run('deploy.sh', [...REQUIRED, n]);
      expect(r.status, r.out).toBe(0);
      const got = secretsOf(r.deploy);
      expect(got).toContain(`${n}=${n}:latest`);
      expect(got).toHaveLength(REQUIRED.length + 1);
    }
  });

  it('the adapter name without the API key is left out, so the app cannot refuse to boot', () => {
    const r = run('deploy.sh', [...REQUIRED, 'UMS_AI_ADAPTER', 'UMS_PUBLISHER_PASSCODE_HASH']);
    expect(r.status, r.out).toBe(0);
    const got = secretsOf(r.deploy);
    expect(got.join(',')).not.toContain('UMS_AI_ADAPTER');
    expect(got).toContain('UMS_PUBLISHER_PASSCODE_HASH=UMS_PUBLISHER_PASSCODE_HASH:latest');
    expect(r.out).toContain('UMS_AI_ADAPTER is left out');
  });

  it('the API key alone is mapped (the adapter stays scripted without the adapter secret)', () => {
    const r = run('deploy.sh', [...REQUIRED, 'UMS_ANTHROPIC_API_KEY']);
    expect(r.status, r.out).toBe(0);
    expect(secretsOf(r.deploy)).toContain('UMS_ANTHROPIC_API_KEY=UMS_ANTHROPIC_API_KEY:latest');
  });

  it('a failed lookup of an optional secret never fails the deploy', () => {
    const r = run('deploy.sh', [...REQUIRED, 'UMS_OFFER_MAX_MINOR'], ['UMS_OFFER_MAX_MINOR']);
    expect(r.status, r.out).toBe(0);
    expect(secretsOf(r.deploy).join(',')).not.toContain('UMS_OFFER_MAX_MINOR');
  });

  it('the connection ends off: the env file passed to the deploy sets it off, with every optional secret on', () => {
    const r = run('deploy.sh', [...REQUIRED, ...OPTIONAL]);
    expect(r.status, r.out).toBe(0);
    expect(r.envFile).toContain("UMS_PAYPAL_CONNECT: 'off'");
    expect(r.envFile).not.toMatch(/UMS_PAYPAL_CONNECT: '(?!off')/);
    expect(r.deploy).not.toMatch(/--(?:set|update)-env-vars/);
    expect(r.deploy).toContain('--min-instances=1');
    expect(r.deploy).toContain('--max-instances=1');
  });

  it('a missing REQUIRED secret still stops the deploy before any deploy call', () => {
    const r = run('deploy.sh', REQUIRED.filter((n) => n !== 'UMS_LINK_SECRET'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('UMS_LINK_SECRET');
    expect(r.deploy).toBeUndefined();
  });

  it('the script only asks questions: no create, no access, no add, no binding call', () => {
    const r = run('deploy.sh', [...REQUIRED, ...OPTIONAL]);
    expect(r.status, r.out).toBe(0);
    for (const c of r.calls)
      expect(c, c).toMatch(
        /^(?:auth list|secrets versions list|sql instances describe|artifacts docker images describe|run deploy|run services describe)\b/,
      );
  });
});

describe('INFRA-A deploy-offline.sh against a stub gcloud', () => {
  it('maps only its four own secrets, to the env names without OFFLINE_, with no database and no payment name', () => {
    const r = run('deploy-offline.sh', OFFLINE);
    expect(r.status, r.out).toBe(0);
    expect(secretsOf(r.deploy).sort()).toEqual(
      [
        'UMS_SESSION_SECRET=UMS_OFFLINE_SESSION_SECRET:latest',
        'UMS_APPROVAL_SECRET=UMS_OFFLINE_APPROVAL_SECRET:latest',
        'UMS_LINK_SECRET=UMS_OFFLINE_LINK_SECRET:latest',
        'UMS_DEMO_PASSCODE_HASH=UMS_OFFLINE_DEMO_PASSCODE_HASH:latest',
      ].sort(),
    );
    expect(r.deploy).not.toMatch(/PAYPAL|DATABASE_URL|cloudsql|OUTBOUND|MERCHANT|TOTP/i);
    expect(r.deploy).toContain('run deploy unitmarket-offline');
    expect(r.deploy).toContain('--service-account=ums-offline@ums-test-project.iam.gserviceaccount.com');
    expect(r.deploy).toContain('--min-instances=1');
    expect(r.deploy).toContain('--max-instances=1');
  });

  it('passes an env file that is offline, in memory, with the connection off', () => {
    const r = run('deploy-offline.sh', OFFLINE);
    expect(r.status, r.out).toBe(0);
    expect(r.envFile).toContain("UMS_MODE: 'offline'");
    expect(r.envFile).toContain("UMS_DB: 'pglite-memory'");
    expect(r.envFile).toContain("UMS_PAYPAL_CONNECT: 'off'");
    expect(r.envFile).not.toMatch(/PAYPAL_(?!CONNECT)|DATABASE_URL/);
  });

  it('refuses, before any deploy call, when one of its own secrets has no value', () => {
    for (const missing of OFFLINE) {
      const r = run('deploy-offline.sh', OFFLINE.filter((n) => n !== missing));
      expect(r.status, missing).toBe(1);
      expect(r.out).toContain(missing);
      expect(r.deploy).toBeUndefined();
    }
  });

  it('never looks at a payment secret and only asks questions', () => {
    const r = run('deploy-offline.sh', OFFLINE);
    expect(r.status, r.out).toBe(0);
    const lookups = r.calls.filter((c) => c.startsWith('secrets versions list'));
    expect(lookups).toHaveLength(OFFLINE.length);
    for (const l of lookups) expect(l).toMatch(/list UMS_OFFLINE_/);
    for (const c of r.calls)
      expect(c, c).toMatch(
        /^(?:auth list|secrets versions list|artifacts docker images describe|run deploy|run services describe)\b/,
      );
  });
});
