import type { UnresolvedItem } from "./types";

const GUIDANCE_FIELDS = ["currentTreatment", "impact", "nextAction"] as const;

export type CompleteAttentionGuidance = UnresolvedItem & Required<
  Pick<UnresolvedItem, (typeof GUIDANCE_FIELDS)[number]>
>;

function usableText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function hasCompleteAttentionGuidance(
  item: UnresolvedItem,
): item is CompleteAttentionGuidance {
  return GUIDANCE_FIELDS.every((field) => usableText(item[field]) !== undefined);
}
