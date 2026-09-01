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
      expect(result.stats.needsReview).toBe(1);
      expect(result.stats.actionRequired).toBe(0);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "unresolved.needs_review",
          objectId: "unresolved_harbor_provision_label",
          attentionLevel: "needs_review",
        }),
      );
    }
  });

  it("requires stable IDs and titles for multiple worksheet views", () => {
    const database = fixture();
    const presentation = database.tablePresentations.find(
      (item) => item.modelId === "model_northstar_cloud",
    )!;
    const secondSection = presentation.sections.pop()!;
    database.tablePresentations.push({
      modelId: presentation.modelId,
      sourceArtifactId: presentation.sourceArtifactId,
      sections: [secondSection],
    });

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "presentation.id_required" }),
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "presentation.title_required" }),
      );
    }
  });

  it("separates neutral review items from required actions", () => {
    const database = fixture();
    database.unresolvedItems[0].attentionLevel = "action_required";

    const result = validateModelDatabase(database);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stats.needsReview).toBe(0);
      expect(result.stats.actionRequired).toBe(1);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "unresolved.action_required",
          attentionLevel: "action_required",
        }),
      );
    }
  });

  it("requires possible workbook errors and updates to remain actions", () => {
    const database = fixture();
    database.unresolvedItems[0].category = "source_error";

    const downgraded = validateModelDatabase(database);
    expect(downgraded.success).toBe(false);
    if (!downgraded.success) {
      expect(downgraded.errors).toContainEqual(
        expect.objectContaining({
          code: "unresolved.repair_required",
          objectId: database.unresolvedItems[0].id,
          field: "attentionLevel",
        }),
      );
    }

    database.unresolvedItems[0].attentionLevel = "action_required";
    database.unresolvedItems[0].actionOwner = "source_owner";
    const repairAction = validateModelDatabase(database);
    expect(repairAction.success).toBe(true);
  });

  it("requires an open action while a transformation remains opaque", () => {
    const database = fixture();
    const transformation = database.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    expect(transformation).toBeDefined();
    transformation!.status = "opaque";

    const withoutAction = validateModelDatabase(database);
    expect(withoutAction.success).toBe(false);
    if (!withoutAction.success) {
      expect(withoutAction.errors).toContainEqual(
        expect.objectContaining({
          code: "transformation.opaque_action_required",
          objectId: transformation!.id,
        }),
      );
    }

    database.unresolvedItems.push({
      id: "unresolved_northstar_gross_profit_formula",
      modelId: "model_northstar_cloud",
      category: "formula",
      description: "The workbook formula is preserved but has no canonical translation.",
      targetId: transformation!.id,
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "E17" },
      attentionLevel: "action_required",
      status: "open",
    });
    database.extractionRuns.find(
      (run) => run.id === "run_northstar_2025_03_15",
    )!.status = "completed_with_issues";
    database.provenanceRecords.push({
      id: "provenance_unresolved_northstar_gross_profit_formula",
      targetId: "unresolved_northstar_gross_profit_formula",
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "E17" },
      extractionRunId: "run_northstar_2025_03_15",
      confidence: 0.72,
      reviewStatus: "unreviewed",
    });

    const withAction = validateModelDatabase(database);
    expect(withAction.success).toBe(true);
    if (withAction.success) {
      expect(withAction.warnings).toContainEqual(
        expect.objectContaining({
          code: "transformation.opaque",
          attentionLevel: "action_required",
        }),
      );
    }

    database.unresolvedItems.at(-1)!.status = "dismissed";
    const dismissedTooEarly = validateModelDatabase(database);
    expect(dismissedTooEarly.success).toBe(false);
    if (!dismissedTooEarly.success) {
      expect(dismissedTooEarly.errors).toContainEqual(
        expect.objectContaining({ code: "transformation.opaque_action_required" }),
      );
    }
  });

  it("does not call a run completed while attention items remain open", () => {
    const database = fixture();
    database.extractionRuns.find(
      (run) => run.id === "run_harbor_2025_03_15",
    )!.status = "completed";

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "extraction_run.open_attention" }),
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

  it("allows explicit prior-period self references without treating them as cycles", () => {
    const database = fixture();
    const transformation = database.transformations[0];
    transformation.expression =
      'period_ref("metric_northstar_revenue", "period_fy2024")';
    transformation.dependencyMetricIds = ["metric_northstar_revenue"];
    transformation.appliesWhen = { periodIds: ["period_fy2025"] };

    expect(validateModelDatabase(database).success).toBe(true);
  });

  it("does not mistake a prior-period driver loop for a same-cell cycle", () => {
    const database = fixture();
    database.transformations.push({
      id: "transformation_cross_period_driver_fixture",
      outputMetricId: "metric_northstar_subscription_revenue",
      language: "model-expression@0.1",
      expression:
        'period_ref("metric_northstar_revenue", "period_fy2024")',
      dependencyMetricIds: ["metric_northstar_revenue"],
      appliesWhen: { periodIds: ["period_fy2025"] },
      status: "supported",
    });
    database.provenanceRecords.push({
      id: "provenance_transformation_cross_period_driver_fixture",
      targetId: "transformation_cross_period_driver_fixture",
      sourceArtifactId: database.sourceArtifacts[0].id,
      extractionRunId: database.extractionRuns[0].id,
      confidence: 1,
      reviewStatus: "confirmed",
    });

    expect(validateModelDatabase(database).success).toBe(true);
  });

  it("still detects an exact-period cross-metric cycle", () => {
    const database = fixture();
    database.transformations.push({
      id: "transformation_same_period_driver_fixture",
      outputMetricId: "metric_northstar_subscription_revenue",
      language: "model-expression@0.1",
      expression:
        'period_ref("metric_northstar_revenue", "period_fy2025")',
      dependencyMetricIds: ["metric_northstar_revenue"],
      appliesWhen: { periodIds: ["period_fy2025"] },
      status: "supported",
    });

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "transformation.cycle" }),
      );
    }
  });

  it("rejects exact-period references to missing periods", () => {
    const database = fixture();
    const transformation = database.transformations[0];
    transformation.expression =
      'period_ref("metric_northstar_subscription_revenue", "period_missing")';
    transformation.dependencyMetricIds = ["metric_northstar_subscription_revenue"];

    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: "reference.missing",
          objectId: transformation.id,
          field: "expression.periodId",
        }),
      );
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
      attentionLevel: "needs_review",
      status: "open",
    });
    database.extractionRuns.find(
      (run) => run.id === "run_northstar_2025_03_15",
    )!.status = "completed_with_issues";
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
