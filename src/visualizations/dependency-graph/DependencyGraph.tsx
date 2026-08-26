import { useMemo } from "react";
import { Icon } from "../../components/Icon";
import type { DependencyGraphProjection } from "../../model-db/queries";
import type { Metric } from "../../model-db/types";

type Props = {
  projection: DependencyGraphProjection;
  availableMetrics: Metric[];
  onFocusMetric: (metricId: string) => void;
  onSelectMetric: (metricId: string) => void;
  onSelectTransformation: (transformationId: string) => void;
};

type PositionedNode = {
  metric: Metric;
  x: number;
  y: number;
  lane: "upstream" | "focus" | "downstream";
};

function reaches(
  start: string,
  target: string,
  edges: DependencyGraphProjection["edges"],
): boolean {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    queue.push(...edges.filter((edge) => edge.fromId === current).map((edge) => edge.toId));
  }
  return false;
}

const NODE_GAP = 88;
const MIN_CANVAS_HEIGHT = 460;

function distribute(
  nodes: Metric[],
  x: number,
  lane: PositionedNode["lane"],
  canvasHeight: number,
): PositionedNode[] {
  const start = canvasHeight / 2 - ((nodes.length - 1) * NODE_GAP) / 2;
  return nodes.map((metric, index) => ({
    metric,
    x,
    y: start + index * NODE_GAP,
    lane,
  }));
}

export function DependencyGraph({
  projection,
  availableMetrics,
  onFocusMetric,
  onSelectMetric,
  onSelectTransformation,
}: Props) {
  const graphLayout = useMemo(() => {
    const upstream: Metric[] = [];
    const downstream: Metric[] = [];
    for (const metric of projection.nodes) {
      if (metric.id === projection.focusMetric.id) continue;
      if (reaches(metric.id, projection.focusMetric.id, projection.edges)) upstream.push(metric);
      else downstream.push(metric);
    }
    const laneCount = Math.max(upstream.length, downstream.length, 1);
    const canvasHeight = Math.max(
      MIN_CANVAS_HEIGHT,
      100 + (laneCount - 1) * NODE_GAP,
    );
    return {
      canvasHeight,
      nodes: [
        ...distribute(upstream, 155, "upstream", canvasHeight),
        ...distribute([projection.focusMetric], 480, "focus", canvasHeight),
        ...distribute(downstream, 805, "downstream", canvasHeight),
      ],
    };
  }, [projection]);

  const positionedNodes = graphLayout.nodes;
  const positions = new Map(positionedNodes.map((node) => [node.metric.id, node]));

  return (
    <div className="graph-view" data-testid="dependency-graph-view">
      <header className="view-heading graph-heading">
        <div>
          <span className="eyebrow">Formula-derived projection</span>
          <h1>Metric dependency graph</h1>
          <p>
            Edges are generated from parsed transformation dependencies, never duplicated
            as hand-authored relationships.
          </p>
        </div>
        <label className="metric-picker">
          <span>Focus metric</span>
          <select
            value={projection.focusMetric.id}
            onChange={(event) => onFocusMetric(event.target.value)}
          >
            {availableMetrics.map((metric) => (
              <option key={metric.id} value={metric.id}>{metric.name}</option>
            ))}
          </select>
        </label>
      </header>

      <section className="graph-canvas-panel">
        <div className="graph-lane-labels" aria-hidden="true">
          <span>Upstream inputs</span>
          <span>Selected metric</span>
          <span>Downstream outputs</span>
        </div>
        <svg
          className="dependency-canvas"
          viewBox={`0 0 960 ${graphLayout.canvasHeight}`}
          role="img"
          aria-label={`Dependency graph for ${projection.focusMetric.name}`}
        >
          <defs>
            <marker id="edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className="arrow-head" />
            </marker>
          </defs>
          <line x1="318" x2="318" y1="28" y2={graphLayout.canvasHeight - 30} className="lane-divider" />
          <line x1="642" x2="642" y1="28" y2={graphLayout.canvasHeight - 30} className="lane-divider" />
          {projection.edges.map((edge) => {
            const from = positions.get(edge.fromId);
            const to = positions.get(edge.toId);
            if (!from || !to) return null;
            const startX = from.x + 104;
            const endX = to.x - 104;
            const midpoint = (startX + endX) / 2;
            return (
              <path
                key={`${edge.fromId}-${edge.toId}-${edge.transformationId}`}
                d={`M ${startX} ${from.y} C ${midpoint} ${from.y}, ${midpoint} ${to.y}, ${endX} ${to.y}`}
                className="dependency-edge"
                data-from={edge.fromId}
                data-to={edge.toId}
                markerEnd="url(#edge-arrow)"
              />
            );
          })}
          {positionedNodes.map((node) => (
            <g
              key={node.metric.id}
              className={`graph-node graph-node--${node.lane}`}
              transform={`translate(${node.x - 104} ${node.y - 31})`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectMetric(node.metric.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") onSelectMetric(node.metric.id);
              }}
            >
              <rect width="208" height="62" rx="8" />
              <circle cx="18" cy="17" r="4" />
              <text x="30" y="20" className="node-name">{node.metric.name}</text>
              <text x="18" y="43" className="node-meta">
                {node.metric.dataType} · {node.metric.unit ?? "unitless"}
              </text>
            </g>
          ))}
        </svg>
        {projection.edges.length === 0 && (
          <div className="graph-empty">
            <Icon name="graph" size={24} />
            <strong>No supported transformation edges</strong>
            <span>This metric may be a source input or an opaque calculation.</span>
          </div>
        )}
      </section>

      <section className="transformation-ledger">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">Transformation ledger</span>
            <h2>Canonical expressions in this view</h2>
          </div>
          <span>{projection.transformations.length} supported</span>
        </div>
        <div className="expression-list">
          {projection.transformations.map((transformation) => (
            <button
              key={transformation.id}
              data-transformation-id={transformation.id}
              onClick={() => onSelectTransformation(transformation.id)}
            >
              <span className="expression-status"><Icon name="check" size={14} /> supported</span>
              <span className="expression-copy">
                <strong>{transformation.outputMetricId.replace("metric_", "")}</strong>
                <code>{transformation.expression}</code>
              </span>
              <Icon name="arrow" size={15} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
