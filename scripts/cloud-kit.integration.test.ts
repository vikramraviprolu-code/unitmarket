import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SECRETS,
  VERBS,
  WEB_URL,
  ago,
  isRead,
  makeKit,
  mutating,
  type Kit,
  type Scenario,
} from './cloud-kit-support';

// INT-CL1 items 1 to 8: the seven cloud verbs of infra/gcp/cloud.sh, run for real (bash) against a FAKE gcloud,
// a fake curl and a logging git shim (see cloud-kit-support.ts). The fake exits 97 on any call a case does not
// expect, so a stray call fails the case. Nothing here reaches a network or a Google Cloud project (D-049).
const DOWN_WEB = { min: 0, ingress: 'internal' as const };
const STOPPED: Scenario = { sqlPolicy: 'NEVER', web: DOWN_WEB };
const text = (r: { out: string }): string => r.out;

describe('item 1: the shared library, the exit contract and --dry-run', () => {
  it('a missing or unknown verb is a usage error (64) and makes no gcloud call', () => {
    for (const args of [[], ['frobnicate'], ['status', '--bogus'], ['up', 'extra']]) {
      const k = makeKit();
      const r = k.run(args);
      expect(r.status, args.join(' ')).toBe(64);
      expect(k.gcloud(), args.join(' ')).toEqual([]);
    }
  });

  it('a usage error says what is wrong on stderr, starting with cloud:', () => {
    const r = makeKit().run(['frobnicate']);
    expect(r.stderr).toMatch(/^cloud: /m);
  });

  it('exit 0: a second up on a running stack is a no-op', () => {
    const k = makeKit();
    expect(k.run(['up']).status).toBe(0);
  });

  it('exit 1: an action whose gcloud call fails reports one line starting with cloud:', () => {
    const k = makeKit({ failOn: ['run services update'] });
    const r = k.run(['restart']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^cloud: /m);
  });

  it('exit 2: a precondition is not met (down without a terminal and without --yes)', () => {
    const k = makeKit();
    expect(k.run(['down']).status).toBe(2);
  });

  it('--dry-run on up prints the planned calls and makes only describe and list calls', () => {
    const k = makeKit(STOPPED);
    const r = k.run(['up', '--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(mutating(k.gcloud())).toEqual([]);
    expect(k.curl()).toEqual([]);
    expect(text(r)).toMatch(/dry-run/);
    expect(text(r)).toContain('--activation-policy=ALWAYS');
    expect(text(r)).toContain('--min-instances=1');
  });

  it('the kit never calls config set, auth login or a secret access', () => {
    for (const verb of ['doctor', 'status', 'up', 'restart']) {
      const k = makeKit();
      k.run([verb]);
      for (const c of k.gcloud()) {
        expect(c, c).not.toMatch(/^config set|^auth (?!list)|secrets versions access/);
      }
    }
  });
});

describe('item 2: cloud doctor', () => {
  it('a healthy stack: exit 0, nothing changed', () => {
    const k = makeKit();
    const r = k.run(['doctor']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/doctor: ok/);
    expect(mutating(k.gcloud())).toEqual([]);
  });

  it('no active account: exit 2, prints the two config lines, never runs them', () => {
    const k = makeKit({ account: '' });
    const r = k.run(['doctor']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('gcloud config set account');
    expect(r.out).toContain('gcloud config set project unitmarket-sbx-vr1');
    expect(k.gcloud().some((c) => /\bconfig\b/.test(c))).toBe(false);
    expect(k.gcloud().every((c) => c.startsWith('auth list'))).toBe(true);
  });

  it('an old backup prints a warning and is not a failure', () => {
    const k = makeKit({ backupAt: ago(30) });
    const r = k.run(['doctor']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN.*older than 24 hours/);
  });

  it('no backup at all is also a warning', () => {
    const k = makeKit({ backupAt: null });
    const r = k.run(['doctor']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN.*backup/i);
  });

  it('reports an origin mismatch between service.yaml and the service address', () => {
    const k = makeKit({ web: { url: 'https://elsewhere-xyz-ey.a.run.app' } });
    const r = k.run(['doctor']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN.*origin mismatch/);
  });

  it('a missing secret name is reported by name and refuses (2)', () => {
    const k = makeKit({ listedSecrets: REQUIRED_SECRETS.filter((n) => n !== 'UMS_LINK_SECRET') });
    const r = k.run(['doctor']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/FAIL.*UMS_LINK_SECRET/);
  });

  it('a required API that is not enabled refuses (2)', () => {
    const k = makeKit({ apis: ['run.googleapis.com'] });
    const r = k.run(['doctor']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/FAIL.*sqladmin/);
  });

  it('prints no secret value and only lists secret names', () => {
    const k = makeKit();
    k.run(['doctor']);
    for (const c of k.gcloud()) expect(c).not.toMatch(/versions access|--data-file/);
  });
});

describe('item 3: cloud status', () => {
  it('prints five parts and exits 0 when none is down', () => {
    const k = makeKit();
    const r = k.run(['status']);
    expect(r.status, r.out).toBe(0);
    for (const n of ['web', 'job_loop', 'database', 'offline_judge', 'paypal_gateway'])
      expect(r.out).toContain(n);
  });

  it('--json prints only JSON, with the url of the web part', () => {
    const k = makeKit();
    const r = k.run(['status', '--json']);
    expect(r.status, r.out).toBe(0);
    const j = JSON.parse(r.stdout) as { services: Array<{ name: string; url?: string }> };
    expect(j.services.find((s) => s.name === 'web')?.url).toBe(WEB_URL);
  });

  it('exit 1 when the database is stopped, and the part says down', () => {
    const k = makeKit({ sqlPolicy: 'NEVER' });
    const r = k.run(['status', '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { services: Array<{ name: string; state: string }> };
    expect(j.services.find((s) => s.name === 'database')?.state).toBe('down');
  });

  it('exit 1 when the web service is down (min 0, ingress internal); job_loop mirrors it', () => {
    const k = makeKit({ web: DOWN_WEB });
    const r = k.run(['status', '--json']);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout) as { services: Array<{ name: string; state: string }> };
    expect(j.services.find((s) => s.name === 'web')?.state).toBe('down');
    expect(j.services.find((s) => s.name === 'job_loop')?.state).toBe('down');
  });

  it('a service that is not Ready is error with its message; Unknown is starting', () => {
    const bad = makeKit({ web: { ready: 'False', message: 'container failed to start' } });
    const rb = bad.run(['status', '--json']);
    expect(rb.status).toBe(1);
    const jb = JSON.parse(rb.stdout) as {
      services: Array<{ name: string; state: string; last_error: string | null }>;
    };
    const web = jb.services.find((s) => s.name === 'web');
    expect(web?.state).toBe('error');
    expect(web?.last_error).toContain('container failed to start');
    const starting = makeKit({ web: { ready: 'Unknown' } });
    const js = JSON.parse(starting.run(['status', '--json']).stdout) as {
      services: Array<{ name: string; state: string }>;
    };
    expect(js.services.find((s) => s.name === 'web')?.state).toBe('starting');
  });

  it('a missing offline service is absent and does not fail the status', () => {
    const k = makeKit({ offline: false });
    const r = k.run(['status', '--json']);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { services: Array<{ name: string; state: string }> };
    expect(j.services.find((s) => s.name === 'offline_judge')?.state).toBe('absent');
  });

  it('the offline part is read by describing unitmarket-offline, never hard-coded (N1)', () => {
    const k = makeKit({
      offline: { revision: 'unitmarket-offline-00004-abc', url: 'https://off.a.run.app' },
    });
    const r = k.run(['status', '--json']);
    expect(r.status, r.out).toBe(0);
    expect(k.gcloud().some((c) => /^run services describe unitmarket-offline\b/.test(c))).toBe(
      true,
    );
    const j = JSON.parse(r.stdout) as {
      services: Array<{ name: string; state: string; revision?: string }>;
    };
    const o = j.services.find((s) => s.name === 'offline_judge');
    expect(o?.state).toBe('up');
    expect(o?.revision).toBe('unitmarket-offline-00004-abc');
  });

  it('approval_ref_set is true only when the secret has an enabled version, and no value is read', () => {
    const yes = makeKit();
    const jy = JSON.parse(yes.run(['status', '--json']).stdout) as {
      services: Array<{ name: string; approval_ref_set?: boolean }>;
    };
    expect(jy.services.find((s) => s.name === 'paypal_gateway')?.approval_ref_set).toBe(true);
    const no = makeKit({
      hasSecrets: REQUIRED_SECRETS.filter((n) => n !== 'UMS_OUTBOUND_APPROVAL_REF'),
    });
    const jn = JSON.parse(no.run(['status', '--json']).stdout) as {
      services: Array<{ name: string; approval_ref_set?: boolean }>;
    };
    expect(jn.services.find((s) => s.name === 'paypal_gateway')?.approval_ref_set).toBe(false);
    for (const c of [...yes.gcloud(), ...no.gcloud()]) {
      expect(c).not.toMatch(/secrets versions access/);
      if (/^secrets/.test(c))
        expect(c).toMatch(/^secrets versions list UMS_OUTBOUND_APPROVAL_REF /);
    }
  });

  it('the gateway part reports the Cloud Run flag only', () => {
    const on = makeKit({ web: { flag: 'on' } });
    const j = JSON.parse(on.run(['status', '--json']).stdout) as {
      services: Array<{ name: string; state: string; flag?: string }>;
    };
    const g = j.services.find((s) => s.name === 'paypal_gateway');
    expect(g).toMatchObject({ state: 'on', flag: 'on' });
    const off = makeKit();
    const j2 = JSON.parse(off.run(['status', '--json']).stdout) as {
      services: Array<{ name: string; state: string; flag?: string }>;
    };
    expect(j2.services.find((s) => s.name === 'paypal_gateway')).toMatchObject({
      state: 'off',
      flag: 'off',
    });
  });

  it('makes only describe and list calls', () => {
    const k = makeKit();
    k.run(['status']);
    expect(mutating(k.gcloud())).toEqual([]);
  });
});

describe('item 4: cloud up', () => {
  it('runs in order: SQL ALWAYS, wait for RUNNABLE, the service update, then the health probe', () => {
    const k = makeKit({ ...STOPPED, wakePolls: 2 });
    const r = k.run(['up']);
    expect(r.status, r.out).toBe(0);
    const lines = k.lines();
    const patch = lines.findIndex((l) =>
      /^sql instances patch\b.*--activation-policy=ALWAYS/.test(l),
    );
    const update = lines.findIndex((l) => /^run services update\b/.test(l));
    const probe = lines.findIndex((l) => /^curl .*\/api\/v1\/status$/.test(l));
    const waits = lines
      .map((l, i) => (/^sql instances describe\b/.test(l) && i > patch && i < update ? i : -1))
      .filter((i) => i >= 0);
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(update).toBeGreaterThan(waits[waits.length - 1]!);
    expect(probe).toBeGreaterThan(update);
    const u = lines[update]!;
    for (const f of [
      '--min-instances=1',
      '--max-instances=1',
      '--no-cpu-throttling',
      '--ingress=all',
    ])
      expect(u, f).toContain(f);
    expect(u).not.toMatch(/--image|env-vars|--source/);
  });

  it('never touches the PayPal flag', () => {
    const k = makeKit(STOPPED);
    expect(k.run(['up']).status).toBe(0);
    expect(k.lines().join('\n')).not.toContain('UMS_PAYPAL_CONNECT');
  });

  it('probes only GET /api/v1/status of the service address', () => {
    const k = makeKit(STOPPED);
    k.run(['up']);
    expect(k.curl().length).toBeGreaterThan(0);
    for (const c of k.curl()) {
      expect(c).toContain(`${WEB_URL}/api/v1/status`);
      expect(c).not.toMatch(/--data|-X |--request|--upload|--header|-H /);
    }
  });

  it('a second up prints "already up", exits 0 and changes nothing', () => {
    const k = makeKit(STOPPED);
    expect(k.run(['up']).status).toBe(0);
    const before = k.gcloud().length;
    const r = k.run(['up']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('already up');
    expect(mutating(k.gcloud().slice(before))).toEqual([]);
  });

  it('a missing service exits 2 and says to run cloud deploy', () => {
    const k = makeKit({ sqlPolicy: 'NEVER', web: false });
    const r = k.run(['up']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('cloud deploy');
  });

  it('a database that never becomes RUNNABLE times out with exit 1 and no service update', () => {
    const k = makeKit({ ...STOPPED, wakePolls: 100 });
    const r = k.run(['up']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/timed out/);
    expect(k.gcloud().some((c) => /^run services update/.test(c))).toBe(false);
  });

  it('an unhealthy answer from the probe is exit 1', () => {
    const k = makeKit({ ...STOPPED, probeStatus: [503] });
    const r = k.run(['up']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not healthy/);
  });

  it('prints the address and the backup age', () => {
    const k = makeKit(STOPPED);
    const r = k.run(['up']);
    expect(r.out).toContain(WEB_URL);
    expect(r.out).toMatch(/backup/i);
  });
});

describe('item 5: cloud down', () => {
  it('with --yes: the flag-off update comes first, then the service stops, then the database', () => {
    const k = makeKit();
    const r = k.run(['down', '--yes']);
    expect(r.status, r.out).toBe(0);
    const m = mutating(k.gcloud());
    expect(m).toHaveLength(3);
    expect(m[0]).toMatch(
      /^run services update unitmarket-sandbox\b.*--update-env-vars=UMS_PAYPAL_CONNECT=off( |$)/,
    );
    expect(m[0]).not.toMatch(/--min-instances|--ingress|--activation-policy/);
    expect(m[1]).toMatch(/^run services update unitmarket-sandbox\b/);
    expect(m[1]).toContain('--min-instances=0');
    expect(m[1]).toContain('--ingress=internal');
    expect(m[2]).toMatch(/^sql instances patch unitmarket-sbx-pg\b.*--activation-policy=NEVER/);
  });

  it('with no terminal and no --yes it refuses (2) before any change', () => {
    const k = makeKit();
    const r = k.run(['down']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/--yes|terminal/);
    expect(mutating(k.gcloud())).toEqual([]);
  });

  it('no call contains delete, and deletion protection is never touched', () => {
    const k = makeKit();
    k.run(['down', '--yes']);
    k.run(['up']);
    for (const c of k.gcloud()) expect(c.toLowerCase(), c).not.toMatch(/delete|deletion/);
  });

  it('a newest backup older than 24 hours warns, and the stop still goes ahead', () => {
    const k = makeKit({ backupAt: ago(30) });
    const r = k.run(['down', '--yes']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/WARN.*older than 24 hours/);
    expect(mutating(k.gcloud())).toHaveLength(3);
  });

  it('a fresh backup gives no warning', () => {
    const k = makeKit({ backupAt: ago(3) });
    const r = k.run(['down', '--yes']);
    expect(r.out).not.toMatch(/older than 24 hours/);
  });

  it('switches the flag off even when it read on', () => {
    const k = makeKit({ web: { flag: 'on' } });
    expect(k.run(['down', '--yes']).status).toBe(0);
    const j = JSON.parse(readFileSync(join(k.state, 'web.json'), 'utf8')) as {
      spec: {
        template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } };
      };
    };
    const env = j.spec.template.spec.containers[0]!.env;
    expect(env.find((e) => e.name === 'UMS_PAYPAL_CONNECT')?.value).toBe('off');
  });

  it('a second down prints "already down" and changes nothing', () => {
    const k = makeKit();
    expect(k.run(['down', '--yes']).status).toBe(0);
    const before = k.gcloud().length;
    const r = k.run(['down', '--yes']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('already down');
    expect(mutating(k.gcloud().slice(before))).toEqual([]);
  });

  it('--dry-run prints the three calls and makes none', () => {
    const k = makeKit();
    const r = k.run(['down', '--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(mutating(k.gcloud())).toEqual([]);
    expect(r.out).toContain('UMS_PAYPAL_CONNECT=off');
    expect(r.out).toContain('--activation-policy=NEVER');
  });

  it('then up and down leave a stack that status reads as up and down', () => {
    const k = makeKit();
    k.run(['down', '--yes']);
    expect(k.run(['status', '--json']).status).toBe(1);
    expect(k.run(['up']).status).toBe(0);
    expect(k.run(['status', '--json']).status).toBe(0);
  });
});

describe('item 6: cloud restart', () => {
  it('makes exactly one service update with a restarted-at label and nothing else changed', () => {
    const k = makeKit();
    const r = k.run(['restart']);
    expect(r.status, r.out).toBe(0);
    const m = mutating(k.gcloud());
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/^run services update unitmarket-sandbox\b/);
    expect(m[0]).toMatch(/--update-labels=restarted-at=\d{8}t\d{6}z( |$)/);
    expect(m[0]).not.toMatch(/--image|env-vars|--min-instances|--max-instances|--ingress|--source/);
  });

  it('probes the health route after the update', () => {
    const k = makeKit();
    k.run(['restart']);
    const lines = k.lines();
    const update = lines.findIndex((l) => /^run services update/.test(l));
    const probe = lines.findIndex((l) => /^curl /.test(l));
    expect(probe).toBeGreaterThan(update);
  });

  it('a service that is down or missing refuses (2); the flag is never touched', () => {
    const down = makeKit({ web: DOWN_WEB });
    expect(down.run(['restart']).status).toBe(2);
    expect(mutating(down.gcloud())).toEqual([]);
    const none = makeKit({ web: false });
    expect(none.run(['restart']).status).toBe(2);
    const k = makeKit();
    k.run(['restart']);
    expect(k.lines().join('\n')).not.toContain('UMS_PAYPAL_CONNECT');
  });
});

describe('item 7: cloud deploy <tag>', () => {
  const dirty = (k: Kit): void => writeFileSync(join(k.repo, 'untracked.txt'), 'x');

  it('with a fresh backup and HEAD at the tag: runs deploy.sh, probes, prints the paste-back block', () => {
    const k = makeKit();
    const r = k.run(['deploy', 't1']);
    expect(r.status, r.out).toBe(0);
    expect(k.gcloud().some((c) => /^run deploy unitmarket-sandbox\b/.test(c))).toBe(true);
    expect(k.curl().length).toBeGreaterThan(0);
    expect(r.out).toMatch(/^tag: t1$/m);
    expect(r.out).toMatch(/^commit: [0-9a-f]{12}$/m);
    expect(r.out).toMatch(/^revision: unitmarket-sandbox-00032-new$/m);
    expect(r.out).toMatch(/^url: https:\/\//m);
    expect(r.out).toMatch(/^health: ok$/m);
    expect(r.out).toMatch(/^flag: off$/m);
  });

  it('no backup in the last 24 hours refuses (2) unless --accept-old-backup is given', () => {
    const old = makeKit({ backupAt: ago(30) });
    const r = old.run(['deploy', 't1']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/backup/);
    expect(old.gcloud().some((c) => /^run deploy/.test(c))).toBe(false);
    const none = makeKit({ backupAt: null });
    expect(none.run(['deploy', 't1']).status).toBe(2);
    const ok = makeKit({ backupAt: ago(30) });
    const r2 = ok.run(['deploy', 't1', '--accept-old-backup']);
    expect(r2.status, r2.out).toBe(0);
    expect(ok.gcloud().some((c) => /^run deploy/.test(c))).toBe(true);
  });

  it('a dirty tree refuses (2) before any deploy call', () => {
    const k = makeKit();
    dirty(k);
    const r = k.run(['deploy', 't1']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/clean|dirty|differs/);
    expect(k.gcloud().some((c) => /^run deploy/.test(c))).toBe(false);
  });

  it('HEAD not exactly at the tag refuses (2): it never fetches or checks out', () => {
    const k = makeKit();
    // advance HEAD one commit past the tag with the real git (not the shim); the tree is clean again
    writeFileSync(join(k.repo, 'later.txt'), 'x');
    spawnSync('git', ['add', '-A'], { cwd: k.repo });
    spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'later'],
      { cwd: k.repo },
    );
    const r = k.run(['deploy', 't1']);
    expect(r.status).toBe(2);
    expect(k.gcloud().some((c) => /^run deploy/.test(c))).toBe(false);
  });

  it('a bad tag is a usage error (64)', () => {
    for (const args of [
      ['deploy'],
      ['deploy', 'bad tag'],
      ['deploy', 'x;y'],
      ['deploy', '--accept-old-backup'],
    ]) {
      const k = makeKit();
      expect(k.run(args).status, args.join(' ')).toBe(64);
      expect(k.gcloud().some((c) => /^run deploy/.test(c))).toBe(false);
    }
  });

  it('never creates, moves, fetches or checks out anything with git', () => {
    const k = makeKit();
    k.run(['deploy', 't1']);
    const g = k.git();
    expect(g.length).toBeGreaterThan(0);
    for (const c of g)
      expect(c, c).not.toMatch(
        /^git (?:tag|push|fetch|pull|checkout|switch|reset|clone|branch|commit|merge|rebase)\b/,
      );
    expect(g.some((c) => c === 'git describe --exact-match --tags HEAD')).toBe(true);
  });

  it('a stopped database refuses (2) and points to cloud up', () => {
    const k = makeKit({ sqlPolicy: 'NEVER' });
    const r = k.run(['deploy', 't1']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('cloud up');
  });

  it('--dry-run runs no deploy and makes only describe and list calls', () => {
    const k = makeKit();
    const r = k.run(['deploy', 't1', '--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(mutating(k.gcloud())).toEqual([]);
    expect(k.gcloud().every(isRead)).toBe(true);
  });

  it('leaves the connection off: it passes no env flag and prints flag: off', () => {
    const k = makeKit();
    const r = k.run(['deploy', 't1']);
    expect(r.status, r.out).toBe(0);
    expect(k.lines().join('\n')).not.toMatch(/--update-env-vars|UMS_PAYPAL_CONNECT=on/);
    expect(existsSync(join(k.stub, 'envfile.out'))).toBe(true);
    expect(readFileSync(join(k.stub, 'envfile.out'), 'utf8')).toContain(
      "UMS_PAYPAL_CONNECT: 'off'",
    );
  });
});

describe('item 8: cloud logs', () => {
  it('reads 100 lines by default, with a fixed field list and no request bodies', () => {
    const k = makeKit();
    const r = k.run(['logs']);
    expect(r.status, r.out).toBe(0);
    const reads = k.gcloud().filter((c) => /^logging read\b/.test(c));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('--limit=100');
    expect(reads[0]).toContain('--format=value(timestamp,severity,jsonPayload.msg,textPayload)');
    expect(reads[0]).not.toMatch(/httpRequest|protoPayload|--format=json/);
    expect(reads[0]).toContain('unitmarket-sandbox');
    expect(r.stdout).toContain('app started');
  });

  it('--lines is bounded to 1 to 1000', () => {
    const ok = makeKit();
    expect(ok.run(['logs', '--lines', '1000']).status).toBe(0);
    expect(ok.gcloud().find((c) => /^logging read/.test(c))).toContain('--limit=1000');
    for (const bad of ['1001', '0', '-5', 'abc', '10;ls', '']) {
      const k = makeKit();
      const r = k.run(['logs', '--lines', bad]);
      expect(r.status, bad).toBe(64);
      expect(k.gcloud(), bad).toEqual([]);
    }
  });

  it('--errors narrows the filter to errors', () => {
    const k = makeKit();
    k.run(['logs', '--errors']);
    const c = k.gcloud().find((x) => /^logging read/.test(x));
    expect(c).toContain('severity>=ERROR');
    const plain = makeKit();
    plain.run(['logs']);
    expect(plain.gcloud().find((x) => /^logging read/.test(x))).not.toContain('severity>=ERROR');
  });

  it('--dry-run prints the call and runs none', () => {
    const k = makeKit();
    const r = k.run(['logs', '--dry-run']);
    expect(r.status, r.out).toBe(0);
    expect(k.gcloud().some((c) => /^logging read/.test(c))).toBe(false);
    expect(r.out).toContain('--limit=100');
  });
});

describe('the seven verbs exist', () => {
  it('each verb is named in the usage text', () => {
    const r = makeKit().run(['--help']);
    for (const v of VERBS) expect(r.out).toContain(v);
  });
});
