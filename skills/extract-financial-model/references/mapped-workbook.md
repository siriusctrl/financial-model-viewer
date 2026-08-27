# Explicit workbook maps

Use an explicit workbook map when a workbook has a stable model sheet but cannot be extracted safely through generic label inference. The map records semantic decisions; the extractor only reads declared cells and never invents metric identity from coordinates.

Run:

```sh
python3 skills/extract-financial-model/scripts/inventory-workbook.py model.xlsx --out inventory.json
python3 skills/extract-financial-model/scripts/inventory-workbook.py model.xlsx --cells style --out style-inventory.json
python3 skills/extract-financial-model/scripts/extract-mapped-workbook.py model.xlsx extraction-map.json output-directory
```

The mapping must declare `format: financial-model-workbook-map@0.1` and provide:

- canonical `dataset`, `model`, `entity`, `scenarios`, `sourceArtifact`, and `extractionRun` objects;
- `sheet`, `modelRange`, and `periodHeaderRange` source locations;
- explicit periods with semantic ID, label, type, source column/header cell, date range, and actuality;
- ordered sections with stable section IDs and mapped metrics;
- for each metric, a stable ID, semantic name, source row/label cell, type, unit, and optional canonical expression/dependencies; use `canonicalExpressions` keyed by period type when annual and quarterly formulas require different lag semantics;
- the evidence supporting the actual/estimate boundary and any open unresolved items.

When the confirmed Alice formatting convention applies, add `styleConvention: alice-blue-yellow@0.1`. This is a fixed convention, not a configurable rule engine. It recognizes only these exact OOXML source encodings:

- blue font: theme 4 without tint, theme 4 with tint `-0.499984740745262`, theme 8 without tint, or direct RGB `FF0070C0`;
- pure yellow fill: solid pattern with direct RGB `FFFFFF00`.

Yellow-fill blue-font cells are classified as `alice_hardcode`. Other blue-font literals are `reported_source`; other fills have no meaning. The extractor writes a deduplicated selected-style catalog plus every selected cell's style reference, matched role, formula/literal kind, canonical target, and conflicts to `workbook-style-evidence.json`. Formula cells remain `derived` even when the convention marks them as Alice-controlled. An actuality mismatch becomes an explicit unresolved item. Unknown conventions and the removed `styleSemantics` rule structure fail extraction before any output is accepted.

If a mapped formula has no `canonicalExpression`, the extractor preserves its exact source formula and materialized value as an `opaque` transformation, then creates a visible metric-level warning. A formula with no cached value emits no fabricated observation and creates an explicit unresolved item. Comments attached to selected observation cells become evidence linked to those observations.

The extraction CLI immediately runs the repository's strict runtime-schema, semantic, provenance, presentation, and report checks. It exits nonzero instead of printing `EXTRACTED` when the package is invalid. Comments that were inventoried but did not attach to selected observations, plus style/actuality conflicts, remain explicit unresolved warnings rather than disappearing silently.

Keep model-specific maps beside private extraction output, not in this repository. The reusable extractor must remain company-agnostic.
