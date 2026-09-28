import type { WorkOrder } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { currentOrder, pagerStep } from './pager';

function order(number: string, patch: Partial<WorkOrder> = {}): WorkOrder {
  return {
    number,
    state: 'open',
    short_description: 'Restock IV pumps',
    assigned_to: null,
    location: 'CLEAN-UTIL',
    priority: 2,
    quantity: 3,
    opened_at: 0,
    ...patch,
  };
}

describe('currentOrder', () => {
  it('picks the newest order that is not closed', () => {
    const orders = [
      order('WO1', { opened_at: 1, state: 'accepted' }),
      order('WO2', { opened_at: 3, state: 'closed' }),
      order('WO3', { opened_at: 2 }),
    ];
    expect(currentOrder(orders)?.number).toBe('WO3');
  });

  it('is null when every order is closed', () => {
    expect(currentOrder([order('WO1', { state: 'closed' })])).toBeNull();
  });
});

describe('pagerStep', () => {
  it('walks standby → new → mine', () => {
    expect(pagerStep(null, 'tech-web')).toBe('standby');
    expect(pagerStep(order('WO1'), 'tech-web')).toBe('new');
    const mine = order('WO1', { state: 'accepted', assigned_to: 'tech-web' });
    expect(pagerStep(mine, 'tech-web')).toBe('mine');
  });

  it('is taken when another tech accepted', () => {
    const theirs = order('WO1', { state: 'accepted', assigned_to: 'tech-4821' });
    expect(pagerStep(theirs, 'tech-web')).toBe('taken');
  });
});
