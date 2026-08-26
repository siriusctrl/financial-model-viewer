import type { ModelDatabase } from "./types";
import type {
  ValidationError,
  ValidationStats,
  ValidationWarning,
} from "./validate";
import { validateModelDatabase } from "./validate";

export type ModelDatabaseImportResult =
  | {
      success: true;
      data: ModelDatabase;
      stats: ValidationStats;
      warnings: ValidationWarning[];
    }
  | {
      success: false;
      kind: "json" | "validation";
      message: string;
      errors: ValidationError[];
    };

export function parseModelDatabaseJson(text: string): ModelDatabaseImportResult {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "Unknown JSON parse error";
    return {
      success: false,
      kind: "json",
      message: `The file is not valid JSON: ${detail}`,
      errors: [],
    };
  }

  const result = validateModelDatabase(input);
  if (!result.success) {
    return {
      success: false,
      kind: "validation",
      message: `${result.errors.length} contract issue${result.errors.length === 1 ? "" : "s"} must be fixed before previewing this dataset.`,
      errors: result.errors,
    };
  }

  return {
    success: true,
    data: result.data,
    stats: result.stats,
    warnings: result.warnings,
  };
}
