// Adapted from AIC_Hackathon_UnitMarket vitest.config.ts at a36ddc0. Owned by SBX.
import { configDefaults, defineConfig } from 'vitest/config';

// Six suites selected by file name, same convention as the simulation: unit (*.test.ts),
// state (*.state.test.ts), contract (*.contract.test.ts), integration (*.integration.test.ts),
// adversarial (*.adversarial.test.ts) and golden (*.golden.test.ts). Each runs as its own project.
const exclude = [...configDefaults.exclude, '**/.next/**', '**/dist/**', 'scripts/__fixtures__/**'];
// BU-3: the next start proof builds and starts the real server (minutes, and it expects a clean git
// tree), so it is opt-in: the integration project skips it unless the command line names the file.
const NEXT_PROOF = 'scripts/next-start-proof.integration.test.ts';
const proofNamed = process.argv.some((a) => a.includes('next-start-proof.integration'));
const roots = ['apps/**', 'domain/**', 'packages/**', 'tools/**', 'tests/**', 'scripts'];

const forms = (suffix: string) =>
  roots.flatMap((r) => [`${r}/*${suffix}.test.ts`, `${r}/*${suffix}.test.tsx`]);

const project = (name: string, include: string[], extraExclude: string[] = []) => ({
  test: {
    name,
    include,
    exclude: [...exclude, ...extraExclude],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PG-1: a no-op unless UMS_TEST_DB=postgres (then every in-memory test database is a database on
    // one throwaway real Postgres; see packages/db/src/pg-test-setup.ts).
    setupFiles: ['packages/db/src/pg-test-setup.ts'],
  },
});

export default defineConfig({
  test: {
    maxWorkers: 2,
    globalSetup: ['packages/db/src/pg-global-setup.ts'],
    projects: [
      project('unit', forms(''), [
        '**/*.{state,contract,integration,adversarial,golden}.test.{ts,tsx}',
      ]),
      project('state', forms('.state')),
      project('contract', forms('.contract')),
      project('integration', forms('.integration'), proofNamed ? [] : [NEXT_PROOF]),
      project('adversarial', forms('.adversarial')),
      project('golden', forms('.golden')),
    ],
  },
});
