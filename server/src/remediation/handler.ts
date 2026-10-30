import type http from 'node:http';
import {
  CreateProjectSchema,
  HOSPITAL_ID_PATTERN,
  MAX_PROJECT_DEVICES,
  parseDeviceQuery,
  UpdateProjectSchema,
} from '@assetpulse/protocol';
import type { RemediationStore } from './store.js';

/**
 * `/api/remediation/*`, scoped to the customer in `?h=`:
 * - `GET   devices`        → one page of the fleet, plus facet counts (`DevicePage`)
 * - `GET   projects`       → the customer's remediation projects, newest first
 * - `POST  projects`       → create from `deviceIds`, or from everything that `match`es a filter
 * - `PATCH projects/<id>`  → move a project to a new status
 * A device id the customer does not own is answered 404, not 403: a 403 would confirm the id
 * exists for someone else.
 */

export const REMEDIATION_PREFIX = '/api/remediation/';
/** Enough for MAX_PROJECT_DEVICES ids and a name. */
const MAX_BODY = 32_768;

type Respond = (status: number, body: unknown) => void;
interface Request {
  customerId: string;
  url: URL;
  body: () => Promise<unknown>;
  respond: Respond;
}
type Route = (req: Request, param: string) => Promise<void>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_BODY) reject(new HttpError(400, 'Request body is too large.'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Request body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown) {
  const result = schema.safeParse(v);
  if (!result.success) throw new HttpError(400, 'Request body is not valid.');
  return result.data as T;
}

async function deviceIdsFor(store: RemediationStore, customerId: string, body: unknown) {
  const request = parsed(CreateProjectSchema, body);
  if ('deviceIds' in request) {
    const ids = [...new Set(request.deviceIds)];
    const owned = await store.ownedIds(customerId, ids);
    if (owned.size !== ids.length) throw new HttpError(404, 'One or more devices were not found.');
    return { name: request.name, ids };
  }
  const { filters, q } = request.match;
  const ids = await store.matchingIds(customerId, filters, q, MAX_PROJECT_DEVICES + 1);
  if (ids.length === 0) throw new HttpError(400, 'No devices match that filter.');
  if (ids.length > MAX_PROJECT_DEVICES) {
    throw new HttpError(400, `A project holds at most ${MAX_PROJECT_DEVICES} devices.`);
  }
  return { name: request.name, ids };
}

function routesFor(store: RemediationStore): Record<string, Route> {
  return {
    'GET devices': async ({ customerId, url, respond }) =>
      respond(200, await store.devices(customerId, parseDeviceQuery(url.searchParams))),
    'GET projects': async ({ customerId, respond }) =>
      respond(200, await store.projects(customerId)),
    'POST projects': async ({ customerId, body, respond }) => {
      const { name, ids } = await deviceIdsFor(store, customerId, await body());
      respond(201, await store.createProject(customerId, name, ids));
    },
    'PATCH projects/:id': async ({ customerId, body, respond }, id) => {
      const { status } = parsed(UpdateProjectSchema, await body());
      const project = await store.updateProject(customerId, id, status);
      if (!project) throw new HttpError(404, 'Project not found.');
      respond(200, project);
    },
  };
}

/** `projects/prj_1` → route `projects/:id` with param `prj_1`; anything deeper is unknown. */
function routeKey(method: string, path: string): [key: string, param: string] {
  const [head, param, ...rest] = path.split('/');
  if (param === undefined) return [`${method} ${head}`, ''];
  return rest.length === 0 && param ? [`${method} ${head}/:id`, param] : ['', ''];
}

export function remediationHandler(store: RemediationStore) {
  const routes = routesFor(store);
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const respond: Respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [key, param] = routeKey(
      req.method ?? 'GET',
      url.pathname.slice(REMEDIATION_PREFIX.length),
    );
    const route = routes[key];
    if (!route) return respond(404, { error: 'not found' });
    const customerId = url.searchParams.get('h') ?? '';
    if (!HOSPITAL_ID_PATTERN.test(customerId)) {
      return respond(400, { error: 'h must be 8 chars [a-z0-9]' });
    }
    route({ customerId, url, body: () => readJson(req), respond }, param).catch((err: unknown) => {
      if (err instanceof HttpError) return respond(err.status, { error: err.message });
      console.error('[remediation]', err);
      respond(502, { error: 'Remediation data is unavailable. Try again in a moment.' });
    });
  };
}
