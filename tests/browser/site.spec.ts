import { expect, test } from "@playwright/test";

test("moves from model overview to a sourced forecast observation", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Northstar Cloud" })).toBeVisible();
  await expect(page.getByText("Validated", { exact: true })).toBeVisible();

  await page.locator(".primary-nav button").filter({ hasText: "Financial table" }).click();
  await expect(page.getByRole("heading", { name: "Financial table" })).toBeVisible();
  await expect(page.getByText("Subscription revenue", { exact: true })).toBeVisible();

  const forecastCell = page.getByTitle(/Assumption · obs_northstar_subscription_revenue_fy2025/);
  await expect(forecastCell).toContainText("1,315.0");
  await forecastCell.click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expect(page.getByText("Model!E11")).toBeVisible();
  await expect(page.getByText("94%")).toBeVisible();
  await expect(page.getByText("unreviewed", { exact: true }).first()).toBeVisible();
});

test("uses one frontend for a structurally different bank model", async ({ page }) => {
  await page.goto("./");
  await page.getByLabel("Active model").selectOption("model_harbor_national");
  await expect(page.getByRole("heading", { name: "Harbor National" })).toBeVisible();
  await expect(page.getByText("Needs review")).toBeVisible();

  await page.locator(".primary-nav button").filter({ hasText: "Financial table" }).click();
  await expect(page.getByText("Provision for credit losses", { exact: true })).toBeVisible();
  await expect(page.getByText("Subscription revenue", { exact: true })).toHaveCount(0);
});

test("renders formula-derived dependency edges and details", async ({ page }) => {
  await page.goto("./");
  await page.locator(".primary-nav button").filter({ hasText: "Dependency graph" }).click();
  await expect(page.getByTestId("dependency-graph-view")).toBeVisible();
  await page.locator(".metric-picker select").selectOption("metric_northstar_gross_profit");
  await expect(
    page.locator(
      '.dependency-edge[data-from="metric_northstar_revenue"][data-to="metric_northstar_gross_profit"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '.dependency-edge[data-from="metric_northstar_gross_profit"][data-to="metric_northstar_gross_margin"]',
    ),
  ).toHaveCount(1);
  await expect(page.locator(".graph-node--focus .node-name")).toHaveText("Gross profit");

  await page
    .locator('[data-transformation-id="transformation_northstar_gross_profit"]')
    .click();
  const detailPanel = page.getByTestId("detail-panel");
  await expect(detailPanel.getByText("Formula lineage")).toBeVisible();
  await expect(detailPanel.locator(".formula-pair code").filter({ hasText: "=B10-B16" })).toBeVisible();
});

test("keeps the mobile shell within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only layout assertion");
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Northstar Cloud" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);

  await page.locator(".primary-nav button").filter({ hasText: "Financial table" }).click();
  await expect(page.getByTestId("financial-table-view")).toBeVisible();
  await expect(page.locator(".financial-table-wrap")).toHaveCSS("overflow-x", "auto");
});
