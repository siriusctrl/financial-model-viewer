import type {
  CanonicalObject,
  Entity,
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
} from "./types";
import { validateExpression } from "./expressions";

export type MetricSeriesQuery = {
  modelId: string;
  metricId: string;
  entityId?: string;
  scenarioId?: string;
  asOf?: string;
};

export type MetricSeriesPoint = {
  period: Period;
  observation: Observation;
};

export type MetricHierarchyNode = {
  metric: Metric;
  children: MetricHierarchyNode[];
};

export type FinancialTableRow = {
  metric: Metric;
  depth: number;
  sourceLocator?: SourceLocator;
  unresolvedItems: UnresolvedItem[];
  observations: Record<string, Observation | undefined>;
};

export type FinancialTableSection = {
  id: string;
  title: string;
  sourceLocator?: SourceLocator;
  rows: FinancialTableRow[];
};

export type FinancialTableProjection = {
  model: Model;
  entity: Entity;
  periods: Period[];
  presentation?: TablePresentation;
  sections: FinancialTableSection[];
  rows: FinancialTableRow[];
};

export type DependencyEdge = {
  fromId: string;
  toId: string;
  transformationId: string;
};

export type DependencyGraphProjection = {
  focusMetric: Metric;
  nodes: Metric[];
  edges: DependencyEdge[];
  transformations: Transformation[];
};

export type ProvenanceProjection = {
  records: Array<{
    provenance: ProvenanceRecord;
    source: SourceArtifact;
    extractionRun: ExtractionRun;
  }>;
};

export type ObservationLineageInput = {
  metric: Metric;
  period?: Period;
  periodOffset: number;
  observation?: Observation;
  provenance: ProvenanceProjection;
};

export type ObservationDetailProjection = {
  observation: Observation;
  metric: Metric;
  period: Period;
  model: Model;
  entity: Entity;
  scenario?: Scenario;
  transformation?: Transformation;
  provenance: ProvenanceProjection;
  inputs: ObservationLineageInput[];
  unresolvedItems: UnresolvedItem[];
};

export type ModelOverviewProjection = {
  model: Model;
  entity: Entity;
  metricCount: number;
  observationCount: number;
  transformationCount: number;
  actualCount: number;
  estimateCount: number;
  unresolvedCount: number;
  unreviewedCount: number;
};

function comparePeriods(left: Period, right: Period): number {
  const leftKey = left.startDate ?? left.endDate ?? left.label;
  const rightKey = right.startDate ?? right.endDate ?? right.label;
  return leftKey.localeCompare(rightKey);
}

function locatorRow(locator: SourceLocator | undefined): number | undefined {
  const address = locator?.cell ?? locator?.range?.split(":")[0];
  const match = address?.match(/\$?[A-Z]+\$?(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function observationMatchesScenario(
  observation: Observation,
  scenarioId: string | undefined,
): boolean {
  if (!scenarioId) return true;
  return observation.actuality === "actual" || observation.scenarioId === scenarioId;
}

export class ModelDatabaseQueries {
  readonly database: ModelDatabase;
  private readonly models: Map<string, Model>;
  private readonly entities: Map<string, Entity>;
  private readonly metrics: Map<string, Metric>;
  private readonly periods: Map<string, Period>;
  private readonly scenarios: Map<string, Scenario>;
  private readonly observations: Map<string, Observation>;
  private readonly transformations: Map<string, Transformation>;
  private readonly relationships: Relationship[];
  private readonly objects: Map<string, CanonicalObject | SourceArtifact | ExtractionRun>;

  constructor(database: ModelDatabase) {
    this.database = database;
    this.models = new Map(database.models.map((item) => [item.id, item]));
    this.entities = new Map(database.entities.map((item) => [item.id, item]));
    this.metrics = new Map(database.metrics.map((item) => [item.id, item]));
    this.periods = new Map(database.periods.map((item) => [item.id, item]));
    this.scenarios = new Map(database.scenarios.map((item) => [item.id, item]));
    this.observations = new Map(database.observations.map((item) => [item.id, item]));
    this.transformations = new Map(
      database.transformations.map((item) => [item.id, item]),
    );
    this.relationships = database.relationships;
    this.objects = new Map();
    for (const collection of [
      database.models,
      database.entities,
      database.metrics,
      database.periods,
      database.scenarios,
      database.observations,
      database.transformations,
      database.relationships,
      database.sourceArtifacts,
      database.evidence,
      database.assumptions,
      database.decisions,
      database.decisionChanges,
      database.extractionRuns,
      database.unresolvedItems,
    ]) {
      for (const object of collection) this.objects.set(object.id, object);
    }
  }

  getModels(): Model[] {
    return [...this.database.models];
  }

  getModel(modelId: string): Model {
    const model = this.models.get(modelId);
    if (!model) throw new Error(`Unknown model ${modelId}`);
    return model;
  }

  getMetric(metricId: string): Metric {
    const metric = this.metrics.get(metricId);
    if (!metric) throw new Error(`Unknown metric ${metricId}`);
    return metric;
  }

  getObject(targetId: string): unknown {
    return this.objects.get(targetId);
  }

  getModelOverview(modelId: string): ModelOverviewProjection {
    const model = this.getModel(modelId);
    const entity = this.entities.get(model.primaryEntityId);
    if (!entity) throw new Error(`Model ${modelId} has no primary entity`);
    const observations = this.database.observations.filter(
      (item) => item.modelId === modelId,
    );
    const metricIds = new Set(observations.map((item) => item.metricId));
    const transformations = this.database.transformations.filter(
      (item) =>
        metricIds.has(item.outputMetricId) ||
        item.dependencyMetricIds.some((metricId) => metricIds.has(metricId)),
    );
    const targetIds = new Set([
      modelId,
      model.primaryEntityId,
      ...observations.map((item) => item.id),
      ...metricIds,
      ...transformations.map((item) => item.id),
    ]);

    return {
      model,
      entity,
      metricCount: metricIds.size,
      observationCount: observations.length,
      transformationCount: transformations.length,
      actualCount: observations.filter((item) => item.actuality === "actual").length,
      estimateCount: observations.filter((item) => item.actuality === "estimate").length,
      unresolvedCount: this.database.unresolvedItems.filter(
        (item) => item.modelId === modelId && item.status === "open",
      ).length,
      unreviewedCount: this.database.provenanceRecords.filter(
        (item) => targetIds.has(item.targetId) && item.reviewStatus === "unreviewed",
      ).length,
    };
  }

  getMetricSeries(query: MetricSeriesQuery): MetricSeriesPoint[] {
    const model = this.getModel(query.modelId);
    const entityId = query.entityId ?? model.primaryEntityId;
    const asOf = query.asOf ?? model.asOf;
    const observations = this.database.observations.filter(
      (item) =>
        item.modelId === query.modelId &&
        item.metricId === query.metricId &&
        item.entityId === entityId &&
        item.asOf <= asOf &&
        observationMatchesScenario(item, query.scenarioId),
    );

    const latestByPeriod = new Map<string, Observation>();
    for (const observation of observations) {
      const current = latestByPeriod.get(observation.periodId);
      if (!current || observation.asOf > current.asOf) {
        latestByPeriod.set(observation.periodId, observation);
      }
    }

    return [...latestByPeriod.values()]
      .map((observation) => {
        const period = this.periods.get(observation.periodId);
        if (!period) throw new Error(`Unknown period ${observation.periodId}`);
        return { period, observation };
      })
      .sort((left, right) => comparePeriods(left.period, right.period));
  }

  private visibleMetricIds(modelId: string): Set<string> {
    return new Set(
      this.database.observations
        .filter((item) => item.modelId === modelId)
        .map((item) => item.metricId),
    );
  }

  private primarySourceLocator(targetId: string): SourceLocator | undefined {
    return this.database.provenanceRecords.find((item) => item.targetId === targetId)
      ?.locator;
  }

  private compareMetricsBySource(left: Metric, right: Metric): number {
    const leftLocator = this.primarySourceLocator(left.id);
    const rightLocator = this.primarySourceLocator(right.id);
    const sheetOrder = (leftLocator?.sheet ?? "").localeCompare(rightLocator?.sheet ?? "");
    if (sheetOrder !== 0) return sheetOrder;
    const leftRow = locatorRow(leftLocator);
    const rightRow = locatorRow(rightLocator);
    if (leftRow !== undefined && rightRow !== undefined && leftRow !== rightRow) {
      return leftRow - rightRow;
    }
    if (leftRow !== undefined) return -1;
    if (rightRow !== undefined) return 1;
    return left.name.localeCompare(right.name);
  }

  getMetricHierarchy({
    modelId,
    rootMetricId,
  }: {
    modelId: string;
    rootMetricId?: string;
  }): MetricHierarchyNode[] {
    const visible = this.visibleMetricIds(modelId);
    const childrenByParent = new Map<string, string[]>();
    const childIds = new Set<string>();
    for (const relationship of this.relationships) {
      if (
        relationship.type !== "component_of" ||
        !visible.has(relationship.fromId) ||
        !visible.has(relationship.toId)
      ) {
        continue;
      }
      const children = childrenByParent.get(relationship.toId) ?? [];
      childrenByParent.set(relationship.toId, [...children, relationship.fromId]);
      childIds.add(relationship.fromId);
    }

    const build = (metricId: string, ancestors: Set<string>): MetricHierarchyNode => {
      if (ancestors.has(metricId)) throw new Error(`Metric hierarchy cycle at ${metricId}`);
      const nextAncestors = new Set(ancestors).add(metricId);
      return {
        metric: this.getMetric(metricId),
        children: (childrenByParent.get(metricId) ?? [])
          .map((childId) => build(childId, nextAncestors))
          .sort((left, right) => this.compareMetricsBySource(left.metric, right.metric)),
      };
    };

    if (rootMetricId) return [build(rootMetricId, new Set())];
    return [...visible]
      .filter((metricId) => !childIds.has(metricId))
      .map((metricId) => build(metricId, new Set()))
      .sort((left, right) => this.compareMetricsBySource(left.metric, right.metric));
  }

  getFinancialTable({
    modelId,
    entityId,
    scenarioId,
    asOf,
  }: Omit<MetricSeriesQuery, "metricId">): FinancialTableProjection {
    const model = this.getModel(modelId);
    const resolvedEntityId = entityId ?? model.primaryEntityId;
    const entity = this.entities.get(resolvedEntityId);
    if (!entity) throw new Error(`Unknown entity ${resolvedEntityId}`);

    const hierarchy = this.getMetricHierarchy({ modelId });
    const seriesByMetric = new Map<string, MetricSeriesPoint[]>();
    const periodIds = new Set<string>();
    for (const metricId of this.visibleMetricIds(modelId)) {
      const series = this.getMetricSeries({
        modelId,
        metricId,
        entityId: resolvedEntityId,
        scenarioId,
        asOf,
      });
      seriesByMetric.set(metricId, series);
      for (const point of series) periodIds.add(point.period.id);
    }
    const periods = [...periodIds]
      .map((periodId) => this.periods.get(periodId))
      .filter((period): period is Period => Boolean(period))
      .sort(comparePeriods);

    const rows: FinancialTableRow[] = [];
    const flatten = (node: MetricHierarchyNode, depth: number): void => {
      rows.push({
        metric: node.metric,
        depth,
        sourceLocator: this.primarySourceLocator(node.metric.id),
        unresolvedItems: this.database.unresolvedItems.filter(
          (item) =>
            item.status === "open" &&
            item.targetId === node.metric.id &&
            (!item.modelId || item.modelId === modelId),
        ),
        observations: Object.fromEntries(
          (seriesByMetric.get(node.metric.id) ?? []).map((point) => [
            point.period.id,
            point.observation,
          ]),
        ),
      });
      for (const child of node.children) flatten(child, depth + 1);
    };
    hierarchy.forEach((node) => flatten(node, 0));

    const presentation = this.database.tablePresentations.find(
      (item) => item.modelId === modelId,
    );
    const rowsByMetric = new Map(rows.map((row) => [row.metric.id, row]));
    const sections: FinancialTableSection[] = presentation
      ? presentation.sections.map((section) => ({
          id: section.id,
          title: section.title,
          sourceLocator: section.sourceLocator,
          rows: section.metricIds
            .map((metricId) => rowsByMetric.get(metricId))
            .filter((row): row is FinancialTableRow => Boolean(row)),
        }))
      : [
          {
            id: `section_${modelId.replace(/^model_/, "")}_metrics`,
            title: "Model metrics",
            sourceLocator: rows.find((row) => row.sourceLocator)?.sourceLocator,
            rows,
          },
        ];

    return {
      model,
      entity,
      periods,
      presentation,
      sections,
      rows: sections.flatMap((section) => section.rows),
    };
  }

  getObservationDetail(observationId: string): ObservationDetailProjection {
    const observation = this.observations.get(observationId);
    if (!observation) throw new Error(`Unknown observation ${observationId}`);
    const model = this.getModel(observation.modelId);
    const metric = this.getMetric(observation.metricId);
    const period = this.periods.get(observation.periodId);
    const entity = this.entities.get(observation.entityId);
    if (!period || !entity) throw new Error(`Observation ${observationId} has broken context`);

    const transformation = observation.transformationId
      ? this.transformations.get(observation.transformationId)
      : undefined;
    const observedPeriods = [...new Set(
      this.database.observations
        .filter(
          (candidate) =>
            candidate.modelId === observation.modelId &&
            candidate.entityId === observation.entityId &&
            candidate.versionId === observation.versionId &&
            candidate.asOf <= observation.asOf &&
            observationMatchesScenario(candidate, observation.scenarioId),
        )
        .map((candidate) => candidate.periodId),
    )]
      .map((periodId) => this.periods.get(periodId))
      .filter((candidate): candidate is Period => Boolean(candidate))
      .sort(comparePeriods);
    const currentPeriodIndex = observedPeriods.findIndex(
      (candidate) => candidate.id === observation.periodId,
    );
    const references = transformation?.status === "supported"
      ? validateExpression(transformation.expression).references
      : [];
    const inputs = references.map(({ metricId, periodOffset }) => {
      const inputPeriod = observedPeriods[currentPeriodIndex + periodOffset];
      const candidates = this.database.observations
        .filter(
          (candidate) =>
            candidate.modelId === observation.modelId &&
            candidate.metricId === metricId &&
            candidate.entityId === observation.entityId &&
            candidate.periodId === inputPeriod?.id &&
            candidate.versionId === observation.versionId &&
            candidate.asOf <= observation.asOf &&
            observationMatchesScenario(candidate, observation.scenarioId),
        )
        .sort((left, right) => {
          const leftExactScenario = left.scenarioId === observation.scenarioId ? 1 : 0;
          const rightExactScenario = right.scenarioId === observation.scenarioId ? 1 : 0;
          return rightExactScenario - leftExactScenario || right.asOf.localeCompare(left.asOf);
        });
      const inputObservation = candidates[0];
      return {
        metric: this.getMetric(metricId),
        period: inputPeriod,
        periodOffset,
        observation: inputObservation,
        provenance: inputObservation
          ? this.getProvenance(inputObservation.id)
          : { records: [] },
      };
    });

    return {
      observation,
      metric,
      period,
      model,
      entity,
      scenario: observation.scenarioId
        ? this.scenarios.get(observation.scenarioId)
        : undefined,
      transformation,
      provenance: this.getProvenance(observation.id),
      inputs,
      unresolvedItems: this.database.unresolvedItems.filter(
        (item) =>
          item.status === "open" &&
          (item.targetId === observation.id || item.targetId === metric.id) &&
          (!item.modelId || item.modelId === observation.modelId),
      ),
    };
  }

  getDependencies({
    metricId,
    direction = "both",
  }: {
    metricId: string;
    direction?: "upstream" | "downstream" | "both";
  }): DependencyGraphProjection {
    const focusMetric = this.getMetric(metricId);
    const edges: DependencyEdge[] = [];
    const transformationIds = new Set<string>();
    const visibleMetricIds = new Set([metricId]);
    const queue: Array<{ metricId: string; depth: number }> = [
      { metricId, depth: 0 },
    ];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(`${direction}:${current.metricId}`)) continue;
      seen.add(`${direction}:${current.metricId}`);
      if (current.depth >= 2) continue;

      if (direction === "upstream" || direction === "both") {
        for (const transformation of this.database.transformations.filter(
          (item) => item.outputMetricId === current.metricId,
        )) {
          transformationIds.add(transformation.id);
          for (const dependencyMetricId of transformation.dependencyMetricIds) {
            edges.push({
              fromId: dependencyMetricId,
              toId: transformation.outputMetricId,
              transformationId: transformation.id,
            });
            visibleMetricIds.add(dependencyMetricId);
            queue.push({ metricId: dependencyMetricId, depth: current.depth + 1 });
          }
        }
      }

      if (direction === "downstream" || direction === "both") {
        for (const transformation of this.database.transformations.filter((item) =>
          item.dependencyMetricIds.includes(current.metricId),
        )) {
          transformationIds.add(transformation.id);
          edges.push({
            fromId: current.metricId,
            toId: transformation.outputMetricId,
            transformationId: transformation.id,
          });
          visibleMetricIds.add(transformation.outputMetricId);
          queue.push({
            metricId: transformation.outputMetricId,
            depth: current.depth + 1,
          });
        }
      }
    }

    const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.fromId}|${edge.toId}|${edge.transformationId}`, edge])).values()];
    return {
      focusMetric,
      nodes: [...visibleMetricIds].map((id) => this.getMetric(id)),
      edges: uniqueEdges,
      transformations: [...transformationIds]
        .map((id) => this.transformations.get(id))
        .filter((item): item is Transformation => Boolean(item)),
    };
  }

  getProvenance(targetId: string): ProvenanceProjection {
    const records = this.database.provenanceRecords
      .filter((item) => item.targetId === targetId)
      .map((provenance) => {
        const source = this.database.sourceArtifacts.find(
          (item) => item.id === provenance.sourceArtifactId,
        );
        const extractionRun = this.database.extractionRuns.find(
          (item) => item.id === provenance.extractionRunId,
        );
        if (!source || !extractionRun) {
          throw new Error(`Broken provenance record ${provenance.id}`);
        }
        return { provenance, source, extractionRun };
      });
    return { records };
  }

  getRelationships(targetId: string): Array<{
    relationship: Relationship;
    direction: "incoming" | "outgoing";
    relatedObject: unknown;
  }> {
    return this.relationships
      .filter((item) => item.fromId === targetId || item.toId === targetId)
      .map((relationship) => {
        const direction = relationship.fromId === targetId ? "outgoing" : "incoming";
        const relatedId = direction === "outgoing" ? relationship.toId : relationship.fromId;
        return {
          relationship,
          direction,
          relatedObject: this.getObject(relatedId),
        };
      });
  }
}
