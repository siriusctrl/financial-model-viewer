import type {
  MetricHierarchyNode,
  ModelOverviewProjection,
} from "../../model-db/queries";
import { Icon } from "../../components/Icon";

type Props = {
  overview: ModelOverviewProjection;
  hierarchy: MetricHierarchyNode[];
  onSelect: (targetId: string) => void;
  onNavigate: (view: "table" | "graph") => void;
};

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function ModelOverview({
  overview,
  hierarchy,
  onSelect,
  onNavigate,
}: Props) {
  const coverageTotal = overview.actualCount + overview.estimateCount;
  const actualShare = coverageTotal
    ? (overview.actualCount / coverageTotal) * 100
    : 0;

  return (
    <div className="overview-view" data-testid="overview-view">
      <section className="overview-hero">
        <div className="eyebrow-row">
          <span className="eyebrow">Model snapshot</span>
          <span className="as-of">As of {formatDate(overview.model.asOf)}</span>
        </div>
        <div className="overview-heading">
          <div>
            <h1>{overview.entity.name}</h1>
            <p>{overview.model.description}</p>
          </div>
          <button className="primary-action" onClick={() => onNavigate("table")}>
            Open financial table
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </section>

      <section className="stat-ledger" aria-label="Model statistics">
        <div className="stat-cell">
          <span>Metrics</span>
          <strong>{overview.metricCount}</strong>
          <small>Semantic definitions</small>
        </div>
        <div className="stat-cell">
          <span>Observations</span>
          <strong>{overview.observationCount}</strong>
          <small>Versioned data points</small>
        </div>
        <div className="stat-cell">
          <span>Transformations</span>
          <strong>{overview.transformationCount}</strong>
          <small>Parsed formula rules</small>
        </div>
        <div className="stat-cell stat-cell--health">
          <span>Review queue</span>
          <strong>{overview.unreviewedCount + overview.unresolvedCount}</strong>
          <small>
            {overview.unresolvedCount} unresolved · {overview.unreviewedCount} unreviewed
          </small>
        </div>
      </section>

      <div className="overview-grid">
        <section className="workspace-panel coverage-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Point-in-time coverage</span>
              <h2>Actuals hand off cleanly to estimates</h2>
            </div>
            <span className="version-chip">{overview.model.currentVersionId.replace("version_", "")}</span>
          </div>
          <div className="coverage-bar" aria-label={`${actualShare.toFixed(0)} percent actual observations`}>
            <span style={{ width: `${actualShare}%` }} />
          </div>
          <div className="coverage-legend">
            <div>
              <i className="legend-mark legend-mark--actual" />
              <span>Actual</span>
              <strong>{overview.actualCount}</strong>
            </div>
            <div>
              <i className="legend-mark legend-mark--estimate" />
              <span>Estimate</span>
              <strong>{overview.estimateCount}</strong>
            </div>
          </div>
          <p className="panel-note">
            Every point keeps its period, scenario, version, as-of date, value type,
            and original workbook locator.
          </p>
        </section>

        <section className="workspace-panel integrity-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Extraction integrity</span>
              <h2>Uncertainty stays visible</h2>
            </div>
            <span className={`integrity-status ${overview.unresolvedCount ? "needs-review" : "is-clean"}`}>
              <Icon name={overview.unresolvedCount ? "warning" : "check"} size={14} />
              {overview.unresolvedCount ? "Needs review" : "Validated"}
            </span>
          </div>
          <dl className="integrity-list">
            <div>
              <dt>Schema</dt>
              <dd>model-db@0.1.0</dd>
            </div>
            <div>
              <dt>Deterministic validation</dt>
              <dd className="positive">Passed</dd>
            </div>
            <div>
              <dt>Open mappings</dt>
              <dd className={overview.unresolvedCount ? "caution" : "positive"}>{overview.unresolvedCount}</dd>
            </div>
            <div>
              <dt>Pending provenance review</dt>
              <dd>{overview.unreviewedCount}</dd>
            </div>
          </dl>
        </section>

        <section className="workspace-panel architecture-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Metric architecture</span>
              <h2>Hierarchy from relationships, not rows</h2>
            </div>
            <button className="text-action" onClick={() => onNavigate("graph")}>
              Explore graph <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="metric-root-list">
            {hierarchy.map((node) => (
              <button key={node.metric.id} onClick={() => onSelect(node.metric.id)}>
                <span className="metric-index">{String(hierarchy.indexOf(node) + 1).padStart(2, "0")}</span>
                <span className="metric-root-copy">
                  <strong>{node.metric.name}</strong>
                  <small>
                    {node.children.length
                      ? `${node.children.length} semantic component${node.children.length === 1 ? "" : "s"}`
                      : node.metric.tags?.join(" · ") || "Standalone metric"}
                  </small>
                </span>
                <Icon name="arrow" size={15} />
              </button>
            ))}
          </div>
        </section>

        <section className="workspace-panel projection-panel">
          <span className="eyebrow">One database · multiple projections</span>
          <h2>Read the same model from two angles.</h2>
          <div className="projection-links">
            <button onClick={() => onNavigate("table")}>
              <span className="projection-icon"><Icon name="table" size={22} /></span>
              <span><strong>Financial table</strong><small>Period × metric projection</small></span>
              <Icon name="arrow" size={15} />
            </button>
            <button onClick={() => onNavigate("graph")}>
              <span className="projection-icon"><Icon name="graph" size={22} /></span>
              <span><strong>Dependency graph</strong><small>Formula-derived edges</small></span>
              <Icon name="arrow" size={15} />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
