import { validateExpression, type ExpressionReference } from "./expressions";
import type {
  ModelDatabase,
  Observation,
  ObservationPoint,
  ObservationSeries,
  ProvenanceRecord,
  ResolvedProvenanceRecord,
  Transformation,
} from "./types";

export function observations(database: ModelDatabase): Observation[] {
  return database.observationSeries.flatMap((series) =>
    series.points.map((point) => resolveObservation(series, point)),
  );
}

export function groupObservationSeries(items: Observation[]): ObservationSeries[] {
  const groups = new Map<string, ObservationSeries>();
  for (const observation of items) {
    const key = JSON.stringify([
      observation.modelId,
      observation.metricId,
      observation.entityId,
      observation.asOf,
      observation.versionId,
    ]);
    let series = groups.get(key);
    if (!series) {
      series = {
        modelId: observation.modelId,
        metricId: observation.metricId,
        entityId: observation.entityId,
        asOf: observation.asOf,
        versionId: observation.versionId,
        points: [],
      };
      groups.set(key, series);
    }
    const {
      modelId: _modelId,
      metricId: _metricId,
      entityId: _entityId,
      asOf: _asOf,
      versionId: _versionId,
      ...point
    } = observation;
    series.points.push(point);
  }
  return [...groups.values()];
}

export function resolveObservation(
  series: ObservationSeries,
  point: ObservationPoint,
): Observation {
  const { points: _points, ...context } = series;
  return { ...context, ...point };
}

export function findObservationPoint(
  database: ModelDatabase,
  observationId: string,
): { series: ObservationSeries; point: ObservationPoint } | undefined {
  for (const series of database.observationSeries) {
    const point = series.points.find((candidate) => candidate.id === observationId);
    if (point) return { series, point };
  }
  return undefined;
}

export function transformationReferences(
  transformation: Transformation,
): ExpressionReference[] {
  if (transformation.status !== "supported") return [];
  return validateExpression(transformation.expression).references;
}

export function transformationDependencyMetricIds(
  transformation: Transformation,
): string[] {
  return [...new Set(
    transformationReferences(transformation).map((reference) => reference.metricId),
  )].sort();
}

export function sourceExpressionFor(
  transformation: Transformation,
  periodId: string,
): string | undefined {
  return transformation.sourceExpressions[periodId];
}

export function resolveProvenanceRecord(
  database: ModelDatabase,
  record: ProvenanceRecord,
): ResolvedProvenanceRecord {
  const context = database.provenanceContexts.find(
    (candidate) => candidate.id === record.contextId,
  );
  if (!context) throw new Error(`Unknown provenance context ${record.contextId}`);
  return {
    ...record,
    sourceArtifactId: context.sourceArtifactId,
    extractionRunId: context.extractionRunId,
    confidence: record.confidence ?? context.confidence,
    reviewStatus: record.reviewStatus ?? context.reviewStatus,
  };
}
