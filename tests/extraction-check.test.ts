/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import type { ModelDatabase, UnresolvedItem } from "../src/model-db/types";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "..");
const checker = join(
  repositoryRoot,
  "skills/extract-financial-model/scripts/check-extraction.mjs",
);
const report = join(repositoryRoot, "examples/extraction-report.md");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("extraction package attention guidance", () => {
  it("requires a workbook quality audit in the extraction report", () => {
    const directory = mkdtempSync(join(tmpdir(), "model-db-report-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "model-db.json");
    const reportPath = join(directory, "extraction-report.md");
    writeFileSync(databasePath, JSON.stringify(sample));
    writeFileSync(
      reportPath,
      readFileSync(report, "utf8").replace(
        /## Workbook quality audit[\s\S]*?(?=## Unresolved mappings)/,
        "",
      ),
    );

    const result = spawnSync("node", [checker, databasePath, reportPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'is missing "## Workbook quality audit"',
    );
  });

  it.each(["currentTreatment", "impact", "nextAction"] as const)(
    "rejects an attention item without %s",
    (field) => {
      const database = structuredClone(sample) as ModelDatabase;
      delete database.unresolvedItems[0][field];
      const directory = mkdtempSync(join(tmpdir(), "model-db-attention-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "model-db.json");
      writeFileSync(databasePath, JSON.stringify(database));

      const result = spawnSync("node", [checker, databasePath, report], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`must provide non-empty ${field}`);
    },
  );

  it("rejects an action item without a named owner", () => {
    const database = structuredClone(sample) as ModelDatabase;
    database.unresolvedItems[0].attentionLevel = "action_required";
    const directory = mkdtempSync(join(tmpdir(), "model-db-attention-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "model-db.json");
    writeFileSync(databasePath, JSON.stringify(database));

    const result = spawnSync("node", [checker, databasePath, report], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must provide actionOwner");
  });

  it("checks resolved items as part of a newly emitted package", () => {
    const database = structuredClone(sample) as ModelDatabase;
    const item = database.unresolvedItems[0] as UnresolvedItem;
    item.status = "resolved";
    delete item.impact;
    const directory = mkdtempSync(join(tmpdir(), "model-db-attention-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "model-db.json");
    writeFileSync(databasePath, JSON.stringify(database));

    const result = spawnSync("node", [checker, databasePath, report], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must provide non-empty impact");
  });

  it("rejects a report that drops structured guidance", () => {
    const database = structuredClone(sample) as ModelDatabase;
    const item = database.unresolvedItems[0];
    const directory = mkdtempSync(join(tmpdir(), "model-db-attention-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "model-db.json");
    const reportPath = join(directory, "extraction-report.md");
    writeFileSync(databasePath, JSON.stringify(database));
    writeFileSync(
      reportPath,
      readFileSync(report, "utf8").replace(item.currentTreatment!, "[omitted]"),
    );

    const result = spawnSync("node", [checker, databasePath, reportPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `does not preserve currentTreatment for attention item ${item.id}`,
    );
  });

  it("accepts guidance wrapped across Markdown lines", () => {
    const database = structuredClone(sample) as ModelDatabase;
    const item = database.unresolvedItems[0];
    const directory = mkdtempSync(join(tmpdir(), "model-db-attention-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "model-db.json");
    const reportPath = join(directory, "extraction-report.md");
    writeFileSync(databasePath, JSON.stringify(database));
    writeFileSync(
      reportPath,
      readFileSync(report, "utf8").replace(
        item.currentTreatment!,
        item.currentTreatment!.replace(" currently ", " currently\n"),
      ),
    );

    const result = spawnSync("node", [checker, databasePath, reportPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });
});
