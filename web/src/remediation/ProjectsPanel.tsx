import { PROJECT_STATUSES, type RemediationProject } from '@assetpulse/protocol';
import { Pill } from './DeviceGrid';
import { nextProjectStatus, plural } from './query';
import styles from './Remediation.module.css';

/** What the advance button says for each next status. */
const ADVANCE_LABEL: Record<string, string> = {
  'In progress': 'Start work',
  Done: 'Mark done',
};

const DATE = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Open is a third of the way, In progress two thirds, Done full. */
function progress(status: RemediationProject['status']): number {
  return ((PROJECT_STATUSES.indexOf(status) + 1) / PROJECT_STATUSES.length) * 100;
}

function ProjectItem({
  project,
  busy,
  onAdvance,
}: {
  project: RemediationProject;
  busy: boolean;
  onAdvance: (p: RemediationProject) => void;
}) {
  const next = nextProjectStatus(project.status);
  return (
    <li className={styles.project}>
      <div className={styles.projectHead}>
        <h3 className={styles.projectName}>{project.name}</h3>
        <Pill value={project.status} kind="status" />
      </div>
      <p className={styles.projectMeta}>
        {plural(project.deviceIds.length, 'device')} · created{' '}
        {DATE.format(new Date(project.createdAt))}
      </p>
      <div className={styles.projectBar} aria-hidden="true">
        <span
          className={project.status === 'Done' ? styles.barDone : undefined}
          style={{ width: `${progress(project.status)}%` }}
        />
      </div>
      {next && (
        <div>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            aria-label={`${ADVANCE_LABEL[next]}: ${project.name}`}
            onClick={() => onAdvance(project)}
          >
            {ADVANCE_LABEL[next]}
          </button>
        </div>
      )}
    </li>
  );
}

export interface ProjectsPanelProps {
  projects: RemediationProject[] | null;
  busy: boolean;
  onAdvance: (project: RemediationProject) => void;
}

export function ProjectsPanel({ projects, busy, onAdvance }: ProjectsPanelProps) {
  return (
    <section className={`${styles.card} ${styles.projects}`} aria-labelledby="projects-heading">
      <div className={styles.projectsTop}>
        <h2 id="projects-heading" className={styles.cardHeading}>
          Remediation projects
        </h2>
        {projects && projects.length > 0 && <span className={styles.muted}>{projects.length}</span>}
      </div>
      {projects && projects.length > 0 ? (
        <ul className={styles.projectList}>
          {projects.map((p) => (
            <ProjectItem key={p.id} project={p} busy={busy} onAdvance={onAdvance} />
          ))}
        </ul>
      ) : (
        <p className={styles.projectsEmpty}>
          {projects
            ? 'No projects yet. Select devices, or filter to a set, then create one.'
            : 'Loading…'}
        </p>
      )}
    </section>
  );
}
