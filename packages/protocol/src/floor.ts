/**
 * The original story's floor: one Clean Utility shelf and four patient rooms, on a 1000×600
 * coordinate space. The console lays zones out itself; the rects only bound the position stream.
 *
 *   ┌ICU-301─┬ICU-302─┐ ┌────────────┐
 *   ├WARD-303┼WARD-304┤ │ CLEAN-UTIL │
 *   └────────┴────────┘ └────────────┘
 */

export const FLOOR_WIDTH = 1000;
export const FLOOR_HEIGHT = 600;
export const FLOOR_NAME = '3 West';

export type ZoneKind = 'room' | 'clean';

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

const ROOM_W = 300;
const ROOM_H = 270;

function room(id: string, label: string, col: number, row: number): Zone {
  const rect = { x: 20 + col * (ROOM_W + 20), y: 20 + row * (ROOM_H + 20), w: ROOM_W, h: ROOM_H };
  return { id, kind: 'room', label, rect };
}

export const ZONES: readonly Zone[] = [
  {
    id: 'CLEAN-UTIL',
    kind: 'clean',
    label: 'Clean Utility',
    rect: { x: 680, y: 20, w: 300, h: 560 },
  },
  room('ICU-301', 'ICU 301', 0, 0),
  room('ICU-302', 'ICU 302', 1, 0),
  room('WARD-303', 'Ward 303', 0, 1),
  room('WARD-304', 'Ward 304', 1, 1),
];

export const ZONE_IDS = ZONES.map((z) => z.id);

/** PAR level for IV pumps on the clean shelf. At or below `min` the server raises a work order. */
export const PAR = { zoneId: 'CLEAN-UTIL', min: 2, max: 5 } as const;

/** Pumps a delivered restock order adds to the shelf. */
export const RESTOCK_QUANTITY = 3;

/** The `from` of an `asset_changed` for a pump a restock just brought onto the floor. */
export const RESTOCK_ORIGIN = 'RESTOCK';

export const ASSET_STATUSES = ['CLEAN', 'IN_USE'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface InitialAsset {
  id: string;
  status: AssetStatus;
  zoneId: string;
}

/** 5 clean IV pumps on the shelf, IVP-101 … IVP-105. */
export const INITIAL_ASSETS: readonly InitialAsset[] = [101, 102, 103, 104, 105].map((n) => ({
  id: `IVP-${n}`,
  status: 'CLEAN',
  zoneId: PAR.zoneId,
}));
