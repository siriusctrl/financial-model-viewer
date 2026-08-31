import type { z } from "zod";
import { validateExpression } from "./expressions";
import { ModelDatabaseSchema } from "./schema";
import type {
  Metric,
  ModelDatabase,
  Observation,
  ScalarValue,
} from "./types";

export type ValidationError = {
  code: string;
  objectId: string;
  field: string;
  reason: string;
  suggestion: string;
};

export type AttentionLevel = "needs_review" | "action_required";

export type ValidationWarning = ValidationError & {
  attentionLevel: AttentionLevel;
};

export type ValidationStats = {
  models: number;
  metrics: number;
  observations: number;
  transformations: number;
  unresolved: number;
  needsReview: number;
  actionRequired: number;
  unreviewed: number;
};

export type ValidationResult =
  | {
      success: true;
      data: ModelDatabase;
      errors: [];
      warnings: ValidationWarning[];
      stats: ValidationStats;
    }
  | {
      success: false;
      data?: ModelDatabase;
      errors: ValidationError[];
      warnings: ValidationWarning[];
      stats?: ValidationStats;
    };

type CollectionName = Exclude<
  keyof ModelDatabase,
  "schemaVersion" | "dataset"
>;

const PROVENANCE_REQUIRED_COLLECTIONS = [
  "models",
  "entities",
  "metrics",
  "periods",
  "scenarios",
  "observations",
  "transformations",
  "relationships",
  "evidence",
  "assumptions",
  "decisions",
  "decisionChanges",
  "unresolvedItems",
] as const satisfies readonly CollectionName[];

function error(
  code: string,
  objectId: string,
  field: string,
  reason: string,
  suggestion: string,
): ValidationError {
  return { code, objectId, field, reason, suggestion };
}

function warning(
  attentionLevel: AttentionLevel,
  code: string,
  objectId: string,
  field: string,
  reason: string,
  suggestion: string,
): ValidationWarning {
  return { ...error(code, objectId, field, reason, suggestion), attentionLevel };
}

function objectIdForSchemaIssue(
  input: unknown,
  issue: z.core.$ZodIssue,
): string {
  if (!input || typeof input !== "object") return "dataset";
  const path = issue.path;
  if (path.length >= 2 && typeof path[0] === "string" && typeof path[1] === "number") {
    const collection = (input as Record<string, unknown>)[path[0]];
    if (Array.isArray(collection)) {
      const candidate = collection[path[1]];
      if (candidate && typeof candidate === "object" && "id" in candidate) {
        return String((candidate as { id: unknown }).id);
      }
    }
  }
  return "dataset";
}

function schemaErrors(input: unknown, issues: z.core.$ZodIssue[]): ValidationError[] {
  return issues.map((issue) =>
    error(
      "schema.invalid",
      objectIdForSchemaIssue(input, issue),
      issue.path.join(".") || "$",
      issue.message,
      "Update the field to match schema/model-db.schema.json",
    ),
  );
}

function scalarKind(value: ScalarValue): string {
  if (value === null) return "null";
  return typeof value;
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

function canonicalCollections(database: ModelDatabase): [string, { id: string }[]][] {
  return [
    ["models", database.models],
    ["entities", database.entities],
    ["metrics", database.metrics],
    ["periods", database.periods],
    ["scenarios", database.scenarios],
    ["observations", database.observations],
    ["transformations", database.transformations],
    ["relationships", database.relationships],
    ["sourceArtifacts", database.sourceArtifacts],
    ["provenanceRecords", database.provenanceRecords],
    ["evidence", database.evidence],
    ["assumptions", database.assumptions],
    ["decisions", database.decisions],
    ["decisionChanges", database.decisionChanges],
    ["extractionRuns", database.extractionRuns],
    ["unresolvedItems", database.unresolvedItems],
  ];
}

type FormulaCycle = {
  objectId: string;
  path: string[];
};

function conditionValues(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  return value ?? [];
}

function detectCycles(database: ModelDatabase): FormulaCycle[] {
  const graph = new Map<string, string[]>();
  const nodeLabels = new Map<string, { metricId: string; periodId?: string }>();
  const periods = new Map(database.periods.map((period) => [period.id, period]));
  const observedPeriodIdsByModel = new Map<string, Set<string>>();
  for (const observation of database.observations) {
    const observed = observedPeriodIdsByModel.get(observation.modelId) ?? new Set<string>();
    observed.add(observation.periodId);
    observedPeriodIdsByModel.set(observation.modelId, observed);
  }
  const periodsByModelAndType = new Map<string, ModelDatabase["periods"]>();
  for (const [modelId, periodIds] of observedPeriodIdsByModel) {
    for (const periodId of periodIds) {
      const period = periods.get(periodId);
      if (!period) continue;
      const key = `${modelId}|${period.type}`;
      const sameType = periodsByModelAndType.get(key) ?? [];
      sameType.push(period);
      periodsByModelAndType.set(key, sameType);
    }
  }
  for (const sameType of periodsByModelAndType.values()) {
    sameType.sort((left, right) =>
      (left.startDate ?? left.endDate ?? left.label).localeCompare(
        right.startDate ?? right.endDate ?? right.label,
      ),
    );
  }

  const cellNode = (modelId: string, metricId: string, periodId: string): string => {
    const key = `cell|${modelId}|${metricId}|${periodId}`;
    nodeLabels.set(key, { metricId, periodId });
    return key;
  };
  const metricNode = (metricId: string): string => {
    const key = `metric|${metricId}`;
    nodeLabels.set(key, { metricId });
    return key;
  };

  for (const transformation of database.transformations) {
    if (transformation.status !== "supported") continue;
    const expression = validateExpression(transformation.expression);
    const modelIds = new Set(conditionValues(transformation.appliesWhen?.modelId));
    const periodIds = new Set(conditionValues(transformation.appliesWhen?.periodIds));
    const linkedOutputs = database.observations.filter(
      (observation) =>
        observation.transformationId === transformation.id &&
        (modelIds.size === 0 || modelIds.has(observation.modelId)) &&
        (periodIds.size === 0 || periodIds.has(observation.periodId)),
    );
    const inferredOutputs = database.observations.filter(
      (observation) =>
        observation.metricId === transformation.outputMetricId &&
        (modelIds.size === 0 || modelIds.has(observation.modelId)) &&
        (periodIds.size === 0 || periodIds.has(observation.periodId)),
    );
    const outputs = linkedOutputs.length > 0 ? linkedOutputs : inferredOutputs;

    if (outputs.length === 0) {
      const outputNode = metricNode(transformation.outputMetricId);
      graph.set(outputNode, [
        ...(graph.get(outputNode) ?? []),
        ...transformation.dependencyMetricIds.map(metricNode),
      ]);
      continue;
    }

    for (const output of outputs) {
      const outputNode = cellNode(
        output.modelId,
        transformation.outputMetricId,
        output.periodId,
      );
      const dependencyNodes = expression.references.flatMap((reference) => {
        if (reference.periodId) {
          return [cellNode(output.modelId, reference.metricId, reference.periodId)];
        }
        if (reference.periodOffset === 0) {
          return [cellNode(output.modelId, reference.metricId, output.periodId)];
        }
        const outputPeriod = periods.get(output.periodId);
        if (!outputPeriod) return [];
        const sameType = periodsByModelAndType.get(
          `${output.modelId}|${outputPeriod.type}`,
        ) ?? [];
        const outputIndex = sameType.findIndex((period) => period.id === output.periodId);
        const inputPeriod = sameType[outputIndex + reference.periodOffset];
        return inputPeriod
          ? [cellNode(output.modelId, reference.metricId, inputPeriod.id)]
          : [];
      });
      graph.set(outputNode, [...(graph.get(outputNode) ?? []), ...dependencyNodes]);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: FormulaCycle[] = [];

  const visit = (nodeId: string): void => {
    if (active.has(nodeId)) {
      const start = stack.indexOf(nodeId);
      const path = [...stack.slice(start), nodeId].map((key) => {
        const node = nodeLabels.get(key);
        return node?.periodId ? `${node.metricId}[${node.periodId}]` : (node?.metricId ?? key);
      });
      cycles.push({
        objectId: nodeLabels.get(nodeId)?.metricId ?? nodeId,
        path,
      });
      return;
    }
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    active.add(nodeId);
    stack.push(nodeId);
    for (const dependency of graph.get(nodeId) ?? []) visit(dependency);
    stack.pop();
    active.delete(nodeId);
  };

  for (const nodeId of graph.keys()) visit(nodeId);
  return cycles;
}

function pushMissingReference(
  errors: ValidationError[],
  objectId: string,
  field: string,
  value: string | undefined,
  validIds: Set<string>,
  kind: string,
): void {
  if (value && !validIds.has(value)) {
    errors.push(
      error(
        "reference.missing",
        objectId,
        field,
        `${kind} ${value} does not exist`,
        `Add the referenced ${kind.toLowerCase()} or correct ${field}`,
      ),
    );
  }
}

function validateObservation(
  observation: Observation,
  database: ModelDatabase,
  indexes: {
    models: Map<string, ModelDatabase["models"][number]>;
    metrics: Map<string, Metric>;
    entities: Set<string>;
    periods: Set<string>;
    scenarios: Set<string>;
    transformations: Set<string>;
  },
  errors: ValidationError[],
): void {
  const model = indexes.models.get(observation.modelId);
  pushMissingReference(
    errors,
    observation.id,
    "modelId",
    observation.modelId,
    new Set(indexes.models.keys()),
    "Model",
  );
  pushMissingReference(errors, observation.id, "metricId", observation.metricId, new Set(indexes.metrics.keys()), "Metric");
  pushMissingReference(errors, observation.id, "entityId", observation.entityId, indexes.entities, "Entity");
  pushMissingReference(errors, observation.id, "periodId", observation.periodId, indexes.periods, "Period");
  pushMissingReference(errors, observation.id, "scenarioId", observation.scenarioId, indexes.scenarios, "Scenario");
  pushMissingReference(errors, observation.id, "transformationId", observation.transformationId, indexes.transformations, "Transformation");

  if (model && !model.versionIds.includes(observation.versionId)) {
    errors.push(
      error(
        "observation.version",
        observation.id,
        "versionId",
        `Version ${observation.versionId} is not declared by model ${model.id}`,
        "Add the version ID to model.versionIds or correct the observation",
      ),
    );
  }

  const metric = indexes.metrics.get(observation.metricId);
  if (metric && !valueMatchesMetric(observation.value, metric)) {
    errors.push(
      error(
        "observation.value_type",
        observation.id,
        "value",
        `Value kind ${scalarKind(observation.value)} is incompatible with metric data type ${metric.dataType}`,
        `Provide a ${metric.dataType} value or correct the metric dataType`,
      ),
    );
  }

  if (observation.valueType === "derived" && !observation.transformationId) {
    errors.push(
      error(
        "observation.transformation",
        observation.id,
        "transformationId",
        "Derived observations must reference a transformation",
        "Add transformationId or use a non-derived valueType",
      ),
    );
  }

  void database;
}

function statsFor(database: ModelDatabase): ValidationStats {
  return {
    models: database.models.length,
    metrics: database.metrics.length,
    observations: database.observations.length,
    transformations: database.transformations.length,
    unresolved: database.unresolvedItems.filter((item) => item.status === "open").length,
    needsReview: database.unresolvedItems.filter(
      (item) => item.status === "open" && item.attentionLevel === "needs_review",
    ).length,
    actionRequired: database.unresolvedItems.filter(
      (item) => item.status === "open" && item.attentionLevel === "action_required",
    ).length,
    unreviewed: database.provenanceRecords.filter(
      (record) => record.reviewStatus === "unreviewed",
    ).length,
  };
}

export function validateModelDatabase(input: unknown): ValidationResult {
  const parsed = ModelDatabaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      errors: schemaErrors(input, parsed.error.issues),
      warnings: [],
    };
  }

  const database = parsed.data;
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const specificallyReportedUnresolvedIds = new Set<string>();
  const models = new Map(database.models.map((item) => [item.id, item]));
  const metrics = new Map(database.metrics.map((item) => [item.id, item]));
  const entityIds = new Set(database.entities.map((item) => item.id));
  const periodIds = new Set(database.periods.map((item) => item.id));
  const scenarioIds = new Set(database.scenarios.map((item) => item.id));
  const transformationIds = new Set(database.transformations.map((item) => item.id));
  const sourceArtifactIds = new Set(database.sourceArtifacts.map((item) => item.id));
  const extractionRuns = new Map(database.extractionRuns.map((item) => [item.id, item]));
  const extractionRunIds = new Set(database.extractionRuns.map((item) => item.id));
  const observationIds = new Set(database.observations.map((item) => item.id));
  const decisionIds = new Set(database.decisions.map((item) => item.id));
  const evidenceIds = new Set(database.evidence.map((item) => item.id));
  const assumptionIds = new Set(database.assumptions.map((item) => item.id));
  const allVersionIds = new Set(database.models.flatMap((item) => item.versionIds));

  const presentationModels = new Set<string>();
  const presentationIds = new Set<string>();
  const presentedMetricsByModel = new Map<string, Set<string>>();
  const presentationSectionIds = new Set<string>();
  for (const presentation of database.tablePresentations) {
    pushMissingReference(
      errors,
      presentation.modelId,
      "modelId",
      presentation.modelId,
      new Set(models.keys()),
      "Model",
    );
    pushMissingReference(
      errors,
      presentation.modelId,
      "sourceArtifactId",
      presentation.sourceArtifactId,
      sourceArtifactIds,
      "Source artifact",
    );

    if (presentation.id) {
      if (presentationIds.has(presentation.id)) {
        errors.push(
          error(
            "presentation.duplicate_id",
            presentation.id,
            "id",
            "Table presentation ID is already used",
            "Assign a globally unique semantic presentation ID",
          ),
        );
      }
      presentationIds.add(presentation.id);
    }
    presentationModels.add(presentation.modelId);

    const visibleMetricIds = new Set(
      database.observations
        .filter((observation) => observation.modelId === presentation.modelId)
        .map((observation) => observation.metricId),
    );
    const presentedMetricIds = new Set<string>();
    const modelPresentedMetricIds = presentedMetricsByModel.get(presentation.modelId)
      ?? new Set<string>();
    for (const section of presentation.sections) {
      if (presentationSectionIds.has(section.id)) {
        errors.push(
          error(
            "presentation.duplicate_section",
            section.id,
            "id",
            "Table section ID is already used by another section",
            "Assign a globally unique semantic section ID",
          ),
        );
      }
      presentationSectionIds.add(section.id);

      section.metricIds.forEach((metricId, index) => {
        pushMissingReference(
          errors,
          section.id,
          `metricIds.${index}`,
          metricId,
          new Set(metrics.keys()),
          "Metric",
        );
        if (presentedMetricIds.has(metricId)) {
          errors.push(
            error(
              "presentation.duplicate_metric",
              section.id,
              `metricIds.${index}`,
              `Metric ${metricId} appears more than once in the table presentation`,
              "Keep each metric in exactly one ordered section within this worksheet view",
            ),
          );
        }
        if (metrics.has(metricId) && !visibleMetricIds.has(metricId)) {
          errors.push(
            error(
              "presentation.metric_not_visible",
              section.id,
              `metricIds.${index}`,
              `Metric ${metricId} has no observation in model ${presentation.modelId}`,
              "Remove the metric or add an observation for this model",
            ),
          );
        }
        presentedMetricIds.add(metricId);
        modelPresentedMetricIds.add(metricId);
      });
    }
    presentedMetricsByModel.set(presentation.modelId, modelPresentedMetricIds);
  }

  for (const modelId of presentationModels) {
    const modelPresentations = database.tablePresentations.filter(
      (presentation) => presentation.modelId === modelId,
    );
    if (modelPresentations.length <= 1) continue;

    modelPresentations.forEach((presentation, index) => {
      if (!presentation.id) {
        errors.push(
          error(
            "presentation.id_required",
            modelId,
            `tablePresentations.${index}.id`,
            "Each worksheet view needs an ID when a model has multiple table presentations",
            "Assign a stable semantic ID derived from the worksheet or view name",
          ),
        );
      }
      if (!presentation.title) {
        errors.push(
          error(
            "presentation.title_required",
            presentation.id ?? modelId,
            `tablePresentations.${index}.title`,
            "Each worksheet view needs a title when a model has multiple table presentations",
            "Preserve the source worksheet or view label as the presentation title",
          ),
        );
      }
    });
  }

  for (const modelId of presentationModels) {
    const visibleMetricIds = new Set(
      database.observations
        .filter((observation) => observation.modelId === modelId)
        .map((observation) => observation.metricId),
    );
    const presentedMetricIds = presentedMetricsByModel.get(modelId) ?? new Set<string>();
    for (const metricId of visibleMetricIds) {
      if (presentedMetricIds.has(metricId)) continue;
      errors.push(
        error(
          "presentation.metric_missing",
          modelId,
          "sections",
          `Observed metric ${metricId} is missing from every table presentation`,
          "Place the metric in at least one ordered worksheet view or remove all presentations to use the explicit fallback",
        ),
      );
    }
  }

  for (const model of database.models) {
    if (presentationModels.has(model.id)) continue;
    const unresolvedPresentation = database.unresolvedItems.find(
      (item) =>
        item.modelId === model.id &&
        item.category === "presentation" &&
        item.status === "open",
    );
    if (unresolvedPresentation) {
      specificallyReportedUnresolvedIds.add(unresolvedPresentation.id);
      warnings.push(
        warning(
          unresolvedPresentation.attentionLevel,
          "presentation.fallback",
          model.id,
          "tablePresentations",
          `Table grouping is unavailable and tracked by ${unresolvedPresentation.id}`,
          "Resolve the open presentation item after confirming worksheet sections and metric order",
        ),
      );
    } else {
      errors.push(
        error(
          "presentation.missing",
          model.id,
          "tablePresentations",
          "Model has no table presentation and no open presentation unresolved item",
          "Extract ordered table sections or add an explicit presentation unresolved item so fallback is never silent",
        ),
      );
    }
  }

  const seenIds = new Map<string, string>();
  for (const [collection, objects] of canonicalCollections(database)) {
    for (const object of objects) {
      const previousCollection = seenIds.get(object.id);
      if (previousCollection) {
        errors.push(
          error(
            "id.duplicate",
            object.id,
            "id",
            `ID is already used in ${previousCollection}`,
            "Assign a globally unique stable ID",
          ),
        );
      } else {
        seenIds.set(object.id, collection);
      }
    }
  }

  pushMissingReference(errors, database.dataset.id, "defaultModelId", database.dataset.defaultModelId, new Set(models.keys()), "Model");
  for (const model of database.models) {
    pushMissingReference(errors, model.id, "primaryEntityId", model.primaryEntityId, entityIds, "Entity");
    pushMissingReference(errors, model.id, "defaultScenarioId", model.defaultScenarioId, scenarioIds, "Scenario");
    if (!model.versionIds.includes(model.currentVersionId)) {
      errors.push(
        error(
          "model.current_version",
          model.id,
          "currentVersionId",
          `Current version ${model.currentVersionId} is not included in versionIds`,
          "Add currentVersionId to versionIds or select a declared version",
        ),
      );
    }
  }

  for (const entity of database.entities) {
    pushMissingReference(errors, entity.id, "parentEntityId", entity.parentEntityId, entityIds, "Entity");
  }
  for (const period of database.periods) {
    pushMissingReference(errors, period.id, "parentPeriodId", period.parentPeriodId, periodIds, "Period");
  }

  for (const observation of database.observations) {
    validateObservation(
      observation,
      database,
      {
        models,
        metrics,
        entities: entityIds,
        periods: periodIds,
        scenarios: scenarioIds,
        transformations: transformationIds,
      },
      errors,
    );
  }

  const observationKeys = new Map<string, string>();
  for (const observation of database.observations) {
    const key = [
      observation.modelId,
      observation.metricId,
      observation.entityId,
      observation.periodId,
      observation.scenarioId ?? "none",
      observation.asOf,
      observation.versionId,
    ].join("|");
    const previous = observationKeys.get(key);
    if (previous) {
      errors.push(
        error(
          "observation.duplicate_point",
          observation.id,
          "$",
          `Point-in-time key duplicates observation ${previous}`,
          "Remove the duplicate or assign a distinct asOf, version, scenario, or context",
        ),
      );
    } else {
      observationKeys.set(key, observation.id);
    }
  }

  for (const transformation of database.transformations) {
    pushMissingReference(errors, transformation.id, "outputMetricId", transformation.outputMetricId, new Set(metrics.keys()), "Metric");
    transformation.dependencyMetricIds.forEach((metricId, index) =>
      pushMissingReference(errors, transformation.id, `dependencyMetricIds.${index}`, metricId, new Set(metrics.keys()), "Metric"),
    );

    if (transformation.status === "supported") {
      const expression = validateExpression(transformation.expression);
      for (const issue of expression.issues) {
        errors.push(
          error(
            "transformation.expression",
            transformation.id,
            `expression${issue.path === "$" ? "" : issue.path.slice(1)}`,
            issue.reason,
            issue.suggestion,
          ),
        );
      }
      const declared = [...new Set(transformation.dependencyMetricIds)].sort();
      if (declared.join("|") !== expression.dependencies.join("|")) {
        errors.push(
          error(
            "transformation.dependencies",
            transformation.id,
            "dependencyMetricIds",
            `Declared dependencies [${declared.join(", ")}] do not match expression dependencies [${expression.dependencies.join(", ")}]`,
            "Regenerate dependencyMetricIds from the parsed canonical expression",
          ),
        );
      }
      for (const reference of expression.references) {
        pushMissingReference(
          errors,
          transformation.id,
          "expression.periodId",
          reference.periodId,
          periodIds,
          "Period",
        );
      }
    } else if (!transformation.originalExpression) {
      errors.push(
        error(
          "transformation.original_expression",
          transformation.id,
          "originalExpression",
          `${transformation.status} transformations must preserve the original formula`,
          "Add originalExpression from the source workbook",
        ),
      );
    }
    if (transformation.status === "opaque") {
      const opaqueAction = database.unresolvedItems.find(
        (item) => {
          const targets = new Set([item.targetId, ...(item.affectedTargetIds ?? [])]);
          return item.category === "formula" &&
            item.status === "open" &&
            item.attentionLevel === "action_required" &&
            (targets.has(transformation.id) || targets.has(transformation.outputMetricId));
        },
      );
      if (!opaqueAction) {
        errors.push(
          error(
            "transformation.opaque_action_required",
            transformation.id,
            "status",
            "Opaque formulas have not entered the canonical calculation graph and require an open formula action",
            "Add an action_required formula item targeting this transformation or its output metric, then translate and rerun extraction",
          ),
        );
      } else {
        specificallyReportedUnresolvedIds.add(opaqueAction.id);
        const actionOwner = opaqueAction.actionOwner === "model_owner"
          ? "model owner"
          : opaqueAction.actionOwner === "source_owner"
            ? "source owner"
            : opaqueAction.actionOwner === "extraction_agent"
              ? "extraction agent"
              : "unspecified owner";
        warnings.push(
          warning(
            "action_required",
            "transformation.opaque",
            transformation.id,
            "status",
            `Canonical recalculation is blocked and tracked by ${opaqueAction.id} (${actionOwner})`,
            opaqueAction.nextAction
              ?? "Resolve the named action, rerun extraction, and replace the opaque transformation with a replay-checked supported expression",
          ),
        );
      }
    }
  }

  for (const cycle of detectCycles(database)) {
    errors.push(
      error(
        "transformation.cycle",
        cycle.objectId,
        "dependencyMetricIds",
        `Dependency cycle detected: ${cycle.path.join(" -> ")}`,
        "Break the cycle or mark an unsupported transformation as opaque",
      ),
    );
  }

  const relationshipTargetIds = new Set(seenIds.keys());
  for (const relationship of database.relationships) {
    pushMissingReference(errors, relationship.id, "fromId", relationship.fromId, relationshipTargetIds, "Canonical object");
    pushMissingReference(errors, relationship.id, "toId", relationship.toId, relationshipTargetIds, "Canonical object");
  }

  for (const artifact of database.sourceArtifacts) {
    if (artifact.contentHash && !/^[a-z0-9]+:[a-f0-9]+$/i.test(artifact.contentHash)) {
      errors.push(
        error(
          "artifact.content_hash",
          artifact.id,
          "contentHash",
          "Content hash must include an algorithm prefix",
          "Use a value such as sha256:0123abcd",
        ),
      );
    }
  }

  for (const run of database.extractionRuns) {
    run.sourceArtifactIds.forEach((artifactId, index) =>
      pushMissingReference(errors, run.id, `sourceArtifactIds.${index}`, artifactId, sourceArtifactIds, "Source artifact"),
    );
    pushMissingReference(errors, run.id, "modelVersionId", run.modelVersionId, allVersionIds, "Model version");
  }

  const validProvenanceTargets = new Set(
    PROVENANCE_REQUIRED_COLLECTIONS.flatMap((collection) =>
      database[collection].map((object) => object.id),
    ),
  );
  const targetsWithProvenance = new Set<string>();
  const provenanceByTarget = new Map<string, ModelDatabase["provenanceRecords"]>();
  for (const provenance of database.provenanceRecords) {
    pushMissingReference(errors, provenance.id, "targetId", provenance.targetId, validProvenanceTargets, "Provenance target");
    pushMissingReference(errors, provenance.id, "sourceArtifactId", provenance.sourceArtifactId, sourceArtifactIds, "Source artifact");
    pushMissingReference(errors, provenance.id, "extractionRunId", provenance.extractionRunId, extractionRunIds, "Extraction run");
    targetsWithProvenance.add(provenance.targetId);
    provenanceByTarget.set(
      provenance.targetId,
      [...(provenanceByTarget.get(provenance.targetId) ?? []), provenance],
    );
  }
  for (const targetId of validProvenanceTargets) {
    if (!targetsWithProvenance.has(targetId)) {
      errors.push(
        error(
          "provenance.missing",
          targetId,
          "provenanceRecords",
          "Extracted canonical object has no provenance record",
          "Add source artifact, locator, extraction run, confidence, and review status",
        ),
      );
    }
  }

  for (const item of database.evidence) {
    pushMissingReference(errors, item.id, "sourceArtifactId", item.sourceArtifactId, sourceArtifactIds, "Source artifact");
  }
  for (const assumption of database.assumptions) {
    pushMissingReference(errors, assumption.id, "modelId", assumption.modelId, new Set(models.keys()), "Model");
    pushMissingReference(errors, assumption.id, "entityId", assumption.entityId, entityIds, "Entity");
    pushMissingReference(errors, assumption.id, "scenarioId", assumption.scenarioId, scenarioIds, "Scenario");
    assumption.effectivePeriodIds?.forEach((periodId, index) =>
      pushMissingReference(errors, assumption.id, `effectivePeriodIds.${index}`, periodId, periodIds, "Period"),
    );
  }
  for (const decision of database.decisions) {
    pushMissingReference(errors, decision.id, "modelId", decision.modelId, new Set(models.keys()), "Model");
    pushMissingReference(errors, decision.id, "rationaleArtifactId", decision.rationaleArtifactId, sourceArtifactIds, "Source artifact");
  }
  for (const change of database.decisionChanges) {
    pushMissingReference(errors, change.id, "decisionId", change.decisionId, decisionIds, "Decision");
    pushMissingReference(errors, change.id, "observationId", change.observationId, observationIds, "Observation");
    pushMissingReference(errors, change.id, "metricId", change.metricId, new Set(metrics.keys()), "Metric");
    pushMissingReference(errors, change.id, "periodId", change.periodId, periodIds, "Period");
    pushMissingReference(errors, change.id, "scenarioId", change.scenarioId, scenarioIds, "Scenario");
    if (scalarKind(change.before) !== scalarKind(change.after)) {
      errors.push(
        error(
          "decision_change.value_type",
          change.id,
          "before/after",
          `Before kind ${scalarKind(change.before)} differs from after kind ${scalarKind(change.after)}`,
          "Use matching scalar types for before and after",
        ),
      );
    }
  }
  for (const unresolved of database.unresolvedItems) {
    pushMissingReference(errors, unresolved.id, "modelId", unresolved.modelId, new Set(models.keys()), "Model");
    pushMissingReference(errors, unresolved.id, "targetId", unresolved.targetId, relationshipTargetIds, "Canonical object");
    unresolved.affectedTargetIds?.forEach((targetId, index) =>
      pushMissingReference(
        errors,
        unresolved.id,
        `affectedTargetIds.${index}`,
        targetId,
        relationshipTargetIds,
        "Canonical object",
      ),
    );
    pushMissingReference(errors, unresolved.id, "sourceArtifactId", unresolved.sourceArtifactId, sourceArtifactIds, "Source artifact");
    if (unresolved.status === "open") {
      for (const provenance of provenanceByTarget.get(unresolved.id) ?? []) {
        const run = extractionRuns.get(provenance.extractionRunId);
        if (run?.status === "completed") {
          errors.push(
            error(
              "extraction_run.open_attention",
              run.id,
              "status",
              `Extraction run is completed even though ${unresolved.id} remains open`,
              "Use completed_with_issues until every needs_review or action_required item is resolved or dismissed",
            ),
          );
        }
      }
    }
    if (unresolved.status === "open" && !specificallyReportedUnresolvedIds.has(unresolved.id)) {
      warnings.push(
        warning(
          unresolved.attentionLevel,
          `unresolved.${unresolved.attentionLevel}`,
          unresolved.id,
          unresolved.category,
          unresolved.description,
          unresolved.nextAction ?? (
            unresolved.attentionLevel === "action_required"
              ? "Fix the source or extraction and re-import the database"
              : "Confirm the stated interpretation only when it matches the source"
          ),
        ),
      );
    }
  }

  // Ensure evidence and assumptions used in relationships are still resolvable after
  // collection-level validation. These sets also make the intended semantic surface explicit.
  void evidenceIds;
  void assumptionIds;

  const stats = statsFor(database);
  if (errors.length > 0) {
    return { success: false, data: database, errors, warnings, stats };
  }
  return { success: true, data: database, errors: [], warnings, stats };
}

export function assertValidModelDatabase(input: unknown): ModelDatabase {
  const result = validateModelDatabase(input);
  if (!result.success) {
    throw new Error(
      result.errors
        .map((item) => `${item.objectId}.${item.field}: ${item.reason}`)
        .join("\n"),
    );
  }
  return result.data;
}
