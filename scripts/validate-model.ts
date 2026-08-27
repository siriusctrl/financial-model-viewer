import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateModelDatabase } from "../src/model-db/validate";

const inputPath = resolve(process.argv[2] ?? "examples/sample-model-db.json");

let input: unknown;
try {
  input = JSON.parse(await readFile(inputPath, "utf8"));
} catch (cause) {
  console.error(`Could not read JSON from ${inputPath}`);
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
}

const result = validateModelDatabase(input);
if (result.success) {
  console.log(`VALID ${inputPath}`);
  console.log(
    `models=${result.stats.models} metrics=${result.stats.metrics} observations=${result.stats.observations} transformations=${result.stats.transformations} needs_review=${result.stats.needsReview} action_required=${result.stats.actionRequired} unreviewed=${result.stats.unreviewed}`,
  );
  if (result.warnings.length > 0) {
    console.warn(`WARNINGS ${result.warnings.length}`);
    for (const item of result.warnings) {
      console.warn(`\n[${item.attentionLevel}:${item.code}] ${item.objectId} · ${item.field}`);
      console.warn(`  Reason: ${item.reason}`);
      console.warn(`  Resolve: ${item.suggestion}`);
    }
  }
} else {
  console.error(`INVALID ${inputPath} (${result.errors.length} errors)`);
  for (const item of result.errors) {
    console.error(`\n[${item.code}] ${item.objectId} · ${item.field}`);
    console.error(`  Reason: ${item.reason}`);
    console.error(`  Fix: ${item.suggestion}`);
  }
  process.exitCode = 1;
}
