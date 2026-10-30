import { createHash } from 'node:crypto';
import type { Device, Severity } from '@assetpulse/protocol';

/**
 * A sandbox customer's vulnerable fleet, generated from its id so every customer gets the same
 * devices on every server, in memory or seeded into Snowflake. Hospitals, manufacturers, and
 * CVE ids are fictional: this is demo data, not a vulnerability feed.
 */

export type FleetDevice = Omit<Device, 'status'>;

const HOSPITALS = [
  'St. Mary Medical Center',
  'Riverside General',
  "Lakeview Children's",
  'Northgate Surgical',
  'Summit Heart Institute',
];

/** [class, manufacturer, model, cve, cvss]: one known vulnerability per model line. */
const MODELS: [string, string, string, string, number][] = [
  ['Infusion pump', 'Northwind Medical', 'FlowSure 300', 'CVE-2026-90011', 9.8],
  ['Infusion pump', 'Contoso Health', 'InfuMate LVP', 'CVE-2026-90014', 7.5],
  ['Infusion pump', 'Helix BioSystems', 'Syringa S2', 'CVE-2026-90017', 5.3],
  ['Patient monitor', 'Aster Diagnostics', 'VitalView 12', 'CVE-2026-90021', 8.8],
  ['Patient monitor', 'Contoso Health', 'CareTrend M5', 'CVE-2026-90023', 6.1],
  ['Patient monitor', 'Northwind Medical', 'BedsideOne', 'CVE-2026-90026', 4.3],
  ['Ventilator', 'Lumen Respiratory', 'AirPath V60', 'CVE-2026-90031', 9.1],
  ['Ventilator', 'Helix BioSystems', 'Breeze ICU', 'CVE-2026-90034', 7.2],
  ['MRI scanner', 'Corvus Imaging', 'Magnis 3T', 'CVE-2026-90041', 8.1],
  ['CT scanner', 'Corvus Imaging', 'Helios 128', 'CVE-2026-90044', 7.8],
  ['CT scanner', 'Fabrikam Devices', 'SliceView 64', 'CVE-2026-90046', 5.9],
  ['Ultrasound', 'Aster Diagnostics', 'SonoLite', 'CVE-2026-90051', 3.7],
  ['Ultrasound', 'Fabrikam Devices', 'EchoPoint 2', 'CVE-2026-90053', 6.5],
  ['Anesthesia machine', 'Vantor Clinical', 'Somna A7', 'CVE-2026-90061', 8.6],
  ['Defibrillator', 'Vantor Clinical', 'PulseGuard', 'CVE-2026-90071', 9.4],
  ['Defibrillator', 'Lumen Respiratory', 'ShockRight AED', 'CVE-2026-90073', 2.9],
  ['Telemetry transmitter', 'Northwind Medical', 'TeleLink T4', 'CVE-2026-90081', 7.4],
  ['Lab analyzer', 'Fabrikam Devices', 'ChemaPro 900', 'CVE-2026-90091', 5.0],
];

const SEVERITY_FLOORS: [number, Severity][] = [
  [9, 'Critical'],
  [7, 'High'],
  [4, 'Medium'],
];

export function severityOf(cvss: number): Severity {
  return SEVERITY_FLOORS.find(([floor]) => cvss >= floor)?.[1] ?? 'Low';
}

/** mulberry32: small, fast, and deterministic for a given seed. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(customerId: string): number {
  return createHash('sha256').update(customerId).digest().readUInt32BE(0);
}

/** Opaque and unique across customers, so another customer's id never names one of yours. */
function deviceId(customerId: string, n: number): string {
  return `dev_${createHash('sha256').update(`${customerId}:${n}`).digest('hex').slice(0, 12)}`;
}

/** "St. Mary Medical Center" → "SMM", "Infusion pump" → "IP": readable asset-tag parts. */
const initials = (s: string) =>
  s
    .split(/\s+/)
    .map((word) => word[0]!.toUpperCase())
    .join('')
    .slice(0, 3);

export function generateFleet(customerId: string, size = 320): FleetDevice[] {
  const next = random(seedOf(customerId));
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  return Array.from({ length: size }, (_, n) => {
    const hospital = pick(HOSPITALS);
    const [deviceClass, manufacturer, model, cve, cvss] = pick(MODELS);
    return {
      id: deviceId(customerId, n),
      assetTag: `${initials(hospital)}-${initials(deviceClass)}-${String(1000 + n)}`,
      model,
      deviceClass,
      manufacturer,
      hospital,
      cve,
      cvss,
      severity: severityOf(cvss),
    };
  });
}
