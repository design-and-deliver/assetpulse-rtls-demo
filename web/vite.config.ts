import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` serves the console on :5173 and proxies the socket to the server's dev port.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
