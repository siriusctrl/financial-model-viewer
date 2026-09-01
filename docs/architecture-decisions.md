# Architecture decisions

## 1. One runtime contract

`src/model-db/schema.ts` owns the runtime contract. TypeScript types are inferred from it, and `schema/model-db.schema.json` is generated from it. Hand-maintaining parallel interface and JSON Schema definitions would allow extraction, validation, and visualization to drift.

The user-supplied model included `Observation.versionId` without a separate version table. The MVP keeps the requested top-level object set and makes each `Model` declare `versionIds` plus `currentVersionId`, giving the validator a concrete foreign-key boundary without inventing a second contract.

Contract `0.2.0` deliberately breaks from `0.1.0` instead of carrying a compatibility layer. Repeated point context is stored once in `observationSeries`; each point retains its own stable identity, value, period, scenario, actuality, and transformation link. Formula records are shared by canonical output/expression and retain exact period formulas in `sourceExpressions`; dependencies are derived from the parsed expression. Repeated source/run/confidence/review tuples live in `provenanceContexts`, while target locators and exceptional overrides remain on provenance links.

## 2. Semantic identity excludes layout

Spreadsheet coordinates, indentation, color, and display blocks are extraction signals. Provenance locators retain sheet/cell/range information, while optional `tablePresentations` preserve only section titles and ordered metric references for the dedicated table viewer. This metadata is non-canonical: it cannot redefine a metric, observation, relationship, or formula dependency. Metric hierarchy continues to use explicit relationships.

A model may have multiple table presentations when one canonical calculation graph spans several meaningful worksheets. Each presentation keeps its own title, source locator, sections, and reading order; the viewer selects a worksheet without splitting cross-sheet observations into fake models. Metrics are unique within one presentation and must be covered by at least one presentation across the model. Entity selection remains an independent observation dimension, which lets a peer-comparison model reuse one metric set across companies.

When presentation metadata is absent and an open presentation issue explicitly acknowledges the gap, the table query falls back to semantic hierarchy ordered by metric provenance and emits a visible review item. Unacknowledged omissions fail validation. This allows the same frontend to display SaaS and bank models with unrelated metric sets without making fallback silent.

## 3. Expressions are parsed, not executed

`model-expression@0.1` uses an expression parser to produce an AST. A validator accepts only literals, arithmetic, comparisons, conditional expressions, and approved function calls. The interpreter evaluates those nodes explicitly.

Function arity is validated before import, and `lag`/`lead` offsets must be positive integer literals. `mod(value, divisor)` follows Excel modulo semantics and rejects a zero divisor. `period_ref(metricId, periodId)` represents an exact cross-frequency reference, such as a fiscal-year total derived from four explicitly identified quarters. That lets the inspector resolve a derived observation to exact prior/current/future or named-period observations and their workbook cells instead of guessing from metric-level dependencies.

When a model contains multiple period frequencies, lagged references stay within the current observation's period type. The table exposes period type as an explicit view instead of interleaving annual and quarterly columns. Canonical transformations are already deduplicated across periods, while the cell inspector selects the exact workbook formula from `sourceExpressions` for the observation period.

Browser-local value edits use this same interpreter and the same point-in-time reference resolution as the inspector. Only non-formula numeric cells are directly writable. A reverse observation index identifies exact downstream formula cells, which are recalculated transitively and validated as one atomic working-copy mutation. Supported formula cells remain read-only; opaque formulas are never guessed or recomputed.

Member access, arbitrary identifiers/functions, arrays, assignment, loops, imports, async work, browser/network APIs, `eval`, and `new Function` are outside the language boundary.

Unsupported workbook formulas retain their original formula and materialized workbook value with `opaque` or `unresolved` status. They do not block unrelated data.

## 4. Validation is semantic and deterministic

Runtime schema parsing is necessary but insufficient. The validator separately checks global ID uniqueness, references, model versions, metric/value compatibility, expression dependencies, formula cycles, duplicate point-in-time observations, decision-change types, and provenance coverage.

Errors include object ID, field, reason, and repair direction. LLM judgment is not part of dataset validity.

The runtime contract and extraction-package checker require every open unresolved item to be named in the report with its exact attention level and every attention item to carry `currentTreatment`, `impact`, and `nextAction`. Each action additionally assigns `extraction_agent`, `model_owner`, or `source_owner`; this prevents an engineering limitation from appearing as an analyst question. Incomplete legacy guidance is rejected at import because `0.2.0` has no compatibility mode.

Confidence, human review state, and operational attention are separate axes. Confidence is evidence metadata and never sets attention priority. High-confidence AI output can remain `unreviewed` without needing an open issue. `needs_review` means the extractor emitted a useful, reversible interpretation that does not imply a workbook error and stated its assumption. The viewer may clear it only when the user confirms that exact interpretation. Every concrete possible workbook/model error or required source update uses a repair category (`source_error`, `source_update`, or `model_inconsistency`) and remains `action_required` until repaired and re-extracted. Other `action_required` items cover blocked extraction or a required human semantic choice; the extractor must not fabricate the disputed claim and the viewer cannot manually clear it. The UI renders review as a neutral-blue cue and actions as red cues. An extraction run cannot claim `completed` while either kind remains open.

## 5. Visualizations depend on queries

Components receive projections from `ModelDatabaseQueries`; they do not join JSON arrays themselves. This keeps point-in-time selection, scenario behavior, hierarchy construction, dependency expansion, and provenance resolution consistent across views.

The dependency graph derives edges by parsing canonical transformation expressions. The relationship table and JSON contract do not duplicate those calculation edges.

## 6. Static deployment for the MVP

The public viewer is a Vite static build deployed with GitHub Pages. The sample dataset is bundled at build time and validated at application startup.

This proves the contract and visualization loop without selecting a production database, API, authentication model, or collaboration system prematurely.

Users may open a local `model-db@0.2.0` JSON or gzip-compressed JSON file in the static viewer. Browser-native streams decompress gzip, then the same validator handles both inputs in memory. The accepted database replaces the sample only for the current tab. The viewer does not upload, persist, cache, or encode imported model data into the URL. This keeps local preview within the static-hosting boundary; sharing and storage remain explicitly deferred.

The static viewer may mutate an in-memory working copy: edit eligible observation values, confirm `needs_review` interpretations, update review state, recalculate supported downstream formulas, and export a validated JSON file. It cannot dismiss attention or clear `action_required`; those states require the source or extraction change named by `nextAction`. These operations do not write back to the source workbook or GitHub Pages and disappear on reload unless the user downloads the draft. Server persistence, simultaneous editors, authentication, and conflict resolution remain outside the static boundary.

Extraction agents may also compile a validated dataset into a separate local static review bundle. That build uses relative assets, embeds the dataset into the generated HTML, and is served only on `127.0.0.1` for Playwright or human inspection. It is a derivative review artifact and does not replace or modify the GitHub Pages build, deployment workflow, or public representative dataset.

## 7. Representative fixtures are not real extraction evidence

The checked-in SaaS and bank fixtures are synthetic and safe to publish. They prove cross-sector extensibility and deterministic behavior but cannot answer extraction-quality questions about a real analyst workbook.

A real authorized workbook is required to measure formula coverage, hierarchy accuracy, source gaps, analyst acceptance, and the amount of implicit knowledge Excel alone cannot resolve.

## 8. Complex XLSX extraction is sparse and explicitly mapped

Workbook inventory reads OOXML package parts directly and iterates stored cells rather than a worksheet's rectangular dimension. This avoids pathological empty-range scans, preserves formula text and cached values separately, and records comments, hidden state, media, links, and opaque binary parts without recalculation or workbook mutation.

The reusable mapped extractor consumes a private semantic map that declares stable metric IDs, source cells, periods, actual/estimate status, sections, and any supported canonical expressions. Version `0.2` normalizes two source-layout forms into one cell-assignment graph: a conventional metric row plus period columns on any named worksheet, or explicit `{sheet, cell, periodId}` assignments. These forms may coexist, so vertical series, top-of-sheet drivers, sparse helper blocks, and cross-sheet inputs do not require company-specific code. The map is the reviewable semantic decision boundary, while cell coordinates remain provenance rather than canonical identity. Pre-0.2 maps are rejected rather than carried through a legacy branch.

The extractor first attempts to translate numeric and percentage literals, restricted arithmetic and comparisons, `IF`/numeric `IFERROR`/`MOD`, multi-range `SUM`/`AVERAGE`, equal-length range `SUMPRODUCT`, and one-criterion `SUMIFS`/`AVERAGEIFS`. Semantic inputs must resolve through the explicit map; formula-free numeric cells inside declared period-header ranges may be constant-folded because those locators explicitly identify period metadata. Arbitrary unmapped cells are never folded into constants. The translator emits exact `period_ref` calls for cross-period inputs, accepts mapped cross-sheet references, follows Excel aggregate handling for blank/text inputs, converts Excel numeric `IF` conditions to explicit boolean comparisons, and compiles numeric `IFERROR` to deterministic lazy guards or its explicit fallback. It accepts every result only after deterministic replay matches the workbook's cached formula value. A source-cell blocker is initially a map-coverage problem: the extraction agent follows referenced cells transitively and expands every defensible semantic mapping before classifying a formula as opaque. A successful source-derived translation takes precedence over a generic mapped expression; the latter remains a reviewed fallback for formulas outside the restricted translator. This prevents a generic metric formula from erasing period-specific driver copies while still avoiding coordinates or unrecorded LLM guesses as canonical lineage.

Unsupported formulas keep their materialized value and exact workbook expression as opaque transformations. The extractor also emits each remaining blocker as a structured item in `formula-translation-tasks.json`. The extraction agent must inspect and classify that queue, but an ordinary extraction does not authorize silently changing the shared translator: a reusable tooling change is made only when codebase optimization is explicitly in scope. This is an agentic review loop around a deterministic safety boundary, not permission to execute source formulas or agent-authored TypeScript. Cached-value replay is necessary but does not prove a guessed semantic mapping; metric and period references must be independently defensible. Because an opaque formula has no canonical calculation lineage, the validator requires a linked open `action_required` formula item; resolving or dismissing the action while the transformation remains opaque is invalid. Missing cached values and incompatible source cell types are also `action_required` and emit no disputed observation. This enables partial but honest preview of a complex workbook without mislabeling cached-only formula values as a successful canonical import.

## 9. Workbook style meaning is extraction evidence

The sparse workbook inventory preserves compact cell-to-style references and a reusable OOXML style catalog, including theme/tint colors, fonts, fills, number formats, alignment, protection, and conditional-formatting rules. It does not copy workbook styling into canonical business objects.

The mapped extractor intentionally supports one named, exact convention, `alice-blue-yellow@0.1`, instead of a configurable style-rule language. Its accepted theme/tint/RGB encodings are code-reviewed constants. Matched roles and their resolved source styles are written to `workbook-style-evidence.json`. A source formula remains canonically derived even when formatting marks it as analyst-controlled. The convention expresses reported-source versus Alice-controlled input semantics, not actual/estimate status; actuality still comes from period evidence and never conflicts with color by definition. This keeps the known visual convention useful without turning color into a universal business rule.
