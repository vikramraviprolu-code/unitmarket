import { describe, expect, it } from 'vitest';
import { securityHeaders } from './headers';

describe('securityHeaders', () => {
  const nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const h = securityHeaders(nonce);

  it('headers contain every required header with a nonce', () => {
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
    expect(h['Strict-Transport-Security']).toContain('includeSubDomains');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
    const csp = h['Content-Security-Policy'] ?? '';
    for (const d of [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "frame-ancestors 'none'",
      "form-action 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('refuses a nonce that could inject into the header', () => {
    expect(() => securityHeaders("x'; script-src *")).toThrow();
    expect(() => securityHeaders('')).toThrow();
    expect(() => securityHeaders('a\r\nSet-Cookie: x=1')).toThrow();
  });
});
