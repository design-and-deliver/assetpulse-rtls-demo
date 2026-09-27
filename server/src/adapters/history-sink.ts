import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SequencedEvent } from '@assetpulse/protocol';

/** One row per sequenced event, in the column layout a Snowflake `COPY INTO` would load. */
export interface HistoryRow {
  EVENT_TS: string;
  HOSPITAL_ID: string;
  SEQ: number;
  EVENT_TYPE: SequencedEvent['type'];
  PAYLOAD: Record<string, unknown>;
}

/** `server/data/history` — the same relative hop from `src/adapters` and `dist/adapters`. */
export const DEFAULT_HISTORY_DIR = fileURLToPath(new URL('../../data/history', import.meta.url));

const ENVELOPE_KEYS = new Set(['v', 'ts', 'seq', 'type']);

/** Envelope fields are promoted to columns, so `PAYLOAD` holds only the event's own fields. */
export function toHistoryRow(hospitalId: string, event: SequencedEvent): HistoryRow {
  const payload = Object.fromEntries(
    Object.entries(event).filter(([key]) => !ENVELOPE_KEYS.has(key)),
  );
  return {
    EVENT_TS: new Date(event.ts).toISOString(),
    HOSPITAL_ID: hospitalId,
    SEQ: event.seq,
    EVENT_TYPE: event.type,
    PAYLOAD: payload,
  };
}

/**
 * Append-only JSONL writer: `<dir>/<yyyy-mm-dd>.jsonl`, dated by `EVENT_TS` (UTC). `record` is
 * synchronous — it queues the row and returns — so the simulation tick never waits on disk.
 * The app never reads these files back.
 */
export class HistorySink {
  private queue: HistoryRow[] = [];
  private draining: Promise<void> | null = null;

  constructor(
    private readonly dir = DEFAULT_HISTORY_DIR,
    private readonly onError: (err: unknown) => void = (err) =>
      console.error('[history-sink]', err),
  ) {}

  record(hospitalId: string, event: SequencedEvent): void {
    this.queue.push(toHistoryRow(hospitalId, event));
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Resolves once every row recorded so far is on disk. For tests and graceful shutdown. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch(this.onError);
    while (this.queue.length > 0) {
      const rows = this.queue;
      this.queue = [];
      for (const [file, lines] of groupByFile(rows)) {
        await appendFile(path.join(this.dir, file), lines, 'utf8').catch(this.onError);
      }
    }
  }
}

function groupByFile(rows: HistoryRow[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const row of rows) {
    const file = `${row.EVENT_TS.slice(0, 10)}.jsonl`;
    files.set(file, (files.get(file) ?? '') + JSON.stringify(row) + '\n');
  }
  return files;
}
