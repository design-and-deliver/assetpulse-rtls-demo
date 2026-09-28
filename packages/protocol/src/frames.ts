import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants.js';
import { ASSET_STATUSES } from './floor.js';

/** Every frame `type`. Import these — never inline a `type: '...'` literal elsewhere. */
export const FrameType = {
  // server → client
  hello: 'hello',
  positions: 'positions',
  assetChanged: 'asset_changed',
  parAlert: 'par_alert',
  workOrder: 'work_order',
  ack: 'ack',
  resync: 'resync',
  // client → server
  subscribe: 'subscribe',
  resume: 'resume',
  command: 'command',
} as const;

export const TOPICS = ['floor', 'role:tech', 'role:ops'] as const;
export type Topic = (typeof TOPICS)[number];

/** `ping` changes nothing: the client times its ack round trip to measure real RTT. */
export const COMMAND_NAMES = ['move_asset', 'reset', 'accept_wo', 'deliver_wo', 'ping'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Codes an `ack{ok:false}` can carry. */
export const ERROR_CODES = [
  'BAD_ARGS',
  'INVALID_TRANSITION',
  'NOT_FOUND',
  'ALREADY_ASSIGNED',
  'NOT_ASSIGNED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// --- Shared shapes -----------------------------------------------------------

const envelope = z.object({ v: z.literal(PROTOCOL_VERSION), ts: z.number() });
const seq = z.number().int().nonnegative();

export const assetSchema = z.object({
  id: z.string(),
  status: z.enum(ASSET_STATUSES),
  zoneId: z.string(),
});
export type Asset = z.infer<typeof assetSchema>;

/** Mirrors the fields of a ServiceNow `wm_order` record. */
export const workOrderSchema = z.object({
  number: z.string(),
  state: z.enum(['open', 'accepted', 'closed']),
  short_description: z.string(),
  assigned_to: z.string().nullable(),
  location: z.string(),
  priority: z.number().int(),
  quantity: z.number().int().nonnegative(),
  opened_at: z.number(),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

export const parStateSchema = z.object({
  zoneId: z.string(),
  clean: z.number().int().nonnegative(),
  min: z.number().int(),
  max: z.number().int(),
  state: z.enum(['OK', 'BREACH']),
});
export type ParState = z.infer<typeof parStateSchema>;

export const snapshotSchema = z.object({
  assets: z.array(assetSchema),
  workOrders: z.array(workOrderSchema),
  par: parStateSchema,
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// --- Server → client ---------------------------------------------------------

const helloFrame = envelope.extend({
  type: z.literal(FrameType.hello),
  worldId: z.string(),
  seq,
  snapshot: snapshotSchema,
});

/** Ephemeral and droppable: deliberately carries no `seq`. */
const positionsFrame = envelope.extend({
  type: z.literal(FrameType.positions),
  batch: z.array(
    z.object({ assetId: z.string(), x: z.number(), y: z.number(), zoneId: z.string() }),
  ),
});

const assetChangedFrame = envelope.extend({
  type: z.literal(FrameType.assetChanged),
  seq,
  assetId: z.string(),
  from: z.string(),
  to: z.string(),
  status: z.enum(ASSET_STATUSES),
});

const parAlertFrame = envelope.extend({
  type: z.literal(FrameType.parAlert),
  seq,
  zoneId: z.string(),
  state: z.enum(['BREACH', 'CLEARED']),
  clean: z.number().int().nonnegative(),
  min: z.number().int(),
  max: z.number().int(),
});

const workOrderFrame = envelope.extend({
  type: z.literal(FrameType.workOrder),
  seq,
  order: workOrderSchema,
});

const ackFrame = envelope.extend({
  type: z.literal(FrameType.ack),
  cmdId: z.string(),
  ok: z.boolean(),
  error: z.enum(ERROR_CODES).optional(),
});

const resyncFrame = envelope.extend({
  type: z.literal(FrameType.resync),
  seq,
  snapshot: snapshotSchema,
});

export const serverFrameSchema = z.discriminatedUnion('type', [
  helloFrame,
  positionsFrame,
  assetChangedFrame,
  parAlertFrame,
  workOrderFrame,
  ackFrame,
  resyncFrame,
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
/** The replayable subset: frames that carry `seq` and live in the event log. */
export type SequencedEvent = Extract<
  ServerFrame,
  { type: 'asset_changed' | 'par_alert' | 'work_order' }
>;

// --- Client → server ---------------------------------------------------------

export const commandArgsSchemas = {
  move_asset: z.object({ assetId: z.string(), toZoneId: z.string() }),
  reset: z.object({}),
  accept_wo: z.object({ orderNumber: z.string(), techId: z.string().min(1) }),
  deliver_wo: z.object({ orderNumber: z.string() }),
  ping: z.object({}),
} satisfies Record<CommandName, z.ZodType>;

export type CommandArgs = { [K in CommandName]: z.infer<(typeof commandArgsSchemas)[K]> };
export type Command = { [K in CommandName]: { name: K; args: CommandArgs[K] } }[CommandName];

const subscribeFrame = envelope.extend({
  type: z.literal(FrameType.subscribe),
  topics: z.array(z.enum(TOPICS)),
});

const resumeFrame = envelope.extend({ type: z.literal(FrameType.resume), lastSeq: seq });

const commandFrame = envelope.extend({
  type: z.literal(FrameType.command),
  cmdId: z.string().min(1),
  name: z.enum(COMMAND_NAMES),
  args: z.unknown(),
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  subscribeFrame,
  resumeFrame,
  commandFrame,
]);
type RawClientFrame = z.infer<typeof clientFrameSchema>;
export type ClientFrame =
  | Exclude<RawClientFrame, { type: 'command' }>
  | (Omit<Extract<RawClientFrame, { type: 'command' }>, 'name' | 'args'> & Command);

// --- Parsing -----------------------------------------------------------------

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; error: string };

function parseJson(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, frame: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function parseServerFrame(raw: string): ParseResult<ServerFrame> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const result = serverFrameSchema.safeParse(json.frame);
  return result.success
    ? { ok: true, frame: result.data }
    : { ok: false, error: describe(result.error) };
}

/** Validates the envelope, then the command's args against its own schema. */
export function parseClientFrame(raw: string): ParseResult<ClientFrame> {
  const json = parseJson(raw);
  if (!json.ok) return json;
  const result = clientFrameSchema.safeParse(json.frame);
  if (!result.success) return { ok: false, error: describe(result.error) };
  const frame = result.data;
  if (frame.type !== FrameType.command) return { ok: true, frame };
  const args = commandArgsSchemas[frame.name].safeParse(frame.args);
  if (!args.success) return { ok: false, error: `args: ${describe(args.error)}` };
  return { ok: true, frame: { ...frame, args: args.data } as ClientFrame };
}
