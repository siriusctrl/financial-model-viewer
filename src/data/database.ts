import sampleDatabase from "../../examples/sample-model-db.json";
import { assertValidModelDatabase } from "../model-db/validate";

export const defaultDatabase = assertValidModelDatabase(sampleDatabase);
