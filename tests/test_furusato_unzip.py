"""scripts/furusato_unzip.py のテスト（ダミーのパスワード・ダミーのCSV。実データは使わない）。
実行: python -m unittest tests.test_furusato_unzip"""
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import types
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pyzipper

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('furusato_unzip', ROOT / 'scripts/furusato_unzip.py')
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)

WORD = 'dummyword'
CONF = {'inboxDir': '_furusato_inbox', 'dateFormats': ['%Y%m%d'], 'dateWindowDays': 1, 'keepDays': 30}


def make_zip(path, password, members):
    with pyzipper.AESZipFile(path, 'w', compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as z:
        z.setpassword(password.encode())
        for n, data in members.items():
            z.writestr(n, data)


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.shared = Path(self.tmp.name)
        self.inbox = self.shared / CONF['inboxDir']; self.inbox.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_it(self):
        with redirect_stdout(io.StringIO()):
            return F.run(self.shared, WORD, CONF)

    def test_candidates_order_and_window(self):
        c = F.candidate_passwords(WORD, date(2026, 10, 30), ['%Y%m%d'], 1)
        self.assertEqual(c, [WORD + '20261030', WORD + '20261029', WORD + '20261031'])
        self.assertEqual(len(F.candidate_passwords(WORD, date(2026, 10, 30), ['%Y%m%d', '%Y-%m-%d'], 0)), 2)

    def test_received_date_from_name_then_mtime(self):
        p = self.inbox / '20261030_093000_x.zip'; p.write_bytes(b'')
        self.assertEqual(F.received_date(p), date(2026, 10, 30))
        q = self.inbox / 'noname.zip'; q.write_bytes(b'')
        os.utime(q, (time.time(), time.time()))
        self.assertIsInstance(F.received_date(q), date)

    def test_extracts_with_received_day_and_moves_zip(self):
        make_zip(self.inbox / '20261030_a.zip', WORD + '20261030', {'order.csv': 'a,b\n1,2\n', 'readme.txt': 'x'})
        self.assertEqual(self.run_it(), 0)
        self.assertEqual((self.inbox / 'csv' / '20261030_a' / 'order.csv').read_text(), 'a,b\n1,2\n')
        self.assertFalse((self.inbox / 'csv' / '20261030_a' / 'readme.txt').exists())   # CSV だけ
        self.assertTrue((self.inbox / 'done' / '20261030_a.zip').exists())
        self.assertFalse((self.inbox / '20261030_a.zip').exists())

    def test_neighbor_day_is_tried(self):
        make_zip(self.inbox / '20261030_a.zip', WORD + '20261029', {'o.csv': 'x'})
        self.assertEqual(self.run_it(), 0)
        self.assertTrue((self.inbox / 'csv' / '20261030_a' / 'o.csv').exists())

    def test_wrong_password_goes_to_failed_and_log_has_no_secret(self):
        make_zip(self.inbox / '20261030_a.zip', 'otherword20261030', {'o.csv': 'x'})
        self.assertEqual(self.run_it(), 1)
        self.assertTrue((self.inbox / 'failed' / '20261030_a.zip').exists())
        self.assertFalse((self.inbox / 'csv').exists())
        log = (self.shared / '_rpa_queue' / 'logs' / F.LOG_NAME).read_text(encoding='utf-8')
        self.assertIn('失敗', log); self.assertNotIn(WORD, log); self.assertNotIn('otherword', log)

    def test_path_traversal_is_flattened(self):
        make_zip(self.inbox / '20261030_a.zip', WORD + '20261030', {'../evil.csv': 'x', 'sub/ok.csv': 'y'})
        self.assertEqual(self.run_it(), 0)
        self.assertFalse((self.inbox.parent / 'evil.csv').exists())
        self.assertTrue((self.inbox / 'csv' / '20261030_a' / 'evil.csv').exists())
        self.assertTrue((self.inbox / 'csv' / '20261030_a' / 'ok.csv').exists())

    def test_zip_without_csv_fails(self):
        make_zip(self.inbox / '20261030_a.zip', WORD + '20261030', {'a.txt': 'x'})
        self.assertEqual(self.run_it(), 1)

    def test_empty_or_missing_inbox_is_ok(self):
        self.assertEqual(self.run_it(), 0)
        self.inbox.rmdir(); self.assertEqual(self.run_it(), 0)

    def test_old_done_zip_is_swept(self):
        d = self.inbox / 'done'; d.mkdir(); old = d / 'old.zip'; old.write_bytes(b'x'); new = d / 'new.zip'; new.write_bytes(b'x')
        t = time.time() - 40 * 86400; os.utime(old, (t, t))
        self.run_it()
        self.assertFalse(old.exists()); self.assertTrue(new.exists())

    def test_config_has_furusato(self):
        c = F.load_conf(); self.assertTrue(c['inboxDir']); self.assertTrue(c['dateFormats'])


# ---- 新しい注文の Teams 通知（ダミーの注文・ダミーの URL。実際には投稿しない）
SECRET_URL = 'https://example.invalid/workflows/SECRET-TOKEN-123/triggers/manual/paths/invoke?sig=TOPSECRET'
RULES = [{'words': ['A100'], 'net': 8400}, {'words': ['A200'], 'net': 13000}]
HEAD = '"発注番号","受注番号","商品番号","品名","数量","お届け先名","お届け先住所","お届け先電話番号"'


def order_csv(*rows):
    """実物と同じく、発注番号・商品番号は ="…" の形（Excel の式）で入れる。お届け先はダミーの個人情報"""
    lines = [HEAD]
    for oid, sku, qty in rows:
        lines.append('="%s","1","=""%s""","品名",%s,"架空 太郎","架空県架空市1-2-3","09012345678"' % (oid, sku, qty))
    return '\n'.join(lines) + '\n'


FOOT = '\n\nアプリ：https://hanaoka-apps.github.io/hanaoka-ops/furusato_sales.html'   # 通知の最後に付く、開くアプリの URL（furusato_config.json の notify.appUrl）


class FakeSession:
    def __init__(self, status=202):
        self.calls, self.status = [], status

    def post(self, url, json=None, timeout=None):
        self.calls.append(json)
        return types.SimpleNamespace(status_code=self.status)

    def texts(self):
        return [c['attachments'][0]['content']['body'][0]['text'] for c in self.calls]


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.shared = Path(self.tmp.name)
        self.inbox = self.shared / CONF['inboxDir']; self.inbox.mkdir()
        p = patch.dict(os.environ, {'EC_TEAMS_WEBHOOK_URL': SECRET_URL}); p.start()
        self.addCleanup(p.stop); self.addCleanup(self.tmp.cleanup)

    def run_it(self, session, rules=RULES):
        with redirect_stdout(io.StringIO()):
            return F.run(self.shared, WORD, CONF, session=session, rules=rules)

    def put(self, name, *rows):
        make_zip(self.inbox / name, WORD + '20261030', {'order.csv': order_csv(*rows)})

    def log(self):
        return (self.shared / '_rpa_queue' / 'logs' / F.LOG_NAME).read_text(encoding='utf-8')

    def test_unzip_notifies_order_number_and_tax_included_amount(self):
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        s = FakeSession()
        self.assertEqual(self.run_it(s), 0)
        self.assertEqual(s.texts(), ['ふるさと納税 新しい注文 1件：発注番号 2630248 9,240円' + FOOT])   # 8,400円（税抜）× 1.1

    def test_multi_line_order_is_one_item_and_sums(self):
        self.put('20261030_a.zip', ('2630300', 'A100', 2), ('2630300', 'A200', 1), ('2630301', 'A200', 1))
        s = FakeSession()
        self.run_it(s)
        self.assertEqual(s.texts(), ['ふるさと納税 新しい注文 2件：発注番号 2630300 32,780円、発注番号 2630301 14,300円' + FOOT])

    def test_unmapped_product_says_amount_undecided(self):
        self.put('20261030_a.zip', ('2630400', 'A999', 1))
        s = FakeSession()
        self.run_it(s)
        self.assertEqual(s.texts(), ['ふるさと納税 新しい注文 1件：発注番号 2630400 金額未確定' + FOOT])

    def test_same_order_number_is_not_notified_twice(self):
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        s = FakeSession()
        self.run_it(s)
        self.put('20261030_b.zip', ('2630248', 'A100', 1), ('2630249', 'A100', 1))   # 同じ注文の再送＋新しい注文
        self.run_it(s)
        self.assertEqual(s.texts(), ['ふるさと納税 新しい注文 1件：発注番号 2630248 9,240円' + FOOT, 'ふるさと納税 新しい注文 1件：発注番号 2630249 9,240円' + FOOT])
        self.put('20261030_c.zip', ('2630248', 'A100', 1))
        self.run_it(s)
        self.assertEqual(len(s.calls), 2)

    def test_no_personal_data_in_message(self):
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        s = FakeSession()
        self.run_it(s)
        blob = json.dumps(s.calls, ensure_ascii=False)
        for secret in ('架空', '09012345678', '1-2-3'):
            self.assertNotIn(secret, blob)

    def test_notify_failure_keeps_unzip_and_retries_next_time(self):
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        self.assertEqual(self.run_it(FakeSession(status=500)), 0)                       # 解凍は成功のまま
        self.assertTrue((self.inbox / 'csv' / '20261030_a' / 'order.csv').exists())
        self.assertTrue((self.inbox / 'done' / '20261030_a.zip').exists())
        self.assertIn('通知に失敗', self.log())
        s = FakeSession()
        self.assertEqual(self.run_it(s), 0)                                             # 新しい ZIP が無くても、次の回に送り直す
        self.assertEqual(s.texts(), ['ふるさと納税 新しい注文 1件：発注番号 2630248 9,240円' + FOOT])
        self.assertEqual(self.run_it(s), 0)
        self.assertEqual(len(s.calls), 1)

    def test_url_and_password_never_in_log(self):
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        self.run_it(FakeSession(status=500))
        for secret in ('SECRET-TOKEN', 'TOPSECRET', WORD):
            self.assertNotIn(secret, self.log())

    def test_unset_webhook_still_unzips(self):
        os.environ.pop('EC_TEAMS_WEBHOOK_URL', None)
        self.put('20261030_a.zip', ('2630248', 'A100', 1))
        s = FakeSession()
        self.assertEqual(self.run_it(s), 0)
        self.assertEqual(s.calls, [])
        self.assertIn('EC_TEAMS_WEBHOOK_URL', self.log())

    def test_failed_zip_is_not_notified(self):
        make_zip(self.inbox / '20261030_a.zip', 'otherword20261030', {'order.csv': order_csv(('2630248', 'A100', 1))})
        s = FakeSession()
        self.assertEqual(self.run_it(s), 1)
        self.assertEqual(s.calls, [])

    def test_amount_rules_come_from_repo_config_and_shared_settings_override(self):
        rules = F.load_rules(self.shared)                                                # 共有の設定が無ければ、リポジトリの対応表
        self.assertEqual(F.order_total([('A112170379', 1)], rules), 9240)
        self.assertEqual(F.order_total([('a112170379', 1)], rules), 9240)                # 大文字小文字・全角半角の違いは同じに見る
        (self.shared / 'furusato_settings.json').write_text(json.dumps({'mapping': {'rules': [{'words': ['A112170379'], 'net': 10000}]}}), encoding='utf-8')
        self.assertEqual(F.order_total([('A112170379', 1)], F.load_rules(self.shared)), 11000)   # 画面で直した単価が優先
        (self.shared / 'furusato_settings.json').write_text('{ broken', encoding='utf-8')
        self.assertEqual(F.order_total([('A112170379', 1)], F.load_rules(self.shared)), 9240)    # 読めなければリポジトリの対応表

    @unittest.skipUnless(shutil.which('node'), 'node がありません')
    def test_amount_matches_the_screen(self):
        """画面（furusato_sales_core.js の priceOrder）と同じ金額になること（設定ファイルの全商品 × 数量いくつか）"""
        conf = json.loads((ROOT / 'furusato_config.json').read_text(encoding='utf-8-sig'))
        cases = [(r['words'][0], q) for r in conf['mapping']['rules'] if r.get('net') is not None for q in (1, 2, 3, 7)]
        js = """
const FS = require(process.argv[1]), conf = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const cases = JSON.parse(process.argv[3]);
console.log(JSON.stringify(cases.map(([sku, q]) => { const o = { lines: [{ sku, qty: q, price: 0 }] }; FS.priceOrder(o, conf.mapping); return o.total; })));
"""
        out = subprocess.run(['node', '-e', js, str(ROOT / 'furusato_sales_core.js'), str(ROOT / 'furusato_config.json'), json.dumps(cases)],
                             capture_output=True, text=True, encoding='utf-8', check=True)
        screen = json.loads(out.stdout)
        rules = conf['mapping']['rules']
        mine = [int(F.order_total([(sku, q)], rules)) for sku, q in cases]
        self.assertEqual(mine, screen)
        self.assertGreater(len(cases), 10)


if __name__ == '__main__':
    unittest.main()
