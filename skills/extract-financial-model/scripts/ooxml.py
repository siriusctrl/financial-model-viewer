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
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"m": MAIN_NS, "r": DOC_REL_NS, "p": PKG_REL_NS, "a": DRAWING_NS}
THEME_COLOR_NAMES = (
    "dark1",
    "light1",
    "dark2",
    "light2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hyperlink",
    "followedHyperlink",
)
BUILTIN_NUMBER_FORMATS = {
    0: "General",
    1: "0",
    2: "0.00",
    3: "#,##0",
    4: "#,##0.00",
    9: "0%",
    10: "0.00%",
    11: "0.00E+00",
    12: "# ?/?",
    13: "# ??/??",
    14: "mm-dd-yy",
    15: "d-mmm-yy",
    16: "d-mmm",
    17: "mmm-yy",
    18: "h:mm AM/PM",
    19: "h:mm:ss AM/PM",
    20: "h:mm",
    21: "h:mm:ss",
    22: "m/d/yy h:mm",
    37: "#,##0 ;(#,##0)",
    38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00;(#,##0.00)",
    40: "#,##0.00;[Red](#,##0.00)",
    45: "mm:ss",
    46: "[h]:mm:ss",
    47: "mmss.0",
    48: "##0.0E+0",
    49: "@",
}
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


def _flag(element: ET.Element | None) -> bool:
    if element is None:
        return False
    return element.get("val", "1").lower() not in {"0", "false", "off"}


def _typed_attributes(element: ET.Element | None) -> dict[str, Any]:
    if element is None:
        return {}
    result: dict[str, Any] = {}
    for key, raw in element.attrib.items():
        if raw.lower() in {"true", "false"}:
            result[key] = raw.lower() == "true"
        else:
            try:
                number = float(raw)
                result[key] = int(number) if number.is_integer() else number
            except ValueError:
                result[key] = raw
    return result


def _color(
    element: ET.Element | None,
    theme_colors: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if element is None:
        return None
    color: dict[str, Any]
    if element.get("rgb") is not None:
        rgb = element.get("rgb", "").upper()
        color = {"type": "rgb", "rgb": rgb if len(rgb) == 8 else f"FF{rgb}"}
    elif element.get("theme") is not None:
        theme = int(element.get("theme", "0"))
        color = {"type": "theme", "theme": theme}
        if 0 <= theme < len(theme_colors):
            color["themeColor"] = theme_colors[theme]
    elif element.get("indexed") is not None:
        color = {"type": "indexed", "indexed": int(element.get("indexed", "0"))}
    elif element.get("auto") is not None:
        color = {"type": "auto", "auto": element.get("auto") in {"1", "true"}}
    else:
        return None
    if element.get("tint") is not None:
        color["tint"] = float(element.get("tint", "0"))
    return color


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
        self.theme_colors = self._read_theme_colors()
        self.style_catalog = self._read_styles()
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

    def _read_theme_colors(self) -> list[dict[str, Any]]:
        theme_part = "xl/theme/theme1.xml"
        if theme_part not in self.parts:
            return []
        root = self._xml(theme_part)
        scheme = root.find("a:themeElements/a:clrScheme", NS)
        if scheme is None:
            return []
        colors: list[dict[str, Any]] = []
        for index, wrapper in enumerate(list(scheme)):
            value = next(iter(wrapper), None)
            if value is None:
                colors.append({
                    "index": index,
                    "name": THEME_COLOR_NAMES[index] if index < len(THEME_COLOR_NAMES) else f"theme{index}",
                })
                continue
            color_type = value.tag.rsplit("}", 1)[-1]
            raw = (
                value.get("lastClr") or value.get("val") or ""
                if color_type == "sysClr"
                else value.get("val") or value.get("lastClr") or ""
            )
            colors.append({
                "index": index,
                "name": THEME_COLOR_NAMES[index] if index < len(THEME_COLOR_NAMES) else f"theme{index}",
                "type": color_type,
                "rgb": raw.upper(),
            })
        return colors

    def _font(self, element: ET.Element) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": element.find("m:name", NS).get("val")
            if element.find("m:name", NS) is not None
            else None,
            "size": float(element.find("m:sz", NS).get("val", "0"))
            if element.find("m:sz", NS) is not None
            else None,
            "bold": _flag(element.find("m:b", NS)),
            "italic": _flag(element.find("m:i", NS)),
            "strike": _flag(element.find("m:strike", NS)),
            "color": _color(element.find("m:color", NS), self.theme_colors),
        }
        underline = element.find("m:u", NS)
        if underline is not None:
            result["underline"] = underline.get("val", "single")
        for name in ("family", "charset", "scheme", "vertAlign"):
            child = element.find(f"m:{name}", NS)
            if child is not None and child.get("val") is not None:
                result[name] = child.get("val")
        return {key: value for key, value in result.items() if value is not None}

    def _fill(self, element: ET.Element) -> dict[str, Any]:
        pattern = element.find("m:patternFill", NS)
        if pattern is not None:
            return {
                "type": "pattern",
                "patternType": pattern.get("patternType", "none"),
                "foregroundColor": _color(pattern.find("m:fgColor", NS), self.theme_colors),
                "backgroundColor": _color(pattern.find("m:bgColor", NS), self.theme_colors),
            }
        gradient = element.find("m:gradientFill", NS)
        if gradient is not None:
            stops = []
            for stop in gradient.findall("m:stop", NS):
                stops.append({
                    "position": float(stop.get("position", "0")),
                    "color": _color(next(iter(stop), None), self.theme_colors),
                })
            return {"type": "gradient", "attributes": _typed_attributes(gradient), "stops": stops}
        return {"type": "none"}

    def _border(self, element: ET.Element) -> dict[str, Any]:
        sides: dict[str, Any] = {}
        for side_name in ("left", "right", "top", "bottom", "diagonal", "vertical", "horizontal"):
            side = element.find(f"m:{side_name}", NS)
            if side is None:
                continue
            parsed = {
                "style": side.get("style"),
                "color": _color(side.find("m:color", NS), self.theme_colors),
            }
            if parsed["style"] is not None or parsed["color"] is not None:
                sides[side_name] = {
                    key: value for key, value in parsed.items() if value is not None
                }
        return sides

    def _read_styles(self) -> dict[str, Any]:
        styles_part = "xl/styles.xml"
        if styles_part not in self.parts:
            return {
                "themeColors": self.theme_colors,
                "fonts": [],
                "fills": [],
                "numberFormats": [],
                "cellFormats": [{"id": 0, "fontId": 0, "fillId": 0, "borderId": 0, "numFmtId": 0}],
            }
        root = self._xml(styles_part)
        fonts_node = root.find("m:fonts", NS)
        fills_node = root.find("m:fills", NS)
        borders_node = root.find("m:borders", NS)
        formats_node = root.find("m:numFmts", NS)
        xfs_node = root.find("m:cellXfs", NS)
        fonts = [
            self._font(item)
            for item in (list(fonts_node) if fonts_node is not None else [])
        ]
        fills = [
            self._fill(item)
            for item in (list(fills_node) if fills_node is not None else [])
        ]
        borders = [
            self._border(item)
            for item in (list(borders_node) if borders_node is not None else [])
        ]
        custom_formats = {
            int(item.get("numFmtId", "0")): item.get("formatCode", "")
            for item in (list(formats_node) if formats_node is not None else [])
        }
        format_ids = set(BUILTIN_NUMBER_FORMATS) | set(custom_formats)
        number_formats = [
            {
                "id": format_id,
                "code": custom_formats.get(format_id, BUILTIN_NUMBER_FORMATS.get(format_id)),
                "source": "custom" if format_id in custom_formats else "builtin",
            }
            for format_id in sorted(format_ids)
        ]
        cell_formats = []
        for index, item in enumerate(list(xfs_node) if xfs_node is not None else []):
            cell_format: dict[str, Any] = {
                "id": index,
                "fontId": int(item.get("fontId", "0")),
                "fillId": int(item.get("fillId", "0")),
                "borderId": int(item.get("borderId", "0")),
                "numFmtId": int(item.get("numFmtId", "0")),
                "xfId": int(item.get("xfId", "0")),
            }
            alignment = item.find("m:alignment", NS)
            if alignment is not None:
                cell_format["alignment"] = _typed_attributes(alignment)
            protection = item.find("m:protection", NS)
            if protection is not None:
                cell_format["protection"] = _typed_attributes(protection)
            applied = {
                key: value in {"1", "true"}
                for key, value in item.attrib.items()
                if key.startswith("apply")
            }
            if applied:
                cell_format["applied"] = applied
            cell_formats.append(cell_format)
        if not cell_formats:
            cell_formats.append({"id": 0, "fontId": 0, "fillId": 0, "borderId": 0, "numFmtId": 0})
        return {
            "themeColors": self.theme_colors,
            "fonts": fonts,
            "fills": fills,
            "borders": borders,
            "numberFormats": number_formats,
            "cellFormats": cell_formats,
        }

    def resolved_style(self, style_id: int) -> dict[str, Any]:
        formats = self.style_catalog["cellFormats"]
        cell_format = formats[style_id] if 0 <= style_id < len(formats) else formats[0]
        font_id = cell_format["fontId"]
        fill_id = cell_format["fillId"]
        fonts = self.style_catalog["fonts"]
        fills = self.style_catalog["fills"]
        borders = self.style_catalog.get("borders", [])
        border_id = cell_format["borderId"]
        number_format = next(
            (
                item
                for item in self.style_catalog["numberFormats"]
                if item["id"] == cell_format["numFmtId"]
            ),
            {"id": cell_format["numFmtId"], "code": None, "source": "unknown"},
        )
        return {
            "styleId": style_id,
            "font": fonts[font_id] if 0 <= font_id < len(fonts) else {},
            "fill": fills[fill_id] if 0 <= fill_id < len(fills) else {},
            "border": borders[border_id] if 0 <= border_id < len(borders) else {},
            "numberFormat": number_format,
            "alignment": cell_format.get("alignment", {}),
            "protection": cell_format.get("protection", {}),
        }

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
                author = authors[author_id] if author_id < len(authors) else ""
                text = _text(comment.find("m:text", NS)) or ""
                author_prefix = f"{author}:" if author else ""
                if author_prefix and text.startswith(author_prefix):
                    text = text[len(author_prefix):].lstrip()
                comments.append({
                    "cell": comment.get("ref", ""),
                    "text": text,
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
        conditional_formatting = []
        for item in root.findall("m:conditionalFormatting", NS):
            rules = []
            for rule in item.findall("m:cfRule", NS):
                rules.append({
                    "type": rule.get("type", ""),
                    "priority": int(rule.get("priority", "0")),
                    "dxfId": int(rule.get("dxfId")) if rule.get("dxfId") is not None else None,
                    "operator": rule.get("operator"),
                    "stopIfTrue": rule.get("stopIfTrue") in {"1", "true"},
                    "formulas": [formula.text or "" for formula in rule.findall("m:formula", NS)],
                })
            conditional_formatting.append({"ranges": item.get("sqref", ""), "rules": rules})
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
            "conditionalFormatting": conditional_formatting,
        }
        if cell_mode == "formula":
            inventory["cells"] = [cell for cell in cells if "formula" in cell]
        elif cell_mode == "style":
            inventory["cells"] = [
                {"cell": cell["cell"], "styleId": cell["style"]}
                for cell in cells
            ]
        elif cell_mode == "all":
            inventory["cells"] = [
                {**cell, "resolvedStyle": self.resolved_style(cell["style"])}
                for cell in cells
            ]
        return inventory

    def inventory(self, cell_mode: str = "none") -> dict[str, Any]:
        if cell_mode not in {"none", "formula", "style", "all"}:
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
                "styleCatalog": self.style_catalog,
            },
            "sheets": sheet_inventories,
        }
