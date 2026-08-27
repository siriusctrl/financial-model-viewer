#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_REPORT_SECTIONS = [
  "Inputs and hashes",
  "Inventory",
  "Object counts",
  "Table presentation",
  "Actual / estimate boundary",
  "Formula coverage",
  "Unresolved mappings",
  "Missing lineage",
  "Validator result",
  "Questions and next actions",
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");

function printUsage() {
  console.log(`Usage:
  node skills/extract-financial-model/scripts/check-extraction.mjs <output-directory>
  node skills/extract-financial-model/scripts/check-extraction.mjs <model-db.json> [extraction-report.md]

The output-directory form expects model-db.json and extraction-report.md in that directory.`);
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exitCode = 1;
}

function resolveArtifacts(arguments_) {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    printUsage();
    process.exit(arguments_.length === 0 ? 1 : 0);
  }

  if (arguments_.length > 2) {
    fail("Expected an output directory, or a database path and optional report path.");
    printUsage();
    process.exit(1);
  }

  const targetPath = resolve(process.cwd(), arguments_[0]);
  if (!existsSync(targetPath)) {
    fail(`Extraction output does not exist: ${targetPath}`);
    process.exit(1);
  }

  const target = statSync(targetPath);
  if (target.isDirectory()) {
    if (arguments_[1]) {
      fail("Do not pass a separate report path when the first argument is an output directory.");
      process.exit(1);
    }
    return {
      databasePath: join(targetPath, "model-db.json"),
      reportPath: join(targetPath, "extraction-report.md"),
    };
  }

  if (!target.isFile() || extname(targetPath).toLowerCase() !== ".json") {
    fail(`Expected a directory or JSON database file: ${targetPath}`);
    process.exit(1);
  }

  return {
    databasePath: targetPath,
    reportPath: arguments_[1]
      ? resolve(process.cwd(), arguments_[1])
      : join(dirname(targetPath), "extraction-report.md"),
  };
}

function checkReport(reportPath, databasePath) {
  if (!existsSync(reportPath) || !statSync(reportPath).isFile()) {
    fail(`Missing extraction report: ${reportPath}`);
    return false;
  }

  const report = readFileSync(reportPath, "utf8");
  let valid = true;

  if (!/^# Extraction report\s*$/m.test(report)) {
    fail(`${reportPath} must contain the title "# Extraction report".`);
    valid = false;
  }

  const headings = [...report.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => ({
    name: match[1],
    index: match.index,
    contentStart: match.index + match[0].length,
  }));

  let previousIndex = -1;
  for (const requiredSection of REQUIRED_REPORT_SECTIONS) {
    const headingIndex = headings.findIndex((heading) => heading.name === requiredSection);
    if (headingIndex === -1) {
      fail(`${reportPath} is missing "## ${requiredSection}".`);
      valid = false;
      continue;
    }

    if (headingIndex <= previousIndex) {
      fail(`${reportPath} must keep "## ${requiredSection}" in the contract-defined order.`);
      valid = false;
    }
    previousIndex = headingIndex;

    const heading = headings[headingIndex];
    const nextHeading = headings[headingIndex + 1];
    const content = report.slice(heading.contentStart, nextHeading?.index ?? report.length).trim();
    if (content.length === 0) {
      fail(`${reportPath} has no content under "## ${requiredSection}".`);
      valid = false;
    }
  }

  const validatorHeadingIndex = headings.findIndex(
    (heading) => heading.name === "Validator result",
  );
  if (validatorHeadingIndex !== -1) {
    const heading = headings[validatorHeadingIndex];
    const nextHeading = headings[validatorHeadingIndex + 1];
    const content = report.slice(heading.contentStart, nextHeading?.index ?? report.length);
    if (!/(?:npm run extraction:check|check-extraction\.mjs)(?:\s|`|$)/.test(content)) {
      fail(`${reportPath} must record the strict extraction checker command under "## Validator result".`);
      valid = false;
    }
  }

  if (existsSync(databasePath) && statSync(databasePath).isFile()) {
    try {
      const database = JSON.parse(readFileSync(databasePath, "utf8"));
      const openUnresolvedItems = Array.isArray(database.unresolvedItems)
        ? database.unresolvedItems
            .filter((item) => item?.status === "open" && typeof item.id === "string")
        : [];
      const reportLines = report.split(/\r?\n/);
      for (const item of openUnresolvedItems) {
        const itemLines = reportLines.filter((line) => line.includes(item.id));
        if (itemLines.length === 0) {
          fail(`${reportPath} does not record open attention item ${item.id}.`);
          valid = false;
          continue;
        }
        const label = item.attentionLevel === "action_required"
          ? "ACTION REQUIRED"
          : "NEEDS REVIEW";
        if (!itemLines.some((line) => line.includes(label))) {
          fail(`${reportPath} must label ${item.id} as ${label}.`);
          valid = false;
        }
      }
    } catch (cause) {
      fail(`Could not compare report attention items with ${databasePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
      valid = false;
    }
  }

  if (valid) {
    console.log(`VALID ${reportPath}`);
    console.log(`reportSections=${REQUIRED_REPORT_SECTIONS.length}`);
  }
  return valid;
}

function checkDatabase(databasePath) {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    fail(`Missing model database: ${databasePath}`);
    return false;
  }

  const tsxPath = resolve(repositoryRoot, "node_modules/.bin/tsx");
  if (!existsSync(tsxPath)) {
    fail(`Repository dependencies are not installed. Run "npm install" in ${repositoryRoot}.`);
    return false;
  }

  const validation = spawnSync(
    tsxPath,
    [resolve(repositoryRoot, "scripts/validate-model.ts"), databasePath],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (validation.error) {
    fail(`Could not run the model database validator: ${validation.error.message}`);
    return false;
  }
  if (validation.status !== 0) {
    return false;
  }
  return true;
}

const { databasePath, reportPath } = resolveArtifacts(process.argv.slice(2));
const reportIsValid = checkReport(reportPath, databasePath);
const databaseIsValid = checkDatabase(databasePath);

if (!reportIsValid || !databaseIsValid) {
  process.exitCode = 1;
} else {
  console.log("PASS extraction package matches the viewer contract and report format.");
}
