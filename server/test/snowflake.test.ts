import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { FrameType, PROTOCOL_VERSION, type SequencedEvent } from '@assetpulse/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistorySink, TeeSink, type EventSink } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';
import {
  SnowflakeSink,
  type RunStatement,
  type SnowflakeSinkOptions,
} from '../src/adapters/snowflake-sink.js';
import { startApp, type App } from '../src/app.js';
import { loadSnowflakeConfig, type SnowflakeConfig } from '../src/snowflake/config.js';
import {
  ask,
  insightsHandler,
  localOrPublic,
  refusalFor,
  summarize,
  type InsightsOptions,
} from '../src/snowflake/insights.js';
import { jwtAccount, signJwt, SnowflakeRest } from '../src/snowflake/rest.js';
import { checkSchema, EXPECTED_COLUMNS, missingColumns } from '../src/snowflake/schema.js';

const H = 'hosp0001';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const CONFIG: SnowflakeConfig = {
  account: 'myorg-myacct',
  user: 'assetpulse_svc',
  privateKeyPem: PEM,
  role: 'ASSETPULSE_APP',
  warehouse: 'ASSETPULSE_WH',
  database: 'ASSETPULSE',
  schema: 'APP',
  semanticModelFile: '@ASSETPULSE.APP.MODELS/assetpulse.yaml',
};

function parEvent(seq: number): SequencedEvent {
  return {
    v: PROTOCOL_VERSION,
    ts: Date.UTC(2026, 9, 22, 12, 0, seq),
    seq,
    type: FrameType.parAlert,
    zoneId: 'CLEAN-UTIL',
    state: 'BREACH',
    clean: 2,
    min: 2,
    max: 5,
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
}

describe('loadSnowflakeConfig', () => {
  const full = {
    SNOWFLAKE_ENABLED: '1',
    SNOWFLAKE_ACCOUNT: 'myorg-myacct',
    SNOWFLAKE_USER: 'svc',
    SNOWFLAKE_ROLE: 'R',
    SNOWFLAKE_WAREHOUSE: 'W',
    SNOWFLAKE_DATABASE: 'D',
    SNOWFLAKE_SCHEMA: 'S',
    SNOWFLAKE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
  };

  it('stays off without the flag, even with every credential set', () => {
    expect(loadSnowflakeConfig({ ...full, SNOWFLAKE_ENABLED: undefined })).toEqual({
      config: null,
      missing: [],
    });
  });

  it('accepts the key as a bare base64 body on one line, the way a portal paste arrives', () => {
    const body = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const { config } = loadSnowflakeConfig({ ...full, SNOWFLAKE_PRIVATE_KEY: body });
    expect(config?.privateKeyPem.replace(/\s+/g, '')).toBe(PEM.replace(/\s+/g, ''));
  });

  it('stays off, rather than failing every request, when the key does not parse', () => {
    const { config, missing } = loadSnowflakeConfig({
      ...full,
      SNOWFLAKE_PRIVATE_KEY: 'not-a-key',
    });
    expect(config).toBeNull();
    expect(missing).toEqual(['a valid SNOWFLAKE_PRIVATE_KEY (it did not parse)']);
  });

  it('stays off and names what is missing when the flag is on but credentials are not', () => {
    const { config, missing } = loadSnowflakeConfig({ SNOWFLAKE_ENABLED: '1' });
    expect(config).toBeNull();
    expect(missing).toContain('SNOWFLAKE_ACCOUNT');
    expect(missing).toContain('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PRIVATE_KEY_PATH');
  });

  it('turns on with everything set, unescaping the inline key and defaulting the model path', () => {
    const { config } = loadSnowflakeConfig(full);
    expect(config?.privateKeyPem).toBe(PEM);
    expect(config?.semanticModelFile).toBe('@D.S.MODELS/assetpulse.yaml');
  });
});

describe('key-pair JWT', () => {
  it('uses the uppercase account (locator only) and user, and verifies with the public key', () => {
    expect(jwtAccount('xy12345.east-us-2.azure')).toBe('XY12345');
    const token = signJwt(CONFIG, 1_000);
    const [header, claims, signature] = token.split('.') as [string, string, string];
    const body = decode(claims);
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(body.sub).toBe('MYORG-MYACCT.ASSETPULSE_SVC');
    expect(body.iss).toMatch(/^MYORG-MYACCT\.ASSETPULSE_SVC\.SHA256:[A-Za-z0-9+/]+=*$/);
    expect(body.exp).toBe(1_000 + 3600);
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      privateKey,
      Buffer.from(signature, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

describe('SnowflakeRest', () => {
  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('posts one statement with positional bindings and polls a 202 to completion', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(202, { statementHandle: 'abc' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { resultSetMetaData: { rowType: [{ name: 'N' }] }, data: [['3']] }),
      );
    const rest = new SnowflakeRest(CONFIG, fetchImpl, async () => {});
    const result = await rest.query('SELECT ?', ['x', 2]);

    expect(result).toEqual({ columns: ['N'], rows: [['3']] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://myorg-myacct.snowflakecomputing.com/api/v2/statements');
    const sent = JSON.parse(init!.body as string) as { bindings: unknown; role: string };
    expect(sent.bindings).toEqual({
      1: { type: 'TEXT', value: 'x' },
      2: { type: 'FIXED', value: '2' },
    });
    expect(sent.role).toBe('ASSETPULSE_APP');
    expect((init!.headers as Record<string, string>)['x-snowflake-authorization-token-type']).toBe(
      'KEYPAIR_JWT',
    );
    expect(fetchImpl.mock.calls[1]![0]).toMatch(/\/api\/v2\/statements\/abc$/);
  });

  it('throws Snowflake’s message on an error status', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { message: 'JWT bad' }));
    await expect(new SnowflakeRest(CONFIG, fetchImpl).query('SELECT 1')).rejects.toThrow('JWT bad');
  });
});

describe('SnowflakeSink', () => {
  const sinks: SnowflakeSink[] = [];
  afterEach(() => sinks.splice(0).forEach((s) => s.close()));
  function sink(run: RunStatement, opts: SnowflakeSinkOptions = {}) {
    const s = new SnowflakeSink(run, { intervalMs: 60_000, onError: () => {}, ...opts });
    sinks.push(s);
    return s;
  }

  it('batches rows into one multi-row INSERT with PARSE_JSON for the payload', async () => {
    const run = vi.fn(async () => ({}));
    const s = sink(run, { batchMax: 10 });
    s.record(H, parEvent(1));
    s.record(H, parEvent(2));
    await s.flush();

    expect(run).toHaveBeenCalledTimes(1);
    const [sql, binds] = run.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('PARSE_JSON(column5)');
    expect(sql.match(/\(\?, \?, \?, \?, \?\)/g)).toHaveLength(2);
    expect(binds.slice(0, 4)).toEqual(['2026-10-22T12:00:01.000Z', H, 1, 'par_alert']);
    expect(JSON.parse(binds[4] as string)).toMatchObject({ zoneId: 'CLEAN-UTIL', state: 'BREACH' });
    expect(s.stats.sent).toBe(2);
  });

  it('never throws into the publish path; a failed batch is requeued for the next send', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({});
    const s = sink(run);
    expect(() => s.record(H, parEvent(1))).not.toThrow();
    await s.flush();
    expect(s.stats.failedBatches).toBe(1);
    await s.flush();
    expect(s.stats.sent).toBe(1);
  });

  it('caps the queue by dropping the oldest rows when Snowflake is unreachable', () => {
    const s = sink(async () => ({}), { maxQueue: 3 });
    for (let i = 1; i <= 5; i++) s.record(H, parEvent(i));
    expect(s.stats.dropped).toBe(2);
  });
});

describe('TeeSink', () => {
  it('keeps writing local history when the Snowflake sink fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'assetpulse-tee-'));
    const failing: EventSink = { record: () => {}, flush: () => Promise.reject(new Error('down')) };
    const history = new HistorySink(dir);
    const tee = new TeeSink([failing, history]);
    tee.record(H, parEvent(1));
    await expect(tee.flush()).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('insights', () => {
  const scopedSql = `SELECT TECH, COUNT(*) FROM WORK_ORDERS WHERE HOSPITAL_ID = '${H}' GROUP BY 1`;

  it('refuses SQL that is not a single SELECT scoped to this hospital', () => {
    expect(refusalFor(scopedSql, H)).toBeNull();
    expect(refusalFor('DELETE FROM EVENTS', H)).toMatch(/SELECT/);
    expect(refusalFor(`SELECT 1 WHERE '${H}' = 'x'; DROP TABLE EVENTS;`, H)).toMatch(
      /one statement/,
    );
    expect(refusalFor('SELECT COUNT(*) FROM EVENTS', H)).toMatch(/hospital/);
  });

  it('asks Analyst with the hospital filter, runs its SQL, and returns the rows', async () => {
    const sf = {
      askAnalyst: vi.fn(async () => [
        { type: 'text', text: 'Orders by tech.' },
        { type: 'sql', statement: scopedSql },
      ]),
      query: vi.fn(async () => ({ columns: ['TECH', 'N'], rows: [['T-1', '4']] })),
    };
    const result = await ask(sf, H, 'Orders by tech?');
    expect(sf.askAnalyst.mock.calls[0]![0]).toContain(`HOSPITAL_ID = '${H}'`);
    expect(result).toMatchObject({
      text: 'Orders by tech.',
      columns: ['TECH', 'N'],
      rows: [['T-1', '4']],
    });
  });

  it('does not run SQL it refuses', async () => {
    const sf = {
      askAnalyst: vi.fn(async () => [{ type: 'sql', statement: 'SELECT * FROM EVENTS' }]),
      query: vi.fn(),
    };
    const result = await ask(sf, H, 'Everything?');
    expect(result.refused).toMatch(/hospital/);
    expect(sf.query).not.toHaveBeenCalled();
  });

  it('summarizes: measured metrics from SQL plus AI prose, hospital always a bind', async () => {
    const sf = {
      askAnalyst: vi.fn(),
      query: vi.fn(async (sql: string) =>
        sql.includes('AI_SUMMARIZE_AGG')
          ? { columns: [], rows: [['12', 'Quiet shift.']] }
          : { columns: [], rows: [['2', '1', '0.75', '2', '6']] },
      ),
    };
    expect(await summarize(sf, H)).toEqual({
      events: 12,
      summary: 'Quiet shift.',
      metrics: {
        ordersOpened: 2,
        ordersDelivered: 1,
        medianMinutesToDeliver: 0.75,
        parBreaches: 2,
        pumpMoves: 6,
      },
    });
    for (const [sql, binds] of sf.query.mock.calls as unknown as [string, string[]][]) {
      expect(sql).not.toContain(H);
      expect(binds.every((b) => b === H)).toBe(true);
    }
  });

  it('reports no median until an order has been delivered', async () => {
    const sf = {
      askAnalyst: vi.fn(),
      query: vi.fn(async () => ({ columns: [], rows: [['0', '0', null, '0', '0']] })),
    };
    expect((await summarize(sf, H)).metrics.medianMinutesToDeliver).toBeNull();
  });
});

describe('schema drift check', () => {
  const allColumns = Object.entries(EXPECTED_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => [table, column]),
  );
  const withRows = (rows: string[][]) => ({ query: vi.fn(async () => ({ columns: [], rows })) });

  it('names each expected column the account lacks, e.g. a view from before a setup.sql change', async () => {
    const stale = allColumns.filter(([t, c]) => !(t === 'WORK_ORDERS' && c === 'DELIVERED_AT'));
    expect(await missingColumns(withRows(stale))).toEqual(['WORK_ORDERS.DELIVERED_AT']);
  });

  it('stays quiet when the schema matches', async () => {
    const log = { warn: vi.fn() };
    expect(await checkSchema(withRows(allColumns), log)).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns with the fix when columns are missing, and never throws when Snowflake fails', async () => {
    const log = { warn: vi.fn() };
    expect(await checkSchema(withRows([]), log)).toBe(false);
    expect(log.warn.mock.calls[0]?.[0]).toMatch(/missing: EVENTS\.EVENT_TS.*re-run setup\.sql/);
    const down = { query: vi.fn(async () => Promise.reject(new Error('unreachable'))) };
    expect(await checkSchema(down, log)).toBeNull();
    expect(log.warn).toHaveBeenLastCalledWith(
      '[snowflake] could not check the schema:',
      'unreachable',
    );
  });
});

describe('insights guardrails', () => {
  const status = (code: number) =>
    Object.assign(new Error(`snowflake ${code}`), { snowflakeStatus: code });
  const okSummary = () => ({ columns: [], rows: [['0', '0', null, '0', '0']] });
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  async function serve(sf: Parameters<typeof insightsHandler>[0], options: InsightsOptions = {}) {
    const handler = insightsHandler(sf, { sleep: async () => {}, ...options });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://localhost:${(server.address() as AddressInfo).port}/api/insights`;
  }

  it('turns a non-transient Analyst SQL failure into an answer, not an error', async () => {
    const sf = {
      askAnalyst: vi.fn(async () => [{ type: 'sql', statement: `SELECT 1 WHERE H = '${H}'` }]),
      query: vi.fn(async () => Promise.reject(status(422))),
    };
    const result = await ask(sf, H, 'Odd question');
    expect(result.failed).toMatch(/Rephrase/);
    expect(sf.query).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure once, and does not retry a 4xx', async () => {
    const flaky = { askAnalyst: vi.fn(), query: vi.fn() };
    flaky.query.mockRejectedValueOnce(status(503)).mockResolvedValue(okSummary());
    let base = await serve(flaky);
    expect((await fetch(`${base}/summary?h=${H}`)).status).toBe(200);
    server!.close();

    const broken = { askAnalyst: vi.fn(), query: vi.fn(async () => Promise.reject(status(422))) };
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    base = await serve(broken);
    expect((await fetch(`${base}/summary?h=${H}`)).status).toBe(502);
    expect(broken.query).toHaveBeenCalledTimes(2); // the two summary statements, no retry
  });

  it('tells a quick second click how long to wait', async () => {
    const sf = { askAnalyst: vi.fn(), query: vi.fn(async () => okSummary()) };
    let t = 1_000;
    const base = await serve(sf, { now: () => t });
    expect((await fetch(`${base}/summary?h=${H}`)).status).toBe(200);
    t += 1_000;
    const res = await fetch(`${base}/summary?h=${H}`);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ retryAfterMs: 2_000 });
  });

  it('serves the glance cards from SQL alone, without holding up an Ask', async () => {
    const sf = {
      askAnalyst: vi.fn(async () => [{ type: 'text', text: 'Which tech?' }]),
      query: vi.fn(async () => ({ columns: [], rows: [['3', '2', '1.5', '1', '4']] })),
    };
    const base = await serve(sf, { now: () => 1_000 });
    const res = await fetch(`${base}/glance?h=${H}`);
    expect(await res.json()).toMatchObject({ ordersDelivered: 2, medianMinutesToDeliver: 1.5 });
    expect(sf.query).toHaveBeenCalledTimes(1);
    expect(sf.query.mock.calls[0]![0]).not.toContain('AI_');
    const ask = await fetch(`${base}/ask?h=${H}`, {
      method: 'POST',
      body: JSON.stringify({ question: 'Orders by tech?' }),
    });
    expect(ask.status).toBe(200);
  });

  it('caps calls per hour across every hospital', async () => {
    const sf = { askAnalyst: vi.fn(), query: vi.fn(async () => okSummary()) };
    const base = await serve(sf, { hourlyLimit: 2 });
    expect((await fetch(`${base}/summary?h=aaaa0001`)).status).toBe(200);
    expect((await fetch(`${base}/summary?h=aaaa0002`)).status).toBe(200);
    expect((await fetch(`${base}/summary?h=aaaa0003`)).status).toBe(503);
  });

  it('shows on localhost, hides on other hosts until made public, and 404s hidden routes', async () => {
    const sf = { askAnalyst: vi.fn(), query: vi.fn(async () => okSummary()) };
    const base = await serve(sf, { visibleTo: localOrPublic(false) });
    // fetch() drops a custom Host header, so send raw requests.
    const as = (host: string, p: string) =>
      new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        http
          .get(`${base}/${p}`, { headers: { host } }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
          })
          .on('error', reject);
      });
    expect((await as('localhost:5173', 'status')).body).toEqual({ enabled: true });
    expect((await as('assetpulse.proswitch.ai', 'status')).body).toEqual({ enabled: false });
    expect((await as('assetpulse.proswitch.ai', `summary?h=${H}`)).status).toBe(404);
    expect(sf.query).not.toHaveBeenCalled();
    const req = { headers: { host: 'assetpulse.proswitch.ai' } } as http.IncomingMessage;
    expect(localOrPublic(true)(req)).toBe(true);
  });

  it('hides the panel once the schema check finds drift, but not while it is unknown', async () => {
    const sf = { askAnalyst: vi.fn(), query: vi.fn() };
    let ok: boolean | null = null;
    const base = await serve(sf, { schemaOk: () => ok });
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ enabled: true });
    ok = false;
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ enabled: false });
  });
});

describe('app with the layer off (the production default)', () => {
  let app: App;
  let dir: string;
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports insights disabled and 404s every other insights route', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'assetpulse-off-'));
    app = await startApp({
      sink: new HistorySink(dir),
      serviceNow: new ServiceNowMock(() => {}),
      snowflake: null,
    });
    const base = `http://localhost:${app.port}/api/insights`;
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ enabled: false });
    expect((await fetch(`${base}/summary?h=${H}`)).status).toBe(404);
    expect((await fetch(`${base}/glance?h=${H}`)).status).toBe(404);
    expect((await fetch(`${base}/ask?h=${H}`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(app.sink).toBeInstanceOf(HistorySink);
  });
});
