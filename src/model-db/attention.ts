import type { UnresolvedItem } from "./types";

const GUIDANCE_FIELDS = ["currentTreatment", "impact", "nextAction"] as const;

export type CompleteAttentionGuidance = UnresolvedItem & Required<
  Pick<UnresolvedItem, (typeof GUIDANCE_FIELDS)[number]>
>;

export type ActionOwner = NonNullable<UnresolvedItem["actionOwner"]>;

export const ACTION_OWNER_COPY: Record<ActionOwner, {
  title: string;
  summary: string;
  detail: string;
}> = {
  extraction_agent: {
    title: "Agent follow-up",
    summary: "No action from you · extraction agent",
    detail: "The extraction agent must update the map or translator, replay the formula, and re-import the dataset.",
  },
  model_owner: {
    title: "Model decision",
    summary: "Decision needed · model owner",
    detail: "A model owner must choose the authoritative interpretation before extraction can continue.",
  },
  source_owner: {
    title: "Source repair",
    summary: "Repair needed · source owner",
    detail: "The source workbook or upstream data must be corrected before extraction can continue.",
  },
};

export function actionOwnerCopy(item: UnresolvedItem) {
  return item.actionOwner
    ? ACTION_OWNER_COPY[item.actionOwner]
    : {
        title: "Owner unspecified",
        summary: "Owner unspecified · rerun extraction",
        detail: "This legacy action does not say who should handle it. Re-run extraction before assigning work.",
      };
}

function usableText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function hasCompleteAttentionGuidance(
  item: UnresolvedItem,
): item is CompleteAttentionGuidance {
  return GUIDANCE_FIELDS.every((field) => usableText(item[field]) !== undefined);
}
