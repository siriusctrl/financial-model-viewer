#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePreviewBundle,
  loadCheckedExtraction,
  preparePreviewOutput,
  publishPreviewBundle,
} from "./preview-bundle.mjs";
import { reviewPreview } from "./review-preview.mjs";

const serveScript = join(dirname(fileURLToPath(import.meta.url)), "serve-preview.mjs");

function usage() {
  console.log(`Usage:
  node skills/extract-financial-model/scripts/build-preview.mjs <output-directory> [--out viewer-directory]
  node skills/extract-financial-model/scripts/build-preview.mjs <model-db.json> [--report extraction-report.md] [--out viewer-directory]

Validates the extraction, builds a portable static viewer, runs headless desktop/mobile checks,
and writes screenshots plus review/review.json into the viewer directory.`);
}

function parseCli(arguments_) {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    usage();
    process.exit(arguments_.length === 0 ? 1 : 0);
  }

  const options = { target: resolve(process.cwd(), arguments_[0]) };
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if ((argument === "--out" || argument === "--report") && arguments_[index + 1]) {
      options[argument === "--out" ? "output" : "report"] = resolve(
        process.cwd(),
        arguments_[index + 1],
      );
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const extraction = loadCheckedExtraction(options.target, options.report);
  const output = preparePreviewOutput(extraction, options.output);
  let completed = false;

  try {
    compilePreviewBundle(output.temporaryDirectory, extraction);
    const review = await reviewPreview(output.temporaryDirectory, extraction);
    publishPreviewBundle(output.temporaryDirectory, output.outputDirectory, extraction);
    completed = true;

    console.log(`BUILT ${output.outputDirectory}`);
    console.log(`REVIEW ${join(output.outputDirectory, "review/contact-sheet.png")}`);
    console.log(`result=${review.result}`);
    console.log(`Serve with: node ${JSON.stringify(serveScript)} ${JSON.stringify(output.outputDirectory)}`);
  } finally {
    if (!completed && existsSync(output.temporaryDirectory)) {
      if (process.env.KEEP_FAILED_PREVIEW === "1") {
        console.error(`INCOMPLETE_PREVIEW ${output.temporaryDirectory}`);
      } else {
        rmSync(output.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}

try {
  await main();
} catch (cause) {
  console.error(`ERROR ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
