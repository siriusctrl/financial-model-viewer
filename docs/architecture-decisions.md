# Architecture decisions

## 1. One runtime contract

`src/model-db/schema.ts` owns the runtime contract. TypeScript types are inferred from it, and `schema/model-db.schema.json` is generated from it. Hand-maintaining parallel interface and JSON Schema definitions would allow extraction, validation, and visualization to drift.

The user-supplied model included `Observation.versionId` without a separate version table. The MVP keeps the requested top-level object set and makes each `Model` declare `versionIds` plus `currentVersionId`, giving the validator a concrete foreign-key boundary without inventing a second contract.

## 2. Semantic identity excludes layout

Spreadsheet coordinates, indentation, color, and display blocks are extraction signals. Provenance locators retain sheet/cell/range information, while optional `tablePresentations` preserve only section titles and ordered metric references for the dedicated table viewer. This metadata is non-canonical: it cannot redefine a metric, observation, relationship, or formula dependency. Metric hierarchy continues to use explicit relationships.

When presentation metadata is absent and an open presentation issue explicitly acknowledges the gap, the table query falls back to semantic hierarchy ordered by metric provenance and emits a warning. Unacknowledged omissions fail validation. This allows the same frontend to display SaaS and bank models with unrelated metric sets without making fallback silent.

## 3. Expressions are parsed, not executed

`model-expression@0.1` uses an expression parser to produce an AST. A validator accepts only literals, arithmetic, comparisons, conditional expressions, and approved function calls. The interpreter evaluates those nodes explicitly.

Function arity is validated before import, and `lag`/`lead` offsets must be positive integer literals. That lets the inspector resolve a derived observation to the exact prior/current/future period observations and their workbook cells instead of guessing from metric-level dependencies.

When a model contains multiple period frequencies, lagged references stay within the current observation's period type. The table exposes period type as an explicit view instead of interleaving annual and quarterly columns. Metric-level dependency graphs deduplicate equivalent period-specific transformations, while the cell inspector retains the exact transformation and workbook formula for each observation.

Member access, arbitrary identifiers/functions, arrays, assignment, loops, imports, async work, browser/network APIs, `eval`, and `new Function` are outside the language boundary.

Unsupported workbook formulas retain their original formula and materialized workbook value with `opaque` or `unresolved` status. They do not block unrelated data.

## 4. Validation is semantic and deterministic

Runtime schema parsing is necessary but insufficient. The validator separately checks global ID uniqueness, references, model versions, metric/value compatibility, expression dependencies, formula cycles, duplicate point-in-time observations, decision-change types, and provenance coverage.

Errors include object ID, field, reason, and repair direction. LLM judgment is not part of dataset validity.

The extraction-package checker also requires every open unresolved item to be named in the report. A valid database with an incomplete warning handoff is not a valid extraction package.

## 5. Visualizations depend on queries

Components receive projections from `ModelDatabaseQueries`; they do not join JSON arrays themselves. This keeps point-in-time selection, scenario behavior, hierarchy construction, dependency expansion, and provenance resolution consistent across views.

The dependency graph derives edges from transformation dependencies. The relationship table does not duplicate those calculation edges.

## 6. Static deployment for the MVP

The public viewer is a Vite static build deployed with GitHub Pages. The sample dataset is bundled at build time and validated at application startup.

This proves the contract and visualization loop without selecting a production database, API, authentication model, or collaboration system prematurely.

Users may open a local `model-db@0.1.0` JSON file in the static viewer. The browser reads and validates the file in memory, and the accepted database replaces the sample only for the current tab. The viewer does not upload, persist, cache, or encode imported model data into the URL. This keeps local preview within the static-hosting boundary; sharing and storage remain explicitly deferred.

Extraction agents may also compile a validated dataset into a separate local static review bundle. That build uses relative assets, embeds the dataset into the generated HTML, and is served only on `127.0.0.1` for Playwright or human inspection. It is a derivative review artifact and does not replace or modify the GitHub Pages build, deployment workflow, or public representative dataset.

## 7. Representative fixtures are not real extraction evidence

The checked-in SaaS and bank fixtures are synthetic and safe to publish. They prove cross-sector extensibility and deterministic behavior but cannot answer extraction-quality questions about a real analyst workbook.

A real authorized workbook is required to measure formula coverage, hierarchy accuracy, source gaps, analyst acceptance, and the amount of implicit knowledge Excel alone cannot resolve.

## 8. Complex XLSX extraction is sparse and explicitly mapped

Workbook inventory reads OOXML package parts directly and iterates stored cells rather than a worksheet's rectangular dimension. This avoids pathological empty-range scans, preserves formula text and cached values separately, and records comments, hidden state, media, links, and opaque binary parts without recalculation or workbook mutation.

The reusable mapped extractor consumes a private semantic map that declares stable metric IDs, source rows, period columns, actual/estimate status, sections, and any supported canonical expressions. The map is the reviewable semantic decision boundary. Company-specific rows never become branches in repository code, and cell coordinates remain provenance rather than canonical identity.

Unsupported formulas keep their materialized value and exact workbook expression as opaque transformations. Missing cached values, incompatible source cell types, and untranslated formula families create explicit unresolved items. This enables partial but honest extraction of a complex workbook without pretending to be a lossless Excel execution engine.
