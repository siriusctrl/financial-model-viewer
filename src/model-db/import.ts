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

async function readTextStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Decoded model database exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function readModelDatabaseFile(
  file: File,
  maxBytes: number,
): Promise<ModelDatabaseImportResult> {
  if (file.size > maxBytes) {
    throw new Error(`Selected file exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const isGzip = signature[0] === 0x1f && signature[1] === 0x8b;
  const stream = isGzip
    ? file.stream().pipeThrough(new DecompressionStream("gzip"))
    : file.stream();
  return parseModelDatabaseJson(await readTextStream(stream, maxBytes));
}

export async function modelDatabaseGzip(database: ModelDatabase): Promise<Blob> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(database)}\n`);
  const compressed = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).blob();
}
