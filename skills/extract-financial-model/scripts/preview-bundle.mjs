import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER_FILENAME, PREVIEW_FORMAT } from "./serve-preview.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");

function resolveExtraction(target, reportOverride) {
  if (!existsSync(target)) throw new Error(`Extraction output does not exist: ${target}`);
  const targetStat = statSync(target);
  if (targetStat.isDirectory()) {
    if (reportOverride) throw new Error("Do not use --report when the extraction target is a directory");
    return {
      checkerArguments: [target],
      databasePath: join(target, "model-db.json"),
      extractionDirectory: target,
      reportPath: join(target, "extraction-report.md"),
    };
  }
  if (!targetStat.isFile() || extname(target).toLowerCase() !== ".json") {
    throw new Error(`Expected an extraction directory or model-db JSON file: ${target}`);
  }
  const reportPath = reportOverride ?? join(dirname(target), "extraction-report.md");
  return {
    checkerArguments: [target, reportPath],
    databasePath: target,
    extractionDirectory: dirname(target),
    reportPath,
  };
}

function runExtractionCheck(checkerArguments) {
  const result = spawnSync(
    process.execPath,
    [join(scriptDirectory, "check-extraction.mjs"), ...checkerArguments],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw new Error(`Could not run extraction checker: ${result.error.message}`);
  if (result.status !== 0) throw new Error("Extraction validation failed; static preview was not built");
}

export function loadCheckedExtraction(target, reportOverride) {
  const extraction = resolveExtraction(target, reportOverride);
  runExtractionCheck(extraction.checkerArguments);
  const databaseBuffer = readFileSync(extraction.databasePath);
  let database;
  try {
    database = JSON.parse(databaseBuffer.toString("utf8"));
  } catch (cause) {
    throw new Error(`Could not parse ${extraction.databasePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    ...extraction,
    database,
    databaseSha256: createHash("sha256").update(databaseBuffer).digest("hex"),
  };
}

function pathContains(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

function ensureSafeOutput(outputDirectory, extractionDirectory) {
  const protectedDirectories = [repositoryRoot, extractionDirectory, resolve(process.env.HOME ?? "/nonexistent")];
  if (outputDirectory === parse(outputDirectory).root || protectedDirectories.includes(outputDirectory)) {
    throw new Error(`Refusing unsafe preview output directory: ${outputDirectory}`);
  }
  if (protectedDirectories.some((directory) => pathContains(outputDirectory, directory))) {
    throw new Error(`Refusing a preview output that contains a protected source directory: ${outputDirectory}`);
  }
  if (!existsSync(outputDirectory)) return;
  if (lstatSync(outputDirectory).isSymbolicLink()) {
    throw new Error(`Refusing to replace a symlinked preview directory: ${outputDirectory}`);
  }
  const markerPath = join(outputDirectory, MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    throw new Error(`Output already exists and is not a generated preview: ${outputDirectory}`);
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (marker.format !== PREVIEW_FORMAT) {
    throw new Error(`Output has an unsupported preview marker: ${outputDirectory}`);
  }
}

export function preparePreviewOutput(extraction, requestedOutput) {
  const outputDirectory = requestedOutput ?? join(extraction.extractionDirectory, "viewer");
  ensureSafeOutput(outputDirectory, extraction.extractionDirectory);
  const temporaryDirectory = join(
    dirname(outputDirectory),
    `.${basename(outputDirectory)}.tmp-${process.pid}-${Date.now()}`,
  );
  if (existsSync(temporaryDirectory)) rmSync(temporaryDirectory, { recursive: true, force: true });
  return { outputDirectory, temporaryDirectory };
}

function buildApplication(temporaryDirectory) {
  const result = spawnSync(
    "npm",
    ["run", "build", "--", "--base", "./", "--outDir", temporaryDirectory, "--emptyOutDir"],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw new Error(`Could not run the viewer build: ${result.error.message}`);
  if (result.status !== 0) throw new Error("Viewer production build failed");
}

function injectDatabase(temporaryDirectory, database) {
  const indexPath = join(temporaryDirectory, "index.html");
  const html = readFileSync(indexPath, "utf8");
  if (!html.includes("</body>")) throw new Error(`Built viewer has no </body> marker: ${indexPath}`);
  const serialized = JSON.stringify(database)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const script = `<script id="model-db-preview-data" type="application/json">${serialized}</script>`;
  writeFileSync(indexPath, html.replace("</body>", `    ${script}\n  </body>`));
}

export function compilePreviewBundle(temporaryDirectory, extraction) {
  buildApplication(temporaryDirectory);
  injectDatabase(temporaryDirectory, extraction.database);
  writeFileSync(join(temporaryDirectory, MARKER_FILENAME), `${JSON.stringify({
    format: PREVIEW_FORMAT,
    generatedAt: new Date().toISOString(),
    databaseFile: basename(extraction.databasePath),
    databaseSha256: extraction.databaseSha256,
    datasetId: extraction.database.dataset.id,
    datasetName: extraction.database.dataset.name,
  }, null, 2)}\n`);
}

export function publishPreviewBundle(temporaryDirectory, outputDirectory, extraction) {
  ensureSafeOutput(outputDirectory, extraction.extractionDirectory);
  if (existsSync(outputDirectory)) rmSync(outputDirectory, { recursive: true });
  renameSync(temporaryDirectory, outputDirectory);
}
