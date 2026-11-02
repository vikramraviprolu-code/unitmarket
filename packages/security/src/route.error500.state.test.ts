// SEC-HTTP500 (docs/specs/security-httpresult-500.md): a handler may answer with a typed 500. The
// wrapper sends it with the standard error envelope; a thrown error still gets the generic 500.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withRoute } from './route';
import type { HttpResult, RouteMeta } from './route';
import { ORIGIN, makeRig } from './test-support';

const meta: RouteMeta = {
  path: '/api/test/five-hundred',
  method: 'GET',
  auth: 'public',
  csrf: false,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};
const schema = z.object({}).strict();
const answer: HttpResult<Record<string, never>> = {
  status: 500,
  code: 'start_unknown',
  message: 'Check the switch before you try again.',
};
const get = () => new Request(`${ORIGIN}/api/test/five-hundred`, { method: 'GET' });

describe('a typed 500 answer', () => {
  it('is sent as HTTP 500 with the error envelope, the handler code and message, and a support code', async () => {
    const rig = await makeRig();
    const res = await withRoute(meta, schema, async () => answer)(rig.deps)(get(), {
      remote_addr: '198.51.100.1',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; support_code: string };
    };
    expect(body.error.code).toBe('start_unknown');
    expect(body.error.message).toBe('Check the switch before you try again.');
    expect(body.error.support_code).toMatch(/^E-[0-9a-f]{8}$/);
  });
});
