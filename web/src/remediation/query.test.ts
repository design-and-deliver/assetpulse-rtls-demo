import { DEFAULT_QUERY, MAX_PROJECT_DEVICES, type Device } from '@assetpulse/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createRemediationApi } from './api';
import {
  activeChips,
  clearFilters,
  hasActiveFilters,
  matchBlocker,
  nextProjectStatus,
  orderFacet,
  pageSelection,
  projectsWith,
  querySearch,
  rangeLabel,
  readQuery,
  setSort,
  showVulnerability,
  toggleFilter,
  toggleOne,
  togglePage,
} from './query';

const device = (id: string): Device => ({
  id,
  assetTag: id.toUpperCase(),
  model: 'Alaris 8015',
  deviceClass: 'Infusion pump',
  manufacturer: 'BD',
  hospital: 'St. Mary',
  cve: 'CVE-2024-1001',
  cvss: 9.8,
  severity: 'Critical',
  status: 'Unplanned',
});

describe('URL state', () => {
  it('round-trips the customer and the view through the query string', () => {
    const query = {
      ...DEFAULT_QUERY,
      filters: { severity: ['Critical', 'High'] },
      q: 'alaris',
      page: 3,
    };
    const search = querySearch('hosp0001', query);
    expect(search).toBe('?h=hosp0001&severity=Critical&severity=High&q=alaris&page=3');
    expect(readQuery(search)).toEqual(query);
  });

  it('leaves defaults out, so a fresh view is just ?h=', () => {
    expect(querySearch('hosp0001', DEFAULT_QUERY)).toBe('?h=hosp0001');
  });
});

describe('filters', () => {
  it('adds and removes a value, dropping an emptied dimension and returning to page 1', () => {
    const on = toggleFilter({ ...DEFAULT_QUERY, page: 4 }, 'hospital', 'St. Mary');
    expect(on).toMatchObject({ filters: { hospital: ['St. Mary'] }, page: 1 });
    expect(toggleFilter(on, 'hospital', 'St. Mary').filters).toEqual({});
  });

  it('lists chips in dimension order and clears filters and search together', () => {
    let q = toggleFilter(DEFAULT_QUERY, 'manufacturer', 'BD');
    q = toggleFilter(q, 'severity', 'High');
    expect(activeChips(q)).toEqual([
      { dim: 'severity', value: 'High' },
      { dim: 'manufacturer', value: 'BD' },
    ]);
    const cleared = clearFilters({ ...q, q: 'mri' });
    expect(hasActiveFilters(cleared)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_QUERY, q: 'mri' })).toBe(true);
  });

  it('orders severity canonically, other facets by count, and keeps a selected zero', () => {
    expect(
      orderFacet('severity', [
        { value: 'Low', count: 9 },
        { value: 'Critical', count: 2 },
      ]).map((c) => c.value),
    ).toEqual(['Critical', 'Low']);
    expect(
      orderFacet(
        'hospital',
        [
          { value: 'B', count: 3 },
          { value: 'A', count: 3 },
          { value: 'C', count: 7 },
        ],
        ['Z'],
      ),
    ).toEqual([
      { value: 'C', count: 7 },
      { value: 'A', count: 3 },
      { value: 'B', count: 3 },
      { value: 'Z', count: 0 },
    ]);
  });
});

describe('sorting', () => {
  it('flips the same column and starts numbers high-first, text A-first', () => {
    const byCvss = setSort({ ...DEFAULT_QUERY, sort: 'model' }, 'cvss');
    expect(byCvss).toMatchObject({ sort: 'cvss', dir: 'desc' });
    expect(setSort(byCvss, 'cvss').dir).toBe('asc');
    expect(setSort(byCvss, 'hospital')).toMatchObject({ sort: 'hospital', dir: 'asc' });
  });
});

describe('selection and paging', () => {
  const rows = [device('a'), device('b')];

  it('reports none, some, or all of the page selected', () => {
    expect(pageSelection(rows, new Set())).toBe('none');
    expect(pageSelection(rows, new Set(['a', 'x']))).toBe('some');
    expect(pageSelection(rows, new Set(['a', 'b']))).toBe('all');
  });

  it('selects the page, then clears only the page, keeping selections from other pages', () => {
    const all = togglePage(rows, new Set(['x']));
    expect([...all].sort()).toEqual(['a', 'b', 'x']);
    expect([...togglePage(rows, all)]).toEqual(['x']);
    expect([...toggleOne(new Set(['a']), 'a')]).toEqual([]);
  });

  it('narrows the grid to one vulnerability, keeping the sort and page size', () => {
    const query = {
      ...toggleFilter(DEFAULT_QUERY, 'severity', 'High'),
      q: 'pump',
      page: 3,
      pageSize: 50,
    };
    expect(showVulnerability(query, 'CVE-2026-90011')).toEqual({
      ...DEFAULT_QUERY,
      q: 'CVE-2026-90011',
      pageSize: 50,
    });
  });

  it('finds the projects a device is in', () => {
    const project = (id: string, deviceIds: string[]) =>
      ({ id, name: id, status: 'Open', deviceIds, createdAt: '' }) as const;
    const projects = [project('p1', ['a', 'b']), project('p2', ['c']), project('p3', ['a'])];
    expect(projectsWith(projects, 'a').map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(projectsWith(projects, 'z')).toEqual([]);
  });

  it('labels the visible range', () => {
    expect(rangeLabel(1, 25, 312)).toBe('1–25 of 312');
    expect(rangeLabel(13, 25, 312)).toBe('301–312 of 312');
    expect(rangeLabel(1, 25, 0)).toBe('0 of 0');
  });
});

describe('projects', () => {
  it('advances Open → In progress → Done, then stops', () => {
    expect(nextProjectStatus('Open')).toBe('In progress');
    expect(nextProjectStatus('In progress')).toBe('Done');
    expect(nextProjectStatus('Done')).toBeNull();
  });

  it('blocks create-from-match when nothing or too much matches', () => {
    expect(matchBlocker(0)).toMatch(/Nothing matches/);
    expect(matchBlocker(MAX_PROJECT_DEVICES)).toBeNull();
    expect(matchBlocker(MAX_PROJECT_DEVICES + 1)).toMatch(/up to 500/);
  });
});

describe('api client', () => {
  it('scopes every call to the customer and surfaces the server error message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ rows: [] }))
      .mockResolvedValueOnce(
        Response.json({ error: 'One or more devices were not found.' }, { status: 404 }),
      );
    const api = createRemediationApi('hosp0001', fetchMock);
    await api.devices({ ...DEFAULT_QUERY, filters: { severity: ['High'] } });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/remediation/devices?h=hosp0001&severity=High');
    await expect(api.createProject({ name: 'Patch', deviceIds: ['zzz'] })).rejects.toThrow(
      'One or more devices were not found.',
    );
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/remediation/projects?h=hosp0001');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });
});
