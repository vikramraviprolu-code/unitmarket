// The owner guide must stay in step with the kit: every refusal the kit can print is explained,
// the dry run comes before the real run, and no document holds anything that looks like a secret.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUSAL_CODES } from './spike';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('owner documents', () => {
  const runbook = read('docs/owner/SPIKE-RUNBOOK.md');
  const form = read('docs/owner/EVIDENCE-TEMPLATE.md');
  it('explains every refusal code', () => {
    for (const code of REFUSAL_CODES) expect(runbook, code).toContain(code);
  });
  it('puts the dry run before the real run and keeps the credential rules', () => {
    expect(runbook.indexOf('--dry-run')).toBeGreaterThan(0);
    expect(runbook.indexOf('--dry-run')).toBeLessThan(runbook.indexOf('SPIKE_MODE=read'));
    expect(runbook).toMatch(/never (go into|paste)/i);
    expect(runbook).toContain('read -s PAYPAL_CLIENT_SECRET');
  });
  it('covers steps 1 to 5 and the never-share list in the form and guide', () => {
    for (const h of ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']) expect(form).toContain(h);
    expect(runbook).toContain('What you never share');
  });
  it('carries the SPIKE GO row template, the machine rules and the evidence-handling rules (H1, M1, L7)', () => {
    expect(runbook).toContain(
      'SPIKE GO: scope=spike-read; operator=vikram; valid_until=YYYY-MM-DD',
    );
    expect(runbook).toMatch(/approved in writing YYYY-MM-DD/);
    expect(runbook).toMatch(
      /own machine, off any corporate VPN, and never inside a cloud, remote or AI container/,
    );
    expect(runbook).toMatch(/Git Bash/);
    expect(runbook).toMatch(/WSL/);
    expect(runbook).toMatch(/outside the repository/);
    expect(runbook).toMatch(/clear the clipboard/);
  });
  it('holds no real SPIKE GO row in the decision log', () => {
    expect(read('docs/decision-log.md')).not.toContain('SPIKE GO:');
  });
  it('holds no token, key or email-like value', () => {
    for (const doc of [runbook, form]) {
      expect(doc).not.toMatch(/A21[A-Za-z0-9_-]{15,}/);
      expect(doc).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/i);
      expect(doc).not.toMatch(/\b[A-Za-z0-9_-]{40,}\b/);
    }
  });
});
