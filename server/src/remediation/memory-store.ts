import { randomUUID } from 'node:crypto';
import {
  DIMENSIONS,
  type Device,
  type DevicePage,
  type DeviceQuery,
  type Dimension,
  type FacetCount,
  type Filters,
  type ProjectStatus,
  type RemediationProject,
  type SortField,
} from '@assetpulse/protocol';
import { generateFleet, type FleetDevice } from './fleet.js';
import { deviceStatusOf, SEVERITY_RANK, STATUS_RANK, type RemediationStore } from './store.js';

interface Tenant {
  fleet: FleetDevice[];
  projects: RemediationProject[];
}

type Comparable = string | number;
const SORT_KEY: Record<SortField, (d: Device) => Comparable> = {
  assetTag: (d) => d.assetTag,
  model: (d) => d.model,
  deviceClass: (d) => d.deviceClass,
  manufacturer: (d) => d.manufacturer,
  hospital: (d) => d.hospital,
  cve: (d) => d.cve,
  cvss: (d) => d.cvss,
  severity: (d) => SEVERITY_RANK[d.severity],
  status: (d) => STATUS_RANK[d.status],
};

function matchesText(d: Device, q: string): boolean {
  const needle = q.toLowerCase();
  return [d.assetTag, d.model, d.cve].some((field) => field.toLowerCase().includes(needle));
}

/** Every active filter except `skip` (the facet being counted) holds, and the text matches. */
export function matches(d: Device, filters: Filters, q: string, skip?: Dimension): boolean {
  const dimsOk = DIMENSIONS.every((dim) => {
    const wanted = filters[dim];
    return dim === skip || !wanted?.length || wanted.includes(d[dim]);
  });
  return dimsOk && (!q || matchesText(d, q));
}

function facetsOf(devices: Device[], filters: Filters, q: string): DevicePage['facets'] {
  const facets = {} as DevicePage['facets'];
  for (const dim of DIMENSIONS) {
    const counts = new Map<string, number>();
    for (const d of devices) {
      if (matches(d, filters, q, dim)) counts.set(d[dim], (counts.get(d[dim]) ?? 0) + 1);
    }
    facets[dim] = [...counts].map(([value, count]): FacetCount => ({ value, count }));
    facets[dim].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return facets;
}

function sorted(devices: Device[], sort: SortField, dir: 'asc' | 'desc'): Device[] {
  const key = SORT_KEY[sort];
  const sign = dir === 'asc' ? 1 : -1;
  // Ties break on the asset tag, so paging is stable whatever the sort.
  return [...devices].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    const primary = ka < kb ? -1 : ka > kb ? 1 : 0;
    return primary * sign || a.assetTag.localeCompare(b.assetTag);
  });
}

/** Sandbox ids are free to mint, so the oldest customers are dropped past this many. */
const MAX_TENANTS = 500;

/** The default store: per-customer fleets and projects in this process, gone on restart. */
export class MemoryStore implements RemediationStore {
  private readonly tenants = new Map<string, Tenant>();

  constructor(private readonly maxTenants = MAX_TENANTS) {}

  private tenant(customerId: string): Tenant {
    let tenant = this.tenants.get(customerId);
    if (!tenant) {
      tenant = { fleet: generateFleet(customerId), projects: [] };
      this.tenants.set(customerId, tenant);
      if (this.tenants.size > this.maxTenants) {
        this.tenants.delete(this.tenants.keys().next().value!);
      }
    }
    return tenant;
  }

  /** The fleet with each device's status worked out from the projects it is in. */
  private fleet(customerId: string): Device[] {
    const { fleet, projects } = this.tenant(customerId);
    const statuses = new Map<string, ProjectStatus[]>();
    for (const p of projects) {
      for (const id of p.deviceIds) statuses.set(id, [...(statuses.get(id) ?? []), p.status]);
    }
    return fleet.map((d) => ({ ...d, status: deviceStatusOf(statuses.get(d.id) ?? []) }));
  }

  async devices(customerId: string, query: DeviceQuery): Promise<DevicePage> {
    const all = this.fleet(customerId);
    const hits = all.filter((d) => matches(d, query.filters, query.q));
    const start = (query.page - 1) * query.pageSize;
    return {
      rows: sorted(hits, query.sort, query.dir).slice(start, start + query.pageSize),
      total: hits.length,
      page: query.page,
      pageSize: query.pageSize,
      facets: facetsOf(all, query.filters, query.q),
    };
  }

  async matchingIds(customerId: string, filters: Filters, q: string, limit: number) {
    return this.fleet(customerId)
      .filter((d) => matches(d, filters, q))
      .slice(0, limit)
      .map((d) => d.id);
  }

  async ownedIds(customerId: string, ids: string[]): Promise<Set<string>> {
    const wanted = new Set(ids);
    return new Set(
      this.tenant(customerId)
        .fleet.filter((d) => wanted.has(d.id))
        .map((d) => d.id),
    );
  }

  async projects(customerId: string): Promise<RemediationProject[]> {
    return [...this.tenant(customerId).projects].reverse();
  }

  async createProject(customerId: string, name: string, deviceIds: string[]) {
    const project: RemediationProject = {
      id: `prj_${randomUUID().slice(0, 8)}`,
      name,
      status: 'Open',
      deviceIds,
      createdAt: new Date().toISOString(),
    };
    this.tenant(customerId).projects.push(project);
    return project;
  }

  async updateProject(customerId: string, projectId: string, status: ProjectStatus) {
    const project = this.tenant(customerId).projects.find((p) => p.id === projectId);
    if (!project) return null;
    project.status = status;
    return project;
  }
}
