#!/usr/bin/env python3
"""Extract a canonical model database from an explicit workbook map."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

from mapped_workbook import MappedWorkbookExtractor, load_mapping


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read selected XLSX cells through an explicit semantic map and emit model-db.json plus extraction-report.md."
    )
    parser.add_argument("workbook", type=Path)
    parser.add_argument("mapping", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        mapping = load_mapping(arguments.mapping)
        result = MappedWorkbookExtractor(arguments.workbook, mapping).extract()
        arguments.output.mkdir(parents=True, exist_ok=True)
        (arguments.output / "model-db.json").write_text(
            f"{json.dumps(result.database, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
        (arguments.output / "extraction-report.md").write_text(result.report, encoding="utf-8")
        (arguments.output / "workbook-inventory.json").write_text(
            f"{json.dumps(result.inventory, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
        (arguments.output / "workbook-style-evidence.json").write_text(
            f"{json.dumps(result.style_evidence, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
        (arguments.output / "formula-translation-tasks.json").write_text(
            f"{json.dumps(result.formula_translation_tasks, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )
    except Exception as cause:  # CLI boundary: provide one concise diagnostic.
        print(f"ERROR Extraction failed: {cause}", file=sys.stderr)
        return 1
    output = arguments.output.resolve()
    checker = Path(__file__).with_name("check-extraction.mjs")
    validation = subprocess.run(["node", str(checker), str(output)], check=False)
    if validation.returncode != 0:
        print(f"ERROR Strict extraction check failed for {output}", file=sys.stderr)
        return validation.returncode

    report_path = output / "extraction-report.md"
    report = report_path.read_text(encoding="utf-8").replace(
        "- `npm run validate -- <output>/model-db.json` — required after generation.\n"
        "- `npm run extraction:check -- <output>` — required final strict package check.",
        "- `npm run validate -- <output>/model-db.json` — PASS through the mapped extractor's automatic strict check.\n"
        "- `npm run extraction:check -- <output>` — PASS through the mapped extractor's automatic strict check.",
    )
    report_path.write_text(report, encoding="utf-8")

    print(f"EXTRACTED {output}")
    observation_count = sum(
        len(series["points"]) for series in result.database["observationSeries"]
    )
    print(
        f"metrics={len(result.database['metrics'])} observations={observation_count} "
        f"transformations={len(result.database['transformations'])} unresolved={len(result.database['unresolvedItems'])}"
        f" formulaTranslationTasks={len(result.formula_translation_tasks['items'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
