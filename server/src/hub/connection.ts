import {
  CLOSE_BAD_FRAME,
  FrameType,
  parseClientFrame,
  type ClientFrame,
  type ServerFrame,
  type Topic,
} from '@assetpulse/protocol';
import type { RawData, WebSocket } from 'ws';
import type { Subscriber, WorldHub } from './world-registry.js';

/** Close code for an unexpected server-side failure while handling a frame. */
const CLOSE_INTERNAL = 1011;

/**
 * Per-socket state: which world it joined, what it subscribed to, and the last `seq` it was
 * sent. Topics start empty — a socket receives only its `hello` until it subscribes.
 */
export class Connection implements Subscriber {
  topics = new Set<Topic>();
  lastSentSeq = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly hub: WorldHub,
  ) {
    hub.attach(this);
    ws.on('message', (data, isBinary) => this.receive(data, isBinary));
    ws.on('close', () => hub.detach(this));
    this.send(hub.hello());
  }

  get worldId(): string {
    return this.hub.hospitalId;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(frame: ServerFrame): void {
    if ('seq' in frame) this.lastSentSeq = frame.seq;
    this.ws.send(JSON.stringify(frame));
  }

  private receive(data: RawData, isBinary: boolean): void {
    const parsed = isBinary ? null : parseClientFrame(data.toString());
    if (!parsed?.ok) {
      this.ws.close(CLOSE_BAD_FRAME, parsed ? parsed.error.slice(0, 120) : 'binary frame');
      return;
    }
    try {
      this.handle(parsed.frame);
    } catch (err) {
      console.error('[connection]', err);
      this.ws.close(CLOSE_INTERNAL, 'internal error');
    }
  }

  private handle(frame: ClientFrame): void {
    switch (frame.type) {
      case FrameType.subscribe:
        this.topics = new Set(frame.topics);
        return;
      case FrameType.command:
        this.send(this.hub.execute(frame.cmdId, frame));
        return;
      case FrameType.resume:
        // Replayed synchronously, so no live event can interleave with the missed ones.
        for (const replayed of this.hub.replay(frame.lastSeq, this.topics)) this.send(replayed);
        return;
    }
  }
}
