import { z } from 'zod';
import { OPERATIONS, PATHS } from './endpoints';
import type { IsoUtc, PayPalOperation } from './temp-contracts';

// Fixture file format (lane 03 owns it). One file is one recorded or synthetic exchange:
// the nth call of `operation` within `scenario`. Unknown fields are refused at every level.
// Only `sandbox-recording` is evidence of PayPal behaviour; the other two labels are not.

export interface FixtureFile {
  meta: {
    source: 'docs-example' | 'synthetic' | 'sandbox-recording';
    scenario: string;
    operation: PayPalOperation;
    step: number;
    recorded_at: IsoUtc | null;
    origin: string;
    redactions: string[];
  };
  request: {
    method: 'GET' | 'POST';
    path_template: string;
    headers: Record<string, string>;
    body: unknown | null;
  };
  response: { status: number; headers: Record<string, string>; body: unknown } | { timeout: true };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const headers = z.record(z.string(), z.string());

const Meta = z
  .object({
    source: z.enum(['docs-example', 'synthetic', 'sandbox-recording']),
    scenario: z.string().regex(/^[a-z0-9_]{1,64}$/),
    operation: z.enum(OPERATIONS),
    step: z.number().int().min(1),
    recorded_at: z.string().regex(ISO_UTC).nullable(),
    origin: z.string().min(1),
    redactions: z.array(z.string()),
  })
  .strict();

const Request = z
  .object({
    method: z.enum(['GET', 'POST']),
    path_template: z.string().min(1),
    headers,
    body: z.unknown(),
  })
  .strict()
  .refine((r) => 'body' in r, { message: 'request.body must be present (use null)' });

const Response = z.union([
  z
    .object({
      status: z.number().int().min(100).max(599),
      headers,
      body: z.unknown(),
    })
    .strict()
    .refine((r) => 'body' in r, { message: 'response.body must be present' }),
  z.object({ timeout: z.literal(true) }).strict(),
]);

export const FixtureFileSchema = z
  .object({ meta: Meta, request: Request, response: Response })
  .strict()
  .superRefine((f, ctx) => {
    const spec = PATHS[f.meta.operation];
    if (f.request.method !== spec.method || f.request.path_template !== spec.template) {
      ctx.addIssue({
        code: 'custom',
        path: ['request'],
        message: `request must be ${spec.method} ${spec.template} for ${f.meta.operation}`,
      });
    }
    const recording = f.meta.source === 'sandbox-recording';
    if (recording !== (f.meta.recorded_at !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['meta', 'recorded_at'],
        message: 'recorded_at is required for a sandbox-recording and forbidden otherwise',
      });
    }
  });
