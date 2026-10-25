// @umsbx/paypal: PayPalPort over Transport. The only package besides safety that imports transport.
export const PACKAGE_NAME = '@umsbx/paypal' as const;

export { createPayPalAdapter } from './adapter';
export type { AdapterDeps, ProviderCallRecord } from './adapter';
export { mapError } from './errors';
export { fromDecimalString, minorUnitsFor, toDecimalString } from './money';
export {
  EXPECTED_CERT_PINS,
  createCertificateSource,
  isFullPin,
  pinComplete,
} from './webhook-cert';
export type {
  CertPin,
  CertificateFacts,
  CertificateSource,
  CertificateSourceWithStats,
  InspectResult,
} from './webhook-cert';
export { learnWebhookCertificate } from './webhook-learn';
export type { Describer, LearnResult } from './webhook-learn';
