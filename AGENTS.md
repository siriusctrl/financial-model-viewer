# AGENTS.md

This file is the operating map for agents working in this repository. Keep product intent and user workflows in `README.md`, durable trade-offs in `docs/architecture-decisions.md`, extraction procedure in the project skill, and this file focused on navigation, invariants, verification, and handoff.

## Source map

- `src/model-db/schema.ts`: the only hand-maintained canonical data contract.
- `src/model-db/types.ts`: TypeScript types inferred from the runtime schema.
- `src/model-db/expressions.ts`: restricted `model-expression@0.1` parser validation and interpreter.
- `src/model-db/calculation.ts`: exact observation input/reverse-dependency resolution, local value mutation, and deterministic downstream formula propagation.
- `src/model-db/validate.ts`: deterministic schema, reference, type, cycle, uniqueness, and provenance checks.
- `src/model-db/queries.ts`: visualization-neutral query layer. UI code consumes projections from here.
- `src/model-db/attention.ts`: shared domain guard for complete attention guidance.
- `tablePresentations` in `src/model-db/schema.ts`: optional non-canonical table sections and metric order captured during extraction.
- `src/visualizations/`: table-first financial model viewer and optional dependency graph projection.
- `src/components/ObjectDetailPanel.tsx`: dismissible slide-over for object/property inspection, local value edits, and reverse lineage.
- `src/components/AttentionGuidance.tsx`: action/review explanation and guarded review confirmation.
- `src/components/AttentionCenter.tsx`: global open-attention queue and model/source navigation.
- `scripts/generate-schema.ts`: generates `schema/model-db.schema.json` from `schema.ts`.
- `scripts/generate-sample.ts`: generates and validates the representative cross-sector fixture.
- `skills/extract-financial-model/`: reusable workbook/model extraction workflow and contract.
- `skills/extract-financial-model/scripts/ooxml.py`: sparse read-only XLSX package access used by inventory and mapped extraction.
- `skills/extract-financial-model/scripts/formula_translation.py`: restricted mapped-cell arithmetic, comparisons, guarded numeric IFERROR, SUM/AVERAGE, equal-length range SUMPRODUCT, and one-criterion SUMIFS/AVERAGEIFS translation with cached-value replay across mapped periods and worksheets.
- `formula-translation-tasks.json` in a mapped extraction output: machine-readable follow-up queue for formulas that still exceed deterministic translator coverage.
- `workbook-style-evidence.json` in a mapped extraction output: non-canonical per-cell styles and matches from the fixed Alice convention.
- `skills/extract-financial-model/scripts/build-preview.mjs`: validates, compiles, and Playwright-reviews a local extraction bundle without changing GitHub Pages.
- `examples/`: generated semantic dataset and its extraction report.
- `tests/`: expression, validator, query-generality, and Playwright browser behavior.
- `.github/workflows/pages.yml`: verification and GitHub Pages deployment.

## Core invariants

- Database objects are the source of truth. Never add canonical block, row, column, indentation, or cell identity. Keep extracted table grouping and order in `tablePresentations`, where it cannot redefine metric identity.
- Standardize object and relationship rules, not company metrics. Sector-specific metrics belong in data.
- `schema.ts` is the only maintained contract. Generate JSON Schema and infer TypeScript types from it.
- Keep `Observation` point-in-time: model, metric, entity, period, scenario, actuality, as-of, and version must remain explicit.
- Never execute expressions with `eval`, `new Function`, imports, assignments, loops, property access, or browser/network APIs.
- Keep browser-local mutations atomic and schema-valid. Direct edits cannot overwrite supported or opaque formula cells; downstream propagation must use `model-expression@0.1` and exact observation references.
- Derive dependency edges from parsed transformations. Do not store duplicate `calculated_from` relationships.
- Expand defensible referenced-cell mappings before preserving a formula as `opaque`; retain its original formula and workbook materialized value, and keep an open `action_required` formula item until canonical translation succeeds.
- Every extracted canonical object requires provenance, confidence, review status, source artifact, and extraction run.
- Every attention item in a new extraction package must state `currentTreatment`, `impact`, and `nextAction`; every action must assign `extraction_agent`, `model_owner`, or `source_owner`. Only open `needs_review` items with complete guidance may be confirmed in the viewer; action-required and incomplete legacy items may not be manually cleared.
- Treat style and position as extraction signals only. Accepted mappings have no open issue; reversible assumptions use `needs_review`; blocked semantic choices or unusable source values use `action_required`.
- Visualizations consume `ModelDatabaseQueries`; do not assemble pages directly from JSON arrays.
- Keep the viewer statically buildable and company-agnostic.

## Task routing

- Schema object or enum change: update `schema.ts`, validator rules, generators, tests, JSON Schema, and fixtures together.
- Formula-language change: update `expressions.ts`, extraction contract, validator, and expression tests.
- New visualization: add a query projection first, then build the component against that result.
- Table grouping/order change: update `tablePresentations`, reference validation, extraction contract, fallback query tests, and fixtures together.
- Workbook extraction: invoke `skills/extract-financial-model/` and keep real confidential inputs outside Git.
- New model fixture: use stable semantic IDs, preserve source lineage, run the deterministic validator, and prove the existing frontend works without company-specific branches.
- Deployment or browser change: inspect Playwright and Pages workflow together.

## Verification

Run for every code or contract change:

```sh
npm run check
```

`npm run check` includes a synthetic XLSX test for sparse inventory, cached formula values, comments, and mapped extraction.

Before publishing a UI change, also run:

```sh
npm run verify:ui
npm run verify:proof
npm run verify:extraction-preview
```

Inspect desktop/mobile screenshots and `artifacts/verification/contact-sheet.png`. A successful build alone does not prove table scrolling, model switching, graph interaction, or source traceability.

For a real extraction, also run `npm run extraction:preview -- path/to/output-directory`, inspect `viewer/review/contact-sheet.png` and the individual screenshots, spot-check source cells/formulas, and confirm every open analyst question is explicit. Do not treat the automated preview result as visual acceptance.

## Documentation and handoff

- Update `README.md` when setup, public behavior, scope, publishing, or verification commands change.
- Update `docs/architecture-decisions.md` when the canonical contract, expression security boundary, query boundary, or hosting model changes.
- Update the project skill when extraction behavior or report requirements change.
- Keep generated extraction viewers local and uncommitted unless publication is explicitly authorized; the normal Pages build remains the representative public viewer.
- Report checks actually run and distinguish representative fixtures from real analyst models.
- Do not commit confidential workbooks, generated `dist/`, browser artifacts, credentials, or local caches.
- Use focused Conventional Commit messages.
