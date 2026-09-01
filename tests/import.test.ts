import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import {
  modelDatabaseGzip,
  parseModelDatabaseJson,
  readModelDatabaseFile,
} from "../src/model-db/import";
import { assertValidModelDatabase } from "../src/model-db/validate";

describe("model database JSON import", () => {
  it("returns a validated database and its preview stats", () => {
    const result = parseModelDatabaseJson(JSON.stringify(sample));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataset.id).toBe(sample.dataset.id);
      expect(result.stats.models).toBe(2);
      expect(result.stats.observations).toBe(60);
    }
  });

  it("distinguishes malformed JSON from contract errors", () => {
    const result = parseModelDatabaseJson('{"schemaVersion":');

    expect(result).toEqual(
      expect.objectContaining({ success: false, kind: "json", errors: [] }),
    );
  });

  it("preserves actionable semantic validation details", () => {
    const invalid = structuredClone(sample);
    invalid.observationSeries[0].metricId = "metric_missing_reference";
    const result = parseModelDatabaseJson(JSON.stringify(invalid));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("validation");
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "reference.missing",
          objectId: invalid.observationSeries[0].points[0].id,
          field: "metricId",
        }),
      );
    }
  });

  it("rejects a missing required table-presentation collection", () => {
    const legacy = structuredClone(sample) as Record<string, unknown>;
    delete legacy.tablePresentations;

    const result = parseModelDatabaseJson(JSON.stringify(legacy));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "schema.invalid",
        field: "tablePresentations",
      }));
    }
  });

  it("reads the same 0.2 contract from JSON and browser-native gzip", async () => {
    const database = assertValidModelDatabase(sample);
    const json = new File([JSON.stringify(database)], "model-db.json", {
      type: "application/json",
    });
    const gzip = new File([await modelDatabaseGzip(database)], "model-db.json.gz", {
      type: "application/gzip",
    });

    const [plainResult, gzipResult] = await Promise.all([
      readModelDatabaseFile(json, 10 * 1024 * 1024),
      readModelDatabaseFile(gzip, 10 * 1024 * 1024),
    ]);
    expect(plainResult.success).toBe(true);
    expect(gzipResult.success).toBe(true);
    if (plainResult.success && gzipResult.success) {
      expect(gzipResult.data).toEqual(plainResult.data);
    }
  });
});
