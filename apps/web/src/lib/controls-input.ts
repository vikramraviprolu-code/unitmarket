// INT-CTL: shared input handling for the four control routes. The route wrapper merges the URL parameter into
// the body, so the schema allows the parameter and an optional reason code, and nothing else (strict). An
// unknown name is 404 whatever the reason code says; a missing or unlisted reason code is 400.
import { z } from 'zod';
import { EXPOSURE_REASON_CODES, SwitchNameSchema, isApiGroup } from '@umsbx/contracts';
import type { ApiGroup, SwitchName } from '@umsbx/contracts';

export const SwitchInput = z
  .object({ name: z.string().max(64), reason_code: z.string().max(32).optional() })
  .strict();
export const ExposureInput = z
  .object({ group: z.string().max(64), reason_code: z.string().max(32).optional() })
  .strict();

/** Typed to the statuses the wrapper accepts. */
export type Refusal = { status: 400 | 404; code: string; message: string };

export const NOT_FOUND: Refusal = { status: 404, code: 'not_found', message: 'Not found.' };
export const REASON_REQUIRED: Refusal = {
  status: 400,
  code: 'reason_code_required',
  message: 'Choose a reason: incident, partner request, maintenance or other.',
};

export function resolveSwitch(name: string): SwitchName | null {
  const r = SwitchNameSchema.safeParse(name);
  return r.success ? r.data : null;
}

/** The group name as the router hands it over: it may still be percent-encoded (`mcp%3Abuy_unit`). */
export function resolveGroup(raw: string): ApiGroup | null {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isApiGroup(text) ? text : null;
}

export function reasonCode(v: string | undefined): string | null {
  return v !== undefined && (EXPOSURE_REASON_CODES as readonly string[]).includes(v) ? v : null;
}
