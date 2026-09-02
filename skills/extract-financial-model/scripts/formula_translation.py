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
QUALIFIED_RANGE_REFERENCE = re.compile(
    r"(?<![A-Z0-9_.!])"
    r"(?:(?:'(?P<start_quoted>[^']+)'|(?P<start_plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<start>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*:\s*"
    r"(?:(?:'(?P<end_quoted>[^']+)'|(?P<end_plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<end>\$?[A-Z]{1,3}\$?[1-9][0-9]*)(?![A-Z0-9_])",
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
STATIC_INDIRECT = re.compile(
    r"INDIRECT\(\s*ADDRESS\(\s*ROW\(\s*\)\s*,\s*"
    r"(?:(?:'(?P<quoted>[^']+)'|(?P<plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<cell>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*\)\s*\)",
    re.IGNORECASE,
)
EMPTY_ARGUMENT = re.compile(r",(\s*)(?=[,)])")
EXCEL_EQUALITY = re.compile(r"(?<![<>=!])=(?!=)")
EXCEL_BOOLEAN = re.compile(r"(?<![A-Z0-9_.])(?P<value>TRUE|FALSE)(?![A-Z0-9_])", re.IGNORECASE)
RIGHT_TEXT_COMPARISON = re.compile(
    r"RIGHT\(\s*"
    r"(?:(?:'(?P<quoted>[^']+)'|(?P<plain>[A-Za-z_][A-Za-z0-9_. ]*))!)?"
    r"(?P<cell>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*,\s*"
    r"(?P<count>[1-9][0-9]*)\s*\)\s*"
    r"(?P<operator>=|<>)\s*\"(?P<expected>[^\"]*)\"",
    re.IGNORECASE,
)
CONDITIONAL_AGGREGATE = re.compile(
    r"(?P<function>SUMIFS|AVERAGEIFS)\(\s*"
    r"(?P<sum_start>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*:\s*"
    r"(?P<sum_end>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*,\s*"
    r"(?P<criteria_start>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*:\s*"
    r"(?P<criteria_end>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*,\s*"
    r"(?P<criterion>\$?[A-Z]{1,3}\$?[1-9][0-9]*)\s*\)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class FormulaTranslation:
    expression: str
    dependency_metric_ids: list[str]


@dataclass(frozen=True)
class FormulaBlocker:
    kind: str
    reason: str
    coordinates: tuple[str, ...] = ()


@dataclass(frozen=True)
class _ResolvedRange:
    references: tuple[tuple[str, float | int, str | None], ...]


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


def expand_cell_range(start: str, end: str) -> list[str]:
    """Expand a bounded A1 range for explicitly trusted workbook-map locators."""
    return _expand_range(start, end)


def _numeric(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def _values_match(calculated: float | int, cached: float | int) -> bool:
    return math.isclose(calculated, cached, rel_tol=1e-9, abs_tol=1e-8)


def _percentage_value(match: re.Match[str]) -> str:
    return format(Decimal(match.group("number")) / Decimal(100), "f")


def _boolean_value(match: re.Match[str]) -> str:
    return "True" if match.group("value").upper() == "TRUE" else "False"


def _excel_mod(value: float | int, divisor: float | int) -> float | int:
    if divisor == 0:
        raise ZeroDivisionError
    return value - divisor * math.floor(value / divisor)


def _excel_criterion_equal(left: Any, right: Any) -> bool:
    """Compare simple SUMIFS criteria with Excel's numeric-text coercion."""
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    numeric_values: list[float] = []
    for value in (left, right):
        if isinstance(value, (int, float)) and math.isfinite(value):
            numeric_values.append(float(value))
            continue
        if isinstance(value, str):
            try:
                parsed = float(value.strip())
            except ValueError:
                break
            if math.isfinite(parsed):
                numeric_values.append(parsed)
                continue
        break
    if len(numeric_values) == 2:
        return numeric_values[0] == numeric_values[1]
    return left == right


class FormulaTranslator:
    """Compile a small Excel subset only through explicitly mapped numeric cells."""

    def __init__(
        self,
        cells: dict[str, dict[str, Any]],
        coordinate_semantics: dict[str, dict[str, str]],
        default_sheet: str | None = None,
        strict_grid: bool = True,
        literal_coordinates: set[str] | None = None,
        available_sheets: set[str] | None = None,
    ):
        self.cells = cells
        self.coordinate_semantics = coordinate_semantics
        self.default_sheet = default_sheet
        self.strict_grid = strict_grid
        self.literal_coordinates = literal_coordinates or set()
        inferred_sheets = {
            self._split_key(key)[0]
            for key in cells
        }
        self.available_sheets: set[str | None] = set(available_sheets or inferred_sheets)
        if default_sheet is not None:
            self.available_sheets.add(default_sheet)
        if not any("!" in key for key in cells):
            self.available_sheets.add(None)
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

    def _is_material_blank(self, key: str) -> bool:
        cell = self.cells.get(key)
        if cell is not None:
            return cell.get("value") is None and "formula" not in cell
        sheet, _coordinate = self._split_key(key)
        return sheet in self.available_sheets

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

    def _resolve_static_indirect(
        self,
        formula_body: str,
        target_coordinate: str,
        target_sheet: str | None,
    ) -> tuple[str, str | None]:
        """Rewrite ``INDIRECT(ADDRESS(ROW(), <index cell>))`` into a concrete same-row reference.

        The idiom addresses a fixed column by number; it is workbook layout, not data.
        The index cell must sit inside a declared ``periodHeaderRanges`` locator and hold an
        integer cached column number. Anything else is left untouched so the caller reports
        the INDIRECT blocker instead of guessing a coordinate.
        """
        row = _coordinate_parts(target_coordinate)[1]
        failure: str | None = None

        def replace(match: re.Match[str]) -> str:
            nonlocal failure
            key = self._key(
                match.group("cell"), match.group("quoted") or match.group("plain"), target_sheet
            )
            cell = self.cells.get(key) if key else None
            value = cell.get("value") if cell else None
            if key not in self.literal_coordinates:
                failure = f"INDIRECT index cell {key} is outside the declared periodHeaderRanges"
                return match.group(0)
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or value != int(value)
                or value < 1
            ):
                failure = f"INDIRECT index cell {key} does not hold an integer column number"
                return match.group(0)
            return f"{_column_label(int(value))}{row}"

        return STATIC_INDIRECT.sub(replace, formula_body), failure

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
            cell = self.cells.get(key)
            if self._is_material_blank(key):
                # A referenced, materially blank workbook cell is numeric zero in
                # Excel arithmetic. Preserve that coercion as a literal without
                # inventing an observation for an empty source cell.
                return "0", 0, None
            if key not in self.literal_coordinates:
                return None
            if cell and "formula" in cell:
                return None
            value = _numeric(cell.get("value") if cell else None)
            return (repr(value), value, None) if value is not None else None
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
        references: list[tuple[str, float | int, str | None]] = []
        for coordinate in coordinates:
            reference = self._canonical_cell_reference(
                coordinate,
                target_coordinate,
                target_period_id,
                resolved_start_sheet,
                target_sheet,
            )
            if reference is None:
                key = self._key(coordinate, resolved_start_sheet, target_sheet)
                raw_value = self.cells.get(key, {}).get("value") if key else None
                if not isinstance(raw_value, str):
                    return None
                # Excel SUM/AVERAGE ignore text returned by referenced cells.
                # Preserve the current branch as a literal rather than inventing
                # a numeric helper observation for values such as "n.a." or "0".
                reference = ("0", 0, None)
            references.append(reference)
        resolved = references
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

    def _translate_conditional_aggregate(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        match = CONDITIONAL_AGGREGATE.fullmatch(formula_body)
        if not match:
            return None
        sum_coordinates = _expand_range(match.group("sum_start"), match.group("sum_end"))
        criteria_coordinates = _expand_range(
            match.group("criteria_start"), match.group("criteria_end")
        )
        if not sum_coordinates or len(sum_coordinates) != len(criteria_coordinates):
            return None
        criterion_key = self._key(match.group("criterion"), None, target_sheet)
        criterion_cell = self.cells.get(criterion_key) if criterion_key else None
        criterion = criterion_cell.get("value") if criterion_cell else None
        if criterion is None:
            return None

        selected: list[tuple[str, float | int, str | None]] = []
        for sum_coordinate, criteria_coordinate in zip(
            sum_coordinates, criteria_coordinates, strict=True
        ):
            criteria_key = self._key(criteria_coordinate, None, target_sheet)
            criteria_cell = self.cells.get(criteria_key) if criteria_key else None
            if not criteria_cell or not _excel_criterion_equal(
                criteria_cell.get("value"), criterion
            ):
                continue
            reference = self._canonical_cell_reference(
                sum_coordinate,
                target_coordinate,
                target_period_id,
                None,
                target_sheet,
            )
            if reference is None:
                return None
            selected.append(reference)
        if not selected:
            return None
        function_name = "average" if match.group("function").upper() == "AVERAGEIFS" else "sum"
        numeric = [reference for reference in selected if reference[2] is not None]
        included = numeric if function_name == "average" else selected
        if not included:
            return None
        values = [reference[1] for reference in included]
        calculated = sum(values) / len(values) if function_name == "average" else sum(values)
        if not _values_match(calculated, target_value):
            return None
        return FormulaTranslation(
            f"{function_name}({', '.join(reference[0] for reference in included)})",
            sorted({reference[2] for reference in included if reference[2] is not None}),
        )

    @staticmethod
    def _iferror_arguments(formula_body: str) -> tuple[str, str] | None:
        if not formula_body.upper().startswith("IFERROR(") or not formula_body.endswith(")"):
            return None
        inner = formula_body[len("IFERROR("):-1]
        depth = 0
        quoted = False
        for index, character in enumerate(inner):
            if character == '"':
                quoted = not quoted
            elif not quoted and character == "(":
                depth += 1
            elif not quoted and character == ")":
                depth -= 1
            elif not quoted and character == "," and depth == 0:
                return inner[:index].strip(), inner[index + 1:].strip()
        return None

    @classmethod
    def _iferror_primary_expression(cls, formula_body: str) -> str | None:
        arguments = cls._iferror_arguments(formula_body)
        return arguments[0] if arguments else None

    def _translate_guarded_iferror(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        """Translate numeric IFERROR by lazily guarding every possible divide-by-zero.

        This intentionally accepts only literal/reference arithmetic. The guarded
        target uses the restricted language's lazy conditional expression, so a
        future zero denominator selects the source fallback without evaluating the
        failing branch.
        """
        arguments = self._iferror_arguments(formula_body)
        if arguments is None or any('"' in argument for argument in arguments):
            return None
        primary_body, fallback_body = (
            PERCENT_LITERAL.sub(_percentage_value, argument)
            for argument in arguments
        )
        if (
            QUALIFIED_RANGE_REFERENCE.search(primary_body)
            or QUALIFIED_RANGE_REFERENCE.search(fallback_body)
            or FUNCTION_CALL.search(primary_body)
            or FUNCTION_CALL.search(fallback_body)
        ):
            return None

        coordinate_by_name: dict[str, tuple[str | None, str]] = {}
        name_by_coordinate: dict[tuple[str | None, str], str] = {}

        def replace_reference(match: re.Match[str]) -> str:
            coordinate = match.group("cell").replace("$", "").upper()
            source = (match.group("quoted") or match.group("plain"), coordinate)
            name = name_by_coordinate.get(source)
            if name is None:
                name = f"cell_{len(name_by_coordinate)}"
                name_by_coordinate[source] = name
                coordinate_by_name[name] = source
            return name

        try:
            primary_ast = ast.parse(
                QUALIFIED_CELL_REFERENCE.sub(replace_reference, primary_body),
                mode="eval",
            )
            fallback_ast = ast.parse(
                QUALIFIED_CELL_REFERENCE.sub(replace_reference, fallback_body),
                mode="eval",
            )
        except SyntaxError:
            return None

        dependencies: set[str] = set()

        # expression, replay value (None when the source branch errors), guards
        Compiled = tuple[str, float | int | None, list[str]]

        def compile_node(node: ast.AST) -> Compiled | None:
            if isinstance(node, ast.Expression):
                return compile_node(node.body)
            if isinstance(node, ast.Constant):
                value = _numeric(node.value)
                return (repr(value), value, []) if value is not None else None
            if isinstance(node, ast.Name):
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
                return reference[0], reference[1], []
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                operand = compile_node(node.operand)
                if operand is None:
                    return None
                expression, value, guards = operand
                return (
                    f"(-{expression})" if isinstance(node.op, ast.USub) else f"(+{expression})",
                    (-value if isinstance(node.op, ast.USub) else value)
                    if value is not None
                    else None,
                    guards,
                )
            if not isinstance(node, ast.BinOp) or not isinstance(
                node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)
            ):
                return None
            left = compile_node(node.left)
            right = compile_node(node.right)
            if left is None or right is None:
                return None
            left_expression, left_value, left_guards = left
            right_expression, right_value, right_guards = right
            operator = {
                ast.Add: "+",
                ast.Sub: "-",
                ast.Mult: "*",
                ast.Div: "/",
            }[type(node.op)]
            guards = [*left_guards, *right_guards]
            if isinstance(node.op, ast.Div) and not (
                isinstance(node.right, ast.Constant) and right_value not in {None, 0}
            ):
                guards.append(f"({right_expression} == 0)")
            if left_value is None or right_value is None:
                value = None
            else:
                try:
                    value = {
                        "+": lambda: left_value + right_value,
                        "-": lambda: left_value - right_value,
                        "*": lambda: left_value * right_value,
                        "/": lambda: left_value / right_value,
                    }[operator]()
                except ZeroDivisionError:
                    value = None
            return f"({left_expression} {operator} {right_expression})", value, guards

        primary = compile_node(primary_ast)
        fallback = compile_node(fallback_ast)
        if primary is None or fallback is None or fallback[1] is None or fallback[2]:
            return None
        calculated = primary[1] if primary[1] is not None else fallback[1]
        if calculated is None or not _values_match(calculated, target_value):
            return None
        expression = primary[0]
        for guard in reversed(primary[2]):
            expression = f"({guard} ? {fallback[0]} : {expression})"
        return FormulaTranslation(expression, sorted(dependencies))

    def _translate_text_error_iferror(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        """Use the explicit IFERROR fallback when a numeric branch reads text.

        This is deliberately period-specific. It accepts only arithmetic syntax
        and only when a referenced workbook cell currently contains nonnumeric
        text, which deterministically makes Excel select the source fallback.
        """
        arguments = self._iferror_arguments(formula_body)
        if arguments is None:
            return None
        primary_body, fallback_body = arguments
        fallback = self._translate_arithmetic(
            fallback_body,
            target_coordinate,
            target_period_id,
            target_value,
            target_sheet,
        )
        if fallback is None:
            return None

        replaced = QUALIFIED_CELL_REFERENCE.sub("1", primary_body)
        if FUNCTION_CALL.search(replaced) or QUALIFIED_RANGE_REFERENCE.search(replaced):
            return None
        try:
            parsed = ast.parse(PERCENT_LITERAL.sub(_percentage_value, replaced), mode="eval")
        except SyntaxError:
            return None
        if any(
            not isinstance(node, (
                ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
                ast.Add, ast.Sub, ast.Mult, ast.Div, ast.UAdd, ast.USub,
                ast.Load,
            ))
            for node in ast.walk(parsed)
        ):
            return None

        for match in QUALIFIED_CELL_REFERENCE.finditer(primary_body):
            key = self._key(
                match.group("cell"),
                match.group("quoted") or match.group("plain"),
                target_sheet,
            )
            raw_value = self.cells.get(key, {}).get("value") if key else None
            if isinstance(raw_value, str) and _numeric(raw_value) is None:
                return fallback
        return None

    def _translate_arithmetic(
        self,
        formula_body: str,
        target_coordinate: str,
        target_period_id: str,
        target_value: float | int,
        target_sheet: str | None,
    ) -> FormulaTranslation | None:
        unresolved_right_comparison = False
        folded_right_comparison = False

        def replace_right_comparison(match: re.Match[str]) -> str:
            nonlocal unresolved_right_comparison, folded_right_comparison
            key = self._key(
                match.group("cell"),
                match.group("quoted") or match.group("plain"),
                target_sheet,
            )
            cell = self.cells.get(key) if key else None
            if key not in self.literal_coordinates or cell is None or cell.get("value") is None:
                unresolved_right_comparison = True
                return match.group(0)
            value = cell["value"]
            if isinstance(value, float) and value.is_integer():
                text = str(int(value))
            else:
                text = str(value)
            count = int(match.group("count"))
            equal = text[-count:] == match.group("expected")
            result = equal if match.group("operator") == "=" else not equal
            folded_right_comparison = True
            return "TRUE" if result else "FALSE"

        formula_body = RIGHT_TEXT_COMPARISON.sub(replace_right_comparison, formula_body)
        if unresolved_right_comparison or '"' in formula_body:
            return None
        formula_body = PERCENT_LITERAL.sub(_percentage_value, formula_body)
        formula_body = EXCEL_BOOLEAN.sub(_boolean_value, formula_body)
        compiled_names: dict[str, tuple[str, float | int, list[str]]] = {}
        resolved_ranges: dict[str, _ResolvedRange] = {}
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
        if unsupported_aggregate:
            return None

        unsupported_range = False

        def replace_range(match: re.Match[str]) -> str:
            nonlocal unsupported_range
            start_sheet = self._sheet_from_match(match, "start")
            end_sheet = self._sheet_from_match(match, "end") or start_sheet
            resolved_sheet = start_sheet or target_sheet or self.default_sheet
            if end_sheet is not None and end_sheet != resolved_sheet:
                unsupported_range = True
                return match.group(0)
            coordinates = _expand_range(match.group("start"), match.group("end"))
            if not coordinates:
                unsupported_range = True
                return match.group(0)
            references = [
                self._canonical_cell_reference(
                    coordinate,
                    target_coordinate,
                    target_period_id,
                    resolved_sheet,
                    target_sheet,
                )
                for coordinate in coordinates
            ]
            if any(reference is None for reference in references):
                unsupported_range = True
                return match.group(0)
            name = f"cell_range_{len(resolved_ranges)}"
            resolved_ranges[name] = _ResolvedRange(tuple(
                reference for reference in references if reference is not None
            ))
            return name

        formula_body = QUALIFIED_RANGE_REFERENCE.sub(replace_range, formula_body)
        if unsupported_range or ":" in formula_body:
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
        # Excel treats an omitted argument (``SUM(A1,,B1)``) as zero.
        python_expression = EMPTY_ARGUMENT.sub(r",0\1", python_expression)
        python_expression = python_expression.replace("<>", "!=")
        python_expression = EXCEL_EQUALITY.sub("==", python_expression)
        try:
            parsed = ast.parse(python_expression, mode="eval")
        except SyntaxError:
            return None

        dependencies: set[str] = set()

        def compile_node(node: ast.AST) -> tuple[str, float | int | bool] | None:
            if isinstance(node, ast.Expression):
                return compile_node(node.body)
            if isinstance(node, ast.Constant):
                if isinstance(node.value, bool):
                    return ("true" if node.value else "false", node.value)
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
                if operand is None or isinstance(operand[1], bool):
                    return None
                return (
                    (f"(-{operand[0]})", -operand[1])
                    if isinstance(node.op, ast.USub)
                    else (f"(+{operand[0]})", operand[1])
                )
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
                normalized_name = node.func.id.upper()
                if normalized_name == "SUMPRODUCT" and len(node.args) >= 2:
                    ranges = [
                        resolved_ranges.get(argument.id)
                        if isinstance(argument, ast.Name)
                        else None
                        for argument in node.args
                    ]
                    if any(item is None for item in ranges):
                        return None
                    resolved = [item for item in ranges if item is not None]
                    lengths = {len(item.references) for item in resolved}
                    if len(lengths) != 1 or not lengths or 0 in lengths:
                        return None
                    terms: list[str] = []
                    products: list[float | int] = []
                    for references in zip(
                        *(item.references for item in resolved),
                        strict=True,
                    ):
                        terms.append(
                            "(" + " * ".join(reference[0] for reference in references) + ")"
                        )
                        products.append(math.prod(reference[1] for reference in references))
                        dependencies.update(
                            reference[2]
                            for reference in references
                            if reference[2] is not None
                        )
                    return f"sum({', '.join(terms)})", sum(products)
                if normalized_name == "MOD" and len(node.args) == 2:
                    left = compile_node(node.args[0])
                    right = compile_node(node.args[1])
                    if (
                        left is None
                        or right is None
                        or isinstance(left[1], bool)
                        or isinstance(right[1], bool)
                    ):
                        return None
                    try:
                        calculated = _excel_mod(left[1], right[1])
                    except ZeroDivisionError:
                        return None
                    return f"mod({left[0]}, {right[0]})", calculated
                if normalized_name == "IF" and len(node.args) == 3:
                    dependencies_before_condition = set(dependencies)
                    condition = compile_node(node.args[0])
                    if condition is None:
                        return None
                    condition_expression, condition_value = condition
                    if isinstance(condition_value, bool):
                        truthy = condition_value
                    else:
                        condition_expression = f"({condition_expression} != 0)"
                        truthy = condition_value != 0
                    if folded_right_comparison and dependencies == dependencies_before_condition:
                        selected = compile_node(node.args[1] if truthy else node.args[2])
                        return selected
                    consequent = compile_node(node.args[1])
                    alternate = compile_node(node.args[2])
                    if consequent is None or alternate is None:
                        return None
                    return (
                        f"when({condition_expression}, {consequent[0]}, {alternate[0]})",
                        consequent[1] if truthy else alternate[1],
                    )
                if normalized_name not in {"SUM", "AVERAGE"} or not node.args:
                    return None
                function_name = normalized_name.lower()
                compiled_arguments: list[tuple[str, float | int]] = []
                for argument_node in node.args:
                    resolved_range = (
                        resolved_ranges.get(argument_node.id)
                        if isinstance(argument_node, ast.Name)
                        else None
                    )
                    if resolved_range is not None:
                        references = resolved_range.references
                        if function_name == "average":
                            references = tuple(
                                reference
                                for reference in references
                                if reference[2] is not None
                            )
                        dependencies.update(
                            reference[2]
                            for reference in references
                            if reference[2] is not None
                        )
                        compiled_arguments.extend(
                            (reference[0], reference[1]) for reference in references
                        )
                        continue
                    argument = compile_node(argument_node)
                    if argument is None or isinstance(argument[1], bool):
                        return None
                    if (
                        function_name == "average"
                        and isinstance(argument_node, ast.Name)
                        and argument_node.id in coordinate_by_name
                    ):
                        reference_sheet, coordinate = coordinate_by_name[argument_node.id]
                        reference = self._canonical_cell_reference(
                            coordinate,
                            target_coordinate,
                            target_period_id,
                            reference_sheet,
                            target_sheet,
                        )
                        if reference is not None and reference[2] is None:
                            continue
                    compiled_arguments.append((argument[0], argument[1]))
                if not compiled_arguments:
                    return None
                values = [argument[1] for argument in compiled_arguments]
                calculated = (
                    sum(values) / len(values)
                    if function_name == "average"
                    else sum(values)
                )
                return (
                    f"{function_name}({', '.join(argument[0] for argument in compiled_arguments)})",
                    calculated,
                )
            if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
                left = compile_node(node.left)
                right = compile_node(node.comparators[0])
                if left is None or right is None:
                    return None
                operator = {
                    ast.Eq: "==",
                    ast.NotEq: "!=",
                    ast.Gt: ">",
                    ast.GtE: ">=",
                    ast.Lt: "<",
                    ast.LtE: "<=",
                }.get(type(node.ops[0]))
                if operator is None:
                    return None
                if operator in {">", ">=", "<", "<="} and (
                    isinstance(left[1], bool) or isinstance(right[1], bool)
                ):
                    return None
                calculated = {
                    "==": left[1] == right[1],
                    "!=": left[1] != right[1],
                    ">": left[1] > right[1],
                    ">=": left[1] >= right[1],
                    "<": left[1] < right[1],
                    "<=": left[1] <= right[1],
                }[operator]
                return f"({left[0]} {operator} {right[0]})", calculated
            if isinstance(node, ast.BinOp) and isinstance(
                node.op,
                (ast.Add, ast.Sub, ast.Mult, ast.Div),
            ):
                left = compile_node(node.left)
                right = compile_node(node.right)
                if (
                    left is None
                    or right is None
                    or isinstance(left[1], bool)
                    or isinstance(right[1], bool)
                ):
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
        if (
            compiled is None
            or isinstance(compiled[1], bool)
            or not _values_match(compiled[1], target_value)
        ):
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
        formula_body, indirect_failure = self._resolve_static_indirect(
            original_formula[1:].strip(), target_coordinate, target_sheet
        )
        if indirect_failure:
            return None
        iferror_primary = self._iferror_primary_expression(formula_body)
        return self._translate_guarded_iferror(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        ) or self._translate_text_error_iferror(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        ) or self._translate_conditional_aggregate(
            formula_body,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        ) or self._translate_aggregate_range(
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
        ) or (self._translate_arithmetic(
            iferror_primary,
            target_coordinate,
            target_period_id,
            cached,
            target_sheet,
        ) if iferror_primary else None)

    def blocker_details(
        self,
        original_formula: str,
        target_sheet: str | None = None,
        target_coordinate: str | None = None,
    ) -> FormulaBlocker:
        formula_body = original_formula[1:].strip() if original_formula.startswith("=") else original_formula
        if target_coordinate is not None:
            formula_body, indirect_failure = self._resolve_static_indirect(
                formula_body, target_coordinate, target_sheet
            )
            if indirect_failure:
                return FormulaBlocker("syntax_or_replay", indirect_failure)
        unsupported_functions = sorted({
            match.group("name").upper()
            for match in FUNCTION_CALL.finditer(formula_body)
            if match.group("name").upper() not in {
                "SUM", "AVERAGE", "SUMIFS", "AVERAGEIFS", "SUMPRODUCT", "IFERROR", "IF", "MOD"
            }
        })
        if unsupported_functions:
            return FormulaBlocker(
                "syntax_or_replay",
                "unsupported Excel function(s): " + ", ".join(unsupported_functions),
            )
        referenced_coordinates: set[str] = set()
        without_ranges = formula_body
        for match in QUALIFIED_RANGE_REFERENCE.finditer(formula_body):
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
        without_ranges = QUALIFIED_RANGE_REFERENCE.sub("", without_ranges)
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
            and coordinate not in self.literal_coordinates
            and not self._is_material_blank(coordinate)
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
