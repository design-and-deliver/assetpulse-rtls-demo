import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript source, never a stale `dist`.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
});
