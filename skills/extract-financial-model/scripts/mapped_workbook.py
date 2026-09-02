"""Deterministic extraction from an explicit semantic workbook map."""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import hashlib
import json

from formula_translation import FormulaTranslation, FormulaTranslator, expand_cell_range
from ooxml import WorkbookPackage


MAP_FORMAT = "financial-model-workbook-map@0.4"
STYLE_CONVENTION = "alice-blue-yellow@0.1"
CANONICAL_METRIC_FIELDS = frozenset({
    "id",
    "name",
    "description",
    "dataType",
    "unit",
    "aggregation",
    "tags",
})
MAPPED_METRIC_FIELDS = CANONICAL_METRIC_FIELDS | {
    "row",
    "cells",
    "sheet",
    "labelCell",
    "canonicalExpression",
    "canonicalExpressions",
    "dependencyMetricIds",
    "opaqueDependencyMetricIds",
    "confidence",
}
BLUE_FONT_SOURCE_COLORS = (
    {"type": "theme", "theme": 4},
    {"type": "theme", "theme": 4, "tint": -0.499984740745262},
    {"type": "theme", "theme": 8},
    {"type": "rgb", "rgb": "FF0070C0"},
)
YELLOW_FILL_SOURCE_COLOR = {"type": "rgb", "rgb": "FFFFFF00"}
STYLE_SEMANTICS = {
    "alice_hardcode": {
        "id": "alice_hardcode",
        "role": "alice_hardcode",
        "description": "Blue font on pure yellow fill marks an Alice-controlled hardcode or assumption input.",
        "valueType": "assumption",
        "adjustable": True,
    },
    "reported_source": {
        "id": "reported_source",
        "role": "reported_source",
        "description": (
            "Blue-font literals without pure yellow fill are sourced from reported financial results "
            "and are not adjustable by Alice."
        ),
        "valueType": "reported",
        "adjustable": False,
    },
}
MAP_COVERAGE_BLOCKERS = frozenset({
    "unmapped_cells",
    "unmapped_metric",
    "unmapped_sheet",
})


def _formula_task_acceptance(blocker_kind: str) -> list[str]:
    coverage_step = (
        "Expand the private semantic map for defensible referenced cells; "
        "do not ask an analyst to fix map coverage."
        if blocker_kind in MAP_COVERAGE_BLOCKERS
        else "Prefer a reusable deterministic translator extension over a one-cell exception."
    )
    return [
        "Use only approved restricted-expression syntax; never emit executable TypeScript or JavaScript.",
        "Preserve the original Excel formula and source-cell provenance.",
        "Rerun extraction and accept the translation only when cached-value replay matches.",
        coverage_step,
        "Keep the linked action_required item open while the transformation remains opaque.",
    ]


def _opaque_next_action(blocker_kinds: set[str]) -> str:
    if blocker_kinds and blocker_kinds <= MAP_COVERAGE_BLOCKERS:
        return (
            "No analyst decision is required for this map-coverage item. Engineering follow-up: "
            "extend the private semantic map for the named worksheet cells, then rerun extraction "
            "and cached-value replay."
        )
    if blocker_kinds.isdisjoint(MAP_COVERAGE_BLOCKERS):
        return (
            "No analyst decision is required for this translator-coverage item. Engineering follow-up: "
            "extend the restricted translator for the named function or syntax/replay case, then rerun "
            "cached-value replay."
        )
    return (
        "No analyst decision is required. Engineering follow-up: inspect each formula task, extend the "
        "private semantic map for unmapped cells, extend the restricted translator only for remaining "
        "syntax/replay gaps, then rerun cached-value replay."
    )


def _without_prefix(value: str, prefix: str) -> str:
    return value[len(prefix):] if value.startswith(prefix) else value


def _observation_id(metric_id: str, period_id: str) -> str:
    return "observation_{}_{}".format(
        _without_prefix(metric_id, "metric_"),
        _without_prefix(period_id, "period_"),
    )


def _transformation_id(metric_id: str, period_id: str) -> str:
    return "transformation_{}_{}".format(
        _without_prefix(metric_id, "metric_"),
        _without_prefix(period_id, "period_"),
    )


def _locator(sheet: str, *, cell: str | None = None, range_: str | None = None) -> dict[str, str]:
    result = {"sheet": sheet}
    if cell:
        result["cell"] = cell
    if range_:
        result["range"] = range_
    return result


def _format_locator(locator: dict[str, Any] | None) -> str:
    if not locator:
        return "workbook-level"
    sheet = locator.get("sheet")
    coordinate = locator.get("cell") or locator.get("range")
    if sheet and coordinate:
        return f"{sheet}!{coordinate}"
    if sheet:
        return f"worksheet {sheet}"
    if locator.get("page"):
        return f"page {locator['page']}"
    if locator.get("timecode"):
        return f"timecode {locator['timecode']}"
    return "source-level"


def _cell_key(sheet: str, coordinate: str) -> str:
    return f"{sheet}!{coordinate.replace('$', '').upper()}"


def _locator_from_key(key: str) -> dict[str, str]:
    sheet, coordinate = key.rsplit("!", 1)
    return _locator(sheet, cell=coordinate)


def _mapped_locator(
    value: str | dict[str, Any],
    default_sheet: str,
    *,
    kind: str,
) -> dict[str, Any]:
    if isinstance(value, str):
        return _locator(default_sheet, **({"cell": value} if kind == "cell" else {"range_": value}))
    locator = deepcopy(value)
    locator.setdefault("sheet", default_sheet)
    if kind not in locator:
        raise ValueError(f"Mapped locator must include {kind}: {value!r}")
    return locator


def _metric_value_is_valid(value: Any, data_type: str) -> bool:
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    if value is None:
        return True
    if data_type in {"number", "percentage", "currency"}:
        return numeric
    if data_type == "count":
        return isinstance(value, int) and not isinstance(value, bool)
    if data_type == "boolean":
        return isinstance(value, bool)
    return isinstance(value, str)


def _source_color(color: dict[str, Any] | None) -> dict[str, Any]:
    if not color:
        return {}
    return {
        key: color[key]
        for key in ("type", "theme", "rgb", "tint")
        if key in color
    }


def _is_specific_blue_font(color: dict[str, Any] | None) -> bool:
    return _source_color(color) in BLUE_FONT_SOURCE_COLORS


def _is_specific_yellow_fill(style: dict[str, Any]) -> bool:
    fill = style.get("fill", {})
    return (
        fill.get("patternType") == "solid"
        and _source_color(fill.get("foregroundColor")) == YELLOW_FILL_SOURCE_COLOR
    )


@dataclass
class ExtractionResult:
    database: dict[str, Any]
    report: str
    inventory: dict[str, Any]
    style_evidence: dict[str, Any]
    formula_translation_tasks: dict[str, Any]


class MappedWorkbookExtractor:
    """Extract only concepts explicitly declared in a semantic mapping file."""

    def __init__(self, workbook: Path, mapping: dict[str, Any]):
        if mapping.get("format") != MAP_FORMAT:
            raise ValueError(f"Mapping must declare {MAP_FORMAT}")
        self.workbook = workbook.resolve()
        self.mapping = mapping
        self.sheet_name = mapping["sheet"]
        self.map_format = mapping["format"]
        self.database: dict[str, Any] = {
            "dataset": {},
            "models": [],
            "entities": [],
            "metrics": [],
            "periods": [],
            "scenarios": [],
            "observations": [],
            "transformations": [],
            "relationships": [],
            "sourceArtifacts": [],
            "provenanceRecords": [],
            "evidence": [],
            "assumptions": [],
            "decisions": [],
            "decisionChanges": [],
            "extractionRuns": [],
            "unresolvedItems": [],
            "tablePresentations": [],
        }
        self._provenance_targets: set[str] = set()
        self._resolved_styles: dict[int, dict[str, Any]] = {}
        self._evidence_styles: dict[int, dict[str, Any]] = {}
        self._style_records: list[dict[str, Any]] = []
        self._formula_translator: FormulaTranslator | None = None
        self._assignments_by_metric: dict[str, list[dict[str, Any]]] = {}
        self._auto_translated_count = 0
        if "styleSemantics" in mapping:
            raise ValueError(
                f"Configurable styleSemantics rules are not supported; use styleConvention={STYLE_CONVENTION!r}"
            )
        self.style_convention = mapping.get("styleConvention")
        if self.style_convention not in {None, STYLE_CONVENTION}:
            raise ValueError(f"Unsupported styleConvention: {self.style_convention!r}")
        self._validate_hierarchy_mapping()

    def _validate_hierarchy_mapping(self) -> None:
        if self.mapping.get("hierarchyReviewed") is not True:
            raise ValueError("Mapping must declare hierarchyReviewed: true")
        component_parent_ids = self.mapping.get("componentParentIds")
        if not isinstance(component_parent_ids, dict):
            raise ValueError("Mapping must declare componentParentIds as an object, even when empty")

        metric_ids: set[str] = set()
        for section in self.mapping["sections"]:
            parent_ids = section.get("metricParentIds")
            if not isinstance(parent_ids, dict):
                raise ValueError(
                    f"Mapped section {section.get('id', '<unknown>')} must declare "
                    "metricParentIds as an object, even when empty"
                )
            ordered_ids: list[str] = []
            for metric in section["metrics"]:
                metric_id = metric["id"]
                if metric_id in metric_ids:
                    raise ValueError(f"Duplicate mapped metric ID: {metric_id}")
                if "presentationParentMetricId" in metric or "componentOfMetricId" in metric:
                    raise ValueError(
                        f"Mapped metric {metric_id} uses removed per-metric parent fields; "
                        "use section.metricParentIds and top-level componentParentIds"
                    )
                unknown_fields = sorted(set(metric) - MAPPED_METRIC_FIELDS)
                if unknown_fields:
                    raise ValueError(
                        f"Mapped metric {metric_id} has unsupported fields: {', '.join(unknown_fields)}"
                    )
                metric_ids.add(metric_id)
                ordered_ids.append(metric_id)
            positions = {metric_id: index for index, metric_id in enumerate(ordered_ids)}
            for child_id, parent_id in parent_ids.items():
                if not isinstance(child_id, str) or not isinstance(parent_id, str):
                    raise ValueError(
                        f"Mapped section {section['id']} metricParentIds must map metric IDs to metric IDs"
                    )
                if child_id not in positions:
                    raise ValueError(
                        f"Mapped section {section['id']} presentation child {child_id} is not in the section"
                    )
                if parent_id not in positions:
                    raise ValueError(
                        f"Mapped section {section['id']} presentation parent {parent_id} is not in the section"
                    )
                if positions[parent_id] >= positions[child_id]:
                    raise ValueError(
                        f"Mapped section {section['id']} presentation parent {parent_id} must appear "
                        f"before child {child_id}"
                    )

        for child_id, parent_id in component_parent_ids.items():
            if not isinstance(child_id, str) or not isinstance(parent_id, str):
                raise ValueError("componentParentIds must map metric IDs to metric IDs")
            if child_id not in metric_ids:
                raise ValueError(f"Component child {child_id} is not a mapped metric")
            if parent_id not in metric_ids:
                raise ValueError(f"Component parent {parent_id} is not a mapped metric")
            if child_id == parent_id:
                raise ValueError(f"Mapped metric {child_id} cannot be a component of itself")

        complete: set[str] = set()
        for start_id in component_parent_ids:
            if start_id in complete:
                continue
            path: list[str] = []
            positions: dict[str, int] = {}
            current_id: str | None = start_id
            while current_id is not None and current_id not in complete:
                if current_id in positions:
                    cycle = [*path[positions[current_id]:], current_id]
                    raise ValueError(f"Mapped component cycle: {' -> '.join(cycle)}")
                positions[current_id] = len(path)
                path.append(current_id)
                current_id = component_parent_ids.get(current_id)
            complete.update(path)

    def _provenance(self, target_id: str, locator: dict[str, str], confidence: float) -> None:
        if target_id in self._provenance_targets:
            return
        self._provenance_targets.add(target_id)
        self.database["provenanceRecords"].append({
            "id": f"provenance_{target_id}",
            "targetId": target_id,
            "sourceArtifactId": self.mapping["sourceArtifact"]["id"],
            "locator": locator,
            "extractionRunId": self.mapping["extractionRun"]["id"],
            "confidence": confidence,
            "reviewStatus": "unreviewed",
        })

    def _unresolved(self, item: dict[str, Any]) -> None:
        canonical = deepcopy(item)
        if "analystQuestion" in canonical:
            raise ValueError("analystQuestion is not part of the attention contract; use nextAction")
        for field in ("currentTreatment", "impact", "nextAction"):
            value = canonical.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"Attention item {canonical.get('id', '<unknown>')} must provide non-empty {field}"
                )
        canonical.setdefault("attentionLevel", "needs_review")
        if canonical["attentionLevel"] == "action_required" and canonical.get("actionOwner") not in {
            "extraction_agent", "model_owner", "source_owner"
        }:
            raise ValueError(
                f"Action item {canonical.get('id', '<unknown>')} must provide actionOwner as "
                "extraction_agent, model_owner, or source_owner"
            )
        self.database["unresolvedItems"].append(canonical)
        self._provenance(
            canonical["id"],
            canonical.get("locator") or _locator(self.sheet_name),
            canonical.get("confidence", 0.5),
        )

    def _build_assignments(
        self,
        periods_by_id: dict[str, dict[str, Any]],
    ) -> dict[str, list[dict[str, Any]]]:
        assignments_by_metric: dict[str, list[dict[str, Any]]] = {}
        seen_cells: dict[str, str] = {}
        seen_points: dict[tuple[str, str], str] = {}
        for section in self.mapping["sections"]:
            for metric in section["metrics"]:
                metric_id = metric["id"]
                assignments: list[dict[str, Any]] = []
                if "cells" in metric:
                    if "row" in metric:
                        raise ValueError(
                            f"Mapped metric {metric_id} must use either row or cells, not both"
                        )
                    for mapped_cell in metric["cells"]:
                        period_id = mapped_cell["periodId"]
                        mapped_period = periods_by_id.get(period_id)
                        if mapped_period is None:
                            raise ValueError(
                                f"Mapped metric {metric_id} cell references unknown period {period_id}"
                            )
                        assignments.append({
                            "sheet": mapped_cell.get("sheet", self.sheet_name),
                            "cell": mapped_cell["cell"].replace("$", "").upper(),
                            "periodId": period_id,
                            "period": mapped_period,
                            "confidence": mapped_cell.get("confidence"),
                        })
                elif "row" in metric:
                    for period_id, mapped_period in periods_by_id.items():
                        column = mapped_period.get("column")
                        if not column:
                            raise ValueError(
                                f"Mapped metric {metric_id} uses row layout, but period {period_id} has no column"
                            )
                        assignments.append({
                            "sheet": metric.get("sheet", self.sheet_name),
                            "cell": f"{column}{metric['row']}".upper(),
                            "periodId": period_id,
                            "period": mapped_period,
                            "confidence": None,
                        })
                else:
                    raise ValueError(
                        f"Mapped metric {metric_id} must declare a legacy row or explicit cells"
                    )

                for assignment in assignments:
                    key = _cell_key(assignment["sheet"], assignment["cell"])
                    previous_metric = seen_cells.get(key)
                    if previous_metric:
                        raise ValueError(
                            f"Source cell {key} is mapped to both {previous_metric} and {metric_id}"
                        )
                    point = (metric_id, assignment["periodId"])
                    previous_cell = seen_points.get(point)
                    if previous_cell:
                        raise ValueError(
                            f"Metric-period point {metric_id}/{assignment['periodId']} is mapped by both "
                            f"{previous_cell} and {key}"
                        )
                    seen_cells[key] = metric_id
                    seen_points[point] = key
                assignments_by_metric[metric_id] = assignments
        return assignments_by_metric

    def extract(self) -> ExtractionResult:
        periods_by_id = {
            mapped_period["id"]: mapped_period
            for mapped_period in self.mapping["periods"]
        }
        self._assignments_by_metric = self._build_assignments(periods_by_id)
        mapped_header_ranges = self.mapping.get("periodHeaderRanges")
        if mapped_header_ranges is None:
            mapped_header_ranges = [self.mapping["periodHeaderRange"]]
        if not isinstance(mapped_header_ranges, list) or not mapped_header_ranges:
            raise ValueError("periodHeaderRanges must contain at least one mapped range")
        period_header_locators = [
            _mapped_locator(value, self.sheet_name, kind="range")
            for value in mapped_header_ranges
        ]
        period_header_locator = period_header_locators[0]
        selected_sheets = {
            assignment["sheet"]
            for assignments in self._assignments_by_metric.values()
            for assignment in assignments
        }
        selected_sheets.update(locator["sheet"] for locator in period_header_locators)
        with WorkbookPackage(self.workbook) as package:
            inventory = package.inventory("none")
            available_sheets = {sheet["name"] for sheet in inventory["sheets"]}
            missing_sheets = sorted(selected_sheets - available_sheets)
            if missing_sheets:
                raise ValueError(
                    "Explicit cell mappings reference missing worksheets: "
                    + ", ".join(missing_sheets)
                )
            cells_by_sheet = {
                sheet: package.cells(sheet)
                for sheet in selected_sheets
            }
            cells = {
                _cell_key(sheet, coordinate): cell
                for sheet, sheet_cells in cells_by_sheet.items()
                for coordinate, cell in sheet_cells.items()
            }
            comments = {
                _cell_key(sheet, item["cell"]): {**item, "sheet": sheet}
                for sheet in selected_sheets
                for item in package.comments(sheet)
            }
            self._resolved_styles = {
                style_id: package.resolved_style(style_id)
                for style_id in {cell["style"] for cell in cells.values()}
            }

        source = deepcopy(self.mapping["sourceArtifact"])
        source["contentHash"] = f"sha256:{inventory['input']['sha256']}"
        source.setdefault("uri", str(self.workbook))
        run = deepcopy(self.mapping["extractionRun"])
        run["sourceArtifactIds"] = [source["id"]]
        run["modelVersionId"] = self.mapping["model"]["currentVersionId"]

        self.database["dataset"] = deepcopy(self.mapping["dataset"])
        self.database["models"] = [deepcopy(self.mapping["model"])]
        self.database["entities"] = [deepcopy(self.mapping["entity"])]
        self.database["scenarios"] = deepcopy(self.mapping.get("scenarios", []))
        self.database["sourceArtifacts"] = [source]
        self.database["extractionRuns"] = [run]

        model = self.database["models"][0]
        entity = self.database["entities"][0]
        model_locator = _mapped_locator(
            self.mapping["modelRange"], self.sheet_name, kind="range"
        )
        self._provenance(model["id"], model_locator, 0.98)
        self._provenance(entity["id"], model_locator, 0.98)
        for scenario in self.database["scenarios"]:
            self._provenance(
                scenario["id"],
                _mapped_locator(
                    mapped_header_ranges[0], self.sheet_name, kind="range"
                ),
                0.95,
            )

        for mapped_period in self.mapping["periods"]:
            period = {
                key: deepcopy(value)
                for key, value in mapped_period.items()
                if key not in {"column", "actuality", "headerCell"}
            }
            self.database["periods"].append(period)
            self._provenance(
                period["id"],
                _mapped_locator(
                    mapped_period["headerCell"], self.sheet_name, kind="cell"
                ),
                0.99,
            )

        metrics_by_id = {
            metric["id"]: metric
            for section in self.mapping["sections"]
            for metric in section["metrics"]
        }
        coordinate_semantics = {
            _cell_key(assignment["sheet"], assignment["cell"]): {
                "metricId": metric_id,
                "periodId": assignment["periodId"],
                "dataType": metrics_by_id[metric_id]["dataType"],
            }
            for metric_id, assignments in self._assignments_by_metric.items()
            for assignment in assignments
        }
        strict_grid = all(
            "cells" not in metric
            for metric in metrics_by_id.values()
        )
        literal_coordinates: set[str] = set()
        for header_locator in period_header_locators:
            header_range = header_locator["range"]
            if ":" in header_range:
                header_start, header_end = header_range.split(":", 1)
                header_coordinates = expand_cell_range(header_start, header_end)
            else:
                header_coordinates = [header_range.replace("$", "").upper()]
            if not header_coordinates:
                raise ValueError(
                    "periodHeaderRanges must contain valid, forward, bounded A1 ranges of at most 1,000 cells"
                )
            literal_coordinates.update(
                _cell_key(header_locator["sheet"], coordinate)
                for coordinate in header_coordinates
            )
        self._formula_translator = FormulaTranslator(
            cells,
            coordinate_semantics,
            default_sheet=self.sheet_name,
            strict_grid=strict_grid,
            literal_coordinates=literal_coordinates,
            available_sheets=set(selected_sheets),
        )

        comments_used: set[str] = set()
        opaque_cells: dict[
            str,
            list[tuple[str, str, tuple[str, ...]]],
        ] = defaultdict(list)
        period_mapping_gaps: list[tuple[str, tuple[str, ...]]] = []
        formula_translation_items: list[dict[str, Any]] = []
        sections = []
        for section in self.mapping["sections"]:
            section_metric_ids = []
            section_metric_parent_ids = deepcopy(section["metricParentIds"])
            for mapped_metric in section["metrics"]:
                metric = self._canonical_metric(mapped_metric)
                observations_before = len(self.database["observations"])
                for assignment in self._assignments_by_metric[metric["id"]]:
                    period_id = assignment["periodId"]
                    mapped_period = assignment["period"]
                    sheet = assignment["sheet"]
                    coordinate = assignment["cell"]
                    source_key = _cell_key(sheet, coordinate)
                    cell = cells.get(source_key)
                    if not cell or (cell.get("value") is None and "formula" not in cell):
                        self._missing_source_value(
                            metric["id"], period_id, sheet, coordinate, model["id"], source["id"]
                        )
                        continue
                    style_record = self._record_style(
                        cell,
                        sheet,
                        coordinate,
                        metric["id"],
                        period_id,
                        mapped_period["actuality"],
                    )
                    if cell.get("value") is None and "formula" in cell:
                        style_record["canonicalTargetEmitted"] = False
                        self._missing_cached_value(
                            metric["id"], period_id, sheet, coordinate, model["id"], source["id"]
                        )
                        continue
                    value = cell.get("value")
                    if not _metric_value_is_valid(value, metric["dataType"]):
                        style_record["canonicalTargetEmitted"] = False
                        self._incompatible_value(
                            metric["id"], period_id, sheet, coordinate, value, model["id"], source["id"],
                        )
                        continue
                    observation = self._observation(
                        metric,
                        period_id,
                        mapped_period,
                        model,
                        entity,
                    )
                    observation["value"] = value
                    if "formula" in cell:
                        if self._formula_translator is None:
                            raise RuntimeError("Formula translator is unavailable before workbook extraction")
                        automatic = self._formula_translator.translate(
                            cell["formula"],
                            coordinate,
                            period_id,
                            value,
                            sheet,
                        )
                        blocker = (
                            None
                            if automatic
                            else self._formula_translator.blocker_details(cell["formula"], sheet)
                        )
                        if blocker and blocker.kind == "unmapped_period":
                            period_mapping_gaps.append((source_key, blocker.coordinates))
                        transformation = self._transformation(
                            metric,
                            mapped_metric,
                            mapped_period,
                            period_id,
                            cell["formula"],
                            automatic,
                        )
                        self.database["transformations"].append(transformation)
                        observation["valueType"] = "derived"
                        observation["transformationId"] = transformation["id"]
                        self._provenance(
                            transformation["id"],
                            _locator(sheet, cell=coordinate),
                            0.94 if transformation["status"] == "supported" else 0.78,
                        )
                        if transformation["status"] == "opaque":
                            if blocker is None:
                                raise RuntimeError("Opaque formula is missing translation blocker details")
                            opaque_cells[metric["id"]].append((
                                source_key,
                                blocker.reason,
                                blocker.coordinates,
                            ))
                            formula_translation_items.append({
                                "id": f"formula_translation_task_{transformation['id']}",
                                "transformationId": transformation["id"],
                                "metricId": metric["id"],
                                "periodId": period_id,
                                "source": {"sheet": sheet, "cell": coordinate},
                                "originalFormula": cell["formula"],
                                "cachedValue": value,
                                "blocker": {
                                    "kind": blocker.kind,
                                    "reason": blocker.reason,
                                    "coordinates": list(blocker.coordinates),
                                },
                                "targetLanguage": "model-expression@0.1",
                                "acceptance": _formula_task_acceptance(blocker.kind),
                            })
                    elif style_record.get("semantic", {}).get("valueType"):
                        observation["valueType"] = style_record["semantic"]["valueType"]
                    self.database["observations"].append(observation)
                    style_record["canonicalTargetEmitted"] = True
                    style_record["observationId"] = observation["id"]
                    if observation.get("transformationId"):
                        style_record["transformationId"] = observation["transformationId"]
                        if style_record.get("semantic", {}).get("valueType"):
                            style_record["formulaPrecedence"] = (
                                "The source formula keeps canonical valueType=derived; style semantics remain evidence."
                            )
                    self._provenance(
                        observation["id"],
                        _locator(sheet, cell=coordinate),
                        assignment["confidence"]
                        if assignment["confidence"] is not None
                        else (0.98 if mapped_period["actuality"] == "actual" else 0.86),
                    )
                    if source_key in comments:
                        self._add_comment_evidence(
                            comments[source_key], observation["id"], metric["id"], period_id
                        )
                        comments_used.add(source_key)

                if len(self.database["observations"]) == observations_before:
                    raise ValueError(f"Mapped metric {metric['id']} has no observations in the selected periods")
                self.database["metrics"].append(metric)
                section_metric_ids.append(metric["id"])
                self._provenance(
                    metric["id"],
                    _mapped_locator(
                        mapped_metric["labelCell"],
                        mapped_metric.get("sheet", self.sheet_name),
                        kind="cell",
                    ),
                    mapped_metric.get("confidence", 0.95),
                )
            section_locator = _mapped_locator(
                section["sourceLocator"]
                if "sourceLocator" in section
                else section["sourceRange"],
                self.sheet_name,
                kind="range",
            )
            canonical_section = {
                "id": section["id"],
                "title": section["title"],
                "metricIds": section_metric_ids,
                "metricParentIds": section_metric_parent_ids,
                "sourceLocator": section_locator,
            }
            sections.append(canonical_section)

        for metric_id, parent_metric_id in self.mapping["componentParentIds"].items():
            mapped_metric = metrics_by_id[metric_id]
            relationship_id = (
                f"relationship_{_without_prefix(metric_id, 'metric_')}_component_of_"
                f"{_without_prefix(parent_metric_id, 'metric_')}"
            )
            self.database["relationships"].append({
                "id": relationship_id,
                "fromId": metric_id,
                "type": "component_of",
                "toId": parent_metric_id,
            })
            self._provenance(
                relationship_id,
                _mapped_locator(
                    mapped_metric["labelCell"],
                    mapped_metric.get("sheet", self.sheet_name),
                    kind="cell",
                ),
                mapped_metric.get("confidence", 0.95),
            )
        mapped_presentations = self.mapping.get("presentations")
        if mapped_presentations:
            sections_by_id = {section["id"]: section for section in sections}
            assigned_section_ids: set[str] = set()
            presentations = []
            for mapped_presentation in mapped_presentations:
                section_ids = mapped_presentation.get("sectionIds")
                if not isinstance(section_ids, list) or not section_ids:
                    raise ValueError("Each mapped presentation must contain a non-empty sectionIds array")
                unknown = sorted(set(section_ids) - sections_by_id.keys())
                if unknown:
                    raise ValueError(
                        "Mapped presentation references unknown sections: " + ", ".join(unknown)
                    )
                duplicates = sorted(set(section_ids) & assigned_section_ids)
                if duplicates:
                    raise ValueError(
                        "Mapped sections may appear in only one generated presentation: "
                        + ", ".join(duplicates)
                    )
                assigned_section_ids.update(section_ids)
                presentation = {
                    "id": mapped_presentation["id"],
                    "title": mapped_presentation["title"],
                    "modelId": model["id"],
                    "sourceArtifactId": source["id"],
                    "sections": [sections_by_id[section_id] for section_id in section_ids],
                }
                if mapped_presentation.get("sourceLocator"):
                    presentation["sourceLocator"] = _mapped_locator(
                        mapped_presentation["sourceLocator"], self.sheet_name, kind="range"
                    )
                presentations.append(presentation)
            unassigned = sorted(sections_by_id.keys() - assigned_section_ids)
            if unassigned:
                raise ValueError(
                    "Mapped presentations do not cover sections: " + ", ".join(unassigned)
                )
            self.database["tablePresentations"] = presentations
        else:
            self.database["tablePresentations"] = [{
                "modelId": model["id"],
                "sourceArtifactId": source["id"],
                "sections": sections,
            }]

        if period_mapping_gaps:
            examples = "; ".join(
                f"{target} references {', '.join(inputs[:8])}"
                for target, inputs in period_mapping_gaps[:8]
            )
            raise ValueError(
                "Explicit period mapping is incomplete for selected formulas. "
                f"{examples}. Add the source periods to the private workbook map and rerun extraction; "
                "do not leave a supported same-row formula opaque or ask an analyst to resolve it."
            )

        for metric_id, blocked_formulas in opaque_cells.items():
            suffix = _without_prefix(metric_id, "metric_")
            coordinates = [coordinate for coordinate, _reason, _inputs in blocked_formulas]
            blocker_counts = Counter(
                reason for _coordinate, reason, _inputs in blocked_formulas
            )
            blocked_inputs = sorted({
                input_coordinate
                for _coordinate, _reason, inputs in blocked_formulas
                for input_coordinate in inputs
            })
            blockers = "; ".join(
                f"{count} formula{'s' if count != 1 else ''}: {reason}"
                for reason, count in sorted(blocker_counts.items())
            )
            blocker_kinds = {
                item["blocker"]["kind"]
                for item in formula_translation_items
                if item["metricId"] == metric_id
            }
            self._unresolved({
                "id": f"unresolved_opaque_formula_{suffix}",
                "modelId": model["id"],
                "category": "formula",
                "description": (
                    f"At {len(coordinates)} explicitly mapped workbook cells, materialized formulas "
                    "are preserved as opaque because "
                    f"they were not safely translated to model-expression@0.1. Translation blockers: {blockers}."
                    + (
                        f" Explicit cells to map or classify include: {', '.join(blocked_inputs[:12])}."
                        if blocked_inputs
                        else ""
                    )
                ),
                "currentTreatment": (
                    "The workbook cached values remain available for preview, but the database does not "
                    "claim canonical calculation lineage for these cells."
                ),
                "impact": (
                    f"{len(coordinates)} formula cell{'s' if len(coordinates) != 1 else ''} for "
                    f"`{metric_id}` cannot participate in trusted lineage or recalculation."
                ),
                "targetId": metric_id,
                "sourceArtifactId": source["id"],
                "locator": _locator_from_key(coordinates[0]),
                "confidence": 0.72,
                "attentionLevel": "action_required",
                "actionOwner": "extraction_agent",
                "status": "open",
                "nextAction": _opaque_next_action(blocker_kinds),
            })
        unmapped_comments = sorted(set(comments) - comments_used)
        for item in self.mapping.get("unresolvedItems", []):
            self._unresolved(deepcopy(item))

        if any(item["status"] == "open" for item in self.database["unresolvedItems"]):
            if run["status"] == "completed":
                run["status"] = "completed_with_issues"

        style_evidence = self._style_evidence(inventory)
        formula_translation_tasks = {
            "format": "financial-model-formula-translation-tasks@0.1",
            "sourceArtifactId": source["id"],
            "extractionRunId": run["id"],
            "targetLanguage": "model-expression@0.1",
            "instructions": (
                "The extraction agent must resolve map-coverage and reusable translator-coverage "
                "items, rerun extraction, "
                "and require cached-value replay before treating this bundle as complete. "
                "Do not execute source formulas or emit arbitrary TypeScript/JavaScript."
            ),
            "items": formula_translation_items,
        }
        self._finalize_database(formula_translation_items)
        return ExtractionResult(
            self.database,
            self._report(
                inventory,
                opaque_cells,
                comments_used,
                unmapped_comments,
                style_evidence,
            ),
            inventory,
            style_evidence,
            formula_translation_tasks,
        )

    def _finalize_database(self, formula_translation_items: list[dict[str, Any]]) -> None:
        """Collapse cell-level builder records into the canonical model-db@0.3 contract."""
        old_transformations = self.database["transformations"]
        grouped_transformations: dict[tuple[str, str, str | None], dict[str, Any]] = {}
        old_to_new: dict[str, str] = {}
        for transformation in old_transformations:
            expression = transformation["expression"] if transformation["status"] == "supported" else None
            key = (transformation["outputMetricId"], transformation["status"], expression)
            canonical = grouped_transformations.get(key)
            if canonical is None:
                digest = hashlib.sha256(
                    "\0".join(value or "" for value in key).encode("utf-8")
                ).hexdigest()[:8]
                canonical = {
                    "id": f"transformation_{_without_prefix(key[0], 'metric_')}_{digest}",
                    "outputMetricId": key[0],
                    "sourceExpressions": {},
                    "status": key[1],
                }
                if expression is not None:
                    canonical["expression"] = expression
                grouped_transformations[key] = canonical
            period_ids = transformation.get("appliesWhen", {}).get("periodIds", [])
            if len(period_ids) != 1:
                raise ValueError(
                    f"Builder transformation {transformation['id']} must apply to exactly one period"
                )
            period_id = period_ids[0]
            existing = canonical["sourceExpressions"].get(period_id)
            source_expression = transformation["originalExpression"]
            if existing is not None and existing != source_expression:
                raise ValueError(
                    f"Conflicting source formulas for {key[0]} in {period_id}: "
                    f"{existing!r} versus {source_expression!r}"
                )
            canonical["sourceExpressions"][period_id] = source_expression
            old_to_new[transformation["id"]] = canonical["id"]

        for observation in self.database["observations"]:
            if "transformationId" in observation:
                observation["transformationId"] = old_to_new[observation["transformationId"]]
        for task in formula_translation_items:
            task["transformationId"] = old_to_new[task["transformationId"]]
            task["id"] = f"formula_translation_task_{task['transformationId']}_{task['periodId']}"
        for unresolved in self.database["unresolvedItems"]:
            if unresolved.get("targetId") in old_to_new:
                unresolved["targetId"] = old_to_new[unresolved["targetId"]]
            if "affectedTargetIds" in unresolved:
                unresolved["affectedTargetIds"] = [
                    old_to_new.get(target_id, target_id)
                    for target_id in unresolved["affectedTargetIds"]
                ]

        series_by_key: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
        for observation in self.database.pop("observations"):
            key = tuple(observation[field] for field in (
                "modelId", "metricId", "entityId", "asOf", "versionId"
            ))
            series = series_by_key.setdefault(key, {
                "modelId": key[0],
                "metricId": key[1],
                "entityId": key[2],
                "asOf": key[3],
                "versionId": key[4],
                "points": [],
            })
            point = {
                field: value
                for field, value in observation.items()
                if field not in {"modelId", "metricId", "entityId", "asOf", "versionId", "unit"}
            }
            series["points"].append(point)

        raw_provenance = self.database["provenanceRecords"]
        contexts: list[dict[str, Any]] = []
        context_by_key: dict[tuple[str, str, float, str], str] = {}
        provenance_records: list[dict[str, Any]] = []
        provenance_keys: set[str] = set()
        for record in raw_provenance:
            target_id = old_to_new.get(record["targetId"], record["targetId"])
            context_key = (
                record["sourceArtifactId"],
                record["extractionRunId"],
                record["confidence"],
                record["reviewStatus"],
            )
            context_id = context_by_key.get(context_key)
            if context_id is None:
                context_id = f"provenance_context_{len(contexts) + 1}"
                context_by_key[context_key] = context_id
                contexts.append({
                    "id": context_id,
                    "sourceArtifactId": context_key[0],
                    "extractionRunId": context_key[1],
                    "confidence": context_key[2],
                    "reviewStatus": context_key[3],
                })
            canonical = {
                "targetId": target_id,
                "contextId": context_id,
                **({"locator": record["locator"]} if record.get("locator") else {}),
            }
            key = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
            if key not in provenance_keys:
                provenance_keys.add(key)
                provenance_records.append(canonical)

        self.database["schemaVersion"] = "0.3.0"
        self.database["observationSeries"] = list(series_by_key.values())
        self.database["transformations"] = list(grouped_transformations.values())
        self.database["provenanceContexts"] = contexts
        self.database["provenanceRecords"] = provenance_records

    def _matching_style_semantic(
        self,
        style: dict[str, Any],
        cell_kind: str,
    ) -> dict[str, Any] | None:
        if self.style_convention != STYLE_CONVENTION:
            return None
        if not _is_specific_blue_font(style.get("font", {}).get("color")):
            return None
        if _is_specific_yellow_fill(style):
            return STYLE_SEMANTICS["alice_hardcode"]
        if cell_kind == "literal":
            return STYLE_SEMANTICS["reported_source"]
        return None

    def _record_style(
        self,
        cell: dict[str, Any],
        sheet: str,
        coordinate: str,
        metric_id: str,
        period_id: str,
        actuality: str,
    ) -> dict[str, Any]:
        resolved = self._resolved_styles.get(cell["style"], {"styleId": cell["style"]})
        font = resolved.get("font", {})
        fill = resolved.get("fill", {})
        alignment = resolved.get("alignment", {})
        style = {
            "styleId": resolved.get("styleId", cell["style"]),
            "font": {
                "bold": font.get("bold", False),
                "italic": font.get("italic", False),
                "color": deepcopy(font.get("color")),
            },
            "fill": {
                "patternType": fill.get("patternType"),
                "foregroundColor": deepcopy(fill.get("foregroundColor")),
            },
            "numberFormat": deepcopy(resolved.get("numberFormat", {})),
            "alignment": {
                key: value
                for key, value in alignment.items()
                if key in {"horizontal", "vertical", "indent", "wrapText", "textRotation"}
            },
        }
        self._evidence_styles[style["styleId"]] = style
        cell_kind = "formula" if "formula" in cell else "literal"
        semantic_definition = self._matching_style_semantic(style, cell_kind)
        source_key = _cell_key(sheet, coordinate)
        record: dict[str, Any] = {
            "sheet": sheet,
            "cell": source_key,
            "metricId": metric_id,
            "periodId": period_id,
            "actuality": actuality,
            "cellKind": cell_kind,
            "styleId": style["styleId"],
        }
        if semantic_definition:
            record["semantic"] = deepcopy(semantic_definition)
        self._style_records.append(record)
        return record

    def _style_evidence(self, inventory: dict[str, Any]) -> dict[str, Any]:
        role_counts = Counter(
            item.get("semantic", {}).get("role", "unmatched")
            for item in self._style_records
        )
        role_kind_counts = Counter(
            (
                item.get("semantic", {}).get("role", "unmatched"),
                item["cellKind"],
            )
            for item in self._style_records
        )
        return {
            "format": "financial-workbook-style-evidence@0.3",
            "source": {
                "filename": inventory["input"]["filename"],
                "sha256": inventory["input"]["sha256"],
                "sheets": sorted({item["sheet"] for item in self._style_records}),
            },
            "styleConvention": (
                {
                    "id": STYLE_CONVENTION,
                    "blueFontSourceColors": deepcopy(BLUE_FONT_SOURCE_COLORS),
                    "yellowFill": {
                        "patternType": "solid",
                        "foregroundColor": deepcopy(YELLOW_FILL_SOURCE_COLOR),
                    },
                    "roles": [
                        deepcopy(semantic)
                        for semantic in STYLE_SEMANTICS.values()
                    ],
                }
                if self.style_convention == STYLE_CONVENTION
                else None
            ),
            "styles": [
                deepcopy(self._evidence_styles[style_id])
                for style_id in sorted(self._evidence_styles)
            ],
            "summary": {
                "selectedCells": len(self._style_records),
                "matchedCells": sum(count for role, count in role_counts.items() if role != "unmatched"),
                "unmatchedCells": role_counts.get("unmatched", 0),
                "byRole": dict(sorted(role_counts.items())),
                "byRoleAndCellKind": [
                    {"role": role, "cellKind": cell_kind, "count": count}
                    for (role, cell_kind), count in sorted(role_kind_counts.items())
                ],
            },
            "cells": self._style_records,
        }

    @staticmethod
    def _canonical_metric(mapped_metric: dict[str, Any]) -> dict[str, Any]:
        return {
            key: deepcopy(value)
            for key, value in mapped_metric.items()
            if key in CANONICAL_METRIC_FIELDS
        }

    def _observation(
        self,
        metric: dict[str, Any],
        period_id: str,
        mapped_period: dict[str, Any],
        model: dict[str, Any],
        entity: dict[str, Any],
    ) -> dict[str, Any]:
        observation = {
            "id": _observation_id(metric["id"], period_id),
            "modelId": model["id"],
            "metricId": metric["id"],
            "entityId": entity["id"],
            "periodId": period_id,
            "actuality": mapped_period["actuality"],
            "asOf": model["asOf"],
            "versionId": model["currentVersionId"],
            "valueType": "reported" if mapped_period["actuality"] == "actual" else "assumption",
        }
        if metric.get("unit"):
            observation["unit"] = metric["unit"]
        if mapped_period["actuality"] == "estimate" and model.get("defaultScenarioId"):
            observation["scenarioId"] = model["defaultScenarioId"]
        return observation

    def _transformation(
        self,
        metric: dict[str, Any],
        mapped_metric: dict[str, Any],
        mapped_period: dict[str, Any],
        period_id: str,
        original_formula: str,
        automatic: FormulaTranslation | None,
    ) -> dict[str, Any]:
        period_expression = mapped_metric.get("canonicalExpressions", {}).get(mapped_period["type"])
        mapped_expression = (
            period_expression.get("expression")
            if period_expression
            else mapped_metric.get("canonicalExpression")
        )
        mapped_dependencies = (
            period_expression.get("dependencyMetricIds", [])
            if period_expression
            else mapped_metric.get("dependencyMetricIds", [])
        )
        if automatic:
            expression = automatic.expression
            dependencies = automatic.dependency_metric_ids
            self._auto_translated_count += 1
        else:
            expression = mapped_expression
            dependencies = mapped_dependencies
        supported = expression is not None
        return {
            "id": _transformation_id(metric["id"], period_id),
            "outputMetricId": metric["id"],
            "language": "model-expression@0.1",
            "expression": expression or "0",
            "dependencyMetricIds": deepcopy(
                dependencies if supported else mapped_metric.get("opaqueDependencyMetricIds", [])
            ),
            "appliesWhen": {"periodIds": [period_id]},
            "originalExpression": original_formula,
            "status": "supported" if supported else "opaque",
        }

    def _missing_cached_value(
        self,
        metric_id: str,
        period_id: str,
        sheet: str,
        coordinate: str,
        model_id: str,
        source_id: str,
    ) -> None:
        suffix = f"{_without_prefix(metric_id, 'metric_')}_{_without_prefix(period_id, 'period_')}"
        self._unresolved({
            "id": f"unresolved_missing_value_{suffix}",
            "modelId": model_id,
            "category": "source_error",
            "description": "The workbook formula has no materialized cached value; no observation was emitted.",
            "currentTreatment": f"The database omits `{metric_id}` for `{period_id}`.",
            "impact": "The selected metric-period point is unavailable in the table and formula graph.",
            "targetId": metric_id,
            "sourceArtifactId": source_id,
            "locator": _locator(sheet, cell=coordinate),
            "confidence": 0.2,
            "attentionLevel": "action_required",
            "actionOwner": "source_owner",
            "status": "open",
            "nextAction": f"Recalculate `{sheet}!{coordinate}` in the source workbook, or explicitly omit it from `{metric_id}`.",
        })

    def _missing_source_value(
        self,
        metric_id: str,
        period_id: str,
        sheet: str,
        coordinate: str,
        model_id: str,
        source_id: str,
    ) -> None:
        suffix = f"{_without_prefix(metric_id, 'metric_')}_{_without_prefix(period_id, 'period_')}"
        self._unresolved({
            "id": f"unresolved_missing_source_value_{suffix}",
            "modelId": model_id,
            "category": "source_error",
            "description": "An explicitly mapped output cell is blank or absent; no observation was emitted.",
            "currentTreatment": f"The database omits `{metric_id}` for `{period_id}`.",
            "impact": "The mapped metric-period point is unavailable and any dependent analysis may be incomplete.",
            "targetId": metric_id,
            "sourceArtifactId": source_id,
            "locator": _locator(sheet, cell=coordinate),
            "confidence": 0.99,
            "attentionLevel": "action_required",
            "actionOwner": "source_owner",
            "status": "open",
            "nextAction": f"Provide the required value at `{sheet}!{coordinate}`, or remove this point from the explicit extraction map if the blank is intentional, then rerun extraction.",
        })

    def _incompatible_value(
        self,
        metric_id: str,
        period_id: str,
        sheet: str,
        coordinate: str,
        value: Any,
        model_id: str,
        source_id: str,
    ) -> None:
        suffix = f"{_without_prefix(metric_id, 'metric_')}_{_without_prefix(period_id, 'period_')}"
        self._unresolved({
            "id": f"unresolved_incompatible_value_{suffix}",
            "modelId": model_id,
            "category": "source_error",
            "description": f"The source cell contains {value!r}, which is incompatible with the mapped metric type; no observation was emitted.",
            "currentTreatment": f"The database omits `{metric_id}` for `{period_id}` instead of inventing a replacement value.",
            "impact": "That metric-period point is absent; other valid periods and metrics remain available.",
            "targetId": metric_id,
            "sourceArtifactId": source_id,
            "locator": _locator(sheet, cell=coordinate),
            "confidence": 0.2,
            "attentionLevel": "action_required",
            "actionOwner": "source_owner",
            "status": "open",
            "nextAction": f"Provide the valid source value or corrected metric type at `{sheet}!{coordinate}` for `{metric_id}`.",
        })

    def _add_comment_evidence(
        self,
        comment: dict[str, str],
        observation_id: str,
        metric_id: str,
        period_id: str,
    ) -> None:
        suffix = f"{_without_prefix(metric_id, 'metric_')}_{_without_prefix(period_id, 'period_')}"
        evidence_id = f"evidence_comment_{suffix}"
        relationship_id = f"relationship_comment_supports_{suffix}"
        self.database["evidence"].append({
            "id": evidence_id,
            "sourceArtifactId": self.mapping["sourceArtifact"]["id"],
            "excerpt": comment["text"],
            "observedAt": self.mapping["dataset"]["updatedAt"],
        })
        self.database["relationships"].append({
            "id": relationship_id,
            "fromId": evidence_id,
            "type": "supports",
            "toId": observation_id,
            "attributes": {"author": comment["author"], "kind": "workbook_comment"},
        })
        locator = _locator(comment["sheet"], cell=comment["cell"])
        self._provenance(evidence_id, locator, 0.98)
        self._provenance(relationship_id, locator, 0.95)

    def _report(
        self,
        inventory: dict[str, Any],
        opaque_cells: dict[str, list[tuple[str, str, tuple[str, ...]]]],
        comments_used: set[str],
        unmapped_comments: list[str],
        style_evidence: dict[str, Any],
    ) -> str:
        counts = {key: len(self.database[key]) for key in (
            "entities", "metrics", "transformations", "relationships",
            "assumptions", "decisions", "unresolvedItems",
        )}
        counts["observations"] = sum(
            len(series["points"]) for series in self.database["observationSeries"]
        )
        statuses = Counter(item["status"] for item in self.database["transformations"])
        attention = Counter(
            item["attentionLevel"]
            for item in self.database["unresolvedItems"]
            if item["status"] == "open"
        )
        lines = [
            "# Extraction report", "", "## Inputs and hashes", "",
            f"- `{inventory['input']['filename']}` — {inventory['input']['bytes']} bytes — `sha256:{inventory['input']['sha256']}`.",
            "- The XLSX package was read without macro execution, formula recalculation, or external-link refresh.",
            "", "## Inventory", "",
            f"- {inventory['workbook']['sheetCount']} worksheets, {sum(item['storedCellCount'] for item in inventory['sheets'])} stored cells, {sum(item['formulaCount'] for item in inventory['sheets'])} formulas, and {inventory['workbook']['calcChainCellCount']} calc-chain entries.",
        ]
        lines.extend(
            f"- `{sheet['name']}` ({sheet['state']}): `{sheet['dimension']}`, {sheet['storedCellCount']} stored cells, {sheet['formulaCount']} formulas, {sheet['commentCount']} comments."
            for sheet in inventory["sheets"]
        )
        lines.extend(f"- WARNING — {warning}" for warning in inventory["package"]["warnings"])
        style_summary = style_evidence["summary"]
        semantic_result = (
            f"{style_summary['matchedCells']} matched the fixed `{self.style_convention}` convention"
            if self.style_convention
            else "style semantics disabled"
        )
        lines.append(
            "- Style evidence: "
            f"{style_summary['selectedCells']} selected cells inspected, "
            f"{semantic_result}, "
            "with font/fill roles kept independent of actual/estimate status; "
            "see `workbook-style-evidence.json`."
        )
        lines.extend(
            f"- Style role `{role}`: {count} selected cells."
            for role, count in style_summary["byRole"].items()
        )
        lines.extend([
            f"- Extraction scope: {self.mapping['scope']}",
            "", "## Object counts", "",
            f"- 1 model; {counts['entities']} entity; {counts['metrics']} metrics; {counts['observations']} observations; {counts['transformations']} transformations; {counts['relationships']} relationships.",
            f"- {sum(len(item['sections']) for item in self.database['tablePresentations'])} table-presentation sections across {len(self.database['tablePresentations'])} worksheet views; {counts['assumptions']} assumptions; {counts['decisions']} decisions; {attention['needs_review']} items need review; {attention['action_required']} require action.",
            "", "## Table presentation", "",
        ])
        lines.extend(
            f"- `{presentation.get('title', presentation['modelId'])}` / `{section['title']}`: "
            f"{len(section['metricIds'])} metrics and {len(section['metricParentIds'])} display-parent edges "
            f"from `{section['sourceLocator']['sheet']}!{section['sourceLocator']['range']}`."
            for presentation in self.database["tablePresentations"]
            for section in presentation["sections"]
        )
        lines.extend([
            "", "## Actual / estimate boundary", "", self.mapping["actualityBasis"],
            "", "## Formula coverage", "",
            f"- {statuses['supported']} supported, {statuses['opaque']} opaque, and {statuses['unresolved']} unresolved transformations.",
            f"- {self._auto_translated_count} formulas were auto-translated from mapped cells and accepted only after cached-value replay matched the XLSX result.",
            f"- {statuses['opaque']} extraction tooling tasks were written to `formula-translation-tasks.json`; each opaque transformation must have exactly one task.",
            f"- {len(comments_used)} comments on selected observation cells were preserved as evidence and linked to those observations.",
            (
                f"- {len(unmapped_comments)} comments outside the selected observation graph remain preserved "
                f"in `workbook-inventory.json`; examples: {', '.join(unmapped_comments[:5])}."
                if unmapped_comments
                else "- No workbook comments remain outside the selected observation graph."
            ),
            "", "## Workbook quality audit", "",
            "- Deterministic checks cover selected-cell formula errors, broken references, missing required mapped values, formula translation/replay, declared map constraints, and source/model consistency findings emitted by the extraction.",
            "- Every possible source/model error or required update is ACTION REQUIRED until repaired and re-extracted; confidence is evidence metadata and does not rank or suppress repair work.",
            (
                f"- {sum(1 for item in self.database['unresolvedItems'] if item['category'] in {'source_error', 'source_update', 'model_inconsistency'})} "
                "source/model repair actions remain open."
            ),
            "", "## Unresolved mappings", "",
        ])
        lines.extend(
            [
                f"- {'ACTION REQUIRED' if item['attentionLevel'] == 'action_required' else 'NEEDS REVIEW'} — "
                f"`{item['id']}` at `{_format_locator(item.get('locator'))}`: "
                f"{item['description']} Current treatment: {item['currentTreatment']} "
                f"Impact: {item['impact']}"
                for item in self.database["unresolvedItems"]
            ]
            or ["- None."]
        )
        lines.extend(["", "## Missing lineage", ""])
        lines.extend(
            [f"- `{metric_id}`: {len(coordinates)} source formulas are materialized but remain opaque." for metric_id, coordinates in opaque_cells.items()]
            or ["- None; every selected formula was translated."]
        )
        lines.extend([
            "", "## Validator result", "",
            "- `npm run validate -- <output>/model-db.json` — required after generation.",
            "- `npm run extraction:check -- <output>` — required final strict package check.",
            "- Every open attention item listed above remains explicit in `unresolvedItems`; none was silently discarded.",
            "", "## Questions and next actions", "",
        ])
        lines.extend(
            f"- `{item['id']}` — Source: `{_format_locator(item.get('locator'))}`. "
            f"{item['nextAction']}"
            for item in self.database["unresolvedItems"]
        )
        if not self.database["unresolvedItems"]:
            lines.append("- None.")
        return "\n".join(lines) + "\n"


def load_mapping(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
