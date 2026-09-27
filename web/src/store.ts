import type { AssetPulseClient, ConnectionState } from '@assetpulse/client';
import { FrameType } from '@assetpulse/protocol';
import { PositionTracker } from './positions';
import { EMPTY_WORLD, applyFrame, type WorldFrame, type WorldView } from './world';

export interface ConnectionView {
  state: ConnectionState;
  /** Last measured `ping` round trip; null until one returns. */
  rttMs: number | null;
  /** Reopened after a drop and still replaying missed events (cleared by the first ack). */
  resyncing: boolean;
}

export interface ConsoleState {
  world: WorldView;
  connection: ConnectionView;
}

export interface ConsoleStore {
  readonly client: AssetPulseClient;
  readonly positions: PositionTracker;
  getState(): ConsoleState;
  subscribe(fn: () => void): () => void;
}

const WORLD_FRAMES = [
  FrameType.hello,
  FrameType.resync,
  FrameType.assetChanged,
  FrameType.parAlert,
  FrameType.workOrder,
] as const;

/**
 * Folds the client's frames into one immutable snapshot for `useSyncExternalStore`. Positions go
 * to the tracker instead, so 4 Hz motion never touches React state.
 */
export function createConsoleStore(client: AssetPulseClient): ConsoleStore {
  const positions = new PositionTracker();
  const listeners = new Set<() => void>();
  let state: ConsoleState = {
    world: EMPTY_WORLD,
    connection: { state: client.state$.value, rttMs: null, resyncing: false },
  };

  const update = (patch: Partial<ConsoleState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const patchConnection = (patch: Partial<ConnectionView>) =>
    update({ connection: { ...state.connection, ...patch } });

  for (const type of WORLD_FRAMES) {
    client.on(type, (frame) => update({ world: applyFrame(state.world, frame as WorldFrame) }));
  }
  client.on(FrameType.positions, (frame) => positions.push(frame.batch, performance.now()));
  // Replay is written right after `resume` and before the ping, so the first ack ends it.
  client.on(FrameType.ack, () => patchConnection({ rttMs: client.stats.rttMs, resyncing: false }));
  client.state$.subscribe((next) =>
    patchConnection({
      state: next,
      resyncing: next === 'open' && client.stats.reconnects > 0,
    }),
  );

  return {
    client,
    positions,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
