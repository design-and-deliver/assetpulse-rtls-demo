/** The table part of a Cortex answer: column names, and rows of cells in the same order. */
export interface Table {
  columns: string[];
  rows: (string | null)[][];
}

const DATE_RANGE_COLUMNS = new Set(['start_date', 'end_date']);

/**
 * Cortex Analyst pads the answer to a question with no time frame with the data's date range
 * (`MIN(...) AS start_date, MAX(...) AS end_date`). Drop that padding so a single total reads as
 * one figure. A result made only of those columns is the answer itself, so it stays.
 */
export function withoutDateRange<T extends Table>(result: T): Table {
  const keep = result.columns.map((c) => !DATE_RANGE_COLUMNS.has(c.toLowerCase()));
  if (keep.every(Boolean) || !keep.some(Boolean)) return result;
  return {
    columns: result.columns.filter((_, i) => keep[i]),
    rows: result.rows.map((row) => row.filter((_, i) => keep[i])),
  };
}
