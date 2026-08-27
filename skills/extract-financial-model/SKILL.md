---
name: extract-financial-model
description: Convert analyst financial-model workbooks, lossless workbook IR, CSV exports, or structured model JSON into a canonical model-db.json plus extraction-report.md, then compile and visually review the result in the dedicated viewer. Use when Codex must extract or refine metrics, observations, formulas, hierarchy, assumptions, decisions, source lineage, and table presentation without treating spreadsheet layout as canonical identity.
---

# Extract Financial Model

Convert a financial model into the repository's canonical semantic database. Preserve uncertainty and source lineage; never invent analyst rationale.

## Required references

Before extracting, read:

- [references/extraction-contract.md](references/extraction-contract.md) for mapping, evidence, ID, and report rules.
- [references/mapped-workbook.md](references/mapped-workbook.md) when a complex workbook needs an explicit semantic map.
- [references/visual-review.md](references/visual-review.md) before compiling or visually reviewing an extraction.
- `../../schema/model-db.schema.json` for the portable contract.
- `../../src/model-db/schema.ts` only when implementing or debugging repository code.

Treat `schema.ts` as the contract authority. The JSON Schema is generated from it.

## Workflow

1. Preserve the input.
   - Record every input file, URI, and SHA-256 hash.
   - Do not execute VBA, macros, embedded scripts, external links, or workbook code.
   - Use a lossless parser or intermediate representation that preserves raw values, formulas, styles, comments, hidden state, named ranges, and external references.

2. Inventory before mapping.
   - For XLSX input, run `python3 skills/extract-financial-model/scripts/inventory-workbook.py workbook.xlsx --out inventory.json`. It reads sparse stored cells directly from OOXML and reports formulas, comments, hidden state, package links, and unsupported binary/media parts without recalculation.
   - When font/fill conventions carry meaning, add `--cells style`. Resolve cells through the emitted theme, font, fill, number-format, alignment, and cell-format catalog; do not compare screen colors by eye or discard theme/tint metadata.
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
   - For a stable but complex model sheet, prefer `extract-mapped-workbook.py` plus a private explicit map over embedding company-specific branches in the reusable extractor.
   - Put workbook-specific style meanings in ordered `styleSemantics.rules` in the private map. Treat rule matches as extraction evidence, keep formulas `derived`, and emit an actuality warning when style meaning conflicts with the mapped period.

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

7. Compile and visually review.
   - Run `npm run extraction:preview -- path/to/output-directory`. This reruns the strict extraction checker, builds a local static viewer, exercises it with Playwright, and writes `viewer/review/` screenshots plus `review.json`.
   - From outside the repository, run `node /path/to/financial-model-viewer/skills/extract-financial-model/scripts/build-preview.mjs path/to/output-directory`; the script resolves the repository toolchain itself.
   - Inspect `viewer/review/contact-sheet.png` and the individual desktop/mobile table, inspector, and dependency-graph screenshots with an image-viewing tool. An automated pass is not visual acceptance.
   - Fix extraction data when the UI faithfully exposes wrong grouping, order, period, unit, source, or lineage. Fix repository query/UI code only when correct data is projected incorrectly; then run the repository checks and rebuild the preview.
   - Rerun until both the extraction checker and visual review pass. Never edit compiled `viewer/` files by hand.
   - For deeper interaction, run `npm run extraction:serve -- path/to/output-directory/viewer` and use Playwright against the printed localhost URL.

## Output discipline

Keep raw precision in `model-db.json`; apply display rounding only in visualization code. In the report, name every unresolved item and ask a concrete analyst question. State explicitly when the input lacks enough evidence to distinguish fact, forecast, or rationale. Treat `viewer/` as a generated local review artifact: do not commit or publish it, especially when inputs are confidential, unless the user explicitly authorizes publication.
