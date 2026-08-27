import { z } from "zod";

const IdSchema = z
  .string()
  .min(3)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "IDs must be stable snake_case identifiers",
  );

const TimestampSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().date();
const ConfidenceSchema = z.number().min(0).max(1);
const AttributesSchema = z.record(z.string(), z.unknown());
const ScalarValueSchema = z.union([
  z.number().finite(),
  z.string(),
  z.boolean(),
  z.null(),
]);

export const DatasetMetadataSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    defaultModelId: IdSchema.optional(),
  })
  .strict();

export const ModelSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    primaryEntityId: IdSchema,
    baseCurrency: z.string().min(3).max(3),
    asOf: DateSchema,
    currentVersionId: IdSchema,
    versionIds: z.array(IdSchema).min(1),
    defaultScenarioId: IdSchema.optional(),
    attributes: AttributesSchema.optional(),
  })
  .strict();

export const EntitySchema = z
  .object({
    id: IdSchema,
    type: z.enum(["company", "segment", "product", "geography", "other"]),
    name: z.string().min(1),
    parentEntityId: IdSchema.optional(),
    attributes: AttributesSchema.optional(),
  })
  .strict();

export const MetricSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    dataType: z.enum([
      "number",
      "percentage",
      "currency",
      "count",
      "boolean",
      "text",
    ]),
    unit: z.string().optional(),
    aggregation: z.enum(["sum", "average", "last", "none"]).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const PeriodSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    type: z.enum([
      "fiscal_quarter",
      "fiscal_year",
      "calendar_quarter",
      "calendar_year",
      "date",
      "other",
    ]),
    startDate: DateSchema.optional(),
    endDate: DateSchema.optional(),
    parentPeriodId: IdSchema.optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    type: z.enum(["actual", "base", "bull", "bear", "custom"]),
  })
  .strict();

export const ObservationSchema = z
  .object({
    id: IdSchema,
    modelId: IdSchema,
    metricId: IdSchema,
    entityId: IdSchema,
    periodId: IdSchema,
    scenarioId: IdSchema.optional(),
    actuality: z.enum(["actual", "estimate"]),
    value: ScalarValueSchema,
    unit: z.string().optional(),
    asOf: DateSchema,
    versionId: IdSchema,
    valueType: z.enum([
      "reported",
      "assumption",
      "derived",
      "external_estimate",
    ]),
    transformationId: IdSchema.optional(),
  })
  .strict();

export const TransformationSchema = z
  .object({
    id: IdSchema,
    outputMetricId: IdSchema,
    language: z.literal("model-expression@0.1"),
    expression: z.string().min(1),
    dependencyMetricIds: z.array(IdSchema),
    appliesWhen: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    originalExpression: z.string().optional(),
    status: z.enum(["supported", "opaque", "unresolved"]),
  })
  .strict();

export const RelationshipSchema = z
  .object({
    id: IdSchema,
    fromId: IdSchema,
    type: z.enum([
      "component_of",
      "driven_by",
      "affects",
      "supports",
      "contradicts",
      "supersedes",
      "related_to",
    ]),
    toId: IdSchema,
    attributes: AttributesSchema.optional(),
  })
  .strict();

export const SourceArtifactSchema = z
  .object({
    id: IdSchema,
    type: z.enum([
      "workbook",
      "filing",
      "news",
      "transcript",
      "voice_memo",
      "document",
      "other",
    ]),
    title: z.string().min(1),
    uri: z.string().optional(),
    contentHash: z.string().optional(),
    publishedAt: TimestampSchema.optional(),
    retrievedAt: TimestampSchema.optional(),
  })
  .strict();

export const SourceLocatorSchema = z
  .object({
    sheet: z.string().optional(),
    cell: z.string().optional(),
    range: z.string().optional(),
    page: z.number().int().positive().optional(),
    passage: z.string().optional(),
    timecode: z.string().optional(),
  })
  .strict();

export const TableSectionSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    metricIds: z.array(IdSchema).min(1),
    sourceLocator: SourceLocatorSchema.optional(),
  })
  .strict();

export const TablePresentationSchema = z
  .object({
    modelId: IdSchema,
    sourceArtifactId: IdSchema.optional(),
    sections: z.array(TableSectionSchema).min(1),
  })
  .strict();

export const ProvenanceRecordSchema = z
  .object({
    id: IdSchema,
    targetId: IdSchema,
    sourceArtifactId: IdSchema,
    locator: SourceLocatorSchema.optional(),
    extractionRunId: IdSchema,
    confidence: ConfidenceSchema,
    reviewStatus: z.enum([
      "unreviewed",
      "confirmed",
      "corrected",
      "rejected",
    ]),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    id: IdSchema,
    sourceArtifactId: IdSchema,
    excerpt: z.string().optional(),
    observedAt: TimestampSchema.optional(),
  })
  .strict();

export const AssumptionSchema = z
  .object({
    id: IdSchema,
    modelId: IdSchema,
    statement: z.string().min(1),
    entityId: IdSchema.optional(),
    effectivePeriodIds: z.array(IdSchema).optional(),
    scenarioId: IdSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    status: z.enum(["active", "superseded", "invalidated", "unresolved"]),
  })
  .strict();

export const DecisionSchema = z
  .object({
    id: IdSchema,
    modelId: IdSchema,
    analystId: IdSchema.optional(),
    createdAt: TimestampSchema,
    rationaleText: z.string().optional(),
    rationaleArtifactId: IdSchema.optional(),
  })
  .strict();

export const DecisionChangeSchema = z
  .object({
    id: IdSchema,
    decisionId: IdSchema,
    observationId: IdSchema.optional(),
    metricId: IdSchema,
    periodId: IdSchema,
    scenarioId: IdSchema.optional(),
    before: ScalarValueSchema,
    after: ScalarValueSchema,
  })
  .strict();

export const ExtractionRunSchema = z
  .object({
    id: IdSchema,
    sourceArtifactIds: z.array(IdSchema).min(1),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
    extractor: z.string().min(1),
    modelVersionId: IdSchema,
    status: z.enum(["running", "completed", "completed_with_issues", "failed"]),
    notes: z.string().optional(),
  })
  .strict();

export const UnresolvedItemSchema = z
  .object({
    id: IdSchema,
    modelId: IdSchema.optional(),
    category: z.enum([
      "metric_mapping",
      "formula",
      "hierarchy",
      "lineage",
      "actuality_boundary",
      "presentation",
      "other",
    ]),
    description: z.string().min(1),
    targetId: IdSchema.optional(),
    sourceArtifactId: IdSchema.optional(),
    locator: SourceLocatorSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    attentionLevel: z.enum(["needs_review", "action_required"]).default("needs_review"),
    status: z.enum(["open", "resolved", "dismissed"]),
  })
  .strict();

export const ModelDatabaseSchema = z
  .object({
    schemaVersion: z.literal("0.1.0"),
    dataset: DatasetMetadataSchema,
    models: z.array(ModelSchema).min(1),
    entities: z.array(EntitySchema).min(1),
    metrics: z.array(MetricSchema).min(1),
    periods: z.array(PeriodSchema).min(1),
    scenarios: z.array(ScenarioSchema),
    observations: z.array(ObservationSchema),
    transformations: z.array(TransformationSchema),
    relationships: z.array(RelationshipSchema),
    sourceArtifacts: z.array(SourceArtifactSchema).min(1),
    provenanceRecords: z.array(ProvenanceRecordSchema),
    evidence: z.array(EvidenceSchema),
    assumptions: z.array(AssumptionSchema),
    decisions: z.array(DecisionSchema),
    decisionChanges: z.array(DecisionChangeSchema),
    extractionRuns: z.array(ExtractionRunSchema).min(1),
    unresolvedItems: z.array(UnresolvedItemSchema),
    tablePresentations: z.array(TablePresentationSchema).default([]),
  })
  .strict()
  .describe(
    "Semantic financial-model database with a canonical object core and optional non-canonical table grouping metadata. Spreadsheet row, column, and cell identity are excluded from business objects.",
  );

export const ModelDatabaseJsonSchema = z.toJSONSchema(ModelDatabaseSchema, {
  target: "draft-2020-12",
  reused: "ref",
});
