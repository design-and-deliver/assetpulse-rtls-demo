/** Wire-protocol version carried in every frame's `v` field. */
export const PROTOCOL_VERSION = 1;

// --- Server timing -----------------------------------------------------------
/** Simulation tick: 10 Hz. */
export const SIM_TICK_MS = 100;
/** Coalesced position flush to each `floor` subscriber: 4 Hz. */
export const POSITION_FLUSH_MS = 250;
/** Server pings every socket this often; no pong by the next ping = terminate. */
export const HEARTBEAT_MS = 15_000;
/** Skip a client's position flush while its send buffer is above this. Events are never skipped. */
export const BACKPRESSURE_BYTES = 512 * 1024;

// --- Server capacity ---------------------------------------------------------
/** Sequenced events kept per world for `resume`. */
export const EVENT_LOG_SIZE = 1_000;
/** Command ids remembered per world, so a retried command replays its ack. */
export const COMMAND_CACHE_SIZE = 1_000;
/** Live hospital sandboxes per server. */
export const MAX_WORLDS = 25;
/** A world with no sockets for this long is garbage-collected. */
export const WORLD_IDLE_MS = 15 * 60_000;
/** Hospital sandbox ids: 8 lowercase alphanumerics. */
export const HOSPITAL_ID_PATTERN = /^[a-z0-9]{8}$/;

// --- Simulation (demo-time) --------------------------------------------------
export const SOILED_TO_REPROCESSING_MS = 8_000;
export const REPROCESSING_MS = 15_000;
export const ROOM_EVENT_MIN_MS = 6_000;
export const ROOM_EVENT_MAX_MS = 10_000;
/** An open work order with no tech online is accepted by the demo bot after this. */
export const DEMO_BOT_DELAY_MS = 45_000;
/** "Surge ICU" pulls up to this many clean pumps at once. */
export const SURGE_SIZE = 4;

// --- Close codes -------------------------------------------------------------
/** Unparseable frame or unsupported protocol version. */
export const CLOSE_BAD_FRAME = 4400;
/** Server is at MAX_WORLDS with none idle. */
export const CLOSE_CAPACITY = 4503;

// --- Client reconnect --------------------------------------------------------
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
/** The client times a `ping` command round trip this often to report real RTT. */
export const CLIENT_PING_MS = 5_000;
/** Raw frames (both directions) the client keeps for the wire drawer. */
export const WIRE_LOG_SIZE = 200;

/**
 * Exponential backoff with jitter: `min(max, base * 2^attempt) * (0.5 + random / 2)`.
 * `random` is injected (0 ≤ random < 1) so the curve is testable.
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return capped * (0.5 + random / 2);
}
