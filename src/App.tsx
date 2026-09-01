import { type ChangeEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AttentionCenter } from "./components/AttentionCenter";
import { Icon } from "./components/Icon";
import { ObjectDetailPanel } from "./components/ObjectDetailPanel";
import { defaultDatabase } from "./data/database";
import {
  confirmReviewItem,
  editObservationValue,
  type ObservationEditResult,
} from "./model-db/calculation";
import { modelDatabaseGzip, readModelDatabaseFile } from "./model-db/import";
import { observations } from "./model-db/access";
import {
  ModelDatabaseQueries,
  type AttentionItemProjection,
} from "./model-db/queries";
import type { ModelDatabase, Period, ScalarValue } from "./model-db/types";
import type { ValidationError } from "./model-db/validate";
import { FinancialTable } from "./visualizations/financial-table/FinancialTable";

type Theme = "light" | "dark";

type InspectorLocation = {
  targetId: string;
  modelId: string;
  presentationId?: string;
  entityId: string;
  periodType?: Period["type"];
};

const MAX_JSON_BYTES = 100 * 1024 * 1024;

type DatasetSource =
  | { kind: "bundled" }
  | { kind: "file"; filename: string };

type ImportNotice = {
  kind: "success" | "review" | "action" | "error";
  title: string;
  message: string;
  errors?: ValidationError[];
};

function defaultModelId(database: ModelDatabase): string {
  return database.dataset.defaultModelId ?? database.models[0].id;
}

function initialPresentationId(database: ModelDatabase, modelId: string): string | undefined {
  return database.tablePresentations.find((item) => item.modelId === modelId)?.id;
}

function initialEntityId(database: ModelDatabase, modelId: string): string {
  return database.models.find((item) => item.id === modelId)?.primaryEntityId
    ?? database.entities[0].id;
}

function initialPeriodType(
  database: ModelDatabase,
  modelId: string,
  presentationId?: string,
  entityId?: string,
): Period["type"] | undefined {
  const queries = new ModelDatabaseQueries(database);
  const periodTypes = queries.getPeriodTypes(modelId, presentationId, entityId);
  const configured = queries.getModel(modelId).attributes?.defaultPeriodType;
  return typeof configured === "string" && periodTypes.includes(configured as Period["type"])
    ? configured as Period["type"]
    : periodTypes[0];
}

function periodTypeLabel(type: Period["type"]): string {
  return type.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem("ledgerglass-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable in hardened browser contexts; system preference still works.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function attentionSummary(items: Array<{
  attentionLevel: "needs_review" | "action_required";
  actionOwner?: "extraction_agent" | "model_owner" | "source_owner";
}>): string {
  const actionsFromYou = items.filter(
    (item) => item.attentionLevel === "action_required"
      && item.actionOwner !== "extraction_agent",
  ).length;
  const toolingIssues = items.filter(
    (item) => item.attentionLevel === "action_required"
      && item.actionOwner === "extraction_agent",
  ).length;
  const needsReview = items.filter(
    (item) => item.attentionLevel === "needs_review",
  ).length;
  return [
    actionsFromYou > 0
      ? `${actionsFromYou} action${actionsFromYou === 1 ? "" : "s"} from you`
      : null,
    toolingIssues > 0
      ? `${toolingIssues} tooling issue${toolingIssues === 1 ? "" : "s"}`
      : null,
    needsReview > 0
      ? `${needsReview} item${needsReview === 1 ? "" : "s"} to review`
      : null,
  ].filter(Boolean).join(" · ");
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [database, setDatabase] = useState(defaultDatabase);
  const [datasetSource, setDatasetSource] = useState<DatasetSource>({ kind: "bundled" });
  const [draftTransactions, setDraftTransactions] = useState(0);
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelId(defaultDatabase));
  const [selectedPresentationId, setSelectedPresentationId] = useState<string | undefined>(() =>
    initialPresentationId(defaultDatabase, defaultModelId(defaultDatabase)),
  );
  const [selectedEntityId, setSelectedEntityId] = useState(() =>
    initialEntityId(defaultDatabase, defaultModelId(defaultDatabase)),
  );
  const [selectedPeriodType, setSelectedPeriodType] = useState<Period["type"] | undefined>(() =>
    initialPeriodType(
      defaultDatabase,
      defaultModelId(defaultDatabase),
      initialPresentationId(defaultDatabase, defaultModelId(defaultDatabase)),
      initialEntityId(defaultDatabase, defaultModelId(defaultDatabase)),
    ),
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [inspectorHistory, setInspectorHistory] = useState<InspectorLocation[]>([]);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionFocus, setAttentionFocus] = useState<{
    metricId: string;
    periodId?: string;
    attentionLevel: "needs_review" | "action_required";
  } | null>(null);
  const queries = useMemo(() => new ModelDatabaseQueries(database), [database]);
  const models = queries.getModels();
  const attentionItems = useMemo(() => queries.getAttentionItems(), [queries]);
  const presentations = queries.getTablePresentations(selectedModelId);
  const entities = queries.getEntities(selectedModelId);
  const periodTypes = queries.getPeriodTypes(
    selectedModelId,
    selectedPresentationId,
    selectedEntityId,
  );
  const table = useMemo(
    () =>
      queries.getFinancialTable({
        modelId: selectedModelId,
        entityId: selectedEntityId,
        scenarioId: queries.getModel(selectedModelId).defaultScenarioId,
        periodType: selectedPeriodType,
        presentationId: selectedPresentationId,
      }),
    [queries, selectedEntityId, selectedModelId, selectedPeriodType, selectedPresentationId],
  );
  const actionRequiredCount = attentionItems.filter(
    (item) => item.item.attentionLevel === "action_required",
  ).length;
  const observationList = useMemo(() => observations(database), [database]);
  const selectedLineageInputIds = useMemo(() => {
    if (!selectedTargetId) return new Set<string>();
    const observation = observationList.find(
      (candidate) => candidate.id === selectedTargetId,
    );
    if (!observation) return new Set<string>();
    return new Set(
      queries.getObservationDetail(observation.id).inputs.flatMap(
        (input) => input.observation ? [input.observation.id] : [],
      ),
    );
  }, [observationList, queries, selectedTargetId]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem("ledgerglass-theme", theme);
    } catch {
      // The active theme remains valid for this tab when storage is unavailable.
    }
  }, [theme]);

  const changeModel = (modelId: string) => {
    const presentationId = initialPresentationId(database, modelId);
    const entityId = initialEntityId(database, modelId);
    setSelectedModelId(modelId);
    setSelectedPresentationId(presentationId);
    setSelectedEntityId(entityId);
    setSelectedPeriodType(initialPeriodType(database, modelId, presentationId, entityId));
    setSelectedTargetId(null);
    setInspectorHistory([]);
    setAttentionFocus(null);
  };

  const rememberCurrentInspector = (nextTargetId: string) => {
    if (!selectedTargetId || selectedTargetId === nextTargetId) return;
    const current: InspectorLocation = {
      targetId: selectedTargetId,
      modelId: selectedModelId,
      presentationId: selectedPresentationId,
      entityId: selectedEntityId,
      periodType: selectedPeriodType,
    };
    setInspectorHistory((history) => {
      const withoutDuplicateTail = history.at(-1)?.targetId === current.targetId
        ? history.slice(0, -1)
        : history;
      return [...withoutDuplicateTail, current].slice(-24);
    });
  };

  const selectObservation = (observationId: string) => {
    rememberCurrentInspector(observationId);
    setAttentionFocus(null);
    setSelectedTargetId(observationId);
  };

  const navigateToObservation = (observationId: string) => {
    const target = queries.getObservationNavigationTarget(
      observationId,
      selectedPresentationId,
    );
    rememberCurrentInspector(observationId);
    setSelectedModelId(target.model.id);
    setSelectedPresentationId(target.presentation?.id);
    setSelectedEntityId(target.entity.id);
    setSelectedPeriodType(target.period.type);
    setAttentionFocus(null);
    setSelectedTargetId(observationId);
  };

  const selectMetric = (metricId: string) => {
    rememberCurrentInspector(metricId);
    setAttentionFocus(null);
    setSelectedTargetId(metricId);
  };

  const navigateBack = () => {
    const previous = inspectorHistory.at(-1);
    if (!previous) return;
    setInspectorHistory((history) => history.slice(0, -1));
    setSelectedModelId(previous.modelId);
    setSelectedPresentationId(previous.presentationId);
    setSelectedEntityId(previous.entityId);
    setSelectedPeriodType(previous.periodType);
    setAttentionFocus(null);
    setSelectedTargetId(previous.targetId);
  };

  const closeInspector = () => {
    setSelectedTargetId(null);
    setInspectorHistory([]);
    setAttentionFocus(null);
  };

  const navigateToAttention = (projection: AttentionItemProjection) => {
    setInspectorHistory([]);
    if (projection.model) {
      const targetObservation = projection.item.targetId
        ? observationList.find((item) => item.id === projection.item.targetId)
        : undefined;
      const entityId = targetObservation?.entityId ?? projection.model.primaryEntityId;
      const presentationId = projection.metric
        ? database.tablePresentations.find(
            (presentation) => presentation.modelId === projection.model?.id
              && presentation.sections.some(
                (section) => section.metricIds.includes(projection.metric!.id),
              ),
          )?.id
        : initialPresentationId(database, projection.model.id);
      setSelectedModelId(projection.model.id);
      setSelectedPresentationId(presentationId);
      setSelectedEntityId(entityId);
      setSelectedPeriodType(
        projection.period?.type
          ?? initialPeriodType(database, projection.model.id, presentationId, entityId),
      );
    }
    setSelectedTargetId(projection.item.id);
    setAttentionFocus(projection.metric ? {
      metricId: projection.metric.id,
      periodId: projection.period?.id,
      attentionLevel: projection.item.attentionLevel,
    } : null);
    setAttentionOpen(false);
  };

  const activateDatabase = (
    nextDatabase: ModelDatabase,
    source: DatasetSource,
  ) => {
    const nextModelId = defaultModelId(nextDatabase);
    const nextPresentationId = initialPresentationId(nextDatabase, nextModelId);
    const nextEntityId = initialEntityId(nextDatabase, nextModelId);
    setDatabase(nextDatabase);
    setDatasetSource(source);
    setDraftTransactions(0);
    setSelectedModelId(nextModelId);
    setSelectedPresentationId(nextPresentationId);
    setSelectedEntityId(nextEntityId);
    setSelectedPeriodType(initialPeriodType(
      nextDatabase,
      nextModelId,
      nextPresentationId,
      nextEntityId,
    ));
    setSelectedTargetId(null);
    setInspectorHistory([]);
    setAttentionFocus(null);
    setAttentionOpen(false);
  };

  const handleDatabaseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_JSON_BYTES) {
      setImportNotice({
        kind: "error",
        title: "File is too large",
        message: "Choose a model database JSON or JSON.GZ file smaller than 100 MB.",
      });
      input.value = "";
      return;
    }

    try {
      const result = await readModelDatabaseFile(file, MAX_JSON_BYTES);
      if (!result.success) {
        setImportNotice({
          kind: "error",
          title: result.kind === "json" ? "Could not read this JSON" : "Dataset did not validate",
          message: result.message,
          errors: result.errors,
        });
        return;
      }

      activateDatabase(
        result.data,
        { kind: "file", filename: file.name },
      );
      const importedAttention = new ModelDatabaseQueries(result.data)
        .getAttentionItems()
        .map(({ item }) => item);
      setImportNotice({
        kind: result.stats.actionRequired > 0
          ? "action"
          : result.warnings.length > 0
            ? "review"
            : "success",
        title: result.warnings.length > 0
          ? `Loaded ${file.name} · ${attentionSummary(importedAttention)}`
          : `Loaded ${file.name}`,
        message: result.stats.actionRequired > 0
          ? `${result.stats.models} model${result.stats.models === 1 ? "" : "s"}, ${result.stats.metrics} metrics, and ${result.stats.observations} observations validated locally. The model is available, but action items need a source or extraction change before they can be cleared.`
          : result.warnings.length > 0
            ? `${result.stats.models} model${result.stats.models === 1 ? "" : "s"}, ${result.stats.metrics} metrics, and ${result.stats.observations} observations validated locally. Confirm a review only when its stated interpretation matches the source.`
            : `${result.stats.models} model${result.stats.models === 1 ? "" : "s"}, ${result.stats.metrics} metrics, and ${result.stats.observations} observations validated locally. The file stays in this browser tab.`,
      });
    } catch (cause) {
      setImportNotice({
        kind: "error",
        title: "Could not open this file",
        message: cause instanceof Error ? cause.message : "The browser could not read the selected file.",
      });
    } finally {
      input.value = "";
    }
  };

  const restoreBundledDatabase = () => {
    activateDatabase(defaultDatabase, { kind: "bundled" });
    setImportNotice({
      kind: "success",
      title: "Bundled dataset restored",
      message: "You are previewing the dataset compiled into this viewer.",
    });
  };

  const updateObservationValue = (
    observationId: string,
    value: ScalarValue,
  ): ObservationEditResult => {
    const result = editObservationValue(database, observationId, value);
    setDatabase(result.database);
    setDraftTransactions((count) => count + 1);
    return result;
  };

  const confirmReview = (itemId: string) => {
    setDatabase(confirmReviewItem(database, itemId));
    setDraftTransactions((count) => count + 1);
    if (selectedTargetId === itemId) {
      setSelectedTargetId(null);
      setInspectorHistory([]);
      setAttentionFocus(null);
    }
  };

  const exportDraft = async () => {
    const sourceName = datasetSource.kind === "file"
      ? datasetSource.filename.replace(/\.json(?:\.gz)?$/i, "")
      : "model-db";
    const blob = await modelDatabaseGzip(database);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sourceName}.edited.json.gz`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <header className="viewer-header">
        <div className="product-lockup">
          <span className="product-monogram">LG</span>
          <span>
            <strong>Ledgerglass</strong>
            <small>Financial model inspection</small>
          </span>
        </div>

        <label className="model-switcher">
          <span>Model</span>
          <select
            aria-label="Active model"
            value={selectedModelId}
            onChange={(event) => changeModel(event.target.value)}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        </label>

        <div className="header-actions">
          {attentionItems.length > 0 ? (
            <button
              className={`validation-status attention-trigger has-warning ${actionRequiredCount > 0 ? "has-action" : "has-review"}`}
              onClick={() => setAttentionOpen(true)}
              aria-expanded={attentionOpen}
              aria-controls="attention-center-title"
              data-testid="attention-trigger"
            >
              <Icon name="warning" size={14} />
              {attentionSummary(attentionItems.map((item) => item.item))}
              <Icon name="arrow" size={12} />
            </button>
          ) : (
            <span className="validation-status">
              <Icon name="check" size={14} /> Accepted · validated locally
            </span>
          )}
          <button
            className="theme-toggle"
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            <Icon name="theme" size={15} />
            <span>{theme === "light" ? "Dark" : "Light"}</span>
          </button>
          {draftTransactions > 0 && (
            <button
              className="draft-export-button"
              onClick={exportDraft}
              title="Download the validated local working copy"
            >
              <Icon name="download" size={14} />
              Export draft <span>{draftTransactions}</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            className="json-file-input"
            data-testid="json-file-input"
            type="file"
            accept="application/json,application/gzip,.json,.json.gz"
            onChange={handleDatabaseFile}
          />
          <button
            className="upload-button"
            onClick={() => fileInputRef.current?.click()}
            title="Open a model-db JSON file locally in this browser"
          >
            <Icon name="upload" size={15} /> Open JSON
          </button>
          {datasetSource.kind === "file" && (
            <button className="text-button" onClick={restoreBundledDatabase}>Restore bundled</button>
          )}
        </div>
      </header>

      <AttentionCenter
        items={attentionItems}
        open={attentionOpen}
        onClose={() => setAttentionOpen(false)}
        onNavigate={navigateToAttention}
      />

      {importNotice && (
        <section
          className={`import-notice import-notice--${importNotice.kind}`}
          data-testid="import-notice"
          role={importNotice.kind === "error" ? "alert" : "status"}
        >
          <Icon name={importNotice.kind === "success" ? "check" : "warning"} size={17} />
          <div>
            <strong>{importNotice.title}</strong>
            <p>{importNotice.message}</p>
            {importNotice.errors && importNotice.errors.length > 0 && (
              <ul>
                {importNotice.errors.slice(0, 3).map((item, index) => (
                  <li key={`${item.code}-${item.objectId}-${item.field}-${index}`}>
                    <code>{item.objectId}.{item.field}</code>: {item.reason}
                  </li>
                ))}
                {importNotice.errors.length > 3 && (
                  <li>Plus {importNotice.errors.length - 3} more issues. Run <code>npm run validate</code> for the complete report.</li>
                )}
              </ul>
            )}
          </div>
          <div className="import-notice-actions">
            {(importNotice.kind === "action" || importNotice.kind === "review") && (
              <button className="import-review-button" onClick={() => setAttentionOpen(true)}>
                Review attention <Icon name="arrow" size={13} />
              </button>
            )}
            <button className="icon-button" aria-label="Dismiss import message" onClick={() => setImportNotice(null)}>
              <Icon name="close" size={15} />
            </button>
          </div>
        </section>
      )}

      <section className="model-toolbar">
        <div className="model-heading">
          <span className="dataset-breadcrumb">{database.dataset.name}</span>
          <h1>{table.entity.name}</h1>
          <p>{table.model.name} · {table.model.baseCurrency} · as of {table.model.asOf}</p>
        </div>
        <div className="model-toolbar-controls">
          {presentations.length > 1 && (
            <label className="period-switcher">
              <span>Worksheet</span>
              <select
                aria-label="Worksheet view"
                value={selectedPresentationId}
                onChange={(event) => {
                  const presentationId = event.target.value;
                  setSelectedPresentationId(presentationId);
                  setSelectedPeriodType(initialPeriodType(
                    database,
                    selectedModelId,
                    presentationId,
                    selectedEntityId,
                  ));
                  setSelectedTargetId(null);
                  setInspectorHistory([]);
                  setAttentionFocus(null);
                }}
              >
                {presentations.map((presentation, index) => (
                  <option key={presentation.id ?? index} value={presentation.id}>
                    {presentation.title ?? `Worksheet ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {entities.length > 1 && (
            <label className="period-switcher">
              <span>Entity</span>
              <select
                aria-label="Entity view"
                value={selectedEntityId}
                onChange={(event) => {
                  const entityId = event.target.value;
                  setSelectedEntityId(entityId);
                  setSelectedPeriodType(initialPeriodType(
                    database,
                    selectedModelId,
                    selectedPresentationId,
                    entityId,
                  ));
                  setSelectedTargetId(null);
                  setInspectorHistory([]);
                  setAttentionFocus(null);
                }}
              >
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>{entity.name}</option>
                ))}
              </select>
            </label>
          )}
          {periodTypes.length > 1 && selectedPeriodType && (
            <label className="period-switcher">
              <span>Period view</span>
              <select
                aria-label="Period view"
                value={selectedPeriodType}
                onChange={(event) => {
                  setSelectedPeriodType(event.target.value as Period["type"]);
                  setSelectedTargetId(null);
                  setInspectorHistory([]);
                  setAttentionFocus(null);
                }}
              >
                {periodTypes.map((type) => (
                  <option key={type} value={type}>{periodTypeLabel(type)}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      <div className="viewer-layout">
        <main className="model-canvas">
          <FinancialTable
            projection={table}
            selectedTargetId={selectedTargetId}
            lineageInputIds={selectedLineageInputIds}
            attentionFocus={attentionFocus}
            onSelectMetric={selectMetric}
            onSelectObservation={selectObservation}
          />
        </main>

        <ObjectDetailPanel
          targetId={selectedTargetId}
          queries={queries}
          onClose={closeInspector}
          canNavigateBack={inspectorHistory.length > 0}
          onNavigateBack={navigateBack}
          onSelectTarget={navigateToObservation}
          onUpdateObservation={updateObservationValue}
          onConfirmReview={confirmReview}
        />
      </div>
    </div>
  );
}
