#!/usr/bin/env python3
"""Focused tests for sparse OOXML inventory and mapped extraction."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import unittest

from mapped_workbook import MappedWorkbookExtractor
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
  <dimension ref="A1:B3"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Input</t></is></c><c r="B1"><v>2</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Output</t></is></c><c r="B2"><f t="shared" si="0" ref="B2:B3">B1*2</f><v>4</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Next</t></is></c><c r="B3"><f t="shared" si="0"/><v>8</v></c></row>
  </sheetData>
</worksheet>"""

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
        "periods": [{
            "id": "period_fy2024",
            "label": "FY24A",
            "type": "fiscal_year",
            "startDate": "2024-01-01",
            "endDate": "2024-12-31",
            "column": "B",
            "headerCell": "B1",
            "actuality": "actual",
        }],
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
                cells = package.cells("Model")
            self.assertEqual(inventory["sheets"][0]["storedCellCount"], 6)
            self.assertEqual(inventory["sheets"][0]["formulaCount"], 2)
            self.assertEqual(inventory["sheets"][0]["commentCount"], 1)
            self.assertEqual(cells["B3"]["formula"], "=B2*2")

            result = MappedWorkbookExtractor(workbook, mapping()).extract()
            self.assertEqual(len(result.database["observations"]), 2)
            self.assertEqual(result.database["observations"][1]["value"], 4)
            self.assertEqual(result.database["transformations"][0]["originalExpression"], "=B1*2")
            self.assertEqual(result.database["transformations"][0]["status"], "supported")
            self.assertEqual(result.database["evidence"][0]["excerpt"], "Reviewed output")
            self.assertEqual(result.database["unresolvedItems"], [])


if __name__ == "__main__":
    unittest.main()
