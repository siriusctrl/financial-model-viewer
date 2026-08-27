import { type ChangeEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AttentionCenter } from "./components/AttentionCenter";
import { Icon } from "./components/Icon";
import { ObjectDetailPanel } from "./components/ObjectDetailPanel";
import { defaultDatabase } from "./data/database";
import {
  editObservationValue,
  setUnresolvedItemStatus,
  type ObservationEditResult,
} from "./model-db/calculation";
import { parseModelDatabaseJson } from "./model-db/import";
import {
  ModelDatabaseQueries,
  type AttentionItemProjection,
} from "./model-db/queries";
import type { ModelDatabase, Period, ScalarValue } from "./model-db/types";
import type { ValidationError } from "./model-db/validate";
import { DependencyGraph } from "./visualizations/dependency-graph/DependencyGraph";
import { FinancialTable } from "./visualizations/financial-table/FinancialTable";

type View = "table" | "graph";
type Theme = "light" | "dark";

const views: Array<{ id: View; label: string }> = [
  { id: "table", label: "Model table" },
  { id: "graph", label: "Lineage map" },
];

const MAX_JSON_BYTES = 20 * 1024 * 1024;

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

function initialGraphMetric(database: ModelDatabase, modelId: string): string | null {
  const metricIds = new Set(
    database.observations
      .filter((observation) => observation.modelId === modelId)
      .map((observation) => observation.metricId),
  );
  return (
    database.transformations.find((item) => metricIds.has(item.outputMetricId))
      ?.outputMetricId ?? [...metricIds][0] ?? null
  );
}

function initialPeriodType(database: ModelDatabase, modelId: string): Period["type"] | undefined {
  const queries = new ModelDatabaseQueries(database);
  const periodTypes = queries.getPeriodTypes(modelId);
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
    const saved = window.localStorage.getItem("financial-model-viewer-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable in hardened browser contexts; system preference still works.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function attentionSummary(items: Array<{ attentionLevel: "needs_review" | "action_required" }>): string {
  const actionRequired = items.filter(
    (item) => item.attentionLevel === "action_required",
  ).length;
  const needsReview = items.length - actionRequired;
  return [
    actionRequired > 0
      ? `${actionRequired} action${actionRequired === 1 ? "" : "s"} required`
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
  const [selectedPeriodType, setSelectedPeriodType] = useState<Period["type"] | undefined>(() =>
    initialPeriodType(defaultDatabase, defaultModelId(defaultDatabase)),
  );
  const [view, setView] = useState<View>("table");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionFocus, setAttentionFocus] = useState<{
    metricId: string;
    periodId?: string;
    attentionLevel: "needs_review" | "action_required";
  } | null>(null);
  const [graphMetricId, setGraphMetricId] = useState<string | null>(() =>
    initialGraphMetric(defaultDatabase, defaultModelId(defaultDatabase)),
  );

  const queries = useMemo(() => new ModelDatabaseQueries(database), [database]);
  const models = queries.getModels();
  const attentionItems = useMemo(() => queries.getAttentionItems(), [queries]);
  const periodTypes = queries.getPeriodTypes(selectedModelId);
  const table = useMemo(
    () =>
      queries.getFinancialTable({
        modelId: selectedModelId,
        scenarioId: queries.getModel(selectedModelId).defaultScenarioId,
        periodType: selectedPeriodType,
      }),
    [queries, selectedModelId, selectedPeriodType],
  );
  const availableMetrics = useMemo(
    () => table.rows.map((row) => row.metric),
    [table.rows],
  );
  const graph = useMemo(
    () => graphMetricId
      ? queries.getDependencies({ metricId: graphMetricId, direction: "both" })
      : null,
    [graphMetricId, queries],
  );
  const actionRequiredCount = attentionItems.filter(
    (item) => item.item.attentionLevel === "action_required",
  ).length;
  const selectedLineageInputIds = useMemo(() => {
    if (!selectedTargetId) return new Set<string>();
    const observation = database.observations.find(
      (candidate) => candidate.id === selectedTargetId,
    );
    if (!observation) return new Set<string>();
    return new Set(
      queries.getObservationDetail(observation.id).inputs.flatMap(
        (input) => input.observation ? [input.observation.id] : [],
      ),
    );
  }, [database.observations, queries, selectedTargetId]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem("financial-model-viewer-theme", theme);
    } catch {
      // The active theme remains valid for this tab when storage is unavailable.
    }
  }, [theme]);

  const changeModel = (modelId: string) => {
    setSelectedModelId(modelId);
    setSelectedPeriodType(initialPeriodType(database, modelId));
    setGraphMetricId(initialGraphMetric(database, modelId));
    setSelectedTargetId(null);
    setAttentionFocus(null);
    setView("table");
  };

  const focusGraph = (metricId: string) => {
    setGraphMetricId(metricId);
    setView("graph");
  };

  const selectObservation = (observationId: string) => {
    const observation = database.observations.find(
      (candidate) => candidate.id === observationId,
    );
    const period = observation
      ? database.periods.find((candidate) => candidate.id === observation.periodId)
      : undefined;
    if (period && period.type !== selectedPeriodType) {
      setSelectedPeriodType(period.type);
    }
    setAttentionFocus(null);
    setSelectedTargetId(observationId);
  };

  const selectMetric = (metricId: string) => {
    setAttentionFocus(null);
    setSelectedTargetId(metricId);
  };

  const closeInspector = () => {
    setSelectedTargetId(null);
    setAttentionFocus(null);
  };

  const navigateToAttention = (projection: AttentionItemProjection) => {
    if (projection.model) {
      const modelChanged = projection.model.id !== selectedModelId;
      setSelectedModelId(projection.model.id);
      setSelectedPeriodType(
        projection.period?.type
          ?? (modelChanged ? initialPeriodType(database, projection.model.id) : selectedPeriodType),
      );
      setGraphMetricId(initialGraphMetric(database, projection.model.id));
    }
    setView("table");
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
    setDatabase(nextDatabase);
    setDatasetSource(source);
    setDraftTransactions(0);
    setSelectedModelId(nextModelId);
    setSelectedPeriodType(initialPeriodType(nextDatabase, nextModelId));
    setGraphMetricId(initialGraphMetric(nextDatabase, nextModelId));
    setSelectedTargetId(null);
    setAttentionFocus(null);
    setAttentionOpen(false);
    setView("table");
  };

  const handleDatabaseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_JSON_BYTES) {
      setImportNotice({
        kind: "error",
        title: "File is too large",
        message: "Choose a model database JSON file smaller than 20 MB.",
      });
      input.value = "";
      return;
    }

    try {
      const result = parseModelDatabaseJson(await file.text());
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
      setImportNotice({
        kind: result.stats.actionRequired > 0
          ? "action"
          : result.warnings.length > 0
            ? "review"
            : "success",
        title: result.warnings.length > 0
          ? `Previewing ${file.name} · ${attentionSummary(result.warnings)}`
          : `Previewing ${file.name}`,
        message: `${result.stats.models} model${result.stats.models === 1 ? "" : "s"}, ${result.stats.metrics} metrics, and ${result.stats.observations} observations validated locally. The file stays in this browser tab.`,
        errors: result.warnings,
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

  const resolveAttentionItem = (
    itemId: string,
    status: "resolved" | "dismissed",
  ) => {
    setDatabase(setUnresolvedItemStatus(database, itemId, status));
    setDraftTransactions((count) => count + 1);
    if (selectedTargetId === itemId) {
      setSelectedTargetId(null);
      setAttentionFocus(null);
    }
  };

  const exportDraft = () => {
    const sourceName = datasetSource.kind === "file"
      ? datasetSource.filename.replace(/\.json$/i, "")
      : "model-db";
    const blob = new Blob([`${JSON.stringify(database, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sourceName}.edited.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <header className="viewer-header">
        <div className="product-lockup">
          <span className="product-monogram">FM</span>
          <span>
            <strong>Financial model viewer</strong>
            <small>Semantic database inspector</small>
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
            accept="application/json,.json"
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
          <button className="icon-button" aria-label="Dismiss import message" onClick={() => setImportNotice(null)}>
            <Icon name="close" size={15} />
          </button>
        </section>
      )}

      <section className="model-toolbar">
        <div className="model-heading">
          <span className="dataset-breadcrumb">{database.dataset.name}</span>
          <h1>{table.entity.name}</h1>
          <p>{table.model.name} · {table.model.baseCurrency} · as of {table.model.asOf}</p>
        </div>
        <div className="model-toolbar-controls">
          {periodTypes.length > 1 && selectedPeriodType && (
            <label className="period-switcher">
              <span>Period view</span>
              <select
                aria-label="Period view"
                value={selectedPeriodType}
                onChange={(event) => {
                  setSelectedPeriodType(event.target.value as Period["type"]);
                  setSelectedTargetId(null);
                  setAttentionFocus(null);
                }}
              >
                {periodTypes.map((type) => (
                  <option key={type} value={type}>{periodTypeLabel(type)}</option>
                ))}
              </select>
            </label>
          )}
          <nav className="view-tabs" aria-label="Viewer mode">
            {views.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </section>

      <div className="viewer-layout">
        <main className="model-canvas">
          {view === "table" && (
            <FinancialTable
              projection={table}
              selectedTargetId={selectedTargetId}
              lineageInputIds={selectedLineageInputIds}
              attentionFocus={attentionFocus}
              onSelectMetric={selectMetric}
              onSelectObservation={selectObservation}
            />
          )}
          {view === "graph" && graph && (
            <DependencyGraph
              projection={graph}
              availableMetrics={availableMetrics}
              onFocusMetric={setGraphMetricId}
              onSelectMetric={selectMetric}
              onSelectTransformation={(targetId) => {
                setAttentionFocus(null);
                setSelectedTargetId(targetId);
              }}
            />
          )}
          {view === "graph" && !graph && (
            <section className="empty-projection" data-testid="empty-dependency-graph">
              <Icon name="graph" size={24} />
              <h2>No dependency graph is available.</h2>
              <p>Add observations and transformations, then open the database again.</p>
            </section>
          )}
        </main>

        <ObjectDetailPanel
          targetId={selectedTargetId}
          queries={queries}
          onClose={closeInspector}
          onSelectTarget={selectObservation}
          onFocusGraph={focusGraph}
          onUpdateObservation={updateObservationValue}
          onResolveAttention={resolveAttentionItem}
        />
      </div>
    </div>
  );
}
