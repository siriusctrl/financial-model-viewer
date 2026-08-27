"""Restricted, replay-checked translation from mapped Excel formulas."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from decimal import Decimal
import math
import re
from typing import Any


QUALIFIED_CELL_REFERENCE = re.compile(
    r"(?<![A-Z0-9_.!])"
    r"(?:(?:'(?P<quoted>[^']+)'|(?P<plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<cell>\$?[A-Z]{1,3}\$?[1-9][0-9]*)(?![A-Z0-9_])",
    re.IGNORECASE,
)
QUALIFIED_AGGREGATE_RANGE = re.compile(
    r"(?P<function>SUM|AVERAGE)\(\s*"
    r"(?:(?:'(?P<start_quoted>[^']+)'|(?P<start_plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<start>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*:\s*"
    r"(?:(?:'(?P<end_quoted>[^']+)'|(?P<end_plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<end>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*\)",
    re.IGNORECASE,
)
PERCENT_LITERAL = re.compile(
    r"(?<![A-Z0-9_.])(?P<number>(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))%(?![A-Z0-9_])",
    re.IGNORECASE,
)
FUNCTION_CALL = re.compile(
    r"(?<![A-Z0-9_.])(?P<name>[A-Z][A-Z0-9_.]*)\s*\(",
    re.IGNORECASE,
)
COORDINATE = re.compile(r"(?P<column>[A-Z]{1,3})(?P<row>[1-9][0-9]*)", re.IGNORECASE)


@dataclass(frozen=True)
class FormulaTranslation:
    expression: str
    dependency_metric_ids: list[str]


@dataclass(frozen=True)
class FormulaBlocker:
    kind: str
    reason: str
    coordinates: tuple[str, ...] = ()


def _column_number(label: str) -> int:
    value = 0
    for character in label.upper():
        value = value * 26 + ord(character) - ord("A") + 1
    return value


def _column_label(number: int) -> str:
    result = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def _coordinate_parts(coordinate: str) -> tuple[int, int]:
    normalized = coordinate.replace("$", "").upper()
    match = COORDINATE.fullmatch(normalized)
    if not match:
        raise ValueError(f"Unsupported cell coordinate: {coordinate}")
    return _column_number(match.group("column")), int(match.group("row"))


def _expand_range(start: str, end: str) -> list[str]:
    start_column, start_row = _coordinate_parts(start)
    end_column, end_row = _coordinate_parts(end)
    if start_column > end_column or start_row > end_row:
        return []
    if (end_column - start_column + 1) * (end_row - start_row + 1) > 1_000:
        return []
    return [
        f"{_column_label(column)}{row}"
        for row in range(start_row, end_row + 1)
        for column in range(start_column, end_column + 1)
    ]


def _numeric(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def _values_match(calculated: float | int, cached: float | int) -> bool:
    return math.isclose(calculated, cached, rel_tol=1e-9, abs_tol=1e-8)


def _percentage_value(match: re.Match[str]) -> str:
    return format(Decimal(match.group("number")) / Decimal(100), "f")


class FormulaTranslator:
    """Compile a small Excel subset only through explicitly mapped numeric cells."""

    def __init__(
        self,
        cells: dict[str, dict[str, Any]],
        coordinate_semantics: dict[str, dict[str, str]],
        default_sheet: str | None = None,
        strict_grid: bool = True,
    ):
        self.cells = cells
        self.coordinate_semantics = coordinate_semantics
        self.default_sheet = default_sheet
        self.strict_grid = strict_grid
        self.qualified = default_sheet is not None or any(
            "!" in coordinate for coordinate in coordinate_semantics
        )
        self.mapped_columns: dict[str | None, set[int]] = {}
        self.mapped_rows: dict[str | None, set[int]] = {}
        self.mapped_sheets: set[str | None] = set()
        for key in coordinate_semantics:
            sheet, coordinate = self._split_key(key)
            column, row = _coordinate_parts(coordinate)
            self.mapped_sheets.add(sheet)
            self.mapped_columns.setdefault(sheet, set()).add(column)
            self.mapped_rows.setdefault(sheet, set()).add(row)

    @staticmethod
    def _split_key(key: str) -> tuple[str | None, str]:
        if "!" not in key:
            return None, key.replace("$", "").upper()
        sheet, coordinate = key.rsplit("!", 1)
        return sheet, coordinate.replace("$", "").upper()

    def _key(
        self,
        coordinate: str,
        reference_sheet: str | None,
        target_sheet: str | None,
    ) -> str | None:
        normalized = coordinate.replace("$", "").upper()
        if not self.qualified:
            return f"{reference_sheet}!{normalized}" if reference_sheet else normalized
        sheet = reference_sheet or target_sheet or self.default_sheet
        return f"{sheet}!{normalized}" if sheet else None

    @staticmethod
    def _sheet_from_match(match: re.Match[str], prefix: str) -> str | None:
        return match.group(f"{prefix}_quoted") or match.group(f"{prefix}_plain")

    def _canonical_cell_reference(
        self,
        coordinate: str,
        target_coordinate: str,
        target_period_id: str,
        reference_sheet: str | None = None,
        target_sheet: str | None = None,
    ) -> tuple[str, float | int, str | None] | None:
        key = self._key(coordinate, reference_sheet, target_sheet)
        target_key = self._key(target_coordinate, target_sheet, target_sheet)
        if key is None or key == target_key:
            return None
        semantic = self.coordinate_semantics.get(key)
        if not semantic:
            return None
        data_type = semantic["dataType"]
        if data_type not in {"number", "percentage", "currency", "count"}:
            return None
        cell = self.cells.get(key)
        raw_value = cell.get("value") if cell else None
        if raw_value is None:
            # Excel coerces a directly referenced blank cell to zero in numeric
            # arithmetic. Keep it as a literal: there is no source observation.
            return "0", 0, None
        value = _numeric(raw_value)
        if value is None:
            return None
        if data_type == "count" and not isinstance(value, int):
            return None
        metric_id = semantic["metricId"]
        period_id = semantic["periodId"]
        expression = (
            f'ref("{metric_id}")'
            if period_id == target_period_id
            else f'period_ref("{metric_id}", "{period_id}")'
        )
        return expression, value, metric_id

    def _resolve_aggregate_range(
        self,
        function_name: str,
        start: str,
        end: str,
        target_coordinate: str,
        target_period_id: str,
        start_sheet: str | None = None,
        end_sheet: str | None = None,
        target_sheet: str | None = None,
    ) -> tuple[str, float | int, list[str]] | None:
        resolved_start_sheet = start_sheet or target_sheet or self.default_sheet
        resolved_end_sheet = end_sheet or resolved_start_sheet
        if resolved_start_sheet != resolved_end_sheet:
            return None
        coordinates = _expand_range(start, end)
        if not coordinates:
            return None
        references = [
            self._canonical_cell_reference(
                coordinate,
                target_coordinate,
                target_period_id,
                resolved_start_sheet,
                target_sheet,
            )
            for coordinate in coordinates
        ]
        if any(reference is None for reference in references):
            return None
        resolved = [reference for reference in references if reference is not None]
        normalized_function = function_name.lower()
        included = (
            [reference for reference in resolved if reference[2] is not None]
            if normalized_function == "average"
            else resolved
        )
        if not included:
            return None
        values = [reference[1] for reference in included]
        calculated = (
            sum(values) / len(values)
            if normalized_function == "average"
            else sum(values)
        )
        return (
            f"{normalized_function}({', '.join(reference[0] for reference in included)})",
            calculated,
            sorted({reference[2] for reference in included if reference[2] is not None}),
        )

    def _translate_aggregate_range(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        match = QUALIFIED_AGGREGATE_RANGE.fullmatch(formula_body)
        if not match:
            return None
        start_sheet = self._sheet_from_match(match, "start")
        end_sheet = self._sheet_from_match(match, "end")
        resolved = self._resolve_aggregate_range(
            match.group("function"),
            match.group("start"),
            match.group("end"),
            target_coordinate,
            target_period_id,
            start_sheet,
            end_sheet,
            target_sheet,
        )
        if resolved is None or not _values_match(resolved[1], target_value):
            return None
        return FormulaTranslation(resolved[0], resolved[2])

    def _translate_arithmetic(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        if '"' in formula_body:
            return None
        formula_body = PERCENT_LITERAL.sub(_percentage_value, formula_body)
        compiled_names: dict[str, tuple[str, float | int, list[str]]] = {}
        unsupported_aggregate = False

        def replace_aggregate(match: re.Match[str]) -> str:
            nonlocal unsupported_aggregate
            resolved = self._resolve_aggregate_range(
                match.group("function"),
                match.group("start"),
                match.group("end"),
                target_coordinate,
                target_period_id,
                self._sheet_from_match(match, "start"),
                self._sheet_from_match(match, "end"),
                target_sheet,
            )
            if resolved is None:
                unsupported_aggregate = True
                return match.group(0)
            name = f"range_{len(compiled_names)}"
            compiled_names[name] = resolved
            return name

        formula_body = QUALIFIED_AGGREGATE_RANGE.sub(replace_aggregate, formula_body)
        if unsupported_aggregate or ":" in formula_body:
            return None
        coordinate_by_name: dict[str, tuple[str | None, str]] = {}
        name_by_coordinate: dict[tuple[str | None, str], str] = {}

        def replace_reference(match: re.Match[str]) -> str:
            coordinate = match.group("cell").replace("$", "").upper()
            sheet = match.group("quoted") or match.group("plain")
            source = (sheet, coordinate)
            name = name_by_coordinate.get(source)
            if name is None:
                name = f"cell_{len(name_by_coordinate)}"
                name_by_coordinate[source] = name
                coordinate_by_name[name] = source
            return name

        python_expression = QUALIFIED_CELL_REFERENCE.sub(replace_reference, formula_body)
        try:
            parsed = ast.parse(python_expression, mode="eval")
        except SyntaxError:
            return None

        dependencies: set[str] = set()

        def compile_node(node: ast.AST) -> tuple[str, float | int] | None:
            if isinstance(node, ast.Expression):
                return compile_node(node.body)
            if isinstance(node, ast.Constant):
                value = _numeric(node.value)
                return (repr(value), value) if value is not None else None
            if isinstance(node, ast.Name):
                compiled_name = compiled_names.get(node.id)
                if compiled_name is not None:
                    dependencies.update(compiled_name[2])
                    return compiled_name[0], compiled_name[1]
                source = coordinate_by_name.get(node.id)
                if source is None:
                    return None
                reference_sheet, coordinate = source
                reference = self._canonical_cell_reference(
                    coordinate,
                    target_coordinate,
                    target_period_id,
                    reference_sheet,
                    target_sheet,
                )
                if reference is None:
                    return None
                if reference[2] is not None:
                    dependencies.add(reference[2])
                return reference[0], reference[1]
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                operand = compile_node(node.operand)
                if operand is None:
                    return None
                return (
                    (f"(-{operand[0]})", -operand[1])
                    if isinstance(node.op, ast.USub)
                    else (f"(+{operand[0]})", operand[1])
                )
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id.upper() in {"SUM", "AVERAGE"}
                and node.args
                and not node.keywords
            ):
                argument_nodes = node.args
                arguments = [compile_node(argument) for argument in argument_nodes]
                if any(argument is None for argument in arguments):
                    return None
                compiled_arguments = [
                    (argument_node, argument)
                    for argument_node, argument in zip(argument_nodes, arguments, strict=True)
                    if argument is not None
                ]
                function_name = node.func.id.lower()
                if function_name == "average":
                    compiled_arguments = [
                        (argument_node, argument)
                        for argument_node, argument in compiled_arguments
                        if not (
                            isinstance(argument_node, ast.Name)
                            and argument_node.id in coordinate_by_name
                            and self._canonical_cell_reference(
                                coordinate_by_name[argument_node.id][1],
                                target_coordinate,
                                target_period_id,
                                coordinate_by_name[argument_node.id][0],
                                target_sheet,
                            )[2] is None
                        )
                    ]
                    if not compiled_arguments:
                        return None
                values = [argument[1] for _node, argument in compiled_arguments]
                calculated = (
                    sum(values) / len(values)
                    if function_name == "average"
                    else sum(values)
                )
                return (
                    f"{function_name}({', '.join(argument[0] for _node, argument in compiled_arguments)})",
                    calculated,
                )
            if isinstance(node, ast.BinOp) and isinstance(
                node.op,
                (ast.Add, ast.Sub, ast.Mult, ast.Div),
            ):
                left = compile_node(node.left)
                right = compile_node(node.right)
                if left is None or right is None:
                    return None
                operator = {
                    ast.Add: "+",
                    ast.Sub: "-",
                    ast.Mult: "*",
                    ast.Div: "/",
                }[type(node.op)]
                try:
                    if operator == "+":
                        calculated = left[1] + right[1]
                    elif operator == "-":
                        calculated = left[1] - right[1]
                    elif operator == "*":
                        calculated = left[1] * right[1]
                    else:
                        calculated = left[1] / right[1]
                except ZeroDivisionError:
                    return None
                return f"({left[0]} {operator} {right[0]})", calculated
            return None

        compiled = compile_node(parsed)
        if compiled is None or not _values_match(compiled[1], target_value):
            return None
        return FormulaTranslation(compiled[0], sorted(dependencies))

    def translate(
        self,
        original_formula: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: Any,
        target_sheet: str | None = None,
    ) -> FormulaTranslation | None:
        cached = _numeric(target_value)
        if cached is None or not original_formula.startswith("="):
            return None
        formula_body = original_formula[1:].strip()
        return self._translate_aggregate_range(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        ) or self._translate_arithmetic(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        )

    def blocker_details(
        self,
        original_formula: str,
        target_sheet: str | None = None,
    ) -> FormulaBlocker:
        formula_body = original_formula[1:].strip() if original_formula.startswith("=") else original_formula
        unsupported_functions = sorted({
            match.group("name").upper()
            for match in FUNCTION_CALL.finditer(formula_body)
            if match.group("name").upper() not in {"SUM", "AVERAGE"}
        })
        if unsupported_functions:
            return FormulaBlocker(
                "syntax_or_replay",
                "unsupported Excel function(s): " + ", ".join(unsupported_functions),
            )
        referenced_coordinates: set[str] = set()
        without_ranges = formula_body
        for match in QUALIFIED_AGGREGATE_RANGE.finditer(formula_body):
            start_sheet = self._sheet_from_match(match, "start")
            end_sheet = self._sheet_from_match(match, "end") or start_sheet
            if start_sheet and end_sheet and start_sheet != end_sheet:
                return FormulaBlocker(
                    "unsupported_range",
                    "three-dimensional or cross-sheet range endpoints are not supported",
                )
            for coordinate in _expand_range(match.group("start"), match.group("end")):
                key = self._key(coordinate, start_sheet, target_sheet)
                if key:
                    referenced_coordinates.add(key)
        without_ranges = QUALIFIED_AGGREGATE_RANGE.sub("", without_ranges)
        for match in QUALIFIED_CELL_REFERENCE.finditer(without_ranges):
            key = self._key(
                match.group("cell"),
                match.group("quoted") or match.group("plain"),
                target_sheet,
            )
            if key:
                referenced_coordinates.add(key)
        missing_coordinates = sorted(
            coordinate
            for coordinate in referenced_coordinates
            if coordinate not in self.coordinate_semantics
        )
        if missing_coordinates:
            missing_sheets = sorted({
                sheet
                for coordinate in missing_coordinates
                for sheet, _cell in [self._split_key(coordinate)]
                if sheet not in self.mapped_sheets
            })
            if missing_sheets:
                return FormulaBlocker(
                    "unmapped_sheet",
                    "referenced worksheet semantics are not mapped: "
                    + ", ".join(f"`{sheet}`" for sheet in missing_sheets),
                    tuple(missing_coordinates),
                )
            missing_parts = {
                coordinate: (*self._split_key(coordinate)[:1], *_coordinate_parts(self._split_key(coordinate)[1]))
                for coordinate in missing_coordinates
            }
            period_gaps = [
                coordinate
                for coordinate, (sheet, column, row) in missing_parts.items()
                if self.strict_grid
                and row in self.mapped_rows.get(sheet, set())
                and column not in self.mapped_columns.get(sheet, set())
            ]
            metric_gaps = [
                coordinate
                for coordinate, (sheet, column, row) in missing_parts.items()
                if self.strict_grid
                and column in self.mapped_columns.get(sheet, set())
                and row not in self.mapped_rows.get(sheet, set())
            ]
            coordinates = tuple(missing_coordinates)
            if len(period_gaps) == len(missing_coordinates):
                return FormulaBlocker(
                    "unmapped_period",
                    "referenced period columns outside the selected semantic map",
                    coordinates,
                )
            if len(metric_gaps) == len(missing_coordinates):
                return FormulaBlocker(
                    "unmapped_metric",
                    "referenced metric rows outside the selected semantic map",
                    coordinates,
                )
            return FormulaBlocker(
                "unmapped_cells",
                "referenced cells outside the selected semantic map",
                coordinates,
            )
        return FormulaBlocker(
            "syntax_or_replay",
            "restricted-syntax or cached-value replay failure",
        )

    def blocker(self, original_formula: str, target_sheet: str | None = None) -> str:
        return self.blocker_details(original_formula, target_sheet).reason
