import type { SnowflakeRest } from '../snowflake/rest.js';
import { missingColumns } from '../snowflake/schema.js';
import { MemoryStore } from './memory-store.js';
import { REMEDIATION_COLUMNS, SnowflakeStore } from './snowflake-store.js';
import type { RemediationStore } from './store.js';

export { REMEDIATION_PREFIX, remediationHandler } from './handler.js';

const METHODS = [
  'devices',
  'matchingIds',
  'ownedIds',
  'projects',
  'createProject',
  'updateProject',
] as const;

/** A store whose every call goes to whichever store `pick` settles on. */
function deferred(pick: Promise<RemediationStore>): RemediationStore {
  const call =
    (method: (typeof METHODS)[number]) =>
    async (...args: unknown[]) => {
      const store = await pick;
      return (store[method] as (...a: unknown[]) => Promise<unknown>).apply(store, args);
    };
  return Object.fromEntries(METHODS.map((m) => [m, call(m)])) as unknown as RemediationStore;
}

/**
 * Snowflake when the layer is on and setup.sql's remediation tables exist; otherwise in memory.
 * A missing table means setup.sql has not been re-run yet, so the page keeps working on the
 * generated fleet and one log line says why, rather than every request failing.
 */
export function remediationStore(
  sf: Pick<SnowflakeRest, 'query'> | null,
  log: Pick<Console, 'warn'> = console,
): RemediationStore {
  const memory = new MemoryStore();
  if (!sf) return memory;
  const fallBack = (why: string) => {
    log.warn(`[remediation] using the in-memory store: ${why}`);
    return memory;
  };
  return deferred(
    missingColumns(sf, REMEDIATION_COLUMNS).then(
      (missing) =>
        missing.length === 0
          ? new SnowflakeStore(sf)
          : fallBack(`Snowflake is missing ${missing.join(', ')}; re-run docs/snowflake/setup.sql`),
      (err: unknown) =>
        fallBack(`could not check Snowflake (${err instanceof Error ? err.message : String(err)})`),
    ),
  );
}
