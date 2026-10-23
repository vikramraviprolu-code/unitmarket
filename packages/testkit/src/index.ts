// @umsbx/testkit: shared test helpers and the PayPalPort conformance suite (lane 16).
// For tests only: product code never imports it.
export const PACKAGE_NAME = '@umsbx/testkit' as const;

export { testDb } from './db';
export { T0, fakeClock, seededIds } from './clock';
export { seedTestCatalogue } from './catalogue';
export { createDryRunStack, createReqFor, dryRunSubject, testDeps } from './stack';
export type { DryRunStack, TestDeps } from './stack';
export { SANDBOX_LIMITS, ownerSubset, renderOwnerSummary, sandboxSubject } from './sandbox-subject';
export type {
  CallEvent,
  CallExchange,
  OwnerCaseId,
  OwnerCaseResult,
  OwnerRunReport,
  SandboxStop,
  SandboxStopCode,
  SandboxSubject,
  SandboxSubjectOptions,
} from './sandbox-subject';
export { describeDryRunOnly, describePayPalConformance } from './conformance';
export type { ConformanceHooks, ConformanceSubject } from './conformance';
export { dryRunScenarios } from './scenarios';
export type { DryRunScenario } from './scenarios';
