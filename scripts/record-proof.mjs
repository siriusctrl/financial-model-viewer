import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const root = resolve(".");
const outputDirectory = resolve("artifacts/verification");
const baseUrl = "http://127.0.0.1:4173/financial-model-viewer/";

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const build = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(
  "npm",
  ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4173"],
  { cwd: root, stdio: "ignore" },
);

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry while the Vite preview server starts.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Preview server did not start at ${baseUrl}`);
}

const captures = [];
async function capture(page, name) {
  const path = resolve(outputDirectory, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  captures.push({ name, path });
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await capture(desktop, "01-table-desktop");

  await desktop.getByTitle(/Assumption · obs_northstar_subscription_revenue_fy2025/).click();
  await capture(desktop, "02-source-inspector-desktop");

  const derivedCell = desktop.getByTitle(/Derived · obs_northstar_gross_profit_fy2025/);
  await derivedCell.click();
  await desktop.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await desktop.waitForTimeout(200);
  await capture(desktop, "03-derived-lineage-desktop");

  await desktop.getByRole("button", { name: "Lineage map" }).click();
  await desktop.locator(".metric-picker select").selectOption("metric_northstar_gross_profit");
  await capture(desktop, "04-lineage-map-desktop");

  await desktop.getByLabel("Active model").selectOption("model_harbor_national");
  await capture(desktop, "05-bank-table-desktop");

  const mobile = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1 });
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await capture(mobile, "06-table-mobile");
  await browser.close();

  const thumbWidth = 680;
  const thumbHeight = 470;
  const gap = 20;
  const columns = 2;
  const rows = Math.ceil(captures.length / columns);
  const composites = await Promise.all(
    captures.map(async (item, index) => {
      const image = await sharp(item.path)
        .resize(thumbWidth, thumbHeight, { fit: "contain", background: "#efede6" })
        .png()
        .toBuffer();
      return {
        input: image,
        left: (index % columns) * (thumbWidth + gap),
        top: Math.floor(index / columns) * (thumbHeight + gap),
      };
    }),
  );
  await sharp({
    create: {
      width: columns * thumbWidth + (columns - 1) * gap,
      height: rows * thumbHeight + (rows - 1) * gap,
      channels: 3,
      background: "#efede6",
    },
  })
    .composite(composites)
    .png()
    .toFile(resolve(outputDirectory, "contact-sheet.png"));

  await writeFile(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, captures: captures.map(({ name }) => `${name}.png`) }, null, 2)}\n`,
  );
  console.log(`Wrote ${captures.length} screenshots and contact sheet to ${outputDirectory}`);
} finally {
  server.kill("SIGTERM");
}
