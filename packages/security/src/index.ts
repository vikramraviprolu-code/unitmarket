// @umsbx/security (lane 11): route wrapper, sessions, CSRF, rate limits, headers, idempotency.
export const PACKAGE_NAME = '@umsbx/security' as const;

export { withRoute, notFoundUnlessOwner, MAX_BODY_CEILING } from './route';
export type { RouteCallContext } from './route';
export { IDEMPOTENCY_PENDING_TTL_MS } from './idempotency';
export type {
  AuthRule,
  HttpResult,
  RateRule,
  RouteContext,
  RouteMeta,
  SecurityDeps,
} from './route';
export {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  clearSessionCookie,
  createSession,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from './session';
export { hashPasscode, verifyPasscode } from './passcode';
export {
  OPERATOR_NAME,
  TOTP_FAIL_RULE,
  TOTP_ISSUER,
  TOTP_MIN_KEY_BYTES,
  TOTP_USED_ACTION,
  UNVERIFIED_OPERATOR_ID,
  acceptTotp,
  base32Decode,
  base32Encode,
  isOperatorName,
  matchingSteps,
  operatorSignIn,
  otpauthUri,
  stepAt,
  totpCode,
} from './totp';
export type { OperatorSignIn, TotpVerdict } from './totp';
export { securityHeaders } from './headers';
export { DEFAULT_RATES, takeToken } from './rate';
export { AUTH_RULES, checkEntry, formatInventory, parseRouteMeta, pathFromFile } from './inventory';
