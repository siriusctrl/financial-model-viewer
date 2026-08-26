import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Assumption,
  Decision,
  DecisionChange,
  Entity,
  Evidence,
  ExtractionRun,
  Metric,
  Model,
  ModelDatabase,
  Observation,
  Period,
  ProvenanceRecord,
  Relationship,
  Scenario,
  SourceArtifact,
  SourceLocator,
  TablePresentation,
  Transformation,
  UnresolvedItem,
} from "../src/model-db/types";
import { validateModelDatabase } from "../src/model-db/validate";

type Context = "northstar" | "harbor";

type MetricFixture = Metric & {
  row: number;
  values: number[];
  transformationId?: string;
};

const periods: Period[] = [
  { id: "period_fy2022", label: "FY22A", type: "fiscal_year", startDate: "2022-01-01", endDate: "2022-12-31" },
  { id: "period_fy2023", label: "FY23A", type: "fiscal_year", startDate: "2023-01-01", endDate: "2023-12-31" },
  { id: "period_fy2024", label: "FY24A", type: "fiscal_year", startDate: "2024-01-01", endDate: "2024-12-31" },
  { id: "period_fy2025", label: "FY25E", type: "fiscal_year", startDate: "2025-01-01", endDate: "2025-12-31" },
  { id: "period_fy2026", label: "FY26E", type: "fiscal_year", startDate: "2026-01-01", endDate: "2026-12-31" },
];

const scenarios: Scenario[] = [
  { id: "scenario_actual", name: "Actual", type: "actual" },
  { id: "scenario_base", name: "Base", type: "base" },
];

const sources: SourceArtifact[] = [
  {
    id: "artifact_northstar_workbook",
    type: "workbook",
    title: "Northstar Cloud operating model (representative fixture)",
    uri: "fixtures://northstar-cloud-model.xlsx",
    contentHash: `sha256:${"a1".repeat(32)}`,
    retrievedAt: "2025-03-15T09:00:00Z",
  },
  {
    id: "artifact_northstar_notes",
    type: "document",
    title: "Northstar Cloud forecast notes (representative fixture)",
    uri: "fixtures://northstar-cloud-notes.md",
    contentHash: `sha256:${"b2".repeat(32)}`,
    retrievedAt: "2025-03-15T09:01:00Z",
  },
  {
    id: "artifact_harbor_workbook",
    type: "workbook",
    title: "Harbor National bank model (representative fixture)",
    uri: "fixtures://harbor-national-model.xlsx",
    contentHash: `sha256:${"c3".repeat(32)}`,
    retrievedAt: "2025-03-15T09:05:00Z",
  },
  {
    id: "artifact_harbor_notes",
    type: "document",
    title: "Harbor National provision notes (representative fixture)",
    uri: "fixtures://harbor-national-notes.md",
    contentHash: `sha256:${"d4".repeat(32)}`,
    retrievedAt: "2025-03-15T09:06:00Z",
  },
];

const runs: ExtractionRun[] = [
  {
    id: "run_northstar_2025_03_15",
    sourceArtifactIds: ["artifact_northstar_workbook", "artifact_northstar_notes"],
    startedAt: "2025-03-15T09:00:00Z",
    completedAt: "2025-03-15T09:02:00Z",
    extractor: "fixture-extractor@0.1",
    modelVersionId: "version_northstar_2025_03_15",
    status: "completed",
    notes: "Representative dataset for schema and viewer verification; not investment research.",
  },
  {
    id: "run_harbor_2025_03_15",
    sourceArtifactIds: ["artifact_harbor_workbook", "artifact_harbor_notes"],
    startedAt: "2025-03-15T09:05:00Z",
    completedAt: "2025-03-15T09:08:00Z",
    extractor: "fixture-extractor@0.1",
    modelVersionId: "version_harbor_2025_03_15",
    status: "completed_with_issues",
    notes: "One label-to-metric mapping remains explicitly unresolved.",
  },
];

const models: Model[] = [
  {
    id: "model_northstar_cloud",
    name: "Northstar Cloud Operating Model",
    description: "Representative SaaS model used to prove metric hierarchy and formula lineage.",
    primaryEntityId: "entity_northstar_cloud",
    baseCurrency: "USD",
    asOf: "2025-03-15",
    currentVersionId: "version_northstar_2025_03_15",
    versionIds: ["version_northstar_2025_03_15"],
    defaultScenarioId: "scenario_base",
    attributes: { sector: "Software", fiscalYearEnd: "December" },
  },
  {
    id: "model_harbor_national",
    name: "Harbor National Bank Model",
    description: "Structurally different bank fixture used to test schema and viewer generality.",
    primaryEntityId: "entity_harbor_national",
    baseCurrency: "USD",
    asOf: "2025-03-15",
    currentVersionId: "version_harbor_2025_03_15",
    versionIds: ["version_harbor_2025_03_15"],
    defaultScenarioId: "scenario_base",
    attributes: { sector: "Banks", fiscalYearEnd: "December" },
  },
];

const entities: Entity[] = [
  { id: "entity_northstar_cloud", type: "company", name: "Northstar Cloud", attributes: { ticker: "NSTC" } },
  { id: "entity_harbor_national", type: "company", name: "Harbor National", attributes: { ticker: "HBNK" } },
];

const northstarMetrics: MetricFixture[] = [
  { id: "metric_northstar_revenue", name: "Revenue", description: "Total recognized revenue.", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement", "key-output"], row: 10, values: [1000, 1150, 1330, 1535, 1745], transformationId: "transformation_northstar_revenue" },
  { id: "metric_northstar_subscription_revenue", name: "Subscription revenue", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement", "driver"], row: 11, values: [820, 960, 1125, 1315, 1510] },
  { id: "metric_northstar_services_revenue", name: "Services revenue", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement"], row: 12, values: [180, 190, 205, 220, 235] },
  { id: "metric_northstar_cost_of_revenue", name: "Cost of revenue", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement"], row: 16, values: [340, 380, 425, 480, 535] },
  { id: "metric_northstar_gross_profit", name: "Gross profit", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement", "key-output"], row: 18, values: [660, 770, 905, 1055, 1210], transformationId: "transformation_northstar_gross_profit" },
  { id: "metric_northstar_gross_margin", name: "Gross margin", dataType: "percentage", unit: "%", aggregation: "average", tags: ["margin", "key-output"], row: 19, values: [0.66, 0.669565, 0.680451, 0.687296, 0.69341], transformationId: "transformation_northstar_gross_margin" },
];

const harborMetrics: MetricFixture[] = [
  { id: "metric_harbor_operating_income", name: "Total operating income", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement", "key-output"], row: 8, values: [2000, 2080, 2175, 2275, 2375], transformationId: "transformation_harbor_operating_income" },
  { id: "metric_harbor_net_interest_income", name: "Net interest income", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["banking", "driver"], row: 9, values: [1480, 1540, 1610, 1685, 1760] },
  { id: "metric_harbor_non_interest_income", name: "Non-interest income", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["banking"], row: 10, values: [520, 540, 565, 590, 615] },
  { id: "metric_harbor_provision", name: "Provision for credit losses", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["credit", "assumption"], row: 14, values: [210, 260, 225, 235, 245] },
  { id: "metric_harbor_non_interest_expense", name: "Non-interest expense", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["banking"], row: 18, values: [1190, 1230, 1285, 1330, 1380] },
  { id: "metric_harbor_pre_tax_income", name: "Pre-tax income", dataType: "currency", unit: "USDm", aggregation: "sum", tags: ["income-statement", "key-output"], row: 21, values: [600, 590, 665, 710, 750], transformationId: "transformation_harbor_pre_tax_income" },
];

const metrics: Metric[] = [...northstarMetrics, ...harborMetrics].map(
  ({ row: _row, values: _values, transformationId: _transformationId, ...metric }) => metric,
);

const transformations: Transformation[] = [
  {
    id: "transformation_northstar_revenue",
    outputMetricId: "metric_northstar_revenue",
    language: "model-expression@0.1",
    expression: "sum(ref(\"metric_northstar_subscription_revenue\"), ref(\"metric_northstar_services_revenue\"))",
    dependencyMetricIds: ["metric_northstar_subscription_revenue", "metric_northstar_services_revenue"],
    appliesWhen: { modelId: "model_northstar_cloud" },
    originalExpression: "=SUM(B11:B12)",
    status: "supported",
  },
  {
    id: "transformation_northstar_gross_profit",
    outputMetricId: "metric_northstar_gross_profit",
    language: "model-expression@0.1",
    expression: "ref(\"metric_northstar_revenue\") - ref(\"metric_northstar_cost_of_revenue\")",
    dependencyMetricIds: ["metric_northstar_revenue", "metric_northstar_cost_of_revenue"],
    appliesWhen: { modelId: "model_northstar_cloud" },
    originalExpression: "=B10-B16",
    status: "supported",
  },
  {
    id: "transformation_northstar_gross_margin",
    outputMetricId: "metric_northstar_gross_margin",
    language: "model-expression@0.1",
    expression: "when(ref(\"metric_northstar_revenue\") == 0, null, ref(\"metric_northstar_gross_profit\") / ref(\"metric_northstar_revenue\"))",
    dependencyMetricIds: ["metric_northstar_revenue", "metric_northstar_gross_profit"],
    appliesWhen: { modelId: "model_northstar_cloud" },
    originalExpression: "=IFERROR(B18/B10,0)",
    status: "supported",
  },
  {
    id: "transformation_harbor_operating_income",
    outputMetricId: "metric_harbor_operating_income",
    language: "model-expression@0.1",
    expression: "sum(ref(\"metric_harbor_net_interest_income\"), ref(\"metric_harbor_non_interest_income\"))",
    dependencyMetricIds: ["metric_harbor_net_interest_income", "metric_harbor_non_interest_income"],
    appliesWhen: { modelId: "model_harbor_national" },
    originalExpression: "=SUM(B9:B10)",
    status: "supported",
  },
  {
    id: "transformation_harbor_pre_tax_income",
    outputMetricId: "metric_harbor_pre_tax_income",
    language: "model-expression@0.1",
    expression: "ref(\"metric_harbor_operating_income\") - ref(\"metric_harbor_provision\") - ref(\"metric_harbor_non_interest_expense\")",
    dependencyMetricIds: ["metric_harbor_operating_income", "metric_harbor_provision", "metric_harbor_non_interest_expense"],
    appliesWhen: { modelId: "model_harbor_national" },
    originalExpression: "=B8-B14-B18",
    status: "supported",
  },
];

const relationships: Relationship[] = [
  { id: "relationship_northstar_subscription_component", fromId: "metric_northstar_subscription_revenue", type: "component_of", toId: "metric_northstar_revenue" },
  { id: "relationship_northstar_services_component", fromId: "metric_northstar_services_revenue", type: "component_of", toId: "metric_northstar_revenue" },
  { id: "relationship_harbor_interest_component", fromId: "metric_harbor_net_interest_income", type: "component_of", toId: "metric_harbor_operating_income" },
  { id: "relationship_harbor_non_interest_component", fromId: "metric_harbor_non_interest_income", type: "component_of", toId: "metric_harbor_operating_income" },
];

const tablePresentations: TablePresentation[] = [
  {
    modelId: "model_northstar_cloud",
    sourceArtifactId: "artifact_northstar_workbook",
    sections: [
      {
        id: "section_northstar_revenue_build",
        title: "Revenue build",
        metricIds: [
          "metric_northstar_revenue",
          "metric_northstar_subscription_revenue",
          "metric_northstar_services_revenue",
        ],
        sourceLocator: { sheet: "Model", range: "A10:F12" },
      },
      {
        id: "section_northstar_gross_profit",
        title: "Gross profit",
        metricIds: [
          "metric_northstar_cost_of_revenue",
          "metric_northstar_gross_profit",
          "metric_northstar_gross_margin",
        ],
        sourceLocator: { sheet: "Model", range: "A16:F19" },
      },
    ],
  },
  {
    modelId: "model_harbor_national",
    sourceArtifactId: "artifact_harbor_workbook",
    sections: [
      {
        id: "section_harbor_operating_income",
        title: "Operating income",
        metricIds: [
          "metric_harbor_operating_income",
          "metric_harbor_net_interest_income",
          "metric_harbor_non_interest_income",
        ],
        sourceLocator: { sheet: "Model", range: "A8:F10" },
      },
      {
        id: "section_harbor_credit_and_costs",
        title: "Credit and costs",
        metricIds: [
          "metric_harbor_provision",
          "metric_harbor_non_interest_expense",
        ],
        sourceLocator: { sheet: "Model", range: "A14:F18" },
      },
      {
        id: "section_harbor_pre_tax_earnings",
        title: "Pre-tax earnings",
        metricIds: ["metric_harbor_pre_tax_income"],
        sourceLocator: { sheet: "Model", range: "A21:F21" },
      },
    ],
  },
];

const observations: Observation[] = [];
const locatorByTarget = new Map<string, SourceLocator>();
const contextByTarget = new Map<string, Context>();
const confidenceByTarget = new Map<string, number>();
const reviewByTarget = new Map<string, ProvenanceRecord["reviewStatus"]>();

function mark(
  id: string,
  context: Context,
  locator?: SourceLocator,
  confidence = 0.99,
  reviewStatus: ProvenanceRecord["reviewStatus"] = "confirmed",
): void {
  contextByTarget.set(id, context);
  if (locator) locatorByTarget.set(id, locator);
  confidenceByTarget.set(id, confidence);
  reviewByTarget.set(id, reviewStatus);
}

function createObservations(
  context: Context,
  model: Model,
  entity: Entity,
  fixtureMetrics: MetricFixture[],
): void {
  const columns = ["B", "C", "D", "E", "F"];
  for (const fixture of fixtureMetrics) {
    fixture.values.forEach((value, index) => {
      const period = periods[index];
      const isActual = index < 3;
      const observation: Observation = {
        id: `obs_${context}_${fixture.id.replace(`metric_${context}_`, "")}_${period.id.replace("period_", "")}`,
        modelId: model.id,
        metricId: fixture.id,
        entityId: entity.id,
        periodId: period.id,
        scenarioId: isActual ? "scenario_actual" : "scenario_base",
        actuality: isActual ? "actual" : "estimate",
        value,
        unit: fixture.unit,
        asOf: model.asOf,
        versionId: model.currentVersionId,
        valueType: fixture.transformationId
          ? "derived"
          : isActual
            ? "reported"
            : "assumption",
        ...(fixture.transformationId
          ? { transformationId: fixture.transformationId }
          : {}),
      };
      observations.push(observation);
      mark(
        observation.id,
        context,
        { sheet: "Model", cell: `${columns[index]}${fixture.row}` },
        isActual ? 1 : 0.94,
        isActual ? "confirmed" : "unreviewed",
      );
    });
  }
}

createObservations("northstar", models[0], entities[0], northstarMetrics);
createObservations("harbor", models[1], entities[1], harborMetrics);

const evidence: Evidence[] = [
  {
    id: "evidence_northstar_retention",
    sourceArtifactId: "artifact_northstar_notes",
    excerpt: "Renewal cohort remains stable; base case assumes subscription growth moderates through FY26.",
    observedAt: "2025-03-15T08:45:00Z",
  },
  {
    id: "evidence_harbor_provision",
    sourceArtifactId: "artifact_harbor_notes",
    excerpt: "Provision normalization is delayed to preserve coverage while criticized assets remain elevated.",
    observedAt: "2025-03-15T08:50:00Z",
  },
];

const assumptions: Assumption[] = [
  {
    id: "assumption_northstar_subscription_growth",
    modelId: "model_northstar_cloud",
    statement: "Subscription revenue growth moderates while renewal behavior remains stable.",
    entityId: "entity_northstar_cloud",
    effectivePeriodIds: ["period_fy2025", "period_fy2026"],
    scenarioId: "scenario_base",
    confidence: 0.76,
    status: "active",
  },
  {
    id: "assumption_harbor_credit_cost",
    modelId: "model_harbor_national",
    statement: "Credit costs stay above the pre-cycle level through FY26.",
    entityId: "entity_harbor_national",
    effectivePeriodIds: ["period_fy2025", "period_fy2026"],
    scenarioId: "scenario_base",
    confidence: 0.71,
    status: "active",
  },
];

const decisions: Decision[] = [
  {
    id: "decision_northstar_fy2025_revenue",
    modelId: "model_northstar_cloud",
    analystId: "analyst_demo",
    createdAt: "2025-03-15T08:55:00Z",
    rationaleText: "Raise FY25 subscription revenue after reviewing renewal cohorts.",
    rationaleArtifactId: "artifact_northstar_notes",
  },
];

const decisionChanges: DecisionChange[] = [
  {
    id: "change_northstar_fy2025_subscription",
    decisionId: "decision_northstar_fy2025_revenue",
    observationId: "obs_northstar_subscription_revenue_fy2025",
    metricId: "metric_northstar_subscription_revenue",
    periodId: "period_fy2025",
    scenarioId: "scenario_base",
    before: 1280,
    after: 1315,
  },
];

const unresolvedItems: UnresolvedItem[] = [
  {
    id: "unresolved_harbor_provision_label",
    modelId: "model_harbor_national",
    category: "metric_mapping",
    description: "The workbook label 'LLP' was mapped to provision for credit losses, but the source contains no explicit definition.",
    targetId: "metric_harbor_provision",
    sourceArtifactId: "artifact_harbor_workbook",
    locator: { sheet: "Model", cell: "A14" },
    confidence: 0.64,
    status: "open",
  },
];

relationships.push(
  { id: "relationship_northstar_evidence_supports", fromId: "evidence_northstar_retention", type: "supports", toId: "assumption_northstar_subscription_growth" },
  { id: "relationship_northstar_assumption_affects", fromId: "assumption_northstar_subscription_growth", type: "affects", toId: "metric_northstar_subscription_revenue" },
  { id: "relationship_northstar_decision_related", fromId: "decision_northstar_fy2025_revenue", type: "related_to", toId: "assumption_northstar_subscription_growth" },
  { id: "relationship_harbor_evidence_supports", fromId: "evidence_harbor_provision", type: "supports", toId: "assumption_harbor_credit_cost" },
  { id: "relationship_harbor_assumption_affects", fromId: "assumption_harbor_credit_cost", type: "affects", toId: "metric_harbor_provision" },
);

for (const object of models) mark(object.id, object.id.includes("harbor") ? "harbor" : "northstar", { sheet: "Cover", range: "A1:F12" });
for (const object of entities) mark(object.id, object.id.includes("harbor") ? "harbor" : "northstar", { sheet: "Cover", cell: "B3" });
for (const object of periods) mark(object.id, "northstar", { sheet: "Model", range: "B7:F7" });
for (const object of scenarios) mark(object.id, "northstar", { sheet: "Assumptions", range: "B2:C2" });
for (const fixture of [...northstarMetrics, ...harborMetrics]) {
  const context = fixture.id.includes("harbor") ? "harbor" : "northstar";
  mark(fixture.id, context, { sheet: "Model", cell: `A${fixture.row}` }, 0.96, fixture.id === "metric_harbor_provision" ? "unreviewed" : "confirmed");
}
for (const object of transformations) {
  const context = object.id.includes("harbor") ? "harbor" : "northstar";
  const fixture = [...northstarMetrics, ...harborMetrics].find((item) => item.id === object.outputMetricId);
  mark(object.id, context, { sheet: "Model", range: `B${fixture?.row ?? 1}:F${fixture?.row ?? 1}` }, 0.95);
}
for (const object of relationships) mark(object.id, object.id.includes("harbor") ? "harbor" : "northstar", { sheet: "Model", range: "A1:F30" }, 0.9, "unreviewed");
for (const object of evidence) mark(object.id, object.id.includes("harbor") ? "harbor" : "northstar", { passage: object.excerpt });
for (const object of assumptions) mark(object.id, object.id.includes("harbor") ? "harbor" : "northstar", { passage: object.statement }, object.confidence ?? 0.8, "unreviewed");
for (const object of decisions) mark(object.id, "northstar", { passage: object.rationaleText });
for (const object of decisionChanges) mark(object.id, "northstar", { sheet: "Model", cell: "E11" }, 0.96, "unreviewed");
for (const object of unresolvedItems) mark(object.id, "harbor", object.locator, object.confidence ?? 0.5, "unreviewed");

const requiredTargets = [
  ...models,
  ...entities,
  ...metrics,
  ...periods,
  ...scenarios,
  ...observations,
  ...transformations,
  ...relationships,
  ...evidence,
  ...assumptions,
  ...decisions,
  ...decisionChanges,
  ...unresolvedItems,
];

const provenanceRecords: ProvenanceRecord[] = requiredTargets.map((target) => {
  const context = contextByTarget.get(target.id);
  if (!context) throw new Error(`No fixture context for ${target.id}`);
  return {
    id: `provenance_${target.id}`,
    targetId: target.id,
    sourceArtifactId:
      target.id.startsWith("evidence_") ||
      target.id.startsWith("assumption_") ||
      target.id.startsWith("decision_")
        ? `artifact_${context}_notes`
        : `artifact_${context}_workbook`,
    locator: locatorByTarget.get(target.id),
    extractionRunId: `run_${context}_2025_03_15`,
    confidence: confidenceByTarget.get(target.id) ?? 0.9,
    reviewStatus: reviewByTarget.get(target.id) ?? "unreviewed",
  };
});

const database: ModelDatabase = {
  schemaVersion: "0.1.0",
  dataset: {
    id: "dataset_representative_models",
    name: "Representative cross-sector financial models",
    description: "Synthetic SaaS and bank fixtures for deterministic schema, validator, query, and visualization tests. Not investment research.",
    createdAt: "2025-03-15T09:08:00Z",
    updatedAt: "2025-03-15T09:08:00Z",
    defaultModelId: "model_northstar_cloud",
  },
  models,
  entities,
  metrics,
  periods,
  scenarios,
  observations,
  transformations,
  relationships,
  sourceArtifacts: sources,
  provenanceRecords,
  evidence,
  assumptions,
  decisions,
  decisionChanges,
  extractionRuns: runs,
  unresolvedItems,
  tablePresentations,
};

const validation = validateModelDatabase(database);
if (!validation.success) {
  console.error(validation.errors);
  throw new Error("Generated sample did not pass deterministic validation");
}

const outputPath = resolve("examples/sample-model-db.json");
const output = `${JSON.stringify(database, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== output) {
    console.error("examples/sample-model-db.json is stale. Run npm run sample:generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output);
  console.log(`Generated ${outputPath}`);
}
