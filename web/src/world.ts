import {
  FrameType,
  type Asset,
  type ParState,
  type ServerFrame,
  type Snapshot,
  type WorkOrder,
} from '@assetpulse/protocol';

/** The console's view of one hospital's world, rebuilt from `hello`/`resync` and patched by events. */
export interface WorldView {
  assets: Map<string, Asset>;
  workOrders: Map<string, WorkOrder>;
  par: ParState | null;
  /** Where this session's history began, and the newest event seen: see `sessionHasActivity`. */
  sessionSeq: number;
  lastSeq: number;
}

export const EMPTY_WORLD: WorldView = {
  assets: new Map(),
  workOrders: new Map(),
  par: null,
  sessionSeq: 0,
  lastSeq: 0,
};

export type WorldFrame = Extract<
  ServerFrame,
  { type: 'hello' | 'resync' | 'asset_changed' | 'par_alert' | 'work_order' }
>;

function fromSnapshot(snapshot: Snapshot, seq: number, sessionSeq = seq): WorldView {
  return {
    assets: new Map(snapshot.assets.map((a) => [a.id, a])),
    workOrders: new Map(snapshot.workOrders.map((o) => [o.number, o])),
    par: snapshot.par,
    sessionSeq,
    lastSeq: seq,
  };
}

export function applyFrame(world: WorldView, frame: WorldFrame): WorldView {
  switch (frame.type) {
    case FrameType.hello:
    case FrameType.resync:
      return fromSnapshot(frame.snapshot, frame.seq, frame.sessionSeq);
    default:
      return { ...applyEvent(world, frame), lastSeq: frame.seq };
  }
}

function applyEvent(
  world: WorldView,
  frame: Exclude<WorldFrame, { type: 'hello' | 'resync' }>,
): WorldView {
  switch (frame.type) {
    case FrameType.assetChanged: {
      const assets = new Map(world.assets);
      assets.set(frame.assetId, { id: frame.assetId, status: frame.status, zoneId: frame.to });
      return { ...world, assets };
    }
    case FrameType.parAlert: {
      const state = frame.state === 'BREACH' ? 'BREACH' : 'OK';
      const { zoneId, clean, min, max } = frame;
      return { ...world, par: { zoneId, clean, min, max, state } };
    }
    case FrameType.workOrder: {
      const workOrders = new Map(world.workOrders);
      workOrders.set(frame.order.number, frame.order);
      return { ...world, workOrders };
    }
  }
}

/** Insights reports on this session only, so with no events since it began there is nothing yet. */
export function sessionHasActivity(world: WorldView): boolean {
  return world.lastSeq > world.sessionSeq;
}

/**
 * Live shelf count, counted the way the server does (every CLEAN pump). `par_alert` only fires on
 * BREACH/CLEARED transitions, so its `clean` goes stale between them.
 */
export function cleanCount(world: WorldView): number {
  let n = 0;
  for (const asset of world.assets.values()) if (asset.status === 'CLEAN') n += 1;
  return n;
}
