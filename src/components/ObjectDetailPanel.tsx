import { useEffect } from "react";
import { Icon } from "./Icon";
import type { ModelDatabaseQueries } from "../model-db/queries";
import type { Transformation } from "../model-db/types";

type Props = {
  targetId: string | null;
  queries: ModelDatabaseQueries;
  onClose: () => void;
  onFocusGraph: (metricId: string) => void;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function objectLabel(value: unknown, fallback: string): string {
  const record = objectRecord(value);
  return String(
    record.name ?? record.title ?? record.statement ?? record.description ?? fallback,
  );
}

function objectKind(id: string): string {
  const kind = id.split("_")[0];
  const labels: Record<string, string> = {
    metric: "Metric definition",
    obs: "Observation",
    transformation: "Transformation",
    relationship: "Semantic relationship",
    assumption: "Analyst assumption",
    evidence: "Evidence",
    decision: "Decision",
    change: "Decision change",
    unresolved: "Unresolved item",
    model: "Model",
    entity: "Entity",
    period: "Period",
  };
  return labels[kind] ?? "Canonical object";
}

function formatLocator(locator: Record<string, unknown> | undefined): string {
  if (!locator) return "No narrow locator supplied";
  if (locator.sheet && locator.cell) return `${locator.sheet}!${locator.cell}`;
  if (locator.sheet && locator.range) return `${locator.sheet}!${locator.range}`;
  if (locator.page) return `Page ${locator.page}${locator.passage ? ` · ${locator.passage}` : ""}`;
  if (locator.timecode) return `${locator.timecode}${locator.passage ? ` · ${locator.passage}` : ""}`;
  return String(locator.passage ?? "Source-level lineage only");
}

function fieldValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function relatedTitle(value: unknown, fallback: string): string {
  return objectLabel(value, fallback);
}

export function ObjectDetailPanel({
  targetId,
  queries,
  onClose,
  onFocusGraph,
}: Props) {
  useEffect(() => {
    if (!targetId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, targetId]);

  if (!targetId) return null;
  const object = queries.getObject(targetId);
  const record = objectRecord(object);
  const provenance = queries.getProvenance(targetId);
  const relationships = queries.getRelationships(targetId);
  const transformations: Transformation[] = targetId.startsWith("transformation_")
    ? [object as Transformation]
    : targetId.startsWith("metric_")
      ? queries.database.transformations.filter((item) => item.outputMetricId === targetId)
      : targetId.startsWith("obs_") && typeof record.transformationId === "string"
        ? queries.database.transformations.filter((item) => item.id === record.transformationId)
        : [];
  const metricId = targetId.startsWith("metric_")
    ? targetId
    : typeof record.metricId === "string"
      ? record.metricId
      : undefined;

  const hiddenFields = new Set(["id", "name", "title", "description", "statement"]);
  const fields = Object.entries(record).filter(
    ([key, value]) => !hiddenFields.has(key) && value !== undefined,
  );

  return (
    <>
      <button className="detail-scrim" aria-label="Close object details" onClick={onClose} />
      <aside className="detail-panel" aria-label={`Details for ${targetId}`} data-testid="detail-panel">
        <header className="detail-header">
          <div>
            <span className="eyebrow">{objectKind(targetId)}</span>
            <h2>{objectLabel(object, targetId)}</h2>
            {record.description ? <p>{String(record.description)}</p> : null}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close details">
            <Icon name="close" size={19} />
          </button>
        </header>

        <div className="detail-body">
          {metricId && (
            <button className="graph-focus-action" onClick={() => onFocusGraph(metricId)}>
              <Icon name="graph" size={17} />
              Focus in dependency graph
              <Icon name="arrow" size={15} />
            </button>
          )}

          <section className="detail-section">
            <div className="detail-section-title">
              <span>Canonical fields</span>
              <code>{targetId}</code>
            </div>
            <dl className="object-fields">
              {fields.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{fieldValue(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {transformations.map((transformation) => (
            <section className="detail-section formula-detail" key={transformation.id}>
              <div className="detail-section-title">
                <span><Icon name="formula" size={16} /> Formula lineage</span>
                <span className={`status-chip ${transformation.status}`}>{transformation.status}</span>
              </div>
              <div className="formula-pair">
                <div>
                  <small>Canonical expression</small>
                  <code>{transformation.expression}</code>
                </div>
                <div>
                  <small>Original workbook formula</small>
                  <code>{transformation.originalExpression ?? "Not supplied"}</code>
                </div>
              </div>
            </section>
          ))}

          <section className="detail-section">
            <div className="detail-section-title">
              <span><Icon name="source" size={16} /> Provenance</span>
              <span>{provenance.records.length} record{provenance.records.length === 1 ? "" : "s"}</span>
            </div>
            <div className="provenance-list">
              {provenance.records.map(({ provenance: item, source, extractionRun }) => (
                <article key={item.id}>
                  <div className="source-title">
                    <span className="source-icon"><Icon name="source" size={17} /></span>
                    <div><strong>{source.title}</strong><small>{source.type}</small></div>
                    <span className={`review-chip ${item.reviewStatus}`}>{item.reviewStatus}</span>
                  </div>
                  <dl>
                    <div><dt>Locator</dt><dd>{formatLocator(item.locator)}</dd></div>
                    <div><dt>Confidence</dt><dd>{Math.round(item.confidence * 100)}%</dd></div>
                    <div><dt>Extraction run</dt><dd>{extractionRun.id}</dd></div>
                    <div><dt>Content hash</dt><dd className="hash-value">{source.contentHash ?? "Not supplied"}</dd></div>
                  </dl>
                  <div className="confidence-track"><span style={{ width: `${item.confidence * 100}%` }} /></div>
                </article>
              ))}
            </div>
          </section>

          {relationships.length > 0 && (
            <section className="detail-section">
              <div className="detail-section-title">
                <span>Related objects</span>
                <span>{relationships.length}</span>
              </div>
              <div className="related-list">
                {relationships.map(({ relationship, direction, relatedObject }) => (
                  <div key={relationship.id}>
                    <span>{direction === "outgoing" ? "→" : "←"} {relationship.type.replaceAll("_", " ")}</span>
                    <strong>{relatedTitle(relatedObject, direction === "outgoing" ? relationship.toId : relationship.fromId)}</strong>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
