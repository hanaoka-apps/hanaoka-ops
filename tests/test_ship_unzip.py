"""scripts/ship_unzip.py のテスト（ダミーのパスワード・ダミーのCSV。実データは使わない）。
実行: python tests/test_ship_unzip.py  （AES の ZIP を作るので pyzipper が必要）"""
import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

import pyzipper

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ship_unzip', ROOT / 'scripts/ship_unzip.py')
U = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(U)

PW = 'dummy-user-id-123'
ENV_NAME = 'SHIP_TEST_ZIP_PASSWORD'
CONF = {'inboxDir': '_ship_inbox', 'targets': [{'key': 'tonami', 'name': 'トナミ運輸', 'dir': 'tonami', 'passwordEnv': ENV_NAME, 'keepDays': 14, 'csvKeepDays': 200}]}
CSV = '送り状No,指定No記号,出荷日\r\n5910000001,36729,2026/10/05\r\n'.encode('cp932')


def make_zip(path, password, members):
    with pyzipper.AESZipFile(path, 'w', compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as z:
        z.setpassword(password.encode())
        for n, data in members.items():
            z.writestr(n, data)


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shared = Path(self.tmp.name)
        self.folder = self.shared / '_ship_inbox' / 'tonami'
        self.folder.mkdir(parents=True)
        self.addCleanup(self.tmp.cleanup)

    def run_it(self, env=None):
        out = io.StringIO()
        with redirect_stdout(out):
            code = U.run(self.shared, CONF, {ENV_NAME: PW} if env is None else env)
        return code, out.getvalue()

    def log_text(self):
        p = self.shared / '_rpa_queue' / 'logs' / 'ship_unzip.log'
        return p.read_text(encoding='utf-8') if p.exists() else ''

    def test_解凍してCSVを置き_ZIPをdoneへ移す(self):
        make_zip(self.folder / 'SYUKKA_LIST_20261102_101142.zip', PW, {'SYUKKA_LIST_20261102_101142.csv': CSV})
        code, _ = self.run_it()
        self.assertEqual(code, 0)
        out = self.folder / 'csv' / 'SYUKKA_LIST_20261102_101142' / 'SYUKKA_LIST_20261102_101142.csv'
        self.assertEqual(out.read_bytes(), CSV)
        self.assertTrue((self.folder / 'done' / 'SYUKKA_LIST_20261102_101142.zip').exists())
        self.assertFalse((self.folder / 'SYUKKA_LIST_20261102_101142.zip').exists())
        self.assertIn('解凍しました', self.log_text())

    def test_パスワードが違えばfailedへ移し_ログに秘密を書かない(self):
        make_zip(self.folder / 'a.zip', 'another-password', {'a.csv': CSV})
        code, out = self.run_it()
        self.assertEqual(code, 1)
        self.assertTrue((self.folder / 'failed' / 'a.zip').exists())
        self.assertFalse((self.folder / 'csv').exists())
        for text in (out, self.log_text()):
            self.assertIn('失敗', text)
            self.assertNotIn(PW, text)
            self.assertNotIn('another-password', text)

    def test_環境変数が無ければ解凍せず_ZIPはそのまま(self):
        make_zip(self.folder / 'a.zip', PW, {'a.csv': CSV})
        code, out = self.run_it(env={})
        self.assertEqual(code, 1)
        self.assertTrue((self.folder / 'a.zip').exists())
        self.assertIn(ENV_NAME, out)               # 名前は出す（値は無い）
        self.assertNotIn(PW, out)

    def test_ZIPが無ければ何もしない(self):
        self.assertEqual(self.run_it()[0], 0)
        self.assertEqual(self.run_it(env={})[0], 0)      # ZIP が無ければ、パスワードが無くてもよい
        (self.shared / '_ship_inbox' / 'tonami').rmdir()
        self.assertEqual(self.run_it()[0], 0)            # フォルダが無くてもよい

    def test_CSVの無いZIPは失敗(self):
        make_zip(self.folder / 'a.zip', PW, {'readme.txt': b'x'})
        self.assertEqual(self.run_it()[0], 1)
        self.assertTrue((self.folder / 'failed' / 'a.zip').exists())

    def test_フォルダを含む名前でも平らに取り出す(self):
        make_zip(self.folder / 'a.zip', PW, {'../evil.csv': CSV, 'sub/b.csv': CSV})
        self.assertEqual(self.run_it()[0], 0)
        self.assertEqual(sorted(p.name for p in (self.folder / 'csv' / 'a').iterdir()), ['b.csv', 'evil.csv'])
        self.assertFalse((self.folder / 'evil.csv').exists())

    def test_古い処理済みZIPと古いCSVを消す(self):
        old = time.time() - 400 * 86400
        (self.folder / 'done').mkdir()
        z = self.folder / 'done' / 'old.zip'; z.write_bytes(b'x'); os.utime(z, (old, old))
        keep = self.folder / 'done' / 'new.zip'; keep.write_bytes(b'x')
        d = self.folder / 'csv' / 'old'; d.mkdir(parents=True); (d / 'x.csv').write_bytes(b'x'); os.utime(d, (old, old))
        n = self.folder / 'csv' / 'new'; n.mkdir(); (n / 'x.csv').write_bytes(b'x')
        self.assertEqual(self.run_it()[0], 0)
        self.assertFalse(z.exists()); self.assertTrue(keep.exists())
        self.assertFalse(d.exists()); self.assertTrue(n.exists())

    def test_設定ファイル(self):
        conf = U.load_conf(ROOT / 'ship_config.json')
        self.assertEqual([t['key'] for t in conf['targets']], ['tonami'])          # zip の設定がある会社だけ
        t = conf['targets'][0]
        self.assertEqual((t['dir'], t['passwordEnv']), ('tonami', 'SHIP_TONAMI_ZIP_PASSWORD'))
        text = (ROOT / 'ship_config.json').read_text(encoding='utf-8')
        self.assertNotIn('"password"', text)                                        # 値は書かない（環境変数の名前だけ）
        bad = self.shared / 'bad.json'
        bad.write_text(json.dumps({'inboxDir': 'x', 'carriers': {'a': {'dir': 'a', 'zip': {'keepDays': 3}}}}), encoding='utf-8')
        with self.assertRaises(ValueError):
            U.load_conf(bad)

    def test_main(self):
        conf = self.shared / 'conf.json'
        conf.write_text(json.dumps({'inboxDir': '_ship_inbox', 'carriers': {'tonami': {'dir': 'tonami', 'zip': {'passwordEnv': ENV_NAME}}}}), encoding='utf-8')
        make_zip(self.folder / 'a.zip', PW, {'a.csv': CSV})
        old = {k: os.environ.get(k) for k in ('SHARED_MASTERS_DIR', ENV_NAME)}
        try:
            os.environ.pop('SHARED_MASTERS_DIR', None)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(U.main(['--config', str(conf)]), 2)
            os.environ['SHARED_MASTERS_DIR'] = str(self.shared); os.environ[ENV_NAME] = PW
            with redirect_stdout(io.StringIO()):
                self.assertEqual(U.main(['--config', str(conf)]), 0)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(U.main(['--config', str(self.shared / 'none.json')]), 2)
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.assertTrue((self.folder / 'csv' / 'a' / 'a.csv').exists())


if __name__ == '__main__':
    unittest.main()
