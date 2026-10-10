import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import merge_value_analysis_sales as sales  # noqa: E402


def fact(ym, day, code, amount, *, kind=0, kikou="", qty=1, price=100, name="架空品"):
    row = [""] * 28
    row[0], row[7], row[16], row[18], row[19] = ym, day, "架空大分類", code, name
    row[20], row[21], row[22], row[23], row[27] = qty, amount, price, kind, kikou
    return row


class OrderSalesDailyTests(unittest.TestCase):
    def setUp(self):
        self.master = {"A": {"factory": "第一工場", "d": "架空大分類"}, "B": {"factory": "第二工場", "d": "架空大分類"}}

    def test_daily_sales_and_orders_by_due_month_follow_hub_exclusions(self):
        facts = {
            "rows": [
                fact("202610", "2026/10/01", "A", 1000),
                fact("202610", "2026/10/02", "B", 500),
                fact("202610", "2026/10/02", "A", -300, kind=2),          # 返品は除外
                fact("202610", "2026/10/02", "A", 50, name="消費税"),      # 消費税は除外
            ],
            "order_rows": [
                fact("202609", "2026/09/28", "A", 2000, kikou="20261015"),  # 納期10月
                fact("202610", "2026/10/01", "B", 700, kikou="2026/10/20"),
                fact("202610", "2026/10/01", "B", 900, kikou="20261105"),   # 納期11月
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            sales.ORDER_DETAIL = Path(tmp) / "none.csv"
            result = sales.build_order_sales_daily(facts, self.master, "2026-10-09")
        october = result["months"]["202610"]
        self.assertEqual(october["sales"], {"2026-10-01": {"第一工場": 1000}, "2026-10-02": {"第二工場": 500}})
        self.assertEqual(october["orders"], {"2026-09-28": {"第一工場": 2000}, "2026-10-01": {"第二工場": 700}})
        self.assertNotIn("202611", result["months"])
        self.assertEqual(result["backlog"]["status"], "missing")

    def test_backlog_uses_open_lines_due_this_month_or_later(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "orders.csv"
            path.write_text(
                "納期,品目ｺｰﾄﾞ,完納区分名,受注残金額\n"
                "20261020,A,,1500\n"
                "20261025,A,完納,800\n"
                "20260920,B,,400\n"
                "20261101,B,,300\n", encoding="utf-8-sig")
            sales.ORDER_DETAIL = path
            result = sales.build_order_sales_daily({"rows": [], "order_rows": []}, self.master, "2026-10-09")
        self.assertEqual(result["backlog"]["by_month"], {"202610": {"第一工場": 1500}, "202611": {"第二工場": 300}})
        self.assertEqual(result["backlog"]["as_of"], "2026-10-09")


if __name__ == "__main__":
    unittest.main()
