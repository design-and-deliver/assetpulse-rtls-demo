import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest refuses a projects list that matches nothing, so only list workspaces that exist yet.
const hasPackages = existsSync('packages') && readdirSync('packages').length > 0;
const projects = [
  ...(hasPackages ? ['packages/*'] : []),
  ...['server', 'web'].filter((dir) => existsSync(dir)),
];

export default defineConfig({
  test: {
    ...(projects.length > 0 ? { projects } : {}),
    passWithNoTests: true,
  },
});
