import type http from 'node:http';
import { HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import { isTransient, type AnalystContent, type QueryResult, type SnowflakeRest } from './rest.js';

/**
 * `/api/insights/*`: Cortex over this hospital's event history.
 * - `GET  status`  → `{ enabled }` (the console hides the panel when false)
 * - `POST ask`     → Cortex Analyst turns the question into SQL; we run it and return the rows
 * - `GET  summary` → measured shift numbers (SQL) plus an `AI_SUMMARIZE_AGG` narrative, last 12 hours
 * With the layer off, only `status` answers; the rest 404, exactly like any unknown path.
 */

export const INSIGHTS_PREFIX = '/api/insights/';
const MAX_BODY = 2_048;
const MAX_QUESTION = 300;
const MAX_ROWS = 50;
/** Each Cortex call spends credits, so one hospital gets one call per window. */
const COOLDOWN_MS = 3_000;
/**
 * The public demo's credit ceiling across every hospital: hospital ids are free to mint, so the
 * per-hospital cooldown alone does not bound spend.
 */
const HOURLY_LIMIT = 120;
const HOUR_MS = 3_600_000;
const RETRY_DELAY_MS = 1_000;

type Snowflake = Pick<SnowflakeRest, 'query' | 'askAnalyst'>;
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface AskResult {
  text: string;
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  suggestions: string[];
  /** Set when Analyst wrote SQL we refused to run. */
  refused?: string;
  /** Set when Analyst's SQL failed in Snowflake (not a transient error): the answer, not an outage. */
  failed?: string;
}

const SUMMARY_SQL = `
SELECT COUNT(*) AS EVENTS, AI_SUMMARIZE_AGG(LINE) AS SUMMARY FROM (
  SELECT TO_VARCHAR(EVENT_TS, 'HH24:MI:SS') || ' ' || EVENT_TYPE || ' ' || TO_VARCHAR(PAYLOAD) AS LINE
  FROM EVENTS
  WHERE HOSPITAL_ID = ? AND EVENT_TS >= DATEADD(hour, -12, CURRENT_TIMESTAMP())
  ORDER BY EVENT_TS
)`;

/** The last 12 hours, measured: every number on the summary comes from here, not from the AI. */
const WINDOW = `DATEADD(hour, -12, CURRENT_TIMESTAMP())`;
const METRICS_SQL = `
SELECT
  (SELECT COUNT(*) FROM WORK_ORDERS WHERE HOSPITAL_ID = ? AND OPENED_AT >= ${WINDOW}) AS ORDERS_OPENED,
  (SELECT COUNT(*) FROM WORK_ORDERS WHERE HOSPITAL_ID = ? AND DELIVERED_AT >= ${WINDOW}) AS ORDERS_DELIVERED,
  (SELECT MEDIAN(MINUTES_TO_DELIVER) FROM WORK_ORDERS
     WHERE HOSPITAL_ID = ? AND DELIVERED_AT >= ${WINDOW}) AS MEDIAN_MINUTES_TO_DELIVER,
  (SELECT COUNT(*) FROM PAR_ALERTS
     WHERE HOSPITAL_ID = ? AND STATE = 'BREACH' AND EVENT_TS >= ${WINDOW}) AS PAR_BREACHES,
  (SELECT COUNT(*) FROM ASSET_MOVES WHERE HOSPITAL_ID = ? AND EVENT_TS >= ${WINDOW}) AS PUMP_MOVES`;

export interface ShiftMetrics {
  ordersOpened: number;
  ordersDelivered: number;
  /** null until an order has been delivered in the window. */
  medianMinutesToDeliver: number | null;
  parBreaches: number;
  pumpMoves: number;
}

export interface ShiftSummary {
  events: number;
  metrics: ShiftMetrics;
  /** AI_SUMMARIZE_AGG prose; the metrics are the facts. */
  summary: string;
}

function toMetrics(row: (string | null)[] | undefined): ShiftMetrics {
  const [opened, delivered, median, breaches, moves] = row ?? [];
  return {
    ordersOpened: Number(opened ?? 0),
    ordersDelivered: Number(delivered ?? 0),
    medianMinutesToDeliver: median == null ? null : Number(median),
    parBreaches: Number(breaches ?? 0),
    pumpMoves: Number(moves ?? 0),
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hospitalOf(req: http.IncomingMessage): string | null {
  const h = new URL(req.url ?? '/', 'http://localhost').searchParams.get('h');
  return h && HOSPITAL_ID_PATTERN.test(h) ? h : null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(badRequest());
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** A request stream can be read once; a retried handler gets the same promise back. */
const bodies = new WeakMap<http.IncomingMessage, Promise<string>>();
function bodyOf(req: http.IncomingMessage): Promise<string> {
  let body = bodies.get(req);
  if (!body) bodies.set(req, (body = readBody(req)));
  return body;
}

/** A client mistake: answered with 400 and a plain message, never logged as a Snowflake failure. */
function badRequest(): Error {
  return Object.assign(new Error('bad request'), { status: 400 });
}

function questionOf(raw: string): string | null {
  try {
    const q = (JSON.parse(raw) as { question?: unknown }).question;
    return typeof q === 'string' && q.trim() && q.length <= MAX_QUESTION ? q.trim() : null;
  } catch {
    return null;
  }
}

/** Analyst only writes queries, but we run its SQL with our role, so check before trusting it. */
export function refusalFor(sql: string, hospitalId: string): string | null {
  if (!/^\s*(with|select)\b/i.test(sql)) return 'Only SELECT queries are run.';
  if (sql.includes(';') && sql.trim().replace(/;\s*$/, '').includes(';')) {
    return 'Only one statement is run.';
  }
  if (!sql.includes(`'${hospitalId}'`)) return 'The query was not limited to this hospital.';
  return null;
}

function pick(content: AnalystContent[], type: string): AnalystContent | undefined {
  return content.find((item) => item.type === type);
}

/** Runs Analyst's SQL. A non-transient failure is part of the answer, not an outage. */
async function runAnalystSql(
  sf: Snowflake,
  sql: string,
): Promise<Pick<AskResult, 'columns' | 'rows' | 'failed'>> {
  try {
    const { columns, rows }: QueryResult = await sf.query(sql);
    return { columns, rows: rows.slice(0, MAX_ROWS) };
  } catch (err) {
    if (isTransient(err)) throw err;
    console.warn('[insights] Analyst SQL did not run:', err instanceof Error ? err.message : err);
    return {
      columns: [],
      rows: [],
      failed: 'Rephrase the question to try again; this one did not run.',
    };
  }
}

export async function ask(sf: Snowflake, hospitalId: string, question: string): Promise<AskResult> {
  const content = await sf.askAnalyst(
    `${question}\n\nOnly use rows where HOSPITAL_ID = '${hospitalId}'.`,
  );
  const sql = pick(content, 'sql')?.statement ?? null;
  const result: AskResult = {
    text: pick(content, 'text')?.text ?? '',
    sql,
    columns: [],
    rows: [],
    suggestions: pick(content, 'suggestions')?.suggestions ?? [],
  };
  if (!sql) return result;
  const refused = refusalFor(sql, hospitalId);
  if (refused) return { ...result, refused };
  return { ...result, ...(await runAnalystSql(sf, sql)) };
}

export async function summarize(sf: Snowflake, hospitalId: string): Promise<ShiftSummary> {
  const [metrics, prose] = await Promise.all([
    sf.query(METRICS_SQL, Array<string>(5).fill(hospitalId)),
    sf.query(SUMMARY_SQL, [hospitalId]),
  ]);
  const [events, summary] = prose.rows[0] ?? ['0', null];
  return {
    events: Number(events ?? 0),
    metrics: toMetrics(metrics.rows[0]),
    summary: summary ?? '',
  };
}

/** Per-hospital cooldown: 0 when admitted, else how long until this hospital may call again. */
function cooldown(now: () => number) {
  const last = new Map<string, number>();
  return (hospitalId: string): number => {
    const t = now();
    const wait = (last.get(hospitalId) ?? -Infinity) + COOLDOWN_MS - t;
    if (wait > 0) return wait;
    last.set(hospitalId, t);
    return 0;
  };
}

/** Sliding one-hour window across all hospitals. Returns false once the hour's budget is spent. */
function hourlyBudget(now: () => number, limit: number) {
  const calls: number[] = [];
  return (): boolean => {
    const t = now();
    while (calls.length > 0 && calls[0]! <= t - HOUR_MS) calls.shift();
    if (calls.length >= limit) return false;
    calls.push(t);
    return true;
  };
}

/** One retry after a short pause for blips (a warehouse resuming, a dropped connection). */
async function retryOnce<T>(work: () => Promise<T>, sleep: (ms: number) => Promise<void>) {
  try {
    return await work();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await sleep(RETRY_DELAY_MS);
    return work();
  }
}

interface Guards {
  waitFor: (hospitalId: string) => number;
  spend: () => boolean;
  sleep: (ms: number) => Promise<void>;
}

function guarded(
  guards: Guards,
  work: (hospitalId: string, req: http.IncomingMessage) => Promise<unknown>,
): Handler {
  return (req, res) => {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return send(res, 400, { error: 'h must be 8 chars [a-z0-9]' });
    const retryAfterMs = guards.waitFor(hospitalId);
    if (retryAfterMs > 0) {
      return send(res, 429, { error: 'One question every few seconds.', retryAfterMs });
    }
    if (!guards.spend()) {
      return send(res, 503, { error: 'Insights is paused after heavy use. Try again in an hour.' });
    }
    retryOnce(() => work(hospitalId, req), guards.sleep)
      .then((body) => send(res, 200, body))
      .catch((err: unknown) => {
        if ((err as { status?: number }).status === 400) {
          return send(res, 400, { error: `Ask a question of up to ${MAX_QUESTION} characters.` });
        }
        console.error('[insights]', err);
        send(res, 502, { error: 'Snowflake did not answer. Try again in a moment.' });
      });
  };
}

export interface InsightsOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hourlyLimit?: number;
  /** false once the boot-time schema check finds drift: the panel hides instead of erroring. */
  schemaOk?: () => boolean | null;
  /**
   * Who may see the panel. Hidden callers get `enabled: false` and a 404 on every other route,
   * exactly as if the layer were off. Defaults to everyone; the app passes `localOrPublic`.
   */
  visibleTo?: (req: http.IncomingMessage) => boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Insights on localhost always; on any other host (production) only once `INSIGHTS_PUBLIC=1`
 * is set, so the layer can run and collect history before the button is shared.
 */
export function localOrPublic(isPublic: boolean) {
  return (req: http.IncomingMessage): boolean => {
    if (isPublic) return true;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return LOCAL_HOSTS.has(host);
  };
}

/**
 * Returns a handler for `/api/insights/*`, or for the off case one that only answers `status`.
 * The caller routes by prefix, so every other path in the app is untouched.
 */
export function insightsHandler(sf: Snowflake | null, options: InsightsOptions = {}) {
  const now = options.now ?? Date.now;
  const schemaOk = options.schemaOk ?? (() => null);
  const guards: Guards = {
    waitFor: cooldown(now),
    spend: hourlyBudget(now, options.hourlyLimit ?? HOURLY_LIMIT),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const visibleTo = options.visibleTo ?? (() => true);
  const routes: Record<string, Handler> = {
    'GET status': (req, res) =>
      send(res, 200, { enabled: sf !== null && schemaOk() !== false && visibleTo(req) }),
  };
  if (sf) {
    // The body is read once, outside the retry, so a retried ask reuses the parsed question.
    routes['POST ask'] = guarded(guards, async (hospitalId, req) => {
      const question = questionOf(await bodyOf(req));
      if (!question) throw badRequest();
      return ask(sf, hospitalId, question);
    });
    routes['GET summary'] = guarded(guards, (hospitalId) => summarize(sf, hospitalId));
  }
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(INSIGHTS_PREFIX.length);
    const key = `${req.method} ${path}`;
    const route = key === 'GET status' || visibleTo(req) ? routes[key] : undefined;
    if (route) route(req, res);
    else send(res, 404, { error: 'not found' });
  };
}
