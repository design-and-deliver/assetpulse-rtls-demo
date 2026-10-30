import { useState } from 'react';
import { matchBlocker, plural } from './query';
import styles from './Remediation.module.css';

export interface ActionBarProps {
  selectedCount: number;
  matchingCount: number;
  /** Filters or search are on, so "everything matching" is a meaningful set. */
  filtered: boolean;
  busy: boolean;
  onClearSelection: () => void;
  onCreateFromSelection: (name: string) => Promise<boolean>;
  onCreateFromMatch: (name: string) => Promise<boolean>;
}

/** "Create from all N matching", or the reason it can't, when filters define a set. */
function MatchCreate({
  count,
  disabled,
  onCreate,
}: {
  count: number;
  disabled: boolean;
  onCreate: () => void;
}) {
  const blocker = matchBlocker(count);
  return (
    <>
      <button
        type="button"
        className={styles.button}
        disabled={disabled || blocker !== null}
        aria-describedby={blocker ? 'match-blocker' : undefined}
        onClick={onCreate}
      >
        Create from all {count.toLocaleString()} matching
      </button>
      {blocker && (
        <p id="match-blocker" className={styles.blocker}>
          {blocker}
        </p>
      )}
    </>
  );
}

/**
 * Turns the current selection, or everything the filters match, into a remediation project.
 * Shown once there is something to turn into one.
 */
export function ActionBar(props: ActionBarProps) {
  const { selectedCount, matchingCount, filtered } = props;
  const [name, setName] = useState('');
  if (selectedCount === 0 && !filtered) return null;

  const blocked = props.busy || name.trim() === '';
  const create = async (from: (name: string) => Promise<boolean>) => {
    if (await from(name.trim())) setName('');
  };

  return (
    <section className={styles.actionBar} aria-label="Create a remediation project">
      <span className={styles.selectionSummary}>
        {plural(selectedCount, 'device')} selected
        {selectedCount > 0 && (
          <button type="button" className={styles.linkButton} onClick={props.onClearSelection}>
            Clear
          </button>
        )}
      </span>
      <span className={styles.actionField}>
        <label htmlFor="project-name" className={styles.fieldLabel}>
          Project name
        </label>
        <input
          id="project-name"
          className={styles.input}
          placeholder="e.g. Patch critical pumps"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </span>
      <span className={styles.actionButtons}>
        <button
          type="button"
          className={styles.primary}
          disabled={blocked || selectedCount === 0}
          onClick={() => void create(props.onCreateFromSelection)}
        >
          Create project from {selectedCount.toLocaleString()} selected
        </button>
        {filtered && (
          <MatchCreate
            count={matchingCount}
            disabled={blocked}
            onCreate={() => void create(props.onCreateFromMatch)}
          />
        )}
      </span>
    </section>
  );
}
