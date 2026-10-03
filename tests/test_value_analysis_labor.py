import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("merge_value_analysis_labor", ROOT / "scripts/merge_value_analysis_labor.py")
LABOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LABOR)


def write_csv(path, headers, rows):
    path.write_text(",".join(headers) + "\n" + "\n".join(",".join(str(row.get(h, "")) for h in headers) for row in rows) + "\n", encoding="utf-8-sig")


class LaborCalculationTests(unittest.TestCase):
    def test_window_dates_route_selection_and_unregistered_rate(self):
        self.assertEqual(LABOR.period_start("202608", 3), "202606")
        self.assertEqual(LABOR.period_start("202608", 6), "202603")
        self.assertEqual(LABOR.rate_for_month(LABOR.DEFAULT_SETTINGS, "202608"), 124.64)
        self.assertIsNone(LABOR.rate_for_month(LABOR.DEFAULT_SETTINGS, "202609"))
        chosen, ambiguous = LABOR.choose_internal_routes([
            {"品目ｺｰﾄﾞ": "ITEM", "手順№": "1", "内外区分": "0", "有効日": "20200101", "失効日": "0", "優先№": "1", "工程名": "old"},
            {"品目ｺｰﾄﾞ": "ITEM", "手順№": "1", "内外区分": "0", "有効日": "20250101", "失効日": "0", "優先№": "1", "工程名": "new"},
            {"品目ｺｰﾄﾞ": "ITEM", "手順№": "2", "内外区分": "1", "有効日": "20200101", "失効日": "0", "優先№": "1", "工程名": "external"},
        ], LABOR.date(2026, 8, 31))
        self.assertEqual(list(chosen), [("ITEM", "1")])
        self.assertEqual(chosen[("ITEM", "1")]["工程名"], "new")
        self.assertEqual(ambiguous, 0)

    def test_multi_step_labor_bom_rollup_and_rate_cutoff(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            destination, actuals, routes, bom = (base / name for name in ("value.json", "actuals.csv", "routes.csv", "bom.csv"))
            actual_headers = ["伝票日付", "品目ｺｰﾄﾞ", "手順№", "報告数量", "人数", "作業時間", "基準外人数/人", "基準外工数/分", "基準外項目"]
            route_headers = ["品目ｺｰﾄﾞ", "手順№", "内外区分", "有効日", "失効日", "優先№", "工程ｺｰﾄﾞ", "工程名"]
            bom_headers = ["製番", "親品目ｺｰﾄﾞ", "子品目ｺｰﾄﾞ", "子品目名", "ﾀﾞﾐｰ構成区分", "展開ｽﾄｯﾌﾟ区分", "原単位区分", "取数(分子)", "取数(分母)", "使用禁止日"]
            write_csv(actuals, actual_headers, [
                {"伝票日付": "20260801", "品目ｺｰﾄﾞ": "ROOT", "手順№": "1", "報告数量": "2", "人数": "2", "作業時間": "10", "基準外人数/人": "1", "基準外工数/分": "2", "基準外項目": "段取り"},
                {"伝票日付": "20260802", "品目ｺｰﾄﾞ": "ROOT", "手順№": "2", "報告数量": "2", "人数": "1", "作業時間": "20", "基準外人数/人": "0", "基準外工数/分": "0", "基準外項目": ""},
                {"伝票日付": "20260803", "品目ｺｰﾄﾞ": "ROOT", "手順№": "1", "報告数量": "2", "人数": "1", "作業時間": "0", "基準外人数/人": "0", "基準外工数/分": "0", "基準外項目": ""},
                {"伝票日付": "20260804", "品目ｺｰﾄﾞ": "CHILD", "手順№": "1", "報告数量": "1", "人数": "1", "作業時間": "5", "基準外人数/人": "0", "基準外工数/分": "0", "基準外項目": ""},
            ])
            write_csv(routes, route_headers, [
                {"品目ｺｰﾄﾞ": "ROOT", "手順№": "1", "内外区分": "0", "有効日": "20200101", "失効日": "0", "優先№": "1", "工程ｺｰﾄﾞ": "A", "工程名": "工程A"},
                {"品目ｺｰﾄﾞ": "ROOT", "手順№": "2", "内外区分": "0", "有効日": "20200101", "失効日": "0", "優先№": "1", "工程ｺｰﾄﾞ": "B", "工程名": "工程B"},
                {"品目ｺｰﾄﾞ": "CHILD", "手順№": "1", "内外区分": "0", "有効日": "20200101", "失効日": "0", "優先№": "1", "工程ｺｰﾄﾞ": "C", "工程名": "工程C"},
            ])
            write_csv(bom, bom_headers, [
                {"親品目ｺｰﾄﾞ": "ROOT", "子品目ｺｰﾄﾞ": "CHILD", "子品目名": "子品", "取数(分子)": "2", "取数(分母)": "1"},
                {"親品目ｺｰﾄﾞ": "ROOT", "子品目ｺｰﾄﾞ": "CHILD", "子品目名": "子品", "取数(分子)": "2", "取数(分母)": "1"},
            ])
            destination.write_text(json.dumps({"months": ["202608"], "meta": {"generated_at": "2026-08-31T12:00:00+09:00"}, "item_analysis": {"items": {"ROOT": {}, "CHILD": {}}, "months": ["202608"], "rows": [{"y": "202608", "i": "ROOT"}], "labor": {"settings": {"period_months": 6, "allocated_exception_keywords": ["段取り", "段取"]}}}}), encoding="utf-8")
            (base / "_value_analysis_labor_sources.json").write_text(json.dumps({"routes_updated_at": "2026-08-30 03:00", "bom_updated_at": "2026-08-29 03:00"}), encoding="utf-8")
            prior_data_dir = LABOR.DATA
            LABOR.DATA = base
            try:
                LABOR.merge(destination, actuals, routes, bom)
            finally:
                LABOR.DATA = prior_data_dir
            output = json.loads(destination.read_text(encoding="utf-8"))
            result = output["item_analysis"]["labor"]["months"]["202608"]["windows"]["3"]
            root = result["handoff"]["items"]["ROOT"]
            self.assertNotIn("items", result)
            self.assertAlmostEqual(root["processing_minutes"], 24.5)
            self.assertAlmostEqual(root["setup_minutes"], 0.5)
            self.assertAlmostEqual(root["standard_minutes"], 25.0)
            self.assertAlmostEqual(root["labor_amount_yen"], 3116.0)
            self.assertEqual(root["reported_zero"], 1)
            self.assertEqual(result["input_rate"], 75.0)
            self.assertEqual(result["internal_route_count"], 3)
            self.assertAlmostEqual(result["handoff"]["items"]["ROOT"]["standard_minutes"], 25.0)
            self.assertEqual(json.loads(destination.read_text(encoding="utf-8"))["item_analysis"]["labor"]["bom_deduplication"]["duplicate_parent_child_rows_removed"], 1)
            settings = json.loads(destination.read_text(encoding="utf-8"))["item_analysis"]["labor"]["settings"]
            self.assertEqual(settings["period_months"], 6)
            self.assertEqual(settings["allocated_exception_keywords"], ["段取り", "段取"])
            handoff = result["handoff"]
            self.assertEqual(handoff["meta"]["version_id"], LABOR.HANDOFF_VERSION_ID)
            self.assertEqual(handoff["meta"]["generated_at"], "2026-08-31T12:00:00+09:00")
            self.assertEqual(handoff["meta"]["period_from"], "2026-06-01")
            self.assertEqual(handoff["meta"]["period_to"], "2026-08-31")
            self.assertEqual(handoff["meta"]["sources"]["製造実績の最終日付"], "2026-08-04")
            self.assertEqual(handoff["meta"]["sources"]["品目手順マスタ更新日時"], "2026-08-30 03:00")
            self.assertEqual(handoff["meta"]["sources"]["構成マスタ更新日時"], "2026-08-29 03:00")
            self.assertEqual(handoff["meta"]["settings"]["months"], 3)
            self.assertEqual(handoff["meta"]["settings"]["allocate_items"], ["段取り", "段取"])
            for key in ("製造実績の最終日付", "品目手順マスタ更新日時", "構成マスタ更新日時"):
                self.assertIn(key, handoff["meta"]["sources"])
            self.assertEqual(handoff["rates"], [{"from_month": "202604", "through_month": "202608", "yen_per_min": 124.64}])
            self.assertEqual(handoff["items"]["ROOT"]["cum_std_per_unit"], root["cum_std_per_unit"])
            self.assertEqual(handoff["items"]["ROOT"]["cum_std_per_unit"], 25.0)
            self.assertEqual(handoff["items"]["ROOT"]["own_run_per_unit"], 14.5)
            self.assertEqual(handoff["items"]["ROOT"]["own_setup_per_unit"], 0.5)
            self.assertEqual(handoff["items"]["ROOT"]["own_std_per_unit"], 15.0)
            self.assertEqual(handoff["items"]["ROOT"]["steps"][0]["工程"], "工程A")
            self.assertEqual(handoff["items"]["ROOT"]["children"][0]["品目コード"], "CHILD")
            self.assertEqual(handoff["items"]["ROOT"]["children"][0]["cum_std_per_unit"], 5.0)

    def test_over_cap_is_capped_and_reported_without_item_names_in_summary(self):
        routes = {("ITEM", "1"): {"工程名": "private"}}
        rows = [{"伝票日付": "20260801", "品目ｺｰﾄﾞ": "ITEM", "手順№": "1", "報告数量": "1", "人数": "1", "作業時間": "4", "基準外人数/人": "3", "基準外工数/分": "2", "基準外項目": "段取り"}]
        window, diagnostics = LABOR.calculate_window("202608", 3, rows, routes, {}, LABOR.DEFAULT_SETTINGS)
        self.assertEqual(window["needs_review"]["exception_exceeds_total"], 1)
        self.assertEqual(window["handoff"]["items"]["ITEM"]["standard_minutes"], 4.0)
        self.assertNotIn("ITEM", str(diagnostics))

    def test_future_dates_and_unmatched_routes_are_excluded(self):
        future = "29991231"
        rows = [
            {"伝票日付": future, "品目ｺｰﾄﾞ": "ITEM", "手順№": "1", "報告数量": "1", "人数": "1", "作業時間": "1"},
            {"伝票日付": "20260801", "品目ｺｰﾄﾞ": "ITEM", "手順№": "9", "報告数量": "1", "人数": "1", "作業時間": "1"},
        ]
        window, _ = LABOR.calculate_window("202608", 3, rows, {}, {}, LABOR.DEFAULT_SETTINGS)
        self.assertEqual(window["excluded"]["future_date"], 1)
        self.assertEqual(window["excluded"]["route_missing_or_not_internal"], 1)

    def test_selected_period_without_actual_results_is_distinguished(self):
        routes = {("ITEM", "1"): {"工程名": "工程"}}
        window, _ = LABOR.calculate_window("202608", 3, [], routes, {}, LABOR.DEFAULT_SETTINGS)
        self.assertEqual(window["status"], "no_results")
        self.assertEqual(window["actual_record_count"], 0)
        self.assertIsNone(window["input_rate"])
        self.assertEqual(window["handoff"]["items"], {})

    def test_value_analysis_ui_reads_handoff_items_as_primary_source(self):
        html = (ROOT / "static/value_analysis.html").read_text(encoding="utf-8")
        self.assertIn("windowData?.handoff?.items?.[code]", html)
        self.assertIn("labor_standard_minutes:labor?.cum_std_per_unit??null", html)
        self.assertIn("minutes(labor?.cum_std_per_unit)", html)
        self.assertIn("Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2})", html)
        self.assertIn("data-cum-std-per-unit=", html)
        self.assertIn("handoff.meta?.version_id", html)
        self.assertIn("工数版：${esc(versionId)}", html)

    def test_value_analysis_ui_reads_same_unrounded_handoff_value_and_shows_version(self):
        html = (ROOT / "static/value_analysis.html").read_text(encoding="utf-8")
        self.assertIn("labor_standard_minutes:labor?.cum_std_per_unit??null", html)
        self.assertIn("minutes(labor?.cum_std_per_unit)", html)
        self.assertIn("data-cum-std-per-unit=", html)
        self.assertIn("handoff.meta?.version_id", html)
        self.assertIn("工数版：${esc(versionId)}", html)


if __name__ == "__main__":
    unittest.main()
