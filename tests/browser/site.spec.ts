import { expect, test, type Page } from "@playwright/test";
import sample from "../../examples/sample-model-db.json" with { type: "json" };
import type { ModelDatabase } from "../../src/model-db/types";

async function uploadJson(
  page: Page,
  name: string,
  value: unknown,
) {
  const contents = typeof value === "string" ? value : JSON.stringify(value);
  await page.getByTestId("json-file-input").evaluate(
    (element, file) => {
      const input = element as HTMLInputElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.contents], file.name, { type: "application/json" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { name, contents },
  );
}

test("opens on the extracted model table and inspects a sourced cell", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Northstar Cloud" })).toBeVisible();
  await expect(page.getByTestId("financial-table-view")).toBeVisible();
  await expect(page.getByText("Revenue build", { exact: true })).toBeVisible();
  await expect(page.getByText("Gross profit", { exact: true }).first()).toBeVisible();

  const forecastCell = page.getByTitle(/Assumption · obs_northstar_subscription_revenue_fy2025/);
  await expect(forecastCell).toContainText("1,315.0");
  await forecastCell.click();

  const inspector = page.getByTestId("detail-panel");
  await expect(inspector.getByText("Selected cell · FY25E")).toBeVisible();
  await expect(inspector.getByText("Model!E11")).toBeVisible();
  await expect(inspector.getByText("94%")).toBeVisible();
  await expect(inspector.getByText("unreviewed", { exact: true })).toBeVisible();
});

test("shows actual workbook inputs for a derived cell", async ({ page }) => {
  await page.goto("./");
  await page.getByTitle(/Assumption · obs_northstar_subscription_revenue_fy2025/).click();
  const derivedCell = page.getByTitle(/Derived · obs_northstar_gross_profit_fy2025/);
  await derivedCell.click();
  await expect(derivedCell).toHaveClass(/selected/);
  await expect(page.locator(".value-button.selected")).toHaveAttribute(
    "title",
    /obs_northstar_gross_profit_fy2025/,
  );

  const lineage = page.getByTestId("formula-lineage");
  await expect(lineage).toContainText("Derived from 2 inputs");
  await expect(lineage).toContainText("Revenue");
  await expect(lineage).toContainText("Model!E10");
  await expect(lineage).toContainText("Cost of revenue");
  await expect(lineage).toContainText("Model!E16");
  await expect(lineage.getByText("=B10-B16", { exact: true })).toBeVisible();
});

test("labels opaque formulas without inventing canonical lineage", async ({ page }) => {
  await page.goto("./");
  const imported = structuredClone(sample) as ModelDatabase;
  const transformation = imported.transformations.find(
    (item) => item.id === "transformation_northstar_gross_profit",
  );
  if (!transformation) throw new Error("Missing representative transformation");
  transformation.status = "opaque";
  transformation.expression = "0";
  transformation.dependencyMetricIds = [];

  await uploadJson(page, "opaque-formula.json", imported);
  await page.getByTitle(/Derived · obs_northstar_gross_profit_fy2025/).click();
  const lineage = page.getByTestId("formula-lineage");
  await expect(lineage).toContainText("Opaque workbook formula");
  await expect(lineage).toContainText("Not translated (opaque)");
  await expect(lineage).not.toContainText("Derived from 0 inputs");
});

test("uses extracted sections for a structurally different bank model", async ({ page }) => {
  await page.goto("./");
  await page.getByLabel("Active model").selectOption("model_harbor_national");
  await expect(page.getByRole("heading", { name: "Harbor National" })).toBeVisible();
  await expect(page.getByText("Operating income", { exact: true })).toBeVisible();
  await expect(page.getByText("Credit and costs", { exact: true })).toBeVisible();
  await expect(page.getByText("Provision for credit losses", { exact: true })).toBeVisible();
  await expect(page.getByText("1 review warning")).toBeVisible();
  await expect(page.getByLabel("1 open extraction issue")).toBeVisible();
  await page.getByTitle(/obs_harbor_provision_fy2025/).click();
  await expect(page.getByTestId("cell-review-warning")).toContainText(
    "The workbook label 'LLP' was mapped to provision for credit losses",
  );
  await expect(page.getByTestId("cell-review-warning")).toContainText("Model!A14");
  await expect(page.getByText("Subscription revenue", { exact: true })).toHaveCount(0);
});

test("renders formula-derived dependency edges in the optional lineage map", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Lineage map" }).click();
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
});

test("keeps the mobile shell within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only layout assertion");
  await page.goto("./");
  await expect(page.getByTestId("financial-table-view")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.locator(".financial-table-wrap")).toHaveCSS("overflow-x", "auto");
});

test("previews a validated model database JSON file locally", async ({ page }) => {
  await page.goto("./");
  const imported = structuredClone(sample);
  imported.dataset.name = "Imported analyst model";

  await uploadJson(page, "analyst-model.json", imported);

  const notice = page.getByTestId("import-notice");
  await expect(notice).toContainText("Previewing analyst-model.json");
  await expect(notice).toContainText("The file stays in this browser tab");
  await expect(page.locator(".dataset-breadcrumb")).toContainText("Imported analyst model");
  await expect(page.getByRole("heading", { name: "Northstar Cloud" })).toBeVisible();
});

test("separates annual and quarterly periods in a mixed-frequency model", async ({ page }) => {
  await page.goto("./");
  const imported = structuredClone(sample) as ModelDatabase;
  imported.periods.push({
    id: "period_q4_2024",
    label: "Q4'24A",
    type: "fiscal_quarter",
    startDate: "2024-10-01",
    endDate: "2024-12-31",
  });
  imported.observations.push({
    ...imported.observations.find((item) => item.id === "obs_northstar_revenue_fy2024")!,
    id: "obs_northstar_revenue_q4_2024",
    periodId: "period_q4_2024",
    value: 360,
  });
  imported.provenanceRecords.push(
    {
      id: "provenance_period_q4_2024",
      targetId: "period_q4_2024",
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "D3" },
      extractionRunId: "run_northstar_2025_03_15",
      confidence: 0.99,
      reviewStatus: "unreviewed",
    },
    {
      id: "provenance_obs_northstar_revenue_q4_2024",
      targetId: "obs_northstar_revenue_q4_2024",
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "D10" },
      extractionRunId: "run_northstar_2025_03_15",
      confidence: 0.99,
      reviewStatus: "unreviewed",
    },
  );

  await uploadJson(page, "mixed-frequency.json", imported);
  const periodView = page.getByLabel("Period view");
  await expect(periodView).toBeVisible();
  await expect(page.getByText("FY22A", { exact: true })).toBeVisible();
  await expect(page.getByText("Q4'24A", { exact: true })).toHaveCount(0);
  await periodView.selectOption("fiscal_quarter");
  await expect(page.getByText("Q4'24A", { exact: true })).toBeVisible();
  await expect(page.getByText("FY22A", { exact: true })).toHaveCount(0);
});

test("surfaces an explicitly acknowledged presentation fallback", async ({ page }) => {
  await page.goto("./");
  const imported = structuredClone(sample) as ModelDatabase;
  imported.tablePresentations = imported.tablePresentations.filter(
    (presentation) => presentation.modelId !== "model_northstar_cloud",
  );
  imported.unresolvedItems.push({
    id: "unresolved_northstar_table_presentation",
    modelId: "model_northstar_cloud",
    category: "presentation",
    description: "The workbook does not expose defensible table sections.",
    sourceArtifactId: "artifact_northstar_workbook",
    status: "open",
  });
  imported.provenanceRecords.push({
    id: "provenance_unresolved_northstar_table_presentation",
    targetId: "unresolved_northstar_table_presentation",
    sourceArtifactId: "artifact_northstar_workbook",
    locator: { sheet: "Model" },
    extractionRunId: "run_northstar_2025_03_15",
    confidence: 0.4,
    reviewStatus: "unreviewed",
  });

  await uploadJson(page, "fallback-model.json", imported);

  await expect(page.getByTestId("import-notice")).toContainText("with 2 warnings");
  await expect(page.getByText("2 review warnings")).toBeVisible();
  await expect(page.getByText("Source-order fallback")).toBeVisible();
});

test("keeps the current preview when an uploaded file is malformed", async ({ page }) => {
  await page.goto("./");
  await uploadJson(page, "broken.json", '{"schemaVersion":');

  await expect(page.getByRole("alert")).toContainText("Could not read this JSON");
  await expect(page.getByRole("alert")).toContainText("not valid JSON");
  await expect(page.getByRole("heading", { name: "Northstar Cloud" })).toBeVisible();
});

test("shows semantic errors before replacing the preview", async ({ page }) => {
  await page.goto("./");
  const invalid = structuredClone(sample);
  invalid.observations[0].metricId = "metric_missing_reference";

  await uploadJson(page, "broken-reference.json", invalid);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Dataset did not validate");
  await expect(alert).toContainText(`${invalid.observations[0].id}.metricId`);
  await expect(alert).toContainText("Metric metric_missing_reference does not exist");
  await expect(page.locator(".dataset-breadcrumb")).toContainText(sample.dataset.name);
});
