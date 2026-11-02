"""scripts/order_notify.py のテスト（実際には投稿しない。通信は差し替える。ダミーの注文・ダミーの URL）。
実行: python -m unittest tests.test_order_notify"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('order_notify', ROOT / 'scripts/order_notify.py')
N = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(N)

SECRET_URL = 'https://example.invalid/workflows/SECRET-TOKEN-123/triggers/manual/paths/invoke?sig=TOPSECRET'


class FakeResponse:
    def __init__(self, status):
        self.status_code = status


class FakeSession:
    """post_teams.post_all が使う session。statuses の順に応答する（尽きたら 202）"""

    def __init__(self, statuses=None, error=None):
        self.calls, self.statuses, self.error = [], list(statuses or []), error

    def post(self, url, json=None, timeout=None):
        self.calls.append({'url': url, 'json': json})
        if self.error:
            raise self.error
        return FakeResponse(self.statuses.pop(0) if self.statuses else 202)

    def texts(self):
        return [c['json']['attachments'][0]['content']['body'][0]['text'] for c in self.calls]


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.path = Path(self.tmp, '_rpa_queue', 'state', 'x.json')
        self.logs = []
        p = patch.dict(os.environ, {N.DEFAULT_ENV: SECRET_URL})
        p.start()
        self.addCleanup(p.stop)

    def go(self, cands, session=None, **kw):
        return N.notify_new('Shopify', cands, self.path, self.logs.append, session=session, **kw)

    def state(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    # ---- 文面
    def test_yen(self):
        self.assertEqual(N.yen(12800), '12,800円')
        self.assertEqual(N.yen('3300.0'), '3,300円')
        self.assertEqual(N.yen('12.5'), '12.50円')
        self.assertEqual(N.yen(None), '金額未確定')
        self.assertEqual(N.yen(100, 'USD'), '100 USD')

    def test_message_format(self):
        m = N.build_messages('Shopify', [('#1801', '#1801 12,800円'), ('#1802', '#1802 3,300円')])
        self.assertEqual(m, [('Shopify 新しい注文 2件：#1801 12,800円、#1802 3,300円', ['#1801', '#1802'])])
        m = N.build_messages('ふるさと納税', [('2630248', '発注番号 2630248 9,240円')])
        self.assertEqual(m[0][0], 'ふるさと納税 新しい注文 1件：発注番号 2630248 9,240円')

    def test_long_message_is_split_with_numbers(self):
        items = [('#%d' % i, '#%d 1,000円' % i) for i in range(1000, 1040)]
        m = N.build_messages('Shopify', items, max_chars=100)
        self.assertGreater(len(m), 2)
        self.assertTrue(all(len(t) <= 130 for t, _ in m))
        self.assertTrue(m[0][0].endswith('（1/%d）' % len(m)))
        self.assertEqual([i for _, ids in m for i in ids], [k for k, _ in items])   # 抜けも重なりもない

    # ---- 開くアプリの URL（各通の最後）
    def test_footer_is_appended_to_every_message(self):
        foot = 'アプリ：https://example.invalid/app.html'
        m = N.build_messages('Shopify', [('#1801', '#1801 12,800円'), ('#1802', '#1802 3,300円')], footer=foot)
        self.assertEqual(m[0][0], 'Shopify 新しい注文 2件：#1801 12,800円、#1802 3,300円\n\n' + foot)
        items = [('#%d' % i, '#%d 1,000円' % i) for i in range(1000, 1040)]
        m = N.build_messages('Shopify', items, max_chars=200, footer=foot)
        self.assertGreater(len(m), 2)
        self.assertTrue(all(t.endswith('\n\n' + foot) for t, _ in m))       # 分けた各通に付く
        self.assertTrue(all(len(t) <= 200 + 40 for t, _ in m))                # URL の分を引いて分けるので、長くなりすぎない
        self.assertEqual([i for _, ids in m for i in ids], [k for k, _ in items])
        self.assertIn('（1/%d）\n\n' % len(m), m[0][0])                       # （1/2）は本文の後、URL の前

    def test_footer_goes_through_notify_new(self):
        foot = 'アプリ：https://example.invalid/app.html'
        self.go([('#1', '#1 100円')], FakeSession(), footer=foot)
        s = FakeSession()
        self.go([('#1', '#1 100円'), ('#2', '#2 200円')], s, footer=foot)
        self.assertEqual(s.texts(), ['Shopify 新しい注文 1件：#2 200円\n\n' + foot])

    def test_app_footer_reads_config_and_never_fails(self):
        p = Path(self.tmp, 'conf.json')
        self.assertEqual(N.app_footer(p), '')                                  # ファイルが無い
        p.write_text('{ broken', encoding='utf-8')
        self.assertEqual(N.app_footer(p), '')                                  # 壊れている
        p.write_text('{"x": 1}', encoding='utf-8')
        self.assertEqual(N.app_footer(p), '')                                  # notify が無い
        p.write_text(json.dumps({'notify': {'appUrl': ' https://example.invalid/a.html '}}), encoding='utf-8')
        self.assertEqual(N.app_footer(p), 'アプリ：https://example.invalid/a.html')

    def test_repo_configs_have_the_app_urls(self):
        self.assertEqual(N.app_footer(ROOT / 'ec_sales_config.json'), 'アプリ：https://hanaoka-apps.github.io/hanaoka-ops/ec_sales.html')
        self.assertEqual(N.app_footer(ROOT / 'furusato_config.json'), 'アプリ：https://hanaoka-apps.github.io/hanaoka-ops/furusato_sales.html')

    # ---- 最初の1回
    def test_first_run_only_records(self):
        s = FakeSession()
        self.assertEqual(self.go([('#1', '#1 100円'), ('#2', '#2 200円')], s), 'seeded')
        self.assertEqual(s.calls, [])
        self.assertEqual(sorted(self.state()['orders']), ['#1', '#2'])

    def test_second_run_notifies_only_new_once(self):
        self.go([('#1', '#1 100円')], FakeSession())
        s = FakeSession()
        self.assertEqual(self.go([('#1', '#1 100円'), ('#2', '#2 12,800円'), ('#3', '#3 3,300円')], s), 'sent')
        self.assertEqual(s.texts(), ['Shopify 新しい注文 2件：#2 12,800円、#3 3,300円'])   # 1通にまとめる
        s2 = FakeSession()
        self.assertEqual(self.go([('#1', '#1 100円'), ('#2', '#2 12,800円'), ('#3', '#3 3,300円')], s2), 'none')
        self.assertEqual(s2.calls, [])   # 同じ注文は2回通知しない

    def test_first_run_can_notify_when_not_silent(self):
        s = FakeSession()
        self.assertEqual(self.go([('A', '発注番号 A 100円')], s, first_run_silent=False), 'sent')
        self.assertEqual(len(s.calls), 1)

    # ---- 失敗
    def test_failure_does_not_record_and_retries(self):
        self.go([('#1', '#1 100円')], FakeSession())
        self.assertEqual(self.go([('#1', '#1 100円'), ('#2', '#2 200円')], FakeSession([500])), 'failed')
        self.assertNotIn('#2', self.state()['orders'])
        self.assertTrue(any('通知に失敗' in m for m in self.logs))
        s = FakeSession()
        self.assertEqual(self.go([('#1', '#1 100円'), ('#2', '#2 200円')], s), 'sent')   # 次の回に送り直す
        self.assertEqual(s.texts(), ['Shopify 新しい注文 1件：#2 200円'])

    def test_connection_error_is_failure_not_exception(self):
        self.go([('#1', '#1 100円')], FakeSession())
        self.assertEqual(self.go([('#2', '#2 200円')], FakeSession(error=ConnectionError(SECRET_URL))), 'failed')
        self.assertNotIn('#2', self.state()['orders'])

    def test_missing_webhook_is_failure_and_names_env_only(self):
        self.go([('#1', '#1 100円')], FakeSession())
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(N.DEFAULT_ENV, None)
            self.assertEqual(self.go([('#2', '#2 200円')], FakeSession()), 'failed')
        self.assertTrue(any(N.DEFAULT_ENV in m for m in self.logs))
        self.assertNotIn('#2', self.state()['orders'])

    def test_partial_failure_records_only_sent_parts(self):
        self.go([('#0', '#0 1円')], FakeSession())
        items = [('#%d' % i, '#%d 1,000円' % i) for i in range(1000, 1040)]
        with patch.object(N, 'MAX_CHARS', 100):
            s = FakeSession([202, 500])
            self.assertEqual(self.go(items, s), 'failed')
        sent = self.state()['orders']
        self.assertTrue('#1000' in sent and '#1039' not in sent)   # 1通目の分だけ記録（2通目以降は次の回に送る）
        self.assertEqual(len(s.calls), 2)

    def test_broken_state_stops_notifications_and_keeps_file(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{ broken', encoding='utf-8')
        s = FakeSession()
        self.assertEqual(self.go([('#1', '#1 100円')], s), 'skipped')
        self.assertEqual(s.calls, [])
        self.assertEqual(self.path.read_text(encoding='utf-8'), '{ broken')   # 上書きしない
        self.assertTrue(any('読めません' in m for m in self.logs))

    # ---- 持ち越し（ふるさと納税）
    def test_pending_is_retried_without_new_candidates(self):
        self.assertEqual(self.go([('A', '発注番号 A 100円')], FakeSession([500]), first_run_silent=False, keep_pending=True), 'failed')
        self.assertIn('A', self.state()['pending'])
        s = FakeSession()
        self.assertEqual(self.go([], s, first_run_silent=False, keep_pending=True), 'sent')
        self.assertEqual(s.texts(), ['Shopify 新しい注文 1件：発注番号 A 100円'])
        self.assertEqual(self.state()['pending'], {})
        self.assertEqual(self.go([], FakeSession(), first_run_silent=False, keep_pending=True), 'none')

    def test_same_order_in_candidates_and_pending_sent_once(self):
        self.go([('A', 'x')], FakeSession([500]), first_run_silent=False, keep_pending=True)
        s = FakeSession()
        self.go([('A', 'x'), ('A', 'x')], s, first_run_silent=False, keep_pending=True)
        self.assertEqual(s.texts(), ['Shopify 新しい注文 1件：x'])

    # ---- 秘密・古い記録
    def test_secret_url_never_in_logs_or_state(self):
        self.go([('#1', '#1 100円')], FakeSession())
        self.go([('#2', '#2 200円')], FakeSession([500]))
        self.go([('#3', '#3 300円')], FakeSession(error=RuntimeError(SECRET_URL)))
        blob = ' '.join(self.logs) + self.path.read_text(encoding='utf-8')
        self.assertNotIn('SECRET-TOKEN', blob)
        self.assertNotIn('TOPSECRET', blob)

    def test_old_records_are_pruned(self):
        self.path.parent.mkdir(parents=True)
        now = datetime(2026, 11, 2, tzinfo=timezone.utc)
        old = (now - timedelta(days=N.KEEP_DAYS + 5)).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.path.write_text(json.dumps({'orders': {'#old': old, '#new': '2026-11-01T00:00:00Z'}}), encoding='utf-8')
        self.go([('#x', '#x 1円')], FakeSession(), now=now)
        self.assertEqual(sorted(self.state()['orders']), ['#new', '#x'])


if __name__ == '__main__':
    unittest.main()
