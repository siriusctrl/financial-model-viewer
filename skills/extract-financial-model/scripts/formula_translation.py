"""Restricted, replay-checked translation from mapped Excel formulas."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from decimal import Decimal
import math
import re
from typing import Any


CELL_REFERENCE = re.compile(
    r"(?<![A-Z0-9_.!])(?P<cell>\$?[A-Z]{1,3}\$?[1-9][0-9]*)(?![A-Z0-9_])",
    re.IGNORECASE,
)
SUM_RANGE = re.compile(
    r"SUM\(\s*(?P<start>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*:\s*"
    r"(?P<end>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*\)",
    re.IGNORECASE,
)
PERCENT_LITERAL = re.compile(
    r"(?<![A-Z0-9_.])(?P<number>(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))%(?![A-Z0-9_])",
    re.IGNORECASE,
)
COORDINATE = re.compile(r"(?P<column>[A-Z]{1,3})(?P<row>[1-9][0-9]*)", re.IGNORECASE)


@dataclass(frozen=True)
class FormulaTranslation:
    expression: str
    dependency_metric_ids: list[str]


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
    ):
        self.cells = cells
        self.coordinate_semantics = coordinate_semantics

    def _canonical_cell_reference(
        self,
        coordinate: str,
        target_coordinate: str,
        target_period_id: str,
    ) -> tuple[str, float | int, str] | None:
        normalized = coordinate.replace("$", "").upper()
        if normalized == target_coordinate.upper():
            return None
        semantic = self.coordinate_semantics.get(normalized)
        cell = self.cells.get(normalized)
        if not semantic or not cell:
            return None
        value = _numeric(cell.get("value"))
        data_type = semantic["dataType"]
        if value is None or data_type not in {"number", "percentage", "currency", "count"}:
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

    def _resolve_sum_range(
        self,
        start: str,
        end: str,
        target_coordinate: str,
        target_period_id: str,
    ) -> tuple[str, float | int, list[str]] | None:
        coordinates = _expand_range(start, end)
        if not coordinates:
            return None
        references = [
            self._canonical_cell_reference(coordinate, target_coordinate, target_period_id)
            for coordinate in coordinates
        ]
        if any(reference is None for reference in references):
            return None
        resolved = [reference for reference in references if reference is not None]
        return (
            f"sum({', '.join(reference[0] for reference in resolved)})",
            sum(reference[1] for reference in resolved),
            sorted({reference[2] for reference in resolved}),
        )

    def _translate_sum_range(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
    ) -> FormulaTranslation | None:
        match = SUM_RANGE.fullmatch(formula_body)
        if not match:
            return None
        resolved = self._resolve_sum_range(
            match.group("start"),
            match.group("end"),
            target_coordinate,
            target_period_id,
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
    ) -> FormulaTranslation | None:
        if "!" in formula_body or "'" in formula_body or '"' in formula_body:
            return None
        formula_body = PERCENT_LITERAL.sub(_percentage_value, formula_body)
        compiled_names: dict[str, tuple[str, float | int, list[str]]] = {}
        unsupported_sum = False

        def replace_sum(match: re.Match[str]) -> str:
            nonlocal unsupported_sum
            resolved = self._resolve_sum_range(
                match.group("start"),
                match.group("end"),
                target_coordinate,
                target_period_id,
            )
            if resolved is None:
                unsupported_sum = True
                return match.group(0)
            name = f"range_{len(compiled_names)}"
            compiled_names[name] = resolved
            return name

        formula_body = SUM_RANGE.sub(replace_sum, formula_body)
        if unsupported_sum or ":" in formula_body:
            return None
        coordinate_by_name: dict[str, str] = {}
        name_by_coordinate: dict[str, str] = {}

        def replace_reference(match: re.Match[str]) -> str:
            coordinate = match.group("cell").replace("$", "").upper()
            name = name_by_coordinate.get(coordinate)
            if name is None:
                name = f"cell_{len(name_by_coordinate)}"
                name_by_coordinate[coordinate] = name
                coordinate_by_name[name] = coordinate
            return name

        python_expression = CELL_REFERENCE.sub(replace_reference, formula_body)
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
                coordinate = coordinate_by_name.get(node.id)
                if coordinate is None:
                    return None
                reference = self._canonical_cell_reference(
                    coordinate,
                    target_coordinate,
                    target_period_id,
                )
                if reference is None:
                    return None
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
                    calculated = {
                        "+": left[1] + right[1],
                        "-": left[1] - right[1],
                        "*": left[1] * right[1],
                        "/": left[1] / right[1],
                    }[operator]
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
    ) -> FormulaTranslation | None:
        cached = _numeric(target_value)
        if cached is None or not original_formula.startswith("="):
            return None
        formula_body = original_formula[1:].strip()
        return self._translate_sum_range(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
        ) or self._translate_arithmetic(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
        )

    def blocker(self, original_formula: str) -> str:
        formula_body = original_formula[1:].strip() if original_formula.startswith("=") else original_formula
        if "!" in formula_body:
            return "cross-sheet reference without an explicit semantic map for that source sheet"

        referenced_coordinates = {
            match.group("cell").replace("$", "").upper()
            for match in CELL_REFERENCE.finditer(formula_body)
        }
        for match in SUM_RANGE.finditer(formula_body):
            referenced_coordinates.update(_expand_range(match.group("start"), match.group("end")))
        if any(
            coordinate not in self.coordinate_semantics
            for coordinate in referenced_coordinates
        ):
            return "referenced cells outside the selected semantic map"
        return "restricted-syntax or cached-value replay failure"
