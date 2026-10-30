"""scripts/furusato_unzip.py のテスト（ダミーのパスワード・ダミーのCSV。実データは使わない）。
実行: python -m unittest tests.test_furusato_unzip"""
import importlib.util
import io
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path

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


if __name__ == '__main__':
    unittest.main()
