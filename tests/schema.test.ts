import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import type { ModelDatabase } from "../src/model-db/types";
import { validateModelDatabase } from "../src/model-db/validate";

function fixture(): ModelDatabase {
  return structuredClone(sample) as ModelDatabase;
}

describe("deterministic model database validator", () => {
  it("accepts the checked-in cross-sector sample", () => {
    const result = validateModelDatabase(sample);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stats.models).toBe(2);
      expect(result.stats.observations).toBeGreaterThan(50);
      expect(result.stats.unresolved).toBe(1);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "unresolved.open",
          objectId: "unresolved_harbor_provision_label",
        }),
      );
    }
  });

  it("reports broken foreign references with object and field", () => {
    const database = fixture();
    database.observations[0].metricId = "metric_missing_reference";

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "reference.missing",
          objectId: database.observations[0].id,
          field: "metricId",
        }),
      );
    }
  });

  it("detects semantic value type mismatches", () => {
    const database = fixture();
    database.observations[0].value = "not a number";

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((item) => item.code === "observation.value_type")).toBe(true);
    }
  });

  it("detects formula dependency cycles", () => {
    const database = fixture();
    database.transformations.push({
      id: "transformation_cycle_fixture",
      outputMetricId: "metric_northstar_subscription_revenue",
      language: "model-expression@0.1",
      expression: 'ref("metric_northstar_revenue")',
      dependencyMetricIds: ["metric_northstar_revenue"],
      status: "supported",
    });

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((item) => item.code === "transformation.cycle")).toBe(true);
    }
  });

  it("requires provenance for every extracted canonical object", () => {
    const database = fixture();
    const targetId = database.metrics[0].id;
    database.provenanceRecords = database.provenanceRecords.filter(
      (item) => item.targetId !== targetId,
    );

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "provenance.missing",
          objectId: targetId,
        }),
      );
    }
  });

  it("rejects duplicate point-in-time observations", () => {
    const database = fixture();
    const duplicate = structuredClone(database.observations[0]);
    duplicate.id = "obs_duplicate_fixture";
    database.observations.push(duplicate);
    database.provenanceRecords.push({
      ...database.provenanceRecords.find(
        (item) => item.targetId === database.observations[0].id,
      )!,
      id: "provenance_obs_duplicate_fixture",
      targetId: duplicate.id,
    });

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((item) => item.code === "observation.duplicate_point")).toBe(true);
    }
  });

  it("rejects incomplete or duplicated table presentation metrics", () => {
    const database = fixture();
    database.tablePresentations[0].sections[0].metricIds.push(
      "metric_northstar_gross_profit",
    );
    database.tablePresentations[0].sections[1].metricIds =
      database.tablePresentations[0].sections[1].metricIds.filter(
        (metricId) => metricId !== "metric_northstar_gross_margin",
      );

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((item) => item.code === "presentation.duplicate_metric")).toBe(true);
      expect(result.errors.some((item) => item.code === "presentation.metric_missing")).toBe(true);
    }
  });

  it("allows an explicit presentation fallback but reports a warning", () => {
    const database = fixture();
    database.tablePresentations = database.tablePresentations.filter(
      (presentation) => presentation.modelId !== "model_northstar_cloud",
    );
    database.unresolvedItems.push({
      id: "unresolved_northstar_table_presentation",
      modelId: "model_northstar_cloud",
      category: "presentation",
      description: "The source does not expose defensible worksheet sections.",
      sourceArtifactId: "artifact_northstar_workbook",
      confidence: 0.4,
      status: "open",
    });
    database.provenanceRecords.push({
      id: "provenance_unresolved_northstar_table_presentation",
      targetId: "unresolved_northstar_table_presentation",
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model" },
      extractionRunId: "run_northstar_2025_03_15",
      confidence: 0.4,
      reviewStatus: "unreviewed",
    });

    const result = validateModelDatabase(database);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "presentation.fallback" }),
      );
    }
  });
});
