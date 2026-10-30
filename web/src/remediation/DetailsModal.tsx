import {
  DEFAULT_QUERY,
  DEVICE_STATUSES,
  type Device,
  type DevicePage,
  type RemediationProject,
} from '@assetpulse/protocol';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { RemediationApi } from './api';
import { Cvss, Pill } from './DeviceGrid';
import { countOf, plural, projectsWith, showVulnerability } from './query';
import styles from './Remediation.module.css';

/** What the modal is showing: a device, or the vulnerability found on it. */
export type Detail = { kind: 'device' | 'vulnerability'; device: Device };

/**
 * A native modal dialog: focus is trapped and Escape closes it for free. It stays mounted while
 * its content changes (device → its CVE), so focus still returns to the grid link that opened it.
 */
export function Modal({
  kicker,
  title,
  mono = false,
  onClose,
  children,
}: {
  kicker: string;
  title: string;
  /** Identifiers (asset tags, CVEs) read best in the monospace face. */
  mono?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => opener?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.modal}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the backdrop lands on the dialog itself, outside its padded content.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.modalContent}>
        <button type="button" className={styles.modalClose} aria-label="Close" onClick={onClose}>
          ×
        </button>
        <p className={styles.modalKicker}>{kicker}</p>
        <h2 id={titleId} className={`${styles.modalTitle} ${mono ? styles.mono : ''}`}>
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className={styles.facts}>
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProjectList({ projects }: { projects: RemediationProject[] | null }) {
  if (!projects) return <p className={styles.muted}>Loading projects…</p>;
  if (projects.length === 0) return <p className={styles.muted}>Not in a project yet.</p>;
  return (
    <ul className={styles.modalList}>
      {projects.map((p) => (
        <li key={p.id}>
          {p.name} <Pill value={p.status} kind="status" />
        </li>
      ))}
    </ul>
  );
}

export function DeviceDetails({
  device,
  projects,
  onOpenVulnerability,
}: {
  device: Device;
  projects: RemediationProject[] | null;
  onOpenVulnerability: () => void;
}) {
  const vulnerability = (
    <button type="button" className={styles.cellLink} onClick={onOpenVulnerability}>
      {device.cve}
    </button>
  );
  return (
    <>
      <Facts
        items={[
          ['Model', device.model],
          ['Device class', device.deviceClass],
          ['Manufacturer', device.manufacturer],
          ['Hospital', device.hospital],
          ['Vulnerability', vulnerability],
          ['CVSS', <Cvss key="cvss" device={device} />],
          ['Severity', <Pill key="sev" value={device.severity} kind="severity" />],
          ['Status', <Pill key="st" value={device.status} kind="status" />],
        ]}
      />
      <h3 className={styles.modalSection}>Remediation projects</h3>
      <ProjectList projects={projects && projectsWith(projects, device.id)} />
    </>
  );
}

/** Every device with this CVE in the customer's fleet, ignoring the grid's current filters. */
function useFleetImpact(api: RemediationApi, cve: string) {
  const [impact, setImpact] = useState<DevicePage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    api.devices(showVulnerability(DEFAULT_QUERY, cve), ctl.signal).then(setImpact, () => {
      if (!ctl.signal.aborted) setFailed(true);
    });
    return () => ctl.abort();
  }, [api, cve]);
  return { impact, failed };
}

const showLabel = (total: number) =>
  total === 1 ? 'Show the 1 device' : `Show all ${total.toLocaleString()} devices`;

function FleetImpact({ impact, onShowAll }: { impact: DevicePage; onShowAll: () => void }) {
  const hospitals = impact.facets.hospital.filter((h) => h.count > 0);
  return (
    <>
      <h3 className={styles.modalSection}>
        In this fleet: {plural(impact.total, 'device')} at {plural(hospitals.length, 'hospital')}
      </h3>
      <Facts items={hospitals.map((h) => [h.value, h.count.toLocaleString()])} />
      <p className={styles.statusLine}>
        {DEVICE_STATUSES.map(
          (s) => `${countOf(impact.facets.status, s).toLocaleString()} ${s}`,
        ).join(' · ')}
      </p>
      <div className={styles.modalActions}>
        <button type="button" className={styles.primary} onClick={onShowAll}>
          {showLabel(impact.total)}
        </button>
      </div>
    </>
  );
}

export function VulnerabilityDetails({
  api,
  device,
  onShowAll,
}: {
  api: RemediationApi;
  device: Device;
  onShowAll: () => void;
}) {
  const { impact, failed } = useFleetImpact(api, device.cve);
  return (
    <>
      <Facts
        items={[
          ['CVSS', <Cvss key="cvss" device={device} />],
          ['Severity', <Pill key="sev" value={device.severity} kind="severity" />],
          ['Affected product', `${device.manufacturer} ${device.model}`],
          ['Device class', device.deviceClass],
        ]}
      />
      {failed && <p className={styles.error}>Could not load where else this CVE is found.</p>}
      {!failed && !impact && <p className={styles.muted}>Counting affected devices…</p>}
      {impact && <FleetImpact impact={impact} onShowAll={onShowAll} />}
    </>
  );
}
