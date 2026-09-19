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
INVENTORY = load_module("merge_value_analysis_inventory", "merge_value_analysis_inventory.py")
CLOSE_STATUS = load_module("set_value_analysis_close_status", "set_value_analysis_close_status.py")


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


if __name__ == "__main__":
    unittest.main()
