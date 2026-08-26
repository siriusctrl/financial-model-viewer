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
    let derivedModelId;
    let unresolvedModelId;
    const tableScreenshots = [];
    for (const [index, model] of modelOptions.entries()) {
      await modelSelect.selectOption(model.value);
      await desktop.getByTestId("financial-table-view").waitFor({ state: "visible" });
      if (await desktop.locator(".value-button").count() === 0) {
        throw new Error(`Model ${model.label} contains no selectable observation cells`);
      }
      if (!derivedModelId && await desktop.locator(".value-button.derived").count() > 0) {
        derivedModelId = model.value;
      }
      if (!unresolvedModelId && await desktop.locator(".row-warning").count() > 0) {
        unresolvedModelId = model.value;
      }
      tableScreenshots.push(await capture(
        desktop,
        reviewDirectory,
        `01-model-${String(index + 1).padStart(2, "0")}-${fileSlug(model.label, model.value)}`,
        captures,
      ));
    }
    await modelSelect.selectOption(defaultModelId);

    const sourcedCell = desktop.locator(".value-button:not(.derived)").first();
    const firstCell = await sourcedCell.count() > 0
      ? sourcedCell
      : desktop.locator(".value-button").first();
    if (await firstCell.count() === 0) throw new Error("Compiled viewer contains no selectable observation cells");
    await firstCell.click();
    await desktop.locator(".inspector-header").waitFor({ state: "visible" });
    const inspectorScreenshot = await capture(desktop, reviewDirectory, "02-cell-inspector", captures);

    let derivedLineage = "not-applicable";
    let derivedScreenshot;
    if (derivedModelId) {
      await modelSelect.selectOption(derivedModelId);
      const derivedCell = desktop.locator(".value-button.derived").first();
      await derivedCell.click();
      await desktop.getByTestId("formula-lineage").waitFor({ state: "visible" });
      derivedLineage = "passed";
      derivedScreenshot = await capture(desktop, reviewDirectory, "03-derived-lineage", captures);
    }

    let unresolvedCue = "not-applicable";
    let unresolvedScreenshot;
    if (unresolvedModelId) {
      await modelSelect.selectOption(unresolvedModelId);
      const unresolvedRow = desktop.locator("tr").filter({
        has: desktop.locator(".row-warning"),
      }).first();
      await unresolvedRow.locator(".value-button").first().click();
      await desktop.getByTestId("cell-review-warning").waitFor({ state: "visible" });
      unresolvedCue = "passed";
      unresolvedScreenshot = await capture(
        desktop,
        reviewDirectory,
        "04-unresolved-review",
        captures,
      );
    }

    const warningStatus = desktop.locator(".validation-status.has-warning");
    const reviewWarning = await warningStatus.count() > 0
      ? await warningStatus.textContent()
      : null;
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
    const mobileScreenshot = await capture(mobile, reviewDirectory, "05-table-mobile", captures);
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
      ? await capture(mobile, reviewDirectory, "06-table-mobile-right-edge", captures)
      : undefined;
    await tableWrap.evaluate((element) => { element.scrollLeft = 0; });
    await mobile.locator(".value-button").first().click();
    await mobile.locator(".inspector-header").waitFor({ state: "visible" });
    const mobileInspectorScreenshot = await capture(
      mobile,
      reviewDirectory,
      "07-mobile-inspector",
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
        cellInspector: "passed",
        derivedLineage,
        mobileDocumentOverflow: "passed",
        mobileInspector: "passed",
        mobileTableScroll: scrollResult.maximum > 0 ? "passed" : "not-applicable",
        modelsRendered: modelOptions.length,
        tableVisible: "passed",
        unresolvedCue,
      },
      reviewWarning: reviewWarning?.trim() || null,
      screenshots: [
        ...tableScreenshots,
        inspectorScreenshot,
        derivedScreenshot,
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
