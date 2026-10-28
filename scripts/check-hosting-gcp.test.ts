import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, materialize, runGuard } from './test-helpers';

// GCP-1: the guard for the Google Cloud deployment kit (infra/gcp). Every refusal case below is the
// clean kit (scripts/__fixtures__/hosting-gcp/good) with exactly one unsafe change. The guard must
// exit 1 and name the rule; it must never print a value from the files.
const GUARD = 'check-hosting-gcp.mjs';
const KIT = [
  'Dockerfile',
  'deploy.sh',
  'monitoring.sh',
  'service.yaml',
  'set-secret.sh',
  'setup.sh',
];
const SCRIPTS = KIT.filter((f) => f.endsWith('.sh'));

// Forbidden strings are assembled at run time so this file holds none of them.
const PUB = 'NEXT_' + 'PUBLIC';
const LIVE_HOST = 'api-m.' + 'paypal.com';
const SANDBOX_HOST = 'api-m.sandbox.' + 'paypal.com';
const GOOGLE_KEY = 'AIza' + 'Sy' + 'A'.repeat(33);
const PEM = '-----BEGIN ' + 'PRIVATE KEY-----';
const HEX_TOKEN = '3f9a' + 'c27d41'.repeat(6);
// GCP-2: the base image digest taken from the real Cloud Build log of 27 Oct.
const BASE_DIGEST = 'dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
const SECRET_NAMES = [
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

function readKit(dir: string, file: string): string {
  return readFileSync(join(dir, 'infra', 'gcp', file), 'utf8');
}

/** The clean kit with one edit: `find` (first occurrence) becomes `replace`. */
function mutate(file: string, find: string, replace: string): string {
  const dir = materialize('hosting-gcp/good');
  const text = readKit(dir, file);
  expect(text, `the clean kit's ${file} must contain: ${find}`).toContain(find);
  writeFileSync(
    join(dir, 'infra', 'gcp', file),
    text.replace(find, () => replace),
  );
  return dir;
}

type Case = [name: string, file: string, find: string, replace: string, rule: string];

// find '' means: append `replace` as a new last line.
const CASES: Case[] = [
  // the connection stays off
  [
    'connect on in service.yaml',
    'service.yaml',
    "UMS_PAYPAL_CONNECT: 'off'",
    "UMS_PAYPAL_CONNECT: 'on'",
    'paypal-connect',
  ],
  [
    'connect on, double quotes',
    'service.yaml',
    "UMS_PAYPAL_CONNECT: 'off'",
    'UMS_PAYPAL_CONNECT: "on"',
    'paypal-connect',
  ],
  [
    'connect set in a script',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --update-env-vars=UMS_PAYPAL_CONNECT=on \\\n',
    'paypal-connect',
  ],
  ['connect missing', 'service.yaml', "UMS_PAYPAL_CONNECT: 'off'\n", '', 'paypal-connect'],
  [
    'env flags bypass the file',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --set-env-vars=FOO=bar \\\n',
    'env-flags',
  ],
  [
    'env file not used',
    'deploy.sh',
    '--env-vars-file="${HERE}/service.yaml"',
    '--labels=kit=gcp',
    'env-file',
  ],
  // the database
  [
    'database not postgres',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'pglite-disk'",
    'db-kind',
  ],
  ['database missing', 'service.yaml', "UMS_DB: 'postgres'\n", '', 'db-kind'],
  [
    'database set in a script',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --set-env-vars=UMS_DB=pglite-memory \\\n',
    'db-kind',
  ],
  // exactly one instance, always on
  ['max instances 2', 'deploy.sh', '--max-instances=1', '--max-instances=2', 'max-instances'],
  ['max instances missing', 'deploy.sh', '  --max-instances=1 \\\n', '', 'max-instances'],
  [
    'max instances twice',
    'deploy.sh',
    '  --max-instances=1 \\\n',
    '  --max-instances=1 \\\n  --max-instances=1 \\\n',
    'max-instances',
  ],
  [
    'max instances in another script',
    'setup.sh',
    'echo "== billing"',
    'gcloud run services update x --max-instances=1\necho "== billing"',
    'max-instances',
  ],
  ['min instances 0', 'deploy.sh', '--min-instances=1', '--min-instances=0', 'min-instances'],
  ['min instances missing', 'deploy.sh', '  --min-instances=1 \\\n', '', 'min-instances'],
  ['cpu throttling missing', 'deploy.sh', '  --no-cpu-throttling \\\n', '', 'cpu-throttling'],
  ['cpu throttling on', 'deploy.sh', '--no-cpu-throttling', '--cpu-throttling', 'cpu-throttling'],
  ['memory too small', 'deploy.sh', '--memory=2Gi', '--memory=512Mi', 'resources'],
  ['concurrency too high', 'deploy.sh', '--concurrency=20', '--concurrency=200', 'resources'],
  ['startup probe not on healthz', 'deploy.sh', 'httpGet.path=/healthz', 'httpGet.path=/', 'probe'],
  [
    'startup probe missing',
    'deploy.sh',
    '  --startup-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=5,timeoutSeconds=5,periodSeconds=5,failureThreshold=24\n',
    '\n',
    'probe',
  ],
  // ingress and who may call
  ['ingress internal', 'deploy.sh', '--ingress=all', '--ingress=internal', 'ingress'],
  [
    'unauthenticated missing on the app',
    'deploy.sh',
    '  --allow-unauthenticated \\\n',
    '',
    'unauthenticated',
  ],
  [
    'unauthenticated on another command',
    'monitoring.sh',
    'echo "== APIs"',
    'gcloud run services update other --allow-unauthenticated\necho "== APIs"',
    'unauthenticated',
  ],
  [
    'allUsers binding',
    'setup.sh',
    'echo "== billing"',
    'gcloud run services add-iam-policy-binding other --member=allUsers --role=roles/run.invoker\necho "== billing"',
    'unauthenticated',
  ],
  // no auto deploy
  [
    'build trigger',
    'deploy.sh',
    'SECRET_FLAGS=""',
    'gcloud builds triggers create github --repo-name=x\nSECRET_FLAGS=""',
    'auto-deploy',
  ],
  [
    'deploy from source',
    'deploy.sh',
    '  --image="$IMAGE" \\\n',
    '  --source=. \\\n',
    'auto-deploy',
  ],
  // names that must never appear
  [
    'NODE_OPTIONS in service.yaml',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nNODE_OPTIONS: '--max-old-space-size=1536'",
    'forbidden-name',
  ],
  [
    'NODE_OPTIONS in Dockerfile',
    'Dockerfile',
    'EXPOSE 8080',
    'ENV NODE_OPTIONS=--max-old-space-size=1536\nEXPOSE 8080',
    'forbidden-name',
  ],
  [
    'proxy variable',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nHTTPS_PROXY: 'x'",
    'forbidden-name',
  ],
  [
    'proxy variable lower case',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nhttp_proxy: 'x'",
    'forbidden-name',
  ],
  [
    'CA variable',
    'Dockerfile',
    'EXPOSE 8080',
    'ENV NODE_EXTRA_CA_CERTS=/etc/x.pem\nEXPOSE 8080',
    'forbidden-name',
  ],
  [
    'TLS verification off',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nNODE_TLS_REJECT_UNAUTHORIZED: '0'",
    'forbidden-name',
  ],
  [
    'maintenance flag',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nUMS_MAINTENANCE_FLAG: '/tmp/ums-maintenance'",
    'forbidden-name',
  ],
  [
    'learn window variable',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nUMS_WEBHOOK_CERT_LEARN_UNTIL: '2026-10-26T18:00:00Z'",
    'forbidden-name',
  ],
  // hosts
  [
    'live PayPal host',
    'service.yaml',
    "UMS_DB: 'postgres'",
    `# talks to https://${LIVE_HOST}/v1\nUMS_DB: 'postgres'`,
    'paypal-host',
  ],
  [
    'sandbox PayPal host',
    'deploy.sh',
    'SECRET_FLAGS=""',
    `# ${SANDBOX_HOST}\nSECRET_FLAGS=""`,
    'paypal-host',
  ],
  [
    'PayPal host in the Dockerfile',
    'Dockerfile',
    'EXPOSE 8080',
    `ENV X=${LIVE_HOST.toUpperCase()}\nEXPOSE 8080`,
    'paypal-host',
  ],
  ['live word in a value', 'service.yaml', "UMS_MODE: 'sandbox'", "UMS_MODE: 'live'", 'live-value'],
  [
    'production word outside NODE_ENV',
    'monitoring.sh',
    'echo "== APIs"',
    'echo "production"\necho "== APIs"',
    'live-value',
  ],
  // bytes
  ['non-ASCII byte', 'monitoring.sh', 'echo "== APIs"', '# café\necho "== APIs"', 'bytes'],
  ['carriage return', 'service.yaml', "UMS_DB: 'postgres'\n", "UMS_DB: 'postgres'\r\n", 'bytes'],
  ['tab character', 'setup.sh', 'echo "== billing"', '\techo "== billing"', 'bytes'],
  ['BOM', 'service.yaml', '# Fixed,', '﻿# Fixed,', 'bytes'],
  ['NEL character', 'setup.sh', 'echo "== billing"', '# a\u0085b\necho "== billing"', 'bytes'],
  // strict mode and safety of scripts
  ...SCRIPTS.map((s): Case => [
    `${s} without strict mode`,
    s,
    'set -euo pipefail',
    'set -eu',
    'strict-mode',
  ]),
  [
    'strict mode switched off later',
    'setup.sh',
    'echo "== billing"',
    'set +e\necho "== billing"',
    'strict-mode',
  ],
  ['trace on', 'setup.sh', 'echo "== billing"', 'set -x\necho "== billing"', 'print-secret'],
  [
    'echo of the password',
    'setup.sh',
    'unset DB_PASSWORD\n',
    'echo "pw $DB_PASSWORD"\nunset DB_PASSWORD\n',
    'print-secret',
  ],
  [
    'echo of the typed value',
    'set-secret.sh',
    'unset VALUE\n',
    'echo "$VALUE"\nunset VALUE\n',
    'print-secret',
  ],
  [
    'read a secret back',
    'set-secret.sh',
    'echo "stored:',
    'gcloud secrets versions access latest --secret="$NAME" --project="$PROJECT_ID"\necho "stored:',
    'secret-read',
  ],
  [
    'no account guard',
    'deploy.sh',
    'ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format=\'value(account)\' 2>/dev/null || true)"\n',
    '',
    'account-guard',
  ],
  [
    'account guard does not stop',
    'monitoring.sh',
    '[ -n "$ACTIVE_ACCOUNT" ] || die',
    'true || die',
    'account-guard',
  ],
  [
    'login inside a script',
    'setup.sh',
    'echo "== billing"',
    'gcloud auth login\necho "== billing"',
    'login',
  ],
  [
    'no terminal check',
    'set-secret.sh',
    '[ -t 0 ] && [ -t 2 ] || die',
    'true || die',
    'terminal-check',
  ],
  [
    'visible prompt',
    'set-secret.sh',
    'read -r -s -p "Value for',
    'read -r -p "Value for',
    'terminal-check',
  ],
  [
    'project id literal',
    'setup.sh',
    '--location="$REGION" \\\n    --description',
    '--location="$REGION" \\\n    --project=real-looking-project \\\n    --description',
    'literal-project',
  ],
  [
    'region literal',
    'deploy.sh',
    '  --region="$REGION" \\\n',
    '  --region=europe-west1 \\\n',
    'literal-project',
  ],
  [
    'project set globally',
    'setup.sh',
    'echo "== billing"',
    'gcloud config set project some-project\necho "== billing"',
    'literal-project',
  ],
  [
    'e-mail address literal',
    'monitoring.sh',
    'echo "== APIs"',
    '# mail owner@example.org\necho "== APIs"',
    'literal-value',
  ],
  [
    'run.app host literal in a script',
    'deploy.sh',
    'SECRET_FLAGS=""',
    'URL_NOTE=unitmarket-sandbox-123456789.europe-west1.run.app\nSECRET_FLAGS=""',
    'literal-value',
  ],
  // secrets
  ...SECRET_NAMES.slice(0, 3).map((n): Case => [
    `${n} given a value in service.yaml`,
    'service.yaml',
    "UMS_DB: 'postgres'",
    `UMS_DB: 'postgres'\n${n}: 'x'`,
    'secret-in-env',
  ]),
  [
    'secret name set as env var',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --update-env-vars=UMS_SESSION_SECRET=abc \\\n',
    'secret-in-env',
  ],
  [
    'Google API key literal',
    'deploy.sh',
    'SECRET_FLAGS=""',
    `KEY_NOTE=${GOOGLE_KEY}\nSECRET_FLAGS=""`,
    'secret-literal',
  ],
  [
    'private key header',
    'service.yaml',
    "UMS_DB: 'postgres'",
    `# ${PEM}\nUMS_DB: 'postgres'`,
    'secret-literal',
  ],
  [
    'long hex token',
    'setup.sh',
    'echo "== billing"',
    `TOKEN_NOTE=${HEX_TOKEN}\necho "== billing"`,
    'secret-literal',
  ],
  [
    'database URL with a password',
    'setup.sh',
    'echo "== billing"',
    'URL_NOTE=postgres://ums_app:hunter2@/db\necho "== billing"',
    'secret-literal',
  ],
  [
    'database URL secret listed in service.yaml',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nDATABASE_URL: 'x'",
    'secret-in-env',
  ],
  [
    'set-secret allows the public origin',
    'set-secret.sh',
    'PAYPAL_CLIENT_ID | ',
    'UMS_PUBLIC_ORIGIN | PAYPAL_CLIENT_ID | ',
    'secret-names',
  ],
  [
    'set-secret allows DATABASE_URL',
    'set-secret.sh',
    'PAYPAL_CLIENT_ID | ',
    'DATABASE_URL | PAYPAL_CLIENT_ID | ',
    'secret-names',
  ],
  ['set-secret drops a name', 'set-secret.sh', ' | UMS_OPERATOR_TOTP_KEYS)', ')', 'secret-names'],
  ['deploy secret list drops a name', 'deploy.sh', ' UMS_OPERATOR_TOTP_KEYS"', '"', 'secret-names'],
  [
    'setup secret list adds a name',
    'setup.sh',
    ' UMS_OPERATOR_TOTP_KEYS"',
    ' UMS_OPERATOR_TOTP_KEYS UMS_PUBLIC_ORIGIN"',
    'secret-names',
  ],
  // service.yaml values and names
  ['mode offline', 'service.yaml', "UMS_MODE: 'sandbox'", "UMS_MODE: 'offline'", 'fixed-value'],
  [
    'proxies 2',
    'service.yaml',
    "UMS_TRUSTED_PROXIES: '1'",
    "UMS_TRUSTED_PROXIES: '2'",
    'fixed-value',
  ],
  [
    'proxies 0',
    'service.yaml',
    "UMS_TRUSTED_PROXIES: '1'",
    "UMS_TRUSTED_PROXIES: '0'",
    'fixed-value',
  ],
  [
    'scope changed',
    'service.yaml',
    "UMS_OUTBOUND_SCOPE: 'mvp_c_refunds'",
    "UMS_OUTBOUND_SCOPE: 'mvp_b_polling'",
    'fixed-value',
  ],
  [
    'node env changed',
    'service.yaml',
    "NODE_ENV: 'production'",
    "NODE_ENV: 'development'",
    'fixed-value',
  ],
  [
    'telemetry changed',
    'service.yaml',
    "NEXT_TELEMETRY_DISABLED: '1'",
    "NEXT_TELEMETRY_DISABLED: '0'",
    'fixed-value',
  ],
  ['fixed value missing', 'service.yaml', "UMS_MODE: 'sandbox'\n", '', 'fixed-value'],
  [
    'label changed',
    'service.yaml',
    `${PUB}_UMS_ENV_LABEL: 'Sandbox'`,
    `${PUB}_UMS_ENV_LABEL: 'Dry run'`,
    'fixed-value',
  ],
  [
    'unknown name',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nSOME_OTHER_NAME: 'x'",
    'unknown-name',
  ],
  [
    'public name',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nNEXT_PUBLIC_API_TOKEN: 'x'",
    'public-name',
  ],
  ['unquoted value', 'service.yaml', "UMS_DB: 'postgres'", 'UMS_DB: postgres', 'value-type'],
  [
    'bare number',
    'service.yaml',
    "NEXT_TELEMETRY_DISABLED: '1'",
    'NEXT_TELEMETRY_DISABLED: 1',
    'value-type',
  ],
  [
    'trailing comment on a value',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres' # ok",
    'value-type',
  ],
  [
    'duplicate key',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nUMS_DB: 'postgres'",
    'duplicate-key',
  ],
  [
    'origin over plain http',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-sandbox-626887286871.europe-west3.run.app'",
    "UMS_PUBLIC_ORIGIN: 'http://localhost:3000'",
    'origin',
  ],
  [
    'origin on another host',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-sandbox-626887286871.europe-west3.run.app'",
    "UMS_PUBLIC_ORIGIN: 'https://shop.example.test'",
    'origin',
  ],
  [
    'origin with a path',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-sandbox-626887286871.europe-west3.run.app'",
    "UMS_PUBLIC_ORIGIN: 'https://svc-1.europe-west1.run.app/x'",
    'origin',
  ],
  [
    'origin missing',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-sandbox-626887286871.europe-west3.run.app'\n",
    '',
    'origin',
  ],
  // the image
  [
    'image base not Node 22.22.0',
    'Dockerfile',
    `FROM node:22.22.0-bookworm-slim@sha256:${BASE_DIGEST} AS build`,
    `FROM node:20-bookworm-slim@sha256:${BASE_DIGEST} AS build`,
    'docker-node',
  ],
  [
    'final stage not Node 22.22.0',
    'Dockerfile',
    `FROM node:22.22.0-bookworm-slim@sha256:${BASE_DIGEST}\nENV`,
    'FROM node:latest\nENV',
    'docker-node',
  ],
  ['runs as root', 'Dockerfile', 'USER node\n', '', 'docker-user'],
  ['explicit root', 'Dockerfile', 'USER node\n', 'USER root\n', 'docker-user'],
  ['uid zero', 'Dockerfile', 'USER node\n', 'USER 0\n', 'docker-user'],
  [
    'start command changed',
    'Dockerfile',
    '"@umsbx/web", "start"',
    '"@umsbx/web", "dev"',
    'docker-cmd',
  ],
  [
    'start command missing',
    'Dockerfile',
    'CMD ["corepack", "pnpm", "--filter", "@umsbx/web", "start"]\n',
    '',
    'docker-cmd',
  ],
  [
    'env file copied',
    'Dockerfile',
    'WORKDIR /app\nCOPY . .',
    'WORKDIR /app\nCOPY .env.local ./\nCOPY . .',
    'docker-env',
  ],
  [
    'remote ADD',
    'Dockerfile',
    'EXPOSE 8080',
    'ADD https://example.test/x.tgz /tmp/\nEXPOSE 8080',
    'docker-env',
  ],
  // files of the kit
  ['setup.sh removed', 'setup.sh', '', '', 'kit-files'],
];

// GCP-2: refusals found by the GCP-1 review. Same shape as CASES: one line of the clean kit changes.
const BIND = '  --role="roles/cloudsql.client"';
const CREATE_END = '    --ssl-mode=ENCRYPTED_ONLY \\\n';
const GCP2_CASES: Case[] = [
  // the database instance keeps no network exposure
  [
    'authorized networks with a value',
    'setup.sh',
    CREATE_END,
    `${CREATE_END}    --authorized-networks=203.0.113.0/24 \\\n`,
    'sql-network',
  ],
  [
    'authorized networks without a value',
    'setup.sh',
    CREATE_END,
    `${CREATE_END}    --authorized-networks= \\\n`,
    'sql-network',
  ],
  [
    'authorized networks added later',
    'setup.sh',
    'echo "== database $SQL_DB"',
    'gcloud sql instances patch "$SQL_INSTANCE" --authorized-networks=203.0.113.7/32 --project="$PROJECT_ID"\necho "== database $SQL_DB"',
    'sql-network',
  ],
  // deletion protection, backups, point in time recovery
  [
    'deletion protection off at creation',
    'setup.sh',
    '    --deletion-protection \\\n',
    '    --no-deletion-protection \\\n',
    'sql-protection',
  ],
  [
    'deletion protection removed',
    'setup.sh',
    '    --deletion-protection \\\n',
    '',
    'sql-protection',
  ],
  [
    'deletion protection switched off later',
    'setup.sh',
    'echo "== database $SQL_DB"',
    'gcloud sql instances patch "$SQL_INSTANCE" --no-deletion-protection --project="$PROJECT_ID"\necho "== database $SQL_DB"',
    'sql-protection',
  ],
  ['backups off', 'setup.sh', '    --backup \\\n', '    --no-backup \\\n', 'sql-protection'],
  ['backups removed', 'setup.sh', '    --backup \\\n', '', 'sql-protection'],
  [
    'point in time recovery switched off',
    'setup.sh',
    '    --enable-point-in-time-recovery \\\n',
    '    --no-enable-point-in-time-recovery \\\n',
    'sql-protection',
  ],
  [
    'point in time recovery removed',
    'setup.sh',
    '    --enable-point-in-time-recovery \\\n',
    '',
    'sql-protection',
  ],
  // encrypted connections only, through the connector only
  [
    'ssl mode allows unencrypted',
    'setup.sh',
    '--ssl-mode=ENCRYPTED_ONLY',
    '--ssl-mode=ALLOW_UNENCRYPTED_AND_ENCRYPTED',
    'sql-ssl',
  ],
  [
    'ssl mode other value, space form',
    'setup.sh',
    '--ssl-mode=ENCRYPTED_ONLY',
    '--ssl-mode TRUSTED_CLIENT_CERTIFICATE_REQUIRED',
    'sql-ssl',
  ],
  ['ssl mode removed', 'setup.sh', CREATE_END, '', 'sql-ssl'],
  [
    'connector enforcement not required',
    'setup.sh',
    '--connector-enforcement=REQUIRED',
    '--connector-enforcement=NOT_REQUIRED',
    'sql-connector',
  ],
  [
    'connector enforcement removed',
    'setup.sh',
    '    --connector-enforcement=REQUIRED \\\n',
    '',
    'sql-connector',
  ],
  // storage cannot grow without a limit
  [
    'storage limit removed',
    'setup.sh',
    '    --storage-auto-increase-limit=30 \\\n',
    '',
    'sql-storage',
  ],
  [
    'storage limit zero (unlimited)',
    'setup.sh',
    '--storage-auto-increase-limit=30',
    '--storage-auto-increase-limit=0',
    'sql-storage',
  ],
  [
    'storage limit very large',
    'setup.sh',
    '--storage-auto-increase-limit=30',
    '--storage-auto-increase-limit=5000',
    'sql-storage',
  ],
  // IAM: the runtime account stays small
  ['runtime account is owner', 'setup.sh', BIND, '  --role="roles/owner"', 'iam-role'],
  ['runtime account is editor', 'setup.sh', BIND, '  --role="roles/editor"', 'iam-role'],
  [
    'secret accessor bound on the project',
    'setup.sh',
    BIND,
    '  --role="roles/secretmanager.secretAccessor"',
    'iam-role',
  ],
  [
    'secret admin bound on the project',
    'setup.sh',
    BIND,
    '  --role="roles/secretmanager.admin"',
    'iam-role',
  ],
  ['another role bound on the project', 'setup.sh', BIND, '  --role="roles/run.admin"', 'iam-role'],
  [
    'secret admin bound on one secret',
    'setup.sh',
    '--role="roles/secretmanager.secretAccessor"',
    '--role="roles/secretmanager.admin"',
    'iam-role',
  ],
  // scaling stays at the pinned instance flags
  [
    'scaling flag',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --scaling=5 \\\n',
    'scaling',
  ],
  [
    'service level max',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --max=5 \\\n',
    'scaling',
  ],
  [
    'service level min, space form',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --min 0 \\\n',
    'scaling',
  ],
  [
    'update-scaling command',
    'setup.sh',
    'echo "== billing"',
    'gcloud run services update-scaling x --max-instances=1\necho "== billing"',
    'scaling',
  ],
  [
    'max instances 2, space form',
    'deploy.sh',
    '--max-instances=1',
    '--max-instances 2',
    'max-instances',
  ],
  [
    'min instances 0, space form',
    'deploy.sh',
    '--min-instances=1',
    '--min-instances 0',
    'min-instances',
  ],
  // one environment file
  [
    'second env vars file',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --env-vars-file=/tmp/extra.yaml \\\n',
    'env-file',
  ],
  [
    'second env vars file, space form',
    'deploy.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --env-vars-file /tmp/extra.yaml \\\n',
    'env-file',
  ],
  // nothing may copy, trace or dump a secret value
  [
    'tee on the secret value',
    'set-secret.sh',
    'RESULT="$(printf \'%s\' "$VALUE" | gcloud',
    'RESULT="$(printf \'%s\' "$VALUE" | tee /tmp/v | gcloud',
    'print-secret',
  ],
  [
    'tee in setup.sh',
    'setup.sh',
    'unset DB_PASSWORD',
    'true | tee /tmp/p >/dev/null\n  unset DB_PASSWORD',
    'print-secret',
  ],
  [
    'declare -p',
    'set-secret.sh',
    'unset CONFIRM',
    'declare -p VALUE\nunset CONFIRM',
    'print-secret',
  ],
  [
    'set -x in the middle of a statement',
    'set-secret.sh',
    'unset CONFIRM',
    'true && set -x\nunset CONFIRM',
    'print-secret',
  ],
  [
    'set -x after a semicolon in setup.sh',
    'setup.sh',
    'unset DB_PASSWORD',
    'true; set -x\n  unset DB_PASSWORD',
    'print-secret',
  ],
  [
    'xtrace through shopt',
    'set-secret.sh',
    'unset CONFIRM',
    'shopt -o -s xtrace\nunset CONFIRM',
    'print-secret',
  ],
  [
    'printenv',
    'set-secret.sh',
    'unset CONFIRM',
    'printenv >/dev/null\nunset CONFIRM',
    'print-secret',
  ],
  // the typed value is kept as typed
  [
    'first read without IFS=',
    'set-secret.sh',
    'IFS= read -r -s -p "Value',
    'read -r -s -p "Value',
    'read-ifs',
  ],
  [
    'second read without IFS=',
    'set-secret.sh',
    'IFS= read -r -s -p "Type',
    'read -r -s -p "Type',
    'read-ifs',
  ],
  [
    'read without -r',
    'set-secret.sh',
    'IFS= read -r -s -p "Type',
    'IFS= read -s -p "Type',
    'read-ifs',
  ],
  // the image is tagged by commit and built from a pinned base
  [
    'image tag without the commit',
    'deploy.sh',
    '${SERVICE}:${TAG}-${COMMIT}"',
    '${SERVICE}:${TAG}"',
    'image-tag',
  ],
  [
    'image tag latest',
    'deploy.sh',
    '${SERVICE}:${TAG}-${COMMIT}"',
    '${SERVICE}:latest"',
    'image-tag',
  ],
  [
    'build stage not pinned by digest',
    'Dockerfile',
    `@sha256:${BASE_DIGEST} AS build`,
    ' AS build',
    'docker-node',
  ],
  [
    'final stage not pinned by digest',
    'Dockerfile',
    `@sha256:${BASE_DIGEST}\nENV`,
    '\nENV',
    'docker-node',
  ],
  [
    'digest too short',
    'Dockerfile',
    `@sha256:${BASE_DIGEST} AS build`,
    '@sha256:dd9d2197 AS build',
    'docker-node',
  ],
  [
    'digest-shaped token outside FROM',
    'Dockerfile',
    'EXPOSE 8080',
    `ENV BASE_NOTE=sha256:${BASE_DIGEST}\nEXPOSE 8080`,
    'secret-literal',
  ],
  [
    'final stage without WORKDIR /app',
    'Dockerfile',
    'WORKDIR /app\nCOPY --from=build --chown',
    'COPY --from=build --chown',
    'docker-workdir',
  ],
  [
    'build stage WORKDIR changed',
    'Dockerfile',
    'WORKDIR /app\nCOPY . .',
    'WORKDIR /srv\nCOPY . .',
    'docker-workdir',
  ],
  // service.yaml: a double-quoted wrong value is still wrong
  [
    'database not postgres, double quotes',
    'service.yaml',
    "UMS_DB: 'postgres'",
    'UMS_DB: "pglite-disk"',
    'db-kind',
  ],
  ['mismatched quotes', 'service.yaml', "UMS_DB: 'postgres'", 'UMS_DB: \'postgres"', 'value-type'],
];

// Legal formatting the guard must accept (it was refused before GCP-2): one edit, still ok.
const ACCEPTED: [name: string, file: string, find: string, replace: string][] = [
  ['--max-instances 1 with a space', 'deploy.sh', '--max-instances=1', '--max-instances 1'],
  ['--min-instances 1 with a space', 'deploy.sh', '--min-instances=1', '--min-instances 1'],
  ['UMS_DB in double quotes', 'service.yaml', "UMS_DB: 'postgres'", 'UMS_DB: "postgres"'],
];

describe('check-hosting-gcp', () => {
  it('passes on the good fixture', () => {
    const r = runGuard(GUARD, materialize('hosting-gcp/good'));
    expect(r.out).toContain('hosting-gcp ok');
    expect(r.status).toBe(0);
  });

  it('passes on the real kit (infra/gcp)', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('hosting-gcp ok');
    expect(r.status).toBe(0);
  });

  it('the good fixture is the real kit, byte for byte', () => {
    const dir = materialize('hosting-gcp/good');
    for (const f of KIT) {
      expect(readKit(dir, f), f).toBe(readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8'));
    }
  });

  it('has at least 10 distinct refusal rules and no duplicate case', () => {
    expect(new Set(CASES.map((c) => c[4])).size).toBeGreaterThanOrEqual(10);
    expect(new Set(CASES.map((c) => c[0])).size).toBe(CASES.length);
  });

  it.each(CASES)('refuses: %s', (_name, file, find, replace, rule) => {
    let dir: string;
    if (_name === 'setup.sh removed') {
      dir = materialize('hosting-gcp/good');
      rmSync(join(dir, 'infra', 'gcp', file));
    } else {
      dir = mutate(file, find, replace);
    }
    const r = runGuard(GUARD, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hosting-gcp: FAIL ${rule}`);
    expect(r.out).not.toContain('hosting-gcp ok');
  });

  it('GCP-2: has no duplicate case name', () => {
    const names = [...CASES, ...GCP2_CASES].map((c) => c[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(GCP2_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(GCP2_CASES)('GCP-2 refuses: %s', (_name, file, find, replace, rule) => {
    const r = runGuard(GUARD, mutate(file, find, replace));
    expect(r.status).toBe(1);
    expect(r.out).toContain(`hosting-gcp: FAIL ${rule}`);
    expect(r.out).not.toContain('hosting-gcp ok');
  });

  it.each(ACCEPTED)('GCP-2 accepts: %s', (_name, file, find, replace) => {
    const r = runGuard(GUARD, mutate(file, find, replace));
    expect(r.out).toContain('hosting-gcp ok');
    expect(r.status).toBe(0);
  });

  it('GCP-2: the real kit carries the hardening settings', () => {
    const read = (f: string) => readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
    const setup = read('setup.sh');
    for (const flag of [
      'gcloud beta sql instances create',
      '--connector-enforcement=REQUIRED',
      '--storage-auto-increase-limit=30',
      '--ssl-mode=ENCRYPTED_ONLY',
      '--deletion-protection',
      '--enable-point-in-time-recovery',
    ])
      expect(setup, flag).toContain(flag);
    expect(setup).not.toMatch(/^[^#\n]*--authorized-networks/m);
    expect(read('set-secret.sh')).toContain(
      'IFS= read -r -s -p "Value for $NAME (hidden): " VALUE',
    );
    expect(read('set-secret.sh')).toContain(
      'IFS= read -r -s -p "Type it again (hidden): " CONFIRM',
    );
    expect(read('deploy.sh')).toContain('${SERVICE}:${TAG}-${COMMIT}"');
    const docker = read('Dockerfile');
    const from = docker.split('\n').filter((l) => l.startsWith('FROM '));
    expect(from).toHaveLength(2);
    for (const l of from) expect(l).toContain(`node:22.22.0-bookworm-slim@sha256:${BASE_DIGEST}`);
    expect(docker).not.toContain('copies only the build output');
  });

  it('GCP-2: the owner steps carry the facts of the first real deploy', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'owner', 'MVPC-OWNER-STEPS-GCP.md'), 'utf8');
    for (const text of [
      // (a) reading logs
      "gcloud logging read '",
      'jsonPayload.msg=~"webhook"',
      "--format='json(timestamp,jsonPayload)'",
      'shows blank lines for our JSON logs',
      // (b) the learn window
      'one real purchase',
      'unsigned mock events',
      '7 of the 8 events',
      // (c) the proxy value is dropped
      'unset DATABASE_URL',
      // (d) warnings
      'Never run `delete` or `--no-deletion-protection` on `unitmarket-sbx-pg`',
      'deletes all data after 30 days',
      'does not cap spending',
      'disable the old versions',
      // (e) order of Step I item 5
      'is repeated after Step J',
      // (f) rebuild after a pull
      'corepack pnpm --filter @umsbx/web build',
      // (g) /healthz
      'Google reserves `/healthz` on `run.app` addresses',
    ])
      expect(doc, text).toContain(text);
    // (h) ten secrets to set, eleven names in Secret Manager
    expect(doc).toContain('Ten names.');
    expect(doc).toContain('Expected: eleven names');
  });

  it('refuses an extra file in the kit', () => {
    const dir = materialize('hosting-gcp/good');
    writeFileSync(
      join(dir, 'infra', 'gcp', 'extra.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\n',
    );
    const r = runGuard(GUARD, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('hosting-gcp: FAIL kit-files');
  });

  it('refuses when infra/gcp is missing', () => {
    const dir = materialize('hosting-gcp/good');
    rmSync(join(dir, 'infra'), { recursive: true });
    const r = runGuard(GUARD, dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('hosting-gcp: FAIL kit-files');
  });

  it('never prints a value from the files', () => {
    const dir = mutate('deploy.sh', 'SECRET_FLAGS=""', `KEY_NOTE=${GOOGLE_KEY}\nSECRET_FLAGS=""`);
    const r = runGuard(GUARD, dir);
    expect(r.out).toContain('hosting-gcp: FAIL secret-literal');
    expect(r.out).not.toContain(GOOGLE_KEY);
    const dir2 = mutate(
      'service.yaml',
      "UMS_DB: 'postgres'",
      "UMS_DB: 'postgres'\nPAYPAL_CLIENT_SECRET: 'value-0042-not-real'",
    );
    const r2 = runGuard(GUARD, dir2);
    expect(r2.out).toContain('PAYPAL_CLIENT_SECRET');
    expect(r2.out).not.toContain('value-0042-not-real');
  });

  it('every script in the real kit starts with a shebang and set -euo pipefail', () => {
    for (const s of SCRIPTS) {
      const text = readFileSync(join(REPO_ROOT, 'infra', 'gcp', s), 'utf8');
      expect(text.startsWith('#!/usr/bin/env bash\n'), s).toBe(true);
      expect(text, s).toMatch(/^set -euo pipefail$/m);
    }
  });

  it('the real kit files are printable ASCII plus LF only', () => {
    for (const f of KIT) {
      const text = readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
      expect(text.search(/[^\x20-\x7E\n]/), f).toBe(-1);
    }
  });

  it('the secret names are the sync:false names of render.yaml minus UMS_PUBLIC_ORIGIN, plus UMS_OWN_MERCHANT_ID', () => {
    const render = readFileSync(join(REPO_ROOT, 'render.yaml'), 'utf8');
    const fromRender = [...render.matchAll(/- key: ([A-Z0-9_]+)\n\s+sync: false\n/g)]
      .map((m) => m[1] as string)
      .filter((n) => n !== 'UMS_PUBLIC_ORIGIN')
      .sort();
    // UMS_OWN_MERCHANT_ID is an addition of the Google Cloud kit: Cloud Run reads env vars from a file in
    // the repository, and the owner's merchant id must never be committed, so the kit stores it as a secret.
    expect([...fromRender, 'UMS_OWN_MERCHANT_ID'].sort()).toEqual([...SECRET_NAMES].sort());
    const setSecret = readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'set-secret.sh'), 'utf8');
    for (const n of SECRET_NAMES) expect(setSecret).toContain(n);
    expect(setSecret).not.toContain('UMS_PUBLIC_ORIGIN |');
  });

  it('the real service.yaml carries every fixed value of render.yaml that the app needs, except the database', () => {
    const render = readFileSync(join(REPO_ROOT, 'render.yaml'), 'utf8');
    const svc = readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'service.yaml'), 'utf8');
    for (const k of [
      'NODE_ENV',
      'NEXT_TELEMETRY_DISABLED',
      'UMS_MODE',
      'UMS_PAYPAL_CONNECT',
      'UMS_OUTBOUND_SCOPE',
      'UMS_TRUSTED_PROXIES',
      'NEXT_PUBLIC_UMS_ENV_LABEL',
    ]) {
      const fromRender = render.match(new RegExp(`key: ${k}\\n\\s+value: '([^']*)'`))?.[1];
      expect(fromRender, k).toBeDefined();
      expect(svc, k).toContain(`${k}: '${fromRender}'`);
    }
    expect(svc).toContain("UMS_DB: 'postgres'");
    expect(svc).not.toContain('UMS_MAINTENANCE_FLAG:');
    expect(svc).not.toContain('UMS_PGLITE_DIR');
  });

  it('the real deploy.sh pins one instance, always on, public ingress and secrets by reference', () => {
    const d = readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'deploy.sh'), 'utf8');
    for (const flag of [
      '--min-instances=1',
      '--max-instances=1',
      '--no-cpu-throttling',
      '--memory=2Gi',
      '--ingress=all',
      '--allow-unauthenticated',
      '--set-secrets="$SECRET_FLAGS"',
      '--add-cloudsql-instances="$CONNECTION"',
    ])
      expect(d, flag).toContain(flag);
    expect(d).not.toMatch(/--(set|update)-env-vars/);
  });

  it('package.json defines check:hosting-gcp and ci runs it', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:hosting-gcp']).toBe('node scripts/check-hosting-gcp.mjs');
    expect(pkg.scripts['ci']).toContain('corepack pnpm check:hosting-gcp');
    expect(pkg.scripts['ci']).toContain('corepack pnpm check:hosting &&');
  });

  it('the kit directory holds exactly the reviewed files', () => {
    expect(readdirSync(join(REPO_ROOT, 'infra', 'gcp')).sort()).toEqual([...KIT].sort());
  });
});
