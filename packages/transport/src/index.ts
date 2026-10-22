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
export { createSandboxTransport } from './sandbox';
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
