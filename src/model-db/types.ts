import type { z } from "zod";
import type {
  AssumptionSchema,
  DatasetMetadataSchema,
  DecisionChangeSchema,
  DecisionSchema,
  EntitySchema,
  EvidenceSchema,
  ExtractionRunSchema,
  MetricSchema,
  ModelDatabaseSchema,
  ModelSchema,
  ObservationSchema,
  PeriodSchema,
  ProvenanceRecordSchema,
  RelationshipSchema,
  ScenarioSchema,
  SourceArtifactSchema,
  SourceLocatorSchema,
  TablePresentationSchema,
  TableSectionSchema,
  TransformationSchema,
  UnresolvedItemSchema,
} from "./schema";

export type DatasetMetadata = z.infer<typeof DatasetMetadataSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type Period = z.infer<typeof PeriodSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Transformation = z.infer<typeof TransformationSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type SourceArtifact = z.infer<typeof SourceArtifactSchema>;
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;
export type TableSection = z.infer<typeof TableSectionSchema>;
export type TablePresentation = z.infer<typeof TablePresentationSchema>;
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionChange = z.infer<typeof DecisionChangeSchema>;
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;
export type UnresolvedItem = z.infer<typeof UnresolvedItemSchema>;
export type ModelDatabase = z.infer<typeof ModelDatabaseSchema>;

export type CanonicalObject =
  | Model
  | Entity
  | Metric
  | Period
  | Scenario
  | Observation
  | Transformation
  | Relationship
  | Evidence
  | Assumption
  | Decision
  | DecisionChange
  | UnresolvedItem;

export type ScalarValue = Observation["value"];
