import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Pages that Vite's dev server would otherwise answer with the console. */
const DEV_PAGES = ['/tour', '/riskradar'];

/**
 * The tour lives in public/tour/index.html and the RiskRadar page is a second Vite entry
 * (riskradar/index.html). The server's static handler serves both by directory; point the dev
 * server at the same files, keeping the query string (the RiskRadar page reads `?h=`).
 */
const devPages: Plugin = {
  name: 'dev-pages',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path = '', query] = (req.url ?? '').split('?');
      const page = DEV_PAGES.find((p) => path === p || path === `${p}/`);
      if (page) req.url = `${page}/index.html${query === undefined ? '' : `?${query}`}`;
      next();
    });
  },
};

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// `npm run dev` serves the console on :5173 and proxies the socket to the server's dev port.
export default defineConfig({
  plugins: [react(), devPages],
  build: {
    rollupOptions: {
      input: { main: entry('./index.html'), riskradar: entry('./riskradar/index.html') },
    },
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
      // The tech handheld (mobile/dist) is served by the server, so the embedded phone works here too.
      '^/tech(/|\\?|$)': { target: 'http://localhost:8787' },
    },
  },
});
