# Explicit workbook maps

Use an explicit workbook map when a workbook cannot be extracted safely through label inference alone. The map records semantic decisions; the extractor only reads declared cells and never invents metric identity from coordinates. A workbook does not need to use one rectangular model sheet.

Run:

```sh
python3 skills/extract-financial-model/scripts/inventory-workbook.py model.xlsx --out inventory.json
python3 skills/extract-financial-model/scripts/inventory-workbook.py model.xlsx --cells style --out style-inventory.json
python3 skills/extract-financial-model/scripts/extract-mapped-workbook.py model.xlsx extraction-map.json output-directory
```

Use `format: financial-model-workbook-map@0.4` for every map; older maps are rejected rather than migrated. The `row` mapping mode remains available for genuine grids. Provide:

- canonical `dataset`, `model`, `entity`, `scenarios`, `sourceArtifact`, and `extractionRun` objects;
- a default `sheet`, plus `modelRange` and `periodHeaderRange` locators; each locator may be a compact string or an object containing `sheet` and `cell`/`range`; multi-worksheet maps may additionally provide a non-empty `periodHeaderRanges` array, with `periodHeaderRange` retained as the primary locator;
- explicit periods with semantic ID, label, type, header cell, date range, and actuality; include `column` only when grid metrics use it;
- `hierarchyReviewed: true`, a top-level sparse `componentParentIds` object, and a sparse `metricParentIds` object on every section; use `{}` when a reviewed hierarchy has no edges;
- ordered sections with stable section IDs and mapped metrics;
- optional `presentations`, each with stable `id`, `title`, `sectionIds`, and optional range `sourceLocator`; every mapped section must be assigned exactly once when this array is present;
- for each metric, a stable ID, semantic name, label-cell locator, type, unit, and exactly one source mapping mode:
  - `row` for a genuine metric-row by period-column grid, optionally with `sheet` when the row is on another worksheet; or
  - `cells`, an array of `{sheet?, cell, periodId, confidence?}` entries for vertical series, top-of-sheet drivers, helper blocks, sparse layouts, and cross-sheet inputs;
- optional canonical expression/dependencies; use `canonicalExpressions` keyed by period type when annual and quarterly formulas require different lag semantics;
- the evidence supporting the actual/estimate boundary and any open attention items.

Every mapped attention item must include `description`, `currentTreatment`, `impact`, and `nextAction`. Every `action_required` item must also use `actionOwner: extraction_agent | model_owner | source_owner`, so the viewer can distinguish an internal extraction follow-up from a genuine model decision or source repair. The extractor preserves these fields in `model-db.json` and fails instead of generating a vague default. The removed `analystQuestion` field is rejected.

Grid and explicit-cell metrics may coexist. Every emitted metric must belong to at least one ordered presentation section. A model may expose multiple worksheet presentations; a metric must be unique within each presentation but may intentionally appear in more than one view. Map each non-root display metric to a prior metric in its section's `metricParentIds`. Map each genuine semantic component to its parent in top-level `componentParentIds`. Omitted keys are reviewed roots because `hierarchyReviewed: true` is mandatory. Display and semantic parents may differ, and neither may be inferred from the other's existence.

Hierarchy excerpt:

```json
{
  "format": "financial-model-workbook-map@0.4",
  "hierarchyReviewed": true,
  "componentParentIds": {
    "metric_acme_subscription_revenue": "metric_acme_revenue"
  },
  "sections": [{
    "id": "section_revenue",
    "title": "Revenue",
    "sourceRange": "A10:F20",
    "metricParentIds": {
      "metric_acme_subscription_revenue": "metric_acme_revenue"
    },
    "metrics": [
      {
        "id": "metric_acme_revenue",
        "name": "Revenue",
        "labelCell": "A10",
        "dataType": "currency",
        "row": 10
      },
      {
        "id": "metric_acme_subscription_revenue",
        "name": "Subscription revenue",
        "labelCell": "A11",
        "dataType": "currency",
        "row": 11
      }
    ]
  }]
}
```

When the confirmed Alice formatting convention applies, add `styleConvention: alice-blue-yellow@0.1`. This is a fixed convention, not a configurable rule engine. It recognizes only these exact OOXML source encodings:

- blue font: theme 4 without tint, theme 4 with tint `-0.499984740745262`, theme 8 without tint, or direct RGB `FF0070C0`;
- pure yellow fill: solid pattern with direct RGB `FFFFFF00`.

Yellow-fill blue-font cells are classified as `alice_hardcode`. Other blue-font literals are `reported_source`; other fills have no meaning. The extractor writes a deduplicated selected-style catalog plus every selected cell's style reference, matched role, formula/literal kind, and canonical target to `workbook-style-evidence.json`. Formula cells remain `derived` even when the convention marks them as Alice-controlled. These roles describe source and adjustability, not actual/estimate status. Unknown conventions and the removed `styleSemantics` rule structure fail extraction before any output is accepted.

For the fictional Example Analyst formatting sample, use `styleConvention: financial-model-colors-example@0.1`. It recognizes only these exact observed encodings:

- pale yellow fills: theme 7 with tint `0.7999816888943144`, direct RGB `FFFFFF99`, or direct RGB `FFFFFFCC`;
- blue fonts: theme 4 without tint, or theme 8 with tint `-0.249977111117893`;
- green fonts: direct RGB `FF008080` or `FF5EC271`; green marker borders use indexed color 17.

A yellow literal is `assumption_input`; a blue literal with no fill is `reported_hardcode`; and a green-font or green-border formula is `cross_sheet_reference` only when the formula itself contains an explicit worksheet reference. Green is positive evidence, not an exhaustive test: default/black formulas may still cross sheets. Formula presence always wins over yellow or blue styling and keeps the observation `derived`.

Use a neutral convention name even when formatting was learned from a real workbook. Do not put a real author or organization in convention IDs, role IDs, code constants, descriptions, or tests. `alice-blue-yellow@0.1` is retained only as a legacy exception; do not copy that naming pattern.

For every mapped formula, the extractor first attempts a deterministic translation of numeric and percentage literals, `+`, `-`, `*`, `/`, comparisons, restricted `IF`/numeric `IFERROR`/`MOD`, `SUM`/`AVERAGE` including multiple ranges, equal-length range-only `SUMPRODUCT`, and one-criterion `SUMIFS`/`AVERAGEIFS`. Every semantic reference must resolve through either a grid mapping or an explicit cell mapping. Formula-free numeric cells inside explicitly declared `periodHeaderRange`/`periodHeaderRanges` may be constant-folded; other unmapped cells may not. A layout `INDIRECT(ADDRESS(ROW(), <index cell>))` pair resolves to the concrete same-row reference it names, but only when that index cell also sits inside a declared `periodHeaderRange`/`periodHeaderRanges` locator and holds a positive integer column number; any other `INDIRECT` remains an unsupported-function blocker. Omitted Excel arguments (`SUM(A1,,B1)`) are numeric zero. The one additional header-only exception is an exact `RIGHT(period_header, n)="text"` comparison: when its cell belongs to a declared period-header range, the cached header value may select a static `IF` branch for that fixed period, and the selected branch must still replay. Same-period inputs compile to `ref`; cross-period inputs compile to `period_ref(metricId, periodId)`. Mapped cross-sheet references are supported. Mapped or materially blank references—including absent sparse OOXML cells on a known worksheet—follow Excel numeric semantics: arithmetic and `SUM` use zero, while `AVERAGE` excludes blanks. Excel aggregates ignore referenced text values, and a numeric `IFERROR` may select its explicit fallback for a deterministically nonnumeric primary; both cases still require exact cached-value replay. Numeric Excel `IF` conditions compile to explicit boolean comparisons. Numeric `IFERROR` arithmetic with possible division by zero compiles to lazy conditional guards using the source fallback; a non-failing primary may be unwrapped only when it independently replays. The extractor replays the translated expression using workbook cached values and accepts it only when the result matches the formula cell's cached value. This exact source-derived lineage takes precedence over a generic metric-level `canonicalExpression`, which remains a reviewed fallback for formulas outside the deterministic subset.

For row/column grid mappings, an otherwise supported formula that references only unmapped period columns still fails with the formula worksheet, target cell, and missing source cells. This is an incomplete private map, not an analyst ambiguity. Add explicit cells when a referenced input does not fit the grid.

Do not accept the first `unmapped_cells`, `unmapped_sheet`, or unsupported-function blocker as final. Inspect the named cells, extend the private semantic map when their roles are defensible, and rerun until referenced-cell closure converges. The extractor writes every remaining opaque blocker to `formula-translation-tasks.json`. Inspect and classify every task. If syntax remains outside the safe language, preserve the exact formula and materialized value as `opaque` with an open `action_required` item owned by `extraction_agent`; do not silently patch the shared translator unless tooling improvement is explicitly in scope. Opaque is an incomplete canonical import; cached values may be previewed, but the action cannot be resolved or dismissed until translation succeeds. Never execute arbitrary TypeScript/JavaScript as a fallback. A formula with no cached value emits no fabricated observation and creates an `action_required` item. Comments attached to selected observation cells become evidence linked to those observations. Material comments on in-scope drivers should lead to mapping those drivers; comments outside the selected semantic graph remain complete in `workbook-inventory.json` and are counted in the report.

Human-facing attention items must print the mapped worksheet plus the narrowest cell or range. They must also separate the current database treatment, affected scope, and exact next step so the viewer can explain the decision without exposing raw validator prose. Cross-sheet blockers must name every referenced worksheet and cell that needs mapping. Retaining that information only in a machine-readable locator is insufficient. A blank or absent explicitly mapped output is a `source_error` action, not a silent skip; remove the point from the private map only when the blank is intentional. Missing cached formula values and incompatible mapped values are also `source_error` actions.

The extraction CLI immediately runs the repository's strict runtime-schema, semantic, provenance, presentation, and report checks. It exits nonzero instead of printing `EXTRACTED` when the package is invalid. It automatically changes a supplied `completed` run to `completed_with_issues` when attention items remain open. Reports must distinguish `NEEDS REVIEW` from `ACTION REQUIRED`; comments outside the selected graph and deliberate scope exclusions remain visible in inventory/report evidence without becoming synthetic attention items.

The mapped extractor always writes a five-file bundle: canonical data in `model-db.json`, human review context in `extraction-report.md`, lossless source evidence in `workbook-inventory.json`, selected style evidence in `workbook-style-evidence.json`, and remaining deterministic translation work in `formula-translation-tasks.json`. The last file is present even when its `items` array is empty.

Keep model-specific maps beside private extraction output, not in this repository. The reusable extractor must remain company-agnostic.
