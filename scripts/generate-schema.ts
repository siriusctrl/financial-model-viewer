import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ModelDatabaseJsonSchema } from "../src/model-db/schema";

const outputPath = resolve("schema/model-db.schema.json");
const output = `${JSON.stringify(
  {
    $id: "https://siriusctrl.github.io/ledgerglass/schema/model-db.schema.json",
    title: "Financial Model Semantic Database",
    ...ModelDatabaseJsonSchema,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== output) {
    console.error("schema/model-db.schema.json is stale. Run npm run schema:generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output);
  console.log(`Generated ${outputPath}`);
}
