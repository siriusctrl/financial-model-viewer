import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./Icon";
import type { ObservationEditResult } from "../model-db/calculation";
import type {
  ModelDatabaseQueries,
  ObservationDetailProjection,
  ProvenanceProjection,
} from "../model-db/queries";
import type {
  Metric,
  Observation,
  ScalarValue,
  SourceLocator,
  UnresolvedItem,
} from "../model-db/types";
import { AttentionGuidance } from "./AttentionGuidance";
import {
  sourceExpressionFor,
  transformationDependencyMetricIds,
} from "../model-db/access";

type Props = {
  targetId: string | null;
  queries: ModelDatabaseQueries;
  onClose: () => void;
  canNavigateBack: boolean;
  onNavigateBack: () => void;
  onSelectTarget: (targetId: string) => void;
  onFocusGraph: (metricId: string) => void;
  onUpdateObservation: (
    observationId: string,
    value: ScalarValue,
  ) => ObservationEditResult;
  onConfirmReview: (itemId: string) => void;
};

type InspectorSide = "left" | "right";

function horizontalOverlap(
  target: Pick<DOMRect, "left" | "right">,
  panelLeft: number,
  panelRight: number,
): number {
  return Math.max(0, Math.min(target.right, panelRight) - Math.max(target.left, panelLeft));
}

function sideThatAvoids(
  target: Pick<DOMRect, "left" | "right">,
  panelWidth: number,
  viewportWidth: number,
  edge: number,
): InspectorSide {
  const rightOverlap = horizontalOverlap(
    target,
    viewportWidth - edge - panelWidth,
    viewportWidth - edge,
  );
  const leftOverlap = horizontalOverlap(target, edge, edge + panelWidth);
  return rightOverlap > leftOverlap ? "left" : "right";
}

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

function InspectorHeaderActions({
  canNavigateBack,
  backLabel,
  onNavigateBack,
  onClose,
}: {
  canNavigateBack: boolean;
  backLabel: string;
  onNavigateBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="inspector-header-actions">
      {canNavigateBack && (
        <button
          className="inspector-back-button"
          onClick={onNavigateBack}
          aria-label={backLabel}
        >
          <Icon name="back" size={14} /> Back
        </button>
      )}
      <button className="icon-button" onClick={onClose} aria-label="Clear selection">
        <Icon name="close" size={17} />
      </button>
    </div>
  );
}

export function ObjectDetailPanel({
  targetId,
  queries,
  onClose,
  canNavigateBack,
  onNavigateBack,
  onSelectTarget,
  onFocusGraph,
  onUpdateObservation,
  onConfirmReview,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const [displayTargetId, setDisplayTargetId] = useState(targetId);
  const [side, setSide] = useState<InspectorSide>("right");
  useEffect(() => {
    if (targetId) setDisplayTargetId(targetId);
  }, [targetId]);
  useLayoutEffect(() => {
    if (!targetId || !panelRef.current) return;
    if (window.matchMedia("(max-width: 820px)").matches) {
      setSide("right");
      return;
    }

    const selectedTarget = document.querySelector<HTMLElement>(
      `[data-inspector-target="${CSS.escape(targetId)}"]`,
    ) ?? document.querySelector<HTMLElement>("[data-attention-cell-focus='true']");
    const panelStyle = getComputedStyle(panelRef.current);
    const edge = Number.parseFloat(panelStyle.getPropertyValue("--inspector-edge"));
    setSide(selectedTarget
      ? sideThatAvoids(
          selectedTarget.getBoundingClientRect(),
          panelRef.current.getBoundingClientRect().width,
          window.innerWidth,
          edge,
        )
      : "right");
  }, [targetId]);
  useEffect(() => {
    if (!targetId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, targetId]);

  const observation = displayTargetId
    ? queries.getObservation(displayTargetId)
    : undefined;

  return (
    <aside
      ref={panelRef}
      className={`inspector-panel inspector-panel--${side} ${targetId ? "is-open" : ""}`}
      aria-label="Cell inspector"
      aria-hidden={!targetId}
      data-side={side}
      data-testid="detail-panel"
      onTransitionEnd={(event) => {
        if (!targetId && event.propertyName === "transform") setDisplayTargetId(null);
      }}
    >
      {observation && displayTargetId ? (
        <CellDetail
          detail={queries.getObservationDetail(observation.id)}
          onClose={onClose}
          canNavigateBack={canNavigateBack}
          onNavigateBack={onNavigateBack}
          onSelectTarget={onSelectTarget}
          onFocusGraph={onFocusGraph}
          onUpdateObservation={onUpdateObservation}
          onConfirmReview={onConfirmReview}
        />
      ) : displayTargetId ? (
        <ObjectDetail
          targetId={displayTargetId}
          queries={queries}
          onClose={onClose}
          canNavigateBack={canNavigateBack}
          onNavigateBack={onNavigateBack}
          onConfirmReview={onConfirmReview}
        />
      ) : null}
    </aside>
  );
}

function ValueEditor({
  detail,
  onUpdateObservation,
}: {
  detail: ObservationDetailProjection;
  onUpdateObservation: Props["onUpdateObservation"];
}) {
  const numericMetric = ["number", "percentage", "currency", "count"].includes(
    detail.metric.dataType,
  );
  const editable = numericMetric
    && detail.observation.valueType !== "derived"
    && !detail.transformation
    && (typeof detail.observation.value === "number" || detail.observation.value === null);
  const displayValue = typeof detail.observation.value === "number"
    ? detail.metric.dataType === "percentage"
      ? detail.observation.value * 100
      : detail.observation.value
    : "";
  const [draft, setDraft] = useState(String(displayValue));
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(displayValue));
  }, [detail.observation.id, displayValue]);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [detail.observation.id]);

  if (!editable) return null;

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setError("Enter a finite numeric value.");
      return;
    }
    try {
      const stored = detail.metric.dataType === "percentage" ? parsed / 100 : parsed;
      const update = onUpdateObservation(detail.observation.id, stored);
      const count = update.propagatedChanges.length;
      setResult(
        count > 0
          ? `Saved locally · ${count} downstream formula cell${count === 1 ? "" : "s"} recalculated.`
          : "Saved locally · no formula cells changed.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The value could not be updated.");
    }
  };

  return (
    <form className="value-editor" onSubmit={save} data-testid="value-editor">
      <div>
        <span>Local value edit</span>
        <small>
          {detail.metric.dataType === "percentage"
            ? "Enter a percentage; formulas use its decimal value."
            : "The validated working copy stays in this tab until exported."}
        </small>
      </div>
      <div className="value-editor-control">
        <input
          type="number"
          step={detail.metric.dataType === "count" ? 1 : "any"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Edit ${detail.metric.name} value`}
        />
        <button type="submit">Apply</button>
      </div>
      {result && <p className="edit-result" role="status">{result}</p>}
      {error && <p className="edit-error" role="alert">{error}</p>}
    </form>
  );
}

function ReverseLineage({
  detail,
  onSelectTarget,
}: {
  detail: ObservationDetailProjection;
  onSelectTarget: (targetId: string) => void;
}) {
  if (detail.dependents.length === 0) return null;
  const visible = detail.dependents.slice(0, 12);
  return (
    <section className="inspector-section reverse-lineage" data-testid="reverse-lineage">
      <div className="inspector-section-heading">
        <div>
          <span>Reverse lineage</span>
          <h3>
            Used by {detail.dependents.length} formula cell{detail.dependents.length === 1 ? "" : "s"}
          </h3>
        </div>
      </div>
      <div className="lineage-inputs">
        {visible.map((dependent) => (
          <button
            key={dependent.observation.id}
            className="lineage-input"
            onClick={() => onSelectTarget(dependent.observation.id)}
          >
            <span>
              <strong>{dependent.metric.name}</strong>
              <small>{dependent.period.label} · derived</small>
            </span>
            <b>{formatValue(dependent.observation.value, dependent.metric)}</b>
          </button>
        ))}
      </div>
      {detail.dependents.length > visible.length && (
        <p className="lineage-overflow">
          Plus {detail.dependents.length - visible.length} more direct formula cells.
        </p>
      )}
    </section>
  );
}

function CellDetail({
  detail,
  onClose,
  canNavigateBack,
  onNavigateBack,
  onSelectTarget,
  onFocusGraph,
  onUpdateObservation,
  onConfirmReview,
}: {
  detail: ObservationDetailProjection;
  onClose: () => void;
  canNavigateBack: boolean;
  onNavigateBack: () => void;
  onSelectTarget: (targetId: string) => void;
  onFocusGraph: (metricId: string) => void;
  onUpdateObservation: Props["onUpdateObservation"];
  onConfirmReview: Props["onConfirmReview"];
}) {
  const attentionGroups = [
    {
      level: "action_required" as const,
      label: "Action required",
      items: detail.unresolvedItems.filter(
        (item) => item.attentionLevel === "action_required",
      ),
    },
    {
      level: "needs_review" as const,
      label: "Needs review",
      items: detail.unresolvedItems.filter(
        (item) => item.attentionLevel === "needs_review",
      ),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <>
      <header className="inspector-header">
        <div>
          <span>Selected cell · {detail.period.label}</span>
          <h2>{detail.metric.name}</h2>
        </div>
        <InspectorHeaderActions
          canNavigateBack={canNavigateBack}
          backLabel="Back to previous inspected cell"
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      </header>

      <div className="inspector-body">
        <section className="cell-value-block">
          <strong>{formatValue(detail.observation.value, detail.metric)}</strong>
          <span>{detail.metric.unit ?? detail.metric.dataType}</span>
          <div className="cell-state-line">
            <span className={`value-kind value-kind--${detail.observation.valueType}`}>
              {detail.observation.valueType.replaceAll("_", " ")}
            </span>
            <span>{detail.observation.actuality}</span>
          </div>
        </section>

        <ValueEditor
          detail={detail}
          onUpdateObservation={onUpdateObservation}
        />

        {attentionGroups.length > 0 && (
          <div className="cell-attention-stack" data-testid="cell-review-warning">
            {attentionGroups.map((group) => (
              <section
                key={group.level}
                className={`cell-review-warning cell-review-warning--${group.level}`}
              >
                <Icon name="warning" size={16} />
                <div>
                  <strong>{group.label}</strong>
                  {group.items.map((item) => (
                    <div className="cell-attention-item" key={item.id}>
                      <p>{item.description}</p>
                      <div className="attention-evidence-line">
                        <span>{item.locator ? formatLocator(item.locator) : "No narrow source locator"}</span>
                        {item.confidence !== undefined && (
                          <span>{Math.round(item.confidence * 100)}% extraction confidence</span>
                        )}
                      </div>
                      <AttentionGuidance
                        item={item}
                        onConfirmReview={onConfirmReview}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
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
                  ? detail.formulaKind === "constant"
                    ? "Formula constant"
                    : `Derived from ${detail.inputs.length} input${detail.inputs.length === 1 ? "" : "s"}`
                  : "Opaque workbook formula"}
              </h3>
              {transformationDependencyMetricIds(detail.transformation).length > 0 && (
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
                      key={`${input.metric.id}:${input.referencePeriodId ?? input.periodOffset}`}
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
              <code>
                {sourceExpressionFor(detail.transformation, detail.period.id) ?? "Not supplied"}
              </code>
              <span>Canonical translation</span>
              <code>
                {detail.transformation.status === "supported"
                  ? detail.transformation.expression
                  : `Not translated (${detail.transformation.status})`}
              </code>
            </div>
          </section>
        )}

        <ReverseLineage detail={detail} onSelectTarget={onSelectTarget} />

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
            <article key={`${item.targetId}:${item.contextId}:${formatLocator(item.locator)}`}>
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
  canNavigateBack,
  onNavigateBack,
  onConfirmReview,
}: {
  targetId: string;
  queries: ModelDatabaseQueries;
  onClose: () => void;
  canNavigateBack: boolean;
  onNavigateBack: () => void;
  onConfirmReview: Props["onConfirmReview"];
}) {
  const object = queries.getObject(targetId);
  const record = objectRecord(object);
  const attentionLevel = record.attentionLevel === "action_required"
    ? "action_required"
    : record.attentionLevel === "needs_review"
      ? "needs_review"
      : null;
  const attentionItem = attentionLevel ? (object as UnresolvedItem) : undefined;
  const fields = Object.entries(record).filter(
    ([key, value]) => ![
      "id",
      "name",
      "title",
      "description",
      "currentTreatment",
      "impact",
      "nextAction",
      "affectedTargetIds",
      "attentionLevel",
      "actionOwner",
      "status",
    ].includes(key) && value !== undefined,
  );
  return (
    <>
      <header className={`inspector-header ${attentionLevel ? `inspector-header--${attentionLevel}` : ""}`}>
        <div>
          <span>{attentionLevel ? "Extraction attention" : "Model object"}</span>
          <h2>
            {attentionLevel === "action_required"
              ? "Action required"
              : attentionLevel === "needs_review"
                ? "Needs review"
                : objectLabel(object, targetId)}
          </h2>
        </div>
        <InspectorHeaderActions
          canNavigateBack={canNavigateBack}
          backLabel="Back to previous inspected item"
          onNavigateBack={onNavigateBack}
          onClose={onClose}
        />
      </header>
      <div className="inspector-body">
        {record.description !== undefined && (
          <p className="object-description">{String(record.description)}</p>
        )}
        {attentionItem && record.status === "open" && (
          <section className="attention-resolution">
            <AttentionGuidance
              item={attentionItem}
              onConfirmReview={onConfirmReview}
            />
          </section>
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
