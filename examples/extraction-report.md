# Extraction report

## Inputs and hashes

This report describes the generated **representative fixtures**, not a real analyst workbook extraction.

| Input artifact | Declared fixture hash |
| --- | --- |
| Northstar Cloud operating model | `sha256:a1a1…a1` |
| Northstar Cloud forecast notes | `sha256:b2b2…b2` |
| Harbor National bank model | `sha256:c3c3…c3` |
| Harbor National provision notes | `sha256:d4d4…d4` |

The URIs use the `fixtures://` scheme and do not point to source files. A real extraction must compute hashes from actual inputs.

## Inventory

- 2 representative models across unrelated sectors;
- 2 company entities;
- 5 fiscal-year periods per model context;
- actual and base scenarios;
- workbook-cell locators for modeled observations;
- source-backed table sections and metric reading order;
- note passages for evidence and assumption objects.

Hidden sheets, named ranges, external references, macros, comments, and style signals were not available because the dataset is generated rather than parsed from `.xlsx`.

## Object counts

| Object | Count |
| --- | ---: |
| Entities | 2 |
| Metrics | 12 |
| Observations | 60 |
| Transformations | 5 |
| Relationships | 9 |
| Table presentation sections | 5 |
| Assumptions | 2 |
| Decisions | 1 |
| Decision changes | 1 |
| Unresolved items | 1 |

## Table presentation

Both representative models include source-backed table presentation metadata. Northstar Cloud has ordered `Revenue build` and `Gross profit` sections covering all 6 observed metrics. Harbor National has ordered `Operating income`, `Credit and costs`, and `Pre-tax earnings` sections covering all 6 observed metrics. Each section retains its source `Model` sheet range; the validator reports no presentation fallback warnings.

## Actual / estimate boundary

FY22–FY24 are marked actual and FY25–FY26 are base estimates. This boundary is fixture-authored; it was not inferred from spreadsheet formatting.

- Actual observations: 36
- Estimate observations: 24

## Formula coverage

- Supported: 5
- Opaque: 0
- Unresolved: 0

All supported formulas preserve a representative original Excel formula and a parsed canonical expression. This coverage must not be generalized to real workbooks.

## Unresolved mappings

`unresolved_harbor_provision_label`: the source-style label `LLP` is mapped to “Provision for credit losses,” but the representative source contains no explicit definition. The object remains unreviewed with 64% confidence.

## Missing lineage

The deterministic validator reports no missing provenance for canonical objects. The source artifacts themselves are fixture declarations rather than published workbook bytes.

## Validator result

```text
npm run validate -- examples/sample-model-db.json
PASS — schema, references, types, dependencies, cycles, point-in-time uniqueness, and provenance coverage
```

## Analyst questions

1. Does `LLP` in the bank model mean provision expense, allowance balance, or another credit metric?
2. For a real workbook, which source establishes the actual/estimate boundary when columns are not explicitly labeled?
3. Which forecast changes have source-backed rationale outside the workbook and should become assumptions or decisions?
