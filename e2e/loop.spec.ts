import { expect, test } from '@playwright/test';

// A fresh sandbox per run (8 chars of [a-z0-9]), so a reused server never hands back a world an
// earlier run already drained.
const hospital = `e2e${Date.now().toString(36).slice(-5)}`;

/** Three pumps off the shelf takes it from 5 to 2, which is at PAR min, so an order is raised. */
const MOVES: [pump: string, room: string][] = [
  ['IVP-101', 'ICU-301'],
  ['IVP-102', 'ICU-302'],
  ['IVP-103', 'WARD-303'],
];

test('restock loop: drain the shelf, pager accepts, restock clears PAR, resume replays', async ({
  browser,
}) => {
  // The resume step waits out a 10 s outage.
  test.setTimeout(60_000);

  const desk = await (await browser.newContext()).newPage();
  const phone = await (await browser.newContext()).newPage();
  const pager = desk.getByRole('region', { name: 'Tech pager' });
  const badge = desk.getByRole('status').filter({ hasText: /Below PAR|Buffer OK/ });

  await test.step('three pumps to rooms breach PAR', async () => {
    await desk.goto(`/?h=${hospital}`);
    await phone.goto(`/tech?h=${hospital}`);
    await expect(badge).toHaveText('✓ Buffer OK (5/5)');
    for (const [pump, room] of MOVES) {
      const pill = desk.locator(`button[data-pump="${pump}"]`);
      const zone = desk.locator(`[data-zone="${room}"]`);
      await pill.dragTo(zone);
      await expect(zone.locator(`button[data-pump="${pump}"]`)).toBeVisible();
    }
    await expect(badge).toHaveText('⚠ Below PAR (2/5)');
  });

  await test.step('the order reaches the pager and the phone', async () => {
    await expect(pager.getByText('New order')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Accept' })).toBeVisible();
  });

  await test.step('pager accepts, and the phone loses the order', async () => {
    await pager.getByRole('button', { name: 'Accept' }).click();
    await expect(pager.getByRole('button', { name: 'Complete restock (+3)' })).toBeVisible();
    // The phone lists only open orders and its own, so another tech's acceptance clears it.
    await expect(phone.getByRole('button', { name: 'Accept' })).toBeHidden();
    await expect(phone.getByText(/^Nothing to restock/)).toBeVisible();
  });

  await test.step('restock clears PAR', async () => {
    await pager.getByRole('button', { name: 'Complete restock (+3)' }).click();
    await expect(badge).toHaveText('✓ Buffer OK (5/5)');
    await expect(pager.getByText('Standby')).toBeVisible();
  });

  await test.step('resume replays the outage', async () => {
    // Offline 10 s, then resume: the toast reports the replayed gap (or a resync).
    await desk.getByRole('button', { name: /Live WebSocket/ }).click();
    await desk.getByRole('button', { name: 'Drop connection 10 s' }).click();
    await expect(desk.getByRole('button', { name: /^Offline · back in/ })).toBeVisible();
    await expect(
      desk.getByRole('status').filter({ hasText: /Missed while offline|Back online/ }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
