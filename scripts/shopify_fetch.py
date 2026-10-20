#!/usr/bin/env python3
"""
Shopify の注文・入金を Admin GraphQL API で取得し、EC売上アプリ(ec_sales.html)が
読む形の CSV で SharedMasters 直下に上書き保存する。

RPA専用機のタスクスケジューラーから、平日 8〜18時の毎時0分に実行する想定。
手順は scripts/rpa_setup/ec_shopify_fetch_setup.md、約束事は
scripts/rpa_setup/EC売上_RPA専用機への依頼内容.md の「1. Shopify の定期取得」。

出力 (SHARED_MASTERS_DIR 直下。Shopify 管理画面の CSV エクスポートと同じ列):
  - ec_shopify_orders.csv        ← orders_export（注文1件で商品が複数なら複数行。先頭行に注文の値、
                                    2行目以降は Name と Lineitem の列だけ）
  - ec_shopify_payouts.csv       ← payouts_export
  - ec_shopify_transactions.csv  ← payment_transactions_export
  3つとも取得できたときだけ置き換える（一時ファイルに書いて最後に置き換え。失敗時は前回のファイルが残る）。

環境変数:
  SHOPIFY_SHOP          - ストアのドメイン（xxxx.myshopify.com）。必須
  認証（次のどちらか。秘密の値はコード・ログ・エラーメッセージに出さない）:
    SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET - Dev Dashboard のアプリ（2026/1/1 以降に作るアプリはこちら）。
                          実行のたびに client credentials grant でトークンを取得する（約24時間で切れる。メモリだけに持つ）。
                          両方あればこちらを使う
    SHOPIFY_ACCESS_TOKEN  - 固定の Admin API アクセストークン（shpat_…。既存のレガシーなカスタムアプリ用）
  SHARED_MASTERS_DIR    - OneDrive 同期済みの SharedMasters フォルダのパス。必須
  SHOPIFY_API_VERSION   - (任意) Admin API のバージョン。既定 DEFAULT_API_VERSION
  SHOPIFY_FETCH_DAYS    - (任意) 直近何日ぶん取るか。既定 90。read_all_orders がないと Shopify は
                          60日より前の注文を返さない
  SHOPIFY_TZ_OFFSET_HOURS - (任意) 日時をそろえる時差。既定 9（日本時間。エクスポートの "+0900" と同じ）

終了コード: 0=成功、1=取得・保存の失敗（前回のファイルは残る）、2=設定が足りない
"""
import csv
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import requests

DEFAULT_API_VERSION = '2026-07'
DEFAULT_DAYS = 90
ORDERS_PAGE = 25          # GraphQL のコスト上限(1000)に収めるため小さめ
LINES_PAGE = 20
PAYOUTS_PAGE = 50
TXN_PAGE = 100
MAX_RETRIES = 6
TXN_MARGIN_DAYS = 7       # 入金日が期間内の入金に入る取引は、期間の少し前から始まっていることがある

ORDERS_CSV = 'ec_shopify_orders.csv'
PAYOUTS_CSV = 'ec_shopify_payouts.csv'
TRANSACTIONS_CSV = 'ec_shopify_transactions.csv'
LOG_NAME = 'shopify_fetch.log'

SHOP_RE = re.compile(r'^[a-z0-9][a-z0-9-]*\.myshopify\.com$')

# Shopify 管理画面「注文のエクスポート」の見出し（順番もそのまま）
ORDER_COLUMNS = [
    'Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at', 'Accepts Marketing',
    'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total', 'Discount Code', 'Discount Amount', 'Shipping Method',
    'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price',
    'Lineitem sku', 'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status',
    'Billing Name', 'Billing Street', 'Billing Address1', 'Billing Address2', 'Billing Company', 'Billing City',
    'Billing Zip', 'Billing Province', 'Billing Country', 'Billing Phone', 'Shipping Name', 'Shipping Street',
    'Shipping Address1', 'Shipping Address2', 'Shipping Company', 'Shipping City', 'Shipping Zip',
    'Shipping Province', 'Shipping Country', 'Shipping Phone', 'Notes', 'Note Attributes', 'Cancelled at',
    'Payment Method', 'Payment Reference', 'Refunded Amount', 'Vendor', 'Outstanding Balance', 'Employee',
    'Location', 'Device ID', 'Id', 'Tags', 'Risk Level', 'Source', 'Lineitem discount', 'Tax 1 Name',
    'Tax 1 Value', 'Tax 2 Name', 'Tax 2 Value', 'Tax 3 Name', 'Tax 3 Value', 'Tax 4 Name', 'Tax 4 Value',
    'Tax 5 Name', 'Tax 5 Value', 'Phone', 'Receipt Number', 'Duties', 'Billing Province Name',
    'Shipping Province Name', 'Payment ID', 'Payment Terms Name', 'Next Payment Due At', 'Payment References',
]
# 「入金」のエクスポート
PAYOUT_COLUMNS = [
    'Payout Date', 'Status', 'Charges', 'Refunds', 'Adjustments', 'Marketplace Sales Tax', 'Advances',
    'Reserved Funds', 'Fees', 'Retried Amount', 'Total', 'Currency', 'Bank Reference',
]
# 「支払いの取引」のエクスポート
TRANSACTION_COLUMNS = [
    'Transaction Date', 'Type', 'Order', 'Card Brand', 'Card Source', 'Payout Status', 'Payout Date',
    'Payout ID', 'Available On', 'Amount', 'Fee', 'Net', 'Checkout', 'Payment Method Name',
    'Presentment Amount', 'Presentment Currency', 'Currency',
]


class FetchError(Exception):
    """取得・保存の失敗（前回のファイルは残す）"""


class ConfigError(Exception):
    """環境変数など、設定が足りない"""


# ---------------------------------------------------------------- 設定・ログ
def load_settings(env=None):
    env = os.environ if env is None else env
    def val(k):
        return (env.get(k) or '').strip()

    missing = [k for k in ('SHOPIFY_SHOP', 'SHARED_MASTERS_DIR') if not val(k)]
    cid, csec, tok = val('SHOPIFY_CLIENT_ID'), val('SHOPIFY_CLIENT_SECRET'), val('SHOPIFY_ACCESS_TOKEN')
    if bool(cid) != bool(csec):
        raise ConfigError('SHOPIFY_CLIENT_ID と SHOPIFY_CLIENT_SECRET は両方設定してください')
    if not (cid or tok):
        missing.append('SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET（または SHOPIFY_ACCESS_TOKEN）')
    if missing:
        raise ConfigError('環境変数が設定されていません: ' + ', '.join(missing)
                          + '（手順は scripts/rpa_setup/ec_shopify_fetch_setup.md）')
    shop = env['SHOPIFY_SHOP'].strip().lower()
    shop = re.sub(r'^https?://', '', shop).rstrip('/')
    if not SHOP_RE.match(shop):
        # トークンを意図しない宛先に送らないよう、myshopify.com 以外は受け付けない
        raise ConfigError('SHOPIFY_SHOP は「xxxx.myshopify.com」の形で指定してください')
    try:
        days = int((env.get('SHOPIFY_FETCH_DAYS') or DEFAULT_DAYS))
        tz = float(env.get('SHOPIFY_TZ_OFFSET_HOURS') or 9)
    except ValueError:
        raise ConfigError('SHOPIFY_FETCH_DAYS / SHOPIFY_TZ_OFFSET_HOURS は数字で指定してください')
    if days < 1:
        raise ConfigError('SHOPIFY_FETCH_DAYS は1以上にしてください')
    return {
        'shop': shop,
        'client_id': cid, 'client_secret': csec, 'token': tok,
        'dir': env['SHARED_MASTERS_DIR'].strip(),
        'version': (env.get('SHOPIFY_API_VERSION') or DEFAULT_API_VERSION).strip(),
        'days': days,
        'tz': timezone(timedelta(hours=tz)),
    }


class Logger:
    """SharedMasters/_rpa_queue/logs/ に追記する（rpa_queue_worker.ps1 と同じ「[日時] 内容」の1行形式）"""

    def __init__(self, shared_dir):
        self.path = os.path.join(shared_dir, '_rpa_queue', 'logs', LOG_NAME)

    def __call__(self, message):
        line = '[{}] {}'.format(datetime.now().strftime('%Y-%m-%d %H:%M:%S'), message)
        print(line, flush=True)
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except OSError as e:
            print('(ログファイルに書けません: {})'.format(e), file=sys.stderr)


# ---------------------------------------------------------------- 認証
class StaticToken:
    """固定トークン（レガシーなカスタムアプリ）"""
    refreshable = False

    def __init__(self, token):
        self._token = token

    def get(self):
        return self._token

    def invalidate(self):
        pass


class ClientCredentialsToken:
    """Dev Dashboard のアプリ用。POST https://{shop}/admin/oauth/access_token（form: grant_type=client_credentials,
    client_id, client_secret）→ {access_token, scope, expires_in(=86399秒)}。トークンはメモリだけに持つ。
    残り60秒を切ったら取り直す。エラーには応答の中身・秘密を出さない（Shopify の error コードだけ）。"""
    refreshable = True
    REFRESH_MARGIN = 60

    def __init__(self, shop, client_id, client_secret, session=None, clock=time.time, log=None):
        self.url = 'https://{}/admin/oauth/access_token'.format(shop)
        self._id, self._secret = client_id, client_secret
        self.session = session or requests
        self.clock = clock
        self.log = log or (lambda m: None)
        self._token, self._expires = None, 0

    def invalidate(self):
        self._token = None

    def get(self):
        if self._token and self.clock() < self._expires - self.REFRESH_MARGIN:
            return self._token
        try:
            res = self.session.post(self.url, timeout=60, headers={'Accept': 'application/json'},
                                    data={'grant_type': 'client_credentials', 'client_id': self._id,
                                          'client_secret': self._secret})
        except requests.exceptions.RequestException as e:
            raise FetchError('トークン取得で接続エラー（{}）'.format(type(e).__name__))
        code = ''
        try:
            body = res.json()
            code = str(body.get('error') or '') if isinstance(body, dict) else ''
        except ValueError:
            body = None
        token = body.get('access_token') if isinstance(body, dict) else None
        if res.status_code != 200 or not token:
            hint = ''
            if code == 'shop_not_permitted':
                hint = '。アプリとストアが同じ Shopify 組織にあるか確認してください'
            elif res.status_code in (400, 401, 403):
                hint = '。Client ID / Client secret とストア名を確認してください'
            raise FetchError('トークンを取得できませんでした（HTTP {}{}）{}'.format(
                res.status_code, ' ' + code if re.fullmatch(r'[a-z_]{1,40}', code) else '', hint))
        try:
            ttl = float(body.get('expires_in') or 86399)
        except (TypeError, ValueError):
            ttl = 86399
        self._token, self._expires = token, self.clock() + ttl
        self.log('アクセストークンを取得しました（client credentials）')
        return self._token


# ---------------------------------------------------------------- GraphQL クライアント
class ShopifyClient:
    def __init__(self, shop, token, version, session=None, sleep=time.sleep, log=None):
        """token は固定トークンの文字列、または get()/invalidate() を持つトークン提供元"""
        self.url = 'https://{}/admin/api/{}/graphql.json'.format(shop, version)
        self.auth = StaticToken(token) if isinstance(token, str) else token
        self.session = session or requests
        self.sleep = sleep
        self.log = log or (lambda m: None)

    def execute(self, query, variables=None):
        """一時エラー(429・5xx・接続失敗・THROTTLED)は待って再試行。それ以外のエラーは FetchError。"""
        last, refreshed = '', False
        for attempt in range(MAX_RETRIES):
            wait = min(2 ** attempt, 60)
            headers = {'X-Shopify-Access-Token': self.auth.get(), 'Content-Type': 'application/json'}
            try:
                res = self.session.post(self.url, headers=headers, timeout=60,
                                        json={'query': query, 'variables': variables or {}})
            except requests.exceptions.RequestException as e:
                last = '接続エラー: ' + type(e).__name__
                self.log('{}（{}秒後に再試行 {}/{}）'.format(last, wait, attempt + 1, MAX_RETRIES))
                self.sleep(wait)
                continue
            if res.status_code in (429, 500, 502, 503, 504):
                try:
                    wait = max(wait, float(res.headers.get('Retry-After', 0)))
                except (TypeError, ValueError):
                    pass
                last = 'HTTP {}'.format(res.status_code)
                self.log('{}（{}秒後に再試行 {}/{}）'.format(last, wait, attempt + 1, MAX_RETRIES))
                self.sleep(wait)
                continue
            if res.status_code == 401 and self.auth.refreshable and not refreshed:
                refreshed = True   # 期限切れの可能性。1回だけ取り直して再実行
                self.auth.invalidate()
                self.log('HTTP 401（トークンを取り直して再実行）')
                continue
            if res.status_code in (401, 403):
                raise FetchError('Shopify に拒否されました（HTTP {}）。トークンかアクセス権限を確認してください'.format(res.status_code))
            if res.status_code != 200:
                raise FetchError('Shopify がエラーを返しました（HTTP {}）'.format(res.status_code))
            body = res.json()
            errors = body.get('errors')
            if errors:
                msgs = errors if isinstance(errors, list) else [errors]
                texts = [(m.get('message') if isinstance(m, dict) else str(m)) for m in msgs]
                codes = [((m.get('extensions') or {}).get('code') if isinstance(m, dict) else '') for m in msgs]
                if 'THROTTLED' in codes or any('Throttled' in (t or '') for t in texts):
                    last = 'レート制限(THROTTLED)'
                    self.log('{}（{}秒後に再試行 {}/{}）'.format(last, wait, attempt + 1, MAX_RETRIES))
                    self.sleep(wait)
                    continue
                if 'ACCESS_DENIED' in codes:
                    raise FetchError('アクセス権限が足りません: ' + '; '.join(t or '' for t in texts)
                                     + '（必要な権限は ec_shopify_fetch_setup.md を参照）')
                raise FetchError('GraphQL エラー: ' + '; '.join(t or '' for t in texts))
            return body.get('data') or {}
        raise FetchError('再試行しても取得できませんでした（最後のエラー: {}）'.format(last))


# ---------------------------------------------------------------- 値の整形
def gid_tail(gid):
    return str(gid or '').rsplit('/', 1)[-1]


def money(set_or_money):
    """MoneyBag(shopMoney) / MoneyV2 → (金額 Decimal, 通貨)"""
    if not set_or_money:
        return Decimal(0), ''
    m = set_or_money.get('shopMoney') or set_or_money
    try:
        return Decimal(str(m.get('amount') or '0')), m.get('currencyCode') or ''
    except InvalidOperation:
        return Decimal(0), ''


def fmt_amount(d):
    """エクスポートと同じ書き方：整数なら小数点なし（円）、小数があれば2桁"""
    if d == d.to_integral_value():
        return str(int(d))
    return '{:.2f}'.format(d)


def amount(set_or_money):
    return fmt_amount(money(set_or_money)[0])


def parse_iso(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def fmt_datetime(s, tz):
    """'2026-10-15T03:29:02Z' → '2026-10-15 12:29:02 +0900'"""
    if not s:
        return ''
    return parse_iso(s).astimezone(tz).strftime('%Y-%m-%d %H:%M:%S %z')


def fmt_date(s, tz):
    return parse_iso(s).astimezone(tz).strftime('%Y-%m-%d') if s else ''


def quoted(v):
    """郵便番号・電話番号は、エクスポートと同じく先頭に ' を付ける（Excel で 0 が消えないように）。画面側で外して読む"""
    return "'" + v if v else ''


def status_text(v):
    return (v or '').lower()


# ---------------------------------------------------------------- 注文
ORDER_FIELDS = '''
  id name email phone note tags cancelledAt createdAt sourceName
  displayFinancialStatus displayFulfillmentStatus
  currencyCode
  totalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  discountCodes
  paymentGatewayNames
  shippingLine { title }
  shippingAddress { name company zip province provinceCode city address1 address2 phone countryCodeV2 }
  billingAddress { name company zip province provinceCode city address1 address2 phone countryCodeV2 }
'''
LINE_FIELDS = '''
  quantity name sku vendor requiresShipping taxable unfulfilledQuantity
  originalUnitPriceSet { shopMoney { amount currencyCode } }
  totalDiscountSet { shopMoney { amount currencyCode } }
'''
ORDERS_QUERY = '''
query Orders($first: Int!, $after: String, $q: String, $lines: Int!) {
  orders(first: $first, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
''' + ORDER_FIELDS + '''
      lineItems(first: $lines) { pageInfo { hasNextPage endCursor } nodes { ''' + LINE_FIELDS + ''' } }
    }
  }
}
'''
MORE_LINES_QUERY = '''
query MoreLines($id: ID!, $after: String, $lines: Int!) {
  order(id: $id) {
    lineItems(first: $lines, after: $after) { pageInfo { hasNextPage endCursor } nodes { ''' + LINE_FIELDS + ''' } }
  }
}
'''


def since_date(days, tz, now=None):
    now = now or datetime.now(timezone.utc)
    return (now.astimezone(tz) - timedelta(days=days)).strftime('%Y-%m-%d')


def fetch_orders(client, since, log=None):
    orders, after = [], None
    while True:
        data = client.execute(ORDERS_QUERY, {'first': ORDERS_PAGE, 'after': after, 'lines': LINES_PAGE,
                                              'q': 'created_at:>=' + since})
        page = (data.get('orders') or {})
        for o in page.get('nodes') or []:
            li = o['lineItems']
            lines = list(li.get('nodes') or [])
            cursor = li['pageInfo'].get('endCursor')
            more = li['pageInfo'].get('hasNextPage')
            while more:   # 商品が多い注文は残りの行を続けて取る
                d = client.execute(MORE_LINES_QUERY, {'id': o['id'], 'after': cursor, 'lines': LINES_PAGE})
                li2 = d['order']['lineItems']
                lines += li2.get('nodes') or []
                cursor, more = li2['pageInfo'].get('endCursor'), li2['pageInfo'].get('hasNextPage')
            orders.append(dict(o, lineItems=lines))
        if not page.get('pageInfo', {}).get('hasNextPage'):
            break
        after = page['pageInfo']['endCursor']
    if log:
        log('注文 {} 件を取得'.format(len(orders)))
    return orders


def street(a):
    return ' '.join(x for x in ((a or {}).get('address1'), (a or {}).get('address2')) if x)


def address_cols(prefix, a):
    a = a or {}
    return {
        prefix + ' Name': a.get('name') or '', prefix + ' Street': street(a),
        prefix + ' Address1': a.get('address1') or '', prefix + ' Address2': a.get('address2') or '',
        prefix + ' Company': a.get('company') or '', prefix + ' City': a.get('city') or '',
        prefix + ' Zip': quoted(a.get('zip')), prefix + ' Province': a.get('provinceCode') or '',
        prefix + ' Country': a.get('countryCodeV2') or '', prefix + ' Phone': quoted(a.get('phone')),
        prefix + ' Province Name': a.get('province') or '',
    }


def line_cols(l):
    unful = l.get('unfulfilledQuantity')
    return {
        'Lineitem quantity': str(l.get('quantity') or 0), 'Lineitem name': l.get('name') or '',
        'Lineitem price': amount(l.get('originalUnitPriceSet')), 'Lineitem sku': l.get('sku') or '',
        'Lineitem requires shipping': 'true' if l.get('requiresShipping') else 'false',
        'Lineitem taxable': 'true' if l.get('taxable') else 'false',
        'Lineitem fulfillment status': 'pending' if (unful is None or unful > 0) else 'fulfilled',
        'Lineitem discount': amount(l.get('totalDiscountSet')), 'Vendor': l.get('vendor') or '',
    }


def fulfillment_text(v):
    v = status_text(v)
    return {'partially_fulfilled': 'partial'}.get(v, v)


def order_rows(orders, tz):
    """注文 → エクスポートと同じ形の行（dict）。先頭行に注文の値、2行目以降は Name と Lineitem のみ"""
    rows = []
    for o in orders:
        head = {
            'Name': o.get('name') or '', 'Email': o.get('email') or '',
            'Financial Status': status_text(o.get('displayFinancialStatus')),
            'Fulfillment Status': fulfillment_text(o.get('displayFulfillmentStatus')),
            'Accepts Marketing': '', 'Currency': o.get('currencyCode') or '',
            'Subtotal': amount(o.get('subtotalPriceSet')), 'Shipping': amount(o.get('totalShippingPriceSet')),
            'Taxes': amount(o.get('totalTaxSet')), 'Total': amount(o.get('totalPriceSet')),
            'Discount Code': ', '.join(o.get('discountCodes') or []), 'Discount Amount': amount(o.get('totalDiscountsSet')),
            'Shipping Method': (o.get('shippingLine') or {}).get('title') or '',
            'Created at': fmt_datetime(o.get('createdAt'), tz),
            'Notes': o.get('note') or '', 'Cancelled at': fmt_datetime(o.get('cancelledAt'), tz),
            'Payment Method': ' + '.join(o.get('paymentGatewayNames') or []),
            'Refunded Amount': amount(o.get('totalRefundedSet')), 'Id': gid_tail(o.get('id')),
            'Tags': ', '.join(o.get('tags') or []), 'Source': o.get('sourceName') or '',
            'Phone': quoted(o.get('phone')),
        }
        head.update(address_cols('Billing', o.get('billingAddress')))
        head.update(address_cols('Shipping', o.get('shippingAddress')))
        lines = o.get('lineItems') or []
        if not lines:
            rows.append(head)
            continue
        for i, l in enumerate(lines):
            r = dict(head) if i == 0 else {'Name': head['Name']}
            r.update(line_cols(l))
            rows.append(r)
    return rows


# ---------------------------------------------------------------- 入金・取引
PAYOUTS_QUERY = '''
query Payouts($first: Int!, $after: String, $q: String) {
  shopifyPaymentsAccount {
    payouts(first: $first, after: $after, query: $q, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id issuedAt status
        net { amount currencyCode }
        summary {
          chargesGross { amount } chargesFee { amount }
          refundsFeeGross { amount } refundsFee { amount }
          adjustmentsGross { amount } adjustmentsFee { amount }
          advanceGross { amount } advanceFees { amount }
          reservedFundsGross { amount } reservedFundsFee { amount }
          retriedPayoutsGross { amount } retriedPayoutsFee { amount }
        }
      }
    }
  }
}
'''
TXN_QUERY = '''
query Txns($first: Int!, $after: String, $q: String) {
  shopifyPaymentsAccount {
    balanceTransactions(first: $first, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type test transactionDate
        amount { amount currencyCode } fee { amount } net { amount }
        associatedOrder { name }
        associatedPayout { id status }
      }
    }
  }
}
'''


def _paged(client, query, field, variables, what, log=None):
    out, after = [], None
    while True:
        data = client.execute(query, dict(variables, after=after))
        acct = data.get('shopifyPaymentsAccount')
        if not acct:
            raise FetchError('Shopify Payments の情報を取得できません（Shopify Payments が有効か、'
                             'read_shopify_payments_payouts 権限があるか確認してください）')
        page = acct[field]
        out += page.get('nodes') or []
        if not page['pageInfo'].get('hasNextPage'):
            break
        after = page['pageInfo']['endCursor']
    if log:
        log('{} {} 件を取得'.format(what, len(out)))
    return out


def fetch_payouts(client, since, log=None):
    return _paged(client, PAYOUTS_QUERY, 'payouts', {'first': PAYOUTS_PAGE, 'q': 'issued_at:>=' + since}, '入金', log)


def fetch_transactions(client, since, log=None):
    start = (datetime.strptime(since, '%Y-%m-%d') - timedelta(days=TXN_MARGIN_DAYS)).strftime('%Y-%m-%d')
    return _paged(client, TXN_QUERY, 'balanceTransactions', {'first': TXN_PAGE, 'q': 'transaction_date:>=' + start},
                  '支払いの取引', log)


PAYOUT_STATUS = {'scheduled': 'scheduled', 'in_transit': 'in_transit', 'paid': 'paid', 'failed': 'failed', 'canceled': 'canceled'}
TXN_PAYOUT_STATUS = {'scheduled': 'pending', 'in_transit': 'in_transit', 'paid': 'paid', 'failed': 'failed', 'canceled': 'canceled'}
TXN_TYPE = {'payout_failure': 'transfer_failure', 'payout_cancellation': 'transfer_cancel'}


def payout_rows(payouts, tz):
    rows = []
    for p in payouts:
        s = p.get('summary') or {}
        g = lambda k: money(s.get(k))[0]   # noqa: E731
        fees = sum((g(k) for k in ('chargesFee', 'refundsFee', 'adjustmentsFee', 'advanceFees',
                                   'reservedFundsFee', 'retriedPayoutsFee')), Decimal(0))
        net, cur = money(p.get('net'))
        rows.append({
            'Payout Date': fmt_date(p.get('issuedAt'), tz), 'Status': PAYOUT_STATUS.get(status_text(p.get('status')), status_text(p.get('status'))),
            'Charges': fmt_amount(g('chargesGross')), 'Refunds': fmt_amount(g('refundsFeeGross')),
            'Adjustments': fmt_amount(g('adjustmentsGross')), 'Marketplace Sales Tax': '0',
            'Advances': fmt_amount(g('advanceGross')), 'Reserved Funds': fmt_amount(g('reservedFundsGross')),
            'Fees': fmt_amount(fees), 'Retried Amount': fmt_amount(g('retriedPayoutsGross')),
            'Total': fmt_amount(net), 'Currency': cur, 'Bank Reference': '',
        })
    rows.sort(key=lambda r: r['Payout Date'], reverse=True)
    return rows


def transaction_rows(txns, payouts, tz, since):
    """入金日は入金(payout)の issuedAt から引く。期間より前の入金に属する取引・入金の行そのものは入れない"""
    pay_date = {p['id']: fmt_date(p.get('issuedAt'), tz) for p in payouts}
    rows = []
    for t in txns:
        if t.get('test'):
            continue
        typ = status_text(t.get('type'))
        if typ == 'payout':      # 入金そのものの行。エクスポートには出てこない
            continue
        ap = t.get('associatedPayout') or {}
        pdate = pay_date.get(ap.get('id'), '') if ap else ''
        txn_date = fmt_date(t.get('transactionDate'), tz)
        if ap and not pdate:
            continue             # 期間より前の入金に属する取引
        if not ap and txn_date < since:
            continue
        amt, cur = money(t.get('amount'))
        rows.append({
            'Transaction Date': fmt_datetime(t.get('transactionDate'), tz), 'Type': TXN_TYPE.get(typ, typ),
            'Order': (t.get('associatedOrder') or {}).get('name') or '',
            'Payout Status': TXN_PAYOUT_STATUS.get(status_text(ap.get('status')), status_text(ap.get('status'))) if ap else '',
            'Payout Date': pdate, 'Payout ID': gid_tail(ap.get('id')) if ap else '',
            'Amount': fmt_amount(amt), 'Fee': fmt_amount(money(t.get('fee'))[0]), 'Net': fmt_amount(money(t.get('net'))[0]),
            'Presentment Amount': fmt_amount(amt), 'Presentment Currency': cur, 'Currency': cur,
        })
    rows.sort(key=lambda r: r['Transaction Date'], reverse=True)
    return rows


# ---------------------------------------------------------------- 保存
def write_csv(path, columns, rows):
    # Shopify のエクスポートと同じ UTF-8（BOMなし）。画面側は UTF-8 優先で読む
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction='raise', lineterminator='\r\n')
        w.writeheader()
        w.writerows(rows)


def save_all(out_dir, files):
    """files: {ファイル名: (見出し, 行)}。全部を一時ファイルに書けてから置き換える（途中で失敗したら前回のまま）"""
    os.makedirs(out_dir, exist_ok=True)
    temps = {}
    try:
        for name, (cols, rows) in files.items():
            tmp = os.path.join(out_dir, '.' + name + '.tmp')
            temps[name] = tmp
            write_csv(tmp, cols, rows)
        for name, tmp in temps.items():
            os.replace(tmp, os.path.join(out_dir, name))
            temps[name] = None
    finally:
        for tmp in temps.values():
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass


def run(settings, client=None, log=None, now=None):
    log = log or Logger(settings['dir'])
    if client is None:
        auth = (ClientCredentialsToken(settings['shop'], settings['client_id'], settings['client_secret'], log=log)
                if settings.get('client_id') else StaticToken(settings['token']))
        client = ShopifyClient(settings['shop'], auth, settings['version'], log=log)
    tz = settings['tz']
    since = since_date(settings['days'], tz, now)
    log('取得を開始します（{} 以降 / API {}）'.format(since, settings['version']))
    orders = fetch_orders(client, since, log)
    if not orders:
        raise FetchError('注文が0件でした（権限・期間の設定を確認。read_all_orders がないと60日より前は取れません）。前回のファイルは残します')
    payouts = fetch_payouts(client, since, log)
    txns = fetch_transactions(client, since, log)
    files = {
        ORDERS_CSV: (ORDER_COLUMNS, order_rows(orders, tz)),
        PAYOUTS_CSV: (PAYOUT_COLUMNS, payout_rows(payouts, tz)),
        TRANSACTIONS_CSV: (TRANSACTION_COLUMNS, transaction_rows(txns, payouts, tz, since)),
    }
    save_all(settings['dir'], files)
    log('保存しました: ' + ', '.join('{} {}行'.format(n, len(r)) for n, (_, r) in files.items()))
    return files


def main():
    for st in (sys.stdout, sys.stderr):   # コンソールの文字コードで書けない字があっても止まらないように
        try:
            st.reconfigure(errors='replace')
        except (AttributeError, ValueError):
            pass
    try:
        settings = load_settings()
    except ConfigError as e:
        print('設定エラー: {}'.format(e), file=sys.stderr)
        return 2
    log = Logger(settings['dir'])
    try:
        run(settings, log=log)
    except FetchError as e:
        log('エラー: {}（前回のファイルはそのまま残しています）'.format(e))
        return 1
    except Exception as e:   # 想定外でも前回のファイルは残る。詳細は型名のみ（秘密を出さない）
        log('エラー: 想定外の失敗です（{}）。前回のファイルはそのまま残しています'.format(type(e).__name__))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
