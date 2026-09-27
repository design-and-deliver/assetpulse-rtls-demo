import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CLOSE_BAD_FRAME, CLOSE_CAPACITY, HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import sirv, { type RequestHandler } from 'sirv';
import { WebSocketServer } from 'ws';
import { HistorySink } from './adapters/history-sink.js';
import { ServiceNowMock } from './adapters/servicenow-mock.js';
import { Connection } from './hub/connection.js';
import { startHeartbeat } from './hub/heartbeat.js';
import { WorldRegistry, type RegistryOptions } from './hub/world-registry.js';

export interface AppOptions extends Partial<RegistryOptions> {
  port?: number;
  heartbeatMs?: number;
  /** Built web console, served at `/`. Skipped if the dir does not exist. */
  webDir?: string;
  /** Built tech handheld (Expo web export), served at `/tech`. Skipped if the dir does not exist. */
  techDir?: string;
}

export interface App {
  port: number;
  registry: WorldRegistry;
  sink: HistorySink;
  /** Stops the worlds, closes sockets and the HTTP server, then flushes history. */
  close(): Promise<void>;
}

function hospitalIdOf(req: http.IncomingMessage): string | null {
  const h = new URL(req.url ?? '/', 'http://localhost').searchParams.get('h');
  return h && HOSPITAL_ID_PATTERN.test(h) ? h : null;
}

const TECH_PREFIX = '/tech';
// Same relative hop from server/src (tsx) and server/dist (built).
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DEFAULT_TECH_DIR = fileURLToPath(new URL('../../mobile/dist', import.meta.url));

function spa(dir: string): RequestHandler | null {
  return existsSync(dir) ? sirv(dir, { single: true }) : null;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404).end();
}

/** `/tech` and `/tech/...` go to the tech build (prefix stripped); everything else to web. */
function staticHandler(webDir: string, techDir: string) {
  const web = spa(webDir);
  const tech = spa(techDir);
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? '/';
    const rest = url.slice(TECH_PREFIX.length);
    const isTech = url.startsWith(TECH_PREFIX) && (rest === '' || '/?'.includes(rest[0]!));
    const handler = isTech ? tech : web;
    if (!handler) return notFound(res);
    if (isTech) req.url = rest.startsWith('/') ? rest : `/${rest}`;
    handler(req, res, () => notFound(res));
  };
}

/** One HTTP server; `/ws` shares its port (App Service exposes exactly one). */
export async function startApp(options: AppOptions = {}): Promise<App> {
  const sink = options.sink ?? new HistorySink();
  const registry = new WorldRegistry({
    ...options,
    sink,
    serviceNow: options.serviceNow ?? new ServiceNowMock(),
  });

  const serveStatic = staticHandler(
    options.webDir ?? DEFAULT_WEB_DIR,
    options.techDir ?? DEFAULT_TECH_DIR,
  );
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          worlds: registry.size,
          sockets: wss.clients.size,
          positionSkips: registry.stats.positionSkips,
        }),
      );
      return;
    }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const stopHeartbeat = startHeartbeat(() => wss.clients, options.heartbeatMs);

  wss.on('connection', (ws, req) => {
    const hospitalId = hospitalIdOf(req);
    if (!hospitalId) return ws.close(CLOSE_BAD_FRAME, 'h must be 8 chars [a-z0-9]');
    const hub = registry.acquire(hospitalId);
    if (!hub) return ws.close(CLOSE_CAPACITY, 'server at world capacity');
    new Connection(ws, hub);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    registry,
    sink,
    async close() {
      stopHeartbeat();
      registry.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sink.flush();
    },
  };
}
