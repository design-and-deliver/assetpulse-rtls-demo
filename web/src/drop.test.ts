import { describe, expect, it } from 'vitest';
import { dropTarget } from './drop';

describe('dropTarget', () => {
  it('sends a drop on another zone', () => {
    expect(dropTarget('IN_USE', 'ICU-301', 'SOILED-UTIL')).toBe('SOILED-UTIL');
  });

  it('sends a reprocessing pump dropped back inside SPD, to mark it ready', () => {
    expect(dropTarget('REPROCESSING', 'SPD', 'SPD')).toBe('SPD');
  });

  it('ignores any other same-zone drop', () => {
    expect(dropTarget('CLEAN', 'CLEAN-UTIL', 'CLEAN-UTIL')).toBeNull();
    expect(dropTarget('READY', 'SPD', 'SPD')).toBeNull();
  });

  it('ignores a drop outside every zone', () => {
    expect(dropTarget('IN_USE', 'ICU-301', null)).toBeNull();
  });
});
