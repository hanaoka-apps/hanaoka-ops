"""scripts/post_teams.py のテスト（実際には投稿しない。通信は差し替える）。
実行: python -m unittest tests.test_post_teams"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('post_teams', ROOT / 'scripts/post_teams.py')
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)

SECRET_URL = 'https://example.invalid/workflows/SECRET-TOKEN-123/triggers/manual/paths/invoke?sig=TOPSECRET'


class FakeResponse:
    def __init__(self, status):
        self.status_code = status


class FakeSession:
    def __init__(self, statuses=None, error=None):
        self.calls = []
        self.statuses = list(statuses or [])
        self.error = error

    def post(self, url, json=None, timeout=None):
        self.calls.append({'url': url, 'json': json, 'timeout': timeout})
        if self.error:
            raise self.error
        return FakeResponse(self.statuses.pop(0) if self.statuses else 202)


class PostTeamsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, 'parts.json')
        self._old = os.environ.get('EC_TEAMS_WEBHOOK_URL')
        self.addCleanup(self._restore)

    def _restore(self):
        if self._old is None:
            os.environ.pop('EC_TEAMS_WEBHOOK_URL', None)
        else:
            os.environ['EC_TEAMS_WEBHOOK_URL'] = self._old

    def write_parts(self, parts):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'parts': parts}, f, ensure_ascii=False)

    def run_main(self, session=None, argv=None):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = T.main(argv or ['--input', self.path], session=session)
        return code, buf.getvalue()

    def test_本文ごとに投稿する_宛先と中身(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_parts(['【EC売上】結果\n取込 2件', '（続き）\n#1801 受注№ 90001'])
        s = FakeSession()
        code, out = self.run_main(s)
        self.assertEqual(code, 0)
        self.assertEqual(len(s.calls), 2)
        self.assertEqual(s.calls[0]['url'], SECRET_URL)
        card = s.calls[0]['json']
        self.assertEqual(card['type'], 'message')
        att = card['attachments'][0]
        self.assertEqual(att['contentType'], 'application/vnd.microsoft.card.adaptive')
        self.assertEqual(att['content']['type'], 'AdaptiveCard')
        self.assertEqual(att['content']['body'][0]['text'], '【EC売上】結果\n取込 2件')
        self.assertTrue(att['content']['body'][0]['wrap'])
        self.assertEqual(s.calls[1]['json']['attachments'][0]['content']['body'][0]['text'], '（続き）\n#1801 受注№ 90001')
        self.assertTrue(s.calls[0]['timeout'])
        self.assertIn('OK: 2 件', out)
        self.assertNotIn('SECRET', out)

    def test_URL未設定なら投稿せず理由を出す(self):
        os.environ.pop('EC_TEAMS_WEBHOOK_URL', None)
        self.write_parts(['本文'])
        s = FakeSession()
        code, out = self.run_main(s)
        self.assertEqual(code, 2)
        self.assertEqual(s.calls, [])
        self.assertIn('EC_TEAMS_WEBHOOK_URL が設定されていません', out)
        os.environ['EC_TEAMS_WEBHOOK_URL'] = '   '
        self.assertEqual(self.run_main(s)[0], 2)                                         # 空白だけも未設定
        os.environ['MY_HOOK'] = SECRET_URL                                                # 環境変数の名前は変えられる
        self.addCleanup(lambda: os.environ.pop('MY_HOOK', None))
        code, _ = self.run_main(FakeSession(), ['--input', self.path, '--webhook-env', 'MY_HOOK'])
        self.assertEqual(code, 0)

    def test_失敗してもURLが漏れない(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_parts(['本文'])
        # 通信エラー：requests の例外はメッセージに URL を含むことがある
        err = ConnectionError('HTTPSConnectionPool: Max retries exceeded with url: ' + SECRET_URL)
        code, out = self.run_main(FakeSession(error=err))
        self.assertEqual(code, 1)
        self.assertIn('通信エラー', out)
        self.assertNotIn('SECRET', out)
        self.assertNotIn('TOPSECRET', out)
        self.assertNotIn('example.invalid', out)
        # 拒否（HTTP 4xx/5xx）
        code, out = self.run_main(FakeSession(statuses=[400]))
        self.assertEqual(code, 1)
        self.assertIn('HTTP 400', out)
        self.assertNotIn('SECRET', out)

    def test_途中で失敗したら残りは投稿しない(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_parts(['1', '2', '3'])
        s = FakeSession(statuses=[202, 500, 202])
        code, out = self.run_main(s)
        self.assertEqual(code, 1)
        self.assertEqual(len(s.calls), 2)
        self.assertIn('2/3 件目', out)

    def test_入力が不正なら投稿しない(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        s = FakeSession()
        for bad in ('{"parts": []}', '{"parts": [1]}', '{"parts": ["  "]}', 'これはJSONではない', '{}'):
            with open(self.path, 'w', encoding='utf-8') as f:
                f.write(bad)
            code, out = self.run_main(s)
            self.assertEqual(code, 2, bad)
            self.assertNotIn('SECRET', out)
        self.assertEqual(s.calls, [])
        code, _ = self.run_main(s, ['--input', os.path.join(self.tmp.name, 'なし.json')])
        self.assertEqual(code, 2)

    def test_配列だけのJSONも読める(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        with open(self.path, 'w', encoding='utf-8-sig') as f:
            json.dump(['本文だけ'], f, ensure_ascii=False)
        s = FakeSession()
        self.assertEqual(self.run_main(s)[0], 0)
        self.assertEqual(len(s.calls), 1)

    def write_input(self, parts, mention='__none__'):
        data = {'parts': parts}
        if mention != '__none__':
            data['mention'] = mention
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)

    def test_メンションあり_本文の先頭の_at_とentitiesが付く(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_input(['本文1', '本文2'], {'id': 'taro@example.com', 'name': '福田 太郎'})
        s = FakeSession()
        code, out = self.run_main(s)
        self.assertEqual(code, 0)
        first = s.calls[0]['json']['attachments'][0]['content']
        self.assertEqual(first['body'][0]['text'], '<at>福田 太郎</at> EC取込の結果です。\n\n本文1')
        self.assertEqual(first['msteams'], {'entities': [{'type': 'mention', 'text': '<at>福田 太郎</at>', 'mentioned': {'id': 'taro@example.com', 'name': '福田 太郎'}}]})
        self.assertEqual(first['type'], 'AdaptiveCard')
        # 2件目以降はメンションを付けない（通知が重ならない）
        second = s.calls[1]['json']['attachments'][0]['content']
        self.assertEqual(second['body'][0]['text'], '本文2')
        self.assertNotIn('msteams', second)
        self.assertIn('メンションあり', out)
        self.assertNotIn('SECRET', out)

    def test_メンションなし_従来どおり(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_input(['本文'])
        s = FakeSession()
        self.assertEqual(self.run_main(s)[0], 0)
        content = s.calls[0]['json']['attachments'][0]['content']
        self.assertEqual(content['body'][0]['text'], '本文')
        self.assertNotIn('msteams', content)
        self.assertNotIn('<at>', json.dumps(s.calls[0]['json'], ensure_ascii=False))
        for empty in (None, {}, []):
            self.write_input(['本文'], empty)
            s = FakeSession()
            self.assertEqual(self.run_main(s)[0], 0)
            self.assertNotIn('msteams', s.calls[0]['json']['attachments'][0]['content'])

    def test_メンションが不正な形でも投稿は成功しメンションなしになる(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        bads = [{'id': 'メールではない', 'name': '福田'}, {'id': 'a@example.com'}, {'name': '福田'}, {'id': 'a@example.com', 'name': ''},
                {'id': 'a@example.com', 'name': '<>'}, {'id': 123, 'name': '福田'}, {'id': 'a b@example.com', 'name': '福田'},
                'taro@example.com', ['a@example.com'], {'id': 'a@example.com', 'name': None}, {'id': 'a@b', 'name': '福田'}]
        for bad in bads:
            self.write_input(['本文'], bad)
            s = FakeSession()
            code, out = self.run_main(s)
            self.assertEqual(code, 0, bad)
            content = s.calls[0]['json']['attachments'][0]['content']
            self.assertNotIn('msteams', content, bad)
            self.assertEqual(content['body'][0]['text'], '本文', bad)
            self.assertNotIn('メンションあり', out)

    def test_表示名の記号は取り除く(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_input(['本文'], {'id': 'a@example.com', 'name': '福田</at><at>他人\n'})
        s = FakeSession()
        self.assertEqual(self.run_main(s)[0], 0)
        c = s.calls[0]['json']['attachments'][0]['content']
        text = c['body'][0]['text']
        self.assertEqual(text.count('<at>'), 1)
        self.assertEqual(text.count('</at>'), 1)                                          # 本文の <at> の形を壊されない
        self.assertEqual(c['msteams']['entities'][0]['mentioned']['name'], '福田/atat他人')

    def test_メンションがあっても失敗してURLが漏れない(self):
        os.environ['EC_TEAMS_WEBHOOK_URL'] = SECRET_URL
        self.write_input(['本文'], {'id': 'taro@example.com', 'name': '福田 太郎'})
        err = ConnectionError('Max retries exceeded with url: ' + SECRET_URL)
        code, out = self.run_main(FakeSession(error=err))
        self.assertEqual(code, 1)
        self.assertNotIn('SECRET', out)
        self.assertNotIn('TOPSECRET', out)
        code, out = self.run_main(FakeSession(statuses=[400]))
        self.assertEqual((code, 'HTTP 400' in out, 'SECRET' in out), (1, True, False))

    def test_ファイル全体にURLを埋め込んでいない(self):
        src = (ROOT / 'scripts/post_teams.py').read_text(encoding='utf-8')
        self.assertNotIn('webhook.office.com', src)
        self.assertNotIn('logic.azure.com', src)
        self.assertNotIn('sig=', src)


if __name__ == '__main__':
    unittest.main()
