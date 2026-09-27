import { ClientError, type AssetPulseClient, type ConnectionState } from '@assetpulse/client';
import { FrameType, ZONES, type Command } from '@assetpulse/protocol';
import { commandFailureText, moveFailureText, replayText, type CommandFailure } from './copy';
import { PositionTracker } from './positions';
import { EMPTY_WORLD, applyFrame, type WorldFrame, type WorldView } from './world';

export interface ConnectionView {
  state: ConnectionState;
  /** Last measured `ping` round trip; null until one returns. */
  rttMs: number | null;
  /** Reopened after a drop and still replaying missed events (cleared by the first ack). */
  resyncing: boolean;
  /** When a "kill network" ends (epoch ms), or null when none is running. */
  killedUntil: number | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export interface ConsoleState {
  world: WorldView;
  connection: ConnectionView;
  toasts: Toast[];
}

export interface ConsoleStore {
  readonly client: AssetPulseClient;
  readonly positions: PositionTracker;
  getState(): ConsoleState;
  subscribe(fn: () => void): () => void;
  /** Optimistic drag-drop: the dot and the asset move now, and snap back if the server refuses. */
  moveAsset(assetId: string, toZoneId: string): Promise<void>;
  /** Sends a no-argument world command; a refusal becomes an error toast. */
  run(command: Command, action: string): Promise<void>;
  killNetwork(ms: number): void;
  dismissToast(id: number): void;
}

const WORLD_FRAMES = [
  FrameType.hello,
  FrameType.resync,
  FrameType.assetChanged,
  FrameType.parAlert,
  FrameType.workOrder,
] as const;
/** The frames a resume replays — `hello` is sent on every connect, so it doesn't count. */
const REPLAYABLE = new Set<string>([
  FrameType.assetChanged,
  FrameType.parAlert,
  FrameType.workOrder,
]);
const ZONE_RECTS = new Map(ZONES.map((z) => [z.id, z.rect]));
const TOAST_MS = 6000;
/** Longest a dropped dot waits for the server's position to reach its new zone. */
const HOLD_MAX_MS = 4000;

/** What a command's outcome boils down to: null = accepted, else why not. */
async function outcome(client: AssetPulseClient, command: Command): Promise<CommandFailure | null> {
  try {
    const ack = await client.send(command);
    return ack.ok ? null : (ack.error ?? 'BAD_ARGS');
  } catch (err) {
    if (err instanceof ClientError) return err.code;
    throw err;
  }
}

/**
 * Folds the client's frames into one immutable snapshot for `useSyncExternalStore`. Positions go
 * to the tracker instead, so 4 Hz motion never touches React state.
 */
export function createConsoleStore(client: AssetPulseClient): ConsoleStore {
  const positions = new PositionTracker();
  const listeners = new Set<() => void>();
  let state: ConsoleState = {
    world: EMPTY_WORLD,
    connection: { state: client.state$.value, rttMs: null, resyncing: false, killedUntil: null },
    toasts: [],
  };
  let nextToastId = 1;
  /** Counts what a resume replays; null outside the reopen → first-ack window. */
  let replay: { events: number; resynced: boolean } | null = null;

  const update = (patch: Partial<ConsoleState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const patchConnection = (patch: Partial<ConnectionView>) =>
    update({ connection: { ...state.connection, ...patch } });

  const dismissToast = (id: number) => update({ toasts: state.toasts.filter((t) => t.id !== id) });
  const toast = (text: string, tone: Toast['tone']) => {
    const id = nextToastId++;
    update({ toasts: [...state.toasts, { id, text, tone }] });
    setTimeout(() => dismissToast(id), TOAST_MS);
  };

  const countReplay = (type: string) => {
    if (!replay) return;
    if (type === FrameType.resync) replay.resynced = true;
    else if (REPLAYABLE.has(type)) replay.events += 1;
  };
  const finishReplay = () => {
    if (!replay) return;
    toast(replayText(replay.events, replay.resynced), 'info');
    replay = null;
  };

  for (const type of WORLD_FRAMES) {
    client.on(type, (frame) => {
      countReplay(type);
      update({ world: applyFrame(state.world, frame as WorldFrame) });
    });
  }
  client.on(FrameType.positions, (frame) => positions.push(frame.batch, performance.now()));
  // Replay is written right after `resume` and before the ping, so the first ack ends it.
  client.on(FrameType.ack, () => {
    finishReplay();
    patchConnection({ rttMs: client.stats.rttMs, resyncing: false });
  });
  client.state$.subscribe((next) => {
    const resyncing = next === 'open' && client.stats.reconnects > 0;
    if (resyncing) replay = { events: 0, resynced: false };
    const killedUntil = next === 'killed' ? state.connection.killedUntil : null;
    patchConnection({ state: next, resyncing, killedUntil });
  });

  const setAssetZone = (assetId: string, zoneId: string) => {
    const asset = state.world.assets.get(assetId);
    if (!asset) return;
    const assets = new Map(state.world.assets).set(assetId, { ...asset, zoneId });
    update({ world: { ...state.world, assets } });
  };

  async function moveAsset(assetId: string, toZoneId: string): Promise<void> {
    const before = state.world.assets.get(assetId);
    const rect = ZONE_RECTS.get(toZoneId);
    if (!before || !rect) return;
    setAssetZone(assetId, toZoneId);
    const optimistic = state.world.assets.get(assetId);

    const failure = await outcome(client, {
      name: 'move_asset',
      args: { assetId, toZoneId },
    });
    if (failure === null) {
      positions.releaseWhenIn(assetId, rect);
      setTimeout(() => positions.expire(assetId, rect, performance.now()), HOLD_MAX_MS);
      return;
    }
    // Revert only if nothing newer (an event, a snapshot) replaced the optimistic copy.
    if (state.world.assets.get(assetId) === optimistic) setAssetZone(assetId, before.zoneId);
    positions.release(assetId, performance.now());
    toast(moveFailureText(assetId, before.status, toZoneId, failure), 'error');
  }

  async function run(command: Command, action: string): Promise<void> {
    const failure = await outcome(client, command);
    if (failure !== null) toast(commandFailureText(action, failure), 'error');
  }

  function killNetwork(ms: number): void {
    client.kill(ms);
    patchConnection({ killedUntil: Date.now() + ms });
  }

  return {
    client,
    positions,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    moveAsset,
    run,
    killNetwork,
    dismissToast,
  };
}
