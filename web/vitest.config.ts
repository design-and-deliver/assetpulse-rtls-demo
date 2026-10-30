import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Like server/vitest.config.ts: resolve workspace packages to their TypeScript source, never a
// stale `dist` (the remediation helpers import protocol code that may not be built yet).
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: { conditions: ['source'] },
    ssr: { resolve: { conditions: ['source'] } },
  }),
);
