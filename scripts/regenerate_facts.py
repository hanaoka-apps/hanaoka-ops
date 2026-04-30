#!/usr/bin/env python3
"""
SharedMasters のCSVから dashboard_facts.json を自動生成・アップロード（最適化版）

GitHub Actions から毎日実行される想定。

入力 (SharedMasters):
  - dashboard_facts_history.json  ← 過去年度の事実データ（不変、prep_history で1回作成）
  - 売上明細出力.csv               ← 当期の売上（SMILEが毎日更新）
  - 受注明細出力.csv               ← 当期の受注（SMILEが毎日更新）

出力 (SharedMasters):
  - dashboard_facts.json (上書き)

環境変数:
  AZURE_TENANT_ID    - テナントID
  AZURE_CLIENT_ID    - アプリクライアントID
  AZURE_CLIENT_SECRET - クライアントシークレット
"""
import os
import sys
import io
import csv
import json
import time
import requests
from datetime import datetime, timezone, timedelta

# ---------- 設定 ----------
TENANT_ID = os.environ['AZURE_TENANT_ID']
CLIENT_ID = os.environ['AZURE_CLIENT_ID']
CLIENT_SECRET = os.environ['AZURE_CLIENT_SECRET']

SITE_ID = "hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23"
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

HISTORY_JSON = 'dashboard_facts_history.json'
INPUT_CSVS = {
    'sales_curr': '売上明細出力.csv',
    'orders':     '受注明細出力.csv',
}
OUTPUT_JSON = 'dashboard_facts.json'


# ---------- 認証 ----------
def get_token():
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        'grant_type': 'client_credentials',
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'scope': 'https://graph.microsoft.com/.default',
    }
    r = requests.post(url, data=data, timeout=30)
    r.raise_for_status()
    return r.json()['access_token']


# ---------- Graph API ----------
def graph_get(token, path, retries=3):
    url = path if path.startswith('http') else f"https://graph.microsoft.com/v1.0{path}"
    last = None
    for i in range(retries):
        r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=120)
        if r.ok: return r
        last = r
        if r.status_code in (429, 502, 503, 504):
            time.sleep(2 ** i); continue
        break
    last.raise_for_status()


def download_json(token, filename):
    print(f"  📥 {filename} を取得中...", flush=True)
    enc_name = requests.utils.quote(filename, safe='')
    url = f"/drives/{DRIVE_ID}/root:/{enc_name}:/content"
    r = graph_get(token, url)
    return r.json()


def download_csv(token, filename):
    print(f"  📥 {filename} を取得中...", flush=True)
    enc_name = requests.utils.quote(filename, safe='')
    url = f"/drives/{DRIVE_ID}/root:/{enc_name}:/content"
    r = graph_get(token, url)
    raw = r.content
    text = None
    for enc in ('utf-8-sig', 'utf-8', 'shift_jis', 'cp932'):
        try:
            candidate = raw.decode(enc)
            if candidate.count('�') < len(candidate) * 0.001:
                text = candidate; break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise RuntimeError(f"{filename} のエンコーディング判別失敗")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise RuntimeError(f"{filename} が空")
    print(f"     {len(rows) - 1} 行")
    return rows[0], rows[1:]


def upload_json(token, filename, data):
    enc_name = requests.utils.quote(filename, safe='')
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{enc_name}:/content"
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    print(f"  📤 {filename} をアップロード中... ({len(body) / 1024 / 1024:.2f} MB)", flush=True)
    r = requests.put(url, headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }, data=body, timeout=300)
    r.raise_for_status()
    return r.json()


# ---------- 変換ヘルパー ----------
def find_idx(header, name, fallback=None):
    cleaned = [h.replace('﻿', '').strip() for h in header]
    if name in cleaned:
        return cleaned.index(name)
    return fallback


def to_float(s):
    try: return float(s)
    except (ValueError, TypeError): return 0.0

def to_int(s):
    try: return int(s)
    except (ValueError, TypeError): return 0

def normalize_zenkaku(s):
    if not s: return s
    return s.replace('ｿﾘｭｰｼｮﾝ', 'ソリューション')

def fy_from_ym(ym):
    if not ym or ym < 100000:
        return 0
    y, m = ym // 100, ym % 100
    return y if m >= 4 else y - 1


# ---------- 売上明細変換 ----------
def transform_sales(header, rows):
    h = header
    idx = {
        'voucher_date': find_idx(h, '伝票日付'),
        'ym':           find_idx(h, '年月度'),
        'meisai_kbn':   find_idx(h, '明細区分'),
        'cust_cd':      find_idx(h, '得意先ｺｰﾄﾞ'),
        'cust_abbr':    find_idx(h, '得意先名略称'),
        'genre':        find_idx(h, '得意先ｼﾞｬﾝﾙ名'),
        'new_kind':     find_idx(h, '新規/掘起し名'),
        'sho_bunrui':   find_idx(h, '小分類名'),
        'deliver_cd':   find_idx(h, '納品先ｺｰﾄﾞ'),
        'deliver_nm':   find_idx(h, '納品先名'),
        'rep_cd':       find_idx(h, '担当者ｺｰﾄﾞ'),
        'rep_nm':       find_idx(h, '担当者名'),
        'bumon':        find_idx(h, '部門名'),
        'chu_bumon':    find_idx(h, '中部門名'),
        'sales_div':    find_idx(h, '売上営業/ｿﾘｭ名'),
        'base':         find_idx(h, '売上部門別名'),
        'dai_bunrui':   find_idx(h, '大分類名'),
        'chu_bunrui':   find_idx(h, '中分類名'),
        'item_cd':      find_idx(h, '品目ｺｰﾄﾞ'),
        'item_nm':      find_idx(h, '品目名'),
        'qty':          find_idx(h, '数量'),
        'amount':       find_idx(h, '金額'),
        'unit_price':   find_idx(h, '単価'),
    }
    missing = [k for k, v in idx.items() if v is None]
    if missing:
        raise RuntimeError(f"列が見つからない: {missing}")
    out = []
    for row in rows:
        if len(row) < max(idx.values()) + 1: continue
        ym = to_int(row[idx['ym']])
        if ym == 0: continue
        fy = fy_from_ym(ym)
        sd_name = (row[idx['sales_div']] or '').strip()
        if '国内営業' in sd_name: sales_div = '国内営業部'
        elif 'ｿﾘｭｰｼｮﾝ' in sd_name: sales_div = 'ソリューション営業部'
        else: sales_div = ''
        if sales_div == '国内営業部': chu_bumon = '国内営業'
        elif sales_div == 'ソリューション営業部': chu_bumon = 'ｿﾘｭｰｼｮﾝ営業部'
        else: chu_bumon = (row[idx['chu_bumon']] or '').strip()
        base = normalize_zenkaku((row[idx['base']] or '').strip())
        meisai = to_int(row[idx['meisai_kbn']])
        kind = 2 if meisai == 2 else 1
        cust_abbr = row[idx['cust_abbr']]
        genre = row[idx['genre']]
        out.append([
            ym, fy,
            row[idx['cust_cd']], cust_abbr, genre,
            row[idx['new_kind']] or '',
            row[idx['sho_bunrui']] or '',
            row[idx['voucher_date']],
            row[idx['deliver_cd']], row[idx['deliver_nm']],
            row[idx['rep_cd']], row[idx['rep_nm']],
            row[idx['bumon']], chu_bumon, base, sales_div,
            row[idx['dai_bunrui']], row[idx['chu_bunrui']],
            row[idx['item_cd']], row[idx['item_nm']],
            to_float(row[idx['qty']]),
            to_float(row[idx['amount']]),
            to_float(row[idx['unit_price']]),
            kind,
            cust_abbr, genre, '',
        ])
    return out


# ---------- 受注明細変換 ----------
def transform_orders(header, rows):
    h = header
    idx = {
        'voucher_date': find_idx(h, '受注日付'),
        'ym':           find_idx(h, '年月度'),
        'cust_cd':      find_idx(h, '得意先ｺｰﾄﾞ'),
        'cust_abbr':    find_idx(h, '得意先名略称'),
        'genre':        find_idx(h, '得意先ｼﾞｬﾝﾙ名'),
        'new_kind':     find_idx(h, '新規/掘起し名'),
        'sho_bunrui':   find_idx(h, '小分類名'),
        'deliver_cd':   find_idx(h, '納品先ｺｰﾄﾞ'),
        'deliver_nm':   find_idx(h, '納品先名'),
        'rep_cd':       find_idx(h, '担当者ｺｰﾄﾞ'),
        'rep_nm':       find_idx(h, '担当者名'),
        'bumon':        find_idx(h, '部門名'),
        'chu_bumon':    find_idx(h, '中部門名'),
        'sales_div':    find_idx(h, '売上営業/ｿﾘｭ名'),
        'base':         find_idx(h, '売上部門別名'),
        'dai_bunrui':   find_idx(h, '大分類名'),
        'chu_bunrui':   find_idx(h, '中分類名'),
        'item_cd':      find_idx(h, '品目ｺｰﾄﾞ'),
        'item_nm':      find_idx(h, '品目名'),
        'qty':          find_idx(h, '数量'),
        'amount':       find_idx(h, '金額'),
        'unit_price':   find_idx(h, '単価'),
    }
    missing = [k for k, v in idx.items() if v is None]
    if missing:
        raise RuntimeError(f"列が見つからない (orders): {missing}")
    out = []
    for row in rows:
        if len(row) < max(idx.values()) + 1: continue
        ym = to_int(row[idx['ym']])
        if ym == 0: continue
        fy = fy_from_ym(ym)
        sd_name = (row[idx['sales_div']] or '').strip()
        if '国内営業' in sd_name: sales_div = '国内営業部'
        elif 'ｿﾘｭｰｼｮﾝ' in sd_name: sales_div = 'ソリューション営業部'
        else: sales_div = ''
        if sales_div == '国内営業部': chu_bumon = '国内営業'
        elif sales_div == 'ソリューション営業部': chu_bumon = 'ｿﾘｭｰｼｮﾝ営業部'
        else: chu_bumon = (row[idx['chu_bumon']] or '').strip()
        base = normalize_zenkaku((row[idx['base']] or '').strip())
        cust_abbr = row[idx['cust_abbr']]
        genre = row[idx['genre']]
        out.append([
            ym, fy,
            row[idx['cust_cd']], cust_abbr, genre,
            row[idx['new_kind']] or '',
            row[idx['sho_bunrui']] or '',
            row[idx['voucher_date']],
            row[idx['deliver_cd']], row[idx['deliver_nm']],
            row[idx['rep_cd']], row[idx['rep_nm']],
            row[idx['bumon']], chu_bumon, base, sales_div,
            row[idx['dai_bunrui']], row[idx['chu_bunrui']],
            row[idx['item_cd']], row[idx['item_nm']],
            to_float(row[idx['qty']]),
            to_float(row[idx['amount']]),
            to_float(row[idx['unit_price']]),
            1,
            cust_abbr, genre, '',
        ])
    return out


# ---------- メイン ----------
def main():
    started = time.time()
    jst = timezone(timedelta(hours=9))
    print(f"🚀 開始 [{datetime.now(jst).strftime('%Y-%m-%d %H:%M:%S JST')}]", flush=True)

    print("\n🔑 アクセストークン取得中...", flush=True)
    token = get_token()

    print("\n📥 履歴データ取得...", flush=True)
    history = download_json(token, HISTORY_JSON)
    history_rows = history.get('rows', [])
    print(f"  履歴 rows: {len(history_rows):,}件 (FY {history.get('build_meta', {}).get('historical_fy_max', '?')} まで)")

    print("\n📥 当期 CSV ダウンロード...", flush=True)
    h_curr, r_curr = download_csv(token, INPUT_CSVS['sales_curr'])
    h_ord, r_ord = download_csv(token, INPUT_CSVS['orders'])

    print("\n🔧 当期データ変換中...", flush=True)
    sales_curr = transform_sales(h_curr, r_curr)
    print(f"  当期売上: {len(sales_curr):,}件")
    orders = transform_orders(h_ord, r_ord)
    print(f"  当期受注: {len(orders):,}件")

    # マージ
    rows = history_rows + sales_curr
    yms = [r[0] for r in rows if r[0]]
    facts = {
        'rows': rows,
        'order_rows': orders,
        'build_meta': {
            'sales_count': len(rows),
            'orders_count': len(orders),
            'ym_min': min(yms) if yms else 0,
            'ym_max': max(yms) if yms else 0,
            'history_count': len(history_rows),
            'current_count': len(sales_curr),
            'updated_at': datetime.now(jst).isoformat(),
        }
    }

    print(f"\n📊 集計:")
    print(f"  rows total: {len(rows):,} (履歴 {len(history_rows):,} + 当期 {len(sales_curr):,})")
    print(f"  order_rows: {len(orders):,}")
    print(f"  ym range:   {facts['build_meta']['ym_min']} 〜 {facts['build_meta']['ym_max']}")

    print(f"\n📤 dashboard_facts.json をアップロード...", flush=True)
    upload_json(token, OUTPUT_JSON, facts)

    elapsed = time.time() - started
    print(f"\n✅ 完了 ({elapsed:.1f}秒)", flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"\n❌ エラー: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
