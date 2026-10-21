// Adapted from AIC_Hackathon_UnitMarket vitest.config.ts at a36ddc0. Owned by SBX.
import { configDefaults, defineConfig } from 'vitest/config';

// Six suites selected by file name, same convention as the simulation: unit (*.test.ts),
// state (*.state.test.ts), contract (*.contract.test.ts), integration (*.integration.test.ts),
// adversarial (*.adversarial.test.ts) and golden (*.golden.test.ts). Each runs as its own project.
const exclude = [...configDefaults.exclude, '**/.next/**', '**/dist/**', 'scripts/__fixtures__/**'];
const roots = ['apps/**', 'domain/**', 'packages/**', 'tools/**', 'scripts'];

const forms = (suffix: string) =>
  roots.flatMap((r) => [`${r}/*${suffix}.test.ts`, `${r}/*${suffix}.test.tsx`]);

const project = (name: string, include: string[], extraExclude: string[] = []) => ({
  test: {
    name,
    include,
    exclude: [...exclude, ...extraExclude],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      project('unit', forms(''), [
        '**/*.{state,contract,integration,adversarial,golden}.test.{ts,tsx}',
      ]),
      project('state', forms('.state')),
      project('contract', forms('.contract')),
      project('integration', forms('.integration')),
      project('adversarial', forms('.adversarial')),
      project('golden', forms('.golden')),
    ],
  },
});
