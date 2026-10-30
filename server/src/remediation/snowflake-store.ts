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
import type { Bind, SnowflakeRest } from '../snowflake/rest.js';
import { generateFleet } from './fleet.js';
import type { RemediationStore } from './store.js';

/**
 * Remediation data in Snowflake (tables in docs/snowflake/setup.sql). Every statement binds the
 * customer as its first `?`, and values only ever travel as binds; column names come from fixed
 * lookup tables, never from the request.
 */

type Snowflake = Pick<SnowflakeRest, 'query'>;

/** The columns setup.sql creates for remediation; checked at boot like the event tables. */
export const REMEDIATION_COLUMNS: Record<string, readonly string[]> = {
  REMEDIATION_DEVICES: [
    'CUSTOMER_ID',
    'DEVICE_ID',
    'ASSET_TAG',
    'MODEL',
    'DEVICE_CLASS',
    'MANUFACTURER',
    'HOSPITAL',
    'CVE',
    'CVSS',
    'SEVERITY',
  ],
  REMEDIATION_PROJECTS: ['CUSTOMER_ID', 'PROJECT_ID', 'NAME', 'STATUS', 'CREATED_AT'],
  REMEDIATION_PROJECT_DEVICES: ['CUSTOMER_ID', 'PROJECT_ID', 'DEVICE_ID'],
  REMEDIATION_FLEET: ['CUSTOMER_ID', 'DEVICE_ID', 'SEVERITY', 'STATUS'],
};

const COLUMN: Record<Dimension, string> = {
  severity: 'SEVERITY',
  status: 'STATUS',
  hospital: 'HOSPITAL',
  deviceClass: 'DEVICE_CLASS',
  manufacturer: 'MANUFACTURER',
};

/** Severity and status order by meaning, like the in-memory store. */
const SORT_SQL: Record<SortField, string> = {
  assetTag: 'ASSET_TAG',
  model: 'MODEL',
  deviceClass: 'DEVICE_CLASS',
  manufacturer: 'MANUFACTURER',
  hospital: 'HOSPITAL',
  cve: 'CVE',
  cvss: 'CVSS',
  severity: "DECODE(SEVERITY, 'Critical', 4, 'High', 3, 'Medium', 2, 1)",
  status: "DECODE(STATUS, 'Unplanned', 1, 'Planned', 2, 3)",
};

const DEVICE_COLUMNS =
  'DEVICE_ID, ASSET_TAG, MODEL, DEVICE_CLASS, MANUFACTURER, HOSPITAL, CVE, CVSS, SEVERITY, STATUS';

const marks = (n: number) => Array(n).fill('?').join(', ');

/** `WHERE` for one customer and a filter, leaving out `skip` (the facet being counted). */
export function whereOf(
  customerId: string,
  filters: Filters,
  q: string,
  skip?: Dimension,
): { sql: string; binds: Bind[] } {
  const clauses = ['CUSTOMER_ID = ?'];
  const binds: Bind[] = [customerId];
  for (const dim of DIMENSIONS) {
    const values = filters[dim] ?? [];
    if (dim === skip || values.length === 0) continue;
    clauses.push(`${COLUMN[dim]} IN (${marks(values.length)})`);
    binds.push(...values);
  }
  if (q) {
    clauses.push(
      '(CONTAINS(LOWER(ASSET_TAG), ?) OR CONTAINS(LOWER(MODEL), ?) OR CONTAINS(LOWER(CVE), ?))',
    );
    binds.push(...Array<string>(3).fill(q.toLowerCase()));
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, binds };
}

function toDevice(row: (string | null)[]): Device {
  const [id, assetTag, model, deviceClass, manufacturer, hospital, cve, cvss, severity, status] =
    row.map((cell) => cell ?? '');
  return {
    id: id!,
    assetTag: assetTag!,
    model: model!,
    deviceClass: deviceClass!,
    manufacturer: manufacturer!,
    hospital: hospital!,
    cve: cve!,
    cvss: Number(cvss),
    severity: severity as Device['severity'],
    status: status as Device['status'],
  };
}

function toProject(row: (string | null)[]): RemediationProject {
  const [id, name, status, createdAt, deviceIds] = row;
  return {
    id: id!,
    name: name!,
    status: status as ProjectStatus,
    createdAt: createdAt!,
    deviceIds: deviceIds ? deviceIds.split(',') : [],
  };
}

const PROJECTS_SQL = `
SELECT p.PROJECT_ID, p.NAME, p.STATUS, p.CREATED_AT,
       LISTAGG(pd.DEVICE_ID, ',') WITHIN GROUP (ORDER BY pd.DEVICE_ID)
FROM REMEDIATION_PROJECTS p
LEFT JOIN REMEDIATION_PROJECT_DEVICES pd
  ON pd.CUSTOMER_ID = p.CUSTOMER_ID AND pd.PROJECT_ID = p.PROJECT_ID
WHERE p.CUSTOMER_ID = ?`;
const PROJECTS_TAIL = 'GROUP BY 1, 2, 3, 4 ORDER BY p.CREATED_AT DESC';

export class SnowflakeStore implements RemediationStore {
  /** One seeding per customer per process, shared by concurrent first requests. */
  private readonly seeded = new Map<string, Promise<void>>();

  constructor(private readonly sf: Snowflake) {}

  /** A customer's first visit loads its generated fleet, once; later visits find the rows. */
  private ensureFleet(customerId: string): Promise<void> {
    let seeding = this.seeded.get(customerId);
    if (!seeding) {
      seeding = this.seed(customerId).catch((err: unknown) => {
        this.seeded.delete(customerId);
        throw err;
      });
      this.seeded.set(customerId, seeding);
    }
    return seeding;
  }

  private async seed(customerId: string): Promise<void> {
    const { rows } = await this.sf.query(
      'SELECT COUNT(*) FROM REMEDIATION_DEVICES WHERE CUSTOMER_ID = ?',
      [customerId],
    );
    if (Number(rows[0]?.[0] ?? 0) > 0) return;
    const fleet = generateFleet(customerId);
    const binds = fleet.flatMap((d): Bind[] => [
      customerId,
      d.id,
      d.assetTag,
      d.model,
      d.deviceClass,
      d.manufacturer,
      d.hospital,
      d.cve,
      d.cvss,
      d.severity,
    ]);
    await this.sf.query(
      `INSERT INTO REMEDIATION_DEVICES (${REMEDIATION_COLUMNS.REMEDIATION_DEVICES!.join(', ')})
       VALUES ${fleet.map(() => `(${marks(10)})`).join(', ')}`,
      binds,
    );
  }

  async devices(customerId: string, query: DeviceQuery): Promise<DevicePage> {
    await this.ensureFleet(customerId);
    const where = whereOf(customerId, query.filters, query.q);
    const order = `${SORT_SQL[query.sort]} ${query.dir === 'asc' ? 'ASC' : 'DESC'}, ASSET_TAG`;
    const [page, count, facets] = await Promise.all([
      this.sf.query(
        `SELECT ${DEVICE_COLUMNS} FROM REMEDIATION_FLEET ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...where.binds, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      this.sf.query(`SELECT COUNT(*) FROM REMEDIATION_FLEET ${where.sql}`, where.binds),
      this.facets(customerId, query.filters, query.q),
    ]);
    return {
      rows: page.rows.map(toDevice),
      total: Number(count.rows[0]?.[0] ?? 0),
      page: query.page,
      pageSize: query.pageSize,
      facets,
    };
  }

  /** Every dimension's counts in one round trip: one `GROUP BY` per dimension, unioned. */
  private async facets(customerId: string, filters: Filters, q: string) {
    const parts = DIMENSIONS.map((dim) => {
      const where = whereOf(customerId, filters, q, dim);
      return {
        sql: `SELECT '${dim}', ${COLUMN[dim]}, COUNT(*) FROM REMEDIATION_FLEET ${where.sql} GROUP BY 2`,
        binds: where.binds,
      };
    });
    const { rows } = await this.sf.query(
      `${parts.map((p) => p.sql).join('\nUNION ALL\n')}\nORDER BY 3 DESC, 2`,
      parts.flatMap((p) => p.binds),
    );
    const facets = Object.fromEntries(
      DIMENSIONS.map((d): [Dimension, FacetCount[]] => [d, []]),
    ) as DevicePage['facets'];
    for (const [dim, value, count] of rows) {
      facets[dim as Dimension]?.push({ value: value ?? '', count: Number(count) });
    }
    return facets;
  }

  async matchingIds(customerId: string, filters: Filters, q: string, limit: number) {
    await this.ensureFleet(customerId);
    const where = whereOf(customerId, filters, q);
    const { rows } = await this.sf.query(
      `SELECT DEVICE_ID FROM REMEDIATION_FLEET ${where.sql} ORDER BY ASSET_TAG LIMIT ?`,
      [...where.binds, limit],
    );
    return rows.map(([id]) => id!);
  }

  async ownedIds(customerId: string, ids: string[]): Promise<Set<string>> {
    await this.ensureFleet(customerId);
    const { rows } = await this.sf.query(
      `SELECT DEVICE_ID FROM REMEDIATION_DEVICES WHERE CUSTOMER_ID = ? AND DEVICE_ID IN (${marks(ids.length)})`,
      [customerId, ...ids],
    );
    return new Set(rows.map(([id]) => id!));
  }

  async projects(customerId: string): Promise<RemediationProject[]> {
    const { rows } = await this.sf.query(`${PROJECTS_SQL} ${PROJECTS_TAIL}`, [customerId]);
    return rows.map(toProject);
  }

  private async project(customerId: string, projectId: string) {
    const { rows } = await this.sf.query(`${PROJECTS_SQL} AND p.PROJECT_ID = ? ${PROJECTS_TAIL}`, [
      customerId,
      projectId,
    ]);
    return rows[0] ? toProject(rows[0]) : null;
  }

  /**
   * Links first, project row last: the fleet view only counts links whose project exists, so a
   * failure between the two statements leaves nothing visible rather than a half-made project.
   */
  async createProject(customerId: string, name: string, deviceIds: string[]) {
    const id = `prj_${randomUUID().slice(0, 8)}`;
    await this.sf.query(
      `INSERT INTO REMEDIATION_PROJECT_DEVICES (CUSTOMER_ID, PROJECT_ID, DEVICE_ID)
       VALUES ${deviceIds.map(() => '(?, ?, ?)').join(', ')}`,
      deviceIds.flatMap((deviceId) => [customerId, id, deviceId]),
    );
    await this.sf.query(
      `INSERT INTO REMEDIATION_PROJECTS (CUSTOMER_ID, PROJECT_ID, NAME, STATUS, CREATED_AT)
       VALUES (?, ?, ?, 'Open', CURRENT_TIMESTAMP())`,
      [customerId, id, name],
    );
    return (await this.project(customerId, id))!;
  }

  async updateProject(customerId: string, projectId: string, status: ProjectStatus) {
    await this.sf.query(
      'UPDATE REMEDIATION_PROJECTS SET STATUS = ? WHERE CUSTOMER_ID = ? AND PROJECT_ID = ?',
      [status, customerId, projectId],
    );
    return this.project(customerId, projectId);
  }
}
