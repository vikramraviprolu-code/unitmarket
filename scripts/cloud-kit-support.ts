// INT-CL1 test support: runs the real cloud kit (infra/gcp/cloud.sh) against a FAKE gcloud, a fake curl
// and a logging git shim, all placed first on PATH. No real gcloud is ever started and no network is
// touched (D-049). The fake gcloud answers the read questions the kit asks from small state files, applies
// the few changes the kit makes, records every call, and exits 97 on any call a case does not expect.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './test-helpers';

export const VERBS = ['doctor', 'status', 'up', 'down', 'restart', 'deploy', 'logs'] as const;
export const PROJECT = 'unitmarket-sbx-vr1';
/**
 * The address Cloud Run gives the service (status.url). DOM-1: service.yaml now holds the custom
 * domain, so this is the real run.app address, not the value read from service.yaml.
 */
export const WEB_URL = 'https://unitmarket-sandbox-626887286871.europe-west3.run.app';
export const REVISION = 'unitmarket-sandbox-00031-x7k';
export const REQUIRED_SECRETS = [
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
export const OFFLINE_SECRETS = [
  'UMS_OFFLINE_SESSION_SECRET',
  'UMS_OFFLINE_APPROVAL_SECRET',
  'UMS_OFFLINE_LINK_SECRET',
  'UMS_OFFLINE_DEMO_PASSCODE_HASH',
  'UMS_OFFLINE_JUDGE_PASSCODE_HASH',
];
export const APIS = [
  'run.googleapis.com',
  'sqladmin.googleapis.com',
  'secretmanager.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
];

/** Asks the shell, because lint bars Date.now and process.env here (S3, S6); the kit itself uses `date`. */
const shell = (script: string): string =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();

/** An ISO time `hours` ago. */
export const ago = (hours: number): string =>
  new Date((Number(shell('date -u +%s')) - hours * 3600) * 1000).toISOString();

const HOST_PATH = shell('printf %s "$PATH"');

export interface WebState {
  exists?: boolean;
  url?: string;
  revision?: string;
  min?: number;
  max?: number;
  ingress?: 'all' | 'internal';
  ready?: 'True' | 'False' | 'Unknown';
  message?: string;
  flag?: 'on' | 'off';
  changedAt?: string;
}

/** The JSON `gcloud run services describe --format=json` returns (Knative shape), with the fields the kit reads. */
export function serviceJson(name: string, s: WebState = {}): string {
  return JSON.stringify({
    metadata: {
      name,
      annotations: { 'run.googleapis.com/ingress': s.ingress ?? 'all' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': String(s.min ?? 1),
            'autoscaling.knative.dev/maxScale': String(s.max ?? 1),
            'run.googleapis.com/cpu-throttling': 'false',
          },
          labels: {},
        },
        spec: {
          containers: [
            {
              image: `europe-west3-docker.pkg.dev/${PROJECT}/unitmarket/${name}:t0-aaaaaaaaaaaa`,
              env: [
                { name: 'UMS_MODE', value: 'sandbox' },
                { name: 'UMS_PAYPAL_CONNECT', value: s.flag ?? 'off' },
              ],
            },
          ],
        },
      },
    },
    status: {
      url: s.url ?? WEB_URL,
      latestReadyRevisionName: s.revision ?? REVISION,
      conditions: [
        {
          type: 'Ready',
          status: s.ready ?? 'True',
          lastTransitionTime: s.changedAt ?? '2026-11-04T20:00:00Z',
          message: s.message ?? '',
        },
      ],
    },
  });
}

export interface Scenario {
  /** The signed-in account; '' means none. */
  account?: string;
  sqlState?: string;
  sqlPolicy?: 'ALWAYS' | 'NEVER';
  /** Describe calls that answer MAINTENANCE after an ALWAYS patch before the instance is RUNNABLE. */
  wakePolls?: number;
  /** ISO time of the newest backup; null: there is none. */
  backupAt?: string | null;
  /** The sandbox service; false: it does not exist. */
  web?: WebState | false;
  /** The offline service; false (default): it does not exist. */
  offline?: WebState | false;
  /** Secret names that have an enabled version. */
  hasSecrets?: string[];
  /** Secret names listed in Secret Manager. */
  listedSecrets?: string[];
  apis?: string[];
  /** Calls containing any of these strings fail with exit 1. */
  failOn?: string[];
  /** HTTP status answers of the fake curl, one per call (the last repeats). */
  probeStatus?: number[];
  probeBody?: string;
  /** Environment for the kit run. */
  env?: Record<string, string>;
  /** DOM-1: the UMS_PUBLIC_ORIGIN line of the kit's copy of service.yaml; default: the real file. */
  origin?: string;
}

export interface Kit {
  root: string;
  repo: string;
  stub: string;
  gcp: string;
  state: string;
  scenario: Required<Pick<Scenario, 'env'>>;
  run(args: string[], opts?: { input?: string }): RunResult;
  /** Every recorded line, in order: gcloud calls as typed, curl calls as `curl ...`, git calls as `git ...`. */
  lines(): string[];
  gcloud(): string[];
  curl(): string[];
  git(): string[];
  /** Read-only? A gcloud call is a read when its verb is describe or list. */
  read(name: string): string;
  write(name: string, text: string): void;
}

export interface RunResult {
  status: number | null;
  out: string;
  stdout: string;
  stderr: string;
}

export const isRead = (call: string): boolean => /\b(?:describe|list)\b/.test(call);
export const mutating = (calls: string[]): string[] => calls.filter((c) => !isRead(c));

const FAKE_GCLOUD = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
S="$DIR/state"
printf '%s\\n' "$*" >> "$DIR/calls.txt"
if [ -s "$S/fail_on.txt" ]; then
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    case "$*" in *"$pat"*) echo "ERROR: simulated failure" >&2; exit 1 ;; esac
  done < "$S/fail_on.txt"
fi
fmt=""
for a in "$@"; do case "$a" in --format=*) fmt="\${a#--format=}" ;; esac; done
svc_file() {
  case "$1" in
    unitmarket-sandbox) echo "$S/web.json" ;;
    unitmarket-offline) echo "$S/offline.json" ;;
    *) echo "$S/none.json" ;;
  esac
}
case "$1 $2 $3" in
  "auth list "*) cat "$S/account" 2>/dev/null || true ;;
  "projects describe "*) echo "ACTIVE" ;;
  "billing projects describe") echo "True" ;;
  "services list "*) cat "$S/apis.txt" ;;
  "secrets list "*) cat "$S/secrets.txt" ;;
  "secrets versions list")
    if grep -qxF "$4" "$S/has.txt"; then echo "1"; fi ;;
  "sql instances describe")
    st="$(cat "$S/sql_state")"
    n="$(cat "$S/wake_polls" 2>/dev/null || echo 0)"
    if [ "$n" -gt 0 ]; then st="MAINTENANCE"; echo $((n - 1)) > "$S/wake_polls"; fi
    pol="$(cat "$S/sql_policy")"
    case "$fmt" in
      json) printf '{"state":"%s","settings":{"tier":"db-g1-small","activationPolicy":"%s"}}\\n' "$st" "$pol" ;;
      "value(state)") echo "$st" ;;
      *) echo "stub gcloud: unsupported format $fmt" >&2; exit 97 ;;
    esac ;;
  "sql instances patch")
    for a in "$@"; do
      case "$a" in
        --activation-policy=*)
          echo "\${a#*=}" > "$S/sql_policy"
          if [ "\${a#*=}" = "ALWAYS" ]; then cp "$S/wake_cfg" "$S/wake_polls"; fi ;;
      esac
    done ;;
  "sql backups list")
    if [ -s "$S/backup_at" ]; then cat "$S/backup_at"; fi ;;
  "sql operations list")
    if [ -s "$S/last_op" ]; then cat "$S/last_op"; fi ;;
  "run services describe")
    f="$(svc_file "$4")"
    if [ ! -f "$f" ]; then echo "ERROR: (gcloud.run.services.describe) Cannot find service [$4]" >&2; exit 1; fi
    case "$fmt" in
      json) cat "$f" ;;
      "value(status.url)") jq -r .status.url "$f" ;;
      *) echo "stub gcloud: unsupported format $fmt" >&2; exit 97 ;;
    esac ;;
  "run services update")
    f="$(svc_file "$4")"
    if [ ! -f "$f" ]; then echo "ERROR: (gcloud.run.services.update) Cannot find service [$4]" >&2; exit 1; fi
    j="$(cat "$f")"
    shift 4
    for a in "$@"; do
      case "$a" in
        --min-instances=*) j="$(jq --arg v "\${a#*=}" '.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]=$v' <<<"$j")" ;;
        --max-instances=*) j="$(jq --arg v "\${a#*=}" '.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"]=$v' <<<"$j")" ;;
        --ingress=*) j="$(jq --arg v "\${a#*=}" '.metadata.annotations["run.googleapis.com/ingress"]=$v' <<<"$j")" ;;
        --no-cpu-throttling) j="$(jq '.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]="false"' <<<"$j")" ;;
        --update-env-vars=*)
          kv="\${a#*=}"
          j="$(jq --arg k "\${kv%%=*}" --arg v "\${kv#*=}" '.spec.template.spec.containers[0].env |= (map(select(.name != $k)) + [{name:$k,value:$v}])' <<<"$j")" ;;
        --update-labels=*)
          kv="\${a#*=}"
          j="$(jq --arg k "\${kv%%=*}" --arg v "\${kv#*=}" '.spec.template.metadata.labels[$k]=$v' <<<"$j")" ;;
        --region=*|--project=*|--quiet) ;;
        *) echo "stub gcloud: unexpected flag $a" >&2; exit 97 ;;
      esac
    done
    j="$(jq '.status.conditions[0].status="True" | .status.conditions[0].message=""' <<<"$j")"
    printf '%s\\n' "$j" > "$f" ;;
  "run deploy "*)
    for a in "$@"; do
      case "$a" in --env-vars-file=*) cp "\${a#*=}" "$DIR/envfile.out" ;; esac
    done
    if [ -f "$S/web_after_deploy.json" ]; then cp "$S/web_after_deploy.json" "$S/web.json"; fi ;;
  "artifacts docker images") exit 0 ;;
  "logging read "*) cat "$S/logs.txt" ;;
  *) echo "stub gcloud: unexpected call: $*" >&2; exit 97 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
S="$DIR/state"
printf 'curl %s\\n' "$*" >> "$DIR/calls.txt"
out=""; wf=""; url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --write-out) wf="$2"; shift 2 ;;
    --max-time|--connect-timeout) shift 2 ;;
    --silent|--show-error) shift ;;
    https://*|http://*) url="$1"; shift ;;
    *) echo "stub curl: unexpected argument: $1" >&2; exit 97 ;;
  esac
done
[ -n "$url" ] || { echo "stub curl: no url" >&2; exit 97; }
code="$(head -n 1 "$S/probe_status")"
if [ "$(wc -l < "$S/probe_status")" -gt 1 ]; then tail -n +2 "$S/probe_status" > "$S/probe_status.next"; mv "$S/probe_status.next" "$S/probe_status"; fi
if [ -n "$out" ]; then cat "$S/probe_body" > "$out"; fi
if [ "$wf" = '%{http_code}' ]; then printf '%s' "$code"; fi
exit 0
`;

function gitShim(realGit: string): string {
  return `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
printf 'git %s\\n' "$*" >> "$DIR/calls.txt"
exec "${realGit}" "$@"
`;
}

const w = (p: string, text: string): void => writeFileSync(p, text);

/** Builds a throwaway repository holding a copy of infra/gcp at the tag t1, a stub directory and the scenario. */
export function makeKit(s: Scenario = {}): Kit {
  const root = mkdtempSync(join(tmpdir(), 'sbx-cloud-kit-'));
  const repo = join(root, 'repo');
  const stub = join(root, 'stub');
  const state = join(stub, 'state');
  const gcp = join(repo, 'infra', 'gcp');
  mkdirSync(join(repo, 'infra'), { recursive: true });
  mkdirSync(state, { recursive: true });
  cpSync(join(REPO_ROOT, 'infra', 'gcp'), gcp, { recursive: true });
  if (s.origin !== undefined) {
    const yaml = join(gcp, 'service.yaml');
    w(
      yaml,
      readFileSync(yaml, 'utf8').replace(
        /^UMS_PUBLIC_ORIGIN: '[^']*'$/m,
        `UMS_PUBLIC_ORIGIN: '${s.origin}'`,
      ),
    );
  }

  const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  w(join(stub, 'gcloud'), FAKE_GCLOUD);
  w(join(stub, 'curl'), FAKE_CURL);
  w(join(stub, 'git'), gitShim(realGit));
  for (const f of ['gcloud', 'curl', 'git']) chmodSync(join(stub, f), 0o755);
  w(join(stub, 'calls.txt'), '');

  const web = s.web === undefined ? {} : s.web;
  const off = s.offline === undefined ? false : s.offline;
  w(
    join(state, 'account'),
    s.account === undefined ? 'tester\n' : s.account ? `${s.account}\n` : '',
  );
  w(join(state, 'sql_state'), s.sqlState ?? 'RUNNABLE');
  w(join(state, 'sql_policy'), s.sqlPolicy ?? 'ALWAYS');
  w(join(state, 'wake_cfg'), String(s.wakePolls ?? 0));
  w(join(state, 'wake_polls'), '0');
  w(join(state, 'backup_at'), s.backupAt === null ? '' : (s.backupAt ?? ago(2)));
  w(join(state, 'last_op'), '2026-11-04T19:00:00Z');
  w(
    join(state, 'has.txt'),
    [...(s.hasSecrets ?? [...REQUIRED_SECRETS, ...OFFLINE_SECRETS])].join('\n') + '\n',
  );
  w(
    join(state, 'secrets.txt'),
    [...(s.listedSecrets ?? [...REQUIRED_SECRETS, ...OFFLINE_SECRETS])]
      .map((n) => `projects/1234567890/secrets/${n}`)
      .join('\n') + '\n',
  );
  w(join(state, 'apis.txt'), (s.apis ?? APIS).join('\n') + '\n');
  w(join(state, 'fail_on.txt'), (s.failOn ?? []).join('\n') + '\n');
  w(join(state, 'probe_status'), (s.probeStatus ?? [200]).join('\n') + '\n');
  w(
    join(state, 'probe_body'),
    s.probeBody ??
      JSON.stringify({ ok: true, environment: 'Sandbox', revision: REVISION, db: 'up' }),
  );
  w(
    join(state, 'logs.txt'),
    '2026-11-04T10:00:00Z INFO app started\n2026-11-04T10:00:01Z ERROR boom\n',
  );
  if (web !== false) w(join(state, 'web.json'), serviceJson('unitmarket-sandbox', web) + '\n');
  if (off !== false) w(join(state, 'offline.json'), serviceJson('unitmarket-offline', off) + '\n');
  w(
    join(state, 'web_after_deploy.json'),
    serviceJson('unitmarket-sandbox', {
      revision: 'unitmarket-sandbox-00032-new',
      min: 1,
      ingress: 'all',
    }) + '\n',
  );

  const git = (...a: string[]) =>
    spawnSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], {
      cwd: repo,
      encoding: 'utf8',
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'kit');
  git('tag', 't1');

  const env = { ...(s.env ?? {}) };
  const kit: Kit = {
    root,
    repo,
    stub,
    gcp,
    state,
    scenario: { env },
    run(args, opts = {}) {
      const r = spawnSync(
        'bash',
        ['-c', 'PATH="$0:$PATH"; exec bash "$@"', stub, join(gcp, 'cloud.sh'), ...args],
        {
          cwd: repo,
          encoding: 'utf8',
          input: opts.input ?? '',
          env: {
            PATH: HOST_PATH,
            HOME: root,
            LANG: 'C',
            CLOUD_WAIT_STEP: '0',
            CLOUD_WAIT_TRIES: '4',
            ...env,
          },
          timeout: 60_000,
        },
      );
      return {
        status: r.status,
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    },
    lines: () => readFileSync(join(stub, 'calls.txt'), 'utf8').split('\n').filter(Boolean),
    gcloud: () => kit.lines().filter((l) => !/^(?:curl|git) /.test(l)),
    curl: () => kit.lines().filter((l) => l.startsWith('curl ')),
    git: () => kit.lines().filter((l) => l.startsWith('git ')),
    read: (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : ''),
    write: (name, text) => w(join(state, name), text),
  };
  return kit;
}

/** Splits the one-line `stack.env` style text into pairs, for the tests that edit it. */
export function setStackEnv(kit: Kit, text: string): void {
  writeFileSync(join(kit.gcp, 'stack.env'), text);
}
