import type http from 'node:http';
import { HOSPITAL_ID_PATTERN } from '@assetpulse/protocol';
import type { AnalystContent, QueryResult, SnowflakeRest } from './rest.js';

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
  const { columns, rows }: QueryResult = await sf.query(sql);
  return { ...result, columns, rows: rows.slice(0, MAX_ROWS) };
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

/** Per-hospital cooldown. Returns false when this hospital called too recently. */
function cooldown(now: () => number) {
  const last = new Map<string, number>();
  return (hospitalId: string): boolean => {
    const t = now();
    if (t - (last.get(hospitalId) ?? -Infinity) < COOLDOWN_MS) return false;
    last.set(hospitalId, t);
    return true;
  };
}

function guarded(
  admit: (hospitalId: string) => boolean,
  work: (hospitalId: string, req: http.IncomingMessage) => Promise<unknown>,
): Handler {
  return (req, res) => {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return send(res, 400, { error: 'h must be 8 chars [a-z0-9]' });
    if (!admit(hospitalId)) return send(res, 429, { error: 'One question every few seconds.' });
    work(hospitalId, req)
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

/**
 * Returns a handler for `/api/insights/*`, or for the off case one that only answers `status`.
 * The caller routes by prefix, so every other path in the app is untouched.
 */
export function insightsHandler(sf: Snowflake | null, now: () => number = Date.now) {
  const admit = cooldown(now);
  const routes: Record<string, Handler> = {
    'GET status': (_req, res) => send(res, 200, { enabled: sf !== null }),
  };
  if (sf) {
    routes['POST ask'] = guarded(admit, async (hospitalId, req) => {
      const question = questionOf(await readBody(req));
      if (!question) throw badRequest();
      return ask(sf, hospitalId, question);
    });
    routes['GET summary'] = guarded(admit, (hospitalId) => summarize(sf, hospitalId));
  }
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(INSIGHTS_PREFIX.length);
    const route = routes[`${req.method} ${path}`];
    if (route) route(req, res);
    else send(res, 404, { error: 'not found' });
  };
}
