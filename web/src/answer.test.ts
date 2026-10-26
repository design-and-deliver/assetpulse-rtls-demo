import { describe, expect, it } from 'vitest';
import { withoutDateRange } from './answer';

describe('withoutDateRange', () => {
  it('drops the date range Cortex pads a total with', () => {
    const padded = {
      columns: ['START_DATE', 'END_DATE', 'TOTAL_PUMPS_DELIVERED'],
      rows: [['2026-10-26 13:56:25', '2026-10-26 13:56:25', '3']],
    };
    expect(withoutDateRange(padded)).toEqual({
      columns: ['TOTAL_PUMPS_DELIVERED'],
      rows: [['3']],
    });
  });

  it('keeps a result made only of the date range: that is the answer', () => {
    const range = { columns: ['START_DATE', 'END_DATE'], rows: [['a', 'b']] };
    expect(withoutDateRange(range)).toBe(range);
  });

  it('leaves other results alone', () => {
    const table = { columns: ['TECH', 'ORDERS'], rows: [['Joe Tech', '2']] };
    expect(withoutDateRange(table)).toBe(table);
  });
});
