"""scripts/build_ec_index.py のテスト。小さな架空の CSV で ec_smile_index.json ができることを確かめる。
実行: python -m unittest tests.test_build_ec_index  （または python tests/test_build_ec_index.py）"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_ec_index', ROOT / 'scripts/build_ec_index.py')
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)

JUCHU_HEAD = ['受注日付', '受注№', '行', '得意先ｺｰﾄﾞ', '納品先ｺｰﾄﾞ', '納品先名', '品目ｺｰﾄﾞ', '品目名', '数量', '単価', '金額',
              '納期', '出荷予定日', '客先注番', '社内メモ', '操作日付', '手配区分', '製造数量', '製番']


def juchu_row(no, line, cust, po, memo='花岡EC', code='FCART2x4BK'):
    return ['20261015', no, str(line), cust, '000001', 'テスト様', code, '品目名', '1.00', '14000.00', '14000',
            '20261019', '20261019', po, memo, '20261015', '1', '1.00', 'SB' + no]


def tsv(rows, quote_all=False):
    def cell(c):
        c = str(c)
        if quote_all or '\n' in c or '\t' in c or '"' in c:
            return '"' + c.replace('"', '""') + '"'
        return c
    return '\r\n'.join('\t'.join(cell(c) for c in r) for r in rows) + '\r\n'


class BuildEcIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, text, enc='utf-8-sig'):
        with open(os.path.join(self.dir, name), 'w', encoding=enc, newline='') as f:
            f.write(text)

    def write_all(self, juchu_enc='utf-8-sig'):
        self.write('受注明細出力.csv', tsv([JUCHU_HEAD,
                                         juchu_row('90001', 1, '599802', '1801'),
                                         juchu_row('90001', 2, '599802', '1801', code='FR'),
                                         juchu_row('80001', 1, '000123', '9999'),            # EC 以外
                                         juchu_row('90002', 1, '599801', '1802', memo='メモ\n改行あり')], quote_all=True), juchu_enc)
        self.write('納品先マスタ.csv', '得意先ｺｰﾄﾞ,納品先ｺｰﾄﾞ,納品先名,納品先索引,荷受け人名１,荷受け人名２,郵便番号,住所１,住所２,住所３,電話番号\r\n'
                   '599802,000001,既存様,,,,100-0001,東京都,,,03-0000-0000\r\n'
                   '599802,000770,新規様,,担当様,,100-0002,東京都,"千代田,1-1",,03-1111-2222\r\n'
                   '000123,000009,他社,,,,,,,,\r\n')
        self.write('品目マスタ.csv', '品目ｺｰﾄﾞ,品目名,単位,初期表示用手配区分\r\nFCART2x4BK,FCART2x4 Black,台,1\r\nFR,ｳﾝﾁﾝ,式,2\r\n')
        self.write('入金明細出力.csv', '伝票日付,得意先ｺｰﾄﾞ,入金額,備考\r\n20261009,599802,32900,SHOPIFY\r\n20261009,000123,1,他社\r\n')

    def run_build(self, **kw):
        with redirect_stdout(io.StringIO()) as out:
            res = B.build(self.dir, ['599801', '599802'], **kw)
        return res, out.getvalue()

    def read_index(self):
        with open(os.path.join(self.dir, 'ec_smile_index.json'), encoding='utf-8') as f:
            return json.load(f)

    def test_EC得意先の行だけが入る(self):
        self.write_all()
        self.run_build()
        idx = self.read_index()
        self.assertEqual(idx['customers'], ['599801', '599802'])
        cols = idx['orders']['cols']
        self.assertIn('客先注番', cols)
        rows = [dict(zip(cols, r)) for r in idx['orders']['rows']]
        self.assertEqual([r['客先注番'] for r in rows], ['1801', '1801', '1802'])
        self.assertEqual(rows[0]['受注№'], '90001')
        self.assertEqual(rows[2]['社内メモ'], 'メモ\n改行あり')          # クォート内の改行も1つの値
        self.assertNotIn('製番', cols)                                   # 必要な列だけ
        self.assertEqual(len(idx['nouhin']['rows']), 2)
        self.assertEqual(idx['nouhin']['maxCode'], {'599802': '000770'})
        self.assertEqual(dict(zip(idx['nouhin']['cols'], idx['nouhin']['rows'][1]))['住所２'], '千代田,1-1')
        self.assertEqual(len(idx['items']['rows']), 2)
        self.assertEqual(idx['nyukin']['rows'], [['20261009', '599802', '32900', 'SHOPIFY']])

    def test_generatedAtと元ファイルの更新日時(self):
        self.write_all()
        now = datetime(2026, 10, 20, 1, 10, 5, tzinfo=timezone.utc)
        self.run_build(now=now)
        idx = self.read_index()
        self.assertEqual(idx['generatedAt'], '2026-10-20T01:10:05Z')
        names = [s['name'] for s in idx['sources']]
        self.assertEqual(names, ['受注明細出力.csv', '納品先マスタ.csv', '品目マスタ.csv', '入金明細出力.csv'])
        self.assertTrue(all(s['modified'].endswith('Z') and s['rows'] > 0 for s in idx['sources']))
        self.assertEqual(idx['sources'][0]['rows'], 4)                  # 元ファイルの全行数（EC 以外も数える）

    def test_ShiftJISでも読める(self):
        self.write_all(juchu_enc='cp932')
        self.run_build()
        idx = self.read_index()
        self.assertEqual(len(idx['orders']['rows']), 3)
        self.assertEqual(dict(zip(idx['orders']['cols'], idx['orders']['rows'][0]))['納品先名'], 'テスト様')

    def test_カンマ区切りでも読める(self):
        self.write_all()
        self.write('受注明細出力.csv', ','.join(JUCHU_HEAD) + '\r\n' + ','.join(juchu_row('90001', 1, '599802', '1801')) + '\r\n')
        self.run_build()
        self.assertEqual(len(self.read_index()['orders']['rows']), 1)

    def test_入金明細が無くても作れる(self):
        self.write_all()
        os.remove(os.path.join(self.dir, '入金明細出力.csv'))
        self.run_build()
        self.assertEqual(self.read_index()['nyukin']['rows'], [])

    def test_失敗したら前回のファイルが残る(self):
        self.write_all()
        self.run_build()
        path = os.path.join(self.dir, 'ec_smile_index.json')
        before = Path(path).read_bytes()
        self.write('受注明細出力.csv', '別の形式\r\nabc\r\n')           # 必須の列が無い（書き出し途中・別ファイル）
        with self.assertRaises(ValueError):
            self.run_build()
        self.assertEqual(Path(path).read_bytes(), before)
        self.assertFalse(os.path.exists(path + '.tmp'))
        self.write_all()
        os.remove(os.path.join(self.dir, '品目マスタ.csv'))
        with self.assertRaises(FileNotFoundError):
            self.run_build()
        self.assertEqual(Path(path).read_bytes(), before)

    def test_main_終了コード(self):
        self.write_all()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(['--dir', self.dir]), 0)
            os.remove(os.path.join(self.dir, '品目マスタ.csv'))
            self.assertEqual(B.main(['--dir', self.dir]), 1)
            self.assertEqual(B.main(['--dir', self.dir, '--customers', '']), 1)

    def test_ログに個人情報を出さない(self):
        self.write_all()
        _, out = self.run_build()
        for word in ['テスト様', '新規様', '千代田', '03-1111', '1801']:
            self.assertNotIn(word, out)
        self.write('受注明細出力.csv', '別の形式\r\nテスト様\r\n')
        with redirect_stdout(io.StringIO()) as o2:
            B.main(['--dir', self.dir])
        self.assertNotIn('テスト様', o2.getvalue())


if __name__ == '__main__':
    unittest.main()
