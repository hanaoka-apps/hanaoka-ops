"""scripts/build_fax_lookup.py のテスト（架空のデータだけを使う。知らせは送らない）。
実行: python -m unittest tests.test_build_fax_lookup"""
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_fax_lookup', ROOT / 'scripts/build_fax_lookup.py')
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)

HEAD = ['コード', '正式名', '正式名2', '略称', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', '電話', 'FAX', 'c12']


def row(code, name, abbr='', tel='', fax=''):
    return [code, name, '', abbr, '', '', '', '', '', '', tel, fax, 'x']


def write_csv(path, rows, enc='utf-8-sig'):
    import csv
    with open(path, 'w', encoding=enc, newline='') as f:
        csv.writer(f).writerows(rows)


class BuildFaxLookupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        os.environ['FAX_LOOKUP_LOG'] = os.path.join(self.dir, 'test.log')
        os.environ.pop(B.WEBHOOK_ENV, None)
        self.now = datetime.now(B.JST)
        self.cust = [HEAD] + [row('%06d' % i, '架空商事%d' % i, 'カクウ%d' % i, '000-0000-%04d' % i, '000-1111-%04d' % i) for i in range(1, 21)]
        self.supp = [HEAD] + [row('S%03d' % i, '見本工業%d' % i) for i in range(1, 11)]
        write_csv(os.path.join(self.dir, B.CUSTOMERS_CSV), self.cust)
        write_csv(os.path.join(self.dir, B.SUPPLIERS_CSV), self.supp, enc='cp932')

    def tearDown(self):
        self.tmp.cleanup()

    def out(self):
        return os.path.join(self.dir, B.OUTPUT_FILE)

    def test_format_is_exact(self):
        lk = B.build_lookup([HEAD, row('1', ' 架空 ', 'カ', 't', 'f'), row('2', '')], [HEAD, row('S', '見本')], self.now)
        raw = B.dump(lk).decode('utf-8')
        self.assertTrue(raw.startswith('{"relations":[{"c":"1","n":"架空","a":"カ","t":"t","f":"f","tp":"得意先"},'
                                       '{"c":"S","n":"見本","a":"","t":"","f":"","tp":"仕入先"}],"updated":"'))
        self.assertRegex(raw, r'"updated":"\d{4}-\d\d-\d\d \d\d:\d\d JST"}$')
        self.assertNotIn(' ', raw.split('"updated"')[0])   # 区切りに空白を入れない

    def test_short_rows_are_empty_strings(self):
        lk = B.build_lookup([HEAD, ['1', '名']], [HEAD], self.now)
        self.assertEqual(lk['relations'][0], {'c': '1', 'n': '名', 'a': '', 't': '', 'f': '', 'tp': '得意先'})

    def test_write_mode_writes_without_bom(self):
        self.assertEqual(B.run(self.dir, 'write', self.now), 0)
        raw = Path(self.out()).read_bytes()
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'))
        data = json.loads(raw.decode('utf-8'))
        self.assertEqual(B.count_by_type(data['relations']), {'得意先': 20, '仕入先': 10})
        self.assertFalse(os.path.exists(self.out() + '.tmp'))

    def test_compare_mode_does_not_write(self):
        self.assertEqual(B.run(self.dir, 'compare', self.now), 0)
        self.assertFalse(os.path.exists(self.out()))

    def test_compare_same_ignores_updated(self):
        B.run(self.dir, 'write', self.now)
        raw, cur = B.read_current(self.out())
        lk = B.build_lookup(self.cust, self.supp)
        lk['updated'] = '2000-01-01 00:00 JST'
        self.assertTrue(B.compare(lk, raw, cur)[0])
        lk['relations'][0]['t'] = 'changed'
        same, desc = B.compare(lk, raw, cur)
        self.assertFalse(same)
        self.assertIn('本番だけ 1 件', desc)

    def test_big_drop_stops_and_keeps_old_file(self):
        B.run(self.dir, 'write', self.now)
        before = Path(self.out()).read_bytes()
        write_csv(os.path.join(self.dir, B.CUSTOMERS_CSV), self.cust[:10])   # 20 → 9 件
        self.assertEqual(B.run(self.dir, 'write', self.now), 1)
        self.assertEqual(Path(self.out()).read_bytes(), before)

    def test_small_drop_is_ok(self):
        B.run(self.dir, 'write', self.now)
        write_csv(os.path.join(self.dir, B.CUSTOMERS_CSV), self.cust[:-1])   # 20 → 19 件（5%）
        self.assertEqual(B.run(self.dir, 'write', self.now), 0)

    def test_too_few_columns_stops(self):
        write_csv(os.path.join(self.dir, B.SUPPLIERS_CSV), [HEAD[:5], ['S', '見本']])
        self.assertEqual(B.run(self.dir, 'write', self.now), 1)
        self.assertFalse(os.path.exists(self.out()))

    def test_missing_csv_stops(self):
        os.remove(os.path.join(self.dir, B.SUPPLIERS_CSV))
        self.assertEqual(B.run(self.dir, 'write', self.now), 1)

    def test_stale_csv_is_reported_but_built(self):
        old = self.now.timestamp() - 3 * 86400
        os.utime(os.path.join(self.dir, B.SUPPLIERS_CSV), (old, old))
        self.assertEqual([n for n, _ in B.stale_files([os.path.join(self.dir, B.SUPPLIERS_CSV)], self.now)], [B.SUPPLIERS_CSV])
        self.assertEqual(B.run(self.dir, 'write', self.now), 0)
        self.assertTrue(os.path.exists(self.out()))
        self.assertIn('今日の分でない', Path(os.environ['FAX_LOOKUP_LOG']).read_text(encoding='utf-8'))

    def test_log_has_no_names(self):
        B.run(self.dir, 'write', self.now)
        B.run(self.dir, 'compare', self.now)
        log = Path(os.environ['FAX_LOOKUP_LOG']).read_text(encoding='utf-8')
        self.assertNotIn('架空商事', log)
        self.assertNotIn('000-0000', log)


if __name__ == '__main__':
    unittest.main()
