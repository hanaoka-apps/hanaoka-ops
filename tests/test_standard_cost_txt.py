import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import import_standard_cost_snapshots as importer  # noqa: E402

HEADER = ["コード", "品目名", "コード", "原価集計部門名", "在庫評価単価", "変動率", "材料費", "労務費", "外注費", "経費",
          "自品目原価計", "積上材料費", "積上労務費", "積上外注費", "積上経費", "積上原価計", "エラー"]


def lines(rows):
    return "\r\n".join("\t".join(r) for r in rows) + "\r\n"


class StandardCostTxtTests(unittest.TestCase):
    def rows(self):
        blank = [""] * 16
        return [["品目別積上原価一覧表"] + blank, ["対象年月：2026年 9月度"] + blank, HEADER,
                ["SAMPLE-A", "架空品目", "", "", "100", "0", "10", "0", "0", "0", "10", "60", "0", "0", "0", "60", ""]]

    def check(self, data: bytes):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "standard_cost_202609.txt"
            path.write_bytes(data)
            ym, costs, *_ = importer.parse(path)
        self.assertEqual(ym, "202609")
        self.assertIn("SAMPLE-A", costs)

    def test_excel_unicode_text_utf16_tab(self):
        self.check(lines(self.rows()).encode("utf-16"))

    def test_utf8_and_cp932_tab(self):
        self.check(lines(self.rows()).encode("utf-8-sig"))
        self.check(lines(self.rows()).encode("cp932"))


if __name__ == "__main__":
    unittest.main()
