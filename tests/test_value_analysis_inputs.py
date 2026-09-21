from __future__ import annotations

import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


PURCHASES = load_module("merge_value_analysis_purchases", "merge_value_analysis_purchases.py")
SALES = load_module("merge_value_analysis_sales", "merge_value_analysis_sales.py")
INVENTORY = load_module("merge_value_analysis_inventory", "merge_value_analysis_inventory.py")
CLOSE_STATUS = load_module("set_value_analysis_close_status", "set_value_analysis_close_status.py")
CONFIRMED_HISTORY = load_module("merge_value_analysis_confirmed_history", "merge_value_analysis_confirmed_history.py")


def base_payload() -> dict:
    blank = INVENTORY.blank_summary
    return {
        "months": ["202607", "202608"],
        "zones": INVENTORY.ZONES,
        "monthly": {
            ym: {
                "zones": {zone: blank() for zone in INVENTORY.ZONES},
                "total": blank(),
            }
            for ym in ("202607", "202608")
        },
        "month_status": {},
        "meta": {},
    }


class PurchaseMergeTest(unittest.TestCase):
    def test_only_purchase_category_is_included(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "受入明細出力.csv"
            destination = Path(directory) / "value_analysis.json"
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["伝票日付", "受入金額", "取引区分属性名", "工場別付加価名"],
                )
                writer.writeheader()
                writer.writerow({"伝票日付": "20260801", "受入金額": "10,000", "取引区分属性名": "仕入", "工場別付加価名": "第一工場"})
                writer.writerow({"伝票日付": "20260802", "受入金額": "99,000", "取引区分属性名": "経費", "工場別付加価名": "第一工場"})
            destination.write_text(json.dumps(base_payload(), ensure_ascii=False), encoding="utf-8")

            PURCHASES.merge(source, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))

            self.assertEqual(result["monthly"]["202608"]["total"]["purchase"], 10000)
            self.assertEqual(result["monthly"]["202608"]["zones"]["第一工場"]["purchase"], 10000)
            self.assertEqual(result["meta"]["daily_purchase_import"]["excluded_non_purchase_rows"], 1)

    def test_finalized_month_is_not_replaced_by_daily_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "受入明細出力.csv"
            destination = Path(directory) / "value_analysis.json"
            payload = base_payload()
            payload["finalized_months"] = ["202608"]
            payload["monthly"]["202608"]["total"]["purchase"] = 12345
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["伝票日付", "受入金額", "取引区分属性名"])
                writer.writeheader()
                writer.writerow({"伝票日付": "20260801", "受入金額": "99,000", "取引区分属性名": "仕入"})

            PURCHASES.merge(source, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))

            self.assertEqual(result["monthly"]["202608"]["total"]["purchase"], 12345)
            self.assertEqual(result["meta"]["daily_purchase_import"]["skipped_finalized_months"], 1)

    def test_blank_receipt_zone_is_completed_from_item_master(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "受入明細出力.csv"
            master = Path(directory) / "品目マスタ.csv"
            destination = Path(directory) / "value_analysis.json"
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["伝票日付", "受入金額", "取引区分属性名", "品目ｺｰﾄﾞ", "工場別付加価名"])
                writer.writeheader()
                writer.writerow({"伝票日付": "20260901", "受入金額": "12,000", "取引区分属性名": "仕入", "品目ｺｰﾄﾞ": "A-01", "工場別付加価名": ""})
            with master.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["品目ｺｰﾄﾞ", "工場別付加価名"])
                writer.writeheader()
                writer.writerow({"品目ｺｰﾄﾞ": "A-01", "工場別付加価名": "第二工場"})
            payload = base_payload()
            payload["months"].append("202609")
            payload["monthly"]["202609"] = {"zones": {zone: INVENTORY.blank_summary() for zone in INVENTORY.ZONES}, "total": INVENTORY.blank_summary()}
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            PURCHASES.merge(source, destination, master)
            result = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(result["monthly"]["202609"]["zones"]["第二工場"]["purchase"], 12000)
            self.assertEqual(result["meta"]["daily_purchase_import"]["master_zone_rows"], 1)

    def test_unclassified_purchase_is_kept_for_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "受入明細出力.csv"
            destination = Path(directory) / "value_analysis.json"
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["伝票日付", "受入金額", "取引区分属性名"])
                writer.writeheader(); writer.writerow({"伝票日付": "20260901", "受入金額": "123", "取引区分属性名": "仕入"})
            payload = base_payload(); payload["months"].append("202609"); payload["monthly"]["202609"] = {"zones": {zone: INVENTORY.blank_summary() for zone in INVENTORY.ZONES}, "total": INVENTORY.blank_summary()}
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            PURCHASES.merge(source, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(result["purchase_unclassified_by_month"]["202609"], 123)

    def test_uses_department_when_primary_factory_column_is_blank(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "受入明細出力.csv"
            destination = Path(directory) / "value_analysis.json"
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["伝票日付", "受入金額", "取引区分属性名", "工場別付加価名", "部門名"],
                )
                writer.writeheader()
                writer.writerow({"伝票日付": "20260901", "受入金額": "12,000", "取引区分属性名": "仕入", "工場別付加価名": "", "部門名": "第二工場"})
            payload = base_payload()
            payload["months"].append("202609")
            payload["monthly"]["202609"] = {"zones": {zone: INVENTORY.blank_summary() for zone in INVENTORY.ZONES}, "total": INVENTORY.blank_summary()}
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            PURCHASES.merge(source, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))
            self.assertEqual(result["monthly"]["202609"]["zones"]["第二工場"]["purchase"], 12000)


class SalesMergeTest(unittest.TestCase):
    def test_sales_breakdown_uses_sales_division_column(self):
        fact = [""] * 24
        fact[0], fact[18], fact[19], fact[20], fact[21], fact[22], fact[23] = "202608", "A-01", "品目A", 1, 10000, 10000, 1
        fact[15] = "国内営業部"
        self.assertEqual(SALES.IDX["sales_division"], 15)
        # 15列目が営業別分類であることを、変換処理の入力定義として固定する。
        self.assertEqual(fact[SALES.IDX["sales_division"]], "国内営業部")

    def test_item_names_and_lowest_sale_are_taken_from_required_rows(self):
        """正式名・主要伝票名・最低売価伝票が別集計にならないことを確認する。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            facts_path = root / "dashboard_facts.json"
            destination = root / "value_analysis.json"
            master = root / "品目マスタ.csv"
            fact_a = [""] * 34
            fact_a[0], fact_a[3], fact_a[7], fact_a[15] = "202609", "得意先A", "20260905", "国内営業部"
            fact_a[18], fact_a[19], fact_a[20], fact_a[21], fact_a[22], fact_a[23] = "A-01", "伝票A", 2, 100, 50, 1
            fact_a[27], fact_a[28], fact_a[29], fact_a[33] = "U-002", "摘要A1", "摘要A2", 2
            fact_b = list(fact_a)
            fact_b[7], fact_b[19], fact_b[20], fact_b[21], fact_b[22], fact_b[27], fact_b[28], fact_b[29], fact_b[33] = "20260904", "伝票B", 3, 300, 100, "U-001", "摘要B1", "摘要B2", 1
            facts_path.write_text(json.dumps({"rows": [fact_a, fact_b]}, ensure_ascii=False), encoding="utf-8")
            payload = base_payload()
            payload["months"].append("202609")
            payload["monthly"]["202609"] = {"zones": {zone: INVENTORY.blank_summary() for zone in INVENTORY.ZONES}, "total": INVENTORY.blank_summary()}
            payload["item_analysis"] = {
                "items": {"A-01": {}}, "rows": [], "months": [],
                "standard_cost_history": {"202609": {"A-01": {"total": 40, "material": 20}}},
            }
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with master.open("w", encoding="utf-8-sig", newline="") as handle:
                # 実データで使われる全角「品目コード」表記でも、品目マスタ名を読む。
                writer = csv.DictWriter(handle, fieldnames=["品目コード", "品目名", "工場別付加価名"])
                writer.writeheader(); writer.writerow({"品目コード": "A-01", "品目名": "正式品目A", "工場別付加価名": "第一工場"})

            old_data, old_facts, old_destination = SALES.DATA, SALES.FACTS, SALES.DESTINATION
            try:
                SALES.DATA, SALES.FACTS, SALES.DESTINATION = root, facts_path, destination
                self.assertEqual(SALES.main(), 0)
            finally:
                SALES.DATA, SALES.FACTS, SALES.DESTINATION = old_data, old_facts, old_destination

            result = json.loads(destination.read_text(encoding="utf-8"))
            item = result["item_analysis"]["items"]["A-01"]
            detail = result["item_analysis"]["rows"][0]
            lowest = result["item_analysis"]["lowest_sales"]["202609:A-01"]
            self.assertEqual(item["n"], "正式品目A")
            self.assertEqual(item["master_name"], "正式品目A")
            self.assertEqual(detail["pv"], "伝票B")
            self.assertEqual(detail["pn"], "伝票B＋他")
            self.assertEqual(lowest, {
                "unit_price": 50.0, "customer": "得意先A", "date": "20260905", "sales_no": "U-002",
                "quantity": 2.0, "amount": 100.0, "item_name": "伝票A",
                "remark1": "摘要A1", "remark2": "摘要A2", "source_index": 2,
            })

    def test_lead_time_uses_only_one_to_one_order_item_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = {
                "売上明細出力.csv": (["伝票日付", "受注№", "品目ｺｰﾄﾞ", "明細区分", "返品区分"], [["20260904", "O-1", "A-01", "0", "0"]]),
                "受注明細出力.csv": (["受注日付", "受注№", "品目ｺｰﾄﾞ", "完納区分名"], [["20260901", "O-1", "A-01", ""]]),
                "品目手順マスタ.csv": (["品目ｺｰﾄﾞ", "工程ﾘｰﾄﾞﾀｲﾑ", "検査ﾘｰﾄﾞﾀｲﾑ"], [["A-01", "2", "1"]]),
            }
            for name, (header, rows) in sources.items():
                with (root / name).open("w", encoding="utf-8-sig", newline="") as handle:
                    writer = csv.writer(handle); writer.writerow(header); writer.writerows(rows)
            old_data = SALES.DATA
            try:
                SALES.DATA = root
                result = SALES.calculate_lead_time()
            finally:
                SALES.DATA = old_data
            self.assertEqual(result["status"], "available")
            self.assertEqual(result["months"]["202609"], {
                "count": 1, "actual_average": 3, "actual_median": 3,
                "actual_min": 3, "actual_max": 3, "standard_average": 3,
                "difference_average": 0,
            })


class InventoryMergeTest(unittest.TestCase):
    def test_confirmed_rows_only_and_previous_month_link(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "inventory_manual.csv"
            destination = Path(directory) / "value_analysis.json"
            payload = base_payload()
            payload["monthly"]["202607"]["total"]["current_inventory"] = 300
            payload["monthly"]["202607"]["zones"]["第一工場"]["current_inventory"] = 300
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=INVENTORY.REQUIRED)
                writer.writeheader()
                writer.writerow({"ym": "202608", "factory": "第一工場", "amount": "500", "note": "確定", "status": "confirmed", "source_type": "manual"})
                writer.writerow({"ym": "202608", "factory": "第二工場", "amount": "999", "note": "下書き", "status": "draft", "source_type": "manual"})

            INVENTORY.merge(source, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))

            self.assertEqual(result["monthly"]["202608"]["total"]["current_inventory"], 500)
            self.assertEqual(result["monthly"]["202608"]["total"]["previous_inventory"], 300)
            self.assertEqual(result["monthly"]["202608"]["zones"]["第一工場"]["current_inventory"], 500)
            self.assertIsNone(result["monthly"]["202608"]["zones"]["第二工場"]["current_inventory"])
            self.assertEqual(result["meta"]["inventory_input_import"]["draft_rows"], 1)


class CloseStatusTest(unittest.TestCase):
    def test_finalize_through_comes_from_input_and_keeps_future_month_open(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "value_analysis.json"
            payload = base_payload()
            payload["months"].append("202609")
            payload["monthly"]["202609"] = {
                "zones": {zone: INVENTORY.blank_summary() for zone in INVENTORY.ZONES},
                "total": INVENTORY.blank_summary(),
            }
            payload["month_status"]["202609"] = {"state": "collecting", "is_finalized": False}
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            finalized = CLOSE_STATUS.apply_close_status(destination, "202608")
            result = json.loads(destination.read_text(encoding="utf-8"))

            self.assertEqual(finalized, ["202607", "202608"])
            self.assertTrue(result["month_status"]["202608"]["is_finalized"])
            self.assertFalse(result["month_status"]["202609"]["is_finalized"])
            self.assertNotIn("202609", result["finalized_months"])
            self.assertEqual(result["meta"]["monthly_close_control"]["finalize_through"], "202608")


class ConfirmedHistoryMergeTest(unittest.TestCase):
    def test_protected_history_recalculates_and_marks_month_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "value_analysis.json"
            payload = base_payload()
            payload["monthly"]["202608"]["total"]["sales"] = 1000
            payload["monthly"]["202608"]["zones"]["第一工場"]["sales"] = 600
            destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            protected = {
                "months": {
                    "202608": {
                        "purchase": 400,
                        "previous_inventory": 200,
                        "current_inventory": 250,
                        "zones": {
                            "第一工場": {
                                "purchase": 240,
                                "previous_inventory": 120,
                                "current_inventory": 150,
                            }
                        },
                    }
                }
            }

            CONFIRMED_HISTORY.merge_history(protected, destination)
            result = json.loads(destination.read_text(encoding="utf-8"))

            self.assertEqual(result["monthly"]["202608"]["total"]["value_added"], 650)
            self.assertEqual(result["monthly"]["202608"]["zones"]["第一工場"]["value_added"], 390)
            self.assertTrue(result["month_status"]["202608"]["purchase_confirmed"])
            self.assertTrue(result["month_status"]["202608"]["inventory_confirmed"])
            self.assertIn("202608", result["finalized_months"])


if __name__ == "__main__":
    unittest.main()
