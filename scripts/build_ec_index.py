#!/usr/bin/env python3
"""
EC売上アプリ用の軽量ファイル ec_smile_index.json を作る。

SMILE から全件出力された大きな CSV（受注明細出力.csv は 90MB 前後）を、ブラウザで毎回読むのは重いので、
EC売上に必要な分だけを SharedMasters 直下の ec_smile_index.json に書き出す。
アプリ（ec_sales.html）はこの JSON を優先して読み、取込後の突き合わせにも使う。

入力 (SharedMasters。OneDrive 同期済みのフォルダ。環境変数 SHARED_MASTERS_DIR):
  - 受注明細出力.csv   … 必須。EC の得意先の行だけ拾う
  - 納品先マスタ.csv   … 必須。EC の得意先の納品先だけ拾う
  - 品目マスタ.csv     … 必須。全品目（コード・名前・単位・手配区分）
  - 入金明細出力.csv   … 任意（無くてもよい）。EC の得意先の入金だけ拾う
  （タブ区切り・カンマ区切り、UTF-8 / Shift-JIS のどれでも読む。1行ずつ処理するのでメモリは少なくて済む）

出力 (SharedMasters):
  - ec_smile_index.json … 一時ファイルに書いてから置き換える。失敗したら前回のファイルをそのまま残す。
    {
      "generatedAt": "UTC ISO",                       … 取込の確認では「取込が終わった時刻より新しいか」を見る
      "sources": [{ "name", "modified"(UTC ISO), "rows" }],
      "customers": ["599801", "599802"],
      "orders":  { "cols": [...見出し], "rows": [[...], ...] },   … EC の受注の行
      "nouhin":  { "cols": [...], "rows": [...], "maxCode": { "得意先": "最大の納品先コード" } },
      "testPoPrefix": "TEST",
      "testOrders":  { "cols": [...], "rows": [...] },   … 客先注番が TEST… の行（orders には入れない）
      "items":   { "cols": [...], "rows": [...] },
      "nyukin":  { "cols": [...], "rows": [...] }
    }
  値はすべて文字列のまま（SMILE の出力そのまま。数値や日付の解釈はアプリ側）。

引数・環境変数:
  EC_CUSTOMERS … EC の得意先コード（カンマ区切り。既定 599801,599802）。--customers でも指定できる
  EC_TEST_PO_PREFIX … テスト送信の客先注番の先頭の印（既定 TEST。--test-po-prefix でも指定できる）。
                      客先注番がこの印で始まる行（EC売上の管理者メニューの「テスト送信」の注文）は、本番ECの受注（orders）には入れず
                      testOrders に分けて持つ（本番の二重取込確認・件数に混ぜない）
  EC_DELIVERY_CODE_LIMIT … 納品先コードの連番の上限（既定 099999。--delivery-code-limit でも指定できる）。これより大きいコード
                      （テスト用の 999998 など）は、得意先ごとの最大コード（maxCode）の計算に入れない
  --config     … ec_sales_config.json のパス。あれば EC の得意先を config.customers のキー、テストの印を testImport.poPrefix、
                  連番の上限を config.deliveryCodeLimit から読む（コードに埋め込まない。常駐スクリプトが main から取得して渡す）。
                  --customers などの指定や環境変数があればそちらを優先する
  --dir        … SharedMasters フォルダ（既定は環境変数 SHARED_MASTERS_DIR）

個人情報（名前・住所・電話）が入るので、ログには件数だけを出し、値は出さない。
標準ライブラリだけで動く（requests などは不要）。専用機の常駐スクリプトが毎回 GitHub の最新を取得して実行する。
"""
import argparse
import codecs
import csv
import json
import os
import sys
import unicodedata
from datetime import datetime, timezone

OUT_NAME = 'ec_smile_index.json'
DEFAULT_CUSTOMERS = '599801,599802'
DEFAULT_TEST_PO_PREFIX = 'TEST'
DEFAULT_CODE_LIMIT = '099999'

# 取り出す列。名前は NFKC にそろえて比べる（ｺｰﾄﾞ／コード、全角半角の違いを吸収する）。
# 先頭の名前が出力の見出しになる。別名があれば後ろに並べる。
ORDER_COLS = [
    ['受注№'], ['行'], ['受注日付'], ['得意先コード', '得意先ｺｰﾄﾞ'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'],
    ['品目コード', '品目ｺｰﾄﾞ'], ['品目名'], ['数量'], ['単価'], ['金額'], ['納期', '受注納期'], ['出荷予定日'],
    ['客先注番'], ['社内メモ'], ['操作日付'], ['手配区分'], ['製造数量'],
    ['製番'], ['原単価'],   # 注文の詳細の「SMILE の伝票イメージ」で、SMILE が付けた製番・原単価を見せる（無い形式の出力でも作れる。個人情報ではない）
]
NOUHIN_COLS = [
    ['得意先コード', '得意先ｺｰﾄﾞ'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'], ['納品先索引'],
    ['荷受け人名１'], ['荷受け人名２'], ['郵便番号'], ['住所１'], ['住所２'], ['電話番号'],
]
ITEM_COLS = [['品目コード', '品目ｺｰﾄﾞ'], ['品目名'], ['単位'], ['初期表示用手配区分'], ['在庫管理区分名'], ['標準原価', '原価単価', '標準原単価']]   # 最後は任意（伝票イメージの「原単価（マスタ）」）
NYUKIN_COLS = [['伝票日付'], ['得意先コード', '得意先ｺｰﾄﾞ'], ['入金額'], ['備考']]

# 必須の列（無ければ別の形式のファイルとみなして失敗にする。書き出し途中のファイルを読んだときも検知できる）
ORDER_REQUIRED = ['受注№', '得意先コード', '客先注番', '品目コード']
NOUHIN_REQUIRED = ['得意先コード', '納品先コード', '納品先名']
ITEM_REQUIRED = ['品目コード', '品目名']


def log(msg):
    print('[build_ec_index] ' + msg, flush=True)


def norm(s):
    return unicodedata.normalize('NFKC', str(s)).replace(' ', '').replace('　', '').strip()


def detect_encoding(path):
    """先頭の一部を UTF-8 として読めれば UTF-8（BOM 付きを含む）、だめなら Shift-JIS(cp932)。"""
    with open(path, 'rb') as f:
        head = f.read(1 << 20)
    dec = codecs.getincrementaldecoder('utf-8-sig')()
    try:
        dec.decode(head, final=False)   # 途中で切れたマルチバイトは final=False なので許される
        return 'utf-8-sig'
    except UnicodeDecodeError:
        return 'cp932'


def read_rows(path):
    """CSV/TSV を1行ずつ返す（最初が見出し）。区切りは見出し行のタブ数・カンマ数で判定。"""
    csv.field_size_limit(1 << 24)
    enc = detect_encoding(path)
    with open(path, 'r', encoding=enc, errors='replace', newline='') as f:
        first = f.readline()
        delim = '\t' if first.count('\t') > first.count(',') else ','
        f.seek(0)
        for row in csv.reader(f, delimiter=delim, quotechar='"'):
            if row:
                yield row


def column_plan(header, spec, required):
    """見出し行から、spec の各列が何番目にあるかを返す（無い任意列は -1）。必須が無ければ ValueError。"""
    index = {}
    for i, h in enumerate(header):
        index.setdefault(norm(h), i)
    found = []
    for names in spec:
        pos = -1
        for n in names:
            if norm(n) in index:
                pos = index[norm(n)]
                break
        found.append(pos)
    for req in required:
        names = next(n for n in spec if n[0] == req)
        if found[spec.index(names)] < 0:
            raise ValueError('必須の列がありません: ' + req)
    return found


def pick(row, plan):
    return [row[p] if 0 <= p < len(row) else '' for p in plan]


def collect(path, spec, required, keep):
    """path の行のうち、keep(row_values) が真のものを spec の列だけ取り出して返す。"""
    it = read_rows(path)
    try:
        header = next(it)
    except StopIteration:
        raise ValueError('中身が空です')
    plan = column_plan(header, spec, required)
    rows, total = [], 0
    for r in it:
        total += 1
        v = pick(r, plan)
        if keep(v):
            rows.append(v)
    return [names[0] for names in spec], rows, total


def mtime_iso(path):
    return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def build(shared_dir, customers, now=None, test_po_prefix=DEFAULT_TEST_PO_PREFIX, delivery_code_limit=DEFAULT_CODE_LIMIT):
    """ec_smile_index.json を作って書き出す。成功したら書いた内容（dict）を返す。失敗したら例外（前回のファイルは残る）。
    test_po_prefix＝テスト送信の客先注番の先頭の印。この印で始まる受注の行は orders に入れず testOrders に分ける。
    delivery_code_limit＝納品先コードの連番の上限。これより大きいコード（テスト用の 999998 など）は maxCode に入れない。"""
    custs = [c.strip() for c in customers if c.strip()]
    if not custs:
        raise ValueError('EC の得意先コードがありません')
    is_ec = lambda code: norm(code) in custs
    prefix = (test_po_prefix or '').strip().upper()
    is_test_po = lambda po: bool(prefix) and norm(po).upper().startswith(prefix)
    sources = []

    def src(name, required=True):
        path = os.path.join(shared_dir, name)
        if not os.path.exists(path):
            if required:
                raise FileNotFoundError(name + ' がありません')
            return None
        return path

    out = {'customers': custs}

    p = src('受注明細出力.csv')
    cols, rows, total = collect(p, ORDER_COLS, ORDER_REQUIRED, lambda v: is_ec(v[3]))
    out['orders'] = {'cols': cols, 'rows': [v for v in rows if not is_test_po(v[13])]}
    if prefix:
        out['testPoPrefix'] = test_po_prefix.strip()
        out['testOrders'] = {'cols': cols, 'rows': [v for v in rows if is_test_po(v[13])]}
    sources.append({'name': '受注明細出力.csv', 'modified': mtime_iso(p), 'rows': total})
    log('受注明細出力: 全 %d 行のうち EC %d 行・テスト送信 %d 行' % (total, len(out['orders']['rows']), len(out['testOrders']['rows']) if prefix else 0))

    p = src('納品先マスタ.csv')
    cols, rows, total = collect(p, NOUHIN_COLS, NOUHIN_REQUIRED, lambda v: is_ec(v[0]))
    max_code = {}
    for v in rows:
        code = v[1].strip()
        # 連番の上限より大きいコード（テスト用の 999998 など）は、最大コードの計算に入れない（アプリの deliveryCodeLimit と同じ）
        if code.isdigit() and code <= delivery_code_limit and code > max_code.get(v[0], ''):
            max_code[v[0]] = code
    out['nouhin'] = {'cols': cols, 'rows': rows, 'maxCode': max_code}
    sources.append({'name': '納品先マスタ.csv', 'modified': mtime_iso(p), 'rows': total})
    log('納品先マスタ: 全 %d 行のうち EC %d 行' % (total, len(rows)))

    p = src('品目マスタ.csv')
    cols, rows, total = collect(p, ITEM_COLS, ITEM_REQUIRED, lambda v: bool(v[0]))
    out['items'] = {'cols': cols, 'rows': rows}
    sources.append({'name': '品目マスタ.csv', 'modified': mtime_iso(p), 'rows': total})
    log('品目マスタ: %d 行' % len(rows))

    p = src('入金明細出力.csv', required=False)
    if p:
        cols, rows, total = collect(p, NYUKIN_COLS, ['伝票日付', '得意先コード'], lambda v: is_ec(v[1]))
        sources.append({'name': '入金明細出力.csv', 'modified': mtime_iso(p), 'rows': total})
        log('入金明細出力: 全 %d 行のうち EC %d 行' % (total, len(rows)))
    else:
        cols, rows = [n[0] for n in NYUKIN_COLS], []
        log('入金明細出力.csv はありません（空で出力します）')
    out['nyukin'] = {'cols': cols, 'rows': rows}

    out['sources'] = sources
    out['generatedAt'] = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')
    # 見出しの並びが分かりやすいよう、キーの順を固定して書く
    ordered = {k: out[k] for k in ['generatedAt', 'sources', 'customers', 'testPoPrefix', 'orders', 'testOrders', 'nouhin', 'items', 'nyukin'] if k in out}

    dest = os.path.join(shared_dir, OUT_NAME)
    tmp = dest + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            json.dump(ordered, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, dest)   # 置き換えは一瞬。途中で失敗しても前回のファイルは壊れない
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    log('%s を書き出しました（%.2f MB）' % (OUT_NAME, os.path.getsize(dest) / 1048576))
    return ordered


def main(argv=None):
    ap = argparse.ArgumentParser(description='EC売上アプリ用の軽量ファイル ec_smile_index.json を作る')
    ap.add_argument('--dir', default=os.environ.get('SHARED_MASTERS_DIR'), help='SharedMasters フォルダ')
    ap.add_argument('--customers', default=os.environ.get('EC_CUSTOMERS'), help='EC の得意先コード（カンマ区切り）')
    ap.add_argument('--test-po-prefix', default=os.environ.get('EC_TEST_PO_PREFIX'), help='テスト送信の客先注番の先頭の印')
    ap.add_argument('--delivery-code-limit', default=os.environ.get('EC_DELIVERY_CODE_LIMIT'), help='納品先コードの連番の上限')
    ap.add_argument('--config', default=None, help='ec_sales_config.json のパス（得意先コードなどをここから読む）')
    args = ap.parse_args(argv)
    if not args.dir:
        log('SHARED_MASTERS_DIR（または --dir）を指定してください')
        return 2
    customers, prefix, limit = args.customers, args.test_po_prefix, args.delivery_code_limit
    if args.config:
        try:
            with open(args.config, encoding='utf-8-sig') as f:
                conf = json.load(f)
            if customers is None:
                customers = ','.join((conf.get('config') or {}).get('customers', {}).keys())
            if prefix is None:
                prefix = str((conf.get('testImport') or {}).get('poPrefix') or '')
            if limit is None:
                limit = str((conf.get('config') or {}).get('deliveryCodeLimit') or '')
        except Exception as e:
            log('設定ファイルを読めません（%s）: %s' % (type(e).__name__, e))
            return 1
    if customers is None:
        customers = DEFAULT_CUSTOMERS
    if prefix is None:
        prefix = DEFAULT_TEST_PO_PREFIX
    if not limit:
        limit = DEFAULT_CODE_LIMIT
    try:
        build(args.dir, customers.split(','), test_po_prefix=prefix, delivery_code_limit=limit)
    except Exception as e:   # 失敗しても前回の ec_smile_index.json は残っている
        log('失敗しました（前回のファイルはそのままです）: %s: %s' % (type(e).__name__, e))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
