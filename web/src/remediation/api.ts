import type {
  CreateProjectRequest,
  DevicePage,
  DeviceQuery,
  ProjectStatus,
  RemediationProject,
} from '@assetpulse/protocol';
import { querySearch } from './query';

/** The page's whole view of the server; tests and the e2e can swap it out. */
export interface RemediationApi {
  devices(query: DeviceQuery, signal?: AbortSignal): Promise<DevicePage>;
  projects(signal?: AbortSignal): Promise<RemediationProject[]>;
  createProject(request: CreateProjectRequest): Promise<RemediationProject>;
  setProjectStatus(id: string, status: ProjectStatus): Promise<RemediationProject>;
}

const BASE = '/api/remediation';

/** The server's `{ error }` message when it sent one, so the alert says what actually went wrong. */
async function errorOf(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === 'string' ? body.error : `Request failed (${res.status}).`;
  return new Error(message);
}

/** Every call carries `?h=`: the server scopes reads and writes to that customer. */
export function createRemediationApi(
  hospitalId: string,
  fetchImpl: typeof fetch = fetch,
): RemediationApi {
  const h = `?h=${encodeURIComponent(hospitalId)}`;
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetchImpl(`${BASE}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    });
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  };
  return {
    devices: (query, signal) => call(`/devices${querySearch(hospitalId, query)}`, { signal }),
    projects: (signal) => call(`/projects${h}`, { signal }),
    createProject: (request) =>
      call(`/projects${h}`, { method: 'POST', body: JSON.stringify(request) }),
    setProjectStatus: (id, status) =>
      call(`/projects/${encodeURIComponent(id)}${h}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
  };
}
