import type { AssetStatus } from '@assetpulse/protocol';

/**
 * Statuses whose next step lives in the zone they already occupy: a reprocessed pump is marked
 * READY by dropping it back inside Sterile Processing. The server still judges every move.
 */
const ADVANCES_IN_PLACE: ReadonlySet<AssetStatus> = new Set(['REPROCESSING']);

/** The zone a finished drag should be sent to, or null to let the dot glide back. */
export function dropTarget(
  status: AssetStatus,
  fromZoneId: string,
  toZoneId: string | null,
): string | null {
  if (toZoneId === null) return null;
  if (toZoneId !== fromZoneId || ADVANCES_IN_PLACE.has(status)) return toZoneId;
  return null;
}
