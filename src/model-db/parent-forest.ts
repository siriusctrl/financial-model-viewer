export type OrderedParentIssue =
  | { kind: "unknown_child"; childId: string; parentId: string }
  | { kind: "unknown_parent"; childId: string; parentId: string }
  | { kind: "parent_order"; childId: string; parentId: string };

export function analyzeOrderedParentForest(
  orderedIds: readonly string[],
  parentIds: Readonly<Record<string, string>>,
): { depths: Map<string, number>; issues: OrderedParentIssue[] } {
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const issues: OrderedParentIssue[] = [];

  for (const [childId, parentId] of Object.entries(parentIds)) {
    const childPosition = positions.get(childId);
    const parentPosition = positions.get(parentId);
    if (childPosition === undefined) {
      issues.push({ kind: "unknown_child", childId, parentId });
    }
    if (parentPosition === undefined) {
      issues.push({ kind: "unknown_parent", childId, parentId });
    } else if (childPosition !== undefined && parentPosition >= childPosition) {
      issues.push({ kind: "parent_order", childId, parentId });
    }
  }

  const depths = new Map<string, number>();
  for (const id of orderedIds) {
    const parentId = parentIds[id];
    depths.set(id, parentId && depths.has(parentId) ? depths.get(parentId)! + 1 : 0);
  }
  return { depths, issues };
}

export function findParentCycles(parentByChild: ReadonlyMap<string, string>): string[][] {
  const complete = new Set<string>();
  const cycles: string[][] = [];

  for (const startId of parentByChild.keys()) {
    if (complete.has(startId)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let currentId: string | undefined = startId;
    while (currentId && !complete.has(currentId)) {
      const cycleStart = positions.get(currentId);
      if (cycleStart !== undefined) {
        cycles.push([...path.slice(cycleStart), currentId]);
        break;
      }
      positions.set(currentId, path.length);
      path.push(currentId);
      currentId = parentByChild.get(currentId);
    }
    path.forEach((id) => complete.add(id));
  }

  return cycles;
}
