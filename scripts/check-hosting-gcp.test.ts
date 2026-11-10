import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, materialize, runGuard } from './test-helpers';

// GCP-1: the guard for the Google Cloud deployment kit (infra/gcp). Every refusal case below is the
// clean kit (scripts/__fixtures__/hosting-gcp/good) with exactly one unsafe change. The guard must
// exit 1 and name the rule; it must never print a value from the files.
const GUARD = 'check-hosting-gcp.mjs';
const KIT = [
  'Dockerfile',
  'cloud.sh',
  'deploy-offline.sh',
  'deploy.sh',
  'monitoring.sh',
  'service-offline.yaml',
  'service.yaml',
  'set-secret.sh',
  'setup.sh',
  'stack.env',
  'lib/cloud-lib.sh',
];
const SCRIPTS = KIT.filter((f) => f.endsWith('.sh'));

// Forbidden strings are assembled at run time so this file holds none of them.
const PUB = 'NEXT_' + 'PUBLIC';
const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');
const GOOGLE_KEY = 'AIza' + 'Sy' + 'A'.repeat(33);
const PEM = '-----BEGIN ' + 'PRIVATE KEY-----';
const HEX_TOKEN = '3f9a' + 'c27d41'.repeat(6);
// GCP-2: the base image digest taken from the real Cloud Build log of 27 Oct.
const BASE_DIGEST = 'dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94';
// INFRA-A: optional secrets of the sandbox service and the five own secrets of the offline service
// (HARD-OFFLINE added the judge hash).
const OPTIONAL_NAMES = [
  'UMS_PUBLISHER_PASSCODE_HASH',
  'UMS_JUDGE_PASSCODE_HASH',
  'UMS_OFFER_MAX_MINOR',
  'UMS_AI_ADAPTER',
  'UMS_ANTHROPIC_API_KEY',
];
const OFFLINE_NAMES = [
  'UMS_OFFLINE_SESSION_SECRET',
  'UMS_OFFLINE_APPROVAL_SECRET',
  'UMS_OFFLINE_LINK_SECRET',
  'UMS_OFFLINE_DEMO_PASSCODE_HASH',
  'UMS_OFFLINE_JUDGE_PASSCODE_HASH',
];
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
    'DOM-1 the word live next to the custom domain in service.yaml',
    'service.yaml',
    "UMS_MODE: 'sandbox'",
    "UMS_MODE: 'sandbox'\n# go live at https://unitmarket.live",
    'live-value',
  ],
  [
    'DOM-1 the custom domain outside service.yaml',
    'deploy.sh',
    'set -euo pipefail',
    'set -euo pipefail\n# https://unitmarket.live',
    'live-value',
  ],
  [
    'DOM-1 a host that only starts like the custom domain',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.lives'",
    'origin',
  ],
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
  // INFRA-A: the list now ends with the eight optional and offline names, so the anchor moved.
  [
    'set-secret drops a name',
    'set-secret.sh',
    ' | UMS_OFFLINE_JUDGE_PASSCODE_HASH)',
    ')',
    'secret-names',
  ],
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
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'http://localhost:3000'",
    'origin',
  ],
  [
    'origin on another host',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://shop.example.test'",
    'origin',
  ],
  [
    'origin with a path',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://svc-1.europe-west1.run.app/x'",
    'origin',
  ],
  [
    'DOM-1 origin on a subdomain of the custom domain',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://www.unitmarket.live'",
    'origin',
  ],
  [
    'DOM-1 custom domain with a path',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live/x'",
    'origin',
  ],
  [
    'DOM-1 custom domain over plain http',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'http://unitmarket.live'",
    'origin',
  ],
  [
    'DOM-1 offline yaml with the custom domain',
    'service-offline.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-offline-626887286871.europe-west3.run.app'",
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    'origin',
  ],
  [
    'origin missing',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'\n",
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
  [
    'DOM-1 a run.app origin is still accepted',
    'service.yaml',
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'",
    "UMS_PUBLIC_ORIGIN: 'https://unitmarket-sandbox-626887286871.europe-west3.run.app'",
  ],
];

// INFRA-A: optional secrets for the sandbox service and the prepared offline service. Each case is the
// clean kit with one unsafe edit; the guard must exit 1 and name the rule.
const INFRA_A_CASES: Case[] = [
  // optional secrets stay optional
  [
    'an optional name moves into the required list',
    'deploy.sh',
    ' UMS_OPERATOR_TOTP_KEYS"',
    ' UMS_OPERATOR_TOTP_KEYS UMS_AI_ADAPTER"',
    'secret-names',
  ],
  ['the optional list drops a name', 'deploy.sh', ' UMS_ANTHROPIC_API_KEY"', '"', 'secret-names'],
  [
    'the optional list gains a payment name',
    'deploy.sh',
    ' UMS_ANTHROPIC_API_KEY"',
    ' UMS_ANTHROPIC_API_KEY PAYPAL_CLIENT_ID"',
    'secret-names',
  ],
  ['setup optional list drops a name', 'setup.sh', ' UMS_ANTHROPIC_API_KEY"', '"', 'secret-names'],
  // JUDGE-A: the judge hash follows the optional-secret pattern of the publisher hash
  [
    'the deploy optional list drops the judge hash',
    'deploy.sh',
    'UMS_PUBLISHER_PASSCODE_HASH UMS_JUDGE_PASSCODE_HASH UMS_OFFER_MAX_MINOR',
    'UMS_PUBLISHER_PASSCODE_HASH UMS_OFFER_MAX_MINOR',
    'secret-names',
  ],
  [
    'the setup optional list drops the judge hash',
    'setup.sh',
    'UMS_PUBLISHER_PASSCODE_HASH UMS_JUDGE_PASSCODE_HASH UMS_OFFER_MAX_MINOR',
    'UMS_PUBLISHER_PASSCODE_HASH UMS_OFFER_MAX_MINOR',
    'secret-names',
  ],
  [
    'the judge hash moves into the required list',
    'deploy.sh',
    ' UMS_OPERATOR_TOTP_KEYS"',
    ' UMS_OPERATOR_TOTP_KEYS UMS_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'set-secret drops the judge hash',
    'set-secret.sh',
    ' | UMS_JUDGE_PASSCODE_HASH',
    '',
    'secret-names',
  ],
  [
    'the judge hash given a value in service.yaml',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nUMS_JUDGE_PASSCODE_HASH: 'x'",
    'secret-in-env',
  ],
  [
    'the offline script names the sandbox judge hash',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'UMS_JUDGE_PASSCODE_HASH=x\nSECRET_FLAGS=""',
    'offline-secret',
  ],
  [
    'deploy stops on a missing optional secret',
    'deploy.sh',
    '    echo "off: ${NAME} has no value"',
    '    die "no value yet for optional ${NAME}"',
    'optional-secret',
  ],
  [
    'deploy has no optional loop',
    'deploy.sh',
    'for NAME in $OPTIONAL_SECRET_NAMES; do',
    'for NAME in $SECRET_NAMES; do',
    'optional-secret',
  ],
  [
    'an optional name given a value in service.yaml',
    'service.yaml',
    "UMS_DB: 'postgres'",
    "UMS_DB: 'postgres'\nUMS_AI_ADAPTER: 'claude'",
    'secret-in-env',
  ],
  [
    'an optional secret given a literal in deploy.sh',
    'deploy.sh',
    'SECRET_FLAGS=""',
    'UMS_ANTHROPIC_API_KEY=abc\nSECRET_FLAGS=""',
    'secret-literal',
  ],
  [
    'set-secret drops an optional name',
    'set-secret.sh',
    ' | UMS_ANTHROPIC_API_KEY',
    '',
    'secret-names',
  ],
  // the offline service
  ['offline kit file removed', 'service-offline.yaml', '', '', 'kit-files'],
  [
    'offline connect on',
    'service-offline.yaml',
    "UMS_PAYPAL_CONNECT: 'off'",
    "UMS_PAYPAL_CONNECT: 'on'",
    'paypal-connect',
  ],
  [
    'offline connect missing',
    'service-offline.yaml',
    "UMS_PAYPAL_CONNECT: 'off'\n",
    '',
    'paypal-connect',
  ],
  [
    'offline connect set in the script',
    'deploy-offline.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --update-env-vars=UMS_PAYPAL_CONNECT=on \\\n',
    'paypal-connect',
  ],
  [
    'offline mode becomes sandbox',
    'service-offline.yaml',
    "UMS_MODE: 'offline'",
    "UMS_MODE: 'sandbox'",
    'fixed-value',
  ],
  ['offline mode missing', 'service-offline.yaml', "UMS_MODE: 'offline'\n", '', 'fixed-value'],
  [
    'offline database becomes postgres',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'postgres'",
    'db-kind',
  ],
  [
    'offline database on disk',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-disk'",
    'db-kind',
  ],
  ['offline database missing', 'service-offline.yaml', "UMS_DB: 'pglite-memory'\n", '', 'db-kind'],
  [
    'offline adapter becomes claude',
    'service-offline.yaml',
    "UMS_AI_ADAPTER: 'scripted'",
    "UMS_AI_ADAPTER: 'claude'",
    'fixed-value',
  ],
  [
    'offline label says Sandbox',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nNEXT_PUBLIC_UMS_ENV_LABEL: 'Sandbox'",
    'fixed-value',
  ],
  [
    'offline yaml names a PayPal secret',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nPAYPAL_CLIENT_ID: 'x'",
    'secret-in-env',
  ],
  [
    'offline yaml names a PayPal setting',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nPAYPAL_MODE: 'x'",
    'offline-paypal',
  ],
  [
    'offline yaml names the database URL',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nDATABASE_URL: 'x'",
    'secret-in-env',
  ],
  [
    'offline yaml carries an unknown name',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nUMS_OUTBOUND_SCOPE: 'mvp_c_refunds'",
    'unknown-name',
  ],
  [
    'offline yaml has a bad origin',
    'service-offline.yaml',
    'https://unitmarket-offline-626887286871.europe-west3.run.app',
    'https://example.org/path',
    'origin',
  ],
  [
    'offline script maps a PayPal secret',
    'deploy-offline.sh',
    'OFFLINE_SECRET_NAMES="UMS_OFFLINE_SESSION_SECRET',
    'OFFLINE_SECRET_NAMES="PAYPAL_CLIENT_SECRET UMS_OFFLINE_SESSION_SECRET',
    'secret-names',
  ],
  [
    'offline script reads a PayPal secret name in code',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'SECRET_FLAGS=""\nOTHER="PAYPAL_CLIENT_ID"',
    'offline-secret',
  ],
  [
    'offline script reads the database secret in code',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'SECRET_FLAGS=""\nOTHER="DATABASE_URL"',
    'offline-secret',
  ],
  [
    'offline script attaches Cloud SQL',
    'deploy-offline.sh',
    '  --set-secrets="$SECRET_FLAGS" \\\n',
    '  --set-secrets="$SECRET_FLAGS" \\\n  --add-cloudsql-instances="$CONNECTION" \\\n',
    'offline-shape',
  ],
  [
    'offline script runs as the sandbox runtime account',
    'deploy-offline.sh',
    '--service-account="$OFFLINE_SA"',
    '--service-account="$RUNTIME_SA"',
    'offline-shape',
  ],
  [
    'offline script drops the secret mapping',
    'deploy-offline.sh',
    '  --set-secrets="$SECRET_FLAGS" \\\n',
    '',
    'deploy-shape',
  ],
  [
    'offline script ignores its yaml',
    'deploy-offline.sh',
    '--env-vars-file="${HERE}/service-offline.yaml"',
    '--env-vars-file="${HERE}/service.yaml"',
    'env-file',
  ],
  [
    'offline script env flags',
    'deploy-offline.sh',
    '  --port=8080 \\\n',
    '  --port=8080 \\\n  --set-env-vars=FOO=bar \\\n',
    'env-flags',
  ],
  [
    'offline max instances 2',
    'deploy-offline.sh',
    '--max-instances=1',
    '--max-instances=2',
    'max-instances',
  ],
  [
    'offline max instances missing',
    'deploy-offline.sh',
    '  --max-instances=1 \\\n',
    '',
    'max-instances',
  ],
  [
    'offline min instances 0',
    'deploy-offline.sh',
    '--min-instances=1',
    '--min-instances=0',
    'min-instances',
  ],
  [
    'offline cpu throttling missing',
    'deploy-offline.sh',
    '  --no-cpu-throttling \\\n',
    '',
    'cpu-throttling',
  ],
  [
    'offline ingress internal',
    'deploy-offline.sh',
    '--ingress=all',
    '--ingress=internal',
    'ingress',
  ],
  [
    'offline unauthenticated missing',
    'deploy-offline.sh',
    '  --allow-unauthenticated \\\n',
    '',
    'unauthenticated',
  ],
  [
    'offline image tag without the commit',
    'deploy-offline.sh',
    '${IMAGE_NAME}:${TAG}-${COMMIT}"',
    '${IMAGE_NAME}:${TAG}"',
    'image-tag',
  ],
  [
    'offline script without the account guard',
    'deploy-offline.sh',
    '[ -n "$ACTIVE_ACCOUNT" ] || die',
    'true || die',
    'account-guard',
  ],
  [
    'offline script reads a secret back',
    'deploy-offline.sh',
    'echo "== image $IMAGE"',
    'gcloud secrets versions access latest --secret="$NAME" --project="$PROJECT_ID"\necho "== image $IMAGE"',
    'secret-read',
  ],
  [
    'offline script builds from a trigger',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'gcloud builds triggers create github --repo-name=x\nSECRET_FLAGS=""',
    'auto-deploy',
  ],
  [
    'a second deploy statement in the offline script',
    'deploy-offline.sh',
    'SERVICE_URL="$(gcloud run services describe',
    'gcloud run deploy "$SERVICE" --image="$IMAGE"\nSERVICE_URL="$(gcloud run services describe',
    'deploy-shape',
  ],
  [
    'offline script names a PayPal host',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    `# ${SANDBOX_HOST}\nSECRET_FLAGS=""`,
    'paypal-host',
  ],
  [
    'offline script without strict mode',
    'deploy-offline.sh',
    'set -euo pipefail',
    'set -eu',
    'strict-mode',
  ],
  // review F2: the offline account is pinned and reads only the offline secrets
  [
    'offline script runs as the sandbox runtime account name',
    'deploy-offline.sh',
    'OFFLINE_SA="ums-offline@',
    'OFFLINE_SA="ums-runtime@',
    'offline-shape',
  ],
  [
    'setup sets the offline account to the sandbox runtime account',
    'setup.sh',
    'OFFLINE_SA="ums-offline@',
    'OFFLINE_SA="ums-runtime@',
    'offline-shape',
  ],
  [
    'setup sets the offline account twice',
    'setup.sh',
    'echo "== billing"',
    'OFFLINE_SA="ums-offline@${PROJECT_ID}.iam.gserviceaccount.com"\necho "== billing"',
    'offline-shape',
  ],
  [
    'setup offline loop also walks the required secrets',
    'setup.sh',
    'for NAME in $OFFLINE_SECRET_NAMES; do',
    'for NAME in $OFFLINE_SECRET_NAMES $SECRET_NAMES; do',
    'offline-shape',
  ],
  [
    'setup binds the offline account at project level',
    'setup.sh',
    '--member="serviceAccount:${RUNTIME_SA}"',
    '--member="serviceAccount:${OFFLINE_SA}"',
    'offline-shape',
  ],
  [
    'setup binds the runtime account inside the offline loop',
    'setup.sh',
    '--member="serviceAccount:${OFFLINE_SA}"',
    '--member="serviceAccount:${RUNTIME_SA}"',
    'offline-shape',
  ],
  [
    'offline script names the runtime account',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'OTHER_SA="$RUNTIME_SA"\nSECRET_FLAGS=""',
    'offline-shape',
  ],
  // HARD-OFFLINE: the offline service gets its own judge hash; judges there sign in buyers only
  [
    'set-secret drops the offline judge name',
    'set-secret.sh',
    ' | UMS_OFFLINE_JUDGE_PASSCODE_HASH',
    '',
    'secret-names',
  ],
  [
    'set-secret allows a made-up offline name',
    'set-secret.sh',
    ' | UMS_OFFLINE_JUDGE_PASSCODE_HASH',
    ' | UMS_OFFLINE_JUDGE_PASSCODE_HASH | UMS_OFFLINE_PAYPAL_CONNECT',
    'secret-names',
  ],
  [
    'the offline deploy list drops the judge secret',
    'deploy-offline.sh',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    '"',
    'secret-names',
  ],
  [
    'the setup offline list drops the judge secret',
    'setup.sh',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    '"',
    'secret-names',
  ],
  [
    'the offline deploy list swaps in the sandbox judge name',
    'deploy-offline.sh',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    ' UMS_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'the setup offline list swaps in the sandbox judge name',
    'setup.sh',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    ' UMS_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'the setup offline list gains a payment name',
    'setup.sh',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    ' UMS_OFFLINE_JUDGE_PASSCODE_HASH PAYPAL_CLIENT_SECRET"',
    'secret-names',
  ],
  [
    'the setup optional list gains the offline judge name',
    'setup.sh',
    ' UMS_ANTHROPIC_API_KEY"',
    ' UMS_ANTHROPIC_API_KEY UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'the deploy optional list gains the offline judge name',
    'deploy.sh',
    ' UMS_ANTHROPIC_API_KEY"',
    ' UMS_ANTHROPIC_API_KEY UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'the setup required list gains the offline judge name',
    'setup.sh',
    ' UMS_OPERATOR_TOTP_KEYS"',
    ' UMS_OPERATOR_TOTP_KEYS UMS_OFFLINE_JUDGE_PASSCODE_HASH"',
    'secret-names',
  ],
  [
    'the offline judge secret is mapped to a connect name',
    'deploy-offline.sh',
    'UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest',
    'UMS_PAYPAL_CONNECT=${NAME}:latest',
    'deploy-shape',
  ],
  [
    'the offline judge secret is mapped to a mode name',
    'deploy-offline.sh',
    'UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest',
    'UMS_MODE=${NAME}:latest',
    'deploy-shape',
  ],
  [
    'the offline mapping stops stripping the prefix',
    'deploy-offline.sh',
    'UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest',
    '${NAME}=${NAME}:latest',
    'deploy-shape',
  ],
  [
    'the offline judge secret gets a hard-coded extra mapping',
    'deploy-offline.sh',
    'echo "== deploy $SERVICE',
    'SECRET_FLAGS="${SECRET_FLAGS},UMS_JUDGE_PASSCODE_HASH=UMS_OFFLINE_JUDGE_PASSCODE_HASH:latest"\necho "== deploy $SERVICE',
    'deploy-shape',
  ],
  [
    'the offline mapping loop walks another list',
    'deploy-offline.sh',
    'SECRET_FLAGS=""\nfor NAME in $OFFLINE_SECRET_NAMES; do',
    'SECRET_FLAGS=""\nfor NAME in $OFFLINE_SECRET_NAMES $OFFLINE_EXTRA; do',
    'deploy-shape',
  ],
  [
    'the offline deploy maps a sandbox judge secret by name',
    'deploy-offline.sh',
    'echo "== deploy $SERVICE',
    'SECRET_FLAGS="${SECRET_FLAGS},UMS_JUDGE_PASSCODE_HASH=UMS_JUDGE_PASSCODE_HASH:latest"\necho "== deploy $SERVICE',
    'offline-secret',
  ],
  [
    'the offline account is bound to the sandbox judge secret outside the loop',
    'setup.sh',
    'echo "== Cloud SQL instance',
    'gcloud secrets add-iam-policy-binding "UMS_JUDGE_PASSCODE_HASH" --member="serviceAccount:${OFFLINE_SA}" --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID" >/dev/null\necho "== Cloud SQL instance',
    'offline-shape',
  ],
  [
    'the offline account is bound to a PayPal secret outside the loop',
    'setup.sh',
    'echo "== Cloud SQL instance',
    'gcloud secrets add-iam-policy-binding "PAYPAL_CLIENT_SECRET" --member="serviceAccount:${OFFLINE_SA}" --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID" >/dev/null\necho "== Cloud SQL instance',
    'offline-shape',
  ],
  [
    'the offline secret loop also walks the sandbox judge secret',
    'setup.sh',
    'for NAME in $OFFLINE_SECRET_NAMES; do',
    'for NAME in $OFFLINE_SECRET_NAMES UMS_JUDGE_PASSCODE_HASH; do',
    'offline-shape',
  ],
  [
    'the offline secret loop also walks the optional secrets',
    'setup.sh',
    'for NAME in $OFFLINE_SECRET_NAMES; do',
    'for NAME in $OFFLINE_SECRET_NAMES $OPTIONAL_SECRET_NAMES; do',
    'offline-shape',
  ],
  [
    'the offline account is bound inside the optional secret loop',
    'setup.sh',
    [
      'echo "== optional secret containers (no values yet)"',
      'for NAME in $OPTIONAL_SECRET_NAMES; do',
      '  if ! gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then',
      '    gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null',
      '    echo "created $NAME"',
      '  else',
      '    echo "kept $NAME"',
      '  fi',
      '  gcloud secrets add-iam-policy-binding "$NAME" \\',
      '    --member="serviceAccount:${RUNTIME_SA}" \\',
    ].join('\n'),
    [
      'echo "== optional secret containers (no values yet)"',
      'for NAME in $OPTIONAL_SECRET_NAMES; do',
      '  if ! gcloud secrets describe "$NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then',
      '    gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJECT_ID" >/dev/null',
      '    echo "created $NAME"',
      '  else',
      '    echo "kept $NAME"',
      '  fi',
      '  gcloud secrets add-iam-policy-binding "$NAME" \\',
      '    --member="serviceAccount:${OFFLINE_SA}" \\',
    ].join('\n'),
    'offline-shape',
  ],
  [
    'the offline judge container is bound to the sandbox account too',
    'setup.sh',
    [
      '    --member="serviceAccount:${OFFLINE_SA}" \\',
      '    --role="roles/secretmanager.secretAccessor" \\',
    ].join('\n'),
    [
      '    --member="serviceAccount:${OFFLINE_SA}" \\',
      '    --member="serviceAccount:${RUNTIME_SA}" \\',
      '    --role="roles/secretmanager.secretAccessor" \\',
    ].join('\n'),
    'iam-role',
  ],
  [
    'the offline yaml gives the offline judge name a value',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nUMS_OFFLINE_JUDGE_PASSCODE_HASH: 'x'",
    'secret-in-env',
  ],
  [
    'the offline yaml gives the sandbox judge name a value',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nUMS_JUDGE_PASSCODE_HASH: 'x'",
    'secret-in-env',
  ],
  [
    'the offline script gives the offline judge name a literal',
    'deploy-offline.sh',
    'SECRET_FLAGS=""',
    'UMS_OFFLINE_JUDGE_PASSCODE_HASH=abc\nSECRET_FLAGS=""',
    'secret-literal',
  ],
  // review F3: OPTIONAL_ON and SECRET_FLAGS come from the reviewed lines only
  [
    'OPTIONAL_ON starts with the connection name',
    'deploy.sh',
    'OPTIONAL_ON=""',
    'OPTIONAL_ON=" UMS_PAYPAL_CONNECT"',
    'optional-secret',
  ],
  [
    'OPTIONAL_ON gets the mode name',
    'deploy.sh',
    'echo "== the database instance must be running"',
    'OPTIONAL_ON="${OPTIONAL_ON} UMS_MODE"\necho "== the database instance must be running"',
    'optional-secret',
  ],
  [
    'OPTIONAL_ON grown with +=',
    'deploy.sh',
    'echo "== the database instance must be running"',
    'OPTIONAL_ON+=" UMS_MODE"\necho "== the database instance must be running"',
    'optional-secret',
  ],
  [
    'OPTIONAL_ON appended outside its loop',
    'deploy.sh',
    'echo "== the database instance must be running"',
    'OPTIONAL_ON="${OPTIONAL_ON} ${NAME}"\necho "== the database instance must be running"',
    'optional-secret',
  ],
  [
    'SECRET_FLAGS gets an extra mapping',
    'deploy.sh',
    'echo "== deploy $SERVICE',
    'SECRET_FLAGS="${SECRET_FLAGS},UMS_MODE=UMS_MODE:latest"\necho "== deploy $SERVICE',
    'deploy-shape',
  ],
];

// Legal edits of the new files that must stay accepted.
const INFRA_A_ACCEPTED: [name: string, file: string, find: string, replace: string][] = [
  [
    'offline yaml with the Dry run label',
    'service-offline.yaml',
    "UMS_DB: 'pglite-memory'",
    "UMS_DB: 'pglite-memory'\nNEXT_PUBLIC_UMS_ENV_LABEL: 'Dry run'",
  ],
  [
    'offline yaml with the placeholder origin',
    'service-offline.yaml',
    'https://unitmarket-offline-626887286871.europe-west3.run.app',
    'https://pending.invalid',
  ],
  [
    'offline script --max-instances 1 with a space',
    'deploy-offline.sh',
    '--max-instances=1',
    '--max-instances 1',
  ],
];

describe('check-hosting-gcp', () => {
  const accountGuard = '[ -n "$ACTIVE_ACCOUNT" ] || die';
  const tokenGuard = '[ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ] || ' + accountGuard;

  it('D-099 accepts token-or-account preflight in deploy.sh', () => {
    const dir = materialize('hosting-gcp/good');
    expect(readKit(dir, 'deploy.sh')).toContain(tokenGuard);
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(0);
  });

  it('still accepts the original account-only deploy preflight', () => {
    const dir = mutate('deploy.sh', tokenGuard, accountGuard);
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ['reversed token condition', tokenGuard.replace('[ -n "${', '[ -z "${')],
    ['unconditional token bypass', 'true || ' + tokenGuard],
    ['missing account fallback', '[ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ] || die'],
  ])('D-099 refuses %s', (_name, replacement) => {
    const dir = mutate('deploy.sh', tokenGuard, replacement);
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('account-guard');
  });

  it('does not extend token preflight to secret-writing scripts', () => {
    const dir = mutate('set-secret.sh', accountGuard, tokenGuard);
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('account-guard');
  });

  it('D-099 refuses printing the access token', () => {
    const dir = mutate(
      'deploy.sh',
      tokenGuard,
      'echo "$CLOUDSDK_AUTH_ACCESS_TOKEN"\n' + tokenGuard,
    );
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('print-secret');
  });

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

  it('INFRA-A: has no duplicate case name and at least 40 cases', () => {
    const names = [...CASES, ...GCP2_CASES, ...INFRA_A_CASES].map((c) => c[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(INFRA_A_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(INFRA_A_CASES)('INFRA-A refuses: %s', (_name, file, find, replace, rule) => {
    let dir: string;
    if (_name === 'offline kit file removed') {
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

  it.each(INFRA_A_ACCEPTED)('INFRA-A accepts: %s', (_name, file, find, replace) => {
    const r = runGuard(GUARD, mutate(file, find, replace));
    expect(r.out).toContain('hosting-gcp ok');
    expect(r.status).toBe(0);
  });

  it('INFRA-A: the real kit maps the optional names only when they have a value', () => {
    const read = (f: string) => readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
    const deploy = read('deploy.sh');
    expect(deploy).toContain(`OPTIONAL_SECRET_NAMES="${OPTIONAL_NAMES.join(' ')}"`);
    expect(deploy).toContain('for NAME in $OPTIONAL_SECRET_NAMES; do');
    expect(deploy).not.toMatch(/die[^\n]*OPTIONAL/);
    // the required list never holds an optional name
    const required = deploy.match(/^SECRET_NAMES="([^"]*)"$/m)?.[1] ?? '';
    for (const n of OPTIONAL_NAMES) expect(required.split(' ')).not.toContain(n);
    const setSecret = read('set-secret.sh');
    for (const n of [...OPTIONAL_NAMES, ...OFFLINE_NAMES]) expect(setSecret, n).toContain(n);
    const setup = read('setup.sh');
    expect(setup).toContain(`OPTIONAL_SECRET_NAMES="${OPTIONAL_NAMES.join(' ')}"`);
    expect(setup).toContain(`OFFLINE_SECRET_NAMES="${OFFLINE_NAMES.join(' ')}"`);
  });

  it('HARD-OFFLINE: the real offline kit has five own secrets, the judge one mapped to the judge env name', () => {
    const read = (f: string) => readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
    expect(OFFLINE_NAMES).toHaveLength(5);
    expect(read('deploy-offline.sh')).toContain(
      `OFFLINE_SECRET_NAMES="${OFFLINE_NAMES.join(' ')}"`,
    );
    expect(read('deploy-offline.sh')).toContain('UMS_${NAME#UMS_OFFLINE_}=${NAME}:latest');
    // the demo and the judge hash are two different secrets; the sandbox judge name is never named
    expect(read('deploy-offline.sh')).not.toMatch(/(?<!OFFLINE_)\bUMS_JUDGE_PASSCODE_HASH\b/);
    expect(read('set-secret.sh')).toContain('UMS_OFFLINE_JUDGE_PASSCODE_HASH');
    expect(read('setup.sh')).toContain(`OFFLINE_SECRET_NAMES="${OFFLINE_NAMES.join(' ')}"`);
  });

  it('INFRA-A: the real offline service is offline, in memory, with the connection off and no payment name', () => {
    const y = readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'service-offline.yaml'), 'utf8');
    expect(y).toContain("UMS_MODE: 'offline'");
    expect(y).toContain("UMS_DB: 'pglite-memory'");
    expect(y).toContain("UMS_PAYPAL_CONNECT: 'off'");
    expect(y).not.toContain(`${PUB}_UMS_ENV_LABEL:`);
    const keys = [...y.matchAll(/^([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] as string);
    for (const k of keys)
      expect(k, k).not.toMatch(/PAYPAL_(?!CONNECT$)|DATABASE_URL|OUTBOUND|MERCHANT|TOTP/);
    const d = readFileSync(join(REPO_ROOT, 'infra', 'gcp', 'deploy-offline.sh'), 'utf8');
    for (const flag of [
      '--min-instances=1',
      '--max-instances=1',
      '--no-cpu-throttling',
      '--allow-unauthenticated',
      '--set-secrets="$SECRET_FLAGS"',
      '--service-account="$OFFLINE_SA"',
      '--env-vars-file="${HERE}/service-offline.yaml"',
    ])
      expect(d, flag).toContain(flag);
    expect(d).not.toContain('--add-cloudsql-instances');
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

  it('the kit directory holds exactly the reviewed files, and the one subfolder lib', () => {
    const top = KIT.filter((f) => !f.includes('/'));
    expect(readdirSync(join(REPO_ROOT, 'infra', 'gcp')).sort()).toEqual([...top, 'lib'].sort());
    expect(readdirSync(join(REPO_ROOT, 'infra', 'gcp', 'lib'))).toEqual(['cloud-lib.sh']);
  });
});

// ---- INT-CL1: the cloud kit (cloud.sh, stack.env, lib/cloud-lib.sh) -------------------------------------
// Each case is the clean kit with one change. Appended lines go after the last line of the file.
type Edit = (text: string) => string;
const append =
  (...lines: string[]): Edit =>
  (t) =>
    `${t.replace(/\n+$/, '')}\n${lines.join('\n')}\n`;
const dropLines =
  (re: RegExp): Edit =>
  (t) =>
    t
      .split('\n')
      .filter((l) => !re.test(l))
      .join('\n');
function edited(file: string, edit: Edit): string {
  const dir = materialize('hosting-gcp/good');
  const path = join(dir, 'infra', 'gcp', file);
  writeFileSync(path, edit(readFileSync(path, 'utf8')));
  return dir;
}
const LIB = 'lib/cloud-lib.sh';
const UPDATE = 'gcloud run services update "$SERVICE" --region="$REGION" --project="$PROJECT_ID"';
const PAY = 'UMS_PAYPAL_CONNECT';
const FLAG_OFF = `--update-env-vars=${PAY}=off`;
const PAYPAL_SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');

type CloudCase = [name: string, file: string, edit: Edit, rule: string];
const CLOUD_CASES: CloudCase[] = [
  // env-flags: exactly the flag-off token, in lib/cloud-lib.sh only
  ['env flag on', LIB, append(`${UPDATE} --update-env-vars=${PAY}=on`), 'env-flags'],
  ['env flag UMS_MODE', LIB, append(`${UPDATE} --update-env-vars=UMS_MODE=x`), 'env-flags'],
  [
    'env flag off plus UMS_MODE',
    LIB,
    append(`${UPDATE} --update-env-vars=${PAY}=off,UMS_MODE=x`),
    'env-flags',
  ],
  ['env flag removed', LIB, append(`${UPDATE} --remove-env-vars=${PAY}`), 'env-flags'],
  ['env flags cleared', LIB, append(`${UPDATE} --clear-env-vars`), 'env-flags'],
  [
    'env flag from a variable',
    LIB,
    append(`${UPDATE} --update-env-vars=${PAY}=\${ON}`),
    'env-flags',
  ],
  [
    'env flag split after the equals sign',
    LIB,
    append(`${UPDATE} --update-env-vars=${PAY}= \\`, '  off'),
    'env-flags',
  ],
  [
    'env flag split before the name',
    LIB,
    append(`${UPDATE} --update-env-vars= \\`, `  ${PAY}=off`),
    'env-flags',
  ],
  ['env flag set (not update)', LIB, append(`${UPDATE} --set-env-vars=${PAY}=off`), 'env-flags'],
  ['flag-off token in cloud.sh', 'cloud.sh', append(`${UPDATE} ${FLAG_OFF}`), 'env-flags'],
  ['flag-off token in deploy.sh', 'deploy.sh', append(`${UPDATE} ${FLAG_OFF}`), 'env-flags'],
  ['flag-off token in setup.sh', 'setup.sh', append(`${UPDATE} ${FLAG_OFF}`), 'env-flags'],
  // paypal-connect: kept, no exception for any helper
  [
    'a helper that turns the connection on',
    LIB,
    append(`connect_on() { ${UPDATE} --update-env-vars=${PAY}=on; }`),
    'paypal-connect',
  ],
  ['connection on in cloud.sh', 'cloud.sh', append(`${PAY}=on`), 'paypal-connect'],
  // min and max instances: lib only, min 0 or 1, max 1
  ['min instances 2 in lib', LIB, append(`${UPDATE} --min-instances=2`), 'min-instances'],
  ['min instances 3, space form', LIB, append(`${UPDATE} --min-instances 3`), 'min-instances'],
  ['max instances 2 in lib', LIB, append(`${UPDATE} --max-instances=2`), 'max-instances'],
  ['max instances 0 in lib', LIB, append(`${UPDATE} --max-instances=0`), 'max-instances'],
  ['min instances in cloud.sh', 'cloud.sh', append(`${UPDATE} --min-instances=1`), 'min-instances'],
  ['max instances in cloud.sh', 'cloud.sh', append(`${UPDATE} --max-instances=1`), 'max-instances'],
  ['min instances in setup.sh', 'setup.sh', append(`${UPDATE} --min-instances=1`), 'min-instances'],
  ['cpu throttling in lib', LIB, append(`${UPDATE} --cpu-throttling`), 'cpu-throttling'],
  [
    'no cpu throttling in cloud.sh',
    'cloud.sh',
    append(`${UPDATE} --no-cpu-throttling`),
    'cpu-throttling',
  ],
  ['scaling stays barred in lib', LIB, append(`${UPDATE} --scaling=0`), 'scaling'],
  // literal-project: doctor prints the config lines and never runs them
  ['config set in lib', LIB, append('gcloud config set project some-project'), 'literal-project'],
  ['config set in cloud.sh', 'cloud.sh', append('gcloud config set account x'), 'literal-project'],
  // no-delete
  ['delete a service', LIB, append('gcloud run services delete "$SERVICE"'), 'no-delete'],
  ['delete a database', LIB, append('gcloud sql instances delete "$SQL_INSTANCE"'), 'no-delete'],
  [
    'delete hidden in a variable',
    LIB,
    append('VERB=delete', 'gcloud run services "$VERB" "$SERVICE"'),
    'no-delete',
  ],
  [
    'delete hidden in a quoted variable',
    LIB,
    append('VERB="delete"', 'gcloud run services "$VERB" "$SERVICE"'),
    'no-delete',
  ],
  ['delete in cloud.sh', 'cloud.sh', append('gcloud secrets delete X'), 'no-delete'],
  [
    'delete inside a message helper, command substitution',
    LIB,
    append('say "$(gcloud run services delete x --quiet)"'),
    'no-delete',
  ],
  [
    'delete inside a message helper, backticks',
    LIB,
    append('echo "`gcloud run services delete x`"'),
    'no-delete',
  ],
  [
    'delete inside a die helper, substitution after text',
    LIB,
    append('die_fail "failed: $(gcloud sql instances delete x)"'),
    'no-delete',
  ],
  ['git delete branch', LIB, append('git branch --delete x'), 'no-delete'],
  [
    'deletion protection off',
    LIB,
    append('gcloud sql instances patch x --no-deletion-protection'),
    'sql-protection',
  ],
  // the deploy stays in deploy.sh
  ['a run deploy in lib', LIB, append('gcloud run deploy "$SERVICE" --image=x'), 'deploy-shape'],
  [
    'a run deploy in cloud.sh',
    'cloud.sh',
    append('gcloud run deploy "$SERVICE" --image=x'),
    'deploy-shape',
  ],
  ['auto-deploy from source', LIB, append(`${UPDATE} --source=.`), 'auto-deploy'],
  // the per-file rules apply to the new files (F1)
  ['a tab in cloud.sh', 'cloud.sh', append('echo\ta'), 'bytes'],
  ['a CR in lib', LIB, append('echo a\r'), 'bytes'],
  ['a non-ASCII byte in stack.env', 'stack.env', append('# caf\u00e9'), 'bytes'],
  ['the word live in lib', LIB, append('# the live URL'), 'live-value'],
  ['the word live in cloud.sh', 'cloud.sh', append('# the live URL'), 'live-value'],
  ['the word live in stack.env', 'stack.env', append('# live'), 'live-value'],
  ['no strict mode in cloud.sh', 'cloud.sh', dropLines(/^set -euo pipefail$/), 'strict-mode'],
  ['no strict mode in lib', LIB, dropLines(/^set -euo pipefail$/), 'strict-mode'],
  [
    'no shebang in lib',
    LIB,
    (t) => t.replace(/^#!\/usr\/bin\/env bash\n/, '# lib\n'),
    'strict-mode',
  ],
  ['tracing in lib', LIB, append('set -x'), 'print-secret'],
  [
    'no account guard in cloud.sh',
    'cloud.sh',
    dropLines(/^\[ -n "\$ACTIVE_ACCOUNT" \] \|\| die/),
    'account-guard',
  ],
  [
    'no account guard in lib',
    LIB,
    dropLines(/^\s*\[ -n "\$ACTIVE_ACCOUNT" \] \|\| die/),
    'account-guard',
  ],
  [
    'a secret read in lib',
    LIB,
    append('gcloud secrets versions access latest --secret=X'),
    'secret-read',
  ],
  ['a sign-in in cloud.sh', 'cloud.sh', append('gcloud auth login'), 'login'],
  ['a printed value in lib', LIB, append('echo "$MY_VALUE"'), 'print-secret'],
  ['a secret literal in lib', LIB, append('UMS_SESSION_SECRET=abc'), 'secret-literal'],
  ['a payment host in lib', LIB, append(`curl https://${PAYPAL_SANDBOX_HOST}/x`), 'paypal-host'],
  ['an email address in stack.env', 'stack.env', append('# a@b.example'), 'literal-value'],
  // kit-files: the guard reads that one subfolder and nothing else
  ['cloud.sh removed', 'cloud.sh', () => '', 'kit-files'],
  ['stack.env removed', 'stack.env', () => '', 'kit-files'],
  ['lib/cloud-lib.sh removed', LIB, () => '', 'kit-files'],
];
// A case whose edit is "make the file vanish" removes it instead of emptying it.
const REMOVE = new Set(['cloud.sh removed', 'stack.env removed', 'lib/cloud-lib.sh removed']);

describe('INT-CL1 guard rules (F1, F2, F3)', () => {
  it('has no duplicate case name', () => {
    const names = CLOUD_CASES.map((c) => c[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(CLOUD_CASES.length).toBeGreaterThanOrEqual(50);
  });

  it.each(CLOUD_CASES)('refuses: %s', (name, file, edit, rule) => {
    let dir: string;
    if (REMOVE.has(name)) {
      dir = materialize('hosting-gcp/good');
      rmSync(join(dir, 'infra', 'gcp', file));
    } else dir = edited(file, edit);
    const r = runGuard(GUARD, dir);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`hosting-gcp: FAIL ${rule}`);
    expect(r.out).not.toContain('hosting-gcp ok');
  });

  it('refuses an extra file or folder next to the reviewed ones', () => {
    for (const rel of ['cloud2.sh', join('lib', 'extra.sh'), join('other', 'x.sh')]) {
      const dir = materialize('hosting-gcp/good');
      mkdirSync(join(dir, 'infra', 'gcp', rel, '..'), { recursive: true });
      writeFileSync(join(dir, 'infra', 'gcp', rel), '#!/usr/bin/env bash\nset -euo pipefail\n');
      const r = runGuard(GUARD, dir);
      expect(r.status, rel).toBe(1);
      expect(r.out, rel).toContain('hosting-gcp: FAIL kit-files');
    }
  });

  const ACCEPTED_CLOUD: Array<[name: string, file: string, edit: Edit]> = [
    ['the flag-off token in lib', LIB, append(`${UPDATE} ${FLAG_OFF}`)],
    [
      'the flag-off token, quoted position, in lib',
      LIB,
      append(`mutate gcloud run services update x ${FLAG_OFF} --quiet`),
    ],
    ['min instances 0 in lib', LIB, append(`${UPDATE} --min-instances=0`)],
    ['min instances 1 in lib', LIB, append(`${UPDATE} --min-instances=1`)],
    ['max instances 1 in lib', LIB, append(`${UPDATE} --max-instances=1`)],
    ['no cpu throttling in lib', LIB, append(`${UPDATE} --no-cpu-throttling`)],
    [
      'ingress internal and all in lib',
      LIB,
      append(`${UPDATE} --ingress=internal`, `${UPDATE} --ingress=all`),
    ],
    [
      'a sql patch in lib',
      LIB,
      append('gcloud sql instances patch "$SQL_INSTANCE" --activation-policy=NEVER --quiet'),
    ],
    ['echo text that says delete', LIB, append('echo "this kit never runs a delete"')],
    ['a die message that says delete', LIB, append('die_refuse "refusing to delete anything"')],
    [
      'an escaped substitution in a message is only text',
      LIB,
      append('say "never run \\$(gcloud delete)"'),
    ],
  ];
  it.each(ACCEPTED_CLOUD)('accepts: %s', (_name, file, edit) => {
    const r = runGuard(GUARD, edited(file, edit));
    expect(r.out).toContain('hosting-gcp ok');
    expect(r.status).toBe(0);
  });

  it('the real kit passes, and holds the flag-off token and no flag-on token anywhere', () => {
    const r = runGuard(GUARD);
    expect(r.out).toContain('hosting-gcp ok');
    const lib = readFileSync(join(REPO_ROOT, 'infra', 'gcp', LIB), 'utf8');
    expect(lib).toContain(FLAG_OFF);
    for (const f of KIT) {
      const t = readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
      expect(t, f).not.toMatch(new RegExp(`${PAY}\\s*=\\s*["']?(?!off\\b)\\w`));
    }
  });

  it('stack.env equals the literals of the four reviewed scripts (F12)', () => {
    const read = (f: string) => readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8');
    const stack = Object.fromEntries(
      read('stack.env')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.split('=') as [string, string]),
    );
    expect(Object.keys(stack).sort()).toEqual(
      ['AR_REPO', 'OFFLINE_SERVICE', 'PROJECT_ID', 'REGION', 'SERVICE', 'SQL_INSTANCE'].sort(),
    );
    const lit = (file: string, name: string): string =>
      read(file).match(new RegExp(`^${name}="([^"]*)"$`, 'm'))?.[1] ??
      `<missing ${name} in ${file}>`;
    expect(stack['SERVICE']).toBe(lit('deploy.sh', 'SERVICE'));
    expect(stack['SERVICE']).toBe(lit('monitoring.sh', 'SERVICE'));
    expect(stack['OFFLINE_SERVICE']).toBe(lit('deploy-offline.sh', 'SERVICE'));
    expect(stack['SQL_INSTANCE']).toBe(lit('deploy.sh', 'SQL_INSTANCE'));
    expect(stack['SQL_INSTANCE']).toBe(lit('setup.sh', 'SQL_INSTANCE'));
    for (const f of ['deploy.sh', 'deploy-offline.sh', 'setup.sh'])
      expect(stack['AR_REPO'], f).toBe(lit(f, 'AR_REPO'));
    expect(stack['PROJECT_ID']).toBe('unitmarket-sbx-vr1');
    expect(stack['REGION']).toBe('europe-west3');
    expect(read('stack.env')).not.toMatch(/--project|--region/);
  });

  it('the four reviewed deploy scripts do not read stack.env (they are unchanged)', () => {
    for (const f of ['deploy.sh', 'deploy-offline.sh', 'setup.sh', 'monitoring.sh'])
      expect(readFileSync(join(REPO_ROOT, 'infra', 'gcp', f), 'utf8'), f).not.toContain(
        'stack.env',
      );
  });

  it('package.json defines the seven cloud scripts and ci still runs the guard', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts).filter((k) => k.startsWith('cloud:'))).toHaveLength(7);
    expect(pkg.scripts['ci']).toContain('corepack pnpm check:hosting-gcp');
  });
});
