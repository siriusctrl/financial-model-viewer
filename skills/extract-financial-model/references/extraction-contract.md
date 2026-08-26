# Financial model extraction contract

## Contents

1. Input inventory
2. Stable identity
3. Object mapping
4. Formula translation
5. Actual and estimate boundary
6. Provenance and review
7. Unresolved items
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

### Table presentation metadata

Emit at most one `tablePresentations` entry per model. Use it only when worksheet structure provides a defensible reading order.

- Give each section a semantic snake-case ID and source-facing title.
- List each observed model metric exactly once across the ordered sections.
- Preserve the workbook sheet/range in `sourceLocator` when available.
- Use `component_of` for semantic hierarchy; table sections do not create business relationships.
- Do not preserve blank rows, merged cells, indentation, coordinates, or formatting as canonical identity.
- If the grouping is uncertain, omit the presentation and add an unresolved item. The viewer will fall back to semantic hierarchy and provenance order.

The validator enforces presentation coverage automatically. If a presentation exists, every observed model metric must appear exactly once and every model, metric, section, and source reference must resolve. If it does not exist, add an open unresolved item with `category: presentation`; the validator emits a visible fallback warning. Missing both the presentation and that unresolved item is an error.

## 4. Formula translation

Translate only to `model-expression@0.1`. Allowed operations are literals, arithmetic, comparisons, conditional expressions, and these calls:

```text
ref sum average min max when lag lead coalesce abs round
```

Function arity is compiled strictly. `ref` and `abs` take one argument; `lag`, `lead`, and `round` take one or two; `when` takes three; aggregate/coalesce calls take at least one. The optional `lag`/`lead` period count must be a positive integer literal so a derived value can resolve to exact input-period observations and workbook cells.

Examples:

```text
=B10-B16
ref("metric_acme_revenue") - ref("metric_acme_cost_of_revenue")

=IFERROR(B18/B10,0)
when(ref("metric_acme_revenue") == 0, null,
  ref("metric_acme_gross_profit") / ref("metric_acme_revenue"))
```

Never use `eval`, `new Function`, assignment, loops, imports, async work, property access, DOM/network APIs, or arbitrary JavaScript. Parse to an AST and let the deterministic interpreter evaluate the AST.

For an unsupported formula:

- set `status` to `opaque`;
- preserve `originalExpression`;
- use the workbook's materialized value in the observation;
- add an unresolved item when the business meaning or dependencies are uncertain.

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

## 7. Unresolved items

Create an unresolved item for every ambiguous metric mapping, hierarchy, formula, lineage gap, or actual/estimate boundary. Each item must state:

- what is ambiguous;
- the source location;
- any affected canonical object;
- confidence;
- one concrete question an analyst can answer.

Never hide an unresolved item by choosing a plausible mapping silently.

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
## Analyst questions
```

The table-presentation section must list every model, its ordered sections, metric coverage, source range, and any fallback warning. Formula coverage must count supported, opaque, and unresolved transformations. Object counts must include entities, metrics, observations, transformations, relationships, table presentation sections, assumptions, decisions, and unresolved items. The validator section must record both the fast validator and the final strict checker invocation (`npm run extraction:check` or the repository's `check-extraction.mjs` path), their result, every remaining error, and every warning; do not summarize a failed validator as successful.
