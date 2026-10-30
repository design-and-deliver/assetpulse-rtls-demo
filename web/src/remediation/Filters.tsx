import type { DevicePage, Dimension } from '@assetpulse/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { DIMENSION_LABELS, orderFacet } from './query';
import styles from './Remediation.module.css';

const SEARCH_DEBOUNCE_MS = 250;
const POPOVER_WIDTH = 248;
const EDGE = 8;

/** Typing updates the box at once; the query (and its fetch) follows after a short pause. */
export function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onSearch(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value, onSearch]);
  return (
    <input
      type="search"
      aria-label="Search devices"
      className={`${styles.input} ${styles.search}`}
      placeholder="Search asset tag, model, or CVE"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" fill="currentColor" />
    </svg>
  );
}

/** Pins the popover (a top-layer element, so the grid's scroll box can't clip it) under its button. */
function placeUnder(button: HTMLElement, popover: HTMLElement) {
  const r = button.getBoundingClientRect();
  const left = Math.min(Math.max(EDGE, r.left - 12), window.innerWidth - POPOVER_WIDTH - EDGE);
  popover.style.top = `${r.bottom + 6}px`;
  popover.style.left = `${left}px`;
}

/** Positions on open, and closes when the page or the grid scrolls out from under it. */
function usePopoverPlacement(
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  popoverRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    // Scrolling its own (long) list is fine; anything else scrolling would leave it adrift.
    const close = (e: Event) => {
      if (!(e.target instanceof Node && popover.contains(e.target))) popover.hidePopover();
    };
    const onToggle = (e: Event) => {
      const open = (e as ToggleEvent).newState === 'open';
      if (open && buttonRef.current) placeUnder(buttonRef.current, popover);
      const method = open ? 'addEventListener' : 'removeEventListener';
      window[method]('scroll', close, true);
      window[method]('resize', close);
    };
    // Once shown, focus the first value; the browser hands focus back to the button on close.
    const onShown = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') popover.querySelector('input')?.focus();
    };
    popover.addEventListener('beforetoggle', onToggle);
    popover.addEventListener('toggle', onShown);
    return () => {
      popover.removeEventListener('beforetoggle', onToggle);
      popover.removeEventListener('toggle', onShown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [buttonRef, popoverRef]);
}

export interface ColumnFilterProps {
  dim: Dimension;
  page: DevicePage | null;
  selected: string[];
  onToggle: (dim: Dimension, value: string) => void;
  /** Shows the dimension's name beside the funnel, for a filter outside its column header. */
  labelled?: boolean;
}

/** A funnel button in a column header that opens that column's values, with counts, as checkboxes. */
export function ColumnFilter({ dim, page, selected, onToggle, labelled }: ColumnFilterProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  usePopoverPlacement(buttonRef, popoverRef);
  const label = `Filter ${DIMENSION_LABELS[dim]}`;
  const on = selected.length;
  const counts = orderFacet(dim, page?.facets[dim] ?? [], selected);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.filterButton} ${labelled ? styles.filterLabelled : ''} ${on ? styles.filterOn : ''}`}
        popoverTarget={id}
      >
        {/* Name from content ("Filter Severity, 1 on"), so it always contains the visible count. */}
        <FunnelIcon />
        {labelled ? (
          <span>
            <span className={styles.srOnly}>Filter </span>
            {DIMENSION_LABELS[dim]}
            {on > 0 && <span className={styles.srOnly}>,</span>}
          </span>
        ) : (
          <span className={styles.srOnly}>{on ? `${label},` : label}</span>
        )}
        {on > 0 && (
          <>
            <span className={styles.filterCount}>{on}</span>
            <span className={styles.srOnly}> on</span>
          </>
        )}
      </button>
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        className={styles.popover}
      >
        <p className={styles.popoverTitle}>{DIMENSION_LABELS[dim]}</p>
        {counts.map(({ value, count }) => (
          <label
            key={value}
            className={`${styles.option} ${count === 0 ? styles.optionEmpty : ''}`}
          >
            <input
              type="checkbox"
              checked={selected.includes(value)}
              onChange={() => onToggle(dim, value)}
            />
            <span className={styles.optionLabel}>{value}</span>
            <span className={styles.optionCount} aria-label={`${count} devices`}>
              {count.toLocaleString()}
            </span>
          </label>
        ))}
        {counts.length === 0 && <p className={styles.muted}>No values yet.</p>}
      </div>
    </>
  );
}
