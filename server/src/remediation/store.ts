import type {
  DevicePage,
  DeviceQuery,
  DeviceStatus,
  Filters,
  ProjectStatus,
  RemediationProject,
  Severity,
} from '@assetpulse/protocol';

/**
 * Where remediation data lives. Every method takes the customer first and never reads or writes
 * outside it: tenant isolation is part of the contract, not something each caller remembers.
 */
export interface RemediationStore {
  devices(customerId: string, query: DeviceQuery): Promise<DevicePage>;
  /** Ids of every device matching a filter, at most `limit` of them. */
  matchingIds(customerId: string, filters: Filters, q: string, limit: number): Promise<string[]>;
  /** The subset of `ids` that belong to this customer. */
  ownedIds(customerId: string, ids: string[]): Promise<Set<string>>;
  projects(customerId: string): Promise<RemediationProject[]>;
  createProject(customerId: string, name: string, deviceIds: string[]): Promise<RemediationProject>;
  /** null when the project does not exist for this customer. */
  updateProject(
    customerId: string,
    projectId: string,
    status: ProjectStatus,
  ): Promise<RemediationProject | null>;
}

/** Severity and status sort by meaning (Critical first), not alphabetically. */
export const SEVERITY_RANK: Record<Severity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
export const STATUS_RANK: Record<DeviceStatus, number> = {
  Unplanned: 1,
  Planned: 2,
  Remediated: 3,
};

/** A device in a finished project is remediated; in any other project, planned. */
export function deviceStatusOf(projectStatuses: ProjectStatus[]): DeviceStatus {
  if (projectStatuses.includes('Done')) return 'Remediated';
  return projectStatuses.length > 0 ? 'Planned' : 'Unplanned';
}
