import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { Icon } from "./components/Icon";
import { ObjectDetailPanel } from "./components/ObjectDetailPanel";
import { defaultDatabase, defaultDatabaseWarnings } from "./data/database";
import { parseModelDatabaseJson } from "./model-db/import";
import { ModelDatabaseQueries } from "./model-db/queries";
import type { ModelDatabase } from "./model-db/types";
import type { ValidationError, ValidationWarning } from "./model-db/validate";
import { DependencyGraph } from "./visualizations/dependency-graph/DependencyGraph";
import { FinancialTable } from "./visualizations/financial-table/FinancialTable";

type View = "table" | "graph";

const views: Array<{ id: View; label: string }> = [
  { id: "table", label: "Model table" },
  { id: "graph", label: "Lineage map" },
];

const MAX_JSON_BYTES = 20 * 1024 * 1024;

type DatasetSource =
  | { kind: "bundled" }
  | { kind: "file"; filename: string };

type ImportNotice = {
  kind: "success" | "warning" | "error";
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

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [database, setDatabase] = useState(defaultDatabase);
  const [datasetSource, setDatasetSource] = useState<DatasetSource>({ kind: "bundled" });
  const [databaseWarnings, setDatabaseWarnings] = useState<ValidationWarning[]>(
    defaultDatabaseWarnings,
  );
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelId(defaultDatabase));
  const [view, setView] = useState<View>("table");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [graphMetricId, setGraphMetricId] = useState<string | null>(() =>
    initialGraphMetric(defaultDatabase, defaultModelId(defaultDatabase)),
  );

  const queries = useMemo(() => new ModelDatabaseQueries(database), [database]);
  const models = queries.getModels();
  const table = useMemo(
    () =>
      queries.getFinancialTable({
        modelId: selectedModelId,
        scenarioId: queries.getModel(selectedModelId).defaultScenarioId,
      }),
    [queries, selectedModelId],
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

  const changeModel = (modelId: string) => {
    setSelectedModelId(modelId);
    setGraphMetricId(initialGraphMetric(database, modelId));
    setSelectedTargetId(null);
    setView("table");
  };

  const focusGraph = (metricId: string) => {
    setGraphMetricId(metricId);
    setView("graph");
  };

  const activateDatabase = (
    nextDatabase: ModelDatabase,
    source: DatasetSource,
    warnings: ValidationWarning[] = [],
  ) => {
    const nextModelId = defaultModelId(nextDatabase);
    setDatabase(nextDatabase);
    setDatasetSource(source);
    setDatabaseWarnings(warnings);
    setSelectedModelId(nextModelId);
    setGraphMetricId(initialGraphMetric(nextDatabase, nextModelId));
    setSelectedTargetId(null);
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
        result.warnings,
      );
      setImportNotice({
        kind: result.warnings.length > 0 ? "warning" : "success",
        title: result.warnings.length > 0
          ? `Previewing ${file.name} with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
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
    activateDatabase(defaultDatabase, { kind: "bundled" }, defaultDatabaseWarnings);
    setImportNotice({
      kind: "success",
      title: "Bundled dataset restored",
      message: "You are previewing the dataset compiled into this viewer.",
    });
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
          <span className={`validation-status ${databaseWarnings.length > 0 ? "has-warning" : ""}`}>
            <Icon name={databaseWarnings.length > 0 ? "warning" : "check"} size={14} />
            {databaseWarnings.length > 0
              ? `${databaseWarnings.length} review warning${databaseWarnings.length === 1 ? "" : "s"}`
              : "Validated locally"}
          </span>
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

      {importNotice && (
        <section
          className={`import-notice import-notice--${importNotice.kind}`}
          data-testid="import-notice"
          role={importNotice.kind === "error" ? "alert" : "status"}
        >
          <Icon name={importNotice.kind === "error" ? "warning" : "check"} size={17} />
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
      </section>

      <div className="viewer-layout">
        <main className="model-canvas">
          {view === "table" && (
            <FinancialTable
              projection={table}
              selectedTargetId={selectedTargetId}
              onSelectMetric={setSelectedTargetId}
              onSelectObservation={setSelectedTargetId}
            />
          )}
          {view === "graph" && graph && (
            <DependencyGraph
              projection={graph}
              availableMetrics={availableMetrics}
              onFocusMetric={setGraphMetricId}
              onSelectMetric={setSelectedTargetId}
              onSelectTransformation={setSelectedTargetId}
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
          modelId={selectedModelId}
          queries={queries}
          onClose={() => setSelectedTargetId(null)}
          onSelectTarget={setSelectedTargetId}
          onFocusGraph={focusGraph}
        />
      </div>
    </div>
  );
}
