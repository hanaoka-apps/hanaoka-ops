import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import build_value_analysis_production_results as production  # noqa: E402


def item(code="SAMPLE-A"):
    return {
        "品目ｺｰﾄﾞ": code, "品目名": "架空品目", "単位": "台",
        "大分類ｺｰﾄﾞ": "A", "大分類名": "架空大分類",
        "中分類ｺｰﾄﾞ": "B", "中分類名": "架空中分類",
        "小分類ｺｰﾄﾞ": "C", "小分類名": "架空小分類",
    }


def route(step, *, internal="0", priority="1", work_area="第一工場 組立", code="SAMPLE-A", start="20200101"):
    return {
        "品目ｺｰﾄﾞ": code, "手順№": str(step), "内外区分": internal,
        "優先№": priority, "有効日": start, "失効日": "0",
        "工程ｺｰﾄﾞ": f"PROCESS-{step}", "工程名": f"架空工程{step}",
        "手配先名": work_area,
    }


def actual(step, qty, *, day="20260910", work_area="第一工場 組立", code="SAMPLE-A", forced="0", **extra):
    row = {
        "伝票日付": day, "品目ｺｰﾄﾞ": code, "手順№": str(step),
        "報告数量": str(qty), "手配先名": work_area, "完納区分": forced,
    }
    row.update(extra)
    return row


class ProductionResultsTests(unittest.TestCase):
    def test_only_final_internal_step_counts_not_forced_or_external_step(self):
        routes = [route(1), route(2), route(3, internal="1")]
        actuals = [actual(1, 5, forced="1"), actual(2, 4), actual(2, 3), actual(3, 9)]
        result = production.build(actuals, routes, [item()], today=date(2026, 10, 8))
        self.assertEqual(result["rows"], [
            {"m": "2026-09", "item": "SAMPLE-A", "factory": "第一工場", "ws": "第一工場 組立", "qty": 7}
        ])
        self.assertEqual(result["diagnostics"]["earlier_internal_step"], 1)
        self.assertEqual(result["diagnostics"]["not_internal_or_unmatched_route"], 1)
        self.assertEqual(result["items"]["SAMPLE-A"]["unit"], "台")
        self.assertEqual(result["items"]["SAMPLE-A"]["dc"], "A")

    def test_month_factory_and_work_area_are_separate_keys(self):
        routes = [route(1, work_area="第一工場 組立")]
        actuals = [
            actual(1, "1.5"), actual(1, 2, work_area="第一工場 検査"),
            actual(1, 3, work_area="第二工場 組立"),
            actual(1, 4, day="20261001"),
        ]
        result = production.build(actuals, routes, [item()], today=date(2026, 10, 8))
        self.assertEqual([(row["m"], row["factory"], row["ws"], row["qty"]) for row in result["rows"]], [
            ("2026-09", "第一工場", "第一工場 検査", 2),
            ("2026-09", "第一工場", "第一工場 組立", 1.5),
            ("2026-09", "第二工場", "第二工場 組立", 3),
            ("2026-10", "第一工場", "第一工場 組立", 4),
        ])
        self.assertEqual(result["diagnostics"]["route_work_area_differs"], 2)

    def test_missing_or_future_data_is_not_zero_filled_or_guessed(self):
        routes = [route(1)]
        actuals = [
            actual(1, 1, day="20251001"), actual(1, 2, day="20260901"),
            actual(1, 3, day="20261009"), actual(1, 4, work_area="不明作業区"),
            actual(1, 5, code="MISSING"),
        ]
        result = production.build(actuals, routes, [item()], today=date(2026, 10, 8))
        self.assertEqual(result["months"][0], "2025-04")
        self.assertEqual(result["months"][-1], "2027-03")
        self.assertEqual(len(result["months"]), 24)
        self.assertEqual(result["observed_months"], ["2025-10", "2026-09"])
        self.assertEqual([row["qty"] for row in result["rows"]], [1, 2])
        self.assertEqual(result["diagnostics"]["invalid_or_future_date"], 1)
        self.assertEqual(result["diagnostics"]["unknown_work_area"], 1)

    def test_route_selection_uses_labor_priority_and_effective_dates(self):
        routes = [
            route(1, start="20200101"),
            route(2, start="20200101", priority="2"),
            route(2, start="20200101", priority="1"),
            route(3, start="20261001"),
        ]
        result = production.build(
            [actual(2, 3), actual(3, 5, day="20261002")], routes, [item()],
            today=date(2026, 10, 8),
        )
        self.assertEqual([(row["m"], row["qty"]) for row in result["rows"]], [
            ("2026-09", 3), ("2026-10", 5),
        ])

    def test_daily_rows_cover_latest_two_observed_months_only(self):
        routes = [route(1)]
        actuals = [
            actual(1, 1, day="20260801"), actual(1, 2, day="20260902"),
            actual(1, 3, day="20260902"), actual(1, 4, day="20261005"),
            actual(1, 5, day="20261005", work_area="第三工場 組立"),
        ]
        result = production.build(actuals, routes, [item()], today=date(2026, 10, 8))
        self.assertEqual(result["daily_months"], ["2026-09", "2026-10"])
        self.assertEqual([(r["d"], r["factory"], r["ws"], r["qty"]) for r in result["daily_rows"]], [
            ("2026-09-02", "第一工場", "第一工場 組立", 5), ("2026-10-05", "第一工場", "第一工場 組立", 4),
            ("2026-10-05", "第三工場", "第三工場 組立", 5),
        ])

    def test_optional_classes_and_index_are_kept_when_present(self):
        extra = dict(item(), **{"品目名索引": "ﾀﾞﾝﾃﾞｨ", "工場別付加価ｺｰﾄﾞ": "000001", "工場別付加価名": "第一工場"})
        result = production.build([actual(1, 1)], [route(1)], [extra], today=date(2026, 10, 8))
        got = result["items"]["SAMPLE-A"]
        self.assertEqual((got["idx"], got["fc"], got["fn"]), ("ダンディ", "000001", "第一工場"))
        self.assertNotIn("x1c", got)

    def test_daily_labor_counts_all_steps_with_value_app_formula(self):
        routes = [route(1), route(2)]
        actuals = [
            actual(1, 3, **{"作業時間": "10", "人数": "2", "基準外工数/分": "5", "基準外人数/人": "1"}),
            actual(2, 3, **{"作業時間": "4", "人数": "1"}),
            actual(2, 2, **{"作業時間": "0", "人数": "1"}),
            actual(1, 1, work_area="外注先", **{"作業時間": "9", "人数": "1"}),
        ]
        result = production.build(actuals, routes, [item()], today=date(2026, 10, 8))
        self.assertEqual(result["daily_labor"], [
            {"d": "2026-09-10", "item": "SAMPLE-A", "factory": "第一工場", "ws": "第一工場 組立", "in": 24, "ex": 5, "z": 1},
        ])

    def test_daily_steps_list_every_internal_step_and_mark_completion(self):
        routes = [route(1), route(2)]
        actuals = [
            actual(1, 3, **{"作業時間": "10", "人数": "2"}),
            actual(2, 3, **{"作業時間": "4", "人数": "1", "基準外工数/分": "6", "基準外人数/人": "1"}),
            actual(1, 5, code="SAMPLE-B", **{"作業時間": "2", "人数": "1"}),
            actual(1, 1, work_area="外注先", **{"作業時間": "9", "人数": "1"}),
        ]
        result = production.build(actuals, routes, [item(), item("SAMPLE-B")], today=date(2026, 10, 8))
        self.assertEqual(result["daily_steps"], [
            {"d": "2026-09-10", "item": "SAMPLE-A", "s": "1", "p": "架空工程1", "factory": "第一工場", "ws": "第一工場 組立", "q": 3, "in": 20, "ex": 0},
            {"d": "2026-09-10", "item": "SAMPLE-A", "s": "2", "p": "架空工程2", "factory": "第一工場", "ws": "第一工場 組立", "q": 3, "in": 4, "ex": 6, "fin": 1},
            {"d": "2026-09-10", "item": "SAMPLE-B", "s": "1", "p": "", "factory": "第一工場", "ws": "第一工場 組立", "q": 5, "in": 2, "ex": 0},
        ])
        self.assertIn("SAMPLE-B", result["items"])

    def test_required_columns_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "報告数量"):
            production.require_columns(["伝票日付"], production.ACTUAL_REQUIRED, "actuals")

    def test_command_writes_only_explicit_protected_output(self):
        import csv

        def write_csv(path, rows):
            with path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
                writer.writeheader()
                writer.writerows(rows)

        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            actual_path, route_path, item_path, output = (base / name for name in (
                "actual.csv", "route.csv", "item.csv", "data/value_analysis_production_results.json",
            ))
            write_csv(actual_path, [actual(1, 2, day="20260901")])
            write_csv(route_path, [route(1)])
            write_csv(item_path, [item()])
            completed = subprocess.run(
                [sys.executable, str(ROOT / "scripts/build_value_analysis_production_results.py"),
                 "--actuals", str(actual_path), "--routes", str(route_path),
                 "--items", str(item_path), "--output", str(output)],
                check=True, capture_output=True, text=True,
            )
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["source"], "製造実績明細出力.csv")
            self.assertIn("items", payload)
            self.assertIn("rows", payload)
            self.assertNotIn("SAMPLE-A", completed.stdout)


if __name__ == "__main__":
    unittest.main()
