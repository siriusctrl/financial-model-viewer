import { describe, expect, it } from "vitest";
import sampleJson from "../examples/sample-model-db.json";
import {
  editObservationValue,
  setUnresolvedItemStatus,
} from "../src/model-db/calculation";
import { ModelDatabaseQueries } from "../src/model-db/queries";
import type { ModelDatabase } from "../src/model-db/types";
import { assertValidModelDatabase } from "../src/model-db/validate";

const sample = assertValidModelDatabase(sampleJson);

describe("local model editing", () => {
  it("recalculates every supported downstream formula from an edited input", () => {
    const result = editObservationValue(
      sample,
      "obs_northstar_subscription_revenue_fy2025",
      1400,
    );
    const observations = new Map(
      result.database.observations.map((observation) => [observation.id, observation]),
    );

    expect(result.propagatedChanges.map((change) => change.observationId)).toEqual([
      "obs_northstar_revenue_fy2025",
      "obs_northstar_gross_profit_fy2025",
      "obs_northstar_gross_margin_fy2025",
    ]);
    expect(observations.get("obs_northstar_revenue_fy2025")?.value).toBe(1620);
    expect(observations.get("obs_northstar_gross_profit_fy2025")?.value).toBe(1140);
    expect(observations.get("obs_northstar_gross_margin_fy2025")?.value).toBeCloseTo(
      1140 / 1620,
    );
    expect(
      result.database.provenanceRecords.find(
        (record) => record.targetId === "obs_northstar_gross_margin_fy2025",
      )?.reviewStatus,
    ).toBe("corrected");
  });

  it("exposes direct reverse formula links for a selected input", () => {
    const detail = new ModelDatabaseQueries(sample).getObservationDetail(
      "obs_northstar_subscription_revenue_fy2025",
    );

    expect(detail.dependents.map((dependent) => dependent.observation.id)).toEqual([
      "obs_northstar_revenue_fy2025",
    ]);
  });

  it("keeps formula cells read-only", () => {
    expect(() => editObservationValue(
      sample,
      "obs_northstar_revenue_fy2025",
      1600,
    )).toThrow("Formula cells are read-only");
  });

  it("does not overwrite an opaque workbook formula", () => {
    const database = structuredClone(sample) as ModelDatabase;
    const observation = database.observations.find(
      (candidate) => candidate.id === "obs_northstar_subscription_revenue_fy2025",
    );
    const opaque = database.transformations.find(
      (candidate) => candidate.id === "transformation_northstar_revenue",
    );
    expect(observation).toBeDefined();
    expect(opaque).toBeDefined();
    opaque!.id = "transformation_test_opaque_input";
    opaque!.status = "opaque";
    observation!.transformationId = opaque!.id;

    expect(() => editObservationValue(
      database,
      observation!.id,
      1400,
    )).toThrow("Formula cells are read-only");
  });

  it("resolves an attention item without mutating the input database", () => {
    const next = setUnresolvedItemStatus(
      sample,
      "unresolved_harbor_provision_label",
      "resolved",
    );

    expect(next.unresolvedItems[0].status).toBe("resolved");
    expect(sample.unresolvedItems[0].status).toBe("open");
    expect(new ModelDatabaseQueries(next).getAttentionItems()).toHaveLength(0);
    expect(() => assertValidModelDatabase(next as ModelDatabase)).not.toThrow();
  });

  it("does not let the viewer dismiss reviews or clear required actions", () => {
    expect(() => setUnresolvedItemStatus(
      sample,
      "unresolved_harbor_provision_label",
      "dismissed",
    )).toThrow("cannot be dismissed in the viewer");

    const database = structuredClone(sample) as ModelDatabase;
    database.unresolvedItems[0].attentionLevel = "action_required";
    expect(() => setUnresolvedItemStatus(
      database,
      "unresolved_harbor_provision_label",
      "resolved",
    )).toThrow("Action-required items stay open");
  });

  it("keeps an opaque formula action open until translation succeeds", () => {
    const database = structuredClone(sample) as ModelDatabase;
    const transformation = database.transformations.find(
      (candidate) => candidate.id === "transformation_northstar_gross_profit",
    );
    expect(transformation).toBeDefined();
    transformation!.status = "opaque";
    database.unresolvedItems.push({
      id: "unresolved_northstar_gross_profit_formula",
      modelId: "model_northstar_cloud",
      category: "formula",
      description: "Canonical formula translation is incomplete.",
      currentTreatment: "The cached value remains preview-only.",
      impact: "Canonical formula lineage is unavailable.",
      nextAction: "Translate the formula and rerun extraction.",
      targetId: transformation!.outputMetricId,
      sourceArtifactId: "artifact_northstar_workbook",
      attentionLevel: "action_required",
      status: "open",
    });

    expect(() => setUnresolvedItemStatus(
      database,
      "unresolved_northstar_gross_profit_formula",
      "dismissed",
    )).toThrow("Opaque formula actions stay open");
  });
});
