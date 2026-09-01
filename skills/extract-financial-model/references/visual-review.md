# Visual review

Use the compiled preview to close the loop between extraction quality and viewer behavior. It is a local derivative artifact, not a replacement for the public GitHub Pages viewer.

## Build and inspect

From the repository root:

```sh
npm run extraction:preview -- path/to/extraction-output
```

The extraction directory must contain `model-db.json` and `extraction-report.md`. The command:

1. runs the same strict package checker used for final validation;
2. builds the current viewer with relative static assets;
3. embeds the validated model database in the generated HTML;
4. opens the bundle in headless Chromium;
5. checks every model and period-frequency table, cell inspection, direct and reverse derived lineage, and unresolved cues when available, plus browser errors, mobile table scrolling, mobile cell inspection, and document overflow;
6. writes `viewer/review/review.json`, individual screenshots, and `viewer/review/contact-sheet.png`.

The generated viewer root also contains `.ledgerglass-preview.json` with format `ledgerglass-preview@0.1`. The serve and rebuild commands use this marker to recognize and safely replace a generated bundle; do not delete or edit it by hand.

`review.json` intentionally reports `automated-checks-passed-visual-judgment-required`. Open the images; do not infer UI quality from exit code alone.

## Review checklist

Check all of the following against the source workbook or lossless IR:

- model, entity, period labels, and actual/estimate boundary;
- section grouping and metric reading order;
- metric names, indentation, units, sign, precision, and missing values;
- selected-cell value, source locator, confidence, and review state;
- derived input metrics, input periods, workbook cells, and original formula;
- neutral-blue `needs_review` cues for reversible assumptions and red `action_required` cues for blocked decisions, at status, row, and cell-detail level;
- every possible source/model error or required update appears as a red action and is not ranked or suppressed by confidence;
- attention detail that clearly separates current treatment, impact, and next action; documented review items expose only an explicit confirmation control, while action items and incomplete legacy reviews expose no manual clear/dismiss control;
- table scrolling and inspector placement on desktop and mobile.

## Decide what to fix

- Fix `model-db.json` and the extraction logic when the viewer accurately reveals incorrect or missing semantic data, presentation metadata, provenance, or formula translation.
- Fix repository query/UI code when the validated data is correct but the viewer orders, formats, resolves, or displays it incorrectly. Run `npm run check`, `npm run verify:ui`, and the extraction preview again.
- Add or refine a validator rule when a repeatable extraction defect reached visual review without an explicit attention item or error.
- Do not patch generated viewer files. They are replaced on the next build.

## Interactive browser session

To keep the generated bundle available for Playwright or a human browser:

```sh
npm run extraction:serve -- path/to/extraction-output/viewer
```

The server binds only to `127.0.0.1`. Use the printed URL, then stop the process when review is complete. No workbook or model data is uploaded. Do not deploy a generated bundle or copy it into the GitHub Pages output without explicit authorization.
