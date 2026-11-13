"""scripts/shopify_fulfill.py のテスト。Shopify の応答は架空の値で作る（実際の顧客データは使わない）。
実行: python -m unittest tests.test_shopify_fulfill -v  （または python tests/test_shopify_fulfill.py）
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
try:
    import requests  # noqa: F401
except ImportError:  # requests が入っていない環境でも読み込めるように
    stub = types.ModuleType('requests')
    stub.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules['requests'] = stub
SPEC = importlib.util.spec_from_file_location('shopify_fulfill', ROOT / 'scripts/shopify_fulfill.py')
SF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SF)

SETTINGS = {'shop': 'test-shop.myshopify.com', 'client_id': 'cid', 'client_secret': 'secret-value', 'dir': '', 'version': '2026-07'}


class Resp:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}

    def json(self):
        if self._body is None:
            raise ValueError('no json')
        return self._body


class FakeSession:
    """post(): トークン取得（form）と GraphQL（json）を見分けて、決めた応答を返す。呼ばれた中身を calls に残す"""

    def __init__(self, orders=None, create=None, update=None, token_resp=None, script=None):
        self.orders = orders or {}      # 注文番号 -> order node
        self.create = create            # fulfillmentCreate の応答（None なら成功）
        self.update = update
        self.token_resp = token_resp
        self.calls = []
        self.script = list(script or [])   # 先頭から順に GraphQL に返す応答（Resp）。空なら通常の動き

    def post(self, url, **kw):
        if url.endswith('/admin/oauth/access_token'):
            self.calls.append(('token', kw.get('data')))
            return self.token_resp or Resp(200, {'access_token': 'tok', 'scope': 'x', 'expires_in': 86399})
        q = kw['json']['query']
        v = kw['json']['variables']
        kind = 'order' if 'orders(' in q else 'create' if 'fulfillmentCreate' in q else 'update'
        self.calls.append((kind, v))
        if self.script:
            return self.script.pop(0)
        if kind == 'order':
            oid = v['q'].replace('name:#', '')
            node = self.orders.get(oid)
            nodes = [] if node is None else (node if isinstance(node, list) else [node])
            return Resp(200, {'data': {'orders': {'nodes': nodes}}})
        if kind == 'create':
            return Resp(200, {'data': {'fulfillmentCreate': self.create or {'fulfillment': {'id': 'gid://f/1', 'status': 'SUCCESS'}, 'userErrors': []}}})
        return Resp(200, {'data': {'fulfillmentTrackingInfoUpdate': self.update or {'fulfillment': {'id': 'gid://f/1', 'status': 'SUCCESS'}, 'userErrors': []}}})

    def kinds(self):
        return [c[0] for c in self.calls]


def order(name, fos=None, fulfillments=None, cancelled=None):
    return {'id': 'gid://shopify/Order/' + name, 'name': '#' + name, 'cancelledAt': cancelled,
            'fulfillmentOrders': {'nodes': [{'id': 'gid://fo/' + str(i), 'status': s} for i, s in enumerate(fos or [])]},
            'fulfillments': fulfillments or []}


def fulfilled(numbers, status='SUCCESS'):
    return {'id': 'gid://f/9', 'status': status, 'trackingInfo': [{'number': n, 'company': '西濃運輸', 'url': ''} for n in numbers]}


ITEM = {'id': '1772', 'company': '西濃運輸', 'number': '907-228-4252', 'url': 'https://track.example.co.jp/?no=9072284252'}


def run(session, items=None, **req):
    body = dict({'orders': items or [ITEM]}, **req)
    return SF.run(body, SETTINGS, session=session, sleep=lambda s: None, batch='b1')


class Tests(unittest.TestCase):
    def test_clean_number(self):
        self.assertEqual(SF.clean_number('907-228-4252'), '9072284252')
        self.assertEqual(SF.clean_number(' ９０７ー２２８－４２５２ '), '9072284252')
        self.assertIsNone(SF.clean_number('12345'))
        self.assertIsNone(SF.clean_number('abc'))
        self.assertIsNone(SF.clean_number(''))

    def test_create_fulfillment_with_tracking_and_notify(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])})
        out = run(s)
        r = out['results'][0]
        self.assertEqual((r['id'], r['status'], r['action']), ('1772', 'done', 'create'))
        self.assertTrue(out['ok'])
        create = [c for c in s.calls if c[0] == 'create'][0][1]['fulfillment']
        self.assertEqual(create['trackingInfo'], {'company': '西濃運輸', 'number': '9072284252', 'url': ITEM['url']})   # ハイフンなし
        self.assertIs(create['notifyCustomer'], True)   # いまの手作業と同じく、通知する
        self.assertEqual(create['lineItemsByFulfillmentOrder'], [{'fulfillmentOrderId': 'gid://fo/0'}])

    def test_notify_false_is_sent(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])})
        run(s, notify=False)
        self.assertIs([c for c in s.calls if c[0] == 'create'][0][1]['fulfillment']['notifyCustomer'], False)

    def test_dry_run_writes_nothing(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])})
        out = run(s, dryRun=True)
        self.assertEqual(s.kinds().count('create'), 0)
        self.assertEqual(s.kinds().count('update'), 0)
        self.assertEqual(out['results'][0]['action'], 'create')
        self.assertIn('確認のみ', out['results'][0]['message'])
        self.assertIn('まだ登録されていません', out['results'][0]['message'])      # 未登録だと、はっきり分かる
        self.assertNotIn('registered', out['results'][0])
        self.assertTrue(out['dryRun'])

    def test_already_registered_is_skipped_without_writing(self):
        s = FakeSession({'1772': order('1772', fulfillments=[fulfilled(['9072284252'])])})
        r = run(s)['results'][0]
        self.assertEqual((r['status'], r['action']), ('already', 'none'))
        self.assertEqual(s.kinds(), ['token', 'order'])
        self.assertEqual(r['registered'], ['9072284252'])                 # Shopify に登録されている番号が結果に入る
        self.assertIn('9072284252', r['message']); self.assertIn('登録済み', r['message'])

    def test_add_tracking_to_fulfilled_order_without_number(self):
        s = FakeSession({'1772': order('1772', fos=['CLOSED'], fulfillments=[fulfilled([])])})
        r = run(s)['results'][0]
        self.assertEqual((r['status'], r['action']), ('done', 'update'))
        u = [c for c in s.calls if c[0] == 'update'][0][1]
        self.assertEqual(u['id'], 'gid://f/9')
        self.assertEqual(u['info']['number'], '9072284252')
        self.assertIs(u['notify'], True)

    def test_other_number_already_registered_needs_a_person(self):
        s = FakeSession({'1772': order('1772', fos=['CLOSED'], fulfillments=[fulfilled(['1111111111'])])})
        r = run(s)['results'][0]
        self.assertEqual(r['status'], 'skipped')
        self.assertEqual(r['registered'], ['1111111111'])                 # 別の番号が、すでに登録されている（画面に出す）
        self.assertIn('1111111111', r['message'])
        self.assertNotIn('create', s.kinds())
        self.assertNotIn('update', s.kinds())

    def test_cancelled_multiple_fos_hold_and_partial_are_skipped(self):
        cases = {
            '1': order('1', fos=['OPEN'], cancelled='2026-11-01T00:00:00Z'),
            '2': order('2', fos=['OPEN', 'OPEN']),
            '3': order('3', fos=['ON_HOLD']),
            '4': order('4', fos=['OPEN'], fulfillments=[fulfilled(['2222222222'])]),
            '5': order('5', fos=['CLOSED'], fulfillments=[fulfilled([]), fulfilled([])]),
        }
        s = FakeSession(cases)
        out = run(s, items=[dict(ITEM, id=k) for k in cases])
        self.assertEqual([r['status'] for r in out['results']], ['skipped'] * 5)
        self.assertFalse(out['ok'])
        self.assertNotIn('create', s.kinds())
        self.assertNotIn('update', s.kinds())

    def test_not_found_and_duplicate_names(self):
        s = FakeSession({'7': [order('7', fos=['OPEN']), order('7', fos=['OPEN'])]})
        out = run(s, items=[dict(ITEM, id='8'), dict(ITEM, id='7')])
        self.assertEqual([r['status'] for r in out['results']], ['error', 'error'])
        self.assertIn('見つかりません', out['results'][0]['message'])
        self.assertIn('複数', out['results'][1]['message'])

    def test_nothing_to_fulfill_is_error(self):
        s = FakeSession({'1772': order('1772', fos=['CLOSED'])})
        self.assertEqual(run(s)['results'][0]['status'], 'error')

    def test_user_errors_become_error_result(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])}, create={'fulfillment': None, 'userErrors': [{'field': ['x'], 'message': 'この拠点では発送できません'}]})
        r = run(s)['results'][0]
        self.assertEqual((r['status'], r['action']), ('error', 'create'))
        self.assertIn('発送できません', r['message'])

    def test_bad_input_per_order(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])})
        out = run(s, items=[dict(ITEM, number='12'), dict(ITEM, id='1773', company=''), dict(ITEM, id='1774', url='http://insecure.example.com/x'), dict(ITEM, id='')])
        self.assertEqual([r['status'] for r in out['results']], ['error'] * 4)
        self.assertEqual(s.kinds(), ['token'] if s.kinds() else [])   # Shopify には、何も送らない（トークンを取るだけ）

    def test_request_validation(self):
        for bad in ({}, {'orders': []}, {'orders': [ITEM, ITEM]}, {'orders': [dict(ITEM, id=str(i)) for i in range(SF.MAX_ORDERS + 1)]}, []):
            with self.assertRaises(SF.ConfigError):
                SF.validate_request(bad)

    def test_token_failure_is_fatal_with_clear_message_and_no_secret(self):
        s = FakeSession(token_resp=Resp(400, {'error': 'shop_not_permitted'}))
        with self.assertRaises(SF.FulfillError) as cm:
            run(s)
        self.assertIn('shop_not_permitted', str(cm.exception))
        self.assertNotIn('secret-value', str(cm.exception))

    def test_access_denied_on_first_order_fails_the_request_with_reason(self):
        denied = Resp(200, {'errors': [{'message': 'Access denied for fulfillmentCreate', 'extensions': {'code': 'ACCESS_DENIED'}}]})
        s = FakeSession(script=[Resp(200, {'data': {'orders': {'nodes': [order('1772', fos=['OPEN'])]}}}), denied])
        with self.assertRaises(SF.FulfillError) as cm:
            run(s, items=[ITEM, dict(ITEM, id='1773')])
        self.assertIn('アクセス権限が足りません', str(cm.exception))

    def test_fatal_error_midway_keeps_partial_results_and_stops_the_rest(self):
        denied = Resp(200, {'errors': [{'message': 'Access denied', 'extensions': {'code': 'ACCESS_DENIED'}}]})
        ok_create = Resp(200, {'data': {'fulfillmentCreate': {'fulfillment': {'id': 'gid://f/1', 'status': 'SUCCESS'}, 'userErrors': []}}})
        node = lambda n: Resp(200, {'data': {'orders': {'nodes': [order(n, fos=['OPEN'])]}}})
        s = FakeSession(script=[node('1772'), ok_create, node('1773'), denied])
        out = run(s, items=[ITEM, dict(ITEM, id='1773', number='907-228-4253'), dict(ITEM, id='1774', number='907-228-4254')])
        self.assertEqual([r['status'] for r in out['results']], ['done', 'error', 'error'])
        self.assertIn('処理していません', out['results'][2]['message'])
        self.assertFalse(out['ok'])

    def test_throttled_is_retried(self):
        throttled = Resp(200, {'errors': [{'message': 'Throttled', 'extensions': {'code': 'THROTTLED'}}]})
        ok = Resp(200, {'data': {'orders': {'nodes': [order('1772', fulfillments=[fulfilled(['9072284252'])])]}}})
        s = FakeSession(script=[throttled, ok])
        self.assertEqual(run(s)['results'][0]['status'], 'already')

    def test_load_settings(self):
        env = {'SHOPIFY_SHOP': 'https://Test-Shop.myshopify.com/', 'SHOPIFY_FULFILL_CLIENT_ID': 'a', 'SHOPIFY_FULFILL_CLIENT_SECRET': 'b', 'SHARED_MASTERS_DIR': '/x'}
        self.assertEqual(SF.load_settings(env)['shop'], 'test-shop.myshopify.com')
        with self.assertRaises(SF.ConfigError):
            SF.load_settings({})
        with self.assertRaises(SF.ConfigError):
            SF.load_settings(dict(env, SHOPIFY_SHOP='evil.example.com'))   # 秘密を別の宛先に送らない

    def test_write_result_and_batch_name(self):
        d = tempfile.mkdtemp()
        try:
            p = SF.write_result(d, 'fulfill-20261110T0900', {'ok': True, 'results': []})
            self.assertTrue(os.path.exists(p))
            self.assertEqual(json.load(open(p, encoding='utf-8'))['ok'], True)
            for bad in ('', '../x', 'a b', 'a/b'):
                with self.assertRaises(SF.ConfigError):
                    SF.write_result(d, bad, {})
        finally:
            shutil.rmtree(d)

    def test_log_has_no_secret_or_personal_info(self):
        s = FakeSession({'1772': order('1772', fos=['OPEN'])})
        lines = []
        SF.run({'orders': [ITEM]}, SETTINGS, session=s, sleep=lambda x: None, log=lines.append, batch='b')
        text = '\n'.join(lines)
        self.assertNotIn('secret-value', text)
        self.assertNotIn(ITEM['url'], text)


if __name__ == '__main__':
    unittest.main()
