/**
 * Floor "3 West" — fixed layout on a 1000×600 SVG coordinate space.
 *
 *   ┌ICU-301┬ICU-302┬ICU-303┬ICU-304┐ ┌─────┐
 *   ├───────────── HALL ────────────┤ │ SPD │  (off-floor reprocessing)
 *   ├MS-305┬MS-306┬MS-307┬MS-308┬CLEAN┬SOILED┤ └─────┘
 */

export const FLOOR_WIDTH = 1000;
export const FLOOR_HEIGHT = 600;
export const FLOOR_NAME = '3 West';

export type ZoneKind = 'room' | 'clean' | 'soiled' | 'spd' | 'hall';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  rect: Rect;
}

const TOP_Y = 20;
const HALL_Y = 210;
const BOTTOM_Y = 400;
const ROW_H = 180;

function icu(n: number, x: number): Zone {
  return {
    id: `ICU-${n}`,
    kind: 'room',
    label: `ICU ${n}`,
    rect: { x, y: TOP_Y, w: 185, h: ROW_H },
  };
}

function medSurg(n: number, x: number): Zone {
  return {
    id: `MS-${n}`,
    kind: 'room',
    label: `Med-Surg ${n}`,
    rect: { x, y: BOTTOM_Y, w: 120, h: ROW_H },
  };
}

export const ZONES: readonly Zone[] = [
  icu(301, 20),
  icu(302, 215),
  icu(303, 410),
  icu(304, 605),
  { id: 'HALL', kind: 'hall', label: 'Hallway', rect: { x: 20, y: HALL_Y, w: 770, h: ROW_H } },
  medSurg(305, 20),
  medSurg(306, 150),
  medSurg(307, 280),
  medSurg(308, 410),
  {
    id: 'CLEAN-UTIL',
    kind: 'clean',
    label: 'Clean Utility',
    rect: { x: 540, y: BOTTOM_Y, w: 120, h: ROW_H },
  },
  {
    id: 'SOILED-UTIL',
    kind: 'soiled',
    label: 'Soiled Utility',
    rect: { x: 670, y: BOTTOM_Y, w: 120, h: ROW_H },
  },
  { id: 'SPD', kind: 'spd', label: 'Sterile Processing', rect: { x: 820, y: 20, w: 160, h: 560 } },
];

export const ZONE_IDS = ZONES.map((z) => z.id);

/** PAR level for IV pumps in the clean utility room. */
export const PAR = { zoneId: 'CLEAN-UTIL', min: 3, max: 8 } as const;

export const ASSET_STATUSES = ['CLEAN', 'IN_USE', 'SOILED', 'REPROCESSING', 'READY'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface InitialAsset {
  id: string;
  status: AssetStatus;
  zoneId: string;
}

function pump(n: number, status: AssetStatus, zoneId: string): InitialAsset {
  return { id: `IVP-${n}`, status, zoneId };
}

/** 14 IV pumps: 8 clean on the shelf, 4 at bedside, 2 in reprocessing. */
export const INITIAL_ASSETS: readonly InitialAsset[] = [
  ...[101, 102, 103, 104, 105, 106, 107, 108].map((n) => pump(n, 'CLEAN', 'CLEAN-UTIL')),
  pump(109, 'IN_USE', 'ICU-301'),
  pump(110, 'IN_USE', 'ICU-302'),
  pump(111, 'IN_USE', 'MS-305'),
  pump(112, 'IN_USE', 'MS-306'),
  pump(113, 'REPROCESSING', 'SPD'),
  pump(114, 'REPROCESSING', 'SPD'),
];
