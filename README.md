# Financial Model Semantic Database & Viewer

A runnable MVP for turning implicit knowledge in analyst financial models into a validated semantic database, then projecting the same data into a financial table, dependency graph, and source-lineage viewer.

**Public viewer:** <https://siriusctrl.github.io/financial-model-viewer/>

```text
Analyst workbook / lossless model IR
  → AI extraction skill
  → canonical TypeScript runtime schema
  → deterministic validator
  → query layer
  → multiple visualizations
```

This project tests a product direction. It does not replace Excel, execute workbook macros, or provide a production database/editor.

## What the MVP proves

- A runtime schema can represent models, entities, company-specific metrics, point-in-time observations, transformations, relationships, evidence, assumptions, decisions, lineage, extraction runs, and unresolved mappings.
- TypeScript types and portable JSON Schema come from one runtime contract.
- A restricted expression interpreter can evaluate supported formulas without `eval` or arbitrary JavaScript.
- A deterministic validator can report broken references, value-type mismatches, dependency cycles, duplicate points, unsupported syntax, and missing provenance with object-level repair guidance.
- The same query layer and frontend render a SaaS model and a structurally different bank model without company-specific UI branches.
- A user can move from a forecast number to its metric, formula, source workbook cell, confidence, review status, and extraction run.

## Repository map

```text
financial-model-viewer/
├── src/
│   ├── model-db/                    # schema, inferred types, expressions, queries, validator
│   ├── visualizations/              # overview, financial table, dependency graph
│   └── components/                  # object/provenance detail surface
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

It intentionally does **not** use spreadsheet blocks, rows, columns, indentation, or cells as business identity. Workbook coordinates appear only inside provenance locators.

Company and sector extensions happen by adding metrics and relationships, not by changing page layouts or introducing company-specific schema variants.

## Local development

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

The Vite development server prints its local URL. The production build uses `/financial-model-viewer/` as its Pages base path.

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

Use `skills/extract-financial-model/` when converting a workbook, workbook IR, CSV export, or structured model input. Each extraction must produce:

```text
model-db.json
extraction-report.md
```

Real workbooks may contain confidential research. Keep inputs and generated private datasets outside this public repository unless explicitly cleared for publication.

## Verification

```sh
npm run check          # generated-contract checks, unit tests, TypeScript, production build
npm run verify:ui      # Chromium/WebKit, desktop/mobile behavior
npm run verify:proof   # real browser screenshots and contact sheet
```

`verify:proof` writes local review evidence to `artifacts/verification/`, which is intentionally ignored by Git.

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
- validated cross-sector fixture and extraction report;
- model overview, financial table, dependency graph, and provenance drawer;
- unit, cross-sector generality, browser, responsive, and visual-proof checks;
- static GitHub Pages deployment.

Deferred:

- automated `.xlsx` ingestion adapters;
- a real analyst workbook dataset, pending an authorized input;
- revision timeline and point-in-time reconstruction UI;
- bull/base/bear comparison;
- source → assumption → change visualization;
- persistent database/API, editing, collaboration, and permissions;
- full Excel calculation compatibility.

See [architecture decisions](docs/architecture-decisions.md) for the contract boundaries and trade-offs.
