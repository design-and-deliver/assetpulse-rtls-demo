import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLOSE_BAD_FRAME, CLOSE_CAPACITY, HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import { WebSocketServer } from 'ws';
import { HistorySink } from './adapters/history-sink.js';
import { ServiceNowMock } from './adapters/servicenow-mock.js';
import { Connection } from './hub/connection.js';
import { WorldRegistry, type RegistryOptions } from './hub/world-registry.js';

export interface AppOptions extends Partial<RegistryOptions> {
  port?: number;
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

/** One HTTP server; `/ws` shares its port (App Service exposes exactly one). */
export async function startApp(options: AppOptions = {}): Promise<App> {
  const sink = options.sink ?? new HistorySink();
  const registry = new WorldRegistry({
    ...options,
    sink,
    serviceNow: options.serviceNow ?? new ServiceNowMock(),
  });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worlds: registry.size, sockets: wss.clients.size }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

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
      registry.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sink.flush();
    },
  };
}
