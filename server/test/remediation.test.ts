import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_QUERY,
  deviceQueryEntries,
  parseDeviceQuery,
  type DevicePage,
  type DeviceQuery,
  type RemediationProject,
} from '@assetpulse/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HistorySink } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';
import { startApp, type App } from '../src/app.js';
import { generateFleet, severityOf } from '../src/remediation/fleet.js';
import { remediationStore } from '../src/remediation/index.js';
import { MemoryStore } from '../src/remediation/memory-store.js';
import { SnowflakeStore, whereOf } from '../src/remediation/snowflake-store.js';
import type { QueryResult } from '../src/snowflake/rest.js';

const ACME = 'acme0001';
const GLOBEX = 'globex01';
const query = (patch: Partial<DeviceQuery> = {}): DeviceQuery => ({ ...DEFAULT_QUERY, ...patch });

describe('generated fleet', () => {
  it('is the same for a customer every time, and different between customers', () => {
    expect(generateFleet(ACME)).toEqual(generateFleet(ACME));
    const acmeIds = new Set(generateFleet(ACME).map((d) => d.id));
    expect(acmeIds.size).toBe(320);
    expect(generateFleet(GLOBEX).some((d) => acmeIds.has(d.id))).toBe(false);
  });

  it('derives severity from CVSS bands', () => {
    expect([9.8, 9, 8.9, 7, 6.9, 4, 3.9].map(severityOf)).toEqual([
      'Critical',
      'Critical',
      'High',
      'High',
      'Medium',
      'Medium',
      'Low',
    ]);
  });
});

describe('device query in the URL', () => {
  it('round-trips, dropping defaults and ignoring unknown sorts and page sizes', () => {
    const q = query({ filters: { severity: ['Critical', 'High'] }, q: 'pump', page: 3 });
    const params = new URLSearchParams(deviceQueryEntries(q));
    expect(params.toString()).toBe('severity=Critical&severity=High&q=pump&page=3');
    expect(parseDeviceQuery(params)).toEqual(q);
    const hostile = parseDeviceQuery(new URLSearchParams('sort=CVSS;DROP&size=9999&page=-2'));
    expect(hostile).toMatchObject({ sort: 'cvss', pageSize: 25, page: 1 });
  });
});

describe('MemoryStore', () => {
  it('filters across dimensions, with OR inside a dimension and AND between them', async () => {
    const store = new MemoryStore();
    const filters = { severity: ['Critical', 'High'], hospital: ['Riverside General'] };
    const page = await store.devices(ACME, query({ filters, pageSize: 100 }));
    expect(page.total).toBeGreaterThan(0);
    for (const d of page.rows) {
      expect(['Critical', 'High']).toContain(d.severity);
      expect(d.hospital).toBe('Riverside General');
    }
  });

  it("counts each facet under every other filter, so a dimension's own pick doesn't zero its siblings", async () => {
    const store = new MemoryStore();
    const page = await store.devices(ACME, query({ filters: { severity: ['Critical'] } }));
    const severities = page.facets.severity.map((f) => f.value);
    expect(severities).toEqual(expect.arrayContaining(['Critical', 'High', 'Medium', 'Low']));
    const hospitalTotal = page.facets.hospital.reduce((sum, f) => sum + f.count, 0);
    expect(hospitalTotal).toBe(page.total);
  });

  it('searches asset tag, model, and CVE', async () => {
    const store = new MemoryStore();
    const page = await store.devices(ACME, query({ q: 'cve-2026-90011', pageSize: 100 }));
    expect(page.total).toBeGreaterThan(0);
    expect(page.rows.every((d) => d.cve === 'CVE-2026-90011')).toBe(true);
  });

  it('sorts severity by meaning and pages without overlap', async () => {
    const store = new MemoryStore();
    const [one, two] = await Promise.all([
      store.devices(ACME, query({ sort: 'severity', dir: 'desc', page: 1 })),
      store.devices(ACME, query({ sort: 'severity', dir: 'desc', page: 2 })),
    ]);
    expect(one.rows[0]!.severity).toBe('Critical');
    const ids = new Set(one.rows.map((d) => d.id));
    expect(two.rows.some((d) => ids.has(d.id))).toBe(false);
  });

  it('moves devices from Unplanned to Planned to Remediated with their project', async () => {
    const store = new MemoryStore();
    const [a, b] = (await store.devices(ACME, query())).rows;
    const project = await store.createProject(ACME, 'Patch', [a!.id, b!.id]);
    const statusOf = async () =>
      (await store.devices(ACME, query({ filters: { status: ['Planned', 'Remediated'] } }))).rows;
    expect((await statusOf()).map((d) => d.status)).toEqual(['Planned', 'Planned']);
    await store.updateProject(ACME, project.id, 'Done');
    expect((await statusOf()).map((d) => d.status)).toEqual(['Remediated', 'Remediated']);
  });

  it('keeps at most maxTenants customers', async () => {
    const store = new MemoryStore(1);
    const [first] = (await store.devices(ACME, query())).rows;
    await store.createProject(ACME, 'Patch', [first!.id]);
    await store.devices(GLOBEX, query());
    expect(await store.projects(ACME)).toEqual([]);
  });
});

describe('/api/remediation', () => {
  let app: App;
  let dir: string;
  const api = (p: string, init?: RequestInit) =>
    fetch(`http://localhost:${app.port}/api/remediation/${p}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
    });
  const post = (customer: string, body: unknown) =>
    api(`projects?h=${customer}`, { method: 'POST', body: JSON.stringify(body) });
  const devicesOf = async (customer: string, params = '') =>
    (await (await api(`devices?h=${customer}${params}`)).json()) as DevicePage;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'remediation-'));
    app = await startApp({
      sink: new HistorySink(dir),
      serviceNow: new ServiceNowMock(() => {}),
      snowflake: null,
    });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('needs a customer, and 404s unknown routes', async () => {
    expect((await api('devices')).status).toBe(400);
    expect((await api(`nope?h=${ACME}`)).status).toBe(404);
    expect((await api(`projects/a/b?h=${ACME}`, { method: 'PATCH' })).status).toBe(404);
  });

  it("serves a page of the caller's fleet with facets", async () => {
    const page = await devicesOf(ACME, '&severity=Critical&size=50');
    expect(page.pageSize).toBe(50);
    expect(page.rows.every((d) => d.severity === 'Critical')).toBe(true);
    expect(Object.keys(page.facets)).toEqual(
      expect.arrayContaining(['severity', 'status', 'hospital', 'deviceClass', 'manufacturer']),
    );
  });

  it('creates a project from picked devices, deduping ids', async () => {
    const [a, b] = (await devicesOf(ACME)).rows;
    const res = await post(ACME, { name: '  Patch pumps ', deviceIds: [a!.id, b!.id, a!.id] });
    expect(res.status).toBe(201);
    const project = (await res.json()) as RemediationProject;
    expect(project).toMatchObject({ name: 'Patch pumps', status: 'Open' });
    expect(project.deviceIds).toEqual([a!.id, b!.id]);
  });

  it("answers 404, not 403, for another customer's device, and saves nothing", async () => {
    const [mine] = (await devicesOf(GLOBEX)).rows;
    const [theirs] = (await devicesOf(ACME)).rows;
    const res = await post(GLOBEX, { name: 'Sneaky', deviceIds: [mine!.id, theirs!.id] });
    expect(res.status).toBe(404);
    expect(await (await api(`projects?h=${GLOBEX}`)).json()).toEqual([]);
  });

  it('creates a project from everything matching a filter', async () => {
    const filters = { severity: ['Critical'], manufacturer: ['Vantor Clinical'] };
    const expected = await devicesOf(
      ACME,
      '&severity=Critical&manufacturer=Vantor+Clinical&size=100',
    );
    const res = await post(ACME, { name: 'Vantor criticals', match: { filters } });
    expect(res.status).toBe(201);
    const project = (await res.json()) as RemediationProject;
    expect(project.deviceIds.sort()).toEqual(expected.rows.map((d) => d.id).sort());
  });

  it('rejects a blank name, no devices, a filter matching nothing, and bad JSON', async () => {
    const [a] = (await devicesOf(ACME)).rows;
    const bad = [
      { name: '   ', deviceIds: [a!.id] },
      { name: 'Empty', deviceIds: [] },
      { name: 'Nothing', match: { filters: { hospital: ['Nowhere'] } } },
    ];
    for (const body of bad) expect((await post(ACME, body)).status).toBe(400);
    const notJson = await api(`projects?h=${ACME}`, { method: 'POST', body: '{' });
    expect(notJson.status).toBe(400);
  });

  it("advances a project's status, and only the owner can", async () => {
    const [a] = (await devicesOf(ACME, '&status=Unplanned')).rows;
    const created = (await (
      await post(ACME, { name: 'Advance', deviceIds: [a!.id] })
    ).json()) as RemediationProject;
    const patch = (customer: string, status: string) =>
      api(`projects/${created.id}?h=${customer}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    expect((await patch(GLOBEX, 'Done')).status).toBe(404);
    expect((await patch(ACME, 'Finished')).status).toBe(400);
    const res = await patch(ACME, 'Done');
    expect(res.status).toBe(200);
    const remediated = await devicesOf(ACME, '&status=Remediated&size=100');
    expect(remediated.rows.map((d) => d.id)).toContain(a!.id);
  });

  it("lists only the caller's projects, newest first", async () => {
    const projects = (await (await api(`projects?h=${ACME}`)).json()) as RemediationProject[];
    expect(projects.length).toBeGreaterThan(1);
    const times = projects.map((p) => p.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(await (await api(`projects?h=${GLOBEX}`)).json()).toEqual([]);
  });
});

/** A fake SQL API: records every statement and answers by matching its text. */
function fakeSnowflake(answer: (sql: string) => (string | null)[][] = () => []) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const sf = {
    query: vi.fn(async (sql: string, binds: unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql, binds });
      return { columns: [], rows: answer(sql) };
    }),
  };
  return { sf, calls };
}

describe('SnowflakeStore', () => {
  it('binds the customer first and every filter value, never splicing values into SQL', () => {
    const where = whereOf(
      ACME,
      { hospital: ["O'Brien Memorial"], severity: ['Critical', 'High'] },
      'Pump',
    );
    expect(where.sql).toBe(
      'WHERE CUSTOMER_ID = ? AND SEVERITY IN (?, ?) AND HOSPITAL IN (?) AND ' +
        '(CONTAINS(LOWER(ASSET_TAG), ?) OR CONTAINS(LOWER(MODEL), ?) OR CONTAINS(LOWER(CVE), ?))',
    );
    expect(where.binds).toEqual([
      ACME,
      'Critical',
      'High',
      "O'Brien Memorial",
      'pump',
      'pump',
      'pump',
    ]);
  });

  it("seeds a new customer's fleet once, even under concurrent first requests", async () => {
    const { sf, calls } = fakeSnowflake((sql) =>
      sql.includes('COUNT(*) FROM REMEDIATION_DEVICES') ? [['0']] : [],
    );
    const store = new SnowflakeStore(sf);
    await Promise.all([store.devices(ACME, query()), store.devices(ACME, query())]);
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO REMEDIATION_DEVICES'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.binds).toHaveLength(320 * 10);
  });

  it('skips seeding when the customer already has devices', async () => {
    const { sf, calls } = fakeSnowflake((sql) => (sql.includes('COUNT(*)') ? [['320']] : []));
    await new SnowflakeStore(sf).devices(ACME, query());
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('pages and sorts with whitelisted SQL, and maps facet rows', async () => {
    const { sf, calls } = fakeSnowflake((sql) => {
      if (sql.includes('UNION ALL'))
        return [
          ['severity', 'Critical', '12'],
          ['hospital', 'Riverside General', '7'],
        ];
      if (sql.includes('COUNT(*) FROM REMEDIATION_FLEET')) return [['12']];
      if (sql.includes('COUNT(*)')) return [['320']];
      return [
        [
          'dev_1',
          'RG-IP-1001',
          'FlowSure 300',
          'Infusion pump',
          'Northwind Medical',
          'Riverside General',
          'CVE-2026-90011',
          '9.8',
          'Critical',
          'Unplanned',
        ],
      ];
    });
    const page = await new SnowflakeStore(sf).devices(
      ACME,
      query({ sort: 'severity', dir: 'asc', page: 3 }),
    );
    const select = calls.find((c) => c.sql.includes('LIMIT ? OFFSET ?'))!;
    expect(select.sql).toContain(
      "ORDER BY DECODE(SEVERITY, 'Critical', 4, 'High', 3, 'Medium', 2, 1) ASC, ASSET_TAG",
    );
    expect(select.binds.slice(-2)).toEqual([25, 50]);
    expect(page.total).toBe(12);
    expect(page.rows[0]).toMatchObject({ assetTag: 'RG-IP-1001', cvss: 9.8, severity: 'Critical' });
    expect(page.facets.severity).toEqual([{ value: 'Critical', count: 12 }]);
    expect(page.facets.status).toEqual([]);
  });

  it('writes the device links before the project row, so a failed create shows nothing', async () => {
    const { sf, calls } = fakeSnowflake((sql) =>
      sql.includes('LISTAGG')
        ? [['prj_1', 'Patch', 'Open', '2026-10-30T12:00:00.000Z', 'dev_1,dev_2']]
        : [],
    );
    const project = await new SnowflakeStore(sf).createProject(ACME, 'Patch', ['dev_1', 'dev_2']);
    const writes = calls.filter((c) => c.sql.includes('INSERT')).map((c) => c.sql);
    expect(writes[0]).toContain('REMEDIATION_PROJECT_DEVICES');
    expect(writes[1]).toContain('REMEDIATION_PROJECTS');
    expect(project.deviceIds).toEqual(['dev_1', 'dev_2']);
  });
});

describe('remediationStore', () => {
  it('falls back to memory, with one warning, when setup.sql has not been re-run', async () => {
    const { sf } = fakeSnowflake(() => []);
    const warn = vi.fn();
    const store = remediationStore(sf, { warn });
    const page = await store.devices(ACME, query());
    expect(page.total).toBe(320);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/missing REMEDIATION_DEVICES\.CUSTOMER_ID/);
  });
});
