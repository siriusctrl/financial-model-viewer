import { describe, expect, it } from "vitest";
import sampleJson from "../examples/sample-model-db.json";
import {
  confirmReviewItem,
  editObservationValue,
} from "../src/model-db/calculation";
import { ModelDatabaseQueries } from "../src/model-db/queries";
import { findObservationPoint, observations } from "../src/model-db/access";
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
    const observationById = new Map(
      observations(result.database).map((observation) => [observation.id, observation]),
    );

    expect(result.propagatedChanges.map((change) => change.observationId)).toEqual([
      "obs_northstar_revenue_fy2025",
      "obs_northstar_gross_profit_fy2025",
      "obs_northstar_gross_margin_fy2025",
    ]);
    expect(observationById.get("obs_northstar_revenue_fy2025")?.value).toBe(1620);
    expect(observationById.get("obs_northstar_gross_profit_fy2025")?.value).toBe(1140);
    expect(observationById.get("obs_northstar_gross_margin_fy2025")?.value).toBeCloseTo(
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
    const located = findObservationPoint(
      database,
      "obs_northstar_subscription_revenue_fy2025",
    );
    const transformationIndex = database.transformations.findIndex(
      (candidate) => candidate.id === "transformation_northstar_revenue",
    );
    expect(located).toBeDefined();
    expect(transformationIndex).toBeGreaterThanOrEqual(0);
    const supported = database.transformations[transformationIndex];
    database.transformations[transformationIndex] = {
      id: "transformation_test_opaque_input",
      outputMetricId: supported.outputMetricId,
      sourceExpressions: supported.sourceExpressions,
      status: "opaque",
    };
    located!.point.transformationId = "transformation_test_opaque_input";

    expect(() => editObservationValue(
      database,
      located!.point.id,
      1400,
    )).toThrow("Formula cells are read-only");
  });

  it("confirms a documented review without mutating the input database", () => {
    const next = confirmReviewItem(
      sample,
      "unresolved_harbor_provision_label",
    );

    expect(next.unresolvedItems[0].status).toBe("resolved");
    expect(sample.unresolvedItems[0].status).toBe("open");
    expect(next.provenanceRecords.find(
      (record) => record.targetId === "unresolved_harbor_provision_label",
    )?.reviewStatus).toBe("confirmed");
    expect(new ModelDatabaseQueries(next).getAttentionItems()).toHaveLength(0);
    expect(() => assertValidModelDatabase(next as ModelDatabase)).not.toThrow();
  });

  it("rejects actions, closed reviews, and undocumented legacy reviews", () => {
    const action = structuredClone(sample) as ModelDatabase;
    action.unresolvedItems[0].attentionLevel = "action_required";
    expect(() => confirmReviewItem(
      action,
      "unresolved_harbor_provision_label",
    )).toThrow("Only open needs-review items");

    const closed = structuredClone(sample) as ModelDatabase;
    closed.unresolvedItems[0].status = "resolved";
    expect(() => confirmReviewItem(
      closed,
      "unresolved_harbor_provision_label",
    )).toThrow("Only open needs-review items");

    const legacy = structuredClone(sample) as ModelDatabase;
    delete (legacy.unresolvedItems[0] as Partial<typeof legacy.unresolvedItems[number]>).currentTreatment;
    expect(() => confirmReviewItem(
      legacy,
      "unresolved_harbor_provision_label",
    )).toThrow("need current treatment, impact, and next action");
  });
});
