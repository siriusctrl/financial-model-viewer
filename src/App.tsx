import { useMemo, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { ObjectDetailPanel } from "./components/ObjectDetailPanel";
import { database, queries } from "./data/database";
import { DependencyGraph } from "./visualizations/dependency-graph/DependencyGraph";
import { FinancialTable } from "./visualizations/financial-table/FinancialTable";
import { ModelOverview } from "./visualizations/model-overview/ModelOverview";

type View = "overview" | "table" | "graph";

const views: Array<{ id: View; label: string; description: string; icon: IconName }> = [
  { id: "overview", label: "Model overview", description: "Coverage & integrity", icon: "overview" },
  { id: "table", label: "Financial table", description: "Metric × period", icon: "table" },
  { id: "graph", label: "Dependency graph", description: "Formula lineage", icon: "graph" },
];

function initialGraphMetric(modelId: string): string {
  const metricIds = new Set(
    database.observations
      .filter((observation) => observation.modelId === modelId)
      .map((observation) => observation.metricId),
  );
  return (
    database.transformations.find((item) => metricIds.has(item.outputMetricId))
      ?.outputMetricId ?? [...metricIds][0]
  );
}

export default function App() {
  const models = queries.getModels();
  const defaultModelId = database.dataset.defaultModelId ?? models[0].id;
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const [view, setView] = useState<View>("overview");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [graphMetricId, setGraphMetricId] = useState(() => initialGraphMetric(defaultModelId));

  const overview = useMemo(
    () => queries.getModelOverview(selectedModelId),
    [selectedModelId],
  );
  const hierarchy = useMemo(
    () => queries.getMetricHierarchy({ modelId: selectedModelId }),
    [selectedModelId],
  );
  const table = useMemo(
    () =>
      queries.getFinancialTable({
        modelId: selectedModelId,
        scenarioId: queries.getModel(selectedModelId).defaultScenarioId,
      }),
    [selectedModelId],
  );
  const availableMetrics = useMemo(
    () => table.rows.map((row) => row.metric),
    [table.rows],
  );
  const graph = useMemo(
    () => queries.getDependencies({ metricId: graphMetricId, direction: "both" }),
    [graphMetricId],
  );

  const changeModel = (modelId: string) => {
    setSelectedModelId(modelId);
    setGraphMetricId(initialGraphMetric(modelId));
    setSelectedTargetId(null);
    setView("overview");
  };

  const focusGraph = (metricId: string) => {
    setGraphMetricId(metricId);
    setView("graph");
    setSelectedTargetId(null);
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
          <p>model-db@{database.schemaVersion}</p>
          <div className="status-line"><span>Schema</span><strong>Runtime-derived</strong></div>
          <div className="status-line"><span>Lineage</span><strong>{database.provenanceRecords.length} records</strong></div>
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
            <span className="validated-badge"><Icon name="check" size={14} /> Deterministic pass</span>
            <button className="schema-button" onClick={() => setSelectedTargetId(selectedModelId)}>
              Inspect model <Icon name="arrow" size={14} />
            </button>
          </div>
        </header>

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
          {view === "graph" && (
            <DependencyGraph
              projection={graph}
              availableMetrics={availableMetrics}
              onFocusMetric={setGraphMetricId}
              onSelectMetric={setSelectedTargetId}
              onSelectTransformation={setSelectedTargetId}
            />
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
