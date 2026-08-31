import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import { ModelDatabaseQueries } from "../src/model-db/queries";
import type { ModelDatabase } from "../src/model-db/types";
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
    expect(
      table.rows.find((row) => row.metric.id === "metric_harbor_provision")
        ?.unresolvedItems.map((item) => item.id),
    ).toEqual(["unresolved_harbor_provision_label"]);
  });

  it("selects among multiple worksheet presentations for one model", () => {
    const database = structuredClone(sample) as ModelDatabase;
    database.tablePresentations[0].id = "presentation_northstar_revenue";
    database.tablePresentations[0].title = "Revenue";
    database.tablePresentations[0].sections[0].sourceLocator = {
      sheet: "Revenue",
      range: "A10:F12",
    };
    const grossProfit = database.tablePresentations[0].sections.splice(1);
    grossProfit[0].sourceLocator = { sheet: "Profit", range: "A16:F19" };
    database.tablePresentations.push({
      id: "presentation_northstar_profit",
      title: "Profit",
      modelId: "model_northstar_cloud",
      sourceArtifactId: "artifact_northstar_workbook",
      sections: grossProfit,
    });
    const revenueObservationIds = new Set(
      database.observations
        .filter((item) => item.metricId === "metric_northstar_revenue")
        .map((item) => item.id),
    );
    for (const provenance of database.provenanceRecords) {
      if (revenueObservationIds.has(provenance.targetId) && provenance.locator) {
        provenance.locator.sheet = "Revenue";
      }
    }
    const worksheetQueries = new ModelDatabaseQueries(assertValidModelDatabase(database));

    expect(worksheetQueries.getTablePresentations("model_northstar_cloud")).toHaveLength(2);
    expect(worksheetQueries.getFinancialTable({
      modelId: "model_northstar_cloud",
      presentationId: "presentation_northstar_profit",
    }).rows.map((row) => row.metric.name)).toEqual([
      "Cost of revenue",
      "Gross profit",
      "Gross margin",
    ]);
    expect(worksheetQueries.getObservationNavigationTarget(
      "obs_northstar_revenue_fy2025",
      "presentation_northstar_profit",
    ).presentation?.id).toBe("presentation_northstar_revenue");
  });

  it("projects open attention into a navigable cross-model review queue", () => {
    const attention = queries.getAttentionItems();

    expect(attention).toHaveLength(1);
    expect(attention[0]).toEqual(
      expect.objectContaining({
        targetLabel: "Provision for credit losses",
        model: expect.objectContaining({ id: "model_harbor_national" }),
        metric: expect.objectContaining({ id: "metric_harbor_provision" }),
        locator: { sheet: "Model", cell: "A14" },
      }),
    );
  });

  it("infers an attention period from a workbook source column when possible", () => {
    const periodSpecific = structuredClone(sample) as ModelDatabase;
    periodSpecific.unresolvedItems[0].locator = { sheet: "Model", cell: "E14" };

    const attention = new ModelDatabaseQueries(
      assertValidModelDatabase(periodSpecific),
    ).getAttentionItems();

    expect(attention[0]?.period?.id).toBe("period_fy2025");
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

  it("deduplicates period-specific formulas in the metric dependency graph", () => {
    const repeated = structuredClone(sample);
    const transformation = repeated.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    if (!transformation) throw new Error("Missing representative transformation");
    repeated.transformations.push({
      ...transformation,
      id: "transformation_northstar_gross_profit_repeat",
    });
    repeated.provenanceRecords.push({
      id: "provenance_transformation_northstar_gross_profit_repeat",
      targetId: "transformation_northstar_gross_profit_repeat",
      sourceArtifactId: "artifact_northstar_workbook",
      locator: { sheet: "Model", cell: "F18" },
      extractionRunId: "run_northstar_2025_03_15",
      confidence: 0.9,
      reviewStatus: "unreviewed",
    });

    const graph = new ModelDatabaseQueries(assertValidModelDatabase(repeated)).getDependencies({
      metricId: "metric_northstar_gross_profit",
      direction: "upstream",
    });
    expect(graph.edges.filter((edge) =>
      edge.fromId === "metric_northstar_revenue" &&
      edge.toId === "metric_northstar_gross_profit"
    )).toHaveLength(1);
    expect(graph.transformations.filter((item) =>
      item.outputMetricId === "metric_northstar_gross_profit"
    )).toHaveLength(1);
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
    lagged.periods.push({
      id: "period_q4_2024",
      label: "Q4'24A",
      type: "fiscal_quarter",
      startDate: "2024-10-01",
      endDate: "2024-12-31",
    });
    lagged.observations.push({
      ...lagged.observations.find((item) => item.id === "obs_northstar_revenue_fy2024")!,
      id: "obs_northstar_revenue_q4_2024",
      periodId: "period_q4_2024",
      value: 360,
    });
    lagged.provenanceRecords.push(
      {
        id: "provenance_period_q4_2024",
        targetId: "period_q4_2024",
        sourceArtifactId: "artifact_northstar_workbook",
        locator: { sheet: "Model", cell: "D3" },
        extractionRunId: "run_northstar_2025_03_15",
        confidence: 0.99,
        reviewStatus: "unreviewed",
      },
      {
        id: "provenance_obs_northstar_revenue_q4_2024",
        targetId: "obs_northstar_revenue_q4_2024",
        sourceArtifactId: "artifact_northstar_workbook",
        locator: { sheet: "Model", cell: "D10" },
        extractionRunId: "run_northstar_2025_03_15",
        confidence: 0.99,
        reviewStatus: "unreviewed",
      },
    );
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

    const mixedQueries = new ModelDatabaseQueries(assertValidModelDatabase(lagged));
    expect(mixedQueries.getPeriodTypes("model_northstar_cloud")).toEqual([
      "fiscal_year",
      "fiscal_quarter",
    ]);
    expect(mixedQueries.getFinancialTable({
      modelId: "model_northstar_cloud",
      periodType: "fiscal_quarter",
    }).periods.map((item) => item.id)).toEqual(["period_q4_2024"]);
  });

  it("resolves explicit cross-period formulas to the exact source cell", () => {
    const explicit = structuredClone(sample) as ModelDatabase;
    const transformation = explicit.transformations.find(
      (item) => item.id === "transformation_northstar_gross_profit",
    );
    if (!transformation) throw new Error("Missing representative transformation");
    transformation.expression =
      'period_ref("metric_northstar_revenue", "period_fy2024")';
    transformation.dependencyMetricIds = ["metric_northstar_revenue"];
    transformation.appliesWhen = { periodIds: ["period_fy2025"] };

    const detail = new ModelDatabaseQueries(
      assertValidModelDatabase(explicit),
    ).getObservationDetail("obs_northstar_gross_profit_fy2025");
    expect(detail.inputs).toHaveLength(1);
    expect(detail.inputs[0]?.period?.label).toBe("FY24A");
    expect(detail.inputs[0]?.referencePeriodId).toBe("period_fy2024");
    expect(detail.inputs[0]?.provenance.records[0]?.provenance.locator?.cell).toBe("D10");
  });

  it("projects open metric issues into the affected cell detail", () => {
    const detail = queries.getObservationDetail("obs_harbor_provision_fy2025");
    expect(detail.unresolvedItems).toContainEqual(
      expect.objectContaining({
        id: "unresolved_harbor_provision_label",
        locator: { sheet: "Model", cell: "A14" },
      }),
    );
  });
});
