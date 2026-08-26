#!/usr/bin/env python3
"""Create a sparse, read-only inventory of an XLSX workbook."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from ooxml import WorkbookPackage


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inventory stored XLSX cells, formulas, comments, hidden state, links, and package risks without recalculation."
    )
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--out", type=Path, help="Write JSON to this path instead of stdout.")
    parser.add_argument(
        "--cells",
        choices=("none", "formula", "all"),
        default="none",
        help="Optionally include formula cells or every stored cell in the JSON IR.",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    if not arguments.workbook.is_file():
        print(f"ERROR Workbook does not exist: {arguments.workbook}", file=sys.stderr)
        return 1
    try:
        with WorkbookPackage(arguments.workbook) as package:
            inventory = package.inventory(arguments.cells)
    except Exception as cause:  # CLI boundary: provide one concise diagnostic.
        print(f"ERROR Could not inventory workbook: {cause}", file=sys.stderr)
        return 1

    payload = f"{json.dumps(inventory, ensure_ascii=False, indent=2)}\n"
    if arguments.out:
        arguments.out.parent.mkdir(parents=True, exist_ok=True)
        arguments.out.write_text(payload, encoding="utf-8")
        print(f"INVENTORY {arguments.out.resolve()}")
        print(
            f"sheets={len(inventory['sheets'])} storedCells={sum(sheet['storedCellCount'] for sheet in inventory['sheets'])} "
            f"formulas={sum(sheet['formulaCount'] for sheet in inventory['sheets'])} warnings={len(inventory['package']['warnings'])}"
        )
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
