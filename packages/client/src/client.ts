import {
  CLIENT_PING_MS,
  FrameType,
  PROTOCOL_VERSION,
  WIRE_LOG_SIZE,
  parseServerFrame,
  reconnectDelayMs,
  type ClientFrame,
  type Command,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';

export type Ack = Extract<ServerFrame, { type: 'ack' }>;
export type ServerFrameType = ServerFrame['type'];
export type FrameOf<T extends ServerFrameType> = Extract<ServerFrame, { type: T }>;

/** `killed` = closed on purpose by `kill(ms)`; `closed` = closed for good by `close()`. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'killed' | 'closed';

/** The subset of the standard `WebSocket` this client uses — browser, React Native, Node 22. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WireEntry {
  dir: 'in' | 'out';
  ts: number;
  raw: string;
}

/** Every figure here is measured from real socket traffic — nothing is simulated. */
export interface ClientStats {
  /** Round trip of the last `ping` command's ack, or null before the first one returns. */
  rttMs: number | null;
  framesIn: number;
  framesOut: number;
  /** Last `WIRE_LOG_SIZE` raw frames, both directions, oldest first. */
  lastFrameRaw: WireEntry[];
  reconnects: number;
  /** Highest sequenced event applied; resume asks for everything after it. */
  lastSeq: number | null;
}

export interface Observable<T> {
  readonly value: T;
  subscribe(fn: (value: T) => void): () => void;
}

export class ClientError extends Error {
  constructor(readonly code: 'DISCONNECTED') {
    super(code);
    this.name = 'ClientError';
  }
}

export interface ClientOptions {
  /** Server socket URL without the query, e.g. `wss://host/ws`. */
  url: string;
  hospitalId: string;
  topics: Topic[];
  /** Injected for tests; defaults to the global `WebSocket`. */
  WebSocket?: WebSocketCtor;
  /** Jitter source (0 ≤ r < 1); defaults to `Math.random`. */
  random?: () => number;
  now?: () => number;
  pingMs?: number;
}

export interface AssetPulseClient {
  on<T extends ServerFrameType>(type: T, fn: (frame: FrameOf<T>) => void): () => void;
  send(command: Command): Promise<Ack>;
  readonly state$: Observable<ConnectionState>;
  readonly stats: ClientStats;
  /** Drops the socket now and blocks reconnecting for `ms` — the "kill network" demo. */
  kill(ms: number): void;
  close(): void;
}

const OPEN = 1;
const SEQUENCED = new Set<ServerFrameType>([
  FrameType.assetChanged,
  FrameType.parAlert,
  FrameType.workOrder,
]);

function observable<T>(initial: T): Observable<T> & { set(value: T): void } {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get value() {
      return value;
    },
    set(next: T) {
      if (next === value) return;
      value = next;
      for (const fn of listeners) fn(value);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function defaultWebSocket(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) throw new Error('No global WebSocket; pass options.WebSocket');
  return ctor;
}

function makeIdFactory(random: () => number): () => string {
  const prefix = Math.floor(random() * 36 ** 8).toString(36);
  let n = 0;
  return () => `${prefix}-${(++n).toString(36)}`;
}

interface Pending {
  resolve(ack: Ack): void;
  reject(err: ClientError): void;
}

class ResilientClient implements AssetPulseClient {
  readonly stats: ClientStats = {
    rttMs: null,
    framesIn: 0,
    framesOut: 0,
    lastFrameRaw: [],
    reconnects: 0,
    lastSeq: null,
  };
  private readonly state = observable<ConnectionState>('connecting');
  readonly state$: Observable<ConnectionState> = this.state;

  private readonly WS: WebSocketCtor;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly pingMs: number;
  private readonly nextId: () => string;
  private readonly listeners = new Map<ServerFrameType, Set<(frame: ServerFrame) => void>>();
  private readonly pending = new Map<string, Pending>();
  private readonly pingsInFlight = new Map<string, number>();

  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ClientOptions) {
    this.WS = opts.WebSocket ?? defaultWebSocket();
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.pingMs = opts.pingMs ?? CLIENT_PING_MS;
    this.nextId = makeIdFactory(this.random);
    this.connect();
  }

  on<T extends ServerFrameType>(type: T, fn: (frame: FrameOf<T>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    const listener = fn as (frame: ServerFrame) => void;
    set.add(listener);
    return () => set.delete(listener);
  }

  send(command: Command): Promise<Ack> {
    if (this.ws?.readyState !== OPEN) return Promise.reject(new ClientError('DISCONNECTED'));
    const cmdId = this.nextId();
    return new Promise<Ack>((resolve, reject) => {
      this.pending.set(cmdId, { resolve, reject });
      this.write({
        v: PROTOCOL_VERSION,
        ts: this.now(),
        type: FrameType.command,
        cmdId,
        ...command,
      });
    });
  }

  kill(ms: number): void {
    if (this.state.value === 'closed') return;
    this.drop('killed');
    this.reconnectTimer = setTimeout(() => this.connect(), ms);
  }

  close(): void {
    this.drop('closed');
  }

  // --- connection lifecycle --------------------------------------------------

  private connect(): void {
    this.reconnectTimer = null;
    const query = `h=${encodeURIComponent(this.opts.hospitalId)}`;
    const ws = new this.WS(`${this.opts.url}${this.opts.url.includes('?') ? '&' : '?'}${query}`);
    this.ws = ws;
    if (this.state.value !== 'connecting') this.state.set('reconnecting');
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => {}; // a close always follows; reconnect is driven from there
  }

  /** Subscribe before resume: the server filters the replay by the topics current at resume. */
  private handleOpen(): void {
    if (this.state.value === 'reconnecting') this.stats.reconnects += 1;
    this.attempt = 0;
    this.state.set('open');
    this.write({
      v: PROTOCOL_VERSION,
      ts: this.now(),
      type: FrameType.subscribe,
      topics: this.opts.topics,
    });
    if (this.stats.lastSeq !== null) {
      this.write({
        v: PROTOCOL_VERSION,
        ts: this.now(),
        type: FrameType.resume,
        lastSeq: this.stats.lastSeq,
      });
    }
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.pingMs);
  }

  private handleClose(): void {
    this.drop('reconnecting');
    const delay = reconnectDelayMs(this.attempt, this.random());
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Detaches and closes the socket, stops timers, and fails every pending command. */
  private drop(next: ConnectionState): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState <= OPEN) ws.close();
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = this.reconnectTimer = null;
    this.pingsInFlight.clear();
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) p.reject(new ClientError('DISCONNECTED'));
    this.state.set(next);
  }

  // --- frames ----------------------------------------------------------------

  private write(frame: ClientFrame): void {
    const raw = JSON.stringify(frame);
    this.ws?.send(raw);
    this.stats.framesOut += 1;
    this.record('out', raw);
  }

  private record(dir: WireEntry['dir'], raw: string): void {
    const log = this.stats.lastFrameRaw;
    log.push({ dir, ts: this.now(), raw });
    if (log.length > WIRE_LOG_SIZE) log.splice(0, log.length - WIRE_LOG_SIZE);
  }

  private handleMessage(data: unknown): void {
    const raw = String(data);
    this.stats.framesIn += 1;
    this.record('in', raw);
    const parsed = parseServerFrame(raw);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.type === FrameType.ack) this.settle(frame);
    else if (!this.advanceSeq(frame)) return;
    this.emit(frame);
  }

  /** Tracks `lastSeq`; returns false for a sequenced event already applied (a replay overlap). */
  private advanceSeq(frame: ServerFrame): boolean {
    if (frame.type === FrameType.resync) {
      this.stats.lastSeq = frame.seq; // may go backwards: the server's world was replaced
      return true;
    }
    if (frame.type === FrameType.hello) {
      this.stats.lastSeq ??= frame.seq;
      return true;
    }
    if (!SEQUENCED.has(frame.type) || !('seq' in frame)) return true;
    if (this.stats.lastSeq !== null && frame.seq <= this.stats.lastSeq) return false;
    this.stats.lastSeq = frame.seq;
    return true;
  }

  private settle(ack: Ack): void {
    const sentAt = this.pingsInFlight.get(ack.cmdId);
    if (sentAt !== undefined) {
      this.pingsInFlight.delete(ack.cmdId);
      this.stats.rttMs = this.now() - sentAt;
    }
    const p = this.pending.get(ack.cmdId);
    this.pending.delete(ack.cmdId);
    p?.resolve(ack);
  }

  private ping(): void {
    const cmdId = this.nextId();
    this.pingsInFlight.set(cmdId, this.now());
    this.write({
      v: PROTOCOL_VERSION,
      ts: this.now(),
      type: FrameType.command,
      cmdId,
      name: 'ping',
      args: {},
    });
  }

  private emit(frame: ServerFrame): void {
    for (const fn of this.listeners.get(frame.type) ?? []) fn(frame);
  }
}

/**
 * Opens a socket to one hospital's world and keeps it open: reconnects with backoff + jitter,
 * resumes from the last applied `seq`, and fails in-flight commands with `DISCONNECTED`.
 */
export function createClient(opts: ClientOptions): AssetPulseClient {
  return new ResilientClient(opts);
}
