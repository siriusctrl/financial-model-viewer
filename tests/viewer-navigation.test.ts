import { describe, expect, it } from "vitest";
import {
  createViewerNavigation,
  viewerNavigationReducer,
  type ViewerLocation,
} from "../src/viewer-navigation";

const base: ViewerLocation = {
  modelId: "model_test",
  presentationId: "presentation_test",
  entityId: "entity_test",
  periodType: "fiscal_year",
  targetId: null,
};

describe("viewer navigation", () => {
  it("keeps cross-view inspection as a back stack", () => {
    const first = viewerNavigationReducer(createViewerNavigation(base), {
      type: "inspect",
      location: { ...base, targetId: "observation_first" },
    });
    const second = viewerNavigationReducer(first, {
      type: "inspect",
      location: {
        ...base,
        presentationId: "presentation_other",
        targetId: "observation_second",
      },
    });

    expect(second.history.map((item) => item.targetId)).toEqual(["observation_first"]);
    expect(viewerNavigationReducer(second, { type: "back" }).current).toMatchObject({
      presentationId: "presentation_test",
      targetId: "observation_first",
    });
  });

  it("replaces view context and closes inspection without stale history", () => {
    const inspected = viewerNavigationReducer(createViewerNavigation(base), {
      type: "inspect",
      location: { ...base, targetId: "metric_test" },
    });
    const replaced = viewerNavigationReducer(inspected, {
      type: "replace",
      location: { ...base, modelId: "model_other", targetId: null },
    });

    expect(replaced.history).toEqual([]);
    expect(viewerNavigationReducer(replaced, { type: "close" })).toEqual(replaced);
  });
});
