---
name: extract-financial-model
description: Convert analyst financial-model workbooks, lossless workbook IR, CSV exports, or structured model JSON into a canonical model-db.json plus extraction-report.md. Use when Codex must extract metrics, observations, formulas, hierarchy, assumptions, decisions, and source lineage from a financial model without treating spreadsheet layout as canonical identity.
---

# Extract Financial Model

Convert a financial model into the repository's canonical semantic database. Preserve uncertainty and source lineage; never invent analyst rationale.

## Required references

Before extracting, read:

- [references/extraction-contract.md](references/extraction-contract.md) for mapping, evidence, ID, and report rules.
- `../../schema/model-db.schema.json` for the portable contract.
- `../../src/model-db/schema.ts` only when implementing or debugging repository code.

Treat `schema.ts` as the contract authority. The JSON Schema is generated from it.

## Workflow

1. Preserve the input.
   - Record every input file, URI, and SHA-256 hash.
   - Do not execute VBA, macros, embedded scripts, external links, or workbook code.
   - Use a lossless parser or intermediate representation that preserves raw values, formulas, styles, comments, hidden state, named ranges, and external references.

2. Inventory before mapping.
   - List sheets, tables, named ranges, hidden rows/columns/sheets, formulas, comments, and external references.
   - Identify candidate actual/estimate boundaries and model versions.
   - Record gaps in the input representation before making semantic claims.

3. Build semantic objects.
   - Separate metric definitions from period-specific observations.
   - Represent companies, segments, products, and geographies as entities.
   - Treat indentation, position, color, and font as extraction signals only.
   - Convert hierarchy into `component_of` relationships.
   - When worksheet section labels and reading order are explicit, preserve them as one ordered `tablePresentations` entry for the model. Reference metric IDs and retain the source range; never make a row or cell the metric identity.
   - If grouping is ambiguous, omit the presentation metadata and create an open `presentation` unresolved item instead of inventing a polished layout. Never omit both: the validator treats an unacknowledged fallback as an error.
   - Never use a cell, row, column, block, display label, or current view as a stable object ID.

4. Translate calculations.
   - Preserve every original formula.
   - Translate supported formulas to `model-expression@0.1`.
   - Derive `dependencyMetricIds` from the parsed canonical expression.
   - Mark unsupported formulas `opaque`; preserve the original formula and materialized workbook value.
   - Mark uncertain formulas `unresolved`; do not approximate silently.

5. Separate evidence from inference.
   - Classify each observation as reported, assumption, derived, or external estimate.
   - Create assumptions or decision rationale only when supported by a source, comment, note, or transcript.
   - Add confidence, review status, source artifact, locator, and extraction run to every extracted canonical object.
   - Put every unresolved mapping or unsupported interpretation in `unresolvedItems`.

6. Emit and validate.
   - Write `model-db.json` and `extraction-report.md` next to the requested output.
   - While iterating on the database, run `npm run validate -- path/to/model-db.json` for fast object-level repair output.
   - Before reporting completion, run `npm run extraction:check -- path/to/output-directory`. This loads `model-db.json` through the viewer's runtime contract and checks that `extraction-report.md` has every required, non-empty section in contract order.
   - The checker resolves repository code relative to itself, so an agent outside the repository root may run `node /path/to/financial-model-viewer/skills/extract-financial-model/scripts/check-extraction.mjs path/to/output-directory`.
   - From the repository root, run `npm run check` after changing schema, fixtures, expressions, validator, or query code.
   - Copy every validator warning into the report and leave the corresponding unresolved item open. Do not report success while validator errors, silent presentation fallbacks, or missing-lineage objects remain.

## Output discipline

Keep raw precision in `model-db.json`; apply display rounding only in visualization code. In the report, name every unresolved item and ask a concrete analyst question. State explicitly when the input lacks enough evidence to distinguish fact, forecast, or rationale.
