import { ZONES, type AssetStatus, type ErrorCode } from '@assetpulse/protocol';
import { STATUS_META } from './status';

export type CommandFailure = ErrorCode | 'DISCONNECTED';

const ZONE_LABELS = new Map(ZONES.map((z) => [z.id, z.label]));

/**
 * Where each status may be dragged next, in the words a nurse would use. Mirrors the server's
 * lifecycle for the hint only; the server still decides, and its `ack` is the verdict.
 */
const NEXT_STOP: Record<AssetStatus, string> = {
  CLEAN: 'Drag it to a patient room to put it in use.',
  IN_USE: 'Drag it to another room, or back to Clean Utility.',
};

const FAILURE_TEXT: Record<CommandFailure, string> = {
  INVALID_TRANSITION: 'The pump is already there.',
  NOT_FOUND: 'The server no longer knows that pump or zone.',
  BAD_ARGS: 'The server rejected the request as malformed.',
  ALREADY_ASSIGNED: 'Another tech already took that work order.',
  NOT_ASSIGNED: 'Accept the work order before delivering it.',
  DISCONNECTED:
    'Retry once the pill shows live — the connection dropped before the server answered.',
};

export function zoneLabel(zoneId: string): string {
  return ZONE_LABELS.get(zoneId) ?? zoneId;
}

/** The snap-back toast: what was refused, why, and the way out. */
export function moveFailureText(
  assetId: string,
  status: AssetStatus,
  toZoneId: string,
  failure: CommandFailure,
): string {
  const head = `${assetId} (${STATUS_META[status].label}) can't go to ${zoneLabel(toZoneId)}.`;
  const tail = failure === 'INVALID_TRANSITION' ? NEXT_STOP[status] : FAILURE_TEXT[failure];
  return `${head} ${tail}`;
}

export function commandFailureText(action: string, failure: CommandFailure): string {
  return `${action} didn't run. ${FAILURE_TEXT[failure]}`;
}

/** The after-resume toast. `resynced` = the gap outran the event log, so a snapshot replaced it. */
export function replayText(events: number, resynced: boolean): string {
  if (resynced) return 'Back online. Too much was missed to replay, so the floor was reloaded.';
  const noun = events === 1 ? 'event' : 'events';
  return `Missed while offline: ${events} ${noun} replayed.`;
}
