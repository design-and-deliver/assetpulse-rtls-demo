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

    test('tech handheld', async ({ page }) => {
      await page.goto(`/tech?h=${hospital}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoViolations(page);
    });

    test('insights dialog', async ({ page }) => {
      // CI has no Snowflake, so pretend the server has it on; only the dialog's markup is under test.
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await page.goto(`/?h=${hospital}`);
      await page.getByRole('button', { name: /Insights/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      // Type first: a disabled Ask is exempt from contrast, the enabled one is not.
      await page.getByLabel(/Question about/).fill('Orders by tech');
      await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeEnabled();
      await expectNoViolations(page, 'dialog');
    });

    test('insights dialog with answers', async ({ page }) => {
      // Canned Cortex replies, shaped like the server's, so the answered markup gets scanned too.
      let releaseAsk = () => {};
      const askHeld = new Promise<void>((resolve) => (releaseAsk = resolve));
      await page.route('**/api/insights/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
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
      await page.route('**/api/insights/summary**', (route) =>
        route.fulfill({
          json: {
            events: 18,
            metrics: {
              ordersOpened: 2,
              ordersClosed: 2,
              medianMinutesToDeliver: 0.07,
              parBreaches: 2,
              pumpMoves: 12,
            },
            summary:
              'Three pumps moved to patient rooms, the shelf hit its minimum, and a tech restocked it.',
          },
        }),
      );
      await page.goto(`/?h=${hospital}`);
      await page.getByRole('button', { name: /Insights/ }).click();
      const chip = page.getByRole('button', { name: /by tech$/ });
      await chip.focus();
      await page.keyboard.press('Enter');
      // While Cortex works, the pressed chip keeps keyboard focus (it must not go disabled).
      await expect(chip).toHaveAttribute('aria-disabled', 'true');
      await expect(chip).toBeFocused();
      releaseAsk();
      await expect(page.getByRole('region', { name: 'Query results' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Median minutes' })).toBeVisible();
      await page.getByRole('button', { name: 'Shift summary' }).click();
      await expect(page.getByRole('heading', { name: 'Last 12 hours' })).toBeVisible();
      await page.getByText('SQL Cortex Analyst wrote').click();
      await expectNoViolations(page, 'dialog');
    });
  });
}
