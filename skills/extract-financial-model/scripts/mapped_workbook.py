"""Deterministic extraction from an explicit semantic workbook map."""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json

from formula_translation import FormulaTranslation, FormulaTranslator, expand_cell_range
from ooxml import WorkbookPackage


MAP_FORMAT = "financial-model-workbook-map@0.2"
SUPPORTED_MAP_FORMATS = {
    "financial-model-workbook-map@0.1",
    MAP_FORMAT,
}
STYLE_CONVENTION = "alice-blue-yellow@0.1"
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
        if mapping.get("format") not in SUPPORTED_MAP_FORMATS:
            raise ValueError(
                f"Mapping must declare one of {', '.join(sorted(SUPPORTED_MAP_FORMATS))}"
            )
        self.workbook = workbook.resolve()
        self.mapping = mapping
        self.sheet_name = mapping["sheet"]
        self.map_format = mapping["format"]
        self.database: dict[str, Any] = {
            "schemaVersion": "0.1.0",
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
        self._next_actions: dict[str, str] = {}
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
        canonical = {
            key: deepcopy(value)
            for key, value in item.items()
            if key not in {"nextAction", "analystQuestion"}
        }
        canonical.setdefault("attentionLevel", "needs_review")
        self.database["unresolvedItems"].append(canonical)
        self._next_actions[canonical["id"]] = item.get(
            "nextAction",
            item.get(
                "analystQuestion",
                f"Inspect source evidence and resolve `{canonical['id']}`.",
            ),
        )
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
        seen_metrics: set[str] = set()
        seen_cells: dict[str, str] = {}
        seen_points: dict[tuple[str, str], str] = {}
        for section in self.mapping["sections"]:
            for metric in section["metrics"]:
                metric_id = metric["id"]
                if metric_id in seen_metrics:
                    raise ValueError(f"Duplicate mapped metric ID: {metric_id}")
                seen_metrics.add(metric_id)
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
        period_header_locator = _mapped_locator(
            self.mapping["periodHeaderRange"], self.sheet_name, kind="range"
        )
        selected_sheets = {
            assignment["sheet"]
            for assignments in self._assignments_by_metric.values()
            for assignment in assignments
        }
        selected_sheets.add(period_header_locator["sheet"])
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
                    self.mapping["periodHeaderRange"], self.sheet_name, kind="range"
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
        strict_grid = self.map_format.endswith("@0.1") and all(
            "cells" not in metric
            for metric in metrics_by_id.values()
        )
        header_range = period_header_locator["range"]
        if ":" in header_range:
            header_start, header_end = header_range.split(":", 1)
            header_coordinates = expand_cell_range(header_start, header_end)
        else:
            header_coordinates = [header_range.replace("$", "").upper()]
        if not header_coordinates:
            raise ValueError(
                "periodHeaderRange must be a valid, forward, bounded A1 range of at most 1,000 cells"
            )
        literal_coordinates = {
            _cell_key(period_header_locator["sheet"], coordinate)
            for coordinate in header_coordinates
        }
        self._formula_translator = FormulaTranslator(
            cells,
            coordinate_semantics,
            default_sheet=self.sheet_name,
            strict_grid=strict_grid,
            literal_coordinates=literal_coordinates,
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
                                "acceptance": [
                                    "Use only approved restricted-expression syntax; never emit executable TypeScript or JavaScript.",
                                    "Preserve the original Excel formula and source-cell provenance.",
                                    "Rerun extraction and accept the translation only when cached-value replay matches.",
                                    "Prefer a reusable deterministic translator extension over a one-cell exception.",
                                    "Keep the linked action_required item open while the transformation remains opaque.",
                                ],
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
            sections.append({
                "id": section["id"],
                "title": section["title"],
                "metricIds": section_metric_ids,
                "sourceLocator": section_locator,
            })
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
                "targetId": metric_id,
                "sourceArtifactId": source["id"],
                "locator": _locator_from_key(coordinates[0]),
                "confidence": 0.72,
                "attentionLevel": "action_required",
                "status": "open",
                "nextAction": (
                    "No analyst decision is required for this translator-coverage item. "
                    "Engineering follow-up: extend the restricted translator for the named function(s), "
                    "then rerun cached-value replay."
                ),
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
                "The extraction agent must resolve reusable translator-coverage items, rerun extraction, "
                "and require cached-value replay before treating this bundle as complete. "
                "Do not execute source formulas or emit arbitrary TypeScript/JavaScript."
            ),
            "items": formula_translation_items,
        }
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
        excluded = {
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
        return {key: deepcopy(value) for key, value in mapped_metric.items() if key not in excluded}

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
            "category": "formula",
            "description": "The workbook formula has no materialized cached value; no observation was emitted.",
            "targetId": metric_id,
            "sourceArtifactId": source_id,
            "locator": _locator(sheet, cell=coordinate),
            "confidence": 0.2,
            "attentionLevel": "action_required",
            "status": "open",
            "nextAction": f"Recalculate `{sheet}!{coordinate}` in the source workbook, or explicitly omit it from `{metric_id}`.",
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
            "category": "metric_mapping",
            "description": f"The source cell contains {value!r}, which is incompatible with the mapped metric type; no observation was emitted.",
            "targetId": metric_id,
            "sourceArtifactId": source_id,
            "locator": _locator(sheet, cell=coordinate),
            "confidence": 0.2,
            "attentionLevel": "action_required",
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
            "entities", "metrics", "observations", "transformations", "relationships",
            "assumptions", "decisions", "unresolvedItems",
        )}
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
            f"- {len(self.database['tablePresentations'][0]['sections'])} table-presentation sections; {counts['assumptions']} assumptions; {counts['decisions']} decisions; {attention['needs_review']} items need review; {attention['action_required']} require action.",
            "", "## Table presentation", "",
        ])
        lines.extend(
            f"- `{section['title']}`: {len(section['metricIds'])} metrics from `{section['sourceLocator']['sheet']}!{section['sourceLocator']['range']}`."
            for section in self.database["tablePresentations"][0]["sections"]
        )
        lines.extend([
            "", "## Actual / estimate boundary", "", self.mapping["actualityBasis"],
            "", "## Formula coverage", "",
            f"- {statuses['supported']} supported, {statuses['opaque']} opaque, and {statuses['unresolved']} unresolved transformations.",
            f"- {self._auto_translated_count} formulas were auto-translated from mapped cells and accepted only after cached-value replay matched the XLSX result.",
            f"- {statuses['opaque']} engineering follow-up tasks were written to `formula-translation-tasks.json`; each opaque transformation must have exactly one task.",
            f"- {len(comments_used)} comments on selected observation cells were preserved as evidence and linked to those observations.",
            (
                f"- {len(unmapped_comments)} comments outside the selected observation graph remain preserved "
                f"in `workbook-inventory.json`; examples: {', '.join(unmapped_comments[:5])}."
                if unmapped_comments
                else "- No workbook comments remain outside the selected observation graph."
            ),
            "", "## Unresolved mappings", "",
        ])
        lines.extend(
            [
                f"- {'ACTION REQUIRED' if item['attentionLevel'] == 'action_required' else 'NEEDS REVIEW'} — "
                f"`{item['id']}` at `{_format_locator(item.get('locator'))}`: "
                f"{item['description']}"
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
            f"{self._next_actions[item['id']]}"
            for item in self.database["unresolvedItems"]
        )
        if not self.database["unresolvedItems"]:
            lines.append("- None.")
        return "\n".join(lines) + "\n"


def load_mapping(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
