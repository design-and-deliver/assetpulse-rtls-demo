import { describe, expect, it } from 'vitest';
import { dropTarget } from './drop';

describe('dropTarget', () => {
  it('sends a drop on another zone', () => {
    expect(dropTarget('ICU-301', 'CLEAN-UTIL')).toBe('CLEAN-UTIL');
  });

  it('ignores a same-zone drop', () => {
    expect(dropTarget('CLEAN-UTIL', 'CLEAN-UTIL')).toBeNull();
  });

  it('ignores a drop outside every zone', () => {
    expect(dropTarget('ICU-301', null)).toBeNull();
  });
});
