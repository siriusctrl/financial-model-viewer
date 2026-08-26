import sampleDatabase from "../../examples/sample-model-db.json";
import { ModelDatabaseQueries } from "../model-db/queries";
import { assertValidModelDatabase } from "../model-db/validate";

export const database = assertValidModelDatabase(sampleDatabase);
export const queries = new ModelDatabaseQueries(database);
