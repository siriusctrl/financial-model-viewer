import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ModelDatabaseJsonSchema } from "../src/model-db/schema";

const outputPaths = [
  resolve("schema/model-db.schema.json"),
  resolve("public/schema/model-db.schema.json"),
];
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
  const stalePaths = [];
  for (const outputPath of outputPaths) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    if (existing !== output) stalePaths.push(outputPath);
  }
  if (stalePaths.length > 0) {
    console.error(`${stalePaths.join(", ")} stale or missing. Run npm run schema:generate.`);
    process.exitCode = 1;
  }
} else {
  for (const outputPath of outputPaths) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);
    console.log(`Generated ${outputPath}`);
  }
}
