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
export {
  AUTH_RULES,
  FAIL_SAFE_WITHOUT_MFA_ROUTES,
  checkEntry,
  formatInventory,
  parseRouteMeta,
  pathFromFile,
} from './inventory';
// INT-CTL: which API groups partners may call.
export { MAX_EXPOSURE_CACHE_MS, createExposureReader } from './exposure';
export {
  ACCOUNT_FAILURE_MEMORY_MS,
  ACCOUNT_LOCK_BASE_MS,
  ACCOUNT_LOCK_CAP_MS,
  ACCOUNT_LOCK_THRESHOLD,
  PASSWORD_MAX,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN,
  USERNAME_PATTERN,
  changePassword,
  checkNewAccount,
  checkPasswordPolicy,
  createAccount,
  resetPasswordForOperator,
  revokeBuyerSessions,
  verifyAccountLogin,
} from './accounts';
export type {
  ChangePasswordResult,
  CreateAccountResult,
  LoginResult,
  PasswordRefusal,
  PolicyVerdict,
  ResetResult,
} from './accounts';
export {
  INVITE_ALPHABET,
  PUBLISHER_CLAIM_RATE,
  checkClaim,
  claimPublisherAccount,
  hashInviteCode,
  normalizeInviteCode,
  verifyPublisherLogin,
} from './publisher-accounts';
export type { ClaimCheck, ClaimResult, PublisherLoginResult } from './publisher-accounts';
export { runResetPassword } from './accounts-cli';
export type { ResetCliError, ResetCliResult } from './accounts-cli';
export {
  KEY_TOKEN_PATTERN,
  OPERATOR_REVOKE_REASONS,
  bearerToken,
  formatKeyToken,
  hasScopes,
  hashKeySecret,
  issueKey,
  listKeys,
  parseKeyToken,
  revokeKey,
  revokeKeyAsOperator,
  verifyKey,
} from './apikey';
export type {
  ApiKeyDeps,
  IssueError,
  IssueInput,
  IssuedKey,
  OperatorRevokeKeyError,
  OperatorRevokeReason,
  VerifiedKey,
} from './apikey';
export { keyScope } from './idempotency';
