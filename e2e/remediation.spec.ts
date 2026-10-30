import { expect, test, type Page } from '@playwright/test';

/** A fresh customer per run (8 chars of [a-z0-9]): its fleet and projects start untouched. */
const customer = `rem${Date.now().toString(36).slice(-5)}`;

const rows = (page: Page) =>
  page.getByRole('region', { name: 'Vulnerable devices' }).locator('tbody tr');

/** Waits for the grid's latest fetch to land, so reads see the current query's rows. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
}

/** The grid's CVSS column, as numbers, top to bottom. */
async function cvssColumn(page: Page): Promise<number[]> {
  const header = page.getByRole('columnheader');
  const index = (await header.allTextContents()).findIndex((t) => t.startsWith('CVSS'));
  const cells = await rows(page)
    .locator(`td:nth-child(${index + 1})`)
    .allTextContents();
  return cells.map(Number);
}

test('remediation: filter, sort, select, create a project, and advance it', async ({ page }) => {
  await page.goto(`/riskradar?h=${customer}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AssetPulse · RiskRadar');
  await settled(page);
  await expect(rows(page).first().getByRole('checkbox')).toBeVisible();

  await test.step('the Severity column filter narrows the grid and lands in the URL', async () => {
    await page.getByRole('button', { name: 'Filter Severity' }).click();
    await page.getByRole('dialog', { name: 'Filter Severity' }).getByLabel('Critical').check();
    await expect(page).toHaveURL(/severity=Critical/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Filter Severity' })).toBeHidden();
    // The pill above the grid names the filter, and the column's icon shows it is on.
    await expect(
      page.getByRole('button', { name: 'Remove filter Severity: Critical' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter Severity, 1 on' })).toBeVisible();
    await settled(page);
    await expect(rows(page).getByText('High', { exact: true })).toHaveCount(0);
  });

  await test.step('CVSS sorts both ways', async () => {
    const cvss = page.getByRole('columnheader', { name: /CVSS/ });
    await expect(cvss).toHaveAttribute('aria-sort', 'descending');
    await cvss.getByRole('button').click();
    await expect(cvss).toHaveAttribute('aria-sort', 'ascending');
    await expect(page).toHaveURL(/dir=asc/);
    await settled(page);
    const ascending = await cvssColumn(page);
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
  });

  const picked: string[] = [];
  await test.step('two rows selected and turned into a project', async () => {
    const boxes = page.getByRole('checkbox', { name: /^Select (?!all)/ });
    for (const i of [0, 1]) {
      const box = boxes.nth(i);
      picked.push(((await box.getAttribute('aria-label')) ?? '').replace(/^Select /, ''));
      await box.check();
    }
    await expect(page.getByText('2 devices selected')).toBeVisible();
    await page.getByLabel('Project name').fill('Patch two critical devices');
    await page.getByRole('button', { name: 'Create project from 2 selected' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Created “Patch two critical devices” with 2 devices.',
    );
  });

  await test.step('the project is listed and its devices are now Planned', async () => {
    for (const tag of picked) {
      await expect(rows(page).filter({ hasText: tag })).toContainText('Planned');
    }
    await expect(page.getByText('0 devices selected')).toBeVisible();
    await page.getByRole('button', { name: 'Projects, 1' }).click();
    const project = page
      .getByRole('dialog', { name: 'Projects' })
      .getByRole('listitem')
      .filter({ hasText: 'Patch two critical devices' });
    await expect(project).toContainText('2 devices');
    await expect(project).toContainText('Open');
  });

  await test.step('advancing the project moves it to In progress, then Done', async () => {
    await page.getByRole('button', { name: 'Start work: Patch two critical devices' }).click();
    await expect(page.getByRole('status')).toHaveText(
      '“Patch two critical devices” is now In progress.',
    );
    await page.getByRole('button', { name: 'Mark done: Patch two critical devices' }).click();
    await expect(page.getByRole('status')).toHaveText('“Patch two critical devices” is now Done.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Projects' })).toBeHidden();
    for (const tag of picked) {
      await expect(rows(page).filter({ hasText: tag })).toContainText('Remediated');
    }
  });
});

test('remediation: the asset tag and the CVE open their details', async ({ page }) => {
  await page.goto(`/riskradar?h=det${customer.slice(3)}`);
  await settled(page);
  const first = rows(page).first();
  const [tag, cve] = await first.getByRole('button').allTextContents();

  await test.step('the asset tag opens the device, and Escape hands focus back', async () => {
    await first.getByRole('button', { name: tag }).click();
    const device = page.getByRole('dialog', { name: tag });
    await expect(device).toContainText('Manufacturer');
    await expect(device).toContainText('Not in a project yet');
    await page.keyboard.press('Escape');
    await expect(device).toBeHidden();
    await expect(first.getByRole('button', { name: tag })).toBeFocused();
  });

  await test.step('the device links on to its vulnerability', async () => {
    await first.getByRole('button', { name: tag }).click();
    await page.getByRole('dialog', { name: tag }).getByRole('button', { name: cve }).click();
    await expect(page.getByRole('dialog', { name: cve })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  await test.step('the CVE opens its fleet impact and narrows the grid to it', async () => {
    await first.getByRole('button', { name: cve }).click();
    const vuln = page.getByRole('dialog', { name: cve });
    const show = vuln.getByRole('button', { name: /^Show (all \d+ devices|the 1 device)$/ });
    const count = /\d+/.exec((await show.textContent()) ?? '')![0];
    await show.click();
    await expect(vuln).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`q=${cve}`));
    await settled(page);
    await expect(page.locator('#devices-heading')).toHaveText(new RegExp(`^${count} vulnerable`));
  });
});

test('remediation: at a 1280px laptop width the grid has the page to itself', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/riskradar?h=lap${customer.slice(3)}`);
  await settled(page);
  const region = page.getByRole('region', { name: 'Vulnerable devices', exact: true });
  const grid = await region.boundingBox();
  expect(grid!.width).toBeGreaterThan(1280 * 0.85);
  await expect(page.getByRole('region', { name: 'Remediation projects' })).toHaveCount(0);
  // The grid's own scroll box holds every column without scrolling sideways.
  expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test('remediation: a column filter works from the keyboard alone', async ({ page }) => {
  await page.goto(`/riskradar?h=kbd${customer.slice(3)}`);
  await settled(page);
  const button = page.getByRole('button', { name: 'Filter Status' });
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Filter Status' });
  await expect(dialog).toBeVisible();
  // Focus moves into the list, so Space ticks the first value straight away.
  await expect(dialog.getByRole('checkbox').first()).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/status=/);
  // Escape closes it and hands focus back to the column's button.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filter Status, 1 on' })).toBeFocused();
});

test('remediation: a reload reproduces the view from the URL', async ({ page }) => {
  await page.goto(`/riskradar?h=rex${customer.slice(3)}&severity=High&sort=hospital&dir=asc`);
  await expect(page.getByRole('button', { name: 'Remove filter Severity: High' })).toBeVisible();
  await page.getByRole('button', { name: 'Filter Severity, 1 on' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Filter Severity' }).getByLabel('High'),
  ).toBeChecked();
  await expect(page.getByRole('columnheader', { name: /Hospital/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
});
