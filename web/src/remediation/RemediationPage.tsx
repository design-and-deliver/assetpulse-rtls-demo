import type {
  DevicePage,
  DeviceQuery,
  Dimension,
  RemediationProject,
  SortField,
} from '@assetpulse/protocol';
import { useCallback, useEffect, useState } from 'react';
import { ActionBar } from './ActionBar';
import type { RemediationApi } from './api';
import { DeviceGrid, Pager } from './DeviceGrid';
import { DeviceDetails, Modal, VulnerabilityDetails, type Detail } from './DetailsModal';
import { ColumnFilter, SearchBox } from './Filters';
import { ProjectList } from './ProjectsPanel';
import {
  activeChips,
  clearFilters,
  DIMENSION_LABELS,
  hasActiveFilters,
  nextProjectStatus,
  pageCount,
  plural,
  querySearch,
  readQuery,
  setSearch,
  setSort,
  showVulnerability,
  toggleFilter,
  toggleOne,
  togglePage,
} from './query';
import styles from './Remediation.module.css';

const LOAD_ERROR = 'Could not load devices. Check the connection and try again.';

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** The view lives in the URL (`?h=…&severity=…`), so a link or a reload reproduces it. */
function useUrlQuery(hospitalId: string): [DeviceQuery, (q: DeviceQuery) => void] {
  const [query, setState] = useState(() => readQuery(window.location.search));
  const setQuery = useCallback(
    (next: DeviceQuery) => {
      setState(next);
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${querySearch(hospitalId, next)}`,
      );
    },
    [hospitalId],
  );
  return [query, setQuery];
}

/** The devices for the current query; a newer query aborts the older fetch. */
function useDevices(api: RemediationApi, query: DeviceQuery, version: number) {
  const [page, setPage] = useState<DevicePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    api.devices(query, ctl.signal).then(
      (p) => {
        setPage(p);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        setError(messageOf(err, LOAD_ERROR));
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [api, query, version]);
  return { page, loading, error };
}

function useProjects(api: RemediationApi, version: number) {
  const [projects, setProjects] = useState<RemediationProject[] | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api.projects(ctl.signal).then(setProjects, () => {
      if (!ctl.signal.aborted) setProjects((p) => p ?? []);
    });
    return () => ctl.abort();
  }, [api, version]);
  return projects;
}

/** The filters picked in the column headers, as removable pills above the grid. */
function FilterBar({
  query,
  onRemove,
  onClear,
}: {
  query: DeviceQuery;
  onRemove: (dim: Dimension, value: string) => void;
  onClear: () => void;
}) {
  const chips = activeChips(query);
  if (chips.length === 0) return null;
  return (
    <div className={styles.filterBar}>
      <Chips chips={chips} onRemove={onRemove} />
      <button type="button" className={styles.linkButton} onClick={onClear}>
        Clear all
      </button>
    </div>
  );
}

function Chips({
  chips,
  onRemove,
}: {
  chips: ReturnType<typeof activeChips>;
  onRemove: (dim: Dimension, value: string) => void;
}) {
  return (
    <ul className={styles.chips} aria-label="Active filters">
      {chips.map(({ dim, value }) => (
        <li key={`${dim}:${value}`}>
          <button
            type="button"
            className={styles.chip}
            aria-label={`Remove filter ${DIMENSION_LABELS[dim]}: ${value}`}
            onClick={() => onRemove(dim, value)}
          >
            <span className={styles.chipDim}>{DIMENSION_LABELS[dim]}:</span> {value}
            <span className={styles.chipX} aria-hidden="true">
              ×
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Create and advance: each success refreshes devices and projects, so statuses follow. */
function useActions(api: RemediationApi, refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<string>, fallback: string): Promise<boolean> => {
      setBusy(true);
      setFailure(null);
      setNotice('');
      try {
        setNotice(await work());
        refresh();
        return true;
      } catch (err) {
        setFailure(messageOf(err, fallback));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const advance = useCallback(
    (project: RemediationProject, status: RemediationProject['status']) =>
      run(async () => {
        await api.setProjectStatus(project.id, status);
        return `“${project.name}” is now ${status}.`;
      }, 'Could not update the project.'),
    [api, run],
  );
  return { busy, notice, failure, run, advance };
}

/** Dimensions whose columns gave way to the details modal: they filter from the toolbar instead. */
const TOOLBAR_FILTERS: Dimension[] = ['deviceClass', 'manufacturer'];

function DetailModal({
  api,
  detail,
  projects,
  onChange,
  onShowAll,
}: {
  api: RemediationApi;
  detail: Detail;
  projects: RemediationProject[] | null;
  onChange: (next: Detail | null) => void;
  onShowAll: (cve: string) => void;
}) {
  const { device } = detail;
  const isDevice = detail.kind === 'device';
  return (
    <Modal
      kicker={isDevice ? 'Device' : 'Vulnerability'}
      title={isDevice ? device.assetTag : device.cve}
      mono
      onClose={() => onChange(null)}
    >
      {isDevice ? (
        <DeviceDetails
          device={device}
          projects={projects}
          onOpenVulnerability={() => onChange({ kind: 'vulnerability', device })}
        />
      ) : (
        <VulnerabilityDetails api={api} device={device} onShowAll={() => onShowAll(device.cve)} />
      )}
    </Modal>
  );
}

function ProjectsButton({
  projects,
  onOpen,
}: {
  projects: RemediationProject[] | null;
  onOpen: () => void;
}) {
  const count = projects?.length ?? 0;
  return (
    <button
      type="button"
      className={styles.button}
      aria-haspopup="dialog"
      aria-label={count > 0 ? `Projects, ${count}` : 'Projects'}
      onClick={onOpen}
    >
      Projects {count > 0 && <span className={styles.countBadge}>{count}</span>}
    </button>
  );
}

const createdNotice = (p: RemediationProject) =>
  `Created “${p.name}” with ${plural(p.deviceIds.length, 'device')}.`;

export function RemediationPage({ api, hospitalId }: { api: RemediationApi; hospitalId: string }) {
  const [query, setQuery] = useUrlQuery(hospitalId);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const { page, loading, error } = useDevices(api, query, version);
  const projects = useProjects(api, version);
  const actions = useActions(api, refresh);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);

  // Fewer matches than before (a filter, a status change) can leave us past the last page.
  useEffect(() => {
    const last = page ? pageCount(query.pageSize, page.total) : 1;
    if (query.page > last) setQuery({ ...query, page: last });
  }, [page, query, setQuery]);

  const onToggleFilter = (dim: Dimension, value: string) =>
    setQuery(toggleFilter(query, dim, value));
  const onSearch = useCallback((q: string) => setQuery(setSearch(query, q)), [query, setQuery]);
  const onClear = () => setQuery(clearFilters(query));
  const total = page?.total ?? 0;
  const filtered = hasActiveFilters(query);

  const createFromSelection = (name: string) =>
    actions.run(async () => {
      const p = await api.createProject({ name, deviceIds: [...selected] });
      setSelected(new Set());
      return createdNotice(p);
    }, 'Could not create the project.');
  const createFromMatch = (name: string) =>
    actions.run(async () => {
      const p = await api.createProject({ name, match: { filters: query.filters, q: query.q } });
      return createdNotice(p);
    }, 'Could not create the project.');

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>
            AssetPulse <span className={styles.titleSub}>· RiskRadar</span>
          </h1>
          <p className={styles.subtitle}>See the risk. Plan the fix.</p>
        </div>
        <div className={styles.headerActions}>
          <ProjectsButton projects={projects} onOpen={() => setProjectsOpen(true)} />
          <a className={styles.backLink} href={`/?h=${encodeURIComponent(hospitalId)}`}>
            ‹ Control panel
          </a>
        </div>
      </header>

      <main>
        <p role="status" className={styles.notice}>
          {actions.notice}
        </p>
        {(error ?? actions.failure) && (
          <p role="alert" className={styles.error}>
            {actions.failure ?? error}
          </p>
        )}

        <div className={styles.layout}>
          <div className={styles.main}>
            <section className={styles.card} aria-labelledby="devices-heading">
              <div className={styles.toolbar}>
                <h2 id="devices-heading" className={styles.resultCount}>
                  {page ? plural(total, 'vulnerable device') : 'Loading devices…'}
                </h2>
                {TOOLBAR_FILTERS.map((dim) => (
                  <ColumnFilter
                    key={dim}
                    dim={dim}
                    page={page}
                    selected={query.filters[dim] ?? []}
                    onToggle={onToggleFilter}
                    labelled
                  />
                ))}
                <SearchBox value={query.q} onSearch={onSearch} />
              </div>
              <FilterBar query={query} onRemove={onToggleFilter} onClear={onClear} />
              <DeviceGrid
                query={query}
                page={page}
                loading={loading}
                selected={selected}
                onSort={(field: SortField) => setQuery(setSort(query, field))}
                onFilter={onToggleFilter}
                onToggle={(id) => setSelected((s) => toggleOne(s, id))}
                onTogglePage={() => setSelected((s) => togglePage(page?.rows ?? [], s))}
                onClear={onClear}
                onOpenDevice={(device) => setDetail({ kind: 'device', device })}
                onOpenVulnerability={(device) => setDetail({ kind: 'vulnerability', device })}
              />
              <Pager
                query={query}
                total={total}
                onPage={(n) => setQuery({ ...query, page: n })}
                onPageSize={(size) => setQuery({ ...query, pageSize: size, page: 1 })}
              />
            </section>
            <ActionBar
              selectedCount={selected.size}
              matchingCount={total}
              filtered={filtered}
              busy={actions.busy}
              onClearSelection={() => setSelected(new Set())}
              onCreateFromSelection={createFromSelection}
              onCreateFromMatch={createFromMatch}
            />
          </div>
        </div>
        {projectsOpen && (
          <Modal kicker="Remediation" title="Projects" onClose={() => setProjectsOpen(false)}>
            <ProjectList
              projects={projects}
              busy={actions.busy}
              onAdvance={(p) => {
                const next = nextProjectStatus(p.status);
                if (next) void actions.advance(p, next);
              }}
            />
          </Modal>
        )}
        {detail && (
          <DetailModal
            api={api}
            detail={detail}
            projects={projects}
            onChange={setDetail}
            onShowAll={(cve) => {
              setDetail(null);
              setQuery(showVulnerability(query, cve));
            }}
          />
        )}
      </main>
    </div>
  );
}
