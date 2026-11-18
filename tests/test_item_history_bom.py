"""build_item_history の構成マスタ読込の回帰テスト (2026-11-18 取数倍率バグ)。

SMILE構成マスタ出力は同一(親,子)を何十行も重複して含む。
旧実装は重複行の取数を加算していたため、完成13台 × 取数1 が 299 (=13×23) になっていた。
"""
import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_item_history", ROOT / "scripts" / "build_item_history.py")


def load_module():
    mod = importlib.util.module_from_spec(SPEC)
    sys.modules["build_item_history"] = mod
    SPEC.loader.exec_module(mod)
    return mod


BOM_HEADER = ["親品目ｺｰﾄﾞ", "子品目ｺｰﾄﾞ", "取数(分子)", "取数(分母)", "使用禁止日", "製番", "ﾀﾞﾐｰ構成区分", "展開ｽﾄｯﾌﾟ区分"]


class BomLoadTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.mod.SHARED = Path(self.tmp.name)
        self.mod._BOM_CACHE = None
        rows = []
        # 親P → 子C 取数1 を23行重複 (旧実装では取数23になっていた)
        rows += [["P", "C", "1", "1", "", "", "0", "0"]] * 23
        # 分母あり: 取数 1/2
        rows += [["P", "H", "1", "2", "", "", "0", "0"]] * 3
        # 製番別構成: 通常構成には混ぜない
        rows += [["P", "S", "5", "1", "", "J26060017400", "0", "0"]]
        # ダミー構成 / 展開ストップ / 使用禁止済み は除外
        rows += [["P", "D", "1", "1", "", "", "1", "0"]]
        rows += [["P", "T", "1", "1", "", "", "0", "1"]]
        rows += [["P", "X", "1", "1", "20000101", "", "0", "0"]]
        with open(self.mod.SHARED / "構成マスタ.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(BOM_HEADER)
            w.writerows(rows)
        with open(self.mod.SHARED / "製造指図出力.csv", "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            w.writerow(["手配日付", "品目ｺｰﾄﾞ", "報告済数量", "製番", "手配№", "工程名"])
            d = self.mod.TODAY.strftime("%Y/%m/%d")
            w.writerow([d, "P", "13", "M0038921", "10455", "組立"])

    def tearDown(self):
        self.tmp.cleanup()

    def test_duplicates_are_not_summed(self):
        bom = dict(self.mod._load_bom_default()["P"])
        self.assertEqual(bom["C"], 1.0)
        self.assertEqual(bom["H"], 0.5)
        for excluded in ("S", "D", "T", "X"):
            self.assertNotIn(excluded, bom)

    def test_consumption_is_completed_qty_times_qty_per(self):
        cons = self.mod.load_consumption()
        self.assertEqual(cons["C"][0]["qty"], 13)  # 旧実装では 299
        self.assertEqual(cons["C"][0]["qty_per"], 1.0)
        self.assertEqual(cons["H"][0]["qty"], 6.5)


if __name__ == "__main__":
    unittest.main()
