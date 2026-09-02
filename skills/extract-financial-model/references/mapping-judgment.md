# Mapping judgment and attention levels

## Contents

1. Separate tool coverage from source ambiguity
2. Build the semantic cell graph
3. Map layouts without assuming a grid
4. Assign attention levels
5. Decide what may remain opaque
6. Stop conditions

## 1. Separate tool coverage from source ambiguity

Do not call a workbook concept ambiguous merely because the current map or translator does not cover it.

Classify a failure first:

- **Map coverage gap:** referenced cells have clear labels, periods, units, or formula roles, but are absent from the semantic map. Extend the map and rerun without asking an analyst.
- **Translator coverage gap:** every referenced cell has semantics, but the deterministic translator does not yet cover the Excel syntax. Inspect its `formula-translation-tasks.json` item and preserve the exact formula and cached value as `opaque` with an open `extraction_agent` action. Extend the reusable translator with replay tests only when tooling work is explicitly authorized, then rerun.
- **Source ambiguity:** the workbook lacks enough evidence to name a metric, choose a period, determine actuality, or resolve conflicting meanings. Do not invent the answer; create an `action_required` item.
- **Source defect:** a required cached value is missing, a cell contains an incompatible value, or a reference is broken. Do not fabricate a value; create an `action_required` item.

An extractor limitation is a tooling task. A source ambiguity is a model/source-owner task. Never turn the former into the latter, and never silently patch shared extraction code unless tooling changes are explicitly in scope.

## 2. Build the semantic cell graph

Start from the values the user wants to inspect, then follow formula references transitively.

1. Map each selected output cell to a metric and period.
2. Parse its references without executing or recalculating the workbook.
3. For every referenced cell, determine whether it already maps to a metric-period point.
4. Extend the map for high-confidence drivers, helper calculations, and copied values.
5. Inspect every generated formula-translation task and repeat until every selected formula reference is mapped, deliberately opaque as a named tooling limitation, or explicitly action-required.
6. Run cached-value replay after every expansion.

Do not limit this closure to visible table rows. Inputs may live above the table, below it, in a vertical chain, in a driver block, in hidden rows, or on another worksheet.

Create a helper metric only when its semantic role can be named from labels, named ranges, comments, neighboring formulas, or consistent workbook structure. Use a provisional semantic name plus `needs_review` when the interpretation is useful and well-supported but not directly stated. Do not use a cell address as metric identity.

## 3. Map layouts without assuming a grid

Use the preferred `financial-model-workbook-map@0.3` format for new maps.

- Use `row` plus period `column` only for a genuine repeated metric-row by period-column grid. Add metric `sheet` when that row is on another worksheet.
- Use metric `cells` for arbitrary layouts. Each entry explicitly declares `sheet`, `cell`, `periodId`, and optional confidence.
- Mix grid metrics and explicit-cell metrics in the same model when the workbook mixes statements, assumptions, and driver blocks.
- Put every observed metric in at least one presentation section, even when its source cells are scattered. Keep it unique within a presentation; multiple worksheet views may intentionally reuse it. Record a defensible section-relative `presentationParentMetricId` and an independent semantic `componentOfMetricId` decision for every mapped metric. Do not turn indentation alone into a semantic component edge. Add an omitted parent metric, start a new local root, or split the section rather than attaching a child to the nearest unrelated row. Presentation order and parent edges are viewer concerns; cell coordinates remain provenance.
- Map cross-sheet inputs explicitly. The translator supports mapped cross-sheet arithmetic, comparisons, `IF`/`MOD`, `SUM`, and `AVERAGE` references; an unmapped worksheet is not automatically an opaque formula.

Example:

```json
{
  "id": "metric_acme_utilization",
  "name": "Utilization",
  "labelCell": { "sheet": "Drivers", "cell": "A4" },
  "dataType": "percentage",
  "unit": "%",
  "presentationParentMetricId": null,
  "componentOfMetricId": null,
  "cells": [
    { "sheet": "Drivers", "cell": "B4", "periodId": "period_acme_fy2025" },
    { "sheet": "Drivers", "cell": "B5", "periodId": "period_acme_fy2026", "confidence": 0.9 }
  ]
}
```

## 4. Assign attention levels

Confidence, human review status, and attention level answer different questions:

- `confidence`: how certain is this extraction claim?
- provenance `reviewStatus`: has a human reviewed or corrected it?
- unresolved `attentionLevel`: may the extraction proceed, should someone inspect it, or is a decision required?

Confidence is evidence metadata only. It never determines attention priority: every concrete possible workbook/model error or required update is `action_required` until repaired and re-extracted.

Use these three product states:

| Product state | Database representation | Rule |
| --- | --- | --- |
| Accepted | No open unresolved item for the object | Emit when evidence and deterministic checks support the mapping. It may remain `reviewStatus: unreviewed`; accepted does not mean human-confirmed. |
| Needs review | Open unresolved item with `attentionLevel: needs_review` | Emit the useful, reversible interpretation and state the assumption. The viewer shows a neutral review cue. |
| Action required | Open unresolved item with `attentionLevel: action_required` | Do not make the disputed semantic claim or fabricate the missing value. Preserve raw material where safe. The viewer shows a red action cue. |

For either open state, store four separate user-facing facts: `description` for what was found, `currentTreatment` for what the database did, `impact` for the affected scope, and `nextAction` for the exact confirmation or repair. Every action also names `actionOwner`: `extraction_agent`, `model_owner`, or `source_owner`. Do not concatenate these into one warning paragraph or send a translator/map gap to the analyst. The viewer may confirm a `needs_review` interpretation, but it must not dismiss attention or manually clear an `action_required` item.

Typical `needs_review` cases:

- a high-confidence label normalization supported by neighboring rows;
- a hierarchy inferred from repeated indentation plus subtotal formulas;
- an actual/estimate boundary supported by multiple signals but not explicitly stated.

Typical `action_required` cases:

- two plausible metrics fit the same unlabeled source cell;
- a required formula has no cached value;
- the source value conflicts with the mapped data type;
- period or scenario identity cannot be determined;
- source evidence conflicts and choosing either interpretation would materially change the model.
- any opaque formula, even when its cached value is usable for preview, because canonical calculation lineage is still missing.
- a broken reference, formula error, or required source value that is missing;
- a literal value interrupting a repeated neighboring formula pattern;
- a stated total or model identity that does not reconcile;
- explicit source evidence that a required input needs updating.

Classify source/model repair findings as `source_error`, `source_update`, or `model_inconsistency`. Do not downgrade one to `needs_review` because the detection is low-confidence; instead state the concrete evidence and the check needed to close it. Do not manufacture actions from vague anomaly scores.

Do not create unresolved items for harmless formatting differences, unsupported non-model workbook parts, deliberately out-of-scope worksheets, or facts already settled by deterministic evidence. Record scope exclusions explicitly in the map and report. Preserve comments outside the selected semantic graph in `workbook-inventory.json`; attach material in-scope comments as evidence instead of asking an analyst to classify every comment.

The fixed Alice style convention describes source and adjustability only. It does not imply actual or estimate status, so a style/period combination is never an attention item by itself.

## 5. Decide what may remain opaque

`opaque` describes formula translation status, not data invalidity.

Before accepting an opaque formula:

1. Inspect its exact blocker and referenced cells.
2. Extend the semantic map for every defensible missing input.
3. Retry translation and cached-value replay.
4. Open its generated `formula-translation-tasks.json` item. Only when shared tooling improvement is explicitly authorized, extend the reusable restricted translator and tests for syntax with defensible general semantics, then rerun extraction.
5. Use a reviewed canonical expression only when it matches the source formula's meaning for that specific period type.
6. Keep the formula opaque when syntax remains outside `model-expression@0.1` and tooling improvement is not in scope, or source meaning is genuinely unresolved.

An opaque formula is always `action_required`: its cached value may support an honest preview, but its calculation did not enter the canonical graph. If only translator syntax is missing, name the extraction tooling limitation and do not ask the analyst to decide whether the formula should be translated. Do not silently expand the shared translator during an ordinary extraction; preserve the task for an explicitly authorized optimization pass. Do not resolve or dismiss the action while the transformation remains opaque. Missing values, broken references, or unknown business meaning are also `action_required`.

## 6. Stop conditions

An extraction iteration is ready for preview when:

- every selected output has provenance;
- referenced-cell closure has no silent gaps;
- every formula-translation task was processed, with any remaining task explicitly justified as outside the safe language;
- every remaining opaque formula names its blocker and source cells;
- every provisional interpretation is `needs_review`;
- every blocked decision is `action_required` and no disputed value was invented;
- the extraction run uses `completed_with_issues` while any attention item remains open;
- the report labels every open item as `NEEDS REVIEW` or `ACTION REQUIRED`.
- every attention item carries non-empty `currentTreatment`, `impact`, and `nextAction` fields in the database.

Previewing a dataset with action-required items is allowed so the issue can be inspected visually. Do not describe the extraction as complete until those items are resolved or dismissed with evidence.
