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
export { buildRecordings, formatSummary, writeRecordings } from './recorder';
export type {
  BuildResult,
  BuiltFile,
  RecorderOptions,
  Refusal,
  Summary,
  WriteResult,
} from './recorder';
export { validateFolderLabels } from './fixture-store';
export { recorderSelfTest } from './recorder-selftest';
export {
  MAX_REQUEST_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  SandboxSealedError,
  createApprovedSandboxTransport,
  createSandboxTransport,
  SCOPE_OPERATIONS,
} from './sandbox';
// FIX-MVPB-SEAL2 H1: the minter itself is not exported. `claimApprovalMinter` hands it out once
// (to @umsbx/safety, when it loads); lint (sbx/sealed-transport) bars every other importer.
export { claimApprovalMinter } from './approval';
export type { ApprovalCapability, GateTrust, MintApprovalCapability } from './approval';
export type { ApprovedSandboxOptions, SandboxCall, SandboxTransport } from './sandbox';
export type { ScopedGate, Wire, WireErrorKind, WireRequest, WireResult } from './wire';
export { MAX_RESPONSE_BYTES } from './wire-map';
