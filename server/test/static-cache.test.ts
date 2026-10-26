import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistorySink } from '../src/adapters/history-sink.js';
import { ServiceNowMock } from '../src/adapters/servicenow-mock.js';
import { startApp, type App } from '../src/app.js';

let app: App;
let root: string;

const get = (p: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${app.port}${p}`, { headers });

const start = async () => {
  app = await startApp({
    port: 0,
    webDir: path.join(root, 'web'),
    techDir: path.join(root, 'no-tech'),
    snowflake: null,
    sink: new HistorySink(path.join(root, 'history')),
    serviceNow: new ServiceNowMock(() => {}),
  });
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'assetpulse-static-'));
  const web = path.join(root, 'web');
  await mkdir(path.join(web, 'assets'), { recursive: true });
  await mkdir(path.join(web, 'tour'), { recursive: true });
  await writeFile(path.join(web, 'index.html'), '<!doctype html>');
  await writeFile(path.join(web, 'assets', 'index-abc123.js'), 'x');
  await writeFile(path.join(web, 'tour', 'assetpulse-tour.mp4'), 'cut one');
  await start();
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('static cache headers', () => {
  it('caches hashed build assets forever', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('makes pages and the tour video revalidate on every load', async () => {
    for (const p of ['/', '/tour/assetpulse-tour.mp4']) {
      const res = await get(p);
      expect(res.headers.get('cache-control'), p).toBe('no-cache');
      expect(res.headers.get('etag'), p).toBeTruthy();
    }
  });

  it('answers 304 while the video is unchanged, and the new cut after a deploy', async () => {
    const first = await get('/tour/assetpulse-tour.mp4');
    const etag = first.headers.get('etag')!;
    expect((await get('/tour/assetpulse-tour.mp4', { 'if-none-match': etag })).status).toBe(304);

    // A deploy replaces the file and restarts the server (sirv indexes files at startup).
    await writeFile(path.join(root, 'web', 'tour', 'assetpulse-tour.mp4'), 'cut two, longer');
    await app.close();
    await start();
    const fresh = await get('/tour/assetpulse-tour.mp4', { 'if-none-match': etag });
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe('cut two, longer');
  });
});
