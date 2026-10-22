// Fake clock and seeded ids for tests. Thin re-export so tests import one place; the doubles live
// in packages/runtime (the only package that may read real time or draw randomness).
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { IsoUtc } from '@umsbx/contracts';

export const T0: IsoUtc = '2026-10-21T10:00:00.000Z';

export { fakeClock, seededIds };
