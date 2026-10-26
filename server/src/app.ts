import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CLOSE_BAD_FRAME, CLOSE_CAPACITY, HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import sirv, { type RequestHandler } from 'sirv';
import { WebSocketServer } from 'ws';
import { HistorySink, TeeSink, type EventSink } from './adapters/history-sink.js';
import { ServiceNowMock } from './adapters/servicenow-mock.js';
import { SnowflakeSink } from './adapters/snowflake-sink.js';
import { Connection } from './hub/connection.js';
import { startHeartbeat } from './hub/heartbeat.js';
import { WorldRegistry, type RegistryOptions } from './hub/world-registry.js';
import { loadSnowflakeConfig, type SnowflakeConfig } from './snowflake/config.js';
import { INSIGHTS_PREFIX, insightsHandler, localOrPublic } from './snowflake/insights.js';
import { SnowflakeRest } from './snowflake/rest.js';
import { checkSchema } from './snowflake/schema.js';

export interface AppOptions extends Partial<RegistryOptions> {
  port?: number;
  heartbeatMs?: number;
  /** Built web console, served at `/`. Skipped if the dir does not exist. */
  webDir?: string;
  /** Built tech handheld (Expo web export), served at `/tech`. Skipped if the dir does not exist. */
  techDir?: string;
  /**
   * Snowflake + Cortex layer. Defaults to the env (`SNOWFLAKE_ENABLED=1` plus credentials);
   * `null` forces it off. Off means no extra sink and only `/api/insights/status` answers.
   */
  snowflake?: SnowflakeConfig | null;
}

export interface App {
  port: number;
  registry: WorldRegistry;
  sink: EventSink;
  /** Stops the worlds, closes sockets and the HTTP server, then flushes history. */
  close(): Promise<void>;
}

function hospitalIdOf(req: http.IncomingMessage): string | null {
  const h = new URL(req.url ?? '/', 'http://localhost').searchParams.get('h');
  return h && HOSPITAL_ID_PATTERN.test(h) ? h : null;
}

const TECH_PREFIX = '/tech';
const TECH_NAME_PATH = '/api/tech-name';
const DEVICE_KEY_PATTERN = /^[a-z0-9]{8,32}$/;

/** `GET /api/tech-name?h=<hospital>&d=<device key>` → `{ name: "Tech 2" }`, stable per device. */
function techNameHandler(registry: WorldRegistry) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hospitalId = hospitalIdOf(req);
    const deviceKey = url.searchParams.get('d') ?? '';
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (!hospitalId || !DEVICE_KEY_PATTERN.test(deviceKey)) {
      return send(400, { error: 'h and d are required' });
    }
    const hub = registry.acquire(hospitalId);
    if (!hub) return send(503, { error: 'server at world capacity' });
    send(200, { name: hub.techName(deviceKey) });
  };
}
// Same relative hop from server/src (tsx) and server/dist (built).
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DEFAULT_TECH_DIR = fileURLToPath(new URL('../../mobile/dist', import.meta.url));

function spa(dir: string): RequestHandler | null {
  return existsSync(dir) ? sirv(dir, { single: true }) : null;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404).end();
}

/**
 * `/tech` and `/tech/...` go to the tech build (prefix stripped; its export is built with
 * `baseUrl: /tech`, so its asset URLs carry the prefix); everything else goes to web.
 */
function staticHandler(webDir: string, techDir: string) {
  const web = spa(webDir);
  const tech = spa(techDir);
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? '/';
    const rest = url.slice(TECH_PREFIX.length);
    const isTech =
      tech !== null && url.startsWith(TECH_PREFIX) && (rest === '' || '/?'.includes(rest[0]!));
    const handler = isTech ? tech : web;
    if (!handler) return notFound(res);
    if (isTech) req.url = rest.startsWith('/') ? rest : `/${rest}`;
    handler(req, res, () => notFound(res));
  };
}

/** One HTTP server; `/ws` shares its port (App Service exposes exactly one). */
/** Off unless configured. When on, events also batch to Snowflake and `/api/insights/*` answers. */
function snowflakeLayer(config: SnowflakeConfig | null) {
  if (!config) return { rest: null, schemaOk: () => null, sink: null };
  const rest = new SnowflakeRest(config);
  let schemaOk: boolean | null = null;
  void checkSchema(rest).then((ok) => (schemaOk = ok));
  return {
    rest,
    schemaOk: () => schemaOk,
    sink: new SnowflakeSink((statement, binds) => rest.query(statement, binds)),
  };
}

function snowflakeConfigFrom(options: AppOptions): SnowflakeConfig | null {
  if (options.snowflake !== undefined) return options.snowflake;
  const { config, missing } = loadSnowflakeConfig();
  if (missing.length > 0) console.warn(`[snowflake] off, missing: ${missing.join(', ')}`);
  return config;
}

export async function startApp(options: AppOptions = {}): Promise<App> {
  const snowflake = snowflakeLayer(snowflakeConfigFrom(options));
  const history = options.sink ?? new HistorySink();
  const sink = snowflake.sink ? new TeeSink([history, snowflake.sink]) : history;
  const insights = insightsHandler(snowflake.rest, {
    schemaOk: snowflake.schemaOk,
    visibleTo: localOrPublic(process.env.INSIGHTS_PUBLIC === '1'),
    sessionOf: (hospitalId) => registry.get(hospitalId)?.session ?? null,
  });
  const registry = new WorldRegistry({
    ...options,
    sink,
    serviceNow: options.serviceNow ?? new ServiceNowMock(),
  });

  const techName = techNameHandler(registry);
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
    if (req.url?.startsWith(INSIGHTS_PREFIX)) return insights(req, res);
    if (req.method === 'GET' && req.url?.startsWith(`${TECH_NAME_PATH}?`))
      return techName(req, res);
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
      snowflake.sink?.close();
    },
  };
}
