import {
  DEVICE_STATUSES,
  DIMENSIONS,
  MAX_PROJECT_DEVICES,
  PROJECT_STATUSES,
  SEVERITIES,
  deviceQueryEntries,
  parseDeviceQuery,
  type Device,
  type DeviceQuery,
  type Dimension,
  type FacetCount,
  type ProjectStatus,
  type RemediationProject,
  type SortField,
} from '@assetpulse/protocol';

/** Pure view logic for the remediation page: URL state, filters, sorting, selection, paging. */

export const DIMENSION_LABELS: Record<Dimension, string> = {
  severity: 'Severity',
  status: 'Status',
  hospital: 'Hospital',
  deviceClass: 'Device class',
  manufacturer: 'Manufacturer',
};

/** Dimensions with a natural order keep it; the rest list by count, then name. */
const CANONICAL_ORDER: Partial<Record<Dimension, readonly string[]>> = {
  severity: SEVERITIES,
  status: DEVICE_STATUSES,
};

/** Numbers read best highest-first; text reads best A to Z. */
const DESC_FIRST = new Set<SortField>(['cvss', 'severity']);

export function readQuery(search: string): DeviceQuery {
  return parseDeviceQuery(new URLSearchParams(search));
}

/** `?h=…&…` for both the page URL and the API call: the customer first, then the view. */
export function querySearch(hospitalId: string, query: DeviceQuery): string {
  return `?${new URLSearchParams([['h', hospitalId], ...deviceQueryEntries(query)])}`;
}

/** Any change to what matches starts again on page 1. */
export function toggleFilter(query: DeviceQuery, dim: Dimension, value: string): DeviceQuery {
  const current = query.filters[dim] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const filters = { ...query.filters, [dim]: next };
  if (next.length === 0) delete filters[dim];
  return { ...query, filters, page: 1 };
}

export function clearFilters(query: DeviceQuery): DeviceQuery {
  return { ...query, filters: {}, q: '', page: 1 };
}

/** Every device with this vulnerability: the CVE alone, with the sort and page size kept. */
export function showVulnerability(query: DeviceQuery, cve: string): DeviceQuery {
  return { ...clearFilters(query), q: cve };
}

export function projectsWith(
  projects: RemediationProject[],
  deviceId: string,
): RemediationProject[] {
  return projects.filter((p) => p.deviceIds.includes(deviceId));
}

export function setSearch(query: DeviceQuery, q: string): DeviceQuery {
  return { ...query, q: q.trim(), page: 1 };
}

/** Same column flips the direction; a new column starts in its natural direction. */
export function setSort(query: DeviceQuery, field: SortField): DeviceQuery {
  if (query.sort === field) return { ...query, dir: query.dir === 'asc' ? 'desc' : 'asc', page: 1 };
  return { ...query, sort: field, dir: DESC_FIRST.has(field) ? 'desc' : 'asc', page: 1 };
}

export function hasActiveFilters(query: DeviceQuery): boolean {
  return query.q !== '' || DIMENSIONS.some((dim) => (query.filters[dim]?.length ?? 0) > 0);
}

export interface Chip {
  dim: Dimension;
  value: string;
}

export function activeChips(query: DeviceQuery): Chip[] {
  return DIMENSIONS.flatMap((dim) => (query.filters[dim] ?? []).map((value) => ({ dim, value })));
}

/**
 * The facet's values in display order. A selected value with no matches still shows (count 0),
 * so it can always be unticked.
 */
export function orderFacet(
  dim: Dimension,
  counts: FacetCount[],
  selected: string[] = [],
): FacetCount[] {
  const known = new Set(counts.map((c) => c.value));
  const all = [
    ...counts,
    ...selected.filter((v) => !known.has(v)).map((value) => ({ value, count: 0 })),
  ];
  const order = CANONICAL_ORDER[dim];
  if (order) return all.sort((a, b) => rank(order, a.value) - rank(order, b.value));
  return all.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function rank(order: readonly string[], value: string): number {
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

export function countOf(counts: FacetCount[] | undefined, value: string): number {
  return counts?.find((c) => c.value === value)?.count ?? 0;
}

/** "26–50 of 312"; "0 of 0" when nothing matches. */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return '0 of 0';
  const from = (page - 1) * pageSize + 1;
  return `${from}–${Math.min(page * pageSize, total)} of ${total}`;
}

export function pageCount(pageSize: number, total: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** How much of the visible page is selected: drives the header checkbox (and its indeterminate). */
export function pageSelection(
  rows: Device[],
  selected: ReadonlySet<string>,
): 'none' | 'some' | 'all' {
  const picked = rows.filter((d) => selected.has(d.id)).length;
  if (picked === 0) return 'none';
  return picked === rows.length ? 'all' : 'some';
}

/** Ticks every row on the page, or clears them all when the page is already fully ticked. */
export function togglePage(rows: Device[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const all = pageSelection(rows, selected) === 'all';
  for (const d of rows) {
    if (all) next.delete(d.id);
    else next.add(d.id);
  }
  return next;
}

export function toggleOne(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/** Open → In progress → Done; nothing after Done. */
export function nextProjectStatus(status: ProjectStatus): ProjectStatus | null {
  return PROJECT_STATUSES[PROJECT_STATUSES.indexOf(status) + 1] ?? null;
}

/** Why "create from all matching" is off, or null when it's allowed. */
export function matchBlocker(total: number): string | null {
  if (total === 0) return 'Nothing matches the current filters.';
  if (total > MAX_PROJECT_DEVICES) {
    return `A project holds up to ${MAX_PROJECT_DEVICES} devices; narrow the filters to ${MAX_PROJECT_DEVICES} or fewer.`;
  }
  return null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
