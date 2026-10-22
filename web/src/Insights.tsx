import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
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
}

const EXAMPLES = [
  'How many work orders were opened today?',
  'Median minutes from page to delivery, by tech',
  'How many times did the shelf drop to its minimum?',
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T & { error?: string };
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

function ResultTable({ columns, rows }: Pick<AskResult, 'columns' | 'rows'>) {
  if (columns.length === 0) return null;
  return (
    <div className={styles.insightsTableWrap}>
      <table className={styles.insightsTable}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Answer({ result }: { result: AskResult }) {
  return (
    <div className={styles.insightsAnswer}>
      {result.text && <p>{result.text}</p>}
      {result.refused && <p className={styles.muted}>Not run: {result.refused}</p>}
      <ResultTable columns={result.columns} rows={result.rows} />
      {result.sql && (
        <details>
          <summary>SQL Cortex Analyst wrote</summary>
          <pre className={styles.insightsSql}>{result.sql}</pre>
        </details>
      )}
    </div>
  );
}

/** The overlay's contents: ask in plain English (Cortex Analyst) or get a shift summary (AI_SUMMARIZE_AGG). */
function InsightsBody({ hospitalId }: { hospitalId: string }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const h = encodeURIComponent(hospitalId);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const ask = (q: string) =>
    run(async () => {
      setAnswer(
        await api<AskResult>(`/api/insights/ask?h=${h}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        }),
      );
    });
  const summarize = () =>
    run(async () => {
      const s = await api<{ events: number; summary: string }>(`/api/insights/summary?h=${h}`);
      setSummary(s.events === 0 ? 'No events in the last 12 hours yet.' : s.summary);
    });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim()) void ask(question.trim());
  };

  return (
    <div className={styles.insightsBody}>
      <form className={styles.insightsForm} onSubmit={onSubmit}>
        <label htmlFor="insights-q" className={styles.srOnly}>
          Question about this hospital’s history
        </label>
        <input
          id="insights-q"
          className={styles.insightsInput}
          value={question}
          maxLength={300}
          placeholder="e.g. Median minutes from page to delivery, by tech"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          className={`${styles.button} ${styles.insightsPrimary}`}
          disabled={busy || !question.trim()}
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <div className={styles.insightsChips}>
        {EXAMPLES.map((q) => (
          <button
            key={q}
            type="button"
            className={styles.insightsChip}
            disabled={busy}
            onClick={() => {
              setQuestion(q);
              void ask(q);
            }}
          >
            {q}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {error && <p className={styles.insightsError}>{error}</p>}
        {summary && <p className={styles.insightsAnswer}>{summary}</p>}
        {answer && <Answer result={answer} />}
      </div>
      <p className={styles.insightsFoot}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => void summarize()}
        >
          Shift summary
        </button>
        <span className={styles.muted}>Events load into Snowflake every 5 s.</span>
      </p>
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
  if (!enabled) return null;
  const close = () => dialog.current?.close();
  /** showModal() would focus the first control (×); start on the question box instead. */
  const open = () => {
    dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
  };
  /** A click on the backdrop lands on the <dialog> itself; clicks inside land on its children. */
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <button type="button" className={appStyles.button} aria-haspopup="dialog" onClick={open}>
        <span aria-hidden="true">&#10022;</span> Insights
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
        <InsightsBody hospitalId={hospitalId} />
      </dialog>
    </>
  );
}
