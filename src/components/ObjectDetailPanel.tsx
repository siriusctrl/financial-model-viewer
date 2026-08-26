import { Icon } from "./Icon";
import type {
  ModelDatabaseQueries,
  ObservationDetailProjection,
  ProvenanceProjection,
} from "../model-db/queries";
import type { Metric, Observation, SourceLocator } from "../model-db/types";

type Props = {
  targetId: string | null;
  modelId: string;
  queries: ModelDatabaseQueries;
  onClose: () => void;
  onSelectTarget: (targetId: string) => void;
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

function formatLocator(locator: SourceLocator | undefined): string {
  if (!locator) return "No narrow source locator";
  if (locator.sheet && locator.cell) return `${locator.sheet}!${locator.cell}`;
  if (locator.sheet && locator.range) return `${locator.sheet}!${locator.range}`;
  if (locator.page) return `Page ${locator.page}${locator.passage ? ` · ${locator.passage}` : ""}`;
  if (locator.timecode) return `${locator.timecode}${locator.passage ? ` · ${locator.passage}` : ""}`;
  return String(locator.passage ?? locator.sheet ?? "Source-level lineage only");
}

function formatValue(value: Observation["value"], metric: Metric): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (metric.dataType === "percentage") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: metric.dataType === "count" ? 0 : 1,
    maximumFractionDigits: metric.dataType === "count" ? 0 : 2,
  }).format(value);
}

function fieldValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function ObjectDetailPanel({
  targetId,
  modelId,
  queries,
  onClose,
  onSelectTarget,
  onFocusGraph,
}: Props) {
  const observation = targetId
    ? queries.database.observations.find((item) => item.id === targetId)
    : undefined;

  return (
    <aside className="inspector-panel" aria-label="Cell inspector" data-testid="detail-panel">
      {observation ? (
        <CellDetail
          detail={queries.getObservationDetail(observation.id)}
          onClose={onClose}
          onSelectTarget={onSelectTarget}
          onFocusGraph={onFocusGraph}
        />
      ) : targetId ? (
        <ObjectDetail targetId={targetId} queries={queries} onClose={onClose} />
      ) : (
        <EmptyInspector modelId={modelId} queries={queries} />
      )}
    </aside>
  );
}

function EmptyInspector({
  modelId,
  queries,
}: {
  modelId: string;
  queries: ModelDatabaseQueries;
}) {
  const model = queries.getModel(modelId);
  const observed = queries.database.observations.filter(
    (item) => item.modelId === modelId,
  ).length;
  return (
    <div className="inspector-empty">
      <div className="inspector-heading">
        <span>Cell inspector</span>
        <strong>No cell selected</strong>
      </div>
      <div className="empty-inspector-copy">
        <span className="selection-glyph"><Icon name="table" size={22} /></span>
        <h2>Select any value in the table.</h2>
        <p>Its model properties, workbook locator, review state, and formula inputs will appear here.</p>
      </div>
      <dl className="inspector-summary">
        <div><dt>Model</dt><dd>{model.name}</dd></div>
        <div><dt>As of</dt><dd>{model.asOf}</dd></div>
        <div><dt>Observed cells</dt><dd>{observed}</dd></div>
      </dl>
    </div>
  );
}

function CellDetail({
  detail,
  onClose,
  onSelectTarget,
  onFocusGraph,
}: {
  detail: ObservationDetailProjection;
  onClose: () => void;
  onSelectTarget: (targetId: string) => void;
  onFocusGraph: (metricId: string) => void;
}) {
  return (
    <>
      <header className="inspector-header">
        <div>
          <span>Selected cell · {detail.period.label}</span>
          <h2>{detail.metric.name}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Clear selection">
          <Icon name="close" size={17} />
        </button>
      </header>

      <div className="inspector-body">
        <section className="cell-value-block">
          <strong>{formatValue(detail.observation.value, detail.metric)}</strong>
          <span>{detail.observation.unit ?? detail.metric.unit ?? detail.metric.dataType}</span>
          <div className="cell-state-line">
            <span className={`value-kind value-kind--${detail.observation.valueType}`}>
              {detail.observation.valueType.replaceAll("_", " ")}
            </span>
            <span>{detail.observation.actuality}</span>
          </div>
        </section>

        {detail.unresolvedItems.length > 0 && (
          <section className="cell-review-warning" data-testid="cell-review-warning">
            <Icon name="warning" size={16} />
            <div>
              <strong>Open extraction issue</strong>
              {detail.unresolvedItems.map((item) => (
                <p key={item.id}>
                  {item.description}
                  {item.locator ? ` · ${formatLocator(item.locator)}` : ""}
                  {item.confidence !== undefined ? ` · ${Math.round(item.confidence * 100)}% confidence` : ""}
                </p>
              ))}
            </div>
          </section>
        )}

        <section className="inspector-section">
          <h3>Properties</h3>
          <dl className="property-list">
            <div><dt>Metric</dt><dd>{detail.metric.id}</dd></div>
            <div><dt>Period</dt><dd>{detail.period.label}</dd></div>
            <div><dt>Scenario</dt><dd>{detail.scenario?.name ?? "None"}</dd></div>
            <div><dt>As of</dt><dd>{detail.observation.asOf}</dd></div>
            <div><dt>Version</dt><dd>{detail.observation.versionId}</dd></div>
          </dl>
        </section>

        {detail.transformation && (
          <section className="inspector-section formula-lineage" data-testid="formula-lineage">
            <div className="inspector-section-heading">
              <h3>
                {detail.transformation.status === "supported"
                  ? `Derived from ${detail.inputs.length} input${detail.inputs.length === 1 ? "" : "s"}`
                  : "Opaque workbook formula"}
              </h3>
              {detail.transformation.dependencyMetricIds.length > 0 && (
                <button className="text-button" onClick={() => onFocusGraph(detail.metric.id)}>
                  Open map <Icon name="arrow" size={13} />
                </button>
              )}
            </div>

            {detail.transformation.status === "supported" ? (
              <div className="lineage-inputs">
                {detail.inputs.map((input) => {
                  const inputSource = input.provenance.records[0];
                  return (
                    <button
                      key={`${input.metric.id}:${input.periodOffset}`}
                      className="lineage-input"
                      disabled={!input.observation}
                      onClick={() => input.observation && onSelectTarget(input.observation.id)}
                    >
                      <span>
                        <strong>{input.metric.name}</strong>
                        <small>
                          {input.period ? `${input.period.label} · ` : ""}
                          {inputSource ? formatLocator(inputSource.provenance.locator) : "No matching cell"}
                        </small>
                      </span>
                      <b>{input.observation ? formatValue(input.observation.value, input.metric) : "—"}</b>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="opaque-formula-note">
                The cached workbook value is retained, but this formula was not translated into canonical lineage.
              </p>
            )}

            <div className="formula-block">
              <span>Workbook formula</span>
              <code>{detail.transformation.originalExpression ?? "Not supplied"}</code>
              <span>Canonical translation</span>
              <code>
                {detail.transformation.status === "supported"
                  ? detail.transformation.expression
                  : `Not translated (${detail.transformation.status})`}
              </code>
            </div>
          </section>
        )}

        <SourceSection provenance={detail.provenance} />
      </div>
    </>
  );
}

function SourceSection({ provenance }: { provenance: ProvenanceProjection }) {
  return (
    <section className="inspector-section">
      <h3>Source and review</h3>
      {provenance.records.length === 0 ? (
        <p className="missing-source">No provenance record resolved.</p>
      ) : (
        <div className="source-records">
          {provenance.records.map(({ provenance: item, source, extractionRun }) => (
            <article key={item.id}>
              <div className="source-record-heading">
                <span className="source-icon"><Icon name="source" size={16} /></span>
                <span><strong>{formatLocator(item.locator)}</strong><small>{source.title}</small></span>
              </div>
              <dl className="property-list compact">
                <div><dt>Confidence</dt><dd>{Math.round(item.confidence * 100)}%</dd></div>
                <div><dt>Review</dt><dd>{item.reviewStatus}</dd></div>
                <div><dt>Extraction</dt><dd>{extractionRun.id}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ObjectDetail({
  targetId,
  queries,
  onClose,
}: {
  targetId: string;
  queries: ModelDatabaseQueries;
  onClose: () => void;
}) {
  const object = queries.getObject(targetId);
  const record = objectRecord(object);
  const fields = Object.entries(record).filter(
    ([key, value]) => !["id", "name", "title", "description"].includes(key) && value !== undefined,
  );
  return (
    <>
      <header className="inspector-header">
        <div><span>Model object</span><h2>{objectLabel(object, targetId)}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Clear selection">
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="inspector-body">
        {record.description !== undefined && (
          <p className="object-description">{String(record.description)}</p>
        )}
        <section className="inspector-section">
          <h3>Properties</h3>
          <dl className="property-list">
            {fields.map(([key, value]) => (
              <div key={key}><dt>{key}</dt><dd>{fieldValue(value)}</dd></div>
            ))}
          </dl>
        </section>
        <SourceSection provenance={queries.getProvenance(targetId)} />
      </div>
    </>
  );
}
