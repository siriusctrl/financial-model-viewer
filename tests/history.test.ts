import { describe, expect, it } from "vitest";
import sample from "../examples/sample-model-db.json";
import {
  createDatabaseHistory,
  databaseHistoryReducer,
} from "../src/model-db/history";
import type { ModelDatabase } from "../src/model-db/types";
import { assertValidModelDatabase } from "../src/model-db/validate";

const database = assertValidModelDatabase(sample);

function fixture(): ModelDatabase {
  return structuredClone(database);
}

describe("database history", () => {
  it("undoes and redoes committed databases", () => {
    const initial = fixture();
    const edited = structuredClone(initial);
    edited.dataset.name = "Edited";

    const committed = databaseHistoryReducer(createDatabaseHistory(initial), {
      type: "commit",
      database: edited,
    });
    expect(committed.present).toBe(edited);
    expect(committed.past).toEqual([initial]);

    const undone = databaseHistoryReducer(committed, { type: "undo" });
    expect(undone.present).toBe(initial);
    expect(undone.future).toEqual([edited]);

    const redone = databaseHistoryReducer(undone, { type: "redo" });
    expect(redone.present).toBe(edited);
    expect(redone.future).toEqual([]);
  });

  it("clears redo history after a new edit and resets on upload", () => {
    const initial = fixture();
    const first = structuredClone(initial);
    first.dataset.name = "First";
    const alternate = structuredClone(initial);
    alternate.dataset.name = "Alternate";

    const committed = databaseHistoryReducer(createDatabaseHistory(initial), {
      type: "commit",
      database: first,
    });
    const undone = databaseHistoryReducer(committed, { type: "undo" });
    const branched = databaseHistoryReducer(undone, {
      type: "commit",
      database: alternate,
    });
    expect(branched.future).toEqual([]);
    expect(branched.present).toBe(alternate);

    const uploaded = structuredClone(initial);
    uploaded.dataset.name = "Uploaded";
    expect(databaseHistoryReducer(branched, {
      type: "reset",
      database: uploaded,
    })).toEqual(createDatabaseHistory(uploaded));
  });
});
