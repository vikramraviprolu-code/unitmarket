// INT-AL / AL.6: the pages of the operator shell, as data. The needs-you list links only to these; UI0 reads the
// same list. A path here has a page.tsx under apps/web/src/app (v1-needs-you.contract.test.ts checks it).
export const OPS_PAGES = [
  '/ops',
  '/ops/controls',
  '/ops/money',
  '/ops/sellers',
  '/ops/publishers',
  '/ops/payee-requests',
  '/ops/evals',
] as const;
export type OpsPage = (typeof OPS_PAGES)[number];
