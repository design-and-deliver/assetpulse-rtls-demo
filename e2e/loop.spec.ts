import { expect, test, type Locator, type Page } from '@playwright/test';

// A fresh sandbox per run (8 chars of [a-z0-9]), so a reused dev server never hands back a
// world an earlier run already surged.
const hospital = `e2e${Date.now().toString(36).slice(-5)}`;

/** READY pumps to stage before delivering: min 3 on the shelf, plus one spare for a room event. */
const READY_TARGET = 4;

/** Each status's next step, as the console drag performs it: status label → drop zone label. */
const NEXT_DROP: [status: string, zone: string][] = [
  ['Reprocessing', 'Sterile Processing'],
  ['Soiled', 'Sterile Processing'],
  ['In use', 'Soiled Utility'],
];

async function center(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error('element not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, size: box.width };
}

/**
 * Drags one pump dot onto a zone, the way a person does on the console's floor map. A pump that
 * just changed zones glides there for ~1.5 s, so grab it only once it is back to its idle
 * jitter (well under a dot's width per 200 ms), and retry a grab that missed.
 */
async function dragPump(page: Page, title: string, zone: string) {
  const dot = page.locator('svg g').filter({ has: page.locator(`title:text-is("${title}")`) });
  const zoneRect = page
    .locator('svg g')
    .filter({ has: page.locator(`text:text-is("${zone}")`) })
    .locator('rect');
  await expect(async () => {
    const before = await center(dot);
    await page.waitForTimeout(200);
    const from = await center(dot);
    expect(Math.hypot(from.x - before.x, from.y - before.y)).toBeLessThan(from.size);
    const to = await center(zoneRect);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect(dot).toHaveCount(0, { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

/** Walks pumps down the lifecycle until READY_TARGET sit in Sterile Processing. */
async function stageReadyPumps(page: Page) {
  const titles = () => page.locator('svg g > title').allTextContents();
  while ((await titles()).filter((t) => t.includes(' · Ready · ')).length < READY_TARGET) {
    const all = await titles();
    const step = NEXT_DROP.map(([status, zone]) => ({
      title: all.find((t) => t.includes(` · ${status} · `)),
      zone,
    })).find((s) => s.title !== undefined);
    if (!step?.title) throw new Error(`no pump left to advance: ${all.join(' | ')}`);
    await dragPump(page, step.title, step.zone);
  }
}

test('dispatch loop: surge, tech restocks, PAR clears, resume replays', async ({ browser }) => {
  // Staging walks a dozen drags through real sim state, and resume waits out a 10 s outage.
  test.setTimeout(60_000);

  const desk = await (await browser.newContext()).newPage();
  const tech = await (await browser.newContext()).newPage();
  const breach = desk.getByText('Below PAR — restock order raised');

  await test.step('surge breaches PAR', async () => {
    await desk.goto(`/?h=${hospital}`);
    await tech.goto(`/tech?h=${hospital}`);
    const surge = desk.getByRole('button', { name: 'Surge ICU' });
    await expect(surge).toBeEnabled();
    // Room events may already have taken pumps, so surge until the shelf breaches.
    await expect(async () => {
      await surge.click();
      await expect(breach).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  });

  await test.step('tech accepts the order', async () => {
    // The order crosses to the second context, and its acceptance crosses back.
    await tech.getByRole('button', { name: 'Accept' }).click();
    await expect(desk.getByText(/^Accepted · /)).toBeVisible();
  });

  await test.step('stage READY pumps', () => stageReadyPumps(desk));

  await test.step('delivery clears PAR', async () => {
    await tech.getByRole('button', { name: 'Delivered' }).click();
    await expect(breach).toBeHidden();
    await expect(desk.getByText('None open')).toBeVisible();
  });

  await test.step('resume replays the outage', async () => {
    // Offline 10 s, then resume: the toast reports the replayed gap (or a resync).
    await desk.getByRole('button', { name: 'Kill network 10 s' }).click();
    await expect(desk.getByRole('button', { name: /^Offline · back in/ })).toBeVisible();
    await expect(
      desk.getByRole('status').filter({ hasText: /Missed while offline|Back online/ }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
