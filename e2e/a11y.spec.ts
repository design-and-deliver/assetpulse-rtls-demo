import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility gate: axe-core over every screen, in both color schemes, against the built app.
 * Any WCAG 2.2 A/AA violation (or axe best-practice failure) fails CI. axe can't judge everything
 * (keyboard paths, screen-reader wording), so the loop e2e and manual NVDA passes still matter.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** A fresh sandbox per run, like loop.spec.ts. */
const hospital = `a11y${Date.now().toString(36).slice(-4)}`;

/** The dialog's cards; `events: 0` is a floor with nothing recorded yet (the empty state). */
async function mockGlance(page: Page, events: number): Promise<void> {
  await page.route('**/api/insights/glance**', (route) =>
    route.fulfill({
      json: {
        session: events ? `${hospital}-run1` : null,
        events,
        ordersOpened: events ? 2 : 0,
        ordersDelivered: events ? 2 : 0,
        medianMinutesToDeliver: events ? 0.07 : null,
        medianMinutesToAccept: events ? 0.03 : null,
        parBreaches: events ? 2 : 0,
        pumpMoves: events ? 12 : 0,
      },
    }),
  );
}

/**
 * A fresh floor with one pump moved: Insights only opens once the session has activity, and a
 * floor of its own keeps that true whichever test runs first.
 */
async function startSession(page: Page): Promise<void> {
  const h = `i${Math.random().toString(36).slice(2, 9).padEnd(7, '0')}`;
  await page.goto(`/?h=${h}`);
  await page.locator('button[data-pump="IVP-101"]').click();
  await page
    .locator('[data-zone="ICU-301"]')
    .getByRole('button', { name: 'Move IVP-101 here' })
    .click();
  await expect(page.locator('[data-zone="ICU-301"] button[data-pump="IVP-101"]')).toBeVisible();
}

async function expectNoViolations(page: Page, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const { violations } = await (include ? builder.include(include) : builder).analyze();
  // One line per rule and element, so the CI log says exactly what to fix.
  const report = violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`),
  );
  expect(report).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test('ops console', async ({ page }) => {
      await page.goto(`/?h=${hospital}`);
      await expect(page.getByRole('status').filter({ hasText: /Buffer OK/ })).toBeVisible();
      await expectNoViolations(page);
    });

    test('ops console with the shelf at its minimum', async ({ page }) => {
      await page.goto(`/?h=${hospital}b`);
      for (const [pump, room] of [
        ['IVP-101', 'ICU-301'],
        ['IVP-102', 'ICU-302'],
        ['IVP-103', 'WARD-303'],
      ]) {
        await page.locator(`button[data-pump="${pump}"]`).click();
        // Every room offers its own "Move … here"; take the target room's.
        await page
          .locator(`[data-zone="${room}"]`)
          .getByRole('button', { name: `Move ${pump} here` })
          .click();
        await expect(
          page.locator(`[data-zone="${room}"] button[data-pump="${pump}"]`),
        ).toBeVisible();
      }
      await expect(page.getByRole('status').filter({ hasText: /At min/ })).toBeVisible();
      await expectNoViolations(page);
    });

    test('tour page, reached from the console header', async ({ page }) => {
      await page.goto(`/?h=${hospital}`);
      await page.getByRole('link', { name: /Watch the 2-minute tour/ }).click();
      await expect(page).toHaveURL(/\/tour$/);
      await expect(page.getByRole('heading', { name: 'AssetPulse tour' })).toBeVisible();
      await expect(page.locator('video track[kind="captions"]')).toHaveCount(1);
      await expectNoViolations(page);
    });

    test('remediation page, filtered with a selection', async ({ page }) => {
      await page.goto(`/riskradar?h=${hospital}`);
      await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Filter Severity' }).click();
      await page.getByRole('dialog', { name: 'Filter Severity' }).getByLabel('Critical').check();
      await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
      await expectNoViolations(page); // with the column filter open
      await page.keyboard.press('Escape');
      await page
        .getByRole('checkbox', { name: /^Select (?!all)/ })
        .first()
        .check();
      // Name it so the create buttons are enabled: a disabled control is exempt from contrast.
      await page.getByLabel('Project name').fill('Patch critical devices');
      await expectNoViolations(page);
    });

    test('remediation page, wide two-column layout and phone width', async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`/riskradar?h=${hospital}`);
      await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
      await expectNoViolations(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoViolations(page);
    });

    test('tech handheld', async ({ page }) => {
      await page.goto(`/tech?h=${hospital}`);
      // Desktop width shows the phone frame, which starts on its lock screen: scan both screens.
      await page.getByRole('button', { name: 'Tap to open AssetPulse' }).waitFor();
      await expectNoViolations(page);
      await page.getByRole('button', { name: 'Tap to open AssetPulse' }).click();
      await expect(page.getByRole('heading', { name: 'AssetPulse' })).toBeVisible();
      await expectNoViolations(page);
    });

    test('insights dialog', async ({ page }) => {
      // CI has no Snowflake, so pretend the server has it on; only the dialog's markup is under test.
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await mockGlance(page, 18);
      await startSession(page);
      await page.getByRole('button', { name: /Insights/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      // Type first: a disabled Ask is exempt from contrast, the enabled one is not.
      await page.getByLabel(/Question about/).fill('Orders by tech');
      await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
      await expectNoViolations(page, 'dialog');
      // Each open starts fresh: an empty question box, with the focus in it.
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /Insights/ }).click();
      await expect(page.getByLabel(/Question about/)).toHaveValue('');
      await expect(page.getByLabel(/Question about/)).toBeFocused();
    });

    test('insights hint before any activity', async ({ page }) => {
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await page.goto(`/?h=i${Date.now().toString(36).slice(-7)}`);
      await page.getByRole('button', { name: /Insights/ }).click();
      // Nothing to analyze yet: the hint shows on the main screen and the dialog stays shut.
      await expect(page.getByRole('status').filter({ hasText: /Move a few pumps/ })).toBeVisible();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expectNoViolations(page);
      // A click anywhere else dismisses it.
      await page.getByRole('heading', { level: 1 }).click();
      await expect(page.getByText(/Move a few pumps/)).toBeHidden();
    });

    test('insights dialog while Snowflake catches up', async ({ page }) => {
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await mockGlance(page, 0);
      await startSession(page);
      await page.getByRole('button', { name: /Insights/ }).click();
      await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
      await expect(page.getByLabel(/Question about/)).toHaveCount(0);
      await expectNoViolations(page, 'dialog');
    });

    test('insights dialog with answers', async ({ page }) => {
      // Canned Cortex replies, shaped like the server's, so the answered markup gets scanned too.
      let releaseAsk = () => {};
      const askHeld = new Promise<void>((resolve) => (releaseAsk = resolve));
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await mockGlance(page, 18);
      await page.route('**/api/insights/ask**', async (route) => {
        await askHeld;
        await route.fulfill({
          json: {
            text: 'This is our interpretation of your question: median minutes by tech.',
            sql: 'SELECT tech, MEDIAN(minutes) AS median_minutes FROM orders GROUP BY tech',
            columns: ['TECH', 'MEDIAN_MINUTES', 'ORDERS'],
            rows: [
              [null, '0.0667', '2'],
              ['T-07', '1.5', '3'],
            ],
            suggestions: [],
          },
        });
      });
      await startSession(page);
      await page.getByRole('button', { name: /Insights/ }).click();
      await page.getByLabel(/Question about/).fill('Median minutes from page to delivery, by tech');
      const ask = page.getByRole('button', { name: 'Ask', exact: true });
      await ask.focus();
      await page.keyboard.press('Enter');
      // While Cortex works, the pressed button keeps keyboard focus (it must not go disabled).
      const asking = page.getByRole('button', { name: 'Asking…' });
      await expect(asking).toHaveAttribute('aria-disabled', 'true');
      await expect(asking).toBeFocused();
      releaseAsk();
      await expect(page.getByRole('region', { name: 'Query results' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Median minutes' })).toBeVisible();
      await page.getByText('How Cortex answered').click();
      await expectNoViolations(page, 'dialog');
    });
  });
}
