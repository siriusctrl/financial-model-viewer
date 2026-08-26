"""Sparse, read-only OOXML helpers for financial workbook extraction.

The module reads stored worksheet cells directly from the XLSX package. It never
opens Excel, recalculates formulas, refreshes links, or rewrites the workbook.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from zipfile import ZipFile
import posixpath
import re
import xml.etree.ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": DOC_REL_NS, "p": PKG_REL_NS}
FORMULA_FUNCTION = re.compile(r"(?<![A-Z0-9_.])([A-Z][A-Z0-9_.]*)\s*\(", re.I)
A1_REFERENCE = re.compile(
    r"(?<![A-Z0-9_.])"
    r"(?P<sheet>(?:'[^']+'|[A-Za-z_][A-Za-z0-9_. ]*)!)?"
    r"(?P<column_abs>\$?)(?P<column>[A-Z]{1,3})"
    r"(?P<row_abs>\$?)(?P<row>[1-9][0-9]*)(?![A-Z0-9_(])",
    re.I,
)
QUOTED_FORMULA_TEXT = re.compile(r'("(?:""|[^"])*")')


def _relationship_part(part: str) -> str:
    path = PurePosixPath(part)
    return str(path.parent / "_rels" / f"{path.name}.rels")


def _resolve_part(source_part: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def _text(element: ET.Element | None) -> str | None:
    if element is None:
        return None
    value = "".join(element.itertext())
    return value if value != "" else None


def _number(raw: str | None) -> int | float | None:
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return int(value) if value.is_integer() else value


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ranges(values: Iterable[int]) -> list[str]:
    ordered = sorted(set(values))
    if not ordered:
        return []
    result: list[str] = []
    start = previous = ordered[0]
    for value in ordered[1:]:
        if value == previous + 1:
            previous = value
            continue
        result.append(str(start) if start == previous else f"{start}:{previous}")
        start = previous = value
    result.append(str(start) if start == previous else f"{start}:{previous}")
    return result


def _column_number(label: str) -> int:
    value = 0
    for character in label.upper():
        value = value * 26 + ord(character) - ord("A") + 1
    return value


def _column_label(number: int) -> str:
    if number < 1:
        raise ValueError(f"Invalid translated column: {number}")
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def _coordinate_parts(coordinate: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", coordinate, re.I)
    if not match:
        raise ValueError(f"Unsupported cell coordinate: {coordinate}")
    return _column_number(match.group(1)), int(match.group(2))


def translate_shared_formula(formula: str, origin: str, target: str) -> str:
    """Translate relative A1 references from a shared-formula base cell."""
    origin_column, origin_row = _coordinate_parts(origin)
    target_column, target_row = _coordinate_parts(target)
    column_delta = target_column - origin_column
    row_delta = target_row - origin_row

    def translate_segment(segment: str) -> str:
        def replace(match: re.Match[str]) -> str:
            column = _column_number(match.group("column"))
            row = int(match.group("row"))
            if not match.group("column_abs"):
                column += column_delta
            if not match.group("row_abs"):
                row += row_delta
            if row < 1:
                raise ValueError(f"Invalid translated row: {row}")
            return "{}{}{}{}{}".format(
                match.group("sheet") or "",
                match.group("column_abs"),
                _column_label(column),
                match.group("row_abs"),
                row,
            )

        return A1_REFERENCE.sub(replace, segment)

    return "".join(
        part if part.startswith('"') else translate_segment(part)
        for part in QUOTED_FORMULA_TEXT.split(formula)
        if part != ""
    )


@dataclass(frozen=True)
class SheetPart:
    name: str
    state: str
    part: str


class WorkbookPackage:
    """Read-only access to workbook metadata and sparse stored cells."""

    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.archive = ZipFile(self.path)
        self.parts = set(self.archive.namelist())
        self.shared_strings = self._read_shared_strings()
        self.workbook_root = self._xml("xl/workbook.xml")
        workbook_relationships = self._relationships("xl/workbook.xml")
        self.sheets: list[SheetPart] = []
        for sheet in self.workbook_root.findall("m:sheets/m:sheet", NS):
            relationship_id = sheet.get(f"{{{DOC_REL_NS}}}id")
            relationship = workbook_relationships.get(relationship_id or "")
            if relationship and relationship.get("part"):
                self.sheets.append(
                    SheetPart(
                        name=sheet.get("name", "Unnamed sheet"),
                        state=sheet.get("state", "visible"),
                        part=str(relationship["part"]),
                    )
                )

    def close(self) -> None:
        self.archive.close()

    def __enter__(self) -> "WorkbookPackage":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _xml(self, part: str) -> ET.Element:
        with self.archive.open(part) as source:
            return ET.parse(source).getroot()

    def _relationships(self, source_part: str) -> dict[str, dict[str, Any]]:
        relationship_part = _relationship_part(source_part)
        if relationship_part not in self.parts:
            return {}
        root = self._xml(relationship_part)
        result: dict[str, dict[str, Any]] = {}
        for relationship in root.findall("p:Relationship", NS):
            relationship_id = relationship.get("Id")
            target = relationship.get("Target")
            if not relationship_id or not target:
                continue
            external = relationship.get("TargetMode") == "External"
            result[relationship_id] = {
                "id": relationship_id,
                "type": relationship.get("Type", ""),
                "target": target,
                "external": external,
                "part": None if external else _resolve_part(source_part, target),
            }
        return result

    def _read_shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self.parts:
            return []
        root = self._xml("xl/sharedStrings.xml")
        return ["".join(item.itertext()) for item in root.findall("m:si", NS)]

    def _read_comments(self, sheet_part: str) -> list[dict[str, str]]:
        relationships = self._relationships(sheet_part)
        comment_parts = [
            relationship["part"]
            for relationship in relationships.values()
            if relationship["type"].endswith("/comments") and relationship["part"]
        ]
        comments: list[dict[str, str]] = []
        for part in comment_parts:
            root = self._xml(str(part))
            authors = [author.text or "" for author in root.findall("m:authors/m:author", NS)]
            for comment in root.findall("m:commentList/m:comment", NS):
                author_id = int(comment.get("authorId", "0"))
                comments.append({
                    "cell": comment.get("ref", ""),
                    "author": authors[author_id] if author_id < len(authors) else "",
                    "text": _text(comment.find("m:text", NS)) or "",
                })
        return comments

    def _cell(
        self,
        element: ET.Element,
        shared_formulas: dict[str, tuple[str, str]],
    ) -> dict[str, Any]:
        cell_type = element.get("t", "n")
        raw_value = _text(element.find("m:v", NS))
        inline_value = _text(element.find("m:is", NS))
        formula_element = element.find("m:f", NS)
        formula_text = _text(formula_element)
        coordinate = element.get("r", "")
        if (
            formula_element is not None
            and formula_element.get("t") == "shared"
            and formula_text is None
            and formula_element.get("si") in shared_formulas
        ):
            base_coordinate, base_formula = shared_formulas[formula_element.get("si", "")]
            formula_text = translate_shared_formula(base_formula, base_coordinate, coordinate)
        resolved: Any = raw_value
        if cell_type == "s" and raw_value is not None:
            index = int(raw_value)
            resolved = self.shared_strings[index] if index < len(self.shared_strings) else None
        elif cell_type == "inlineStr":
            resolved = inline_value
        elif cell_type == "b":
            resolved = raw_value == "1"
        elif cell_type == "n":
            resolved = _number(raw_value)

        result: dict[str, Any] = {
            "cell": coordinate,
            "type": cell_type,
            "style": int(element.get("s", "0")),
            "rawValue": raw_value,
            "value": resolved,
        }
        if formula_element is not None:
            result["formula"] = f"={formula_text or ''}"
            formula_attributes = dict(formula_element.attrib)
            if formula_attributes:
                result["formulaAttributes"] = formula_attributes
        return result

    def _stored_cells(self, root: ET.Element) -> list[dict[str, Any]]:
        elements = root.findall(".//m:c", NS)
        shared_formulas: dict[str, tuple[str, str]] = {}
        for element in elements:
            formula = element.find("m:f", NS)
            formula_text = _text(formula)
            if formula is not None and formula.get("t") == "shared" and formula_text is not None:
                shared_formulas[formula.get("si", "")] = (element.get("r", ""), formula_text)
        return [self._cell(element, shared_formulas) for element in elements]

    def cells(self, sheet_name: str) -> dict[str, dict[str, Any]]:
        sheet = next((item for item in self.sheets if item.name == sheet_name), None)
        if not sheet:
            raise KeyError(f"Unknown worksheet: {sheet_name}")
        root = self._xml(sheet.part)
        return {
            cell["cell"]: cell
            for cell in self._stored_cells(root)
            if cell["cell"]
        }

    def comments(self, sheet_name: str) -> list[dict[str, str]]:
        sheet = next((item for item in self.sheets if item.name == sheet_name), None)
        if not sheet:
            raise KeyError(f"Unknown worksheet: {sheet_name}")
        return self._read_comments(sheet.part)

    def sheet_inventory(self, sheet: SheetPart, cell_mode: str = "none") -> dict[str, Any]:
        root = self._xml(sheet.part)
        cells = self._stored_cells(root)
        formulas = [cell["formula"] for cell in cells if "formula" in cell]
        function_counts = Counter(
            match.group(1).upper()
            for formula in formulas
            for match in FORMULA_FUNCTION.finditer(formula)
        )
        relationships = list(self._relationships(sheet.part).values())
        hidden_rows = [
            int(row.get("r", "0"))
            for row in root.findall("m:sheetData/m:row", NS)
            if row.get("hidden") in {"1", "true"}
        ]
        hidden_columns = [
            {
                "min": int(column.get("min", "0")),
                "max": int(column.get("max", "0")),
            }
            for column in root.findall("m:cols/m:col", NS)
            if column.get("hidden") in {"1", "true"}
        ]
        comments = self._read_comments(sheet.part)
        inventory: dict[str, Any] = {
            "name": sheet.name,
            "state": sheet.state,
            "part": sheet.part,
            "dimension": root.find("m:dimension", NS).get("ref", "")
            if root.find("m:dimension", NS) is not None
            else "",
            "storedCellCount": len(cells),
            "nonEmptyCellCount": sum(
                cell.get("rawValue") is not None or cell.get("value") is not None or "formula" in cell
                for cell in cells
            ),
            "formulaCount": len(formulas),
            "formulaFunctionCounts": dict(function_counts.most_common()),
            "externalFormulaCount": sum("[" in formula and "]" in formula for formula in formulas),
            "commentCount": len(comments),
            "comments": comments,
            "mergedRanges": [item.get("ref", "") for item in root.findall("m:mergeCells/m:mergeCell", NS)],
            "hiddenRowRanges": _ranges(hidden_rows),
            "hiddenColumns": hidden_columns,
            "freezePane": (
                root.find("m:sheetViews/m:sheetView/m:pane", NS).get("topLeftCell")
                if root.find("m:sheetViews/m:sheetView/m:pane", NS) is not None
                else None
            ),
            "relationships": relationships,
            "styleUsage": dict(Counter(str(cell["style"]) for cell in cells).most_common()),
        }
        if cell_mode == "formula":
            inventory["cells"] = [cell for cell in cells if "formula" in cell]
        elif cell_mode == "all":
            inventory["cells"] = cells
        return inventory

    def inventory(self, cell_mode: str = "none") -> dict[str, Any]:
        if cell_mode not in {"none", "formula", "all"}:
            raise ValueError(f"Unsupported cell mode: {cell_mode}")
        defined_names = []
        for item in self.workbook_root.findall("m:definedNames/m:definedName", NS):
            defined_names.append({
                "name": item.get("name", ""),
                "hidden": item.get("hidden") in {"1", "true"},
                "localSheetId": item.get("localSheetId"),
                "value": item.text or "",
            })
        calculation = self.workbook_root.find("m:calcPr", NS)
        risky_parts = {
            "macros": sorted(part for part in self.parts if "vbaProject" in part),
            "externalLinks": sorted(part for part in self.parts if part.startswith("xl/externalLinks/")),
            "connections": sorted(part for part in self.parts if part == "xl/connections.xml"),
            "embeddings": sorted(part for part in self.parts if part.startswith("xl/embeddings/")),
            "customBinary": sorted(part for part in self.parts if part.endswith(".bin")),
        }
        media = sorted(part for part in self.parts if part.startswith("xl/media/"))
        calc_chain_count = 0
        if "xl/calcChain.xml" in self.parts:
            calc_chain_count = len(self._xml("xl/calcChain.xml").findall("m:c", NS))
        sheet_inventories = [self.sheet_inventory(sheet, cell_mode) for sheet in self.sheets]
        warnings: list[str] = []
        for category, parts in risky_parts.items():
            if parts:
                warnings.append(f"Workbook contains {category}: {', '.join(parts)}")
        if any(part.lower().endswith((".emf", ".wmf")) for part in media):
            warnings.append("Workbook contains EMF/WMF media; preserve package bytes because most parsers do not render these formats.")
        if any(sheet["externalFormulaCount"] for sheet in sheet_inventories):
            warnings.append("Workbook contains formulas with external workbook references; do not refresh them during extraction.")

        return {
            "format": "financial-workbook-inventory@0.1",
            "input": {
                "filename": self.path.name,
                "bytes": self.path.stat().st_size,
                "sha256": _file_sha256(self.path),
            },
            "package": {
                "partCount": len(self.parts),
                "media": media,
                "riskSignals": risky_parts,
                "warnings": warnings,
            },
            "workbook": {
                "sheetCount": len(self.sheets),
                "definedNames": defined_names,
                "calculation": dict(calculation.attrib) if calculation is not None else {},
                "calcChainCellCount": calc_chain_count,
            },
            "sheets": sheet_inventories,
        }
