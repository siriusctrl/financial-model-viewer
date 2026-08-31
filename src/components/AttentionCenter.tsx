import { useEffect, useMemo, useRef, useState } from "react";
import { actionOwnerCopy } from "../model-db/attention";
import type { AttentionItemProjection } from "../model-db/queries";
import type { SourceLocator } from "../model-db/types";
import { Icon } from "./Icon";

type AttentionFilter =
  | "all"
  | "model_owner"
  | "source_owner"
  | "extraction_agent"
  | "unassigned"
  | "needs_review";

type Props = {
  items: AttentionItemProjection[];
  open: boolean;
  onClose: () => void;
  onNavigate: (item: AttentionItemProjection) => void;
};

function formatLocator(locator: SourceLocator | undefined): string {
  if (!locator) return "No narrow source locator";
  if (locator.sheet && locator.cell) return `${locator.sheet}!${locator.cell}`;
  if (locator.sheet && locator.range) return `${locator.sheet}!${locator.range}`;
  if (locator.page) return `Page ${locator.page}`;
  if (locator.timecode) return locator.timecode;
  return locator.passage ?? locator.sheet ?? "Source-level lineage";
}

function categoryLabel(category: AttentionItemProjection["item"]["category"]): string {
  return category.replaceAll("_", " ");
}

export function AttentionCenter({ items, open, onClose, onNavigate }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<AttentionFilter>("all");
  const countFor = (owner: AttentionFilter) => items.filter(({ item }) => {
    if (owner === "all") return true;
    if (owner === "needs_review") return item.attentionLevel === "needs_review";
    if (item.attentionLevel !== "action_required") return false;
    if (owner === "unassigned") return item.actionOwner === undefined;
    return item.actionOwner === owner;
  }).length;
  const agentCount = countFor("extraction_agent");
  const modelOwnerCount = countFor("model_owner");
  const sourceOwnerCount = countFor("source_owner");
  const unassignedCount = countFor("unassigned");
  const humanActionCount = modelOwnerCount + sourceOwnerCount + unassignedCount;
  const reviewCount = countFor("needs_review");
  const visibleItems = useMemo(
    () => filter === "all"
      ? items
      : items.filter(({ item }) => {
          if (filter === "needs_review") return item.attentionLevel === "needs_review";
          if (item.attentionLevel !== "action_required") return false;
          if (filter === "unassigned") return item.actionOwner === undefined;
          return item.actionOwner === filter;
        }),
    [filter, items],
  );

  useEffect(() => {
    if (!open) return;
    setFilter("all");
    closeButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  const filters: Array<{ id: AttentionFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: items.length },
    { id: "model_owner", label: "Model decision", count: modelOwnerCount },
    { id: "source_owner", label: "Source repair", count: sourceOwnerCount },
    { id: "extraction_agent", label: "Agent follow-up", count: agentCount },
    { id: "unassigned", label: "Unassigned", count: unassignedCount },
    { id: "needs_review", label: "Review", count: reviewCount },
  ];
  const visibleFilters = filters.filter((item) => item.id === "all" || item.count > 0);

  return (
    <div className="attention-layer">
      <div
        className="attention-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        className="attention-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attention-center-title"
        data-testid="attention-center"
      >
        <header className="attention-center-header">
          <div>
            <span>Extraction attention</span>
            <h2 id="attention-center-title">What needs attention</h2>
            <p>
              Each item names who should handle it. Agent follow-ups require no action from you.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            aria-label="Close review queue"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="attention-overview" aria-label="Open attention counts">
          <div className="attention-overview-human">
            <strong>{humanActionCount}</strong>
            <span><b>Action from you</b><small>Model decision or source repair</small></span>
          </div>
          <div className="attention-overview-agent">
            <strong>{agentCount}</strong>
            <span><b>Agent follow-up</b><small>No action from you</small></span>
          </div>
          <div className="attention-overview-review">
            <strong>{reviewCount}</strong>
            <span><b>Needs review</b><small>Confirm an interpretation</small></span>
          </div>
        </div>

        <nav className="attention-filters" aria-label="Filter review queue">
          {visibleFilters.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </nav>

        <div className="attention-list">
          {visibleItems.map((projection, index) => {
            const isAction = projection.item.attentionLevel === "action_required";
            const owner = isAction ? actionOwnerCopy(projection.item) : null;
            return (
              <button
                key={projection.item.id}
                className={`attention-item attention-item--${projection.item.attentionLevel}`}
                onClick={() => onNavigate(projection)}
                data-attention-id={projection.item.id}
                data-attention-level={projection.item.attentionLevel}
              >
                <span className="attention-item-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="attention-item-copy">
                  <span className="attention-item-state">
                    <i /> {owner?.summary ?? "Confirmation needed"}
                  </span>
                  <strong>{projection.targetLabel}</strong>
                  <small>
                    {projection.model?.name && `${projection.model.name} · `}
                    {formatLocator(projection.locator)} · {categoryLabel(projection.item.category)}
                  </small>
                  <p>{projection.item.description}</p>
                </span>
                <span className="attention-item-arrow" aria-hidden="true">
                  Review <Icon name="arrow" size={13} />
                </span>
              </button>
            );
          })}
          {visibleItems.length === 0 && (
            <div className="attention-empty">
              <Icon name="check" size={22} />
              <strong>No items in this view</strong>
              <span>Choose another filter to inspect the remaining queue.</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
