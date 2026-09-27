import {
  FrameType,
  PROTOCOL_VERSION,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';
import WebSocket from 'ws';

const WAIT_MS = 3_000;
/** Shared by every client: the command cache is per world, so cmdIds must be world-unique. */
let cmdCounter = 0;

export type Frame<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>;

/** A real `ws` client that records every parsed frame and can wait for the next match. */
export class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly ws: WebSocket;
  private readonly opened: Promise<void>;

  constructor(port: number, query: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
    this.opened = new Promise((resolve) => this.ws.once('open', () => resolve()));
    this.closed = new Promise((resolve) =>
      this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    this.ws.on('message', (data) => {
      const parsed = parseServerFrame(data.toString());
      if (!parsed.ok) throw new Error(`server sent an invalid frame: ${parsed.error}`);
      this.frames.push(parsed.frame);
    });
  }

  static async connect(port: number, h: string, topics?: Topic[]): Promise<TestClient> {
    const client = new TestClient(port, `?h=${h}`);
    await client.next(FrameType.hello);
    if (topics) await client.subscribe(topics);
    return client;
  }

  /** Resolves with the first frame of `type` (from index `from`) that satisfies `match`. */
  async next<T extends ServerFrame['type']>(
    type: T,
    match: (f: Frame<T>) => boolean = () => true,
    from = 0,
  ): Promise<Frame<T>> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const hit = this.frames
        .slice(from)
        .find((f): f is Frame<T> => f.type === type && match(f as Frame<T>));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await delay(10);
    }
  }

  of<T extends ServerFrame['type']>(type: T): Frame<T>[] {
    return this.frames.filter((f): f is Frame<T> => f.type === type);
  }

  async sendRaw(raw: string): Promise<void> {
    await this.opened;
    this.ws.send(raw);
  }

  async send(frame: Omit<ClientFrame, 'v' | 'ts'>): Promise<void> {
    await this.sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, ts: Date.now(), ...frame }));
  }

  /** Subscribes, then waits one round trip so the server has applied it. */
  async subscribe(topics: Topic[]): Promise<void> {
    await this.send({ type: FrameType.subscribe, topics });
    // A no-op command (NOT_FOUND) as a barrier: its ack means the subscribe was applied.
    await this.command('sync', { name: 'move_asset', args: { assetId: 'none', toZoneId: 'none' } });
  }

  /** Sends a command and resolves with its ack. */
  async command(
    prefix: string,
    command: Pick<Extract<ClientFrame, { type: 'command' }>, 'name' | 'args'>,
    cmdId = `${prefix}-${++cmdCounter}`,
  ): Promise<Frame<'ack'>> {
    const from = this.frames.length;
    await this.send({ type: FrameType.command, cmdId, ...command } as Omit<
      ClientFrame,
      'v' | 'ts'
    >);
    return this.next(FrameType.ack, (a) => a.cmdId === cmdId, from);
  }

  close(): void {
    this.ws.close();
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
