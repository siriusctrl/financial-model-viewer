import {
  evaluateExpression,
  validateExpression,
  type ExpressionReference,
} from "./expressions";
import {
  ObservationSchema,
  ProvenanceRecordSchema,
  UnresolvedItemSchema,
} from "./schema";
import { hasCompleteAttentionGuidance } from "./attention";
import type {
  Metric,
  ModelDatabase,
  Observation,
  Period,
  ScalarValue,
  Transformation,
} from "./types";

export type ResolvedObservationInput = {
  reference: ExpressionReference;
  period?: Period;
  observation?: Observation;
};

export type ObservationValueChange = {
  observationId: string;
  metricId: string;
  periodId: string;
  before: ScalarValue;
  after: ScalarValue;
};

export type ObservationEditResult = {
  database: ModelDatabase;
  directChange: ObservationValueChange;
  propagatedChanges: ObservationValueChange[];
};

function comparePeriods(left: Period, right: Period): number {
  const leftKey = left.startDate ?? left.endDate ?? left.label;
  const rightKey = right.startDate ?? right.endDate ?? right.label;
  return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id);
}

function matchesScenario(
  candidate: Observation,
  scenarioId: string | undefined,
): boolean {
  if (!scenarioId) return true;
  return candidate.actuality === "actual" || candidate.scenarioId === scenarioId;
}

function observationIndexKey(
  observation: Pick<Observation, "modelId" | "metricId" | "entityId" | "periodId" | "versionId">,
): string {
  return [
    observation.modelId,
    observation.metricId,
    observation.entityId,
    observation.periodId,
    observation.versionId,
  ].join("\u0000");
}

function changeFor(
  observation: Observation,
  before: ScalarValue,
  after: ScalarValue,
): ObservationValueChange {
  return {
    observationId: observation.id,
    metricId: observation.metricId,
    periodId: observation.periodId,
    before,
    after,
  };
}

function valueMatchesMetric(value: ScalarValue, metric: Metric): boolean {
  if (value === null) return true;
  if (["number", "percentage", "currency"].includes(metric.dataType)) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (metric.dataType === "count") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (metric.dataType === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

function assertValidChangedObservations(
  database: ModelDatabase,
  observationIds: Set<string>,
): void {
  const metrics = new Map(database.metrics.map((metric) => [metric.id, metric]));
  for (const observation of database.observations) {
    if (!observationIds.has(observation.id)) continue;
    const parsed = ObservationSchema.safeParse(observation);
    if (!parsed.success) {
      throw new Error(`${observation.id}: ${parsed.error.issues[0]?.message ?? "invalid observation"}`);
    }
    const metric = metrics.get(observation.metricId);
    if (!metric || !valueMatchesMetric(observation.value, metric)) {
      throw new Error(
        `${observation.id}.value is incompatible with ${metric?.dataType ?? "its metric"}`,
      );
    }
  }
  for (const provenance of database.provenanceRecords) {
    if (!observationIds.has(provenance.targetId)) continue;
    const parsed = ProvenanceRecordSchema.safeParse(provenance);
    if (!parsed.success) {
      throw new Error(`${provenance.id}: ${parsed.error.issues[0]?.message ?? "invalid provenance"}`);
    }
  }
}

export class ModelCalculator {
  private readonly observations: Map<string, Observation>;
  private readonly periods: Map<string, Period>;
  private readonly transformations: Map<string, Transformation>;
  private readonly observationsByPoint: Map<string, Observation[]>;
  private readonly observationIdsByTransformation: Map<string, string[]>;
  private readonly transformationIdsByDependency: Map<string, Set<string>>;
  private readonly referencesByTransformation: Map<string, ExpressionReference[]>;
  private readonly observedPeriodsCache = new Map<string, Period[]>();

  constructor(private readonly database: ModelDatabase) {
    this.observations = new Map(
      database.observations.map((observation) => [observation.id, observation]),
    );
    this.periods = new Map(database.periods.map((period) => [period.id, period]));
    this.transformations = new Map(
      database.transformations.map((transformation) => [transformation.id, transformation]),
    );
    this.observationsByPoint = new Map();
    this.observationIdsByTransformation = new Map();
    this.transformationIdsByDependency = new Map();
    this.referencesByTransformation = new Map();

    for (const observation of database.observations) {
      const key = observationIndexKey(observation);
      this.observationsByPoint.set(
        key,
        [...(this.observationsByPoint.get(key) ?? []), observation],
      );
      if (observation.transformationId) {
        this.observationIdsByTransformation.set(
          observation.transformationId,
          [
            ...(this.observationIdsByTransformation.get(observation.transformationId) ?? []),
            observation.id,
          ],
        );
      }
    }

    for (const transformation of database.transformations) {
      if (transformation.status !== "supported") continue;
      for (const metricId of transformation.dependencyMetricIds) {
        const ids = this.transformationIdsByDependency.get(metricId) ?? new Set<string>();
        ids.add(transformation.id);
        this.transformationIdsByDependency.set(metricId, ids);
      }
    }
  }

  private transformationReferences(transformation: Transformation): ExpressionReference[] {
    const cached = this.referencesByTransformation.get(transformation.id);
    if (cached) return cached;
    const references = validateExpression(transformation.expression).references;
    this.referencesByTransformation.set(transformation.id, references);
    return references;
  }

  getObservation(observationId: string): Observation {
    const observation = this.observations.get(observationId);
    if (!observation) throw new Error(`Unknown observation ${observationId}`);
    return observation;
  }

  getTransformation(observation: Observation): Transformation | undefined {
    return observation.transformationId
      ? this.transformations.get(observation.transformationId)
      : undefined;
  }

  private observedPeriods(output: Observation, periodType: Period["type"]): Period[] {
    const cacheKey = [
      output.modelId,
      output.entityId,
      output.versionId,
      output.asOf,
      output.scenarioId ?? "",
      periodType,
    ].join("\u0000");
    const cached = this.observedPeriodsCache.get(cacheKey);
    if (cached) return cached;

    const periodIds = new Set(
      this.database.observations
        .filter(
          (candidate) =>
            candidate.modelId === output.modelId
            && candidate.entityId === output.entityId
            && candidate.versionId === output.versionId
            && candidate.asOf <= output.asOf
            && matchesScenario(candidate, output.scenarioId),
        )
        .map((candidate) => candidate.periodId),
    );
    const periods = [...periodIds]
      .map((periodId) => this.periods.get(periodId))
      .filter(
        (period): period is Period => period !== undefined && period.type === periodType,
      )
      .sort(comparePeriods);
    this.observedPeriodsCache.set(cacheKey, periods);
    return periods;
  }

  private referencePeriod(
    output: Observation,
    reference: ExpressionReference,
  ): Period | undefined {
    if (reference.periodId) return this.periods.get(reference.periodId);
    const outputPeriod = this.periods.get(output.periodId);
    if (!outputPeriod) return undefined;
    const periods = this.observedPeriods(output, outputPeriod.type);
    const outputIndex = periods.findIndex((period) => period.id === output.periodId);
    return periods[outputIndex + reference.periodOffset];
  }

  private resolveReference(
    output: Observation,
    reference: ExpressionReference,
  ): ResolvedObservationInput {
    const period = this.referencePeriod(output, reference);
    if (!period) return { reference };
    const candidates = this.observationsByPoint.get(
      observationIndexKey({
        modelId: output.modelId,
        metricId: reference.metricId,
        entityId: output.entityId,
        periodId: period.id,
        versionId: output.versionId,
      }),
    ) ?? [];
    const observation = candidates
      .filter(
        (candidate) =>
          candidate.asOf <= output.asOf
          && matchesScenario(candidate, output.scenarioId),
      )
      .sort((left, right) => {
        const leftExactScenario = left.scenarioId === output.scenarioId ? 1 : 0;
        const rightExactScenario = right.scenarioId === output.scenarioId ? 1 : 0;
        return rightExactScenario - leftExactScenario || right.asOf.localeCompare(left.asOf);
      })[0];
    return { reference, period, observation };
  }

  resolveInputs(observationId: string): ResolvedObservationInput[] {
    const output = this.getObservation(observationId);
    const transformation = this.getTransformation(output);
    if (!transformation || transformation.status !== "supported") return [];
    return this.transformationReferences(transformation)
      .map((reference) => this.resolveReference(output, reference));
  }

  getDirectDependents(observationId: string): Observation[] {
    const input = this.getObservation(observationId);
    const transformationIds = this.transformationIdsByDependency.get(input.metricId);
    if (!transformationIds) return [];
    const dependentIds = new Set<string>();
    for (const transformationId of transformationIds) {
      for (const candidateId of this.observationIdsByTransformation.get(transformationId) ?? []) {
        const candidate = this.getObservation(candidateId);
        if (candidate.modelId !== input.modelId) continue;
        if (this.resolveInputs(candidateId).some(
          (resolved) => resolved.observation?.id === observationId,
        )) {
          dependentIds.add(candidateId);
        }
      }
    }
    return [...dependentIds]
      .map((id) => this.getObservation(id))
      .sort((left, right) => {
        const leftPeriod = this.periods.get(left.periodId);
        const rightPeriod = this.periods.get(right.periodId);
        return left.metricId.localeCompare(right.metricId)
          || (leftPeriod && rightPeriod ? comparePeriods(leftPeriod, rightPeriod) : 0)
          || left.id.localeCompare(right.id);
      });
  }

  evaluateObservation(observationId: string): ScalarValue {
    const output = this.getObservation(observationId);
    const transformation = this.getTransformation(output);
    if (!transformation || transformation.status !== "supported") {
      throw new Error(`${observationId} has no supported canonical formula`);
    }
    const requiredValue = (reference: ExpressionReference): ScalarValue => {
      const input = this.resolveReference(output, reference).observation;
      if (!input) {
        const period = this.referencePeriod(output, reference);
        throw new Error(
          `${observationId} cannot resolve ${reference.metricId} for ${period?.label ?? "the requested period"}`,
        );
      }
      return input.value;
    };
    return evaluateExpression(transformation.expression, {
      ref: (metricId) => requiredValue({ metricId, periodOffset: 0 }),
      periodRef: (metricId, periodId) => requiredValue({
        metricId,
        periodOffset: 0,
        periodId,
      }),
      lag: (metricId, periods) => requiredValue({
        metricId,
        periodOffset: -periods,
      }),
      lead: (metricId, periods) => requiredValue({
        metricId,
        periodOffset: periods,
      }),
    });
  }
}

export function editObservationValue(
  database: ModelDatabase,
  observationId: string,
  value: ScalarValue,
): ObservationEditResult {
  const next = structuredClone(database) as ModelDatabase;
  const observation = next.observations.find((item) => item.id === observationId);
  if (!observation) throw new Error(`Unknown observation ${observationId}`);
  const transformation = observation.transformationId
    ? next.transformations.find((item) => item.id === observation.transformationId)
    : undefined;
  if (observation.valueType === "derived" || transformation) {
    throw new Error("Formula cells are read-only. Edit one of their source inputs instead.");
  }
  if (Object.is(observation.value, value)) {
    throw new Error("Enter a value that differs from the current cell.");
  }

  const before = observation.value;
  observation.value = value;
  const directMetric = next.metrics.find((metric) => metric.id === observation.metricId);
  if (!directMetric || !valueMatchesMetric(value, directMetric)) {
    throw new Error(
      `${observation.id}.value is incompatible with ${directMetric?.dataType ?? "its metric"}`,
    );
  }
  const calculator = new ModelCalculator(next);
  const affectedIds = new Set<string>();
  const queue = [observationId];
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;
    for (const dependent of calculator.getDirectDependents(currentId)) {
      if (affectedIds.has(dependent.id)) continue;
      affectedIds.add(dependent.id);
      queue.push(dependent.id);
    }
  }

  const recalculatedIds = new Set<string>();
  const visiting = new Set<string>();
  const propagatedChanges: ObservationValueChange[] = [];
  const recalculate = (targetId: string): void => {
    if (recalculatedIds.has(targetId)) return;
    if (visiting.has(targetId)) throw new Error(`Formula cycle reached ${targetId}`);
    visiting.add(targetId);
    for (const input of calculator.resolveInputs(targetId)) {
      if (input.observation && affectedIds.has(input.observation.id)) {
        recalculate(input.observation.id);
      }
    }
    const target = calculator.getObservation(targetId);
    const previous = target.value;
    const calculated = calculator.evaluateObservation(targetId);
    target.value = calculated;
    if (!Object.is(previous, calculated)) {
      propagatedChanges.push(changeFor(target, previous, calculated));
    }
    visiting.delete(targetId);
    recalculatedIds.add(targetId);
  };
  for (const targetId of affectedIds) recalculate(targetId);

  const changedIds = new Set([
    observationId,
    ...propagatedChanges.map((change) => change.observationId),
  ]);
  for (const provenance of next.provenanceRecords) {
    if (changedIds.has(provenance.targetId)) provenance.reviewStatus = "corrected";
  }
  assertValidChangedObservations(next, changedIds);

  return {
    database: next,
    directChange: changeFor(observation, before, value),
    propagatedChanges,
  };
}

export function confirmReviewItem(
  database: ModelDatabase,
  itemId: string,
): ModelDatabase {
  const current = database.unresolvedItems.find((candidate) => candidate.id === itemId);
  if (!current) throw new Error(`Unknown unresolved item ${itemId}`);
  if (current.status !== "open" || current.attentionLevel !== "needs_review") {
    throw new Error("Only open needs-review items can be confirmed in the viewer");
  }
  if (!hasCompleteAttentionGuidance(current)) {
    throw new Error("Review items need current treatment, impact, and next action before confirmation");
  }

  const next = structuredClone(database) as ModelDatabase;
  const item = next.unresolvedItems.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Unknown unresolved item ${itemId}`);
  item.status = "resolved";
  for (const provenance of next.provenanceRecords) {
    if (provenance.targetId === itemId) {
      provenance.reviewStatus = "confirmed";
    }
  }
  const parsedItem = UnresolvedItemSchema.safeParse(item);
  if (!parsedItem.success) {
    throw new Error(`${item.id}: ${parsedItem.error.issues[0]?.message ?? "invalid unresolved item"}`);
  }
  for (const provenance of next.provenanceRecords) {
    if (provenance.targetId !== itemId) continue;
    const parsed = ProvenanceRecordSchema.safeParse(provenance);
    if (!parsed.success) {
      throw new Error(`${provenance.id}: ${parsed.error.issues[0]?.message ?? "invalid provenance"}`);
    }
  }
  return next;
}
