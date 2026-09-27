import { describe, expect, it } from 'vitest';
import {
  FrameType,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseServerFrame,
  type Snapshot,
} from '../src/index.js';

const env = { v: PROTOCOL_VERSION, ts: 1_727_448_821_045 };

const snapshot: Snapshot = {
  assets: [{ id: 'IVP-101', status: 'CLEAN', zoneId: 'CLEAN-UTIL' }],
  workOrders: [],
  par: { zoneId: 'CLEAN-UTIL', clean: 8, min: 3, max: 8, state: 'OK' },
};

const order = {
  number: 'WO0010001',
  state: 'open' as const,
  short_description: 'Deliver 6 IV pumps to Clean Utility',
  assigned_to: null,
  location: 'CLEAN-UTIL',
  priority: 2,
  quantity: 6,
  opened_at: env.ts,
};

const serverFrames = {
  hello: { ...env, type: FrameType.hello, worldId: 'abcd1234', seq: 0, snapshot },
  positions: {
    ...env,
    type: FrameType.positions,
    batch: [{ assetId: 'IVP-101', x: 600, y: 480, zoneId: 'CLEAN-UTIL' }],
  },
  asset_changed: {
    ...env,
    type: FrameType.assetChanged,
    seq: 7,
    assetId: 'IVP-101',
    from: 'CLEAN-UTIL',
    to: 'ICU-301',
    status: 'IN_USE',
  },
  par_alert: {
    ...env,
    type: FrameType.parAlert,
    seq: 8,
    zoneId: 'CLEAN-UTIL',
    state: 'BREACH',
    clean: 2,
    min: 3,
    max: 8,
  },
  work_order: { ...env, type: FrameType.workOrder, seq: 9, order },
  ack: { ...env, type: FrameType.ack, cmdId: 'c-1', ok: false, error: 'ALREADY_ASSIGNED' },
  resync: { ...env, type: FrameType.resync, seq: 42, snapshot },
};

const clientFrames = {
  subscribe: { ...env, type: FrameType.subscribe, topics: ['floor', 'role:ops'] },
  resume: { ...env, type: FrameType.resume, lastSeq: 41 },
  move_asset: {
    ...env,
    type: FrameType.command,
    cmdId: 'c-2',
    name: 'move_asset',
    args: { assetId: 'IVP-101', toZoneId: 'ICU-301' },
  },
  surge: { ...env, type: FrameType.command, cmdId: 'c-3', name: 'surge', args: {} },
  reset: { ...env, type: FrameType.command, cmdId: 'c-4', name: 'reset', args: {} },
  accept_wo: {
    ...env,
    type: FrameType.command,
    cmdId: 'c-5',
    name: 'accept_wo',
    args: { orderNumber: 'WO0010001', techId: 'tech-1' },
  },
  deliver_wo: {
    ...env,
    type: FrameType.command,
    cmdId: 'c-6',
    name: 'deliver_wo',
    args: { orderNumber: 'WO0010001' },
  },
  ping: { ...env, type: FrameType.command, cmdId: 'c-7', name: 'ping', args: {} },
};

describe('server frames', () => {
  it.each(Object.entries(serverFrames))('%s round-trips', (_name, frame) => {
    expect(parseServerFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it('positions carry no seq (ephemeral stream)', () => {
    const withSeq = { ...serverFrames.positions, seq: 1 };
    const parsed = parseServerFrame(JSON.stringify(withSeq));
    expect(parsed.ok && 'seq' in parsed.frame).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(parseServerFrame(JSON.stringify({ ...env, type: 'nope' })).ok).toBe(false);
  });
});

describe('client frames', () => {
  it.each(Object.entries(clientFrames))('%s round-trips', (_name, frame) => {
    expect(parseClientFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it('rejects an unsupported protocol version', () => {
    const v2 = { ...clientFrames.resume, v: 2 };
    expect(parseClientFrame(JSON.stringify(v2)).ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(parseClientFrame('{not json')).toEqual({ ok: false, error: 'invalid JSON' });
  });

  it('rejects an unknown topic', () => {
    const bad = { ...clientFrames.subscribe, topics: ['everything'] };
    expect(parseClientFrame(JSON.stringify(bad)).ok).toBe(false);
  });

  it('rejects an unknown command name', () => {
    const bad = { ...clientFrames.surge, name: 'teleport' };
    expect(parseClientFrame(JSON.stringify(bad)).ok).toBe(false);
  });

  it('validates command args against that command', () => {
    const bad = { ...clientFrames.accept_wo, args: { orderNumber: 'WO0010001' } };
    const parsed = parseClientFrame(JSON.stringify(bad));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/^args: techId/);
  });
});
