import { startApp } from './app.js';

const app = await startApp({ port: Number(process.env.PORT ?? 8787) });
console.log(`[assetpulse] listening on :${app.port} (ws at /ws)`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[assetpulse] ${signal}: closing`);
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
