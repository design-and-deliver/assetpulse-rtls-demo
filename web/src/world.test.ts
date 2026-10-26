import { FrameType, PROTOCOL_VERSION, type Snapshot } from '@assetpulse/protocol';
import { describe, expect, it } from 'vitest';
import { applyFrame, EMPTY_WORLD, sessionHasActivity, type WorldFrame } from './world';

const snapshot: Snapshot = {
  assets: [],
  workOrders: [],
  par: { zoneId: 'CLEAN-UTIL', clean: 5, min: 2, max: 5, state: 'OK' },
};
const resync = (seq: number, sessionSeq?: number): WorldFrame => ({
  v: PROTOCOL_VERSION,
  ts: 0,
  type: FrameType.resync,
  seq,
  sessionSeq,
  snapshot,
});
const moved = (seq: number): WorldFrame => ({
  v: PROTOCOL_VERSION,
  ts: 0,
  seq,
  type: FrameType.assetChanged,
  assetId: 'IVP-101',
  from: 'CLEAN-UTIL',
  to: 'ICU-301',
  status: 'IN_USE',
});

describe('sessionHasActivity', () => {
  it('is false on a session with no events yet, true after one', () => {
    const fresh = applyFrame(EMPTY_WORLD, resync(7, 7));
    expect(sessionHasActivity(fresh)).toBe(false);
    expect(sessionHasActivity(applyFrame(fresh, moved(8)))).toBe(true);
  });

  it('counts events from earlier in the session when the page reloads mid-session', () => {
    expect(sessionHasActivity(applyFrame(EMPTY_WORLD, resync(9, 4)))).toBe(true);
  });

  it('treats a server without sessionSeq as a session starting at the snapshot', () => {
    expect(sessionHasActivity(applyFrame(EMPTY_WORLD, resync(9)))).toBe(false);
  });
});
