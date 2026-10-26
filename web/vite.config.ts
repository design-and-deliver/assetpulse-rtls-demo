import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The tour lives in public/tour/index.html. The server's static handler serves it at /tour, but
 * Vite's dev server would fall back to the console there, so point /tour at the file in dev too.
 */
const tourPage: Plugin = {
  name: 'tour-page',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/tour' || req.url === '/tour/') req.url = '/tour/index.html';
      next();
    });
  },
};

// `npm run dev` serves the console on :5173 and proxies the socket to the server's dev port.
export default defineConfig({
  plugins: [react(), tourPage],
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
      // The tech handheld (mobile/dist) is served by the server, so the embedded phone works here too.
      '^/tech(/|\\?|$)': { target: 'http://localhost:8787' },
    },
  },
});
