# Financial model extraction contract

## Contents

1. Input inventory
2. Stable identity
3. Object mapping
4. Formula translation
5. Actual and estimate boundary
6. Provenance and review
7. Attention items
8. Required report

## 1. Input inventory

Inventory the input before producing canonical objects. At minimum capture:

- workbook/file name and SHA-256 hash;
- sheet names, visibility, used ranges, tables, and named ranges;
- raw cell values and formulas separately from displayed values;
- merged cells, hidden rows/columns, comments, notes, and external references;
- style signals including number format, indentation, fill, font weight, and color;
- formula errors and unsupported workbook features.

Never open the workbook in a mode that executes macros or refreshes external data. If the available parser drops formulas, styles, comments, or hidden state, describe the loss in the report.

Preserve theme color index and tint as well as raw RGB. A workbook may encode visually similar blue text through multiple theme colors and direct RGB values. Keep cell-to-style references separate from the reusable style catalog so the inventory stays compact.

## 2. Stable identity

Use lowercase snake-case IDs with a semantic namespace, for example:

```text
model_acme_operating
entity_acme_company
metric_acme_subscription_revenue
period_acme_fy2026
observation_acme_subscription_revenue_fy2026_base_v3
transformation_acme_gross_profit
```

Keep an ID stable when labels, layout, workbook coordinates, or visualizations change. Do not include cell addresses, row numbers, column numbers, or display order in canonical IDs.

## 3. Object mapping

Map input concepts as follows:

| Input signal | Canonical object | Rule |
| --- | --- | --- |
| Company, segment, product, geography | `Entity` | Use parent relationships only for real-world containment. |
| Row label or named financial concept | `Metric` | Define meaning and unit once; do not embed period values. |
| Header date or fiscal label | `Period` | Preserve fiscal/calendar type and dates when known. |
| Actual/base/bull/bear column or sheet | `Scenario` | Do not infer a scenario from color alone. |
| Value at metric + entity + period context | `Observation` | Preserve raw precision, as-of, version, actuality, and value type. |
| Formula producing a reusable metric | `Transformation` | Translate when supported and retain the source formula. |
| Indented child, subtotal component | `Relationship` | Use `component_of` only when meaning is supported. |
| Workbook, filing, note, transcript | `SourceArtifact` | Record URI and content hash when available. |
| Source location for an extracted object | `ProvenanceRecord` | Include extraction run, confidence, and review status. |
| Source passage supporting a view | `Evidence` | Preserve a short excerpt or locator, subject to source policy. |
| Forward-looking analyst belief | `Assumption` | Require evidence; formulas alone are insufficient. |
| Deliberate forecast change | `Decision` + `DecisionChange` | Record rationale only when present in an input source. |
| Explicit worksheet section and metric order | `TablePresentation` | Preserve a lean, non-canonical table grouping with ordered metric IDs and the source range. |

Do not add a `calculated_from` relationship when the same edge is derivable from a transformation's dependencies.

Workbook-specific formatting conventions belong outside the canonical schema. The mapped extractor supports one explicit opt-in convention, `alice-blue-yellow@0.1`; it does not expose a generic color-rule language. Treat its matches only as reviewable source/adjustability evidence. Formula presence takes precedence over a style-implied value type: keep the observation `derived` and retain the style role alongside it. The convention does not imply actual or estimate status; determine actuality independently from period evidence.

### Table presentation metadata

Emit at most one `tablePresentations` entry per model. Use it only when worksheet structure provides a defensible reading order.

- Give each section a semantic snake-case ID and source-facing title.
- List each observed model metric exactly once across the ordered sections.
- Preserve the workbook sheet/range in `sourceLocator` when available.
- Use `component_of` for semantic hierarchy; table sections do not create business relationships.
- Do not preserve blank rows, merged cells, indentation, coordinates, or formatting as canonical identity.
- If the grouping is uncertain, omit the presentation and add a `needs_review` presentation item. The viewer will fall back to semantic hierarchy and provenance order. Use `action_required` only when no defensible, inspectable fallback can be produced without a semantic decision.

The validator enforces presentation coverage automatically. If a presentation exists, every observed model metric must appear exactly once and every model, metric, section, and source reference must resolve. If it does not exist, add an open unresolved item with `category: presentation`; the validator emits a visible fallback warning. Missing both the presentation and that unresolved item is an error.

## 4. Formula translation

Translate only to `model-expression@0.1`. Allowed operations are literals, arithmetic, comparisons, conditional expressions, and these calls:

```text
ref period_ref sum average min max when lag lead coalesce abs round mod
```

Function arity is compiled strictly. `ref` and `abs` take one argument; `mod` takes a value and nonzero divisor and follows Excel modulo semantics; `period_ref` takes a metric ID and an exact period ID; `lag`, `lead`, and `round` take one or two; `when` takes three; aggregate/coalesce calls take at least one. The optional `lag`/`lead` period count must be a positive integer literal. Use `period_ref` when one formula combines periods of a different frequency, such as four quarters into a fiscal year, so the inspector can resolve every exact input observation and workbook cell.

Examples:

```text
=B10-B16
ref("metric_acme_revenue") - ref("metric_acme_cost_of_revenue")

=IF(B10=0,0,B18/B10)
when(ref("metric_acme_revenue") == 0, 0,
  ref("metric_acme_gross_profit") / ref("metric_acme_revenue"))

=B10/A10-1
ref("metric_acme_revenue") / lag("metric_acme_revenue", 1) - 1

=SUM(B10:E10)
sum(period_ref("metric_acme_revenue", "period_q1_2025"),
  period_ref("metric_acme_revenue", "period_q2_2025"),
  period_ref("metric_acme_revenue", "period_q3_2025"),
  period_ref("metric_acme_revenue", "period_q4_2025"))
```

Never use `eval`, `new Function`, assignment, loops, imports, async work, property access, DOM/network APIs, or arbitrary JavaScript. Parse to an AST and let the deterministic interpreter evaluate the AST.

The mapped XLSX extractor may auto-translate numeric and percentage literals, `+`, `-`, `*`, `/`, comparisons, restricted `IF`/`MOD`, and `SUM`/`AVERAGE` calls. Semantic references must have an explicit metric/period mapping from a legacy grid or explicit per-metric cells on any mapped worksheet. Formula-free numeric cells inside the declared `periodHeaderRange` are the sole non-semantic references that may be constant-folded; arbitrary unmapped cells may not. It follows Excel's numeric handling for mapped blank references: direct arithmetic and `SUM` coerce them to zero, while `AVERAGE` excludes them. It must replay the restricted expression against source cached values and accept the translation only when the result matches the formula cell's cached result. An accepted source-derived translation takes precedence over a generic mapped expression because it preserves the actual period-specific lineage. Before leaving a formula opaque, expand the semantic map for every defensible referenced cell. The CLI writes every remaining translation blocker to `formula-translation-tasks.json`; the extraction agent must inspect that queue, prefer reusable restricted-translator support, and rerun replay. Unsupported syntax or replay mismatch uses a reviewed mapped expression when one exists; otherwise preserve the formula as opaque and classify the remaining issue under Section 7. Never execute the source formula or agent-authored TypeScript/JavaScript.

For an unsupported formula:

- set `status` to `opaque`;
- preserve `originalExpression`;
- use the workbook's materialized value in the observation;
- add an open `action_required` formula item targeting the transformation or its output metric; it must remain open until canonical translation succeeds.
- add a structured `formula-translation-tasks.json` item and process it before final handoff.

## 5. Actual and estimate boundary

Use explicit workbook labels, source dates, filing periods, analyst notes, or confirmed conventions. Treat formatting and column position as hints, not proof.

Every observation must include:

- `actuality`;
- `asOf`;
- `versionId` declared by its model;
- `valueType`;
- period, entity, metric, and model references;
- scenario when the source distinguishes one.

If the boundary cannot be confirmed, preserve the likely mapping with reduced confidence only when useful and create an `actuality_boundary` unresolved item.

## 6. Provenance and review

Create at least one provenance record for every extracted model, entity, metric, period, scenario, observation, transformation, relationship, evidence item, assumption, decision, decision change, and unresolved item.

Use the narrowest available locator:

- workbook: sheet plus cell or range;
- filing/document: page and passage;
- transcript/voice memo: timecode and passage.

Use `confirmed` only for human-reviewed or directly unambiguous mappings. Use `unreviewed` for AI extraction, even when confidence is high. Confidence expresses extraction certainty; it does not replace review status.

## 7. Attention items

Do not create an unresolved item merely because the extraction agent or current map lacks coverage. Expand the map or implementation first. Create one only for a remaining provisional interpretation or blocked decision.

Use:

- `attentionLevel: needs_review` when a useful, reversible interpretation can be emitted with its assumption stated;
- `attentionLevel: action_required` when the source must be repaired, a person must choose among materially different meanings, or canonical ingestion is blocked by an unresolved engineering gap such as an opaque formula. Do not emit a disputed claim; cached opaque values may be retained only for explicit preview.

Accepted mappings have no open unresolved item. They may still have `reviewStatus: unreviewed`; acceptance means extraction may proceed, not that a person confirmed it.

Each attention item must state:

- `description`: what was found or remains ambiguous;
- `currentTreatment`: exactly what the database emitted, inherited, retained for preview, or omitted;
- `impact`: which value, label, period boundary, lineage, or presentation may be wrong or unavailable;
- `nextAction`: one concrete confirmation or repair instruction that closes the item;
- the source location;
- any affected canonical object;
- confidence;
- the assumption already made, if any.

Write the four explanation fields into each `unresolvedItems` object in `model-db.json`; the report is not a substitute for machine-readable UI guidance. A `needs_review` item may be cleared only by confirming its stated current treatment. An `action_required` item must remain open until its `nextAction` has been completed in the source or extraction and the database is re-imported.

Never hide an unresolved item by choosing a plausible mapping silently. Conversely, do not manufacture one for an explicit scope exclusion, a non-model workbook feature, or an inventory comment outside the selected semantic graph. Preserve those facts in scope and inventory evidence. Translator-only limitations are engineering follow-ups, not analyst questions.

## 8. Required report

Write `extraction-report.md` with these sections:

```markdown
# Extraction report

## Inputs and hashes
## Inventory
## Object counts
## Table presentation
## Actual / estimate boundary
## Formula coverage
## Unresolved mappings
## Missing lineage
## Validator result
## Questions and next actions
```

The table-presentation section must list every model, its ordered sections, metric coverage, source range, and any fallback warning. Formula coverage must count supported, opaque, and unresolved transformations. Object counts must include entities, metrics, observations, transformations, relationships, table presentation sections, assumptions, decisions, and unresolved items. The validator section must record both the fast validator and the final strict checker invocation (`npm run extraction:check` or the repository's `check-extraction.mjs` path), their result, every remaining error, and every warning; do not summarize a failed validator as successful.

Every open item must appear on one report line prefixed by `NEEDS REVIEW` or `ACTION REQUIRED`, and the extraction run must remain `completed_with_issues`. Every workbook issue and next action must name its worksheet and narrowest available cell or range. Distinguish engineering follow-up from analyst decisions. For a cross-sheet formula, name both the worksheet containing the formula and every referenced worksheet that blocks translation. For a genuinely workbook-level issue, say that no single worksheet owns it and list the affected worksheets when known.
