# Financial Model Semantic Database & Viewer

A runnable MVP for turning implicit knowledge in analyst financial models into a validated semantic database, then projecting the same data into a financial table, dependency graph, and source-lineage viewer.

**Public viewer:** <https://siriusctrl.github.io/financial-model-viewer/>

```text
Analyst workbook / lossless model IR
  → AI extraction skill
  → canonical TypeScript runtime schema
  → deterministic validator
  → query layer
  → dedicated table viewer + lineage inspector
```

This project tests a product direction. It does not replace Excel, execute workbook macros, or provide a production database/editor.

## What the MVP proves

- A runtime schema can represent models, entities, company-specific metrics, point-in-time observations, transformations, relationships, evidence, assumptions, decisions, lineage, extraction runs, unresolved mappings, and lean table presentation metadata.
- TypeScript types and portable JSON Schema come from one runtime contract.
- A restricted expression interpreter can evaluate supported formulas without `eval` or arbitrary JavaScript.
- A deterministic validator can report broken references, value-type mismatches, dependency cycles, duplicate points, unsupported syntax, and missing provenance with object-level repair guidance.
- Every open unresolved item remains a visible review warning, with affected metric/cell cues when a target is known.
- Mixed-frequency models expose explicit annual/quarterly period views, and lagged lineage resolves within the selected period type.
- The same query layer and frontend render a SaaS model and a structurally different bank model without company-specific UI branches.
- A user can move from a forecast number to its metric, formula, source workbook cell, confidence, review status, and extraction run.

## Repository map

```text
financial-model-viewer/
├── src/
│   ├── model-db/                    # schema, inferred types, expressions, queries, validator
│   ├── visualizations/              # financial table and dependency graph
│   └── components/                  # persistent cell/property inspector
├── skills/extract-financial-model/ # reusable extraction workflow
├── schema/model-db.schema.json      # generated portable JSON Schema
├── examples/                        # validated cross-sector semantic fixture
├── scripts/                         # deterministic generators and browser proof
├── tests/                           # unit, generality, and Playwright checks
└── docs/                            # durable architecture/product boundaries
```

`src/model-db/schema.ts` is the only hand-maintained data contract. `types.ts` uses `z.infer`, while `schema/model-db.schema.json` is generated with Zod's JSON Schema converter.

## Data model principles

The canonical database stores what exists, what was observed, how metrics are calculated, why an analyst changed a forecast when evidence exists, and where each extracted object came from.

It intentionally does **not** use spreadsheet blocks, rows, columns, indentation, or cells as business identity. Workbook coordinates appear inside provenance locators. An optional `tablePresentations` layer records section titles and metric order for the viewer without changing canonical identity. If extraction cannot defend that structure, it must create an open presentation issue: the validator emits a warning and the query layer uses a deterministic fallback. Omitting both metadata and the issue is an error.

Company and sector extensions happen by adding metrics and relationships, not by changing page layouts or introducing company-specific schema variants.

## Local development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

The Vite development server prints its local URL. The production build uses `/financial-model-viewer/` as its Pages base path.

## Preview a model database JSON file

The public and local viewers include an **Open JSON** action. Choose a `model-db@0.1.0` JSON file to validate it against the runtime schema and deterministic semantic rules, then replace the bundled sample in the current browser tab.

- Files are read locally with the browser File API and are never uploaded or persisted.
- The existing preview stays active when JSON parsing or validation fails.
- The page shows actionable object and field errors before accepting invalid data.
- Files are limited to 20 MB to keep the static browser preview responsive.

Reload the page or use **Restore bundled** to return to the dataset compiled into the viewer.

## Deterministic data workflow

Generate portable contracts and fixtures:

```sh
npm run schema:generate
npm run sample:generate
```

The generators support `--check` through their package scripts and fail when checked-in outputs are stale. Sample generation runs the deterministic validator before writing JSON.

Validate any extracted dataset with object-level repair output:

```sh
npm run validate -- path/to/model-db.json
```

Check a complete extraction package against the viewer contract and required report format:

```sh
npm run extraction:check -- path/to/output-directory
```

The output directory must contain both `model-db.json` and `extraction-report.md`. The checker uses the same runtime schema and semantic validator as the viewer, then verifies that every required report section exists, is non-empty, appears in contract order, and names every open unresolved warning.

Inventory a complex XLSX package without opening Excel, recalculating formulas, refreshing links, or scanning inflated rectangular used ranges:

```sh
npm run workbook:inventory -- model.xlsx --out inventory.json
npm run workbook:inventory -- model.xlsx --cells style --out style-inventory.json
```

For a stable but complex model sheet, create an explicit private semantic map and extract only the declared concepts:

```sh
npm run workbook:extract -- model.xlsx extraction-map.json output-directory
```

The style inventory keeps compact cell-to-style references plus reusable theme, font, fill, number-format, alignment, and cell-format catalogs. The confirmed Alice workbook convention is enabled explicitly with `styleConvention: alice-blue-yellow@0.1`; there is no configurable color-rule language. The mapped extractor writes a deduplicated selected-style catalog and per-cell audit trail to `workbook-style-evidence.json`; formulas remain derived and style/actuality conflicts become explicit warnings.

The mapped extractor also preserves exact formulas and selected comments. Numeric/percentage literals, basic arithmetic, and `SUM(range)` are translated automatically when every input cell has explicit metric/period metadata and replaying cached values reproduces the XLSX result; exact cross-period references remain inspectable in the viewer. Missing values, incompatible source types, formulas blocked by unmapped inputs or unsupported syntax, unmapped comments, and style conflicts become explicit unresolved items. The extractor automatically runs the strict package checker and exits nonzero on failure; it does not infer company-specific semantics from layout alone.

Compile the checked extraction into a local static viewer and run its Playwright review loop:

```sh
npm run extraction:preview -- path/to/output-directory
```

This writes a generated `viewer/` directory next to the extraction, with portable relative assets, the validated database embedded in HTML, and `viewer/review/` screenshots plus a machine-readable `review.json`. The Playwright pass visits every model and period-frequency view, then checks source-cell inspection, derived lineage, unresolved cues, mobile table scrolling, and mobile inspection. The automated result deliberately requires visual judgment: inspect the contact sheet and individual screenshots before accepting the extraction.

Keep the compiled bundle available for deeper Playwright or browser interaction:

```sh
npm run extraction:serve -- path/to/output-directory/viewer
```

The server binds to `127.0.0.1` and does not upload data. This is an additive local review path; the public GitHub Pages build and its bundled representative dataset remain unchanged. Do not publish a generated bundle containing confidential model data without explicit authorization.

Use `skills/extract-financial-model/` when converting a workbook, workbook IR, CSV export, or structured model input. Each extraction must produce:

```text
model-db.json
extraction-report.md
```

Real workbooks may contain confidential research. Keep inputs and generated private datasets outside this public repository unless explicitly cleared for publication.

## Verification

```sh
npm run check          # generated-contract checks, unit tests, TypeScript, production build
npm run verify:workbook-tools # synthetic sparse-XLSX inventory/extraction test
npm run verify:ui      # Chromium/WebKit, desktop/mobile behavior
npm run verify:proof   # real browser screenshots and contact sheet
npm run verify:extraction-preview # compile and review the representative extraction
```

The proof commands write local review evidence under `artifacts/`, which is intentionally ignored by Git.

## Included data

`examples/sample-model-db.json` contains two synthetic, representative fixtures:

- Northstar Cloud, a SaaS operating model;
- Harbor National, a bank model with different metrics and an explicit unresolved mapping.

They exist to prove schema, validator, query, and frontend generality. They are not real companies, not investment research, and do not satisfy the final real-workbook extraction milestone. Replace or supplement them with an authorized model using the extraction skill.

## Current scope

Implemented:

- canonical runtime schema, inferred TypeScript types, and generated JSON Schema;
- restricted expression AST validation/interpreter;
- deterministic semantic validator;
- extraction skill and contract;
- sparse read-only XLSX inventory and explicit mapped-workbook extraction;
- validated cross-sector fixture and extraction report;
- table-first model viewer, dependency graph, and persistent cell/property inspector;
- unit, cross-sector generality, browser, responsive, and visual-proof checks;
- static GitHub Pages deployment.

Deferred:

- generic company-semantic inference across arbitrary `.xlsx` layouts;
- complete canonicalization of every secondary sheet in a real analyst workbook;
- revision timeline and point-in-time reconstruction UI;
- bull/base/bear comparison;
- source → assumption → change visualization;
- persistent database/API, editing, collaboration, and permissions;
- full Excel calculation compatibility.

See [architecture decisions](docs/architecture-decisions.md) for the contract boundaries and trade-offs.
