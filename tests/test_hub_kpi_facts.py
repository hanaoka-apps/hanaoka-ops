from __future__ import annotations

import importlib.util
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_regenerate_facts():
    # 読み込むだけなら認証情報も requests も要らないので、ダミーで埋めておく
    for key in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"):
        os.environ.setdefault(key, "dummy")
    sys.modules.setdefault("requests", types.ModuleType("requests"))
    spec = importlib.util.spec_from_file_location("regenerate_facts", ROOT / "scripts" / "regenerate_facts.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


RF = load_regenerate_facts()
JST = timezone(timedelta(hours=9))


def sales_row(ym, voucher, amount=1000):
    # transform_sales と同じ35列。HUBが使わない列にも値を入れて、落ちることを確かめる
    r = [f"col{i}" for i in range(35)]
    r[0], r[7], r[14], r[15], r[19] = ym, voucher, "国内営業部", "国内営業部", "品目"
    r[20], r[21], r[22], r[23] = 1.0, float(amount), float(amount), 1
    return r


def order_row(ym, voucher, kikou, amount=1000):
    r = sales_row(ym, voucher, amount)[:27]
    r.append(kikou)
    return r


class DateYmTest(unittest.TestCase):
    def test_variants(self):
        self.assertEqual(RF.date_ym("26/09/03"), 202609)
        self.assertEqual(RF.date_ym("2026/9/3"), 202609)
        self.assertEqual(RF.date_ym("2026-09-03"), 202609)
        self.assertEqual(RF.date_ym("20260903"), 202609)
        self.assertEqual(RF.date_ym(""), 0)
        self.assertEqual(RF.date_ym(None), 0)


class BuildHubKpiFactsTest(unittest.TestCase):
    build = datetime(2026, 10, 4, 6, 0, tzinfo=JST)

    def test_keeps_only_recent_rows(self):
        rows = [
            sales_row(202607, "2026/07/31"),  # 窓の外
            sales_row(202608, "2026/08/01"),  # 年月度が窓の中
            sales_row(202610, "2026/10/02"),
        ]
        orders = [
            order_row(202605, "2026/05/10", "2026/06/01"),  # 全部窓の外
            order_row(202605, "2026/05/10", "2026/09/15"),  # 納期だけ窓の中
            order_row(202607, "2026/08/20", ""),            # 受注日付だけ窓の中
        ]
        hub = RF.build_hub_kpi_facts(rows, orders, {"国内営業部": {"202610": 1}}, self.build)
        self.assertEqual(hub["build_meta"]["window_start_ym"], 202608)
        self.assertEqual([r[0] for r in hub["rows"]], [202608, 202610])
        self.assertEqual([r[27] for r in hub["order_rows"]], ["2026/09/15", ""])
        self.assertEqual(hub["dept_monthly_targets"], {"国内営業部": {"202610": 1}})

    def test_slims_columns_but_keeps_positions(self):
        hub = RF.build_hub_kpi_facts([sales_row(202610, "2026/10/02", 500)], [], {}, self.build)
        row = hub["rows"][0]
        self.assertEqual(len(row), RF.HUB_ROW_LEN)
        for i in range(RF.HUB_ROW_LEN):
            if i in RF.HUB_KEEP_COLS:
                self.assertIsNotNone(row[i], i)
            else:
                self.assertIsNone(row[i], i)
        self.assertEqual(row[21], 500.0)

    def test_window_wraps_year(self):
        hub = RF.build_hub_kpi_facts([], [], {}, datetime(2027, 1, 10, tzinfo=JST))
        self.assertEqual(hub["build_meta"]["window_start_ym"], 202611)


if __name__ == "__main__":
    unittest.main()
