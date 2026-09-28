import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FrameType,
  PROTOCOL_VERSION,
  type SequencedEvent,
  type WorkOrder,
} from '@assetpulse/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { HistorySink, toHistoryRow } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';

const T0 = Date.UTC(2026, 8, 27, 23, 59, 59, 500);
const HOSPITAL = 'abcd1234';

const ORDER: WorkOrder = {
  number: 'WO0010001',
  state: 'open',
  short_description: 'Restock infusion pumps to CLEAN-UTIL',
  assigned_to: null,
  location: 'CLEAN-UTIL',
  priority: 2,
  quantity: 3,
  opened_at: T0,
};

function event(seq: number, ts = T0): SequencedEvent {
  return { v: PROTOCOL_VERSION, ts, seq, type: FrameType.workOrder, order: ORDER };
}

describe('toHistoryRow', () => {
  it('has exactly the five Snowflake columns, envelope promoted out of PAYLOAD', () => {
    const row = toHistoryRow(HOSPITAL, event(7));
    expect(Object.keys(row).sort()).toEqual([
      'EVENT_TS',
      'EVENT_TYPE',
      'HOSPITAL_ID',
      'PAYLOAD',
      'SEQ',
    ]);
    expect(row).toEqual({
      EVENT_TS: '2026-09-27T23:59:59.500Z',
      HOSPITAL_ID: HOSPITAL,
      SEQ: 7,
      EVENT_TYPE: FrameType.workOrder,
      PAYLOAD: { order: ORDER },
    });
  });
});

describe('HistorySink', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON row per event, split into files by UTC date', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'assetpulse-history-'));
    const sink = new HistorySink(dir);
    sink.record(HOSPITAL, event(1));
    sink.record(HOSPITAL, event(2));
    sink.record(HOSPITAL, event(3, T0 + 1_000)); // crosses midnight UTC
    await sink.flush();

    expect((await readdir(dir)).sort()).toEqual(['2026-09-27.jsonl', '2026-09-28.jsonl']);
    const day1 = (await readFile(path.join(dir, '2026-09-27.jsonl'), 'utf8')).trim().split('\n');
    expect(day1.map((line) => JSON.parse(line).SEQ)).toEqual([1, 2]);

    sink.record(HOSPITAL, event(4, T0 + 1_000));
    await sink.flush();
    const day2 = (await readFile(path.join(dir, '2026-09-28.jsonl'), 'utf8')).trim().split('\n');
    expect(day2.map((line) => JSON.parse(line).SEQ)).toEqual([3, 4]);
  });
});

describe('ServiceNowMock', () => {
  it('POSTs a new wm_order and PATCHes later states, logging only', () => {
    const lines: string[] = [];
    const sn = new ServiceNowMock((line) => lines.push(line));

    const created = sn.submit(HOSPITAL, ORDER);
    expect(created).toMatchObject({ method: 'POST', path: '/api/now/table/wm_order' });
    expect(created.body).toMatchObject({
      opened_at: '2026-09-27 23:59:59',
      u_hospital_id: HOSPITAL,
    });

    const accepted = sn.submit(HOSPITAL, { ...ORDER, state: 'accepted', assigned_to: 'tech-1' });
    expect(accepted).toMatchObject({
      method: 'PATCH',
      path: '/api/now/table/wm_order?number=WO0010001',
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[servicenow-mock] POST');
  });
});
