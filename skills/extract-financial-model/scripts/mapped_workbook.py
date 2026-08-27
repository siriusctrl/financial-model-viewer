"""Deterministic extraction from an explicit semantic workbook map."""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import json

from ooxml import WorkbookPackage


MAP_FORMAT = "financial-model-workbook-map@0.1"
STYLE_CELL_KINDS = {"formula", "literal"}
STYLE_COLOR_FIELDS = {"type", "rgb", "theme", "indexed", "auto", "tint"}
STYLE_VALUE_TYPES = {"reported", "assumption", "external_estimate"}
ACTUALITIES = {"actual", "estimate"}


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


def _color_matches(color: dict[str, Any] | None, pattern: dict[str, Any]) -> bool:
    if color is None:
        return False
    for key, expected in pattern.items():
        actual = color.get(key)
        if key == "rgb" and isinstance(actual, str) and isinstance(expected, str):
            normalized_actual = actual.upper()
            normalized_expected = expected.upper()
            if len(normalized_actual) == 6:
                normalized_actual = f"FF{normalized_actual}"
            if len(normalized_expected) == 6:
                normalized_expected = f"FF{normalized_expected}"
            if normalized_actual != normalized_expected:
                return False
        elif actual != expected:
            return False
    return True


def _matches_any_color(
    color: dict[str, Any] | None,
    patterns: list[dict[str, Any]],
) -> bool:
    return any(_color_matches(color, pattern) for pattern in patterns)


def _validate_style_rules(rules: Any) -> list[dict[str, Any]]:
    if not isinstance(rules, list):
        raise ValueError("styleSemantics.rules must be an array")
    validated: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ValueError(f"styleSemantics.rules[{index}] must be an object")
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not rule_id:
            raise ValueError(f"styleSemantics.rules[{index}].id must be a non-empty string")
        if rule_id in seen_ids:
            raise ValueError(f"Duplicate style semantic rule ID: {rule_id}")
        seen_ids.add(rule_id)
        unsupported_rule_fields = set(rule) - {
            "id", "role", "description", "match", "expectedActuality",
            "conflictQuestion", "valueType", "adjustable",
        }
        if unsupported_rule_fields:
            raise ValueError(
                f"Style semantic rule {rule_id} has unsupported fields: "
                f"{', '.join(sorted(unsupported_rule_fields))}"
            )
        role = rule.get("role")
        if not isinstance(role, str) or not role:
            raise ValueError(f"Style semantic rule {rule_id} must declare a non-empty role")
        match = rule.get("match")
        if not isinstance(match, dict) or not match:
            raise ValueError(f"Style semantic rule {rule_id} must declare a non-empty match object")
        unsupported = set(match) - {
            "cellKinds", "fontColors", "fillColors", "excludeFillColors",
        }
        if unsupported:
            raise ValueError(
                f"Style semantic rule {rule_id} has unsupported match fields: {', '.join(sorted(unsupported))}"
            )
        if not match.get("fontColors") and not match.get("fillColors"):
            raise ValueError(
                f"Style semantic rule {rule_id} must positively match fontColors or fillColors"
            )
        cell_kinds = match.get("cellKinds")
        if cell_kinds is not None and (
            not isinstance(cell_kinds, list)
            or not cell_kinds
            or any(item not in STYLE_CELL_KINDS for item in cell_kinds)
        ):
            raise ValueError(
                f"Style semantic rule {rule_id} cellKinds must contain only formula or literal"
            )
        for field in ("fontColors", "fillColors", "excludeFillColors"):
            patterns = match.get(field)
            if patterns is None:
                continue
            if (
                not isinstance(patterns, list)
                or not patterns
                or any(not isinstance(pattern, dict) or not pattern for pattern in patterns)
            ):
                raise ValueError(
                    f"Style semantic rule {rule_id} {field} must be a non-empty array of color objects"
                )
            for pattern in patterns:
                unsupported_colors = set(pattern) - STYLE_COLOR_FIELDS
                if unsupported_colors:
                    raise ValueError(
                        f"Style semantic rule {rule_id} {field} has unsupported color fields: "
                        f"{', '.join(sorted(unsupported_colors))}"
                    )
                rgb = pattern.get("rgb")
                if rgb is not None and (
                    not isinstance(rgb, str)
                    or len(rgb) not in {6, 8}
                    or any(character not in "0123456789abcdefABCDEF" for character in rgb)
                ):
                    raise ValueError(
                        f"Style semantic rule {rule_id} {field} rgb must be 6 or 8 hexadecimal characters"
                    )
                if "theme" in pattern and not isinstance(pattern["theme"], int):
                    raise ValueError(f"Style semantic rule {rule_id} {field} theme must be an integer")
                if "indexed" in pattern and not isinstance(pattern["indexed"], int):
                    raise ValueError(f"Style semantic rule {rule_id} {field} indexed must be an integer")
                if "auto" in pattern and not isinstance(pattern["auto"], bool):
                    raise ValueError(f"Style semantic rule {rule_id} {field} auto must be boolean")
                tint = pattern.get("tint")
                if tint is not None and (
                    isinstance(tint, bool)
                    or not isinstance(tint, (int, float))
                    or not -1 <= tint <= 1
                ):
                    raise ValueError(f"Style semantic rule {rule_id} {field} tint must be between -1 and 1")
        expected_actuality = rule.get("expectedActuality")
        if expected_actuality is not None and expected_actuality not in ACTUALITIES:
            raise ValueError(
                f"Style semantic rule {rule_id} expectedActuality must be actual or estimate"
            )
        value_type = rule.get("valueType")
        if value_type is not None and value_type not in STYLE_VALUE_TYPES:
            raise ValueError(
                f"Style semantic rule {rule_id} valueType must be reported, assumption, or external_estimate"
            )
        if "adjustable" in rule and not isinstance(rule["adjustable"], bool):
            raise ValueError(f"Style semantic rule {rule_id} adjustable must be boolean")
        validated.append(deepcopy(rule))
    return validated


@dataclass
class ExtractionResult:
    database: dict[str, Any]
    report: str
    inventory: dict[str, Any]
    style_evidence: dict[str, Any]


class MappedWorkbookExtractor:
    """Extract only concepts explicitly declared in a semantic mapping file."""

    def __init__(self, workbook: Path, mapping: dict[str, Any]):
        if mapping.get("format") != MAP_FORMAT:
            raise ValueError(f"Mapping must declare format {MAP_FORMAT}")
        self.workbook = workbook.resolve()
        self.mapping = mapping
        self.sheet_name = mapping["sheet"]
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
        self._analyst_questions: dict[str, str] = {}
        self._resolved_styles: dict[int, dict[str, Any]] = {}
        self._evidence_styles: dict[int, dict[str, Any]] = {}
        self._style_records: list[dict[str, Any]] = []
        self._style_conflicts: list[dict[str, Any]] = []
        style_semantics = mapping.get("styleSemantics", {})
        if not isinstance(style_semantics, dict):
            raise ValueError("styleSemantics must be an object")
        self._style_rules = _validate_style_rules(style_semantics.get("rules", []))

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
        canonical = {key: deepcopy(value) for key, value in item.items() if key != "analystQuestion"}
        self.database["unresolvedItems"].append(canonical)
        self._analyst_questions[canonical["id"]] = item.get(
            "analystQuestion",
            f"What source evidence should resolve `{canonical['id']}`?",
        )
        self._provenance(
            canonical["id"],
            canonical.get("locator") or _locator(self.sheet_name),
            canonical.get("confidence", 0.5),
        )

    def extract(self) -> ExtractionResult:
        with WorkbookPackage(self.workbook) as package:
            cells = package.cells(self.sheet_name)
            comments = {item["cell"]: item for item in package.comments(self.sheet_name)}
            inventory = package.inventory("none")
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
        model_locator = _locator(self.sheet_name, range_=self.mapping["modelRange"])
        self._provenance(model["id"], model_locator, 0.98)
        self._provenance(entity["id"], model_locator, 0.98)
        for scenario in self.database["scenarios"]:
            self._provenance(
                scenario["id"],
                _locator(self.sheet_name, range_=self.mapping["periodHeaderRange"]),
                0.95,
            )

        periods_by_id: dict[str, dict[str, Any]] = {}
        for mapped_period in self.mapping["periods"]:
            period = {
                key: deepcopy(value)
                for key, value in mapped_period.items()
                if key not in {"column", "actuality", "headerCell"}
            }
            self.database["periods"].append(period)
            periods_by_id[period["id"]] = mapped_period
            self._provenance(
                period["id"],
                _locator(self.sheet_name, cell=mapped_period["headerCell"]),
                0.99,
            )

        comments_used: set[str] = set()
        opaque_cells: dict[str, list[str]] = defaultdict(list)
        sections = []
        metric_ids: set[str] = set()
        for section in self.mapping["sections"]:
            section_metric_ids = []
            for mapped_metric in section["metrics"]:
                metric = self._canonical_metric(mapped_metric)
                if metric["id"] in metric_ids:
                    raise ValueError(f"Duplicate mapped metric ID: {metric['id']}")
                metric_ids.add(metric["id"])
                observations_before = len(self.database["observations"])
                for period_id, mapped_period in periods_by_id.items():
                    coordinate = f"{mapped_period['column']}{mapped_metric['row']}"
                    cell = cells.get(coordinate)
                    if not cell or (cell.get("value") is None and "formula" not in cell):
                        continue
                    style_record = self._record_style(
                        cell,
                        coordinate,
                        metric["id"],
                        period_id,
                        mapped_period["actuality"],
                    )
                    if cell.get("value") is None and "formula" in cell:
                        style_record["canonicalTargetEmitted"] = False
                        self._missing_cached_value(metric["id"], period_id, coordinate, model["id"], source["id"])
                        continue
                    value = cell.get("value")
                    if not _metric_value_is_valid(value, metric["dataType"]):
                        style_record["canonicalTargetEmitted"] = False
                        self._incompatible_value(
                            metric["id"], period_id, coordinate, value, model["id"], source["id"],
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
                        transformation = self._transformation(
                            metric,
                            mapped_metric,
                            mapped_period,
                            period_id,
                            cell["formula"],
                        )
                        self.database["transformations"].append(transformation)
                        observation["valueType"] = "derived"
                        observation["transformationId"] = transformation["id"]
                        self._provenance(
                            transformation["id"],
                            _locator(self.sheet_name, cell=coordinate),
                            0.94 if transformation["status"] == "supported" else 0.78,
                        )
                        if transformation["status"] == "opaque":
                            opaque_cells[metric["id"]].append(coordinate)
                    elif (
                        style_record.get("semantic", {}).get("valueType")
                        and not style_record.get("actualityConflict")
                    ):
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
                        _locator(self.sheet_name, cell=coordinate),
                        0.98 if mapped_period["actuality"] == "actual" else 0.86,
                    )
                    if coordinate in comments:
                        self._add_comment_evidence(comments[coordinate], observation["id"], metric["id"], period_id)
                        comments_used.add(coordinate)

                if len(self.database["observations"]) == observations_before:
                    raise ValueError(f"Mapped metric {metric['id']} has no observations in the selected periods")
                self.database["metrics"].append(metric)
                section_metric_ids.append(metric["id"])
                self._provenance(
                    metric["id"],
                    _locator(self.sheet_name, cell=mapped_metric["labelCell"]),
                    mapped_metric.get("confidence", 0.95),
                )
            sections.append({
                "id": section["id"],
                "title": section["title"],
                "metricIds": section_metric_ids,
                "sourceLocator": _locator(self.sheet_name, range_=section["sourceRange"]),
            })
        self.database["tablePresentations"] = [{
            "modelId": model["id"],
            "sourceArtifactId": source["id"],
            "sections": sections,
        }]

        for metric_id, coordinates in opaque_cells.items():
            suffix = _without_prefix(metric_id, "metric_")
            self._unresolved({
                "id": f"unresolved_opaque_formula_{suffix}",
                "modelId": model["id"],
                "category": "formula",
                "description": f"{len(coordinates)} materialized workbook formulas are preserved as opaque because they were not safely translated to model-expression@0.1.",
                "targetId": metric_id,
                "sourceArtifactId": source["id"],
                "locator": _locator(self.sheet_name, range_=f"{coordinates[0]}:{coordinates[-1]}"),
                "confidence": 0.72,
                "status": "open",
                "analystQuestion": f"Should `{metric_id}` be translated into canonical lineage, or remain opaque workbook logic?",
            })
        unmapped_comments = sorted(set(comments) - comments_used)
        if unmapped_comments:
            examples = ", ".join(unmapped_comments[:5])
            self._unresolved({
                "id": "unresolved_unmapped_comments",
                "modelId": model["id"],
                "category": "lineage",
                "description": (
                    f"{len(unmapped_comments)} comments on {self.sheet_name} were inventoried but do not attach "
                    f"to selected observation cells; examples: {examples}."
                ),
                "targetId": model["id"],
                "sourceArtifactId": source["id"],
                "locator": _locator(self.sheet_name, cell=unmapped_comments[0]),
                "confidence": 0.65,
                "status": "open",
                "analystQuestion": "Which unmapped workbook comments contain material model rationale that should be promoted to canonical evidence?",
            })
        conflicts_by_rule: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for conflict in self._style_conflicts:
            conflicts_by_rule[conflict["ruleId"]].append(conflict)
        for rule_id, conflicts in conflicts_by_rule.items():
            rule = next(item for item in self._style_rules if item["id"] == rule_id)
            examples = ", ".join(item["cell"] for item in conflicts[:8])
            expected = rule.get("expectedActuality")
            actualities = sorted({item["actuality"] for item in conflicts})
            self._unresolved({
                "id": f"unresolved_style_actuality_{rule_id}",
                "modelId": model["id"],
                "category": "actuality_boundary",
                "description": (
                    f"Style rule `{rule_id}` expects actuality `{expected}`, but {len(conflicts)} selected cells "
                    f"are mapped as {', '.join(actualities)}; examples: {examples}."
                ),
                "targetId": model["id"],
                "sourceArtifactId": source["id"],
                "locator": _locator(self.sheet_name, cell=conflicts[0]["cell"]),
                "confidence": 0.55,
                "status": "open",
                "analystQuestion": rule.get(
                    "conflictQuestion",
                    f"Should cells matched by `{rule_id}` change actuality, or is the style convention broader than documented?",
                ),
            })
        for item in self.mapping.get("unresolvedItems", []):
            self._unresolved(deepcopy(item))

        style_evidence = self._style_evidence(inventory)
        return ExtractionResult(
            self.database,
            self._report(inventory, opaque_cells, comments_used, style_evidence),
            inventory,
            style_evidence,
        )

    def _matching_style_rule(self, style: dict[str, Any], cell_kind: str) -> dict[str, Any] | None:
        font_color = style.get("font", {}).get("color")
        fill_color = style.get("fill", {}).get("foregroundColor")
        for rule in self._style_rules:
            match = rule.get("match", {})
            cell_kinds = match.get("cellKinds")
            if cell_kinds and cell_kind not in cell_kinds:
                continue
            font_colors = match.get("fontColors")
            if font_colors and not _matches_any_color(font_color, font_colors):
                continue
            fill_colors = match.get("fillColors")
            if fill_colors and not _matches_any_color(fill_color, fill_colors):
                continue
            excluded_fills = match.get("excludeFillColors", [])
            if excluded_fills and _matches_any_color(fill_color, excluded_fills):
                continue
            return rule
        return None

    def _record_style(
        self,
        cell: dict[str, Any],
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
        rule = self._matching_style_rule(style, cell_kind)
        record: dict[str, Any] = {
            "cell": coordinate,
            "metricId": metric_id,
            "periodId": period_id,
            "actuality": actuality,
            "cellKind": cell_kind,
            "styleId": style["styleId"],
        }
        if rule:
            semantic = {
                key: deepcopy(value)
                for key, value in rule.items()
                if key not in {"match", "expectedActuality", "conflictQuestion"}
            }
            record["semantic"] = semantic
            expected_actuality = rule.get("expectedActuality")
            if expected_actuality and expected_actuality != actuality:
                record["actualityConflict"] = True
                self._style_conflicts.append({
                    "cell": coordinate,
                    "metricId": metric_id,
                    "periodId": period_id,
                    "actuality": actuality,
                    "expectedActuality": expected_actuality,
                    "ruleId": rule["id"],
                })
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
            "format": "financial-workbook-style-evidence@0.1",
            "source": {
                "filename": inventory["input"]["filename"],
                "sha256": inventory["input"]["sha256"],
                "sheet": self.sheet_name,
            },
            "semanticRules": deepcopy(self._style_rules),
            "styles": [
                deepcopy(self._evidence_styles[style_id])
                for style_id in sorted(self._evidence_styles)
            ],
            "summary": {
                "selectedCells": len(self._style_records),
                "matchedCells": sum(count for role, count in role_counts.items() if role != "unmatched"),
                "unmatchedCells": role_counts.get("unmatched", 0),
                "actualityConflicts": len(self._style_conflicts),
                "byRole": dict(sorted(role_counts.items())),
                "byRoleAndCellKind": [
                    {"role": role, "cellKind": cell_kind, "count": count}
                    for (role, cell_kind), count in sorted(role_kind_counts.items())
                ],
            },
            "conflicts": deepcopy(self._style_conflicts),
            "cells": self._style_records,
        }

    @staticmethod
    def _canonical_metric(mapped_metric: dict[str, Any]) -> dict[str, Any]:
        excluded = {
            "row",
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

    @staticmethod
    def _transformation(
        metric: dict[str, Any],
        mapped_metric: dict[str, Any],
        mapped_period: dict[str, Any],
        period_id: str,
        original_formula: str,
    ) -> dict[str, Any]:
        period_expression = mapped_metric.get("canonicalExpressions", {}).get(mapped_period["type"])
        expression = period_expression.get("expression") if period_expression else mapped_metric.get("canonicalExpression")
        dependencies = (
            period_expression.get("dependencyMetricIds", [])
            if period_expression
            else mapped_metric.get("dependencyMetricIds", [])
        )
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
            "locator": _locator(self.sheet_name, cell=coordinate),
            "confidence": 0.2,
            "status": "open",
            "analystQuestion": f"Should `{coordinate}` be recalculated in the source workbook, or omitted from `{metric_id}`?",
        })

    def _incompatible_value(
        self,
        metric_id: str,
        period_id: str,
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
            "locator": _locator(self.sheet_name, cell=coordinate),
            "confidence": 0.2,
            "status": "open",
            "analystQuestion": f"What numeric source value should replace {value!r} at `{self.sheet_name}!{coordinate}` for `{metric_id}`?",
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
        locator = _locator(self.sheet_name, cell=comment["cell"])
        self._provenance(evidence_id, locator, 0.98)
        self._provenance(relationship_id, locator, 0.95)

    def _report(
        self,
        inventory: dict[str, Any],
        opaque_cells: dict[str, list[str]],
        comments_used: set[str],
        style_evidence: dict[str, Any],
    ) -> str:
        counts = {key: len(self.database[key]) for key in (
            "entities", "metrics", "observations", "transformations", "relationships",
            "assumptions", "decisions", "unresolvedItems",
        )}
        statuses = Counter(item["status"] for item in self.database["transformations"])
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
        lines.append(
            "- Style evidence: "
            f"{style_summary['selectedCells']} selected cells inspected, "
            f"{style_summary['matchedCells']} matched semantic rules, "
            f"{style_summary['actualityConflicts']} actuality conflicts; "
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
            f"- {len(self.database['tablePresentations'][0]['sections'])} table-presentation sections; {counts['assumptions']} assumptions; {counts['decisions']} decisions; {counts['unresolvedItems']} open unresolved items.",
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
            f"- {len(comments_used)} comments on selected observation cells were preserved as evidence and linked to those observations.",
            "", "## Unresolved mappings", "",
        ])
        lines.extend(
            [f"- WARNING — `{item['id']}`: {item['description']}" for item in self.database["unresolvedItems"]]
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
            "- Every open warning listed above remains explicit in `unresolvedItems`; no warning was silently discarded.",
            "", "## Analyst questions", "",
        ])
        lines.extend(
            f"- `{item['id']}` — {self._analyst_questions[item['id']]}"
            for item in self.database["unresolvedItems"]
        )
        if not self.database["unresolvedItems"]:
            lines.append("- None.")
        return "\n".join(lines) + "\n"


def load_mapping(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
