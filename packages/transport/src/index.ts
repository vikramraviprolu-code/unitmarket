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
  PRODUCTION_WIRE,
  SCOPE_OPERATIONS,
} from './sandbox';
// FIX-MVPB-SEAL2 H1: the minter itself is not exported. `claimApprovalMinter` hands it out once
// (to @umsbx/safety, when it loads); lint (sbx/sealed-transport) bars every other importer.
export { claimApprovalMinter } from './approval';
export type { ApprovalCapability, GateTrust, MintApprovalCapability } from './approval';
export type { ApprovedSandboxOptions, SandboxCall, SandboxTransport } from './sandbox';
export type { ScopedGate, Wire, WireErrorKind, WireRequest, WireResult } from './wire';
export { MAX_RESPONSE_BYTES } from './wire-map';
export { wireSelfCheck } from './wire-selfcheck';
export type { WireSelfCheck } from './wire-selfcheck';
// AI-A (D-067): the one egress to the model API. The factory and limits only; the error class and exchange helper stay internal.
export {
  MODEL_API,
  MODEL_API_VERSION,
  MODEL_DEADLINE_MS,
  MODEL_MAX_REQUEST_BYTES,
  MODEL_MAX_RESPONSE_BYTES,
  MODEL_PATH,
  createModelHttps,
} from './model-https';
// MC2-L4 (D-085): the one egress to the ECB euro reference rates. The factory, the result types and the
// limits only; the parser, the error class and the exchange helper stay internal.
export {
  ECB_API,
  ECB_DEADLINE_MS,
  ECB_MAX_RESPONSE_BYTES,
  ECB_PATH,
  createEcbFetch,
} from './fx-ecb';
export type { EcbErrorKind, EcbFetchResult, EcbRates } from './fx-ecb';
