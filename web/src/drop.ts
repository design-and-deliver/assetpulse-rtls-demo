/** The zone a finished drag should be sent to, or null to let the dot glide back. */
export function dropTarget(fromZoneId: string, toZoneId: string | null): string | null {
  return toZoneId !== null && toZoneId !== fromZoneId ? toZoneId : null;
}
