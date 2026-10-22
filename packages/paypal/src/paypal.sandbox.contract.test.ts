// Conformance suite against the PayPal sandbox. Owner-run only (MVP-B): skipped unless
// UMS_SANDBOX_TESTS=1, and the subject is built from @umsbx/config, so every gate applies
// (mode sandbox, connect on, outbound approval). MVP-A ships this file skipped.
import { describe, expect, it, vi } from 'vitest';
import { describePayPalConformance, sandboxSubject } from '@umsbx/testkit';

const enabled = import.meta.env['UMS_SANDBOX_TESTS'] === '1';

const subject = sandboxSubject();
const made = vi.fn(subject.make);
describe.skipIf(!enabled)('PayPal sandbox contract (owner-run, UMS_SANDBOX_TESTS=1)', () => {
  describePayPalConformance({ ...subject, make: made });
});

describe('PayPal sandbox contract guard', () => {
  it.skipIf(enabled)(
    'without UMS_SANDBOX_TESTS=1 the sandbox subject is never built and no socket opens',
    () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(made).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      const open = process
        .getActiveResourcesInfo()
        .filter((r) => r === 'TCPSocketWrap' || r === 'TCPConnectWrap' || r === 'TLSWrap');
      expect(open).toEqual([]);
      fetchSpy.mockRestore();
    },
  );
});
