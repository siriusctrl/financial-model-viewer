# Ledgerglass

A dedicated viewer for turning analyst financial models into a validated semantic database, then inspecting the result as a compact financial table with formulas, lineage, provenance, and explicit review items.

**Public viewer:** <https://siriusctrl.github.io/ledgerglass/>

The project is intentionally narrower than Excel: it does not execute macros, provide full Excel calculation compatibility, or act as a collaborative production database.

## Quick start

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

For a production build:

```sh
npm run build
```

## Use the viewer

Select **Upload JSON** in the public or local viewer and choose a validated `model-db@0.3.0` `.json` or `.json.gz` file. Both contain the same contract; gzip only reduces transfer and storage size. The browser decompresses and validates the selected file locally, without sending it to a server, persisting it, or placing the model in the URL. Invalid files do not replace the current model. Pre-0.3 files are rejected rather than migrated implicitly.

The primary model table supports:

- annual and quarterly period views;
- worksheet/view switching for models that span multiple source pages;
- entity switching for peer and portfolio-style datasets;
- cell inspection with workbook source, confidence, and extraction run;
- direct and reverse formula lineage with automatic cross-view cell navigation and inspector back history;
- browser-local input edits with deterministic downstream recalculation, Undo/Redo controls, and standard keyboard shortcuts;
- dark and light appearances;
- compact gzip JSON export of the local working copy.

Open attention is grouped into two explicit states:

- `needs_review`: the extraction contains a stated, reversible interpretation. It can be confirmed only when `currentTreatment`, `impact`, and `nextAction` are present.
- `action_required`: canonical ingestion is incomplete or blocked. The viewer says whether the extraction agent, model owner, or source owner must handle it; only model/source-owned actions require user coordination. It cannot be cleared in the viewer—fix the named cause and import the corrected database.

Possible workbook/model errors and required source updates are always `action_required` until repaired and re-extracted. Confidence describes the supporting evidence only; it does not set priority or downgrade repair work.

## Extract and preview a workbook

The reusable workflow lives in [`skills/extract-financial-model/`](skills/extract-financial-model/). It defines mapping judgment, provenance requirements, formula translation, attention levels, and the required extraction report.

Inventory an XLSX package without opening Excel or recalculating formulas:

```sh
npm run workbook:inventory -- model.xlsx --out inventory.json
```

Extract a workbook using an explicit semantic map:

```sh
npm run workbook:extract -- model.xlsx extraction-map.json output-directory
```

Every extraction package must contain at least:

```text
model-db.json
extraction-report.md
```

The mapped XLSX extractor writes a complete five-file bundle by also preserving `workbook-inventory.json`, `workbook-style-evidence.json`, and `formula-translation-tasks.json`. Other extraction paths must include the translation-task file whenever an opaque formula remains.

Validate the complete package, then compile it into a local static viewer and run the Playwright review loop:

```sh
npm run extraction:check -- output-directory
npm run extraction:preview -- output-directory
```

The preview command writes `output-directory/viewer/` with portable static assets, screenshots, a contact sheet, and `review/review.json`. Inspect those artifacts before accepting a real extraction; an automated pass is not visual approval.

For further local browser or Playwright interaction:

```sh
npm run extraction:serve -- output-directory/viewer
```

The server binds to `127.0.0.1`. Keep confidential workbooks, extracted datasets, and generated viewers outside Git unless publication is explicitly authorized. Delivered extraction bundles use a privacy-safe source label and content hash; they omit workbook/comment authors, creator metadata, and local source paths.

## Validation and verification

Validate one database directly:

```sh
npm run validate -- path/to/model-db.json
```

Run the required repository checks after code or contract changes:

```sh
npm run check
```

Before publishing UI changes, also run:

```sh
npm run verify:ui
npm run verify:proof
npm run verify:extraction-preview
```

Browser screenshots and contact sheets are written under the ignored `artifacts/` directory.

## Repository guide

- [`src/model-db/schema.ts`](src/model-db/schema.ts) is the only hand-maintained canonical contract.
- [`src/model-db/`](src/model-db/) contains validation, expressions, calculations, queries, and inferred types.
- [`src/visualizations/`](src/visualizations/) contains the compact financial table projection.
- [`skills/extract-financial-model/`](skills/extract-financial-model/) contains the extraction procedure and tools.
- [`examples/`](examples/) contains synthetic cross-sector fixtures, not real investment research.
- [`docs/architecture-decisions.md`](docs/architecture-decisions.md) records durable contract, security, query, and hosting decisions.
