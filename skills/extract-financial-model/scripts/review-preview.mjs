import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { startPreviewServer } from "./serve-preview.mjs";

async function capture(page, directory, name, captures) {
  const path = join(directory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  captures.push({ name, path });
  return `${name}.png`;
}

async function writeContactSheet(captures, reviewDirectory) {
  const width = 720;
  const height = 500;
  const gap = 18;
  const columns = 2;
  const rows = Math.ceil(captures.length / columns);
  const composites = await Promise.all(captures.map(async (capture, index) => ({
    input: await sharp(capture.path)
      .resize(width, height, { fit: "contain", background: "#efede6" })
      .png()
      .toBuffer(),
    left: (index % columns) * (width + gap),
    top: Math.floor(index / columns) * (height + gap),
  })));
  await sharp({
    create: {
      width: columns * width + (columns - 1) * gap,
      height: rows * height + (rows - 1) * gap,
      channels: 3,
      background: "#efede6",
    },
  }).composite(composites).png().toFile(join(reviewDirectory, "contact-sheet.png"));
}

function attachRuntimeChecks(page, browserErrors, failedResponses) {
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
}

function fileSlug(value, fallback) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (slug || fallback).slice(0, 60);
}

export async function reviewPreview(viewerDirectory, extraction) {
  const reviewDirectory = join(viewerDirectory, "review");
  mkdirSync(reviewDirectory, { recursive: true });
  const preview = await startPreviewServer(viewerDirectory);
  const captures = [];
  const browserErrors = [];
  const failedResponses = [];
  let browser;

  const transformations = new Map(
    extraction.database.transformations.map((transformation) => [transformation.id, transformation]),
  );
  const periods = new Map(
    extraction.database.periods.map((period) => [period.id, period]),
  );
  const derivedObservations = extraction.database.observations
    .map((observation) => ({
      observation,
      transformation: observation.transformationId
        ? transformations.get(observation.transformationId)
        : undefined,
    }))
    .filter(({ observation, transformation }) =>
      observation.valueType === "derived" && transformation?.status === "supported",
    );
  const toView = ({ observation }) => ({
    modelId: observation.modelId,
    entityId: observation.entityId,
    presentationId: extraction.database.tablePresentations.find(
      (presentation) => presentation.modelId === observation.modelId
        && presentation.sections.some((section) => section.metricIds.includes(observation.metricId)),
    )?.id,
    periodType: periods.get(observation.periodId)?.type,
    observationId: observation.id,
  });
  const exactLineage = [...derivedObservations]
    .filter(({ transformation }) => transformation.expression.includes("period_ref("))
    .sort(({ transformation: left }, { transformation: right }) =>
      (right.expression.match(/period_ref\(/g)?.length ?? 0) -
      (left.expression.match(/period_ref\(/g)?.length ?? 0),
    )[0];
  const graphLineage = derivedObservations.find(({ transformation }) =>
    transformation.dependencyMetricIds.some(
      (metricId) => metricId !== transformation.outputMetricId,
    ),
  );

  try {
    browser = await chromium.launch();
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    attachRuntimeChecks(desktop, browserErrors, failedResponses);
    await desktop.goto(preview.url, { waitUntil: "networkidle" });
    await desktop.getByTestId("financial-table-view").waitFor({ state: "visible" });

    const modelSelect = desktop.getByLabel("Active model");
    const modelOptions = await modelSelect.locator("option").evaluateAll((options) =>
      options.map((option) => ({ label: option.textContent?.trim() || option.value, value: option.value })),
    );
    const defaultModelId = await modelSelect.inputValue();
    let derivedView = exactLineage
      ? {
          ...toView(exactLineage),
          expectedInputCount: new Set(
            [
              ...[...exactLineage.transformation.expression.matchAll(
                /period_ref\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g,
              )].map((match) => `${match[1]}|${match[2]}`),
              ...[...exactLineage.transformation.expression.matchAll(
                /\bref\(\s*["']([^"']+)["']\s*\)/g,
              )].map((match) => `${match[1]}|${exactLineage.observation.periodId}`),
            ],
          ).size,
        }
      : undefined;
    let graphView = graphLineage ? toView(graphLineage) : undefined;
    let unresolvedView;
    const tableScreenshots = [];
    let periodViewsRendered = 0;
    for (const model of modelOptions) {
      await modelSelect.selectOption(model.value);
      await desktop.getByTestId("financial-table-view").waitFor({ state: "visible" });
      const worksheetSelect = desktop.getByLabel("Worksheet view");
      const worksheetOptions = await worksheetSelect.count() > 0
        ? await worksheetSelect.locator("option").evaluateAll((options) =>
            options.map((option) => ({
              label: option.textContent?.trim() || option.value,
              value: option.value,
            })),
          )
        : [{ label: "model", value: undefined }];
      for (const worksheetOption of worksheetOptions) {
        if (worksheetOption.value) await worksheetSelect.selectOption(worksheetOption.value);
        const periodSelect = desktop.getByLabel("Period view");
        const periodOptions = await periodSelect.count() > 0
          ? await periodSelect.locator("option").evaluateAll((options) =>
              options.map((option) => ({
                label: option.textContent?.trim() || option.value,
                value: option.value,
              })),
            )
          : [{ label: "all-periods", value: undefined }];
        for (const periodOption of periodOptions) {
          if (periodOption.value) await periodSelect.selectOption(periodOption.value);
          if (await desktop.locator(".value-button").count() === 0) {
            throw new Error(
              `Model ${model.label} / ${worksheetOption.label} / ${periodOption.label} contains no selectable observation cells`,
            );
          }
          if (!derivedView && await desktop.locator(".value-button.derived").count() > 0) {
            derivedView = {
              modelId: model.value,
              presentationId: worksheetOption.value,
              periodType: periodOption.value,
            };
          }
          if (!graphView && await desktop.locator(".value-button.derived").count() > 0) {
            graphView = {
              modelId: model.value,
              presentationId: worksheetOption.value,
              periodType: periodOption.value,
            };
          }
          if (!unresolvedView && await desktop.locator(".row-warning").count() > 0) {
            unresolvedView = {
              modelId: model.value,
              presentationId: worksheetOption.value,
              periodType: periodOption.value,
            };
          }
          periodViewsRendered += 1;
          tableScreenshots.push(await capture(
            desktop,
            reviewDirectory,
            `01-view-${String(periodViewsRendered).padStart(2, "0")}-${fileSlug(model.label, model.value)}-${fileSlug(worksheetOption.label, "worksheet")}-${fileSlug(periodOption.label, "periods")}`,
            captures,
          ));
        }
      }
    }
    await modelSelect.selectOption(defaultModelId);

    const sourcedCell = desktop.locator(".value-button:not(.derived)").first();
    const firstCell = await sourcedCell.count() > 0
      ? sourcedCell
      : desktop.locator(".value-button").first();
    if (await firstCell.count() === 0) throw new Error("Compiled viewer contains no selectable observation cells");
    await firstCell.click();
    await desktop.locator(".inspector-header").waitFor({ state: "visible" });
    await desktop.waitForTimeout(250);
    const inspectorScreenshot = await capture(desktop, reviewDirectory, "02-cell-inspector", captures);

    let derivedLineage = "not-applicable";
    let derivedScreenshot;
    let dependencyGraph = "not-applicable";
    let graphScreenshot;
    if (derivedView) {
      await modelSelect.selectOption(derivedView.modelId);
      const worksheetSelect = desktop.getByLabel("Worksheet view");
      if (derivedView.presentationId && await worksheetSelect.count() > 0) {
        await worksheetSelect.selectOption(derivedView.presentationId);
      }
      const entitySelect = desktop.getByLabel("Entity view");
      if (derivedView.entityId && await entitySelect.count() > 0) {
        await entitySelect.selectOption(derivedView.entityId);
      }
      const periodSelect = desktop.getByLabel("Period view");
      if (derivedView.periodType && await periodSelect.count() > 0) {
        await periodSelect.selectOption(derivedView.periodType);
      }
      const preferredDerivedCell = derivedView.observationId
        ? desktop.getByTitle(`Derived · ${derivedView.observationId}`)
        : desktop.locator(".value-button.derived").first();
      const derivedCell = await preferredDerivedCell.count() > 0
        ? preferredDerivedCell
        : desktop.locator(".value-button.derived").first();
      await derivedCell.click();
      await desktop.getByTestId("formula-lineage").waitFor({ state: "visible" });
      if (derivedView.expectedInputCount !== undefined) {
        const actualInputCount = await desktop
          .getByTestId("formula-lineage")
          .locator(".lineage-input")
          .count();
        if (actualInputCount !== derivedView.expectedInputCount) {
          throw new Error(
            `Exact-period lineage rendered ${actualInputCount} inputs; expected ${derivedView.expectedInputCount}`,
          );
        }
      }
      derivedLineage = "passed";
      derivedScreenshot = await capture(desktop, reviewDirectory, "03-derived-lineage", captures);
    }

    if (graphView) {
      await modelSelect.selectOption(graphView.modelId);
      const worksheetSelect = desktop.getByLabel("Worksheet view");
      if (graphView.presentationId && await worksheetSelect.count() > 0) {
        await worksheetSelect.selectOption(graphView.presentationId);
      }
      const entitySelect = desktop.getByLabel("Entity view");
      if (graphView.entityId && await entitySelect.count() > 0) {
        await entitySelect.selectOption(graphView.entityId);
      }
      const periodSelect = desktop.getByLabel("Period view");
      if (graphView.periodType && await periodSelect.count() > 0) {
        await periodSelect.selectOption(graphView.periodType);
      }
      const preferredGraphCell = graphView.observationId
        ? desktop.getByTitle(`Derived · ${graphView.observationId}`)
        : desktop.locator(".value-button.derived").first();
      const graphCell = await preferredGraphCell.count() > 0
        ? preferredGraphCell
        : desktop.locator(".value-button.derived").first();
      await graphCell.click();
      await desktop.getByTestId("formula-lineage").waitFor({ state: "visible" });
      const openMap = desktop.getByRole("button", { name: "Open map" });
      if (await openMap.count() > 0) {
        await openMap.click();
        await desktop.getByTestId("dependency-graph-view").waitFor({ state: "visible" });
        if (await desktop.locator(".dependency-edge").count() === 0) {
          throw new Error("Supported derived formula opened a dependency graph with no edges");
        }
        dependencyGraph = "passed";
        graphScreenshot = await capture(desktop, reviewDirectory, "04-dependency-graph", captures);
        await desktop.getByTestId("detail-panel").getByLabel("Clear selection").click();
        await desktop.getByTestId("detail-panel").waitFor({ state: "hidden" });
        await desktop.getByRole("button", { name: "Model table" }).click();
        await desktop.getByTestId("financial-table-view").waitFor({ state: "visible" });
      }
    }

    const warningStatus = desktop.locator(".validation-status.has-warning");
    const reviewWarning = await warningStatus.count() > 0
      ? await warningStatus.textContent()
      : null;
    let attentionQueue = "not-applicable";
    let attentionQueueScreenshot;
    let attentionDetail = "not-applicable";
    let attentionDetailScreenshot;
    if (await warningStatus.count() > 0) {
      await warningStatus.click();
      const attentionCenter = desktop.getByTestId("attention-center");
      await attentionCenter.waitFor({ state: "visible" });
      if (await attentionCenter.locator(".attention-item").count() === 0) {
        throw new Error("Attention status opened an empty attention center");
      }
      attentionQueue = "passed";
      attentionQueueScreenshot = await capture(
        desktop,
        reviewDirectory,
        "05-attention-queue",
        captures,
      );
      const firstAttentionItem = attentionCenter.locator(".attention-item").first();
      const attentionLevel = await firstAttentionItem.getAttribute("data-attention-level");
      await firstAttentionItem.click();
      await attentionCenter.waitFor({ state: "hidden" });
      const detailPanel = desktop.getByTestId("detail-panel");
      const guidance = detailPanel.getByTestId("attention-guidance");
      await guidance.waitFor({ state: "visible" });
      if (await guidance.getAttribute("data-guidance-complete") !== "true") {
        throw new Error("Current extraction attention detail contains incomplete guidance");
      }
      const confirmButton = guidance.getByRole("button", { name: "Confirm interpretation" });
      if (attentionLevel === "action_required" && await confirmButton.count() > 0) {
        throw new Error("Action-required attention exposed a confirmation control");
      }
      if (attentionLevel === "needs_review" && await confirmButton.count() === 0) {
        throw new Error("Documented needs-review attention omitted its confirmation control");
      }
      attentionDetail = "passed";
      await desktop.waitForTimeout(250);
      attentionDetailScreenshot = await capture(
        desktop,
        reviewDirectory,
        "06-attention-detail",
        captures,
      );
      await detailPanel.getByLabel("Clear selection").click();
      await detailPanel.waitFor({ state: "hidden" });
    }

    let unresolvedCue = "not-applicable";
    let unresolvedScreenshot;
    if (unresolvedView) {
      await modelSelect.selectOption(unresolvedView.modelId);
      const worksheetSelect = desktop.getByLabel("Worksheet view");
      if (unresolvedView.presentationId && await worksheetSelect.count() > 0) {
        await worksheetSelect.selectOption(unresolvedView.presentationId);
      }
      const periodSelect = desktop.getByLabel("Period view");
      if (unresolvedView.periodType && await periodSelect.count() > 0) {
        await periodSelect.selectOption(unresolvedView.periodType);
      }
      const unresolvedRow = desktop.locator("tr").filter({
        has: desktop.locator(".row-warning"),
      }).first();
      await unresolvedRow.locator(".value-button").first().click();
      await desktop.getByTestId("cell-review-warning").waitFor({ state: "visible" });
      unresolvedCue = "passed";
      unresolvedScreenshot = await capture(
        desktop,
        reviewDirectory,
        "07-unresolved-review",
        captures,
      );
    }
    const mobile = await browser.newPage({ viewport: { width: 393, height: 852 } });
    attachRuntimeChecks(mobile, browserErrors, failedResponses);
    await mobile.goto(preview.url, { waitUntil: "networkidle" });
    await mobile.getByTestId("financial-table-view").waitFor({ state: "visible" });
    const dimensions = await mobile.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
      throw new Error(`Mobile document overflows horizontally: ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`);
    }
    const mobileScreenshot = await capture(mobile, reviewDirectory, "08-table-mobile", captures);
    const tableWrap = mobile.locator(".financial-table-wrap");
    const scrollResult = await tableWrap.evaluate((element) => {
      const maximum = element.scrollWidth - element.clientWidth;
      element.scrollLeft = maximum;
      return { maximum, position: element.scrollLeft };
    });
    if (scrollResult.maximum > 0 && scrollResult.position === 0) {
      throw new Error("Mobile table has hidden columns but cannot scroll horizontally");
    }
    const mobileScrolledScreenshot = scrollResult.maximum > 0
      ? await capture(mobile, reviewDirectory, "09-table-mobile-right-edge", captures)
      : undefined;
    await tableWrap.evaluate((element) => { element.scrollLeft = 0; });
    await mobile.locator(".value-button").first().click();
    await mobile.locator(".inspector-header").waitFor({ state: "visible" });
    await mobile.waitForTimeout(250);
    const mobileInspectorScreenshot = await capture(
      mobile,
      reviewDirectory,
      "10-mobile-inspector",
      captures,
    );

    if (browserErrors.length > 0 || failedResponses.length > 0) {
      throw new Error(`Browser review found runtime errors: ${[...browserErrors, ...failedResponses].join("; ")}`);
    }

    await writeContactSheet(captures, reviewDirectory);
    const review = {
      format: "financial-model-visual-review@0.1",
      generatedAt: new Date().toISOString(),
      databaseSha256: extraction.databaseSha256,
      datasetId: extraction.database.dataset.id,
      datasetName: extraction.database.dataset.name,
      result: "automated-checks-passed-visual-judgment-required",
      checks: {
        browserConsole: "passed",
        attentionDetail,
        attentionQueue,
        cellInspector: "passed",
        dependencyGraph,
        derivedLineage,
        mobileDocumentOverflow: "passed",
        mobileInspector: "passed",
        mobileTableScroll: scrollResult.maximum > 0 ? "passed" : "not-applicable",
        modelsRendered: modelOptions.length,
        periodViewsRendered,
        tableVisible: "passed",
        unresolvedCue,
      },
      reviewWarning: reviewWarning?.trim() || null,
      screenshots: [
        ...tableScreenshots,
        inspectorScreenshot,
        derivedScreenshot,
        graphScreenshot,
        attentionQueueScreenshot,
        attentionDetailScreenshot,
        unresolvedScreenshot,
        mobileScreenshot,
        mobileScrolledScreenshot,
        mobileInspectorScreenshot,
      ]
        .filter(Boolean),
      contactSheet: "contact-sheet.png",
    };
    writeFileSync(join(reviewDirectory, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
    return review;
  } finally {
    if (browser) await browser.close();
    await preview.close();
  }
}
