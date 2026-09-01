import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import { observations } from "../src/model-db/access";
import { ModelDatabaseQueries } from "../src/model-db/queries";
import type { ModelDatabase } from "../src/model-db/types";
import { assertValidModelDatabase } from "../src/model-db/validate";

const database = assertValidModelDatabase(sample);
const queries = new ModelDatabaseQueries(database);

function fixture(): ModelDatabase {
  return structuredClone(database);
}

describe("query projections", () => {
  it("builds ordered tables for structurally different models", () => {
    const northstar = queries.getFinancialTable({
      modelId: "model_northstar_cloud",
      scenarioId: "scenario_base",
    });
    expect(northstar.periods.map((period) => period.label)).toEqual([
      "FY22A", "FY23A", "FY24A", "FY25E", "FY26E",
    ]);
    expect(northstar.sections.map((section) => section.title)).toEqual([
      "Revenue build", "Gross profit",
    ]);
    expect(northstar.rows.map((row) => row.metric.name)).toEqual([
      "Revenue", "Subscription revenue", "Services revenue",
      "Cost of revenue", "Gross profit", "Gross margin",
    ]);
    expect(northstar.rows.find((row) => row.metric.id === "metric_northstar_revenue")
      ?.observations.period_fy2025?.value).toBe(1535);

    const harbor = queries.getFinancialTable({ modelId: "model_harbor_national" });
    expect(harbor.entity.name).toBe("Harbor National");
    expect(harbor.rows.some((row) => row.metric.name === "Provision for credit losses")).toBe(true);
    expect(harbor.rows.some((row) => row.metric.name === "Subscription revenue")).toBe(false);
  });

  it("selects and navigates among multiple worksheet presentations", () => {
    const next = fixture();
    next.tablePresentations[0].id = "presentation_northstar_revenue";
    next.tablePresentations[0].title = "Revenue";
    next.tablePresentations[0].sections[0].sourceLocator = { sheet: "Revenue", range: "A10:F12" };
    const grossProfit = next.tablePresentations[0].sections.splice(1);
    grossProfit[0].sourceLocator = { sheet: "Profit", range: "A16:F19" };
    next.tablePresentations.push({
      id: "presentation_northstar_profit",
      title: "Profit",
      modelId: "model_northstar_cloud",
      sourceArtifactId: "artifact_northstar_workbook",
      sections: grossProfit,
    });
    const revenueIds = new Set(observations(next)
      .filter((item) => item.metricId === "metric_northstar_revenue")
      .map((item) => item.id));
    for (const provenance of next.provenanceRecords) {
      if (revenueIds.has(provenance.targetId) && provenance.locator) {
        provenance.locator.sheet = "Revenue";
      }
    }
    const worksheetQueries = new ModelDatabaseQueries(assertValidModelDatabase(next));
    expect(worksheetQueries.getTablePresentations("model_northstar_cloud")).toHaveLength(2);
    expect(worksheetQueries.getFinancialTable({
      modelId: "model_northstar_cloud",
      presentationId: "presentation_northstar_profit",
    }).rows.map((row) => row.metric.name)).toEqual([
      "Cost of revenue", "Gross profit", "Gross margin",
    ]);
    expect(worksheetQueries.getObservationNavigationTarget(
      "obs_northstar_revenue_fy2025",
      "presentation_northstar_profit",
    ).presentation?.id).toBe("presentation_northstar_revenue");
  });

  it("projects attention into a navigable review queue and infers source periods", () => {
    const attention = queries.getAttentionItems();
    expect(attention).toHaveLength(1);
    expect(attention[0]).toEqual(expect.objectContaining({
      targetLabel: "Provision for credit losses",
      model: expect.objectContaining({ id: "model_harbor_national" }),
      locator: { sheet: "Model", cell: "A14" },
    }));
    const periodSpecific = fixture();
    periodSpecific.unresolvedItems[0].locator = { sheet: "Model", cell: "E14" };
    expect(new ModelDatabaseQueries(assertValidModelDatabase(periodSpecific))
      .getAttentionItems()[0]?.period?.id).toBe("period_fy2025");
  });

  it("resolves provenance and exact workbook inputs for a derived cell", () => {
    const provenance = queries.getProvenance("obs_northstar_subscription_revenue_fy2025");
    expect(provenance.records[0].source.type).toBe("workbook");
    expect(provenance.records[0].provenance.locator).toEqual({ sheet: "Model", cell: "E11" });
    expect(provenance.records[0].provenance.reviewStatus).toBe("unreviewed");

    const detail = queries.getObservationDetail("obs_northstar_gross_profit_fy2025");
    expect(detail.transformation?.sourceExpressions.period_fy2025).toBe("=E10-E16");
    expect(detail.inputs.map((input) => input.metric.name)).toEqual(["Revenue", "Cost of revenue"]);
    expect(detail.inputs.map((input) => input.provenance.records[0]?.provenance.locator)).toEqual([
      { sheet: "Model", cell: "E10" },
      { sheet: "Model", cell: "E16" },
    ]);
  });

  it("distinguishes formula constants from expressions that currently fold to zero", () => {
    const next = fixture();
    const transformation = next.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    if (!transformation || transformation.status !== "supported") throw new Error("Missing fixture");
    transformation.sourceExpressions.period_fy2025 = "=2.4*12%+4*88%";
    transformation.expression = "((2.4 * 0.12) + (4 * 0.88))";
    expect(new ModelDatabaseQueries(assertValidModelDatabase(next))
      .getObservationDetail("obs_northstar_gross_profit_fy2025").formulaKind).toBe("constant");

    transformation.sourceExpressions.period_fy2025 = "=IFERROR(E10*E16,0)";
    transformation.expression = "0";
    expect(new ModelDatabaseQueries(assertValidModelDatabase(next))
      .getObservationDetail("obs_northstar_gross_profit_fy2025").formulaKind).toBe("expression");
  });

  it("resolves lagged and explicit cross-period formulas to exact source cells", () => {
    const lagged = fixture();
    const transformation = lagged.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    if (!transformation || transformation.status !== "supported") throw new Error("Missing fixture");
    transformation.expression = 'lag("metric_northstar_revenue", 1)';
    const laggedDetail = new ModelDatabaseQueries(assertValidModelDatabase(lagged))
      .getObservationDetail("obs_northstar_gross_profit_fy2025");
    expect(laggedDetail.inputs[0]?.period?.label).toBe("FY24A");
    expect(laggedDetail.inputs[0]?.provenance.records[0]?.provenance.locator?.cell).toBe("D10");

    transformation.expression = 'period_ref("metric_northstar_revenue", "period_fy2024")';
    const explicitDetail = new ModelDatabaseQueries(assertValidModelDatabase(lagged))
      .getObservationDetail("obs_northstar_gross_profit_fy2025");
    expect(explicitDetail.inputs[0]?.referencePeriodId).toBe("period_fy2024");
    expect(explicitDetail.inputs[0]?.provenance.records[0]?.provenance.locator?.cell).toBe("D10");
  });

  it("projects open metric issues into the affected cell detail", () => {
    expect(queries.getObservationDetail("obs_harbor_provision_fy2025").unresolvedItems)
      .toContainEqual(expect.objectContaining({
        id: "unresolved_harbor_provision_label",
        locator: { sheet: "Model", cell: "A14" },
      }));
  });
});
