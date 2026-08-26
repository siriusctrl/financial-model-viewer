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


@dataclass
class ExtractionResult:
    database: dict[str, Any]
    report: str
    inventory: dict[str, Any]


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
                    if cell.get("value") is None and "formula" in cell:
                        self._missing_cached_value(metric["id"], period_id, coordinate, model["id"], source["id"])
                        continue
                    value = cell.get("value")
                    if not _metric_value_is_valid(value, metric["dataType"]):
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
                    self.database["observations"].append(observation)
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
        for item in self.mapping.get("unresolvedItems", []):
            self._unresolved(deepcopy(item))

        return ExtractionResult(
            self.database,
            self._report(inventory, opaque_cells, comments_used),
            inventory,
        )

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
