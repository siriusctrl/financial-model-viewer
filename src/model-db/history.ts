import type { ModelDatabase } from "./types";

const MAX_HISTORY_ENTRIES = 20;

export type DatabaseHistory = {
  past: ModelDatabase[];
  present: ModelDatabase;
  future: ModelDatabase[];
};

export type DatabaseHistoryAction =
  | { type: "commit"; database: ModelDatabase }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; database: ModelDatabase };

export function createDatabaseHistory(database: ModelDatabase): DatabaseHistory {
  return { past: [], present: database, future: [] };
}

export function databaseHistoryReducer(
  history: DatabaseHistory,
  action: DatabaseHistoryAction,
): DatabaseHistory {
  switch (action.type) {
    case "commit":
      if (action.database === history.present) return history;
      return {
        past: [...history.past, history.present].slice(-MAX_HISTORY_ENTRIES),
        present: action.database,
        future: [],
      };
    case "undo": {
      const previous = history.past.at(-1);
      if (!previous) return history;
      return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future].slice(0, MAX_HISTORY_ENTRIES),
      };
    }
    case "redo": {
      const next = history.future[0];
      if (!next) return history;
      return {
        past: [...history.past, history.present].slice(-MAX_HISTORY_ENTRIES),
        present: next,
        future: history.future.slice(1),
      };
    }
    case "reset":
      return createDatabaseHistory(action.database);
  }
}
