#!/usr/bin/env python3
"""Focused tests for sparse OOXML inventory and mapped extraction."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import unittest

from formula_translation import FormulaTranslator
from mapped_workbook import MappedWorkbookExtractor, _is_specific_blue_font
from ooxml import WorkbookPackage, translate_shared_formula


def observations(database):
    return [
        {**{key: value for key, value in series.items() if key != "points"}, **point}
        for series in database["observationSeries"]
        for point in series["points"]
    ]


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


def write_fixture(path: Path, sheet_xml: str = SHEET_XML) -> None:
    with ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", WORKBOOK_XML)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        archive.writestr("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS)
        archive.writestr("xl/comments1.xml", COMMENTS_XML)
        archive.writestr("xl/styles.xml", STYLES_XML)
        archive.writestr("xl/theme/theme1.xml", THEME_XML)


def mapping() -> dict:
    return {
        "format": "financial-model-workbook-map@0.3",
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
                    "presentationParentMetricId": None,
                    "componentOfMetricId": None,
                },
                {
                    "id": "metric_test_output",
                    "name": "Output",
                    "row": 2,
                    "labelCell": "A2",
                    "dataType": "number",
                    "canonicalExpression": 'ref("metric_test_input") * 2',
                    "dependencyMetricIds": ["metric_test_input"],
                    "presentationParentMetricId": "metric_test_input",
                    "componentOfMetricId": "metric_test_input",
                },
            ],
        }],
    }


class WorkbookToolTests(unittest.TestCase):
    def test_mapped_extraction_requires_explicit_parent_decisions(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            write_fixture(workbook)
            incomplete_mapping = mapping()
            del incomplete_mapping["sections"][0]["metrics"][1]["presentationParentMetricId"]

            with self.assertRaisesRegex(
                ValueError,
                r"metric_test_output must explicitly declare presentationParentMetricId",
            ):
                MappedWorkbookExtractor(workbook, incomplete_mapping).extract()

            incomplete_mapping = mapping()
            del incomplete_mapping["sections"][0]["metrics"][1]["componentOfMetricId"]
            with self.assertRaisesRegex(
                ValueError,
                r"metric_test_output must explicitly declare componentOfMetricId",
            ):
                MappedWorkbookExtractor(workbook, incomplete_mapping).extract()

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

    def test_formula_translation_requires_mapped_inputs_and_cached_value_replay(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            write_fixture(workbook)
            with WorkbookPackage(workbook) as package:
                source_cells = package.cells("Model")
                source_cells["E1"] = {
                    "cell": "E1", "type": "n", "style": 0, "rawValue": "7", "value": 7,
                }
                translator = FormulaTranslator(source_cells, {
                    "B1": {
                        "metricId": "metric_test_input",
                        "periodId": "period_fy2024",
                        "dataType": "number",
                    },
                    "C1": {
                        "metricId": "metric_test_input",
                        "periodId": "period_fy2025",
                        "dataType": "number",
                    },
                    "D1": {
                        "metricId": "metric_test_blank_input",
                        "periodId": "period_fy2025",
                        "dataType": "number",
                    },
                })

            sum_translation = translator.translate(
                "=SUM(B1:C1)", "C2", "period_fy2025", 5,
            )
            self.assertIsNotNone(sum_translation)
            self.assertEqual(
                (sum_translation.expression, sum_translation.dependency_metric_ids),
                (
                    'sum(period_ref("metric_test_input", "period_fy2024"), '
                    'ref("metric_test_input"))',
                    ["metric_test_input"],
                ),
            )
            self.assertIsNone(
                translator.translate(
                    "=SUM(B1:C1)", "C2", "period_fy2025", 6,
                ),
            )

            literal_translation = translator.translate(
                "=380+440", "C2", "period_fy2025", 820,
            )
            self.assertIsNotNone(literal_translation)
            self.assertEqual(
                (literal_translation.expression, literal_translation.dependency_metric_ids),
                ("(380 + 440)", []),
            )

            percent_translation = translator.translate(
                "=B1+0.2%", "C2", "period_fy2025", 2.002,
            )
            self.assertIsNotNone(percent_translation)
            self.assertEqual(
                (percent_translation.expression, percent_translation.dependency_metric_ids),
                (
                    '(period_ref("metric_test_input", "period_fy2024") + 0.002)',
                    ["metric_test_input"],
                ),
            )

            nested_sum = translator.translate(
                "=C1-SUM(B1:B1)", "C2", "period_fy2025", 1,
            )
            self.assertIsNotNone(nested_sum)
            self.assertEqual(
                nested_sum.expression,
                '(ref("metric_test_input") - '
                'sum(period_ref("metric_test_input", "period_fy2024")))',
            )
            multi_range_sum = translator.translate(
                "=SUM(B1:C1,C1:C1)", "C2", "period_fy2025", 8,
            )
            self.assertIsNotNone(multi_range_sum)
            self.assertEqual(
                multi_range_sum.expression,
                'sum(period_ref("metric_test_input", "period_fy2024"), '
                'ref("metric_test_input"), ref("metric_test_input"))',
            )
            sumproduct = translator.translate(
                "=SUMPRODUCT(B1:C1,B1:C1)", "C2", "period_fy2025", 13,
            )
            self.assertIsNotNone(sumproduct)
            self.assertEqual(
                sumproduct.expression,
                'sum((period_ref("metric_test_input", "period_fy2024") * '
                'period_ref("metric_test_input", "period_fy2024")), '
                '(ref("metric_test_input") * ref("metric_test_input")))',
            )
            conditional_sum = FormulaTranslator(
                {
                    "B1": {"value": 2029}, "C1": {"value": 2029},
                    "B2": {"value": 2}, "C2": {"value": 3},
                    "D1": {"value": "2029"},
                },
                {
                    "B2": {"metricId": "metric_a", "periodId": "period_q1", "dataType": "number"},
                    "C2": {"metricId": "metric_a", "periodId": "period_q2", "dataType": "number"},
                },
            ).translate("=SUMIFS(B2:C2,B1:C1,D1)", "D2", "period_year", 5)
            self.assertIsNotNone(conditional_sum)
            self.assertEqual(
                conditional_sum.expression,
                'sum(period_ref("metric_a", "period_q1"), '
                'period_ref("metric_a", "period_q2"))',
            )
            blank_arithmetic = translator.translate(
                "=C1+D1", "C2", "period_fy2025", 3,
            )
            self.assertIsNotNone(blank_arithmetic)
            self.assertEqual(
                (blank_arithmetic.expression, blank_arithmetic.dependency_metric_ids),
                ('(ref("metric_test_input") + 0)', ["metric_test_input"]),
            )
            absent_blank = translator.translate(
                "=E2+1", "C2", "period_fy2025", 1,
            )
            self.assertIsNotNone(absent_blank)
            self.assertEqual(absent_blank.expression, "(0 + 1)")
            average_translation = translator.translate(
                "=AVERAGE(B1:D1)", "C2", "period_fy2025", 2.5,
            )
            self.assertIsNotNone(average_translation)
            self.assertEqual(
                average_translation.expression,
                'average(period_ref("metric_test_input", "period_fy2024"), '
                'ref("metric_test_input"))',
            )
            discrete_average = translator.translate(
                "=AVERAGE(C1,D1)", "C2", "period_fy2025", 3,
            )
            self.assertIsNotNone(discrete_average)
            self.assertEqual(
                discrete_average.expression,
                'average(ref("metric_test_input"))',
            )
            literal_average = translator.translate(
                "=AVERAGE(8.35,10.76,11.54)",
                "C2",
                "period_fy2025",
                10.216666666666667,
            )
            self.assertIsNotNone(literal_average)
            self.assertEqual(
                literal_average.expression,
                "average(8.35, 10.76, 11.54)",
            )
            conditional_translation = translator.translate(
                "=IF(MOD(C1,4),90,91)", "C2", "period_fy2025", 90,
            )
            self.assertIsNotNone(conditional_translation)
            self.assertEqual(
                conditional_translation.expression,
                'when((mod(ref("metric_test_input"), 4) != 0), 90, 91)',
            )
            comparison_translation = translator.translate(
                "=IF(C1=3,365,366)", "C2", "period_fy2025", 365,
            )
            self.assertIsNotNone(comparison_translation)
            self.assertEqual(
                comparison_translation.expression,
                'when((ref("metric_test_input") == 3), 365, 366)',
            )
            self.assertIsNone(
                translator.translate(
                    "=IF(MOD(C1,4),90,91)", "C2", "period_fy2025", 91,
                ),
            )
            self.assertEqual(
                translator.blocker("=E1"),
                "referenced period columns outside the selected semantic map",
            )
            self.assertEqual(
                translator.blocker("='Reported'!B1"),
                "referenced worksheet semantics are not mapped: `Reported`",
            )
            period_blocker = translator.blocker_details("=E1")
            self.assertEqual(period_blocker.kind, "unmapped_period")
            self.assertEqual(period_blocker.coordinates, ("E1",))

            guarded_iferror = translator.translate(
                "=IFERROR(B1/(C1-C1),7)", "C2", "period_fy2025", 7,
            )
            self.assertIsNotNone(guarded_iferror)
            self.assertEqual(
                guarded_iferror.expression,
                '(((ref("metric_test_input") - ref("metric_test_input")) == 0) '
                '? 7 : (period_ref("metric_test_input", "period_fy2024") / '
                '(ref("metric_test_input") - ref("metric_test_input"))))',
            )
            guarded_iferror_nonzero = translator.translate(
                "=IFERROR(C1/B1,7)", "C2", "period_fy2025", 1.5,
            )
            self.assertIsNotNone(guarded_iferror_nonzero)
            self.assertEqual(
                guarded_iferror_nonzero.expression,
                '((period_ref("metric_test_input", "period_fy2024") == 0) '
                '? 7 : (ref("metric_test_input") / '
                'period_ref("metric_test_input", "period_fy2024")))',
            )

            text_error = FormulaTranslator(
                {"B1": {"value": 3}, "C1": {"value": "n.a."}},
                {
                    "B1": {"metricId": "metric_input", "periodId": "period_fy2025", "dataType": "number"},
                },
            ).translate("=IFERROR(B1*C1,0)", "D1", "period_fy2025", 0)
            self.assertIsNotNone(text_error)
            self.assertEqual((text_error.expression, text_error.dependency_metric_ids), ("0", []))

            aggregate_text = FormulaTranslator(
                {
                    "B1": {"value": 4},
                    "C1": {"value": "0", "formula": '=IF(B1<0,B1,"0")'},
                },
                {
                    "B1": {"metricId": "metric_input", "periodId": "period_fy2025", "dataType": "number"},
                },
            ).translate("=SUM(B1:C1)", "D1", "period_fy2025", 4)
            self.assertIsNotNone(aggregate_text)
            self.assertEqual(
                (aggregate_text.expression, aggregate_text.dependency_metric_ids),
                ('sum(ref("metric_input"), 0)', ["metric_input"]),
            )

            qualified = FormulaTranslator(
                {"Drivers!B1": {"value": 2, "style": 0}},
                {
                    "Drivers!B1": {
                        "metricId": "metric_test_driver",
                        "periodId": "period_fy2025",
                        "dataType": "number",
                    },
                },
                default_sheet="Model",
                strict_grid=False,
            )
            cross_sheet = qualified.translate(
                "='Drivers'!B1*2",
                "B2",
                "period_fy2025",
                4,
                "Model",
            )
            self.assertIsNotNone(cross_sheet)
            self.assertEqual(
                cross_sheet.expression,
                '(ref("metric_test_driver") * 2)',
            )
            unmapped_sheet = qualified.blocker_details("='Unmapped'!B1", "Model")
            self.assertEqual(unmapped_sheet.kind, "unmapped_sheet")
            self.assertEqual(unmapped_sheet.coordinates, ("Unmapped!B1",))

            header_literal = FormulaTranslator(
                {"H2": {"value": 2020, "style": 0}},
                {},
                literal_coordinates={"H2"},
            )
            leap_year = header_literal.translate(
                "=IF(MOD(H2,4),365,366)",
                "H3",
                "period_fy2020",
                366,
            )
            self.assertIsNotNone(leap_year)
            self.assertEqual(
                (leap_year.expression, leap_year.dependency_metric_ids),
                ("when((mod(2020, 4) != 0), 365, 366)", []),
            )
            iferror = header_literal.translate(
                "=IFERROR(H2*2,0)", "H3", "period_fy2020", 4040
            )
            self.assertIsNotNone(iferror)
            self.assertEqual((iferror.expression, iferror.dependency_metric_ids), ("(2020 * 2)", []))

    def test_mapped_extraction_rejects_formula_period_gaps(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            gap_sheet = SHEET_XML.replace(
                '<f t="shared" si="0" ref="B2:B3">B1*2</f><v>4</v>',
                '<f>C1*2</f><v>6</v>',
            )
            write_fixture(workbook, gap_sheet)
            gap_mapping = mapping()
            gap_mapping["periods"] = gap_mapping["periods"][:1]

            with self.assertRaisesRegex(
                ValueError,
                r"period mapping is incomplete.*Model!B2 references Model!C1",
            ):
                MappedWorkbookExtractor(workbook, gap_mapping).extract()

    def test_explicit_cells_support_vertical_and_non_grid_formula_chains(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            write_fixture(workbook)
            explicit_mapping = mapping()
            explicit_mapping["format"] = "financial-model-workbook-map@0.3"
            for period in explicit_mapping["periods"]:
                del period["column"]
            input_metric, output_metric = explicit_mapping["sections"][0]["metrics"]
            del input_metric["row"]
            input_metric["cells"] = [
                {"cell": "B1", "periodId": "period_fy2024"},
                {"cell": "C1", "periodId": "period_fy2025"},
            ]
            del output_metric["row"]
            output_metric["cells"] = [
                {"cell": "B2", "periodId": "period_fy2024"},
                {"cell": "B3", "periodId": "period_fy2025"},
            ]

            result = MappedWorkbookExtractor(workbook, explicit_mapping).extract()

            self.assertEqual(len(observations(result.database)), 4)
            self.assertEqual(
                result.database["transformations"][1]["expression"],
                '(period_ref("metric_test_output", "period_fy2024") * 2)',
            )
            self.assertEqual(result.database["unresolvedItems"], [])
            self.assertEqual(result.formula_translation_tasks["items"], [])
            self.assertIn("2 formulas were auto-translated", result.report)

    def test_mapped_sections_can_be_partitioned_into_worksheet_presentations(self) -> None:
        with TemporaryDirectory() as directory:
            workbook = Path(directory) / "fixture.xlsx"
            write_fixture(workbook)
            multi_view_mapping = mapping()
            section = multi_view_mapping["sections"][0]
            output_metric = section["metrics"].pop()
            output_metric["presentationParentMetricId"] = None
            multi_view_mapping["sections"].append({
                "id": "section_test_output",
                "title": "Output",
                "sourceRange": "A2:C2",
                "metrics": [output_metric],
            })
            multi_view_mapping["presentations"] = [
                {
                    "id": "presentation_test_inputs",
                    "title": "Inputs",
                    "sourceLocator": "A1:C1",
                    "sectionIds": ["section_test"],
                },
                {
                    "id": "presentation_test_outputs",
                    "title": "Outputs",
                    "sourceLocator": "A2:C2",
                    "sectionIds": ["section_test_output"],
                },
            ]

            result = MappedWorkbookExtractor(workbook, multi_view_mapping).extract()

            self.assertEqual(
                [item["id"] for item in result.database["tablePresentations"]],
                ["presentation_test_inputs", "presentation_test_outputs"],
            )
            self.assertIn("2 worksheet views", result.report)

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
            extracted_observations = observations(result.database)
            self.assertEqual(len(extracted_observations), 4)
            self.assertEqual(extracted_observations[3]["value"], 6)
            self.assertEqual(result.database["transformations"][0]["sourceExpressions"]["period_fy2024"], "=B1*2")
            self.assertEqual(result.database["transformations"][0]["status"], "supported")
            self.assertEqual(
                result.database["tablePresentations"][0]["sections"][0]["metricParentIds"],
                {"metric_test_output": "metric_test_input"},
            )
            self.assertIn(
                {
                    "id": "relationship_test_output_component_of_test_input",
                    "fromId": "metric_test_output",
                    "type": "component_of",
                    "toId": "metric_test_input",
                },
                result.database["relationships"],
            )
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
            self.assertEqual(
                result.style_evidence["format"],
                "financial-workbook-style-evidence@0.3",
            )
            self.assertEqual(
                result.style_evidence["cells"][0]["styleId"],
                1,
            )
            self.assertEqual(
                result.style_evidence["styles"][2]["fill"]["foregroundColor"]["rgb"],
                "FFFFFF00",
            )

            automatic_mapping = deepcopy(mapping())
            output_metric = automatic_mapping["sections"][0]["metrics"][1]
            del output_metric["canonicalExpression"]
            del output_metric["dependencyMetricIds"]
            automatic = MappedWorkbookExtractor(workbook, automatic_mapping).extract()
            self.assertEqual(
                [item["status"] for item in automatic.database["transformations"]],
                ["supported"],
            )
            self.assertEqual(
                automatic.database["transformations"][0]["expression"],
                '(ref("metric_test_input") * 2)',
            )
            self.assertEqual(
                set(automatic.database["transformations"][0]["sourceExpressions"]),
                {"period_fy2024", "period_fy2025"},
            )
            self.assertIn("2 formulas were auto-translated", automatic.report)

            missing_sheet = SHEET_XML.replace(
                '<c r="C1" s="2"><v>3</v></c>',
                "",
            )
            missing_workbook = Path(directory) / "missing.xlsx"
            write_fixture(missing_workbook, missing_sheet)
            missing = MappedWorkbookExtractor(missing_workbook, mapping()).extract()
            missing_action = next(
                item
                for item in missing.database["unresolvedItems"]
                if item["id"] == "unresolved_missing_source_value_test_input_fy2025"
            )
            self.assertEqual(missing_action["category"], "source_error")
            self.assertEqual(missing_action["attentionLevel"], "action_required")
            self.assertEqual(missing_action["actionOwner"], "source_owner")
            self.assertIn("Workbook quality audit", missing.report)

            opaque_sheet = SHEET_XML.replace(
                '<f t="shared" si="0" ref="B2:B3">B1*2</f><v>4</v>',
                '<f>OFFSET(B1,0,0)*2</f><v>4</v>',
            )
            opaque_workbook = Path(directory) / "opaque.xlsx"
            write_fixture(opaque_workbook, opaque_sheet)
            opaque_mapping = deepcopy(mapping())
            opaque_metric = opaque_mapping["sections"][0]["metrics"][1]
            del opaque_metric["canonicalExpression"]
            del opaque_metric["dependencyMetricIds"]
            opaque = MappedWorkbookExtractor(opaque_workbook, opaque_mapping).extract()
            self.assertEqual(len(opaque.formula_translation_tasks["items"]), 1)
            self.assertEqual(
                opaque.formula_translation_tasks["items"][0]["source"],
                {"sheet": "Model", "cell": "B2"},
            )
            self.assertEqual(
                opaque.formula_translation_tasks["items"][0]["blocker"]["reason"],
                "unsupported Excel function(s): OFFSET",
            )
            opaque_action = next(
                item
                for item in opaque.database["unresolvedItems"]
                if item["category"] == "formula"
            )
            self.assertEqual(opaque_action["attentionLevel"], "action_required")
            self.assertTrue(opaque_action["currentTreatment"])
            self.assertTrue(opaque_action["impact"])
            self.assertIn("extend the restricted translator", opaque_action["nextAction"])

            map_gap_sheet = SHEET_XML.replace(
                '<f t="shared" si="0" ref="B2:B3">B1*2</f><v>4</v>',
                '<f>B4*2</f><v>4</v>',
            ).replace(
                "</sheetData>",
                '<row r="4"><c r="B4"><v>2</v></c></row></sheetData>',
            )
            map_gap_workbook = Path(directory) / "map-gap.xlsx"
            write_fixture(map_gap_workbook, map_gap_sheet)
            map_gap_mapping = deepcopy(mapping())
            map_gap_metric = map_gap_mapping["sections"][0]["metrics"][1]
            del map_gap_metric["canonicalExpression"]
            del map_gap_metric["dependencyMetricIds"]
            map_gap = MappedWorkbookExtractor(map_gap_workbook, map_gap_mapping).extract()
            map_gap_action = next(
                item
                for item in map_gap.database["unresolvedItems"]
                if item["category"] == "formula"
            )
            self.assertIn("map-coverage item", map_gap_action["nextAction"])
            self.assertIn("extend the private semantic map", map_gap_action["nextAction"])
            self.assertIn(
                "Expand the private semantic map",
                map_gap.formula_translation_tasks["items"][0]["acceptance"][3],
            )

            alternate_actuality_mapping = deepcopy(mapping())
            alternate_actuality_mapping["periods"][1]["actuality"] = "actual"
            alternate_actuality = MappedWorkbookExtractor(
                workbook,
                alternate_actuality_mapping,
            ).extract()
            self.assertEqual(alternate_actuality.database["unresolvedItems"], [])
            hardcode_cell = next(
                item
                for item in alternate_actuality.style_evidence["cells"]
                if item["cell"] == "Model!C1"
            )
            self.assertEqual(
                hardcode_cell["semantic"]["role"],
                "alice_hardcode",
            )
            self.assertNotIn("actualityConflict", hardcode_cell)

            incomplete_attention_mapping = deepcopy(mapping())
            incomplete_attention_mapping["unresolvedItems"] = [{
                "id": "unresolved_missing_guidance",
                "modelId": "model_test",
                "category": "other",
                "description": "A review item without actionable guidance.",
                "status": "open",
                "attentionLevel": "needs_review",
            }]
            with self.assertRaisesRegex(ValueError, "non-empty currentTreatment"):
                MappedWorkbookExtractor(workbook, incomplete_attention_mapping).extract()

            conflicting_attention_mapping = deepcopy(mapping())
            conflicting_attention_mapping["unresolvedItems"] = [{
                "id": "unresolved_conflicting_next_action",
                "modelId": "model_test",
                "category": "other",
                "description": "A review item with conflicting migration fields.",
                "currentTreatment": "The mapped value remains visible.",
                "impact": "The interpretation may be wrong.",
                "nextAction": "Use the canonical instruction.",
                "analystQuestion": "Use the legacy instruction.",
                "status": "open",
                "attentionLevel": "needs_review",
            }]
            with self.assertRaisesRegex(ValueError, "analystQuestion is not part"):
                MappedWorkbookExtractor(workbook, conflicting_attention_mapping).extract()

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
