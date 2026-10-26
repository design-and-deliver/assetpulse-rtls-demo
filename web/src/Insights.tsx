import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import appStyles from './App.module.css';
import styles from './Panels.module.css';

/** Mirrors `AskResult` in server/src/snowflake/insights.ts. */
interface AskResult {
  text: string;
  sql: string | null;
  columns: string[];
  rows: (string | null)[][];
  suggestions: string[];
  refused?: string;
  failed?: string;
}

/** Mirrors `ShiftMetrics` in server/src/snowflake/insights.ts. */
interface ShiftMetrics {
  ordersOpened: number;
  ordersDelivered: number;
  medianMinutesToDeliver: number | null;
  parBreaches: number;
  pumpMoves: number;
  events: number;
}

/** The `glance` route's body: the metrics plus which run they describe (null: no floor running). */
interface Glance extends ShiftMetrics {
  session: string | null;
}

/** Mirrors `ShiftSummary` in server/src/snowflake/insights.ts. */
interface ShiftSummary {
  events: number;
  metrics: ShiftMetrics;
  summary: string;
}

/** Demo shifts are short, so under a minute reads in seconds. */
function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  return minutes < 1 ? `${Math.round(minutes * 60)} s` : `${minutes.toFixed(1)} min`;
}

/** Numbers first (measured in SQL), then the AI's prose, so the facts never depend on the model. */
function Summary({ data }: { data: ShiftSummary }) {
  if (data.events === 0) {
    return <p className={styles.insightsAnswer}>{NO_ACTIVITY}</p>;
  }
  const m = data.metrics;
  // The other three measured numbers are the Glance cards above the tabs; never show one twice.
  const stats: [string, string][] = [
    ['Orders opened', String(m.ordersOpened)],
    ['Pump moves', String(m.pumpMoves)],
  ];
  return (
    <section className={styles.shift} aria-label="Session summary">
      <dl className={styles.shiftStats}>
        {stats.map(([label, value]) => (
          <div key={label} className={styles.shiftStat}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {data.summary && (
        <>
          <h4 className={styles.shiftSub}>What happened</h4>
          <p className={styles.shiftProse}>{data.summary}</p>
          <p className={styles.shiftCredit}>
            Written by Cortex AI_SUMMARIZE_AGG from {data.events} events.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The cards' numbers, fetched on every open: plain SQL, no Cortex. `failed` lets the dialog
 * fall back to the tabs alone, since the cards are a bonus and Ask may still work.
 */
function useGlance(hospitalId: string, opens: number) {
  const [glance, setGlance] = useState<Glance | null>(null);
  const [failed, setFailed] = useState(false);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    if (opens === 0) return;
    api<Glance>(`/api/insights/glance?h=${encodeURIComponent(hospitalId)}`)
      .then((g) => {
        setGlance(g);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [hospitalId, opens, checks]);
  return { glance, failed, check: () => setChecks((n) => n + 1) };
}

/** The three numbers a charge nurse or supply tech checks first, above both tabs. */
function GlanceCards({ metrics }: { metrics: ShiftMetrics }) {
  const cards: [string, string][] = [
    ['Orders delivered', String(metrics.ordersDelivered)],
    ['Median delivery', duration(metrics.medianMinutesToDeliver)],
    ['Shelf hit minimum', String(metrics.parBreaches)],
  ];
  return (
    <section className={styles.glance} aria-labelledby="glance-h">
      <h3 id="glance-h" className={styles.glanceHeading}>
        This session
      </h3>
      <dl className={styles.shiftStats}>
        {cards.map(([label, value]) => (
          <div key={label} className={styles.shiftStat}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Insights covers only this session, so a fresh floor has nothing to analyze yet. */
function NothingYet({ onCheck }: { onCheck: () => void }) {
  return (
    <div className={styles.insightsEmpty}>
      <p>
        Move a few pumps or work an order on the floor, then check again to see this session’s
        insights.
      </p>
      <p className={styles.insightsFoot}>
        <button type="button" className={styles.button} onClick={onCheck}>
          Check again
        </button>
      </p>
    </div>
  );
}

/** Short chip labels; the full question goes into the box, so the visitor sees what was asked. */
const EXAMPLES = [
  { label: 'Orders opened', question: 'How many work orders were opened?' },
  { label: 'Median delivery', question: 'Median minutes from page to delivery, by tech' },
  { label: 'Shelf at minimum', question: 'How many times did the shelf drop to its minimum?' },
];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * Timestamps (ISO from the server) read as local time. SQL returns numbers as strings with many
 * decimals ("0.066666667"); show at most two.
 */
function formatCell(cell: string): string {
  if (ISO_TIMESTAMP.test(cell)) return new Date(cell).toLocaleString(undefined, TIMESTAMP_FORMAT);
  const n = Number(cell);
  return cell.trim() !== '' && Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : cell;
}

/** Events reach Snowflake in 5 s batches, so a fresh hospital has nothing to report at first. */
const NO_ACTIVITY =
  'No activity yet. Drag pumps into patient rooms, then try again in a few seconds.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A quick second click lands inside the server's per-hospital cooldown (429). That is pacing,
 * not a failure, so wait it out once and retry instead of showing an error.
 */
async function api<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string; retryAfterMs?: number };
  if (res.status === 429 && !retried && body.retryAfterMs) {
    await sleep(body.retryAfterMs + 100);
    return api<T>(path, init, true);
  }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Off unless the server says Snowflake is on, so the production console is unchanged. */
function useEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api<{ enabled: boolean }>('/api/insights/status')
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, []);
  return enabled;
}

/** SQL column names (MEDIAN_MINUTES) as words, so a screen reader doesn't spell out underscores. */
function columnLabel(column: string): string {
  const words = column.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ResultTable({ columns, rows }: Pick<AskResult, 'columns' | 'rows'>) {
  if (columns.length === 0) return null;
  // A wide result scrolls sideways, so the wrapper takes focus for keyboard scrolling.
  return (
    <div className={styles.insightsTableWrap} tabIndex={0} role="region" aria-label="Query results">
      <table className={styles.insightsTable}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>
                  {cell !== null ? (
                    formatCell(cell)
                  ) : (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className={styles.srOnly}>none</span>
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A one-cell result (a count, a median) reads best as one large figure, not a 1x1 table. */
function Figure({ label, value }: { label: string; value: string | null }) {
  return (
    <p className={styles.insightsFigure}>
      <span className={styles.insightsFigureLabel}>{columnLabel(label)}</span>
      <span className={styles.insightsFigureValue}>{value === null ? '—' : formatCell(value)}</span>
    </p>
  );
}

function Result({ columns, rows }: Pick<AskResult, 'columns' | 'rows'>) {
  if (columns.length === 0) return null;
  if (rows.length === 0) return <p className={styles.muted}>{NO_ACTIVITY}</p>;
  if (columns.length === 1 && rows.length === 1) {
    return <Figure label={columns[0]!} value={rows[0]![0] ?? null} />;
  }
  return <ResultTable columns={columns} rows={rows} />;
}

/**
 * The result leads. Cortex's restatement of the question and its SQL sit behind one disclosure,
 * unless there is no SQL: then the text is Cortex's whole reply (e.g. asking to clarify).
 */
function Answer({ result }: { result: AskResult }) {
  return (
    <div className={styles.insightsAnswer}>
      {!result.sql && result.text && <p>{result.text}</p>}
      {result.refused && <p className={styles.muted}>Not run: {result.refused}</p>}
      {result.failed && <p className={styles.muted}>{result.failed}</p>}
      <Result columns={result.columns} rows={result.rows} />
      {result.sql && (
        <details className={styles.insightsHow}>
          <summary>How Cortex answered</summary>
          {result.text && <p>{result.text}</p>}
          <pre className={styles.insightsSql}>{result.sql}</pre>
        </details>
      )}
    </div>
  );
}

type Tab = 'ask' | 'summary';
const TABS: { id: Tab; label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'summary', label: 'Shift summary' },
];

/** ARIA tabs: one tab stop; the arrow keys move between tabs and select them. */
function Tabs({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = TABS[(TABS.findIndex((t) => t.id === tab) + 1) % TABS.length]!.id;
    onSelect(next);
    document.getElementById(`insights-tab-${next}`)?.focus();
  };
  return (
    <div role="tablist" aria-label="Insights" className={styles.insightsTabs} onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t.id}
          id={`insights-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`insights-panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          className={styles.insightsTab}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

interface Panel {
  busy: boolean;
  /** This panel's own error, so a summary failure never shows on the Ask tab. */
  error: string | null;
}

function AskPanel({
  hidden,
  busy,
  error,
  answer,
  onAsk,
}: Panel & { hidden: boolean; answer: AskResult | null; onAsk: (q: string) => void }) {
  const [question, setQuestion] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) onAsk(question.trim());
  };
  return (
    <div id="insights-panel-ask" role="tabpanel" aria-labelledby="insights-tab-ask" hidden={hidden}>
      <form className={styles.insightsForm} onSubmit={onSubmit}>
        <label htmlFor="insights-q" className={styles.srOnly}>
          Question about this hospital’s history
        </label>
        <input
          id="insights-q"
          className={styles.insightsInput}
          value={question}
          maxLength={300}
          placeholder="Ask about this floor’s history"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          className={`${styles.button} ${styles.insightsPrimary}`}
          disabled={!question.trim()}
          aria-disabled={busy || undefined}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <div className={styles.insightsChips}>
        {EXAMPLES.map(({ label, question: q }) => (
          <button
            key={label}
            type="button"
            className={styles.insightsChip}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setQuestion(q);
              onAsk(q);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {busy && <p className={styles.srOnly}>Asking Snowflake…</p>}
        {error && <p className={styles.insightsError}>{error}</p>}
        {answer && <Answer result={answer} />}
      </div>
    </div>
  );
}

function SummaryPanel({
  hidden,
  busy,
  error,
  summary,
  onRefresh,
}: Panel & { hidden: boolean; summary: ShiftSummary | null; onRefresh: () => void }) {
  return (
    <div
      id="insights-panel-summary"
      role="tabpanel"
      aria-labelledby="insights-tab-summary"
      hidden={hidden}
    >
      <div aria-live="polite">
        {busy && <p className={styles.muted}>Summarizing this session…</p>}
        {error && <p className={styles.insightsError}>{error}</p>}
        {summary && <Summary data={summary} />}
      </div>
      <p className={styles.insightsFoot}>
        <button
          type="button"
          className={styles.button}
          aria-disabled={busy || undefined}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </p>
    </div>
  );
}

/** Each tab shows only its own latest result, so answers never pile up. */
function InsightsBody({ hospitalId, opens }: { hospitalId: string; opens: number }) {
  const [tab, setTab] = useState<Tab>('ask');
  const [busy, setBusy] = useState<Tab | null>(null);
  const [error, setError] = useState<{ tab: Tab; text: string } | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);

  const { glance, failed, check } = useGlance(hospitalId, opens);

  // A reset starts a new session: the last run's answers no longer describe this floor.
  const session = glance?.session;
  useEffect(() => {
    setAnswer(null);
    setSummary(null);
    setError(null);
    setTab('ask');
  }, [session]);

  const h = encodeURIComponent(hospitalId);
  /**
   * Busy buttons use aria-disabled, not disabled: disabling the focused button would drop a
   * keyboard user's focus out of it. A click while busy is ignored here instead.
   */
  async function run(on: Tab, work: () => Promise<void>) {
    if (busy) return;
    setBusy(on);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError({ tab: on, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }
  const ask = (q: string) =>
    void run('ask', async () => {
      setAnswer(
        await api<AskResult>(`/api/insights/ask?h=${h}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        }),
      );
    });
  const summarize = () =>
    void run('summary', async () => {
      setSummary(await api<ShiftSummary>(`/api/insights/summary?h=${h}`));
    });
  /** The summary has nothing to ask, so opening its tab the first time fetches it. */
  const select = (t: Tab) => {
    setTab(t);
    if (t === 'summary' && !summary) summarize();
  };
  const panel = (t: Tab): Panel => ({
    busy: busy !== null,
    error: error?.tab === t ? error.text : null,
  });

  if (!glance && !failed) {
    return (
      <div className={styles.insightsBody}>
        <p className={styles.muted}>Loading…</p>
      </div>
    );
  }
  if (glance && glance.events === 0) {
    return (
      <div className={styles.insightsBody}>
        <NothingYet onCheck={check} />
      </div>
    );
  }
  return (
    <div className={styles.insightsBody}>
      {glance && <GlanceCards metrics={glance} />}
      <Tabs tab={tab} onSelect={select} />
      <AskPanel hidden={tab !== 'ask'} {...panel('ask')} answer={answer} onAsk={ask} />
      <SummaryPanel
        hidden={tab !== 'summary'}
        {...panel('summary')}
        summary={summary}
        onRefresh={summarize}
      />
    </div>
  );
}

/**
 * Progressive disclosure: a header button (only when the server has Snowflake on) opens the
 * panel as a modal <dialog>, which brings Esc-to-close, a focus trap, and a backdrop. The body
 * stays mounted while closed, so the last answer is still there when it reopens.
 */
export function Insights({ hospitalId }: { hospitalId: string }) {
  const enabled = useEnabled();
  const dialog = useRef<HTMLDialogElement>(null);
  /** Counts opens, so the cards refresh each time without loading while the dialog is closed. */
  const [opens, setOpens] = useState(0);
  if (!enabled) return null;
  const close = () => dialog.current?.close();
  /** showModal() would focus the first control (×); start on the question box instead. */
  const open = () => {
    dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
    setOpens((n) => n + 1);
  };
  /** A click on the backdrop lands on the <dialog> itself; clicks inside land on its children. */
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <button type="button" className={appStyles.button} aria-haspopup="dialog" onClick={open}>
        <span aria-hidden="true" className={styles.insightsGlyph}>
          &#10022;
        </span>{' '}
        Insights
      </button>
      <dialog
        ref={dialog}
        className={styles.insightsDialog}
        aria-labelledby="insights-h"
        onClick={onBackdrop}
      >
        <div className={styles.insightsDialogHead}>
          <p className={styles.insightsKicker}>Snowflake Cortex</p>
          <h2 id="insights-h" className={styles.insightsTitle}>
            Insights
          </h2>
          <button type="button" className={styles.insightsClose} aria-label="Close" onClick={close}>
            &times;
          </button>
        </div>
        <InsightsBody hospitalId={hospitalId} opens={opens} />
      </dialog>
    </>
  );
}
