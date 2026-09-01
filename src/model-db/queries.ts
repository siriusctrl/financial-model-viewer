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
import { ModelCalculator } from "./calculation";

export type MetricSeriesQuery = {
  modelId: string;
  metricId: string;
  entityId?: string;
  scenarioId?: string;
  asOf?: string;
  periodType?: Period["type"];
};

export type FinancialTableQuery = Omit<MetricSeriesQuery, "metricId"> & {
  presentationId?: string;
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
  referencePeriodId?: string;
  observation?: Observation;
  provenance: ProvenanceProjection;
};

export type ObservationLineageDependent = {
  observation: Observation;
  metric: Metric;
  period: Period;
  transformation: Transformation;
};

export type ObservationDetailProjection = {
  observation: Observation;
  metric: Metric;
  period: Period;
  model: Model;
  entity: Entity;
  scenario?: Scenario;
  transformation?: Transformation;
  formulaKind?: "constant" | "expression";
  provenance: ProvenanceProjection;
  inputs: ObservationLineageInput[];
  dependents: ObservationLineageDependent[];
  unresolvedItems: UnresolvedItem[];
};

const SOURCE_FORMULA_NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?/gi;

function isSourceFormulaConstant(originalExpression: string | undefined): boolean {
  if (!originalExpression?.trimStart().startsWith("=")) return false;
  const body = originalExpression.trimStart().slice(1);
  const remainder = body
    .replace(SOURCE_FORMULA_NUMBER, "")
    .replace(/[()+\-*/^\s]/g, "");
  return body.length > 0 && remainder.length === 0;
}

function formulaKind(transformation: Transformation): "constant" | "expression" {
  if (transformation.status !== "supported" || transformation.dependencyMetricIds.length > 0) {
    return "expression";
  }
  if (transformation.originalExpression) {
    return isSourceFormulaConstant(transformation.originalExpression)
      ? "constant"
      : "expression";
  }
  return "constant";
}

export type ObservationNavigationTarget = {
  observation: Observation;
  model: Model;
  entity: Entity;
  period: Period;
  presentation?: TablePresentation;
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
  needsReviewCount: number;
  actionRequiredCount: number;
  unreviewedCount: number;
};

export type AttentionItemProjection = {
  item: UnresolvedItem;
  model?: Model;
  metric?: Metric;
  period?: Period;
  locator?: SourceLocator;
  targetLabel: string;
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

function locatorColumn(locator: SourceLocator | undefined): string | undefined {
  const address = locator?.cell ?? locator?.range?.split(":")[0];
  return address?.match(/^\$?([A-Z]+)/i)?.[1]?.toUpperCase();
}

function labelForObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const label = record.name ?? record.title ?? record.statement;
  return typeof label === "string" ? label : undefined;
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
  private readonly calculator: ModelCalculator;

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
    this.calculator = new ModelCalculator(database);
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

  getEntities(modelId: string): Entity[] {
    const entityIds = new Set(
      this.database.observations
        .filter((item) => item.modelId === modelId)
        .map((item) => item.entityId),
    );
    return this.database.entities.filter((item) => entityIds.has(item.id));
  }

  getTablePresentations(modelId: string): TablePresentation[] {
    return this.database.tablePresentations.filter((item) => item.modelId === modelId);
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
      needsReviewCount: this.database.unresolvedItems.filter(
        (item) =>
          item.modelId === modelId &&
          item.status === "open" &&
          item.attentionLevel === "needs_review",
      ).length,
      actionRequiredCount: this.database.unresolvedItems.filter(
        (item) =>
          item.modelId === modelId &&
          item.status === "open" &&
          item.attentionLevel === "action_required",
      ).length,
      unreviewedCount: this.database.provenanceRecords.filter(
        (item) => targetIds.has(item.targetId) && item.reviewStatus === "unreviewed",
      ).length,
    };
  }

  getAttentionItems(): AttentionItemProjection[] {
    const observationPeriodsBySheetCell = new Map<string, Set<string>>();
    const observationPeriodsBySheetColumn = new Map<string, Set<string>>();
    for (const provenance of this.database.provenanceRecords) {
      const observation = this.observations.get(provenance.targetId);
      const sheet = provenance.locator?.sheet;
      const column = locatorColumn(provenance.locator);
      if (!observation || !sheet || !column) continue;
      const cell = provenance.locator?.cell?.replaceAll("$", "").toUpperCase();
      if (cell) {
        const cellKey = `${observation.modelId}\u0000${sheet}\u0000${cell}`;
        const cellPeriodIds = observationPeriodsBySheetCell.get(cellKey) ?? new Set<string>();
        cellPeriodIds.add(observation.periodId);
        observationPeriodsBySheetCell.set(cellKey, cellPeriodIds);
      }
      const key = `${observation.modelId}\u0000${sheet}\u0000${column}`;
      const periodIds = observationPeriodsBySheetColumn.get(key) ?? new Set<string>();
      periodIds.add(observation.periodId);
      observationPeriodsBySheetColumn.set(key, periodIds);
    }

    return this.database.unresolvedItems
      .filter((item) => item.status === "open")
      .map((item): AttentionItemProjection => {
        const targetObservation = item.targetId
          ? this.observations.get(item.targetId)
          : undefined;
        const targetTransformation = item.targetId
          ? this.transformations.get(item.targetId)
          : undefined;
        const metric = targetObservation
          ? this.metrics.get(targetObservation.metricId)
          : item.targetId && this.metrics.has(item.targetId)
            ? this.metrics.get(item.targetId)
            : targetTransformation
              ? this.metrics.get(targetTransformation.outputMetricId)
              : undefined;
        const inferredModelId = item.modelId
          ?? targetObservation?.modelId
          ?? (item.targetId && this.models.has(item.targetId) ? item.targetId : undefined)
          ?? (metric
            ? this.database.observations.find(
                (observation) => observation.metricId === metric.id,
              )?.modelId
            : undefined);
        const model = inferredModelId ? this.models.get(inferredModelId) : undefined;
        const locator = item.locator
          ?? this.primarySourceLocator(item.id)
          ?? (item.targetId ? this.primarySourceLocator(item.targetId) : undefined);
        let period = targetObservation
          ? this.periods.get(targetObservation.periodId)
          : undefined;
        const sourceColumn = locatorColumn(locator);
        const sourceCell = locator?.cell?.replaceAll("$", "").toUpperCase();
        if (!period && model && locator?.sheet && sourceCell) {
          const candidatePeriodIds = observationPeriodsBySheetCell.get(
            `${model.id}\u0000${locator.sheet}\u0000${sourceCell}`,
          );
          if (candidatePeriodIds?.size === 1) {
            period = this.periods.get([...candidatePeriodIds][0]);
          }
        }
        if (!period && model && locator?.sheet && sourceColumn) {
          const candidatePeriodIds = observationPeriodsBySheetColumn.get(
            `${model.id}\u0000${locator.sheet}\u0000${sourceColumn}`,
          );
          if (candidatePeriodIds?.size === 1) {
            period = this.periods.get([...candidatePeriodIds][0]);
          }
        }

        const targetLabel = targetObservation && metric && period
          ? `${metric.name} · ${period.label}`
          : metric?.name
            ?? (item.targetId ? labelForObject(this.objects.get(item.targetId)) : undefined)
            ?? (model ? `${model.name} model` : "Workbook-level issue");
        return { item, model, metric, period, locator, targetLabel };
      })
      .sort((left, right) => {
        const levelOrder = left.item.attentionLevel === right.item.attentionLevel
          ? 0
          : left.item.attentionLevel === "action_required" ? -1 : 1;
        return levelOrder
          || (left.model?.name ?? "").localeCompare(right.model?.name ?? "")
          || (left.locator?.sheet ?? "").localeCompare(right.locator?.sheet ?? "")
          || (locatorRow(left.locator) ?? Number.MAX_SAFE_INTEGER)
            - (locatorRow(right.locator) ?? Number.MAX_SAFE_INTEGER)
          || left.item.id.localeCompare(right.item.id);
      });
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
      .filter((point) => !query.periodType || point.period.type === query.periodType)
      .sort((left, right) => comparePeriods(left.period, right.period));
  }

  getPeriodTypes(
    modelId: string,
    presentationId?: string,
    entityId?: string,
  ): Period["type"][] {
    const presentation = presentationId
      ? this.getTablePresentations(modelId).find((item) => item.id === presentationId)
      : undefined;
    const metricIds = presentation
      ? new Set(presentation.sections.flatMap((section) => section.metricIds))
      : undefined;
    const types = new Map<Period["type"], Period>();
    for (const observation of this.database.observations) {
      if (observation.modelId !== modelId) continue;
      if (entityId && observation.entityId !== entityId) continue;
      if (metricIds && !metricIds.has(observation.metricId)) continue;
      const period = this.periods.get(observation.periodId);
      if (!period) continue;
      const current = types.get(period.type);
      if (!current || comparePeriods(period, current) < 0) types.set(period.type, period);
    }
    return [...types.entries()]
      .sort((left, right) => comparePeriods(left[1], right[1]))
      .map(([type]) => type);
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
    periodType,
    presentationId,
  }: FinancialTableQuery): FinancialTableProjection {
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
        periodType,
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
      const observations = seriesByMetric.get(node.metric.id) ?? [];
      if (observations.length === 0) {
        for (const child of node.children) flatten(child, depth);
        return;
      }
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
          observations.map((point) => [
            point.period.id,
            point.observation,
          ]),
        ),
      });
      for (const child of node.children) flatten(child, depth + 1);
    };
    hierarchy.forEach((node) => flatten(node, 0));

    const presentations = this.getTablePresentations(modelId);
    const presentation = presentationId
      ? presentations.find((item) => item.id === presentationId)
      : presentations[0];
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

  getObservationNavigationTarget(
    observationId: string,
    preferredPresentationId?: string,
  ): ObservationNavigationTarget {
    const observation = this.observations.get(observationId);
    if (!observation) throw new Error(`Unknown observation ${observationId}`);
    const model = this.getModel(observation.modelId);
    const entity = this.entities.get(observation.entityId);
    const period = this.periods.get(observation.periodId);
    if (!entity) throw new Error(`Unknown entity ${observation.entityId}`);
    if (!period) throw new Error(`Unknown period ${observation.periodId}`);

    const candidates = this.getTablePresentations(model.id).filter(
      (presentation) => presentation.sections.some(
        (section) => section.metricIds.includes(observation.metricId),
      ),
    );
    const sourceSheet = this.primarySourceLocator(observation.id)?.sheet
      ?? this.primarySourceLocator(observation.metricId)?.sheet;
    const sourcePresentation = sourceSheet
      ? candidates.find(
          (presentation) => presentation.sourceLocator?.sheet === sourceSheet
            || presentation.sections.some(
              (section) => section.metricIds.includes(observation.metricId)
                && section.sourceLocator?.sheet === sourceSheet,
            ),
        )
      : undefined;
    const preferredPresentation = candidates.find(
      (presentation) => presentation.id === preferredPresentationId,
    );

    return {
      observation,
      model,
      entity,
      period,
      presentation: sourcePresentation ?? preferredPresentation ?? candidates[0],
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
    const inputs = this.calculator.resolveInputs(observation.id).map((resolved) => {
      const inputObservation = resolved.observation;
      return {
        metric: this.getMetric(resolved.reference.metricId),
        period: resolved.period,
        periodOffset: resolved.reference.periodOffset,
        referencePeriodId: resolved.reference.periodId,
        observation: inputObservation,
        provenance: inputObservation
          ? this.getProvenance(inputObservation.id)
          : { records: [] },
      };
    });
    const dependents = this.calculator.getDirectDependents(observation.id)
      .map((dependent) => {
        const dependentPeriod = this.periods.get(dependent.periodId);
        const dependentTransformation = dependent.transformationId
          ? this.transformations.get(dependent.transformationId)
          : undefined;
        if (!dependentPeriod || !dependentTransformation) return undefined;
        return {
          observation: dependent,
          metric: this.getMetric(dependent.metricId),
          period: dependentPeriod,
          transformation: dependentTransformation,
        };
      })
      .filter((dependent): dependent is ObservationLineageDependent => dependent !== undefined);

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
      formulaKind: transformation ? formulaKind(transformation) : undefined,
      provenance: this.getProvenance(observation.id),
      inputs,
      dependents,
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
          (item) => item.status === "supported" && item.outputMetricId === current.metricId,
        )) {
          transformationIds.add(transformation.id);
          for (const dependencyMetricId of transformation.dependencyMetricIds) {
            if (dependencyMetricId === transformation.outputMetricId) continue;
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
          item.status === "supported" && item.dependencyMetricIds.includes(current.metricId),
        )) {
          transformationIds.add(transformation.id);
          if (current.metricId === transformation.outputMetricId) continue;
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

    const uniqueEdges = [...new Map(
      edges.map((edge) => [`${edge.fromId}|${edge.toId}`, edge]),
    ).values()];
    const uniqueTransformations = [...new Map(
      [...transformationIds]
        .map((id) => this.transformations.get(id))
        .filter((item): item is Transformation => Boolean(item))
        .map((item) => [
          `${item.outputMetricId}|${item.expression}|${[...item.dependencyMetricIds].sort().join(",")}`,
          item,
        ]),
    ).values()];
    return {
      focusMetric,
      nodes: [...visibleMetricIds].map((id) => this.getMetric(id)),
      edges: uniqueEdges,
      transformations: uniqueTransformations,
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
