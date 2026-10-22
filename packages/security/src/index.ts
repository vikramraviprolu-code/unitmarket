// @umsbx/security (lane 11): route wrapper, sessions, CSRF, rate limits, headers, idempotency.
export const PACKAGE_NAME = '@umsbx/security' as const;

export { withRoute, notFoundUnlessOwner, MAX_BODY_CEILING } from './route';
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
} from './session';
export { hashPasscode, verifyPasscode } from './passcode';
export { securityHeaders } from './headers';
export { DEFAULT_RATES } from './rate';
export { AUTH_RULES, checkEntry, formatInventory, parseRouteMeta, pathFromFile } from './inventory';
