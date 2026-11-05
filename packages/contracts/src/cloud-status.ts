// INT-CTL / CTL.2: the shape of a pasted `corepack pnpm cloud:status --json` (CL1), strict. The operator pastes it
// into the Controls tab; the browser checks it against this schema, at most 16 KB, and never stores or posts it.
// It mirrors scripts/__fixtures__/cloud-status.json, which CL1's contract test pins. The project becomes part of a
// link to the Google Cloud console, so it must look like a project id (F10): 6 to 30 characters, a lower case
// letter first, then lower case letters, digits and hyphens, and not a hyphen last.
import { z } from 'zod';

export const CLOUD_STATUS_MAX_BYTES = 16 * 1024;

const STATE = z.enum(['up', 'down', 'starting', 'stopping', 'error', 'absent']);
const AT = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const ERR = z.string().max(500).nullable();
const TEXT = z.string().min(1).max(200);

export const CLOUD_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const Web = z
  .object({
    name: z.literal('web'),
    state: STATE,
    revision: TEXT,
    url: z
      .string()
      .max(300)
      .regex(/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/),
    last_changed_at: AT,
    last_error: ERR,
  })
  .strict();
const JobLoop = z
  .object({
    name: z.literal('job_loop'),
    state: STATE,
    runs_in: z.literal('web'),
    last_changed_at: AT,
    last_error: ERR,
  })
  .strict();
const Database = z
  .object({
    name: z.literal('database'),
    state: STATE,
    tier: TEXT,
    newest_backup_at: AT.nullable(),
    last_changed_at: AT,
    last_error: ERR,
  })
  .strict();
const Judge = z
  .object({ name: z.literal('offline_judge'), state: STATE, last_error: ERR })
  .strict();
const Gateway = z
  .object({
    name: z.literal('paypal_gateway'),
    state: z.enum(['on', 'off']),
    flag: z.enum(['on', 'off']),
    approval_ref_set: z.boolean(),
    last_changed_at: AT,
  })
  .strict();

export const CloudStatusSchema = z
  .object({
    checked_at: AT,
    project: z.string().regex(CLOUD_PROJECT_PATTERN),
    services: z.tuple([Web, JobLoop, Database, Judge, Gateway]),
  })
  .strict();
export type CloudStatus = z.infer<typeof CloudStatusSchema>;
