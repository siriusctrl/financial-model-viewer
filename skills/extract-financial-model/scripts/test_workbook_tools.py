#!/usr/bin/env python3
"""Focused tests for sparse OOXML inventory and mapped extraction."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import unittest

from mapped_workbook import MappedWorkbookExtractor, _is_specific_blue_font
from ooxml import WorkbookPackage, translate_shared_formula


WORKBOOK_XML = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets>
  <calcPr fullCalcOnLoad="1"/>
</workbook>"""

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""

SHEET_XML = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:C3"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Input</t></is></c><c r="B1" s="1"><v>2</v></c><c r="C1" s="2"><v>3</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Output</t></is></c><c r="B2"><f t="shared" si="0" ref="B2:B3">B1*2</f><v>4</v></c><c r="C2"><f>C1*2</f><v>6</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Next</t></is></c><c r="B3"><f t="shared" si="0"/><v>8</v></c></row>
  </sheetData>
</worksheet>"""

STYLES_XML = """<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><name val="Arial"/><sz val="10"/><color theme="1"/></font>
    <font><name val="Arial"/><sz val="10"/><color theme="8"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>"""

THEME_XML = """<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">
  <a:themeElements><a:clrScheme name="Test">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
    <a:accent1><a:srgbClr val="5B9BD5"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
    <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="4472C4"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
  </a:clrScheme><a:fontScheme name="Test"/><a:fmtScheme name="Test"/></a:themeElements>
</a:theme>"""

SHEET_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>
</Relationships>"""

COMMENTS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <authors><author>Analyst</author></authors>
  <commentList><comment ref="B2" authorId="0"><text><t>Reviewed output</t></text></comment></commentList>
</comments>"""


def write_fixture(path: Path) -> None:
    with ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", WORKBOOK_XML)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        archive.writestr("xl/worksheets/sheet1.xml", SHEET_XML)
        archive.writestr("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS)
        archive.writestr("xl/comments1.xml", COMMENTS_XML)
        archive.writestr("xl/styles.xml", STYLES_XML)
        archive.writestr("xl/theme/theme1.xml", THEME_XML)


def mapping() -> dict:
    return {
        "format": "financial-model-workbook-map@0.1",
        "dataset": {
            "id": "dataset_test",
            "name": "Test",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "defaultModelId": "model_test",
        },
        "model": {
            "id": "model_test",
            "name": "Test model",
            "primaryEntityId": "entity_test",
            "baseCurrency": "USD",
            "asOf": "2026-01-01",
            "currentVersionId": "version_test",
            "versionIds": ["version_test"],
        },
        "entity": {"id": "entity_test", "type": "company", "name": "Test"},
        "scenarios": [],
        "sourceArtifact": {"id": "artifact_test", "type": "workbook", "title": "Test.xlsx"},
        "extractionRun": {
            "id": "run_test",
            "startedAt": "2026-01-01T00:00:00Z",
            "completedAt": "2026-01-01T00:00:01Z",
            "extractor": "mapped-workbook-test",
            "status": "completed",
        },
        "sheet": "Model",
        "modelRange": "A1:B2",
        "periodHeaderRange": "B1:B1",
        "scope": "Synthetic two-row fixture.",
        "actualityBasis": "The sole period is explicitly mapped as actual.",
        "periods": [
            {
                "id": "period_fy2024",
                "label": "FY24A",
                "type": "fiscal_year",
                "startDate": "2024-01-01",
                "endDate": "2024-12-31",
                "column": "B",
                "headerCell": "B1",
                "actuality": "actual",
            },
            {
                "id": "period_fy2025",
                "label": "FY25E",
                "type": "fiscal_year",
                "startDate": "2025-01-01",
                "endDate": "2025-12-31",
                "column": "C",
                "headerCell": "C1",
                "actuality": "estimate",
            },
        ],
        "styleConvention": "alice-blue-yellow@0.1",
        "sections": [{
            "id": "section_test",
            "title": "Test",
            "sourceRange": "A1:B2",
            "metrics": [
                {
                    "id": "metric_test_input",
                    "name": "Input",
                    "row": 1,
                    "labelCell": "A1",
                    "dataType": "number",
                },
                {
                    "id": "metric_test_output",
                    "name": "Output",
                    "row": 2,
                    "labelCell": "A2",
                    "dataType": "number",
                    "canonicalExpression": 'ref("metric_test_input") * 2',
                    "dependencyMetricIds": ["metric_test_input"],
                },
            ],
        }],
    }


class WorkbookToolTests(unittest.TestCase):
    def test_fixed_style_convention_only_accepts_observed_blue_sources(self) -> None:
        self.assertTrue(_is_specific_blue_font({"type": "theme", "theme": 4}))
        self.assertTrue(_is_specific_blue_font({
            "type": "theme",
            "theme": 4,
            "tint": -0.499984740745262,
        }))
        self.assertTrue(_is_specific_blue_font({"type": "theme", "theme": 8}))
        self.assertTrue(_is_specific_blue_font({"type": "rgb", "rgb": "FF0070C0"}))
        self.assertFalse(_is_specific_blue_font({"type": "rgb", "rgb": "FF0000FF"}))
        self.assertFalse(_is_specific_blue_font({"type": "theme", "theme": 4, "tint": 0.25}))

    def test_shared_formula_translation_respects_absolute_references_and_strings(self) -> None:
        self.assertEqual(
            translate_shared_formula('A1+$A1+A$1+$A$1+Sheet2!B2+"A1"+LOG10(B1)', "B2", "C3"),
            'B2+$A2+B$1+$A$1+Sheet2!C3+"A1"+LOG10(C2)',
        )

    def test_sparse_inventory_and_mapped_extraction(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            write_fixture(workbook)
            with WorkbookPackage(workbook) as package:
                inventory = package.inventory()
                style_inventory = package.inventory("style")
                cells = package.cells("Model")
            self.assertEqual(inventory["sheets"][0]["storedCellCount"], 8)
            self.assertEqual(inventory["sheets"][0]["formulaCount"], 3)
            self.assertEqual(inventory["sheets"][0]["commentCount"], 1)
            self.assertEqual(cells["B3"]["formula"], "=B2*2")
            self.assertEqual(package.resolved_style(1)["font"]["color"]["theme"], 8)
            self.assertEqual(package.resolved_style(2)["fill"]["foregroundColor"]["rgb"], "FFFFFF00")
            self.assertEqual(style_inventory["sheets"][0]["cells"][2], {"cell": "C1", "styleId": 2})

            result = MappedWorkbookExtractor(workbook, mapping()).extract()
            self.assertEqual(len(result.database["observations"]), 4)
            self.assertEqual(result.database["observations"][3]["value"], 6)
            self.assertEqual(result.database["transformations"][0]["originalExpression"], "=B1*2")
            self.assertEqual(result.database["transformations"][0]["status"], "supported")
            self.assertEqual(result.database["evidence"][0]["excerpt"], "Reviewed output")
            self.assertEqual(result.database["unresolvedItems"], [])
            self.assertEqual(result.style_evidence["summary"]["byRole"], {
                "alice_hardcode": 1,
                "reported_source": 1,
                "unmatched": 2,
            })
            self.assertEqual(
                result.style_evidence["styleConvention"]["id"],
                "alice-blue-yellow@0.1",
            )
            self.assertEqual(result.style_evidence["summary"]["actualityConflicts"], 0)
            self.assertEqual(
                result.style_evidence["cells"][0]["styleId"],
                1,
            )
            self.assertEqual(
                result.style_evidence["styles"][2]["fill"]["foregroundColor"]["rgb"],
                "FFFFFF00",
            )

            conflicting_mapping = deepcopy(mapping())
            conflicting_mapping["periods"][1]["actuality"] = "actual"
            conflicting = MappedWorkbookExtractor(workbook, conflicting_mapping).extract()
            self.assertEqual(conflicting.style_evidence["summary"]["actualityConflicts"], 1)
            self.assertEqual(
                conflicting.database["unresolvedItems"][0]["id"],
                "unresolved_style_actuality_alice_hardcode",
            )

            invalid_mapping = deepcopy(mapping())
            invalid_mapping["styleConvention"] = "configurable-colors@0.1"
            with self.assertRaisesRegex(ValueError, "Unsupported styleConvention"):
                MappedWorkbookExtractor(workbook, invalid_mapping)

            legacy_mapping = deepcopy(mapping())
            legacy_mapping["styleSemantics"] = {"rules": []}
            with self.assertRaisesRegex(ValueError, "Configurable styleSemantics rules are not supported"):
                MappedWorkbookExtractor(workbook, legacy_mapping)


if __name__ == "__main__":
    unittest.main()
