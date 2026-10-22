import { useEffect, useState, type FormEvent } from 'react';
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

/** Ask the event history in plain English (Cortex Analyst), or get a shift summary (AI_SUMMARIZE_AGG). */
export function Insights({ hospitalId }: { hospitalId: string }) {
  const enabled = useEnabled();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  if (!enabled) return null;

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
    <section className={styles.panel} aria-labelledby="insights-h">
      <div className={styles.panelTop}>
        <h2 className={styles.heading} id="insights-h">
          Ask the history{' '}
          <span className={styles.headingNote}>Snowflake Cortex · events load every 5 s</span>
        </h2>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => void summarize()}
        >
          Shift summary
        </button>
      </div>
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
        <button type="submit" className={styles.button} disabled={busy || !question.trim()}>
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
    </section>
  );
}
