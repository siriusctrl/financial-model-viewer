import type { Period } from "./model-db/types";

export type ViewerLocation = {
  modelId: string;
  presentationId?: string;
  entityId: string;
  periodType?: Period["type"];
  targetId: string | null;
};

export type ViewerNavigationState = {
  current: ViewerLocation;
  history: ViewerLocation[];
};

export type ViewerNavigationAction =
  | { type: "replace"; location: ViewerLocation }
  | { type: "inspect"; location: ViewerLocation }
  | { type: "back" }
  | { type: "close" };

export function createViewerNavigation(location: ViewerLocation): ViewerNavigationState {
  return { current: location, history: [] };
}

export function viewerNavigationReducer(
  state: ViewerNavigationState,
  action: ViewerNavigationAction,
): ViewerNavigationState {
  switch (action.type) {
    case "replace":
      return { current: action.location, history: [] };
    case "inspect": {
      if (state.current.targetId === action.location.targetId) {
        return { ...state, current: action.location };
      }
      const history = state.current.targetId
        ? [...state.history, state.current].slice(-24)
        : state.history;
      return { current: action.location, history };
    }
    case "back": {
      const previous = state.history.at(-1);
      return previous
        ? { current: previous, history: state.history.slice(0, -1) }
        : state;
    }
    case "close":
      return {
        current: { ...state.current, targetId: null },
        history: [],
      };
  }
}
