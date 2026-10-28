"""scripts/shopify_fetch.py のテスト。API応答は架空の値で作る（実際の顧客データは使わない）。
実行: python -m unittest tests.test_shopify_fetch -v  （または python tests/test_shopify_fetch.py）
できたCSVは node で ec_sales_core.js の EC.groupShopifyOrders / EC.groupPayouts にも通す（node がなければその分は飛ばす）。
"""
import csv
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
try:
    import requests  # noqa: F401
except ImportError:  # requests が入っていない環境でも読み込めるように
    stub = types.ModuleType('requests')
    stub.exceptions = types.SimpleNamespace(RequestException=Exception)
    sys.modules['requests'] = stub
SPEC = importlib.util.spec_from_file_location('shopify_fetch', ROOT / 'scripts/shopify_fetch.py')
SF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SF)

JST = SF.timezone(SF.timedelta(hours=9))


def mb(a, cur='JPY'):
    return {'shopMoney': {'amount': a, 'currencyCode': cur}}


def line(name, qty, price, sku='', unful=None, disc='0.0'):
    return {'quantity': qty, 'name': name, 'sku': sku, 'vendor': 'テスト店', 'requiresShipping': True, 'taxable': True,
            'unfulfilledQuantity': qty if unful is None else unful, 'originalUnitPriceSet': mb(price), 'totalDiscountSet': mb(disc)}


def addr(name, zip_, phone):
    return {'name': name, 'company': '', 'zip': zip_, 'province': '東京都', 'provinceCode': 'JP-13', 'city': '千代田区',
            'address1': '架空1-2-3', 'address2': 'テストビル4F', 'phone': phone, 'countryCodeV2': 'JP'}


def order(name, lines, total='17050.0', **over):
    o = {
        'id': 'gid://shopify/Order/' + name.strip('#'), 'name': name, 'email': 'taro@example.com', 'phone': None, 'note': 'メモ',
        'tags': ['a', 'b'], 'cancelledAt': None, 'createdAt': '2026-10-15T03:29:02Z', 'sourceName': 'web',
        'displayFinancialStatus': 'PAID', 'displayFulfillmentStatus': 'UNFULFILLED', 'currencyCode': 'JPY',
        'totalPriceSet': mb(total), 'subtotalPriceSet': mb('15400.0'), 'totalShippingPriceSet': mb('1650.0'),
        'totalTaxSet': mb('1550.0'), 'totalDiscountsSet': mb('0.0'), 'totalRefundedSet': mb('0.0'),
        'discountCodes': [], 'paymentGatewayNames': ['shopify_payments'], 'shippingLine': {'title': '佐川急便'},
        'shippingAddress': addr('架空 太郎', '100-0001', '09012345678'), 'billingAddress': addr('架空 太郎', '100-0001', ''),
        'lineItems': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'nodes': lines},
    }
    o.update(over)
    return o


ORDERS = [
    order('#9001', [line('FLATCART 2x4（ブラック） - オプションは注文しない', 1, '15400.0', 'FC')]),
    order('#9002', [line('テーブルコンテナ', 2, '5000.0', 'TC', unful=0), line('バッグ', 1, '3000.0', '')], total='15500.0',
          displayFulfillmentStatus='FULFILLED', discountCodes=['WELCOME'], paymentGatewayNames=['shopify_payments', 'bank_deposit'],
          cancelledAt='2026-10-16T01:00:00Z', displayFinancialStatus='PARTIALLY_REFUNDED', totalRefundedSet=mb('5000.0')),
]
SUMMARY_KEYS = ['chargesGross', 'chargesFee', 'refundsFeeGross', 'refundsFee', 'adjustmentsGross', 'adjustmentsFee',
                'advanceGross', 'advanceFees', 'reservedFundsGross', 'reservedFundsFee', 'retriedPayoutsGross', 'retriedPayoutsFee']


def summary(**kv):
    s = {k: {'amount': '0.0'} for k in SUMMARY_KEYS}
    s.update({k: {'amount': v} for k, v in kv.items()})
    return s


PAYOUTS = [
    {'id': 'gid://shopify/ShopifyPaymentsPayout/11', 'issuedAt': '2026-10-16T00:00:00Z', 'status': 'PAID',
     'net': {'amount': '128504.0', 'currencyCode': 'JPY'}, 'summary': summary(chargesGross='133100.0', chargesFee='4596.0')},
    {'id': 'gid://shopify/ShopifyPaymentsPayout/12', 'issuedAt': '2026-10-23T00:00:00Z', 'status': 'SCHEDULED',
     'net': {'amount': '16470.0', 'currencyCode': 'JPY'}, 'summary': summary(chargesGross='17050.0', chargesFee='580.0')},
]


def txn(typ, order_name, amount, fee, net, payout, status='PAID', date='2026-10-14T02:00:00Z', test=False):
    return {'id': 'gid://x/' + order_name + typ, 'type': typ, 'test': test, 'transactionDate': date,
            'amount': {'amount': amount, 'currencyCode': 'JPY'}, 'fee': {'amount': fee}, 'net': {'amount': net},
            'associatedOrder': {'name': order_name} if order_name else None,
            'associatedPayout': {'id': 'gid://shopify/ShopifyPaymentsPayout/' + payout, 'status': status} if payout else None}


TXNS = [
    txn('CHARGE', '#9001', '17050.0', '580.0', '16470.0', '12', 'SCHEDULED'),
    txn('CHARGE', '#9002', '133100.0', '4596.0', '128504.0', '11'),
    txn('PAYOUT', '', '-128504.0', '0.0', '-128504.0', '11'),                       # 入金そのものの行（出さない）
    txn('CHARGE', '#9999', '1.0', '0.0', '1.0', '11', test=True),                   # テスト取引（出さない）
    txn('CHARGE', '#8000', '5000.0', '100.0', '4900.0', '5'),                        # 期間より前の入金に属する（出さない）
    txn('TRANSFER', '', '-128504.0', '0.0', '-128504.0', '11'),                      # 実機のAPIでは入金の行は TRANSFER（出さない）
    txn('TRANSFER_FAILURE', '', '0.0', '0.0', '0.0', '11'),
]


class FakeClient:
    """ShopifyClient の代わり。クエリの種類で応答を返す。ページングも再現する。"""

    def __init__(self, orders=ORDERS, payouts=PAYOUTS, txns=TXNS, page=1):
        self.orders, self.payouts, self.txns, self.page, self.calls = orders, payouts, txns, page, []

    def _page(self, items, after):
        i = int(after or 0)
        more = i + self.page < len(items)
        return {'pageInfo': {'hasNextPage': more, 'endCursor': str(i + self.page)}, 'nodes': items[i:i + self.page]}

    def execute(self, query, variables=None):
        v = variables or {}
        self.calls.append((query, v))
        if 'MoreLines' in query:
            return {'order': {'lineItems': {'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'nodes': [line('追加の行', 1, '100.0')]}}}
        if 'orders(' in query:
            return {'orders': self._page(self.orders, v.get('after'))}
        if 'payouts(' in query:
            return {'shopifyPaymentsAccount': {'payouts': self._page(self.payouts, v.get('after'))}}
        return {'shopifyPaymentsAccount': {'balanceTransactions': self._page(self.txns, v.get('after'))}}


def settings(d, **over):
    s = {'shop': 'demo.myshopify.com', 'token': 'shpat_dummy', 'dir': d, 'version': '2026-07', 'days': 90, 'tz': JST}
    s.update(over)
    return s


def read(path):
    with open(path, encoding='utf-8', newline='') as f:
        return list(csv.reader(f))


def read_dicts(path):
    rows = read(path)
    return [dict(zip(rows[0], x)) for x in rows[1:]]


NOW = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def go(self, client=None, **over):
        SF.run(settings(self.tmp, **over), client=client or FakeClient(), log=lambda m: None, now=NOW)

    def test_headers_match_shopify_export(self):
        self.go()
        self.assertEqual(read(self.tmp + '/ec_shopify_orders.csv')[0], SF.ORDER_COLUMNS)
        self.assertEqual(len(SF.ORDER_COLUMNS), 79)
        self.assertEqual(read(self.tmp + '/ec_shopify_payouts.csv')[0], SF.PAYOUT_COLUMNS)
        self.assertEqual(len(SF.PAYOUT_COLUMNS), 13)
        self.assertEqual(read(self.tmp + '/ec_shopify_transactions.csv')[0], SF.TRANSACTION_COLUMNS)
        self.assertEqual(len(SF.TRANSACTION_COLUMNS), 17)

    def test_order_values_and_multiline(self):
        self.go()
        a, b, c = read_dicts(self.tmp + '/ec_shopify_orders.csv')       # 1件 + 2行の注文
        self.assertEqual((a['Name'], a['Total'], a['Subtotal'], a['Shipping'], a['Taxes']), ('#9001', '17050', '15400', '1650', '1550'))
        self.assertEqual(a['Created at'], '2026-10-15 12:29:02 +0900')
        self.assertEqual((a['Financial Status'], a['Fulfillment Status']), ('paid', 'unfulfilled'))
        self.assertEqual(a['Lineitem fulfillment status'], 'pending')
        self.assertEqual((a['Shipping Zip'], a['Shipping Phone'], a['Billing Phone']), ("'100-0001", "'09012345678", ''))
        self.assertEqual((a['Shipping Province Name'], a['Shipping City'], a['Shipping Address1'], a['Shipping Address2']),
                         ('東京都', '千代田区', '架空1-2-3', 'テストビル4F'))
        self.assertEqual((a['Payment Method'], a['Shipping Method'], a['Notes'], a['Tags']), ('shopify_payments', '佐川急便', 'メモ', 'a, b'))
        # 2件目：先頭行に注文の値、2行目以降は Name と Lineitem だけ
        self.assertEqual((b['Total'], b['Discount Code'], b['Refunded Amount'], b['Cancelled at']),
                         ('15500', 'WELCOME', '5000', '2026-10-16 10:00:00 +0900'))
        self.assertEqual((b['Financial Status'], b['Fulfillment Status'], b['Payment Method']),
                         ('partially_refunded', 'fulfilled', 'shopify_payments + bank_deposit'))
        self.assertEqual((b['Lineitem quantity'], b['Lineitem price'], b['Lineitem fulfillment status']), ('2', '5000', 'fulfilled'))
        self.assertEqual(c['Name'], '#9002')
        self.assertEqual(c['Total'], '')
        self.assertEqual({k for k, v in c.items() if v != ''} - {'Name'},
                         {'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem requires shipping', 'Lineitem taxable',
                          'Lineitem fulfillment status', 'Lineitem discount', 'Vendor'})

    def test_payouts_and_transactions(self):
        self.go()
        p = read_dicts(self.tmp + '/ec_shopify_payouts.csv')
        self.assertEqual([x['Payout Date'] for x in p], ['2026-10-23', '2026-10-16'])      # 新しい順
        self.assertEqual((p[1]['Status'], p[1]['Charges'], p[1]['Fees'], p[1]['Total'], p[1]['Currency']),
                         ('paid', '133100', '4596', '128504', 'JPY'))
        self.assertEqual(p[0]['Status'], 'scheduled')
        t = read_dicts(self.tmp + '/ec_shopify_transactions.csv')
        self.assertEqual(sorted(x['Order'] for x in t if x['Type'] == 'charge'), ['#9001', '#9002'])
        self.assertFalse([x for x in t if x['Type'] in ('payout', 'transfer') or x['Order'] in ('#9999', '#8000')])
        x = [y for y in t if y['Order'] == '#9001'][0]
        self.assertEqual((x['Amount'], x['Fee'], x['Net'], x['Payout Date'], x['Payout Status'], x['Payout ID'], x['Currency']),
                         ('17050', '580', '16470', '2026-10-23', 'pending', '12', 'JPY'))
        self.assertEqual(x['Transaction Date'], '2026-10-14 11:00:00 +0900')
        self.assertIn('transfer_failure', [y['Type'] for y in t])

    def test_paging_and_extra_lines(self):
        many = order('#9003', [line('a', 1, '1.0')])
        many['lineItems']['pageInfo'] = {'hasNextPage': True, 'endCursor': 'c'}
        c = FakeClient(orders=ORDERS + [many], page=1)
        self.go(client=c)
        names = [x['Name'] for x in read_dicts(self.tmp + '/ec_shopify_orders.csv')]
        self.assertEqual(names.count('#9003'), 2)           # 1行目 + 追加の行
        self.assertEqual(len([1 for q, v in c.calls if 'orders(' in q]), 3)   # 注文は3ページ

    def test_failure_keeps_previous_files(self):
        self.go()
        before = Path(self.tmp, 'ec_shopify_orders.csv').read_bytes()
        bad = FakeClient()
        bad.execute = Mock(side_effect=[
            {'orders': {'pageInfo': {'hasNextPage': False}, 'nodes': ORDERS}}, SF.FetchError('入金で失敗')])
        with self.assertRaises(SF.FetchError):
            self.go(client=bad)
        self.assertEqual(Path(self.tmp, 'ec_shopify_orders.csv').read_bytes(), before)
        self.assertEqual([f for f in os.listdir(self.tmp) if f.endswith('.tmp')], [])

    def test_zero_orders_is_error(self):
        with self.assertRaises(SF.FetchError):
            self.go(client=FakeClient(orders=[]))

    def test_log_written_without_secrets(self):
        SF.run(settings(self.tmp), client=FakeClient(), now=NOW)
        log = Path(self.tmp, '_rpa_queue', 'logs', 'shopify_fetch.log').read_text(encoding='utf-8')
        self.assertIn('保存しました', log)
        self.assertNotIn('shpat_dummy', log)
        self.assertNotIn('demo.myshopify.com', log)

    @unittest.skipUnless(shutil.which('node'), 'node がありません')
    def test_screen_parsers_read_output(self):
        self.go()
        js = """
const fs = require('fs'), EC = require(process.argv[1]);
const obj = f => { const r = EC.parseDelimited(fs.readFileSync(process.argv[2] + '/' + f, 'utf8'), ','); const h = r.shift();
  return r.filter(x => x.length > 1).map(x => Object.fromEntries(h.map((k, i) => [k, x[i] || '']))); };
const orders = EC.groupShopifyOrders(obj('ec_shopify_orders.csv'));
const groups = EC.groupPayouts(obj('ec_shopify_transactions.csv'), obj('ec_shopify_payouts.csv'), () => '000001');
console.log(JSON.stringify({ orders, groups }));
"""
        out = subprocess.run(['node', '-e', js, str(ROOT / 'ec_sales_core.js'), self.tmp],
                             capture_output=True, text=True, encoding='utf-8', check=True)
        d = json.loads(out.stdout)
        o = {x['name']: x for x in d['orders']}
        self.assertEqual(sorted(o), ['#9001', '#9002'])
        self.assertEqual((o['#9001']['total'], o['#9001']['createdAt'], o['#9001']['createdTime']), (17050, '2026-10-15', '12:29'))
        self.assertEqual(o['#9001']['ship']['zip'], '100-0001')
        self.assertEqual(o['#9001']['ship']['phone'], '09012345678')
        self.assertEqual(o['#9001']['ship']['province'], '東京都')
        self.assertEqual(len(o['#9002']['lines']), 2)
        self.assertEqual((o['#9002']['cancelledAt'], o['#9002']['refunded']), ('2026-10-16', 5000))
        g = {x['date']: x for x in d['groups']}
        self.assertEqual(sorted(g), ['2026-10-16', '2026-10-23'])
        self.assertTrue(g['2026-10-16']['match'])
        self.assertEqual((g['2026-10-16']['bank'], g['2026-10-16']['total']), (128504, 128504))
        self.assertTrue(g['2026-10-23']['match'])


class ClientTests(unittest.TestCase):
    def resp(self, status, body=None, headers=None):
        r = Mock(status_code=status, headers=headers or {})
        r.json.return_value = body or {}
        return r

    def client(self, responses):
        sess = Mock()
        sess.post.side_effect = responses
        sleeps = []
        return SF.ShopifyClient('demo.myshopify.com', 'tok', '2026-07', session=sess, sleep=sleeps.append), sess, sleeps

    def test_retries_then_succeeds(self):
        throttled = {'errors': [{'message': 'Throttled', 'extensions': {'code': 'THROTTLED'}}]}
        c, sess, sleeps = self.client([self.resp(429, headers={'Retry-After': '3'}), self.resp(503),
                                       self.resp(200, throttled), self.resp(200, {'data': {'ok': 1}})])
        self.assertEqual(c.execute('q'), {'ok': 1})
        self.assertEqual(sess.post.call_count, 4)
        self.assertEqual(sleeps[0], 3)
        self.assertEqual(sess.post.call_args.kwargs['headers']['X-Shopify-Access-Token'], 'tok')

    def test_gives_up(self):
        c, _, _ = self.client([self.resp(503)] * SF.MAX_RETRIES)
        with self.assertRaises(SF.FetchError):
            c.execute('q')

    def test_access_denied_message(self):
        c, _, _ = self.client([self.resp(200, {'errors': [{'message': 'no scope', 'extensions': {'code': 'ACCESS_DENIED'}}]})])
        with self.assertRaisesRegex(SF.FetchError, 'アクセス権限'):
            c.execute('q')

    def test_unauthorized(self):
        c, _, _ = self.client([self.resp(401)])
        with self.assertRaisesRegex(SF.FetchError, '拒否'):
            c.execute('q')


class AuthTests(unittest.TestCase):
    """client credentials（Dev Dashboard のアプリ）と固定トークン。秘密は ID/secret ともダミー"""
    SECRET = 'dummy-secret-xyz'

    def resp(self, status, body=None):
        r = Mock(status_code=status, headers={})
        r.json.return_value = body or {}
        return r

    def token_resp(self, tok='tok-1', ttl=86399):
        return self.resp(200, {'access_token': tok, 'scope': 'read_orders', 'expires_in': ttl})

    def test_client_credentials_token_is_used_for_graphql(self):
        sess = Mock()
        sess.post.side_effect = [self.token_resp('tok-1'), self.resp(200, {'data': {'ok': 1}}), self.resp(200, {'data': {'ok': 2}})]
        auth = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess)
        c = SF.ShopifyClient('demo.myshopify.com', auth, '2026-07', session=sess, sleep=lambda s: None)
        self.assertEqual(c.execute('q'), {'ok': 1})
        self.assertEqual(c.execute('q'), {'ok': 2})            # 2回目はトークンを使い回す
        self.assertEqual(sess.post.call_count, 3)
        tok_call = sess.post.call_args_list[0]
        self.assertEqual(tok_call.args[0], 'https://demo.myshopify.com/admin/oauth/access_token')
        self.assertEqual(tok_call.kwargs['data'], {'grant_type': 'client_credentials', 'client_id': 'cid', 'client_secret': self.SECRET})
        self.assertEqual(sess.post.call_args_list[1].kwargs['headers']['X-Shopify-Access-Token'], 'tok-1')

    def test_refetch_when_near_expiry(self):
        now = [1000.0]
        sess = Mock()
        sess.post.side_effect = [self.token_resp('a', 3600), self.token_resp('b', 3600)]
        auth = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess, clock=lambda: now[0])
        self.assertEqual(auth.get(), 'a')
        now[0] += 3000
        self.assertEqual(auth.get(), 'a')                      # まだ有効
        now[0] += 560                                           # 残り40秒（60秒を切った）
        self.assertEqual(auth.get(), 'b')

    def test_static_token_still_works(self):
        sess = Mock()
        sess.post.return_value = self.resp(200, {'data': {'ok': 1}})
        c = SF.ShopifyClient('demo.myshopify.com', 'shpat_fixed', '2026-07', session=sess)
        self.assertEqual(c.execute('q'), {'ok': 1})
        self.assertEqual(sess.post.call_args.kwargs['headers']['X-Shopify-Access-Token'], 'shpat_fixed')
        self.assertEqual(sess.post.call_count, 1)

    def test_token_failure_does_not_leak_secret(self):
        for r in (self.resp(400, {'error': 'shop_not_permitted', 'error_description': 'Client credentials cannot be performed on this shop. ' + self.SECRET}),
                  self.resp(401, {'error': 'invalid_client', 'error_description': self.SECRET}), self.resp(200, {})):
            sess = Mock()
            sess.post.return_value = r
            auth = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess)
            with self.assertRaises(SF.FetchError) as cm:
                auth.get()
            self.assertNotIn(self.SECRET, str(cm.exception))
        sess = Mock()
        sess.post.return_value = self.resp(400, {'error': 'shop_not_permitted'})
        with self.assertRaisesRegex(SF.FetchError, '同じ Shopify 組織'):
            SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess).get()

    def test_connection_error_does_not_leak_secret(self):
        sess = Mock()
        sess.post.side_effect = SF.requests.exceptions.RequestException('failed ' + self.SECRET)
        with self.assertRaises(SF.FetchError) as cm:
            SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess).get()
        self.assertNotIn(self.SECRET, str(cm.exception))

    def test_401_refetches_token_once(self):
        sess = Mock()
        sess.post.side_effect = [self.token_resp('old'), self.resp(401), self.token_resp('new'), self.resp(200, {'data': {'ok': 1}})]
        auth = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess)
        c = SF.ShopifyClient('demo.myshopify.com', auth, '2026-07', session=sess, sleep=lambda s: None)
        self.assertEqual(c.execute('q'), {'ok': 1})
        self.assertEqual(sess.post.call_args_list[3].kwargs['headers']['X-Shopify-Access-Token'], 'new')
        # 取り直しても401なら、それ以上は繰り返さない
        sess2 = Mock()
        sess2.post.side_effect = [self.token_resp('old'), self.resp(401), self.token_resp('new'), self.resp(401)]
        auth2 = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess2)
        c2 = SF.ShopifyClient('demo.myshopify.com', auth2, '2026-07', session=sess2, sleep=lambda s: None)
        with self.assertRaisesRegex(SF.FetchError, '拒否'):
            c2.execute('q')
        self.assertEqual(sess2.post.call_count, 4)

    def test_static_token_401_is_not_retried(self):
        sess = Mock()
        sess.post.return_value = self.resp(401)
        c = SF.ShopifyClient('demo.myshopify.com', 'shpat_fixed', '2026-07', session=sess)
        with self.assertRaises(SF.FetchError):
            c.execute('q')
        self.assertEqual(sess.post.call_count, 1)

    def test_token_not_in_log_or_files(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        sess = Mock()
        sess.post.return_value = self.token_resp('tok-secret-abc')
        log = SF.Logger(tmp)
        auth = SF.ClientCredentialsToken('demo.myshopify.com', 'cid', self.SECRET, session=sess, log=log)
        auth.get()
        text = Path(tmp, '_rpa_queue', 'logs', 'shopify_fetch.log').read_text(encoding='utf-8')
        self.assertNotIn('tok-secret-abc', text)
        self.assertNotIn(self.SECRET, text)


class SettingsTests(unittest.TestCase):
    def test_auth_modes(self):
        base = {'SHOPIFY_SHOP': 'demo.myshopify.com', 'SHARED_MASTERS_DIR': 'x'}
        with self.assertRaisesRegex(SF.ConfigError, 'SHOPIFY_CLIENT_ID.*SHOPIFY_ACCESS_TOKEN'):
            SF.load_settings(base)
        with self.assertRaisesRegex(SF.ConfigError, '両方'):
            SF.load_settings(dict(base, SHOPIFY_CLIENT_ID='a'))
        s = SF.load_settings(dict(base, SHOPIFY_CLIENT_ID='a', SHOPIFY_CLIENT_SECRET='b'))
        self.assertEqual((s['client_id'], s['client_secret'], s['token']), ('a', 'b', ''))
        s = SF.load_settings(dict(base, SHOPIFY_ACCESS_TOKEN='t'))
        self.assertEqual((s['client_id'], s['token']), ('', 't'))

    def test_missing_env(self):
        with self.assertRaisesRegex(SF.ConfigError, 'SHOPIFY_SHOP.*SHOPIFY_ACCESS_TOKEN'):
            SF.load_settings({'SHARED_MASTERS_DIR': 'x'})

    def test_shop_must_be_myshopify(self):
        env = {'SHOPIFY_SHOP': 'evil.example.com', 'SHOPIFY_ACCESS_TOKEN': 't', 'SHARED_MASTERS_DIR': 'x'}
        with self.assertRaises(SF.ConfigError):
            SF.load_settings(env)
        env['SHOPIFY_SHOP'] = 'https://Demo.myshopify.com/'
        s = SF.load_settings(env)
        self.assertEqual((s['shop'], s['days'], s['version']), ('demo.myshopify.com', 90, SF.DEFAULT_API_VERSION))
        env.update(SHOPIFY_FETCH_DAYS='365', SHOPIFY_API_VERSION='2026-10')
        s = SF.load_settings(env)
        self.assertEqual((s['days'], s['version']), (365, '2026-10'))

    def test_main_exit_code_2_without_env(self):
        keys = ('SHOPIFY_SHOP', 'SHOPIFY_ACCESS_TOKEN', 'SHARED_MASTERS_DIR')
        old = {k: os.environ.pop(k, None) for k in keys}
        try:
            self.assertEqual(SF.main(), 2)
        finally:
            os.environ.update({k: v for k, v in old.items() if v is not None})


if __name__ == '__main__':
    unittest.main()
