import { hasCompleteAttentionGuidance } from "../model-db/attention";
import type { UnresolvedItem } from "../model-db/types";
import { Icon } from "./Icon";

type Props = {
  item: UnresolvedItem;
  onConfirmReview: (itemId: string) => void;
};

export function AttentionGuidance({ item, onConfirmReview }: Props) {
  const guidance = {
    complete: hasCompleteAttentionGuidance(item),
    currentTreatment: item.currentTreatment?.trim()
      || "This older dataset does not state how the item is currently treated.",
    impact: item.impact?.trim()
      || "This older dataset does not state which values or interpretations may be affected.",
    nextAction: item.nextAction?.trim()
      || "Re-run extraction with current treatment, impact, and a concrete next step.",
  };
  const isAction = item.attentionLevel === "action_required";

  return (
    <div
      className={`attention-guidance attention-guidance--${item.attentionLevel}`}
      data-testid="attention-guidance"
      data-guidance-complete={guidance.complete}
    >
      <dl>
        <div>
          <dt>Current treatment</dt>
          <dd>{guidance.currentTreatment}</dd>
        </div>
        <div>
          <dt>Why it matters</dt>
          <dd>{guidance.impact}</dd>
        </div>
        <div>
          <dt>{isAction ? "Required next step" : "What to check"}</dt>
          <dd>{guidance.nextAction}</dd>
        </div>
      </dl>

      {isAction ? (
        <DecisionLock
          title="Cannot be cleared in the viewer"
          detail="Complete the step above and re-import the extraction."
        />
      ) : guidance.complete ? (
        <div className="attention-confirmation">
          <p>
            Confirm only if the current treatment matches your understanding of the source.
            Otherwise leave this item open.
          </p>
          <button
            className="confirm-interpretation-button"
            onClick={() => onConfirmReview(item.id)}
          >
            <Icon name="check" size={13} /> Confirm interpretation
          </button>
        </div>
      ) : (
        <DecisionLock
          title="Confirmation unavailable"
          detail="This legacy item is missing actionable guidance. Re-run extraction before confirming it."
          legacy
        />
      )}
    </div>
  );
}

function DecisionLock({
  title,
  detail,
  legacy = false,
}: {
  title: string;
  detail: string;
  legacy?: boolean;
}) {
  return (
    <div className={`attention-decision-lock${legacy ? " attention-decision-lock--legacy" : ""}`}>
      <Icon name="lock" size={13} />
      <span>
        <strong>{title}</strong>
        {detail}
      </span>
    </div>
  );
}
