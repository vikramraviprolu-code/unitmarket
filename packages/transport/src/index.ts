export const PACKAGE_NAME = '@umsbx/transport' as const;

export { CERT_HOST_SUFFIX, CERT_PATH_PREFIX, PATHS, SANDBOX_API } from './endpoints';
export type { PathSpec } from './endpoints';
export { guard } from './guard';
export type { GuardResult } from './guard';
export { FixtureFileSchema } from './fixture-schema';
export type { FixtureFile } from './fixture-schema';
export { buildIndex, loadFixtures } from './fixture-store';
export type { FixtureIndex, FixtureIndexEntry } from './fixture-store';
export { createDryRunTransport } from './dryrun';
export type { DryRunCall, DryRunTransport } from './dryrun';
export {
  MAX_REQUEST_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  SandboxSealedError,
  createApprovedSandboxTransport,
  createSandboxTransport,
} from './sandbox';
export type { ApprovedSandboxOptions, SandboxCall, SandboxTransport } from './sandbox';
export type { ScopedGate, Wire, WireErrorKind, WireRequest, WireResult } from './wire';
export { MAX_RESPONSE_BYTES } from './wire-map';
