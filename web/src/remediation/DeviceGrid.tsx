import {
  PAGE_SIZES,
  type Device,
  type DevicePage,
  type DeviceQuery,
  type Dimension,
  type SortField,
} from '@assetpulse/protocol';
import { useEffect, useRef, type ReactNode } from 'react';
import { ColumnFilter } from './Filters';
import { pageCount, pageSelection, rangeLabel } from './query';
import styles from './Remediation.module.css';

const SEVERITY_CLASS: Record<string, string | undefined> = {
  Critical: styles.sevCritical,
  High: styles.sevHigh,
  Medium: styles.sevMedium,
  Low: styles.sevLow,
};

/** Device and project statuses share one look per meaning: to do, under way, finished. */
export const STATUS_CLASS: Record<string, string | undefined> = {
  Unplanned: styles.stUnplanned,
  Planned: styles.stPlanned,
  Remediated: styles.stRemediated,
  Open: styles.stOpen,
  'In progress': styles.stInProgress,
  Done: styles.stDone,
};

export function Pill({ value, kind }: { value: string; kind: 'severity' | 'status' }) {
  const tone = (kind === 'severity' ? SEVERITY_CLASS : STATUS_CLASS)[value] ?? '';
  return (
    <span className={`${styles.pill} ${tone}`}>
      <span className={styles.pillDot} aria-hidden="true" />
      {value}
    </span>
  );
}

/** The score, plus a 0–10 bar in the severity's color so a column of scores scans at a glance. */
export function Cvss({ device }: { device: Device }) {
  return (
    <span className={styles.cvss} data-severity={device.severity}>
      <span className={styles.cvssMeter} aria-hidden="true">
        <span style={{ width: `${device.cvss * 10}%` }} />
      </span>
      {device.cvss.toFixed(1)}
    </span>
  );
}

/** Opens a device's or a vulnerability's details; the grid shows only what triage needs. */
export interface DetailHandlers {
  onOpenDevice: (device: Device) => void;
  onOpenVulnerability: (device: Device) => void;
}

interface Column {
  field: SortField;
  label: string;
  className?: string;
  /** Set when the column is also a filter dimension: its header gets a filter button. */
  dim?: Dimension;
  cell: (d: Device, open: DetailHandlers) => ReactNode;
}

function DetailLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" className={styles.cellLink} aria-haspopup="dialog" onClick={onClick}>
      {children}
    </button>
  );
}

// Model, class, and manufacturer live in the device's details; class and manufacturer still
// filter from the toolbar.
const COLUMNS: Column[] = [
  {
    field: 'assetTag',
    label: 'Asset tag',
    className: `${styles.mono} ${styles.strong}`,
    cell: (d, open) => <DetailLink onClick={() => open.onOpenDevice(d)}>{d.assetTag}</DetailLink>,
  },
  {
    field: 'hospital',
    label: 'Hospital',
    dim: 'hospital',
    className: styles.wrapText,
    cell: (d) => d.hospital,
  },
  {
    field: 'cve',
    label: 'CVE',
    className: styles.mono,
    cell: (d, open) => <DetailLink onClick={() => open.onOpenVulnerability(d)}>{d.cve}</DetailLink>,
  },
  { field: 'cvss', label: 'CVSS', className: styles.num, cell: (d) => <Cvss device={d} /> },
  {
    field: 'severity',
    label: 'Severity',
    dim: 'severity',
    cell: (d) => <Pill value={d.severity} kind="severity" />,
  },
  {
    field: 'status',
    label: 'Status',
    dim: 'status',
    cell: (d) => <Pill value={d.status} kind="status" />,
  },
];

const SKELETON_ROWS = 10;

function SortHeader({
  column,
  query,
  page,
  onSort,
  onFilter,
}: {
  column: Column;
  query: DeviceQuery;
  page: DevicePage | null;
  onSort: (f: SortField) => void;
  onFilter: (dim: Dimension, value: string) => void;
}) {
  const active = query.sort === column.field;
  const ariaSort = active ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  const icon = active && query.dir === 'asc' ? '▲' : '▼';
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={column.className === styles.num ? styles.num : undefined}
    >
      <button type="button" className={styles.sortButton} onClick={() => onSort(column.field)}>
        {column.label}
        <span className={styles.sortIcon} aria-hidden="true">
          {active ? icon : '↕'}
        </span>
      </button>
      {column.dim && (
        <ColumnFilter
          dim={column.dim}
          page={page}
          selected={query.filters[column.dim] ?? []}
          onToggle={onFilter}
        />
      )}
    </th>
  );
}

/** The page checkbox: checked when every row is ticked, indeterminate when only some are. */
function PageCheckbox({
  rows,
  selected,
  onTogglePage,
}: {
  rows: Device[];
  selected: ReadonlySet<string>;
  onTogglePage: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const state = pageSelection(rows, selected);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all devices on this page"
      checked={state === 'all'}
      disabled={rows.length === 0}
      onChange={onTogglePage}
    />
  );
}

function SkeletonRows() {
  return Array.from({ length: SKELETON_ROWS }, (_, i) => (
    <tr key={i} aria-hidden="true">
      <td className={styles.checkCol} />
      {COLUMNS.map((c) => (
        <td key={c.field}>
          <span className={styles.skeleton} />
        </td>
      ))}
    </tr>
  ));
}

function EmptyRow({ onClear }: { onClear: () => void }) {
  return (
    <tr>
      <td colSpan={COLUMNS.length + 1} className={styles.empty}>
        <strong>No devices match these filters.</strong>
        <button type="button" className={styles.linkButton} onClick={onClear}>
          Clear filters
        </button>{' '}
        to see the whole fleet.
      </td>
    </tr>
  );
}

function DeviceRow({
  device,
  checked,
  onToggle,
  open,
}: {
  device: Device;
  checked: boolean;
  onToggle: (id: string) => void;
  open: DetailHandlers;
}) {
  return (
    <tr className={checked ? styles.selectedRow : undefined}>
      <td className={styles.checkCol}>
        <input
          type="checkbox"
          aria-label={`Select ${device.assetTag}`}
          checked={checked}
          onChange={() => onToggle(device.id)}
        />
      </td>
      {COLUMNS.map((c) => (
        <td key={c.field} className={c.className}>
          {c.cell(device, open)}
        </td>
      ))}
    </tr>
  );
}

export interface DeviceGridProps extends DetailHandlers {
  query: DeviceQuery;
  page: DevicePage | null;
  loading: boolean;
  selected: ReadonlySet<string>;
  onSort: (field: SortField) => void;
  onFilter: (dim: Dimension, value: string) => void;
  onToggle: (id: string) => void;
  onTogglePage: () => void;
  onClear: () => void;
}

function GridBody({
  page,
  selected,
  onToggle,
  onClear,
  onOpenDevice,
  onOpenVulnerability,
}: Pick<DeviceGridProps, 'page' | 'selected' | 'onToggle' | 'onClear' | keyof DetailHandlers>) {
  if (!page) return <SkeletonRows />;
  if (page.rows.length === 0) return <EmptyRow onClear={onClear} />;
  const open = { onOpenDevice, onOpenVulnerability };
  return page.rows.map((d) => (
    <DeviceRow key={d.id} device={d} checked={selected.has(d.id)} onToggle={onToggle} open={open} />
  ));
}

export function DeviceGrid(props: DeviceGridProps) {
  const { query, page, loading, selected, onSort, onFilter, onTogglePage } = props;
  return (
    <div className={styles.gridWrap} role="region" aria-label="Vulnerable devices" tabIndex={0}>
      <table
        className={`${styles.table} ${loading && page ? styles.busy : ''}`}
        aria-busy={loading}
      >
        <thead>
          <tr>
            <th scope="col" className={styles.checkCol}>
              <PageCheckbox
                rows={page?.rows ?? []}
                selected={selected}
                onTogglePage={onTogglePage}
              />
            </th>
            {COLUMNS.map((c) => (
              <SortHeader
                key={c.field}
                column={c}
                query={query}
                page={page}
                onSort={onSort}
                onFilter={onFilter}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          <GridBody {...props} />
        </tbody>
      </table>
    </div>
  );
}

export interface PagerProps {
  query: DeviceQuery;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

export function Pager({ query, total, onPage, onPageSize }: PagerProps) {
  const pages = pageCount(query.pageSize, total);
  return (
    <nav className={styles.pager} aria-label="Pages">
      <label className={styles.pagerSize}>
        Rows per page
        <select
          className={styles.select}
          value={query.pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <span className={styles.pagerRange} aria-live="polite">
        {rangeLabel(query.page, query.pageSize, total)}
      </span>
      <span className={styles.pagerButtons}>
        <button
          type="button"
          className={styles.button}
          onClick={() => onPage(query.page - 1)}
          disabled={query.page <= 1}
        >
          ‹ Previous
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => onPage(query.page + 1)}
          disabled={query.page >= pages}
        >
          Next ›
        </button>
      </span>
    </nav>
  );
}
