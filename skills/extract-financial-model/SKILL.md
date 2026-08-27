---
name: extract-financial-model
description: Convert analyst financial-model workbooks, lossless workbook IR, CSV exports, or structured model JSON into a canonical model-db.json plus extraction-report.md, then compile and visually review the result in the dedicated viewer. Use when Codex must extract or refine metrics, observations, formulas, hierarchy, assumptions, decisions, source lineage, and table presentation across grid, vertical, driver-block, or cross-sheet layouts; distinguish accepted mappings, reviewable assumptions, required actions, and extractor coverage gaps without treating spreadsheet layout as canonical identity.
---

# Extract Financial Model

Convert a financial model into the repository's canonical semantic database. Preserve uncertainty and source lineage; never invent analyst rationale.

## Required references

Before extracting, read:

- [references/extraction-contract.md](references/extraction-contract.md) for mapping, evidence, ID, and report rules.
- [references/mapping-judgment.md](references/mapping-judgment.md) before deciding that a cell is ambiguous, opaque, reviewable, or blocked.
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
   - Distinguish workbook ambiguity from tool/map coverage. An unsupported current map is not evidence that the workbook concept is invalid.

3. Build the semantic cell graph and objects.
   - Start with the requested outputs, follow their formula references transitively, and map the referenced-cell closure. Inputs may be above the visible table, arranged vertically, hidden, or located on another worksheet.
   - Separate metric definitions from period-specific observations.
   - Represent companies, segments, products, and geographies as entities.
   - Treat indentation, position, color, and font as extraction signals only.
   - Convert hierarchy into `component_of` relationships.
   - When worksheet section labels and reading order are explicit, preserve them as one ordered `tablePresentations` entry for the model. Reference metric IDs and retain the source range; never make a row or cell the metric identity.
   - If grouping is ambiguous, omit the presentation metadata and create an open `presentation` unresolved item instead of inventing a polished layout. Never omit both: the validator treats an unacknowledged fallback as an error.
   - Never use a cell, row, column, block, display label, or current view as a stable object ID.
   - For a stable but complex workbook, prefer `extract-mapped-workbook.py` plus a private explicit map over embedding company-specific branches in the reusable extractor. Use `financial-model-workbook-map@0.2` for new work: retain row/column mapping for genuine grids (optionally naming another worksheet on the metric) and use per-metric `cells` for arbitrary layouts.
   - For the confirmed Alice workbook convention only, set `styleConvention: alice-blue-yellow@0.1` in the private map. Do not add configurable color rules: the extractor matches only the exact source color encodings documented in `references/mapped-workbook.md`. Treat matches as source/adjustability evidence, keep formulas `derived`, and never infer actual/estimate status from this convention.
   - Inspect comments while closing the semantic cell graph. Attach comments on mapped, in-scope source cells as evidence; map a commented driver when its role is material and defensible. Keep out-of-scope comments preserved in `workbook-inventory.json` and summarize their count in the report—do not create a blanket analyst question for every comment outside the selected graph.
   - Put deliberately excluded worksheets and blocks in the map's extraction `scope` and inventory, not in unresolved items. Create attention only when the omission prevents the requested output or hides a real semantic decision.

4. Translate calculations.
   - Preserve every original formula.
   - Translate supported formulas to `model-expression@0.1`. For mapped XLSX files, let the deterministic translator convert numeric/percentage literals, basic arithmetic and comparisons, restricted `IF`/`MOD`, and `SUM`/`AVERAGE` calls only when semantic inputs have canonical metric/period metadata and cached-value replay matches; cross-period inputs must use exact `period_ref` references. Formula-free numeric cells inside the declared `periodHeaderRange` may be constant-folded, but arbitrary unmapped cells may not. Mapped blank references follow Excel numeric coercion (`0` in arithmetic and `SUM`, excluded from `AVERAGE`).
   - Inspect the exact blocker before accepting `opaque`. If referenced cells have defensible semantics, extend the explicit cell map and retry. Do not turn a map-coverage or translator-coverage gap into an analyst question.
   - Treat an otherwise supported legacy-grid formula blocked only by missing period columns as an extraction-map defect. Add the explicit source periods, rerun extraction, and verify the inputs.
   - Derive `dependencyMetricIds` from the parsed canonical expression.
   - After every mapped extraction, open `formula-translation-tasks.json`. For each item, inspect the formula and named source cell, then prefer a reusable extension to the restricted translator plus replay tests. Rerun extraction until the task queue is empty. A task may remain only after a genuine safe-language or source-semantics blocker is documented; never treat the first unsupported-function result as final.
   - Mark a genuinely unsupported formula `opaque`; preserve the original formula and materialized workbook value, and create an open `action_required` formula item. Opaque means canonical ingestion is incomplete, not merely “worth reviewing”; the action cannot be resolved or dismissed while the transformation remains opaque. Never generate or execute arbitrary TypeScript/JavaScript as the fallback—the agent translates into the reviewed restricted language or improves the deterministic translator.
   - Mark uncertain formulas `unresolved`; do not approximate silently.

5. Separate evidence from inference.
   - Classify each observation as reported, assumption, derived, or external estimate.
   - Create assumptions or decision rationale only when supported by a source, comment, note, or transcript.
   - Add confidence, review status, source artifact, locator, and extraction run to every extracted canonical object.
   - Do not create an unresolved item for a high-confidence mapping that passed deterministic checks. This is the accepted state even when provenance remains `unreviewed`.
   - Use `attentionLevel: needs_review` for a useful, explicit, reversible assumption. Emit the provisional object and state the assumption.
   - Use `attentionLevel: action_required` when a semantic decision, source repair, or engineering fix is required before canonical ingestion succeeds. Do not emit a disputed value or invented interpretation; an opaque cached value may remain only as explicit preview material.
   - For every attention item, write `description` (what was found), `currentTreatment` (what the database emitted or omitted), `impact` (what may be wrong or unavailable), and `nextAction` (one concrete confirmation or repair instruction). Put these fields in `model-db.json`, not only the report.
   - Confidence, provenance review status, and attention level are independent; follow the decision table in `mapping-judgment.md`.

6. Emit and validate.
   - Write `model-db.json`, `extraction-report.md`, and `formula-translation-tasks.json` next to the requested output.
   - While iterating on the database, run `npm run validate -- path/to/model-db.json` for fast object-level repair output.
   - Before reporting completion, run `npm run extraction:check -- path/to/output-directory`. This loads `model-db.json` through the viewer's runtime contract and checks that `extraction-report.md` has every required, non-empty section in contract order.
   - The checker resolves repository code relative to itself, so an agent outside the repository root may run `node /path/to/financial-model-viewer/skills/extract-financial-model/scripts/check-extraction.mjs path/to/output-directory`.
   - From the repository root, run `npm run check` after changing schema, fixtures, expressions, validator, or query code.
   - Label every open report item `NEEDS REVIEW` or `ACTION REQUIRED`. The strict package checker rejects any emitted attention item without `currentTreatment`, `impact`, or `nextAction`. Keep the extraction run `completed_with_issues` while either kind remains open. Do not report success while validator errors, silent presentation fallbacks, or missing-lineage objects remain.

7. Compile and visually review.
   - Run `npm run extraction:preview -- path/to/output-directory`. This reruns the strict extraction checker, builds a local static viewer, exercises it with Playwright, and writes `viewer/review/` screenshots plus `review.json`.
   - From outside the repository, run `node /path/to/financial-model-viewer/skills/extract-financial-model/scripts/build-preview.mjs path/to/output-directory`; the script resolves the repository toolchain itself.
   - Inspect `viewer/review/contact-sheet.png` and the individual desktop/mobile table, inspector, and dependency-graph screenshots with an image-viewing tool. An automated pass is not visual acceptance.
   - Fix extraction data when the UI faithfully exposes wrong grouping, order, period, unit, source, or lineage. Fix repository query/UI code only when correct data is projected incorrectly; then run the repository checks and rebuild the preview.
   - Rerun until both the extraction checker and visual review pass. Never edit compiled `viewer/` files by hand.
   - For deeper interaction, run `npm run extraction:serve -- path/to/output-directory/viewer` and use Playwright against the printed localhost URL.

## Output discipline

Keep raw precision in `model-db.json`; apply display rounding only in visualization code. In the report, name every attention item, its worksheet/cell, current treatment, impact, and the one instruction needed next under `Questions and next actions`. Label translator limitations as engineering follow-up and consume the corresponding `formula-translation-tasks.json` items before final handoff. Ask an analyst only about genuine source ambiguity or source defects—not about limitations the extraction agent can resolve by expanding the map or code. New private maps should use `nextAction`; `analystQuestion` remains a legacy alias. Treat `viewer/` as a generated local review artifact: do not commit or publish it, especially when inputs are confidential, unless the user explicitly authorizes publication.
