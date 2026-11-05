// INT-OPS-A / OPS-A.1 (A5): the four health lights of operator Home. One pure rule per light, in words an
// operator can read at a glance. The inputs are facts the composition read gathers (the health check, the stored
// switch, the lock block, the last job pass and the injected clock); this file decides nothing about where they
// come from. A word never shows a code and never has a dash.
import type { BlockedBy } from '@umsbx/contracts';

/** A job loop that has not finished a pass for longer than this is stale (five minutes). */
export const JOB_STALE_MS = 300_000;

/** The plain word for each lock that can hold an outbound call back. Every BLOCKED_BY value has one. */
export const BLOCKED_WORDS: Record<BlockedBy, string> = {
  connect_off: 'connection flag off',
  kill_switch: 'kill switch off',
  no_approval: 'no approval',
  budget: 'call budget used',
  egress: 'network not allowed',
};

export type LightTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
export type LightId = 'app' | 'database' | 'paypal' | 'jobs';
export interface HealthLight {
  id: LightId;
  label: string;
  word: string;
  tone: LightTone;
}

export interface HealthInput {
  /** 'up' when the health check answered, 'unknown' when the read threw. */
  app: 'up' | 'unknown';
  maintenance: boolean;
  db: boolean;
  environment: 'dryrun' | 'sandbox';
  /** The stored paypal_outbound switch, or null when it could not be read. */
  switch_on: boolean | null;
  /** The lock block of the gate; null on the dry-run transport. */
  outbound: { open: boolean; blocked_by: string | null } | null;
  last_pass_at: string | null;
  now: string;
}

function appLight(i: HealthInput): HealthLight {
  return i.app === 'up'
    ? { id: 'app', label: 'App', word: 'up', tone: 'good' }
    : { id: 'app', label: 'App', word: 'unknown', tone: 'neutral' };
}

function databaseLight(i: HealthInput): HealthLight {
  if (i.maintenance)
    return { id: 'database', label: 'Database', word: 'closed for maintenance', tone: 'warn' };
  return i.db
    ? { id: 'database', label: 'Database', word: 'up', tone: 'good' }
    : { id: 'database', label: 'Database', word: 'down', tone: 'bad' };
}

function paypalLight(i: HealthInput): HealthLight {
  const base = { id: 'paypal', label: 'PayPal gateway' } as const;
  if (i.environment === 'dryrun') return { ...base, word: 'off (dry-run)', tone: 'info' };
  if (i.switch_on === null) return { ...base, word: 'unknown', tone: 'neutral' };
  if (!i.switch_on) return { ...base, word: 'off (switched off)', tone: 'warn' };
  if (i.outbound === null) return { ...base, word: 'unknown', tone: 'neutral' };
  if (i.outbound.open) return { ...base, word: 'on', tone: 'good' };
  const by = i.outbound.blocked_by;
  const why =
    by !== null && Object.hasOwn(BLOCKED_WORDS, by) ? BLOCKED_WORDS[by as BlockedBy] : null;
  return { ...base, word: why === null ? 'blocked' : `blocked (${why})`, tone: 'bad' };
}

function jobsLight(i: HealthInput): HealthLight {
  const base = { id: 'jobs', label: 'Job loop' } as const;
  if (i.last_pass_at === null) return { ...base, word: 'not run yet', tone: 'neutral' };
  const age = Date.parse(i.now) - Date.parse(i.last_pass_at);
  return age > JOB_STALE_MS
    ? { ...base, word: 'stale', tone: 'bad' }
    : { ...base, word: 'running', tone: 'good' };
}

export function healthLights(i: HealthInput): HealthLight[] {
  return [appLight(i), databaseLight(i), paypalLight(i), jobsLight(i)];
}
