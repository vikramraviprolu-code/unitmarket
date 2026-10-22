import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  // The workspace packages are TypeScript sources.
  transpilePackages: [
    '@umsbx/access-clock',
    '@umsbx/approval',
    '@umsbx/catalogue',
    '@umsbx/config',
    '@umsbx/contracts',
    '@umsbx/db',
    '@umsbx/delivery',
    '@umsbx/discovery',
    '@umsbx/entitlements',
    '@umsbx/fit',
    '@umsbx/ledger',
    '@umsbx/model',
    '@umsbx/obs',
    '@umsbx/offer-entry',
    '@umsbx/paypal',
    '@umsbx/receipts',
    '@umsbx/runtime',
    '@umsbx/safety',
    '@umsbx/security',
    '@umsbx/transport',
  ],
  serverExternalPackages: ['@electric-sql/pglite'],
  outputFileTracingRoot: resolve(here, '../..'),
  // Route files export `routeMeta` (read by scripts/route-inventory.mjs), which Next's generated
  // route type check does not know. `pnpm typecheck` (tsc) covers these files instead.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack(cfg) {
    // packages/db finds its SQL migrations with new URL('../migrations', import.meta.url). Webpack
    // would try to bundle that directory as an asset; with url parsing off the URL is resolved at
    // run time against the source location instead.
    cfg.module.rules.push({ test: /packages[\\/]db[\\/]src[\\/].*\.ts$/, parser: { url: false } });
    return cfg;
  },
};

export default config;
