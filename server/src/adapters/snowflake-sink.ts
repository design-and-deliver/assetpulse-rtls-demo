import type { SequencedEvent } from '@assetpulse/protocol';
import type { Bind } from '../snowflake/rest.js';
import { toHistoryRow, type EventSink, type HistoryRow } from './history-sink.js';

/** The one call the sink makes. `SnowflakeRest.query` satisfies it; tests pass a fake. */
export type RunStatement = (statement: string, binds: Bind[]) => Promise<unknown>;

export interface SnowflakeSinkOptions {
  /**
   * How often queued rows are sent unprompted. Long on purpose: every INSERT wakes the
   * warehouse (60 s minimum bill), and Insights calls `flush` before it reads, so answers
   * never wait on this timer.
   */
  intervalMs?: number;
  /** Rows per INSERT (5 binds each; the SQL API is comfortable well past this). */
  batchMax?: number;
  /** Queue cap. Past it the oldest rows are dropped, so a dead Snowflake can't grow memory. */
  maxQueue?: number;
  onError?: (err: unknown) => void;
}

/** 5 min: a busy floor wakes the warehouse at most 12 times an hour from writes. */
const SEND_INTERVAL_MS = 5 * 60_000;

/** Column order matches `HistoryRow` and the `EVENTS` table in docs/snowflake/setup.sql. */
function insertSql(rowCount: number): string {
  const values = Array.from({ length: rowCount }, () => '(?, ?, ?, ?, ?)').join(', ');
  return (
    'INSERT INTO EVENTS (EVENT_TS, HOSPITAL_ID, SEQ, EVENT_TYPE, PAYLOAD) ' +
    'SELECT TO_TIMESTAMP_TZ(column1), column2, column3, column4, PARSE_JSON(column5) ' +
    `FROM VALUES ${values}`
  );
}

function bindsOf(rows: HistoryRow[]): Bind[] {
  return rows.flatMap((row) => [
    row.EVENT_TS,
    row.HOSPITAL_ID,
    row.SEQ,
    row.EVENT_TYPE,
    JSON.stringify(row.PAYLOAD),
  ]);
}

/**
 * The analytics (cold) path: rows queue in memory and go to Snowflake in batches on a timer.
 * `record` only pushes to an array, so the WebSocket (hot) path never waits on the network, and a
 * failed batch is logged and retried on the next tick instead of reaching any client.
 */
export class SnowflakeSink implements EventSink {
  private queue: HistoryRow[] = [];
  private sending: Promise<void> | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly batchMax: number;
  private readonly maxQueue: number;
  private readonly onError: (err: unknown) => void;
  readonly stats = { sent: 0, failedBatches: 0, dropped: 0 };

  constructor(
    private readonly run: RunStatement,
    options: SnowflakeSinkOptions = {},
  ) {
    this.batchMax = options.batchMax ?? 200;
    this.maxQueue = options.maxQueue ?? 5_000;
    this.onError = options.onError ?? ((err) => console.error('[snowflake-sink]', err));
    this.timer = setInterval(() => void this.send(), options.intervalMs ?? SEND_INTERVAL_MS);
    this.timer.unref();
  }

  record(hospitalId: string, event: SequencedEvent): void {
    this.queue.push(toHistoryRow(hospitalId, event));
    this.trim();
  }

  /** Sends whatever is queued (one batch at a time) and resolves when the queue is empty or a batch fails. */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const before = this.stats.failedBatches;
      await this.send();
      if (this.stats.failedBatches > before) return;
    }
    await this.sending;
  }

  close(): void {
    clearInterval(this.timer);
  }

  private trim(): void {
    const over = this.queue.length - this.maxQueue;
    if (over <= 0) return;
    this.queue.splice(0, over);
    this.stats.dropped += over;
  }

  private send(): Promise<void> {
    if (this.sending || this.queue.length === 0) return this.sending ?? Promise.resolve();
    const batch = this.queue.splice(0, this.batchMax);
    this.sending = this.run(insertSql(batch.length), bindsOf(batch))
      .then(() => {
        this.stats.sent += batch.length;
      })
      .catch((err: unknown) => {
        this.stats.failedBatches++;
        this.queue.unshift(...batch);
        this.trim();
        this.onError(err);
      })
      .finally(() => {
        this.sending = null;
      });
    return this.sending;
  }
}
