import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import { ModelDatabaseQueries } from "../src/model-db/queries";
import { assertValidModelDatabase } from "../src/model-db/validate";

const queries = new ModelDatabaseQueries(assertValidModelDatabase(sample));

describe("query projections", () => {
  it("builds the SaaS financial table from ordered presentation metadata", () => {
    const table = queries.getFinancialTable({
      modelId: "model_northstar_cloud",
      scenarioId: "scenario_base",
    });

    expect(table.periods.map((period) => period.label)).toEqual([
      "FY22A",
      "FY23A",
      "FY24A",
      "FY25E",
      "FY26E",
    ]);
    expect(table.sections.map((section) => section.title)).toEqual([
      "Revenue build",
      "Gross profit",
    ]);
    expect(table.rows.map((row) => row.metric.name)).toEqual([
      "Revenue",
      "Subscription revenue",
      "Services revenue",
      "Cost of revenue",
      "Gross profit",
      "Gross margin",
    ]);
    const revenue = table.rows.find(
      (row) => row.metric.id === "metric_northstar_revenue",
    );
    expect(revenue?.observations.period_fy2025?.value).toBe(1535);
  });

  it("uses the same query layer for a structurally different bank model", () => {
    const table = queries.getFinancialTable({
      modelId: "model_harbor_national",
      scenarioId: "scenario_base",
    });

    expect(table.entity.name).toBe("Harbor National");
    expect(table.rows.some((row) => row.metric.name === "Provision for credit losses")).toBe(true);
    expect(table.rows.some((row) => row.metric.name === "Subscription revenue")).toBe(false);
  });

  it("derives graph edges from transformation dependencies", () => {
    const graph = queries.getDependencies({
      metricId: "metric_northstar_gross_profit",
      direction: "both",
    });

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        fromId: "metric_northstar_revenue",
        toId: "metric_northstar_gross_profit",
      }),
    );
    expect(graph.nodes.map((metric) => metric.id)).toContain(
      "metric_northstar_gross_margin",
    );
  });

  it("resolves source lineage for a forecast observation", () => {
    const provenance = queries.getProvenance(
      "obs_northstar_subscription_revenue_fy2025",
    );

    expect(provenance.records[0].source.type).toBe("workbook");
    expect(provenance.records[0].provenance.locator).toEqual({
      sheet: "Model",
      cell: "E11",
    });
    expect(provenance.records[0].provenance.reviewStatus).toBe("unreviewed");
  });

  it("resolves the exact workbook inputs for a derived cell", () => {
    const detail = queries.getObservationDetail(
      "obs_northstar_gross_profit_fy2025",
    );

    expect(detail.transformation?.originalExpression).toBe("=B10-B16");
    expect(detail.inputs.map((input) => input.metric.name)).toEqual([
      "Revenue",
      "Cost of revenue",
    ]);
    expect(
      detail.inputs.map(
        (input) => input.provenance.records[0]?.provenance.locator,
      ),
    ).toEqual([
      { sheet: "Model", cell: "E10" },
      { sheet: "Model", cell: "E16" },
    ]);
  });

  it("resolves lagged formulas to the prior-period source cell", () => {
    const lagged = structuredClone(sample);
    const transformation = lagged.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    if (!transformation) throw new Error("Missing representative transformation");
    transformation.expression = 'lag("metric_northstar_revenue", 1)';
    transformation.dependencyMetricIds = ["metric_northstar_revenue"];

    const detail = new ModelDatabaseQueries(assertValidModelDatabase(lagged)).getObservationDetail(
      "obs_northstar_gross_profit_fy2025",
    );
    expect(detail.inputs).toHaveLength(1);
    expect(detail.inputs[0]?.period?.label).toBe("FY24A");
    expect(detail.inputs[0]?.provenance.records[0]?.provenance.locator?.cell).toBe("D10");
  });
});
