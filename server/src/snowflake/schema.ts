import type { SnowflakeRest } from './rest.js';

/**
 * The columns docs/snowflake/setup.sql creates, which the insights SQL and the Cortex semantic
 * model (assetpulse.yaml) rely on. Nothing applies setup.sql automatically, so when a commit
 * changes it the account keeps the old objects until someone re-runs it in Snowsight. This check
 * turns that silent drift into one log line at boot instead of a vague error on first use.
 * Keep it in step with setup.sql.
 */
export const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  EVENTS: ['EVENT_TS', 'HOSPITAL_ID', 'SEQ', 'EVENT_TYPE', 'PAYLOAD', 'LOADED_AT'],
  WORK_ORDERS: [
    'HOSPITAL_ID',
    'ORDER_NUMBER',
    'LOCATION',
    'QUANTITY',
    'TECH',
    'OPENED_AT',
    'ACCEPTED_AT',
    'CLOSED_AT',
    'CLOSE_CODE',
    'DELIVERED_AT',
    'CANCELLED_AT',
    'MINUTES_TO_ACCEPT',
    'MINUTES_TO_DELIVER',
  ],
  PAR_ALERTS: ['HOSPITAL_ID', 'EVENT_TS', 'ZONE_ID', 'STATE', 'CLEAN_COUNT', 'PAR_MIN', 'PAR_MAX'],
  ASSET_MOVES: ['HOSPITAL_ID', 'EVENT_TS', 'ASSET_ID', 'FROM_ZONE', 'TO_ZONE', 'STATUS'],
};

type Snowflake = Pick<SnowflakeRest, 'query'>;

/**
 * `OBJECT.COLUMN` for every expected column the account lacks (a missing object lists all of its).
 * `expected` defaults to the event tables; the remediation tables pass their own.
 */
export async function missingColumns(
  sf: Snowflake,
  expected: Record<string, readonly string[]> = EXPECTED_COLUMNS,
): Promise<string[]> {
  const objects = Object.keys(expected);
  const { rows } = await sf.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = CURRENT_SCHEMA() AND TABLE_NAME IN (${objects.map(() => '?').join(', ')})`,
    objects,
  );
  const present = new Set(rows.map(([table, column]) => `${table}.${column}`));
  return objects
    .flatMap((table) => expected[table]!.map((column) => `${table}.${column}`))
    .filter((name) => !present.has(name));
}

/**
 * Logs drift once at boot and reports it: true when the schema matches, false when columns are
 * missing, null when Snowflake could not be reached (unknown, so callers should not hide on it).
 * Never throws: a down or slow Snowflake must not block startup.
 */
export async function checkSchema(
  sf: Snowflake,
  log: Pick<Console, 'warn'> = console,
): Promise<boolean | null> {
  try {
    const missing = await missingColumns(sf);
    if (missing.length === 0) return true;
    log.warn(
      `[snowflake] schema is behind docs/snowflake/setup.sql, missing: ${missing.join(', ')}. ` +
        'Insights is hidden until you re-run setup.sql in Snowsight as ACCOUNTADMIN and ' +
        're-upload assetpulse.yaml to @MODELS.',
    );
    return false;
  } catch (err) {
    log.warn('[snowflake] could not check the schema:', err instanceof Error ? err.message : err);
    return null;
  }
}
