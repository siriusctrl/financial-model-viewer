import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import { parseModelDatabaseJson } from "../src/model-db/import";

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
    invalid.observations[0].metricId = "metric_missing_reference";
    const result = parseModelDatabaseJson(JSON.stringify(invalid));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.kind).toBe("validation");
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "reference.missing",
          objectId: invalid.observations[0].id,
          field: "metricId",
        }),
      );
    }
  });

  it("rejects a silent table-presentation fallback", () => {
    const legacy = structuredClone(sample) as Record<string, unknown>;
    delete legacy.tablePresentations;

    const result = parseModelDatabaseJson(JSON.stringify(legacy));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((item) => item.code === "presentation.missing")).toBe(true);
    }
  });
});
