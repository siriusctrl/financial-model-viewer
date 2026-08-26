import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { ObjectDetailPanel } from "./components/ObjectDetailPanel";
import { defaultDatabase } from "./data/database";
import { parseModelDatabaseJson } from "./model-db/import";
import { ModelDatabaseQueries } from "./model-db/queries";
import type { ModelDatabase } from "./model-db/types";
import type { ValidationError } from "./model-db/validate";
import { DependencyGraph } from "./visualizations/dependency-graph/DependencyGraph";
import { FinancialTable } from "./visualizations/financial-table/FinancialTable";
import { ModelOverview } from "./visualizations/model-overview/ModelOverview";

type View = "overview" | "table" | "graph";

const views: Array<{ id: View; label: string; description: string; icon: IconName }> = [
  { id: "overview", label: "Model overview", description: "Coverage & integrity", icon: "overview" },
  { id: "table", label: "Financial table", description: "Metric × period", icon: "table" },
  { id: "graph", label: "Dependency graph", description: "Formula lineage", icon: "graph" },
];

const MAX_JSON_BYTES = 20 * 1024 * 1024;

type DatasetSource =
  | { kind: "sample" }
  | { kind: "file"; filename: string };

type ImportNotice = {
  kind: "success" | "error";
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
  const [datasetSource, setDatasetSource] = useState<DatasetSource>({ kind: "sample" });
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const queries = useMemo(() => new ModelDatabaseQueries(database), [database]);
  const models = queries.getModels();
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelId(defaultDatabase));
  const [view, setView] = useState<View>("overview");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [graphMetricId, setGraphMetricId] = useState<string | null>(() =>
    initialGraphMetric(defaultDatabase, defaultModelId(defaultDatabase)),
  );

  const overview = useMemo(
    () => queries.getModelOverview(selectedModelId),
    [queries, selectedModelId],
  );
  const hierarchy = useMemo(
    () => queries.getMetricHierarchy({ modelId: selectedModelId }),
    [queries, selectedModelId],
  );
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
    setView("overview");
  };

  const focusGraph = (metricId: string) => {
    setGraphMetricId(metricId);
    setView("graph");
    setSelectedTargetId(null);
  };

  const activateDatabase = (nextDatabase: ModelDatabase, source: DatasetSource) => {
    const nextModelId = defaultModelId(nextDatabase);
    setDatabase(nextDatabase);
    setDatasetSource(source);
    setSelectedModelId(nextModelId);
    setGraphMetricId(initialGraphMetric(nextDatabase, nextModelId));
    setSelectedTargetId(null);
    setView("overview");
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

      activateDatabase(result.data, { kind: "file", filename: file.name });
      setImportNotice({
        kind: "success",
        title: `Previewing ${file.name}`,
        message: `${result.stats.models} model${result.stats.models === 1 ? "" : "s"}, ${result.stats.metrics} metrics, and ${result.stats.observations} observations validated locally. The file stays in this browser tab.`,
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

  const restoreSample = () => {
    activateDatabase(defaultDatabase, { kind: "sample" });
    setImportNotice({
      kind: "success",
      title: "Sample dataset restored",
      message: "You are previewing the bundled cross-sector demonstration dataset.",
    });
  };

  return (
    <div className="app-shell">
      <aside className="navigation-rail">
        <div className="brand-lockup">
          <span className="brand-mark"><Icon name="database" size={20} /></span>
          <span>
            <strong>Ledgerglass</strong>
            <small>Semantic model viewer</small>
          </span>
        </div>

        <label className="model-switcher">
          <span>Active model</span>
          <select
            aria-label="Active model"
            value={selectedModelId}
            onChange={(event) => changeModel(event.target.value)}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
          <small>{overview.entity.name} · {overview.model.baseCurrency}</small>
        </label>

        <nav className="primary-nav" aria-label="Model visualizations">
          <span className="nav-label">Workspace</span>
          {views.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} size={18} />
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </nav>

        <div className="rail-status">
          <div className="status-heading">
            <span className="status-pulse" />
            <strong>Dataset validated</strong>
          </div>
          <p>model-db@{database.schemaVersion} · {datasetSource.kind === "file" ? "local" : "sample"}</p>
          <div className="status-line"><span>Schema</span><strong>Runtime-derived</strong></div>
          <div className="status-line"><span>Lineage</span><strong>{database.provenanceRecords.length} records</strong></div>
          <div className="status-line"><span>Source</span><strong>{datasetSource.kind === "file" ? "Browser only" : "Bundled"}</strong></div>
          {datasetSource.kind === "file" && (
            <button className="restore-sample-button" onClick={restoreSample}>Restore sample</button>
          )}
        </div>
      </aside>

      <main className="main-workspace">
        <header className="workspace-topbar">
          <div className="dataset-breadcrumb">
            <span>{database.dataset.name}</span>
            <i>/</i>
            <strong>{views.find((item) => item.id === view)?.label}</strong>
          </div>
          <div className="topbar-meta">
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
              <Icon name="upload" size={14} /> Open JSON
            </button>
            <span className="validated-badge"><Icon name="check" size={14} /> Deterministic pass</span>
            <button className="schema-button" onClick={() => setSelectedTargetId(selectedModelId)}>
              Inspect model <Icon name="arrow" size={14} />
            </button>
          </div>
        </header>

        {importNotice && (
          <section
            className={`import-notice import-notice--${importNotice.kind}`}
            data-testid="import-notice"
            role={importNotice.kind === "error" ? "alert" : "status"}
          >
            <Icon name={importNotice.kind === "error" ? "warning" : "check"} size={18} />
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

        <div className="workspace-content">
          {view === "overview" && (
            <ModelOverview
              overview={overview}
              hierarchy={hierarchy}
              onSelect={setSelectedTargetId}
              onNavigate={setView}
            />
          )}
          {view === "table" && (
            <FinancialTable
              projection={table}
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
              <span className="eyebrow">No graph available</span>
              <h1>This model has no observed metrics yet.</h1>
              <p>Add observations and transformations to the model database, then open the JSON again.</p>
            </section>
          )}
        </div>
      </main>

      <ObjectDetailPanel
        targetId={selectedTargetId}
        queries={queries}
        onClose={() => setSelectedTargetId(null)}
        onFocusGraph={focusGraph}
      />
    </div>
  );
}
