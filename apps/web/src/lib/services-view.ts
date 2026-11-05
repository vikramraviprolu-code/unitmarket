// INT-CTL / CTL.2: the services panel's words, as plain strings. The cloud state is a pasted `cloud:status --json`,
// validated here against CloudStatusSchema (strict, at most 16 KB) and never stored or posted; the app's own state
// is the revision and db of GET /api/v1/status. The server holds no cloud permission and runs no cloud command.
// Every link is built here, on the fixed console base, from the validated project (F10) and encodeURIComponent.
import { CLOUD_STATUS_MAX_BYTES, CloudStatusSchema } from '@umsbx/contracts';
import type { CloudStatus } from '@umsbx/contracts';

export const CLOUD_COMMANDS = [
  'corepack pnpm cloud:doctor',
  'corepack pnpm cloud:status',
  'corepack pnpm cloud:up',
  'corepack pnpm cloud:down',
  'corepack pnpm cloud:restart',
  'corepack pnpm cloud:deploy',
  'corepack pnpm cloud:logs',
] as const;

const CONSOLE = 'https://console.cloud.google.com/';
const [DOCTOR, STATUS, UP, DOWN, RESTART, DEPLOY, LOGS] = CLOUD_COMMANDS;

export type ParseResult = { ok: true; value: CloudStatus } | { ok: false; message: string };

/** The refusal never repeats the pasted text: it may hold markup. */
export function parseCloudStatus(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > CLOUD_STATUS_MAX_BYTES)
    return { ok: false, message: 'That paste is longer than 16 KB. Paste only the status JSON.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'That is not JSON. Paste the output of the cloud status command.',
    };
  }
  const r = CloudStatusSchema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      message:
        'That JSON does not match the cloud status shape. Paste the unedited output of the cloud status command.',
    };
  return { ok: true, value: r.data };
}

export type ServiceKey = 'web' | 'job_loop' | 'database' | 'offline_judge' | 'paypal_gateway';

export interface ServiceCard {
  key: ServiceKey;
  title: string;
  /** The state word, or 'unknown' until a status is pasted. */
  state: string;
  lines: string[];
  commands: string[];
  cloud_shell_url: string | null;
  audit_url: string | null;
}

export interface ServicesView {
  checked_at: string | null;
  project: string | null;
  cloud_pasted: boolean;
  cards: ServiceCard[];
}

export interface AppStatus {
  revision: string;
  db: string;
}

const links = (project: string | null): Pick<ServiceCard, 'cloud_shell_url' | 'audit_url'> => {
  if (project === null) return { cloud_shell_url: null, audit_url: null };
  const p = encodeURIComponent(project);
  return {
    cloud_shell_url: `${CONSOLE}home/dashboard?project=${p}&cloudshell=true`,
    audit_url: `${CONSOLE}logs/query;query=logName%3D~%22cloudaudit.googleapis.com%22?project=${p}`,
  };
};

const when = (label: string, at: string | undefined): string[] =>
  at === undefined ? [] : [`${label}: ${at}`];
const err = (e: string | null | undefined): string[] =>
  e === null || e === undefined ? [] : [`Last error: ${e}`];

export function servicesView(i: {
  app: AppStatus | null;
  cloud: CloudStatus | null;
}): ServicesView {
  const c = i.cloud;
  const [web, job, db, judge, gw] = c === null ? [] : c.services;
  const l = links(c === null ? null : c.project);
  const appRev =
    i.app === null ? 'The app status was not read.' : `Running revision: ${i.app.revision}`;
  const appDb =
    i.app === null ? 'The app status was not read.' : `Database as the app sees it: ${i.app.db}`;
  const cards: ServiceCard[] = [
    {
      key: 'web',
      title: 'Web',
      state: web?.state ?? 'unknown',
      lines: [
        appRev,
        ...(web === undefined
          ? []
          : [
              `Cloud revision: ${web.revision}`,
              ...when('Last changed', web.last_changed_at),
              ...err(web.last_error),
            ]),
      ],
      commands: [STATUS, UP, DOWN, RESTART, DEPLOY, LOGS],
      ...l,
    },
    {
      key: 'job_loop',
      title: 'Job loop',
      state: job?.state ?? 'unknown',
      lines:
        job === undefined
          ? ['Runs inside the web service.']
          : [
              'Runs inside the web service.',
              ...when('Last changed', job.last_changed_at),
              ...err(job.last_error),
            ],
      commands: [STATUS, RESTART, LOGS],
      ...l,
    },
    {
      key: 'database',
      title: 'Database',
      state: db?.state ?? 'unknown',
      lines: [
        appDb,
        ...(db === undefined
          ? []
          : [
              `Tier: ${db.tier}`,
              ...(db.newest_backup_at === null
                ? ['No backup yet.']
                : when('Newest backup', db.newest_backup_at)),
              ...err(db.last_error),
            ]),
      ],
      commands: [STATUS, UP, DOWN],
      ...l,
    },
    {
      key: 'offline_judge',
      title: 'Offline judge',
      state: judge?.state ?? 'unknown',
      lines:
        judge === undefined
          ? ['The part that scores answers without a network.']
          : ['The part that scores answers without a network.', ...err(judge.last_error)],
      commands: [DOCTOR, STATUS],
      ...l,
    },
    {
      key: 'paypal_gateway',
      title: 'PayPal gateway',
      state: gw?.state ?? 'unknown',
      lines:
        gw === undefined
          ? ['Shown from the pasted status. The locks are in the gateway panel.']
          : [
              `Connect flag on the host: ${gw.flag}`,
              `Approval reference set: ${gw.approval_ref_set ? 'yes' : 'no'}`,
              ...when('Last changed', gw.last_changed_at),
            ],
      commands: [STATUS],
      ...l,
    },
  ];
  return {
    checked_at: c === null ? null : c.checked_at,
    project: c === null ? null : c.project,
    cloud_pasted: c !== null,
    cards,
  };
}
