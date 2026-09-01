import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import { findObservationPoint } from "../src/model-db/access";
import type { ModelDatabase, Transformation } from "../src/model-db/types";
import { validateModelDatabase } from "../src/model-db/validate";

function fixture(): ModelDatabase {
  return structuredClone(sample) as ModelDatabase;
}

function addProvenance(database: ModelDatabase, targetId: string): void {
  database.provenanceRecords.push({
    targetId,
    contextId: database.provenanceContexts[0].id,
  });
}

function attachTransformation(
  database: ModelDatabase,
  observationId: string,
  transformation: Transformation,
): void {
  const located = findObservationPoint(database, observationId);
  if (!located) throw new Error(`Missing fixture observation ${observationId}`);
  located.point.valueType = "derived";
  located.point.transformationId = transformation.id;
  database.transformations.push(transformation);
  addProvenance(database, transformation.id);
}

describe("deterministic model database validator", () => {
  it("accepts the checked-in cross-sector sample", () => {
    const result = validateModelDatabase(sample);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stats).toEqual(expect.objectContaining({
        models: 2,
        observations: 60,
        unresolved: 1,
        needsReview: 1,
        actionRequired: 0,
      }));
      expect(result.warnings).toContainEqual(expect.objectContaining({
        code: "unresolved.needs_review",
        objectId: "unresolved_harbor_provision_label",
      }));
    }
  });

  it("rejects the pre-0.2 contract instead of maintaining compatibility", () => {
    const legacy = structuredClone(sample) as Record<string, unknown>;
    legacy.schemaVersion = "0.1.0";
    const result = validateModelDatabase(legacy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "schema.invalid",
        field: "schemaVersion",
      }));
    }
  });

  it("requires stable IDs and titles for multiple worksheet views", () => {
    const database = fixture();
    const presentation = database.tablePresentations[0];
    const secondSection = presentation.sections.pop()!;
    database.tablePresentations.push({
      modelId: presentation.modelId,
      sourceArtifactId: presentation.sourceArtifactId,
      sections: [secondSection],
    });
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "presentation.id_required" }));
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "presentation.title_required" }));
    }
  });

  it("separates neutral review items from required actions", () => {
    const database = fixture();
    database.unresolvedItems[0].attentionLevel = "action_required";
    database.unresolvedItems[0].actionOwner = "source_owner";
    const result = validateModelDatabase(database);
    expect(result.success).toBe(true);
    if (result.success) expect(result.stats.actionRequired).toBe(1);
  });

  it("requires possible workbook errors and updates to remain actions", () => {
    const database = fixture();
    database.unresolvedItems[0].category = "source_error";
    const downgraded = validateModelDatabase(database);
    expect(downgraded.success).toBe(false);
    if (!downgraded.success) {
      expect(downgraded.errors).toContainEqual(expect.objectContaining({
        code: "unresolved.repair_required",
        field: "attentionLevel",
      }));
    }
    database.unresolvedItems[0].attentionLevel = "action_required";
    database.unresolvedItems[0].actionOwner = "source_owner";
    expect(validateModelDatabase(database).success).toBe(true);
  });

  it("requires an open action while a transformation remains opaque", () => {
    const database = fixture();
    const index = database.transformations.findIndex(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    const supported = database.transformations[index];
    database.transformations[index] = {
      id: supported.id,
      outputMetricId: supported.outputMetricId,
      sourceExpressions: supported.sourceExpressions,
      status: "opaque",
    };
    expect(validateModelDatabase(database).success).toBe(false);

    database.unresolvedItems.push({
      id: "unresolved_northstar_gross_profit_formula",
      modelId: "model_northstar_cloud",
      category: "formula",
      description: "The workbook formula has no canonical translation.",
      currentTreatment: "Cached values remain visible without trusted lineage.",
      impact: "Recalculation is blocked for this output.",
      nextAction: "Extend the translator and rerun cached-value replay.",
      targetId: supported.id,
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "E18" },
      confidence: 0.72,
      attentionLevel: "action_required",
      actionOwner: "extraction_agent",
      status: "open",
    });
    database.extractionRuns[0].status = "completed_with_issues";
    addProvenance(database, "unresolved_northstar_gross_profit_formula");
    const withAction = validateModelDatabase(database);
    expect(withAction.success).toBe(true);
    if (withAction.success) {
      expect(withAction.warnings).toContainEqual(expect.objectContaining({
        code: "transformation.opaque",
        attentionLevel: "action_required",
      }));
    }
  });

  it("does not call a run completed while attention remains open", () => {
    const database = fixture();
    database.extractionRuns[1].status = "completed";
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "extraction_run.open_attention" }));
    }
  });

  it("reports broken series references against the affected point", () => {
    const database = fixture();
    const series = database.observationSeries[0];
    series.metricId = "metric_missing_reference";
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "reference.missing",
        objectId: series.points[0].id,
        field: "metricId",
      }));
    }
  });

  it("detects semantic value type mismatches", () => {
    const database = fixture();
    database.observationSeries[0].points[0].value = "not a number";
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "observation.value_type" }));
    }
  });

  it("detects an exact-period cross-metric cycle", () => {
    const database = fixture();
    attachTransformation(database, "obs_northstar_subscription_revenue_fy2025", {
      id: "transformation_same_period_driver_fixture",
      outputMetricId: "metric_northstar_subscription_revenue",
      expression: 'period_ref("metric_northstar_revenue", "period_fy2025")',
      sourceExpressions: { period_fy2025: "=E10" },
      status: "supported",
    });
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "transformation.cycle" }));
    }
  });

  it("allows explicit prior-period references without false cycles", () => {
    const database = fixture();
    attachTransformation(database, "obs_northstar_subscription_revenue_fy2025", {
      id: "transformation_prior_period_driver_fixture",
      outputMetricId: "metric_northstar_subscription_revenue",
      expression: 'period_ref("metric_northstar_revenue", "period_fy2024")',
      sourceExpressions: { period_fy2025: "=D10" },
      status: "supported",
    });
    expect(validateModelDatabase(database).success).toBe(true);
  });

  it("rejects exact-period references to missing periods", () => {
    const database = fixture();
    const transformation = database.transformations[0];
    if (transformation.status !== "supported") throw new Error("Expected supported fixture");
    transformation.expression =
      'period_ref("metric_northstar_subscription_revenue", "period_missing")';
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "reference.missing",
        field: "expression.periodId",
      }));
    }
  });

  it("requires provenance for every extracted canonical object", () => {
    const database = fixture();
    const targetId = database.metrics[0].id;
    database.provenanceRecords = database.provenanceRecords.filter((item) => item.targetId !== targetId);
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "provenance.missing", objectId: targetId }));
    }
  });

  it("rejects duplicate point-in-time observations", () => {
    const database = fixture();
    const point = database.observationSeries[0].points[0];
    const duplicate = { ...structuredClone(point), id: "obs_duplicate_fixture" };
    database.observationSeries[0].points.push(duplicate);
    const sourceRecord = database.provenanceRecords.find((item) => item.targetId === point.id)!;
    database.provenanceRecords.push({ ...sourceRecord, targetId: duplicate.id });
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "observation.duplicate_point" }));
    }
  });

  it("rejects incomplete or duplicated table presentation metrics", () => {
    const database = fixture();
    database.tablePresentations[0].sections[0].metricIds.push("metric_northstar_gross_profit");
    database.tablePresentations[0].sections[1].metricIds =
      database.tablePresentations[0].sections[1].metricIds.filter(
        (metricId) => metricId !== "metric_northstar_gross_margin",
      );
    const result = validateModelDatabase(database);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "presentation.duplicate_metric" }));
      expect(result.errors).toContainEqual(expect.objectContaining({ code: "presentation.metric_missing" }));
    }
  });
});
