#!/usr/bin/env python3
"""
Shopify の注文に、送り状番号（運送会社・番号・追跡URL）を登録して、発送済みにする（EC売上アプリの出荷チェックの「Shopify に登録する」用）。

RPA専用機の常駐スクリプト（rpa_queue_worker.ps1 のジョブ type: fulfill = ec_shopify_fulfill）が、毎回 GitHub の main から取得して実行する。
PAD は使わない。標準ライブラリ以外は requests だけ。1ファイルで動く（shopify_fetch.py は読み込まない）。

使い方:
  python shopify_fulfill.py --input request.json [--batch fulfill-20261110T0900]
    request.json = {
      "dryRun": true|false,           # true なら、Shopify には書かず、何をするかだけを結果に出す（既定 false）
      "notify": true|false,           # お客様に、Shopify から発送通知メールを送るか（既定 true。いまの手作業の運用に合わせた）
      "orders": [ { "id": "1772", "company": "西濃運輸", "number": "907-228-4252", "url": "https://…" }, … ]
    }
    id＝Shopify の注文番号（#1772 の数字だけ）。number はハイフン・空白を除いた数字にして使う（いまの手作業と同じ形）。

注文ごとにやること（Shopify Admin GraphQL。権限は write_merchant_managed_fulfillment_orders ほか。手順は ec_shopify_fulfill_setup.md）:
  1) 注文を番号で探す。見つからない・複数なら error。キャンセル済みは skipped。
  2) すでに同じ送り状番号が登録されていれば already（何もしない＝二重登録しない）。
  3) まだ発送していない「発送の指示（FulfillmentOrder）」が1つなら、fulfillmentCreate で、運送会社・番号・追跡URLを付けて発送済みにする。
  4) すでに発送済みで、追跡の番号が無い発送が1つなら、fulfillmentTrackingInfoUpdate で、追跡情報を付け足す。
  5) それ以外（発送の指示が複数・保留中・発送が複数・番号が別のものなど）は、勝手に決めず skipped にして、理由を出す（管理画面で、人が見る）。

結果:
  SHARED_MASTERS_DIR/_ec_fulfill/<batch>/result.json に書く（--batch を省くと、結果は標準出力にだけ出す）。
  { "batchId", "finishedAt", "dryRun", "ok": 全件が done/already か, "results": [ { "id", "status": done|already|skipped|error, "action": create|update|none, "message" } ] }
  お客様の名前・住所・メール・電話は、読まない・書かない・ログに出さない（注文番号と、番号・状態だけ）。

環境変数（専用機にだけ。値はログ・リポジトリに出さない）:
  SHOPIFY_SHOP                  ストアの xxxx.myshopify.com
  SHOPIFY_FULFILL_CLIENT_ID / SHOPIFY_FULFILL_CLIENT_SECRET   出荷登録用のアプリ（書き込み専用。読み取り用のアプリとは別）
  SHARED_MASTERS_DIR            OneDrive 同期済みの SharedMasters のパス
  SHOPIFY_API_VERSION           (任意) 既定 DEFAULT_API_VERSION

終了コード: 0＝処理した（結果の中に error があっても 0。結果ファイルを見る）／1＝実行できなかった（認証・通信・権限）／2＝設定・入力が不正
標準出力の最後の行が、常駐スクリプトを通して依頼の失敗理由になる。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

import requests

DEFAULT_API_VERSION = '2026-07'
LOG_NAME = 'shopify_fulfill.log'
SHOP_RE = re.compile(r'^[a-z0-9][a-z0-9\-]*\.myshopify\.com$')
MAX_RETRIES = 5
MAX_ORDERS = 50
NUMBER_RE = re.compile(r'^\d{6,20}$')
URL_RE = re.compile(r'^https://[^\s<>"]{3,500}$')


class FulfillError(Exception):
    """実行できない（認証・通信・権限）。fatal＝続けても同じなので、残りの注文も止める"""

    def __init__(self, message, fatal=False):
        super().__init__(message)
        self.fatal = fatal


class ConfigError(Exception):
    """環境変数・入力が不正"""


# ---------------------------------------------------------------- 設定・ログ
def load_settings(env=None):
    env = os.environ if env is None else env

    def val(k):
        return (env.get(k) or '').strip()

    missing = [k for k in ('SHOPIFY_SHOP', 'SHOPIFY_FULFILL_CLIENT_ID', 'SHOPIFY_FULFILL_CLIENT_SECRET', 'SHARED_MASTERS_DIR') if not val(k)]
    if missing:
        raise ConfigError('環境変数が設定されていません: ' + ', '.join(missing) + '（手順は scripts/rpa_setup/ec_shopify_fulfill_setup.md）')
    shop = re.sub(r'^https?://', '', val('SHOPIFY_SHOP').lower()).rstrip('/')
    if not SHOP_RE.match(shop):
        raise ConfigError('SHOPIFY_SHOP は「xxxx.myshopify.com」の形で指定してください')   # 秘密を意図しない宛先に送らない
    return {'shop': shop, 'client_id': val('SHOPIFY_FULFILL_CLIENT_ID'), 'client_secret': val('SHOPIFY_FULFILL_CLIENT_SECRET'),
            'dir': val('SHARED_MASTERS_DIR'), 'version': val('SHOPIFY_API_VERSION') or DEFAULT_API_VERSION}


class Logger:
    """SharedMasters/_rpa_queue/logs/ に追記（[日時] 内容）。秘密・お客様の情報は書かない"""

    def __init__(self, shared_dir=None):
        self.path = os.path.join(shared_dir, '_rpa_queue', 'logs', LOG_NAME) if shared_dir else None

    def __call__(self, message):
        line = '[{}] {}'.format(datetime.now().strftime('%Y-%m-%d %H:%M:%S'), message)
        print(line, flush=True)
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except OSError as e:
            print('(ログファイルに書けません: {})'.format(e), file=sys.stderr)


# ---------------------------------------------------------------- 認証・GraphQL
class ClientCredentialsToken:
    """Dev Dashboard のアプリ用（client credentials）。トークンはメモリだけ。エラーに秘密・応答の中身を出さない"""
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
                                    data={'grant_type': 'client_credentials', 'client_id': self._id, 'client_secret': self._secret})
        except requests.exceptions.RequestException as e:
            raise FulfillError('トークン取得で接続エラー（{}）'.format(type(e).__name__), fatal=True)
        code = ''
        try:
            body = res.json()
            code = str(body.get('error') or '') if isinstance(body, dict) else ''
        except ValueError:
            body = None
        token = body.get('access_token') if isinstance(body, dict) else None
        if res.status_code != 200 or not token:
            hint = '。アプリとストアが同じ Shopify 組織にあるか確認してください' if code == 'shop_not_permitted' else (
                '。Client ID / Client secret とストア名を確認してください' if res.status_code in (400, 401, 403) else '')
            raise FulfillError('トークンを取得できませんでした（HTTP {}{}）{}'.format(
                res.status_code, ' ' + code if re.fullmatch(r'[a-z_]{1,40}', code) else '', hint), fatal=True)
        try:
            ttl = float(body.get('expires_in') or 86399)
        except (TypeError, ValueError):
            ttl = 86399
        self._token, self._expires = token, self.clock() + ttl
        self.log('アクセストークンを取得しました（client credentials）')
        return self._token


class ShopifyClient:
    def __init__(self, shop, auth, version, session=None, sleep=time.sleep, log=None):
        self.url = 'https://{}/admin/api/{}/graphql.json'.format(shop, version)
        self.auth = auth
        self.session = session or requests
        self.sleep = sleep
        self.log = log or (lambda m: None)

    def execute(self, query, variables=None):
        """一時エラー（429・5xx・接続失敗・THROTTLED）は待って再試行。それ以外は FulfillError"""
        last, refreshed = '', False
        for attempt in range(MAX_RETRIES):
            wait = min(2 ** attempt, 60)
            headers = {'X-Shopify-Access-Token': self.auth.get(), 'Content-Type': 'application/json'}
            try:
                res = self.session.post(self.url, headers=headers, timeout=60, json={'query': query, 'variables': variables or {}})
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
            if res.status_code == 401 and not refreshed:
                refreshed = True
                self.auth.invalidate()
                self.log('HTTP 401（トークンを取り直して再実行）')
                continue
            if res.status_code in (401, 403):
                raise FulfillError('Shopify に拒否されました（HTTP {}）。アプリの権限（スコープ）を確認してください'.format(res.status_code), fatal=True)
            if res.status_code != 200:
                raise FulfillError('Shopify がエラーを返しました（HTTP {}）'.format(res.status_code))
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
                    raise FulfillError('アクセス権限が足りません: ' + '; '.join(t or '' for t in texts)
                                       + '（必要な権限は ec_shopify_fulfill_setup.md を参照）', fatal=True)
                raise FulfillError('GraphQL エラー: ' + '; '.join(t or '' for t in texts))
            return body.get('data') or {}
        raise FulfillError('再試行しても実行できませんでした（最後のエラー: {}）'.format(last), fatal=True)


# ---------------------------------------------------------------- GraphQL
ORDER_QUERY = '''
query($q: String!) {
  orders(first: 3, query: $q) {
    nodes {
      id
      name
      cancelledAt
      fulfillmentOrders(first: 10) { nodes { id status } }
      fulfillments(first: 10) { id status trackingInfo { number company url } }
    }
  }
}'''

FULFILL_CREATE = '''
mutation($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}'''

TRACKING_UPDATE = '''
mutation($id: ID!, $info: FulfillmentTrackingInput!, $notify: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $info, notifyCustomer: $notify) {
    fulfillment { id status }
    userErrors { field message }
  }
}'''

OPEN_STATUSES = ('OPEN', 'IN_PROGRESS')


def clean_number(value):
    """ハイフン・空白・全角を除いた数字（いまの手作業の形：9072284252）。6〜20桁の数字でなければ None"""
    s = str(value or '').translate(str.maketrans('０１２３４５６７８９', '0123456789'))
    s = re.sub(r'[\s\-－ー]', '', s)
    return s if NUMBER_RE.match(s) else None


def result(order_id, status, action, message):
    return {'id': order_id, 'status': status, 'action': action, 'message': message}


def user_errors_text(node):
    errs = (node or {}).get('userErrors') or []
    return '; '.join(str(e.get('message') or '') for e in errs if isinstance(e, dict)) or ''


def process_order(client, item, notify, dry_run):
    """注文1件を処理して result() を返す。この関数の中の通信エラー（FulfillError）は、上に伝える（全体を止める）"""
    oid = re.sub(r'\D', '', str(item.get('id') or ''))
    if not oid:
        return result(str(item.get('id') or ''), 'error', 'none', '注文番号がありません')
    number = clean_number(item.get('number'))
    if not number:
        return result(oid, 'error', 'none', '送り状番号が正しくありません（数字6〜20桁）')
    company = str(item.get('company') or '').strip()[:60]
    if not company:
        return result(oid, 'error', 'none', '運送会社の名前がありません')
    url = str(item.get('url') or '').strip()
    if url and not URL_RE.match(url):
        return result(oid, 'error', 'none', '追跡URLの形が正しくありません')
    info = {'company': company, 'number': number}
    if url:
        info['url'] = url

    data = client.execute(ORDER_QUERY, {'q': 'name:#{}'.format(oid)})
    nodes = [n for n in ((data.get('orders') or {}).get('nodes') or []) if str(n.get('name') or '').lstrip('#') == oid]
    if not nodes:
        return result(oid, 'error', 'none', 'Shopify に、この注文番号が見つかりません')
    if len(nodes) > 1:
        return result(oid, 'error', 'none', '同じ注文番号が複数あります（管理画面で確認してください）')
    order = nodes[0]
    if order.get('cancelledAt'):
        return result(oid, 'skipped', 'none', 'キャンセル済みの注文です')

    fulfillments = [f for f in (order.get('fulfillments') or []) if str(f.get('status') or '').upper() != 'CANCELLED']
    have = set()
    for f in fulfillments:
        for t in (f.get('trackingInfo') or []):
            if t.get('number'):
                have.add(clean_number(t['number']) or str(t['number']))
    if number in have:
        return result(oid, 'already', 'none', 'この送り状番号は、すでに登録されています')

    fos = [fo for fo in ((order.get('fulfillmentOrders') or {}).get('nodes') or [])]
    open_fos = [fo for fo in fos if str(fo.get('status') or '').upper() in OPEN_STATUSES]
    on_hold = [fo for fo in fos if str(fo.get('status') or '').upper() == 'ON_HOLD']

    if open_fos:
        if len(open_fos) > 1:
            return result(oid, 'skipped', 'none', '発送の指示が複数あります（管理画面で、人が発送してください）')
        if fulfillments:
            return result(oid, 'skipped', 'none', '一部が発送済みで、残りがあります（管理画面で確認してください）')
        if dry_run:
            return result(oid, 'done', 'create', '【確認のみ】発送済みにして、送り状番号を登録します')
        data = client.execute(FULFILL_CREATE, {'fulfillment': {
            'notifyCustomer': bool(notify),
            'trackingInfo': info,
            'lineItemsByFulfillmentOrder': [{'fulfillmentOrderId': open_fos[0]['id']}]}})
        err = user_errors_text(data.get('fulfillmentCreate'))
        if err:
            return result(oid, 'error', 'create', '発送の登録に失敗しました: ' + err)
        return result(oid, 'done', 'create', '発送済みにして、送り状番号を登録しました')

    if on_hold:
        return result(oid, 'skipped', 'none', '発送が保留中です（管理画面で確認してください）')

    if fulfillments:
        if len(fulfillments) > 1:
            return result(oid, 'skipped', 'none', '発送が複数あります（管理画面で、人が確認してください）')
        f = fulfillments[0]
        if any(t.get('number') for t in (f.get('trackingInfo') or [])):
            return result(oid, 'skipped', 'none', '別の送り状番号がすでに登録されています（管理画面で確認してください）')
        if dry_run:
            return result(oid, 'done', 'update', '【確認のみ】発送済みの注文に、送り状番号を追加します')
        data = client.execute(TRACKING_UPDATE, {'id': f['id'], 'info': info, 'notify': bool(notify)})
        err = user_errors_text(data.get('fulfillmentTrackingInfoUpdate'))
        if err:
            return result(oid, 'error', 'update', '送り状番号の追加に失敗しました: ' + err)
        return result(oid, 'done', 'update', '発送済みの注文に、送り状番号を追加しました')

    return result(oid, 'error', 'none', '発送できる状態ではありません（発送の指示がありません）')


def validate_request(req):
    if not isinstance(req, dict):
        raise ConfigError('依頼の形が正しくありません')
    orders = req.get('orders')
    if not isinstance(orders, list) or not orders:
        raise ConfigError('登録する注文（orders）がありません')
    if len(orders) > MAX_ORDERS:
        raise ConfigError('一度に登録できるのは {} 件までです（{} 件）'.format(MAX_ORDERS, len(orders)))
    seen = set()
    for o in orders:
        if not isinstance(o, dict):
            raise ConfigError('orders の形が正しくありません')
        oid = re.sub(r'\D', '', str(o.get('id') or ''))
        if oid in seen:
            raise ConfigError('同じ注文番号が重なっています: ' + oid)
        seen.add(oid)
    return orders


def run(req, settings, session=None, sleep=time.sleep, clock=time.time, log=None, batch=''):
    log = log or (lambda m: None)
    orders = validate_request(req)
    dry_run = bool(req.get('dryRun'))
    notify = True if req.get('notify') is None else bool(req.get('notify'))
    auth = ClientCredentialsToken(settings['shop'], settings['client_id'], settings['client_secret'], session=session, clock=clock, log=log)
    client = ShopifyClient(settings['shop'], auth, settings['version'], session=session, sleep=sleep, log=log)
    log('出荷登録を始めます（{} 件{}{}）'.format(len(orders), '・確認のみ' if dry_run else '', '' if notify else '・通知なし'))
    results = []
    stopped = ''
    for item in orders:
        oid = re.sub(r'\D', '', str(item.get('id') or '')) or str(item.get('id') or '')
        if stopped:
            r = result(oid, 'error', 'none', '前の注文で止まったため、処理していません（' + stopped + '）')
        else:
            try:
                r = process_order(client, item, notify, dry_run)
            except FulfillError as e:
                if e.fatal and not results:
                    raise   # 1件も進んでいない：依頼の失敗として、理由をそのまま返す
                r = result(oid, 'error', 'none', str(e))
                if e.fatal:
                    stopped = str(e)
        log('#{} → {}（{}）{}'.format(r['id'], r['status'], r['action'], r['message']))
        results.append(r)
    ok = all(r['status'] in ('done', 'already') for r in results)
    return {'batchId': batch, 'finishedAt': datetime.now().astimezone().isoformat(timespec='seconds'), 'dryRun': dry_run, 'notify': notify, 'ok': ok, 'results': results}


def write_result(shared_dir, batch, body):
    if not re.fullmatch(r'[A-Za-z0-9_\-]{1,80}', batch or ''):
        raise ConfigError('batch の名前が正しくありません（英数字・_・- だけ）')
    folder = os.path.join(shared_dir, '_ec_fulfill', batch)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, 'result.json')
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--input')
    ap.add_argument('--batch', default='')
    args = ap.parse_args(argv)
    try:
        raw = open(args.input, encoding='utf-8-sig').read() if args.input else sys.stdin.read()
        req = json.loads(raw)
        settings = load_settings()
        log = Logger(settings['dir'])
        body = run(req, settings, log=log, batch=args.batch)
        if args.batch:
            log('結果を書きました: {}'.format(write_result(settings['dir'], args.batch, body)))
        else:
            print(json.dumps(body, ensure_ascii=False))
        return 0
    except ConfigError as e:
        print('設定・入力が不正です: ' + str(e))
        return 2
    except (ValueError, OSError) as e:
        print('依頼を読めません: ' + type(e).__name__)
        return 2
    except FulfillError as e:
        print(str(e))
        return 1


if __name__ == '__main__':
    sys.exit(main())
