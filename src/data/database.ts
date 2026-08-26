import sampleDatabase from "../../examples/sample-model-db.json";
import { validateModelDatabase } from "../model-db/validate";

const embeddedPreview = typeof document === "undefined"
  ? undefined
  : document.getElementById("model-db-preview-data")?.textContent?.trim();
let initialInput: unknown = sampleDatabase;

if (embeddedPreview) {
  try {
    initialInput = JSON.parse(embeddedPreview);
  } catch (cause) {
    throw new Error(
      `The compiled preview contains invalid model JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

const initialValidation = validateModelDatabase(initialInput);
if (!initialValidation.success) {
  throw new Error(
    `The bundled model database failed validation: ${initialValidation.errors
      .slice(0, 3)
      .map((item) => `${item.objectId}.${item.field}: ${item.reason}`)
      .join("; ")}`,
  );
}

export const defaultDatabase = initialValidation.data;
export const defaultDatabaseWarnings = initialValidation.warnings;
