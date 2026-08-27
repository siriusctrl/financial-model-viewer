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

When formatting has confirmed workbook-specific meaning, add ordered `styleSemantics.rules`. A rule may match `cellKinds`, `fontColors`, `fillColors`, and `excludeFillColors`; color patterns may use OOXML `theme`, `tint`, `rgb`, or `indexed` fields. Record a semantic `role`, optional canonical `valueType`, `adjustable` flag, and `expectedActuality`. Put the more specific combined rule first.

For example, a private map may classify blue font on pure yellow fill as an analyst hardcode, then classify other blue-font literals as reported inputs. The extractor writes a deduplicated selected-style catalog plus every selected cell's style reference, matched rule, formula/literal kind, canonical target, and conflicts to `workbook-style-evidence.json`. Formula cells remain `derived` even when a style role marks them as analyst-controlled. An expected-actuality mismatch becomes an explicit unresolved item. Empty matches, unknown match fields, invalid color patterns, and non-canonical value types fail extraction before any output is accepted.

If a mapped formula has no `canonicalExpression`, the extractor preserves its exact source formula and materialized value as an `opaque` transformation, then creates a visible metric-level warning. A formula with no cached value emits no fabricated observation and creates an explicit unresolved item. Comments attached to selected observation cells become evidence linked to those observations.

The extraction CLI immediately runs the repository's strict runtime-schema, semantic, provenance, presentation, and report checks. It exits nonzero instead of printing `EXTRACTED` when the package is invalid. Comments that were inventoried but did not attach to selected observations, plus style/actuality conflicts, remain explicit unresolved warnings rather than disappearing silently.

Keep model-specific maps beside private extraction output, not in this repository. The reusable extractor must remain company-agnostic.
