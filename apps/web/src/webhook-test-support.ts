// CO-1d test support: the committed public test certificates (their keys were discarded) read from
// disk. Kept apart from webhook-support.ts so that file imports no node:fs (scripts/maintenance-flag.test.ts
// lists the production files that may). Not a test file.
import { readFileSync } from 'node:fs';

const read = (name: string): string =>
  readFileSync(new URL(`../../../fixtures/webhooks/synthetic/${name}`, import.meta.url), 'utf8');

export const PARSE_ONLY_PEM = read('parse-only.pem');
/** Subjects that audit and log redaction would change (CO-1d F2). Valid from 2026-10-25T13:28Z. */
export const EMAIL_SUBJECT_PEM = read('parse-only-email.pem');
export const TOKEN_SUBJECT_PEM = read('parse-only-token.pem');
