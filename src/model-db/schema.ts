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

export const ObservationPointSchema = z
  .object({
    id: IdSchema,
    periodId: IdSchema,
    scenarioId: IdSchema.optional(),
    actuality: z.enum(["actual", "estimate"]),
    value: ScalarValueSchema,
    valueType: z.enum([
      "reported",
      "assumption",
      "derived",
      "external_estimate",
    ]),
    transformationId: IdSchema.optional(),
  })
  .strict();

export const ObservationSeriesSchema = z
  .object({
    modelId: IdSchema,
    metricId: IdSchema,
    entityId: IdSchema,
    asOf: DateSchema,
    versionId: IdSchema,
    points: z.array(ObservationPointSchema).min(1),
  })
  .strict();

const SourceExpressionsSchema = z
  .record(IdSchema, z.string().min(1))
  .refine((value) => Object.keys(value).length > 0, {
    message: "sourceExpressions must contain at least one period formula",
  });

const TransformationBaseSchema = z.object({
    id: IdSchema,
    outputMetricId: IdSchema,
    sourceExpressions: SourceExpressionsSchema,
});

export const TransformationSchema = z.discriminatedUnion("status", [
  TransformationBaseSchema.extend({
    status: z.literal("supported"),
    expression: z.string().min(1),
  }).strict(),
  TransformationBaseSchema.extend({
    status: z.literal("opaque"),
  }).strict(),
  TransformationBaseSchema.extend({
    status: z.literal("unresolved"),
  }).strict(),
]);

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
    id: IdSchema.optional(),
    title: z.string().min(1).optional(),
    modelId: IdSchema,
    sourceArtifactId: IdSchema.optional(),
    sourceLocator: SourceLocatorSchema.optional(),
    sections: z.array(TableSectionSchema).min(1),
  })
  .strict();

export const ProvenanceRecordSchema = z
  .object({
    targetId: IdSchema,
    contextId: IdSchema,
    locator: SourceLocatorSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    reviewStatus: z.enum([
      "unreviewed",
      "confirmed",
      "corrected",
      "rejected",
    ]).optional(),
  })
  .strict();

export const ProvenanceContextSchema = z
  .object({
    id: IdSchema,
    sourceArtifactId: IdSchema,
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
      "source_error",
      "source_update",
      "model_inconsistency",
      "other",
    ]),
    description: z.string().min(1),
    currentTreatment: z.string().min(1),
    impact: z.string().min(1),
    nextAction: z.string().min(1),
    targetId: IdSchema.optional(),
    affectedTargetIds: z.array(IdSchema).min(1).optional(),
    sourceArtifactId: IdSchema.optional(),
    locator: SourceLocatorSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    attentionLevel: z.enum(["needs_review", "action_required"]),
    actionOwner: z.enum(["extraction_agent", "model_owner", "source_owner"]).optional(),
    status: z.enum(["open", "resolved", "dismissed"]),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.attentionLevel === "action_required" && !item.actionOwner) {
      context.addIssue({
        code: "custom",
        path: ["actionOwner"],
        message: "Action-required items must assign extraction_agent, model_owner, or source_owner",
      });
    }
  });

export const ModelDatabaseSchema = z
  .object({
    schemaVersion: z.literal("0.2.0"),
    dataset: DatasetMetadataSchema,
    models: z.array(ModelSchema).min(1),
    entities: z.array(EntitySchema).min(1),
    metrics: z.array(MetricSchema).min(1),
    periods: z.array(PeriodSchema).min(1),
    scenarios: z.array(ScenarioSchema),
    observationSeries: z.array(ObservationSeriesSchema),
    transformations: z.array(TransformationSchema),
    relationships: z.array(RelationshipSchema),
    sourceArtifacts: z.array(SourceArtifactSchema).min(1),
    provenanceContexts: z.array(ProvenanceContextSchema).min(1),
    provenanceRecords: z.array(ProvenanceRecordSchema),
    evidence: z.array(EvidenceSchema),
    assumptions: z.array(AssumptionSchema),
    decisions: z.array(DecisionSchema),
    decisionChanges: z.array(DecisionChangeSchema),
    extractionRuns: z.array(ExtractionRunSchema).min(1),
    unresolvedItems: z.array(UnresolvedItemSchema),
    tablePresentations: z.array(TablePresentationSchema),
  })
  .strict()
  .describe(
    "Deduplicated semantic financial-model database with point-preserving observation series, reusable transformation rules, shared provenance contexts, and optional non-canonical table grouping metadata.",
  );

export const ModelDatabaseJsonSchema = z.toJSONSchema(ModelDatabaseSchema, {
  target: "draft-2020-12",
  reused: "ref",
});
