import { z } from 'zod';

/**
 * The remediation API (`/api/remediation/*`): a customer's vulnerable devices across every
 * hospital, sliced by any combination of dimensions, and the remediation projects made from them.
 * The customer is the sandbox `?h=` id; every read and write is scoped to it on the server.
 */

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Where a device stands: in no project yet, in an open project, or in a finished one. */
export const DEVICE_STATUSES = ['Unplanned', 'Planned', 'Remediated'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const PROJECT_STATUSES = ['Open', 'In progress', 'Done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** The facets a fleet can be sliced by. Each one is a filter, a facet count, and a grid column. */
export const DIMENSIONS = [
  'severity',
  'status',
  'hospital',
  'deviceClass',
  'manufacturer',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const SORT_FIELDS = [
  'assetTag',
  'model',
  'deviceClass',
  'manufacturer',
  'hospital',
  'cve',
  'cvss',
  'severity',
  'status',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const PAGE_SIZES = [25, 50, 100] as const;
/** One project holds at most this many devices, so "everything matching" stays a sane batch. */
export const MAX_PROJECT_DEVICES = 500;

export interface Device {
  id: string;
  assetTag: string;
  model: string;
  deviceClass: string;
  manufacturer: string;
  hospital: string;
  cve: string;
  cvss: number;
  severity: Severity;
  status: DeviceStatus;
}

export type Filters = Partial<Record<Dimension, string[]>>;

export interface DeviceQuery {
  filters: Filters;
  /** Free text over asset tag, model, and CVE. */
  q: string;
  sort: SortField;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface DevicePage {
  rows: Device[];
  /** Devices matching the whole query. */
  total: number;
  page: number;
  pageSize: number;
  /**
   * Per dimension, the count for each value under every *other* active filter, so picking a
   * second hospital still shows how many devices it would add.
   */
  facets: Record<Dimension, FacetCount[]>;
}

export interface RemediationProject {
  id: string;
  name: string;
  status: ProjectStatus;
  deviceIds: string[];
  createdAt: string;
}

export const DEFAULT_QUERY: DeviceQuery = {
  filters: {},
  q: '',
  sort: 'cvss',
  dir: 'desc',
  page: 1,
  pageSize: PAGE_SIZES[0],
};

const MAX_Q = 80;

function oneOf<T extends string>(values: readonly T[], raw: string | null, fallback: T): T {
  return values.includes(raw as T) ? (raw as T) : fallback;
}

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The slice of `URLSearchParams` the parser needs (this package has no DOM or Node types). */
export interface QueryParams {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/** Reads a query from URL params; anything unknown or malformed falls back to the default. */
export function parseDeviceQuery(params: QueryParams): DeviceQuery {
  const filters: Filters = {};
  for (const dim of DIMENSIONS) {
    const values = params.getAll(dim).filter((v) => v.trim() !== '');
    if (values.length > 0) filters[dim] = [...new Set(values)];
  }
  const size = Number(params.get('size'));
  return {
    filters,
    q: (params.get('q') ?? '').trim().slice(0, MAX_Q),
    sort: oneOf(SORT_FIELDS, params.get('sort'), DEFAULT_QUERY.sort),
    dir: oneOf(['asc', 'desc'], params.get('dir'), DEFAULT_QUERY.dir),
    page: positiveInt(params.get('page'), 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_QUERY.pageSize,
  };
}

/**
 * The inverse of `parseDeviceQuery` as `[name, value]` pairs (feed them to `URLSearchParams`),
 * leaving out defaults so URLs stay short.
 */
export function deviceQueryEntries(query: DeviceQuery): [string, string][] {
  const entries: [string, string][] = [];
  for (const dim of DIMENSIONS) for (const v of query.filters[dim] ?? []) entries.push([dim, v]);
  if (query.q) entries.push(['q', query.q]);
  if (query.sort !== DEFAULT_QUERY.sort) entries.push(['sort', query.sort]);
  if (query.dir !== DEFAULT_QUERY.dir) entries.push(['dir', query.dir]);
  if (query.page !== 1) entries.push(['page', String(query.page)]);
  if (query.pageSize !== DEFAULT_QUERY.pageSize) entries.push(['size', String(query.pageSize)]);
  return entries;
}

const filtersSchema = z.partialRecord(z.enum(DIMENSIONS), z.array(z.string().min(1)).max(50));

/**
 * Create from hand-picked devices, or from everything matching a filter. Exactly one of the two:
 * a filter is resolved on the server, inside the caller's own fleet.
 */
export const CreateProjectSchema = z.union([
  z.object({
    name: z.string().trim().min(1).max(80),
    deviceIds: z.array(z.string().min(1)).min(1).max(MAX_PROJECT_DEVICES),
  }),
  z.object({
    name: z.string().trim().min(1).max(80),
    match: z.object({ filters: filtersSchema, q: z.string().max(MAX_Q).default('') }),
  }),
]);
export type CreateProjectRequest = z.input<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({ status: z.enum(PROJECT_STATUSES) });
