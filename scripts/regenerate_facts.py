#!/usr/bin/env python3
"""
SharedMasters のCSVから dashboard_facts.json を自動生成・アップロード（最適化版）

GitHub Actions から毎日実行される想定。

入力 (SharedMasters):
  - dashboard_facts_history.json  ← 過去年度の事実データ（不変、prep_history で1回作成）
  - 売上明細出力.csv               ← 当期の売上（SMILEが毎日更新）
  - 受注明細出力.csv               ← 当期の受注（SMILEが毎日更新）
  - 目標_部門目標出力.csv          ← 部門別月次目標（RPAが毎日更新）
  - 目標_担当者目標出力.csv        ← 担当者別月次目標（RPAが毎日更新）

出力 (SharedMasters):
  - dashboard_facts.json (上書き)
    {
      "rows": [...],
      "order_rows": [...],
      "dept_monthly_targets": { "全社": {"202504": 200000000, ...}, ... },
      "rep_monthly_targets":  { "000067": {"202504": 4800000, ...}, ... },
      "build_meta": {...}
    }

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
    'sales_curr':   '売上明細出力.csv',
    'orders':       '受注明細出力.csv',
    'dept_targets': '目標_部門目標出力.csv',
    'rep_targets':  '目標_担当者目標出力.csv',
    # --- 営業訪問実績 (新設 2026-07) ---
    'daily_reports': 'daily_reports.csv',
    'web_logs':      'web_tracking_logs.csv',
    'web_readers':   'web_tracking_readers.csv',
}
OUTPUT_JSON = 'dashboard_facts.json'

# 営業訪問実績で採用する 表示テンプレート
VISIT_TEMPLATE = '【営業・業務】訪問・来社・WEBMTG報告'


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
    tried = []
    # Phase 1: 厳密デコード ＋ 文字化け率0.5%以下なら採用
    for enc in ('utf-8-sig', 'utf-8', 'shift_jis', 'cp932'):
        try:
            candidate = raw.decode(enc)
            bad = candidate.count('\ufffd')
            ratio = bad / max(len(candidate), 1)
            tried.append(f"{enc}:OK化け{bad}({ratio*100:.3f}%)")
            if ratio < 0.005:
                text = candidate
                print(f"     エンコーディング: {enc}" + (f" (化け文字 {bad}文字)" if bad else ""), flush=True)
                break
        except UnicodeDecodeError as e:
            tried.append(f"{enc}:UnicodeDecodeError@byte{e.start}")
            continue
    # Phase 2: 厳密失敗時は cp932(replace) でフォールバック
    if text is None:
        print(f"     [警告] 厳密判別失敗。試行: {tried}", flush=True)
        try:
            candidate = raw.decode('cp932', errors='replace')
            bad = candidate.count('\ufffd')
            ratio = bad / max(len(candidate), 1)
            print(f"     [フォールバック] cp932(replace): 不正バイト率 {ratio*100:.2f}% ({bad}/{len(candidate)})", flush=True)
            if ratio < 0.05:
                text = candidate
        except Exception as e:
            print(f"     [エラー] cp932(replace)失敗: {e}", flush=True)
    if text is None:
        raise RuntimeError(f"{filename} のエンコーディング判別失敗 (試行: {tried})")

    # === 区切り文字を自動検出 (CSV/TSV/セミコロン/パイプ対応) ===
    # 先頭4KBを使って判定
    sample = text[:4096]
    delim = None
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=',\t;|')
        delim = dialect.delimiter
    except csv.Error:
        # Sniffer 失敗時: 1行目に含まれる候補のうち最多のものを採用
        first_line = sample.split('\n')[0]
        counts = {d: first_line.count(d) for d in [',', '\t', ';', '|']}
        delim = max(counts, key=counts.get) if max(counts.values()) > 0 else ','
    delim_label = {',':'カンマ','\t':'タブ',';':'セミコロン','|':'パイプ'}.get(delim, repr(delim))
    print(f"     区切り文字: {delim_label}", flush=True)

    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = list(reader)
    if not rows:
        raise RuntimeError(f"{filename} が空")
    print(f"     {len(rows) - 1} 行 / {len(rows[0])} 列")
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


# ============================================================
# CSV型検証 (RPA命名ミス・人為差替え対策)
# ============================================================
def detect_csv_type(header):
    """先頭20列のヘッダ文字列を見て、CSVがどの種類かを判定して返す。
    返り値: "uriage"/"juchu"/"hachu"/"mokuhyo_bumon"/"mokuhyo_tanto"/"unknown"
    """
    cleaned = [str(h).replace('﻿', '').strip() for h in header[:20]]
    head_str = ",".join(cleaned)
    has_cust    = "得意先" in head_str
    has_supplier= ("仕入先" in head_str or "取引先" in head_str)
    # 売上明細・受注明細・発注明細
    is_uriage = ("伝票日付" in head_str and "明細区分" in head_str and has_cust)
    is_juchu  = (("受注日付" in head_str or "受注№" in head_str or "受注No" in head_str) and has_cust)
    is_hachu  = (("発注日付" in head_str or "発注№" in head_str or "発注No" in head_str) and has_supplier)
    # 目標CSV (部門/担当者)
    has_taisho_ym = "対象年月度" in head_str
    has_jun_uriage = "純売上金額" in head_str
    has_bumon_cd  = ("部門コード"  in head_str or "部門ｺｰﾄﾞ"  in head_str)
    has_tanto_cd  = ("担当者コード" in head_str or "担当者ｺｰﾄﾞ" in head_str)
    is_mokuhyo_bumon = (has_taisho_ym and has_jun_uriage and has_bumon_cd and "部門名" in head_str)
    is_mokuhyo_tanto = (has_taisho_ym and has_jun_uriage and has_tanto_cd and "担当者名" in head_str)
    # 優先順位
    if is_mokuhyo_bumon: return "mokuhyo_bumon"
    if is_mokuhyo_tanto: return "mokuhyo_tanto"
    if is_hachu and not (is_uriage or is_juchu): return "hachu"
    if is_juchu and not is_uriage:               return "juchu"
    if is_uriage:                                return "uriage"
    return "unknown"


def verify_csv_type(filename, header, expected_type):
    actual = detect_csv_type(header)
    type_label = {
        "uriage": "売上明細",
        "juchu":  "受注明細",
        "hachu":  "発注明細",
        "mokuhyo_bumon": "目標_部門目標",
        "mokuhyo_tanto": "目標_担当者目標",
        "unknown":"不明",
    }
    print(f"     型判定: {type_label.get(actual, actual)} (期待: {type_label.get(expected_type, expected_type)})", flush=True)
    if actual != expected_type:
        raise RuntimeError(
            f"❌ {filename} の中身が期待と違います!\n"
            f"   期待: {type_label.get(expected_type, expected_type)} ({expected_type})\n"
            f"   実際: {type_label.get(actual, actual)} ({actual})\n"
            f"   先頭ヘッダ20列: {','.join(str(h).strip() for h in header[:20])}\n"
            f"   → RPA出力ミスの可能性。SharedMasters の CSV を確認してください。\n"
            f"   → 安全のため処理を中断します（古い dashboard_facts.json は上書きされません）。"
        )


# ---------- 変換ヘルパー ----------
def find_idx(header, name, fallback=None):
    cleaned = [h.replace('﻿', '').strip() for h in header]
    if name in cleaned:
        return cleaned.index(name)
    return fallback


def find_first_idx(header, *names):
    """複数候補のヘッダ名を順に試し、最初にヒットしたindexを返す"""
    for name in names:
        i = find_idx(header, name)
        if i is not None:
            return i
    return None


def find_all_idx(header, name):
    """完全一致する全ての列indexをリストで返す"""
    cleaned = [h.replace('﻿', '').strip() for h in header]
    return [i for i, h in enumerate(cleaned) if h == name]


def find_partial_idx(header, keyword):
    """部分一致で最初にヒットしたindexを返す"""
    cleaned = [h.replace('﻿', '').strip() for h in header]
    for i, h in enumerate(cleaned):
        if keyword in h:
            return i
    return None


def find_partial_all_idx(header, keyword):
    """部分一致する全ての列indexをリストで返す"""
    cleaned = [h.replace('﻿', '').strip() for h in header]
    return [i for i, h in enumerate(cleaned) if keyword in h]


def pick_japanese_name_col(rows, candidates, sample_size=50):
    """候補列のうち、日本語文字を最も多く含む列indexを返す
    ID列(ad0xxxxxx形式)ではなく名前列(日本語)を優先するため
    """
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    scores = {i: 0 for i in candidates}
    for row in rows[:sample_size]:
        for i in candidates:
            if i >= len(row):
                continue
            val = str(row[i] or '').strip()
            for c in val:
                # ひらがな・カタカナ・漢字
                if '぀' <= c <= 'ヿ' or '一' <= c <= '鿿':
                    scores[i] += 1
    # 全部0なら最後の列を選択（表示名は右側にあることが多い）
    if max(scores.values()) == 0:
        return candidates[-1]
    return max(scores, key=scores.get)


def to_float(s):
    try: return float(s)
    except (ValueError, TypeError): return 0.0

def to_int(s):
    try: return int(s)
    except (ValueError, TypeError): return 0

def normalize_zenkaku(s):
    if not s: return s
    return s.replace('ｿﾘｭｰｼｮﾝ', 'ソリューション')

def normalize_rep_code(s):
    """担当者コードを6桁0埋めに正規化（販売明細と整合させる）"""
    if not s: return ""
    s = str(s).strip()
    if not s: return ""
    # 数値のみなら6桁0埋め
    if s.isdigit():
        return s.zfill(6)
    return s

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
        raise RuntimeError(
            f"列が見つからない (orders): {missing}\n"
            f"  ヘッダ実際 ({len(header)}列): {header}"
        )
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


# ---------- 目標_部門目標 変換 ----------
def transform_dept_targets(header, rows):
    """部門目標CSV を {部門名: {年月: 金額}, ...} に変換
    F列「変更後純売上」を採用（変更なしの時は D=F、変更時は F が現行目標）
    """
    h = header
    # 列名は半角カナ・全角カナ両対応
    idx = {
        'bumon_cd':   find_idx(h, '部門コード') if find_idx(h, '部門コード') is not None else find_idx(h, '部門ｺｰﾄﾞ'),
        'bumon_nm':   find_idx(h, '部門名'),
        'ym':         find_idx(h, '対象年月度'),
        'orig_amt':   find_idx(h, '純売上金額'),
        'cur_amt':    find_idx(h, '変更後純売上金額') if find_idx(h, '変更後純売上金額') is not None else find_idx(h, '変更後純売上'),
    }
    missing = [k for k, v in idx.items() if v is None]
    if missing:
        raise RuntimeError(f"列が見つからない (dept_targets): {missing}")
    out = {}
    for row in rows:
        if len(row) < max(idx.values()) + 1: continue
        ym = to_int(row[idx['ym']])
        if ym == 0: continue
        scope = (row[idx['bumon_nm']] or '').strip()
        scope = normalize_zenkaku(scope)
        if not scope: continue
        # F列 変更後 を優先、空なら D列 純売上
        cur = to_float(row[idx['cur_amt']])
        orig = to_float(row[idx['orig_amt']])
        amount = cur if cur > 0 else orig
        if scope not in out: out[scope] = {}
        out[scope][str(ym)] = amount
    return out


# ---------- 目標_担当者目標 変換 ----------
def transform_rep_targets(header, rows):
    """担当者目標CSV を {担当者コード(6桁0埋め): {年月: 金額}, ...} に変換"""
    h = header
    # 列名は半角カナ・全角カナ両対応
    idx = {
        'rep_cd':     find_idx(h, '担当者コード') if find_idx(h, '担当者コード') is not None else find_idx(h, '担当者ｺｰﾄﾞ'),
        'rep_nm':     find_idx(h, '担当者名'),
        'ym':         find_idx(h, '対象年月度'),
        'orig_amt':   find_idx(h, '純売上金額'),
        'cur_amt':    find_idx(h, '変更後純売上金額') if find_idx(h, '変更後純売上金額') is not None else find_idx(h, '変更後純売上'),
    }
    missing = [k for k, v in idx.items() if v is None]
    if missing:
        raise RuntimeError(f"列が見つからない (rep_targets): {missing}")
    out = {}
    for row in rows:
        if len(row) < max(idx.values()) + 1: continue
        ym = to_int(row[idx['ym']])
        if ym == 0: continue
        rep_cd = normalize_rep_code(row[idx['rep_cd']])
        if not rep_cd: continue
        cur = to_float(row[idx['cur_amt']])
        orig = to_float(row[idx['orig_amt']])
        amount = cur if cur > 0 else orig
        if rep_cd not in out: out[rep_cd] = {}
        out[rep_cd][str(ym)] = amount
    return out


# ============================================================
# 営業訪問実績: daily_reports.csv
# ============================================================
def transform_daily_reports(header, rows):
    """daily_reports.csv を営業訪問実績用のコンパクトな配列に変換
    出力: [id, 会社名, 会社ID, 相手先担当者, 相手先担当者ID,
           対応日時開始, 対応日時終了, 主な商材, 営業担当者(表示名),
           社内同席者, 対応内容, CheckList, ルート営業, 訪問種別, ルート工場]
    フィルタ: 表示テンプレート == VISIT_TEMPLATE
    """
    h = header

    # 表示テンプレート列（フィルタ用）
    template_idx = find_first_idx(h, '表示テンプレート', '表示テンプレート名')

    # 営業担当者列: 複数存在する可能性あり (所属/ID/表示名)
    tanto_candidates = find_all_idx(h, '営業担当者')
    if not tanto_candidates:
        # 部分一致で拾う
        tanto_candidates = find_partial_all_idx(h, '営業担当')

    # 相手先担当者列
    aite_candidates = find_all_idx(h, '相手先担当者')
    if not aite_candidates:
        aite_candidates = find_all_idx(h, '相手先担当者(リード)')
    if not aite_candidates:
        aite_candidates = find_partial_all_idx(h, '相手先担当')

    # ルート(営業) / ルート(工場)
    # 「ルート(営)」「ルート(営業)」など表記ゆれ対応
    route_ei_idx = find_first_idx(h, 'ルート(営業)', 'ルート(営)', 'ルート（営業）', 'ルート（営）')
    if route_ei_idx is None:
        for i, hh in enumerate([c.replace('﻿', '').strip() for c in h]):
            if 'ルート' in hh and ('営' in hh) and '工場' not in hh:
                route_ei_idx = i
                break

    route_koujou_idx = find_first_idx(h, 'ルート(工場)', 'ルート（工場）')
    if route_koujou_idx is None:
        for i, hh in enumerate([c.replace('﻿', '').strip() for c in h]):
            if 'ルート' in hh and '工場' in hh:
                route_koujou_idx = i
                break

    # 訪問種別
    houmon_idx = find_first_idx(h, '訪問種別')

    # Check List 列 (表記ゆれ・全半角括弧・別名対応)
    checklist_idx = None
    checklist_candidates_exact = [
        'Check List（次回確認事項）', 'Check List(次回確認事項)',
        'CheckList（次回確認事項）', 'CheckList(次回確認事項)',
        'チェックリスト（次回確認事項）', 'チェックリスト(次回確認事項)',
        'Check List', 'CheckList', 'チェックリスト',
        '次回確認事項', '次回確認', 'ToDo', 'TODO', 'Todo', 'todo',
    ]
    for cand in checklist_candidates_exact:
        i = find_idx(h, cand)
        if i is not None:
            checklist_idx = i
            break
    # 部分一致フォールバック
    if checklist_idx is None:
        for kw in ['Check List', 'CheckList', 'チェックリスト', '次回確認事項', 'ToDo', 'TODO']:
            i = find_partial_idx(h, kw)
            if i is not None:
                checklist_idx = i
                print(f"     [checklist] 部分一致で発見: '{kw}' → 列{i} ('{h[i]}')", flush=True)
                break
    if checklist_idx is not None:
        print(f"     [checklist] 採用列{checklist_idx}: '{h[checklist_idx].strip()}'", flush=True)
    else:
        print(f"     [警告] Check List列が見つからない (先頭ヘッダ抜粋: {[str(x).strip() for x in h[:30]]})", flush=True)

    idx = {
        'id':          find_first_idx(h, 'id', 'ID', 'Id'),
        'title':       find_first_idx(h, '題名', 'タイトル'),
        'company_nm':  find_first_idx(h, '会社名'),
        'company_id':  find_first_idx(h, '会社ID', '会社Id'),
        'start':       find_first_idx(h, '対応日時 開始', '対応日時開始', '対応日時_開始'),
        'end':         find_first_idx(h, '対応日時 終了', '対応日時終了', '対応日時_終了'),
        'shozai':      find_first_idx(h, '主な商材'),
        'douseki':     find_first_idx(h, '社内同席者'),
        'content':     find_first_idx(h, '対応内容'),
        'template':    template_idx,
        'checklist':   checklist_idx,  # ← 上書き
        'route_ei':    route_ei_idx,
        'route_koujou':route_koujou_idx,
        'houmon':      houmon_idx,
    }

    # 開始日必須
    if idx['start'] is None:
        raise RuntimeError(f"daily_reports: 対応日時 開始 列が見つからない。ヘッダ先頭20列: {header[:20]}")
    if template_idx is None:
        print(f"     [警告] daily_reports: 表示テンプレート列が見つからないためフィルタなし", flush=True)

    # 営業担当者: 日本語名が入っている列を選択
    tanto_idx = pick_japanese_name_col(rows, tanto_candidates) if tanto_candidates else None
    # 相手先担当者: 日本語名が入っている列を選択
    aite_idx = pick_japanese_name_col(rows, aite_candidates) if aite_candidates else None

    print(f"     daily_reports 列決定: 営業担当者={tanto_idx} 相手先担当者={aite_idx} "
          f"訪問種別={houmon_idx} ルート営業={route_ei_idx} ルート工場={route_koujou_idx}", flush=True)

    out = []
    filtered_count = 0
    kept_count = 0
    for row in rows:
        # 表示テンプレートフィルタ
        if template_idx is not None:
            tmpl = str(row[template_idx] or '').strip() if template_idx < len(row) else ''
            if tmpl != VISIT_TEMPLATE:
                filtered_count += 1
                continue

        def g(i):
            if i is None or i >= len(row):
                return ''
            return str(row[i] or '').strip()

        start = g(idx['start'])
        if not start:
            continue  # 開始日なしはスキップ

        out.append([
            g(idx['id']),               # 0: id
            g(idx['company_nm']),       # 1: 会社名
            g(idx['company_id']),       # 2: 会社ID
            g(aite_idx),                # 3: 相手先担当者(表示名)
            '',                         # 4: 相手先担当者ID (今回不使用、将来拡張用)
            start,                      # 5: 対応日時開始
            g(idx['end']),              # 6: 対応日時終了
            g(idx['shozai']),           # 7: 主な商材
            g(tanto_idx),               # 8: 営業担当者(表示名)
            g(idx['douseki']),          # 9: 社内同席者
            g(idx['content']),          # 10: 対応内容
            g(idx['checklist']),        # 11: Check List
            g(idx['route_ei']),         # 12: ルート(営業)
            g(idx['houmon']),           # 13: 訪問種別
            g(idx['route_koujou']),     # 14: ルート(工場)
        ])
        kept_count += 1
    print(f"     daily_reports 抽出: {kept_count}件 (テンプレフィルタ除外 {filtered_count}件)", flush=True)
    return out


# ============================================================
# 営業訪問実績: web_tracking_logs.csv
# ============================================================
def transform_web_logs(header, rows):
    """HP閲覧ログを配列化
    出力: [リードID, 日付, 氏名, 会社名, 部署, 役職, 都道府県,
           重要顧客, エンドユーザ, 販売店, 営業担当者,
           ページタイトル, URL, 滞在時間]
    """
    h = header
    idx = {
        'lead_id':   find_first_idx(h, 'リードID', 'リードId', 'Lead ID', 'LeadID'),
        'date':      find_first_idx(h, '日付', 'Date'),
        'name':      find_first_idx(h, '氏名'),
        'company':   find_first_idx(h, '会社名'),
        'busho':     find_first_idx(h, '部署'),
        'yakushoku': find_first_idx(h, '役職'),
        'todofuken': find_first_idx(h, '都道府県'),
        'juuyou':    find_first_idx(h, '重要顧客'),
        'endyu':     find_first_idx(h, 'エンドユーザー', 'エンドユーザ'),
        'hanbai':    find_first_idx(h, '販売店'),
        'tanto':     find_first_idx(h, '営業担当者'),
        'page':      find_first_idx(h, 'ページタイトル', 'ページ'),
        'url':       find_first_idx(h, 'URL', 'url'),
        'taizai':    find_first_idx(h, '滞在時間'),
    }
    out = []
    for row in rows:
        def g(i):
            if i is None or i >= len(row):
                return ''
            return str(row[i] or '').strip()
        date = g(idx['date'])
        if not date:
            continue
        out.append([
            g(idx['lead_id']),
            date,
            g(idx['name']),
            g(idx['company']),
            g(idx['busho']),
            g(idx['yakushoku']),
            g(idx['todofuken']),
            g(idx['juuyou']),
            g(idx['endyu']),
            g(idx['hanbai']),
            g(idx['tanto']),
            g(idx['page']),
            g(idx['url']),
            g(idx['taizai']),
        ])
    return out


# ============================================================
# 営業訪問実績: web_tracking_readers.csv
# ============================================================
def transform_web_readers(header, rows):
    """HP閲覧者集計を配列化
    出力: [リードID, 氏名, 会社名, 部署, 役職, 都道府県,
           重要顧客, エンドユーザ, 販売店, 営業担当者,
           アクション数, 最終閲覧日]
    """
    h = header
    idx = {
        'lead_id':   find_first_idx(h, 'リードID', 'リードId', 'Lead ID', 'LeadID'),
        'name':      find_first_idx(h, '氏名'),
        'company':   find_first_idx(h, '会社名'),
        'busho':     find_first_idx(h, '部署'),
        'yakushoku': find_first_idx(h, '役職'),
        'todofuken': find_first_idx(h, '都道府県'),
        'juuyou':    find_first_idx(h, '重要顧客'),
        'endyu':     find_first_idx(h, 'エンドユーザー', 'エンドユーザ'),
        'hanbai':    find_first_idx(h, '販売店'),
        'tanto':     find_first_idx(h, '営業担当者'),
        'action':    find_first_idx(h, 'アクション数', 'アクション'),
        'last_view': find_first_idx(h, '最終閲覧日', '最終アクセス日'),
    }
    out = []
    for row in rows:
        def g(i):
            if i is None or i >= len(row):
                return ''
            return str(row[i] or '').strip()
        lead_id = g(idx['lead_id'])
        if not lead_id:
            continue
        # アクション数は数値化
        action_raw = g(idx['action'])
        try:
            action_num = int(float(action_raw)) if action_raw else 0
        except (ValueError, TypeError):
            action_num = 0
        out.append([
            lead_id,
            g(idx['name']),
            g(idx['company']),
            g(idx['busho']),
            g(idx['yakushoku']),
            g(idx['todofuken']),
            g(idx['juuyou']),
            g(idx['endyu']),
            g(idx['hanbai']),
            g(idx['tanto']),
            action_num,
            g(idx['last_view']),
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

    print("\n📥 当期 CSV ダウンロード & 型検証...", flush=True)
    h_curr, r_curr = download_csv(token, INPUT_CSVS['sales_curr'])
    verify_csv_type(INPUT_CSVS['sales_curr'], h_curr, "uriage")
    h_ord, r_ord = download_csv(token, INPUT_CSVS['orders'])
    verify_csv_type(INPUT_CSVS['orders'], h_ord, "juchu")
    h_dt, r_dt = download_csv(token, INPUT_CSVS['dept_targets'])
    verify_csv_type(INPUT_CSVS['dept_targets'], h_dt, "mokuhyo_bumon")
    h_rt, r_rt = download_csv(token, INPUT_CSVS['rep_targets'])
    verify_csv_type(INPUT_CSVS['rep_targets'], h_rt, "mokuhyo_tanto")

    print("\n🔧 当期データ変換中...", flush=True)
    sales_curr = transform_sales(h_curr, r_curr)
    print(f"  当期売上: {len(sales_curr):,}件")
    try:
        orders = transform_orders(h_ord, r_ord)
        print(f"  当期受注: {len(orders):,}件")
    except Exception as e:
        print(f"  ⚠️ 受注明細処理エラー: {e}", flush=True)
        print(f"  → 受注データは空として続行（売上ダッシュボードは動作可能）", flush=True)
        orders = []

    print("\n🎯 目標データ変換中...", flush=True)
    dept_targets = transform_dept_targets(h_dt, r_dt)
    rep_targets = transform_rep_targets(h_rt, r_rt)
    dept_total_keys = sum(len(v) for v in dept_targets.values())
    rep_total_keys  = sum(len(v) for v in rep_targets.values())
    print(f"  部門目標: {len(dept_targets)} 部門 / {dept_total_keys} レコード")
    print(f"  担当者目標: {len(rep_targets)} 担当者 / {rep_total_keys} レコード")

    # --- 営業訪問実績用CSV (新設 2026-07) ---
    daily_reports = []
    web_logs = []
    web_readers = []
    print("\n📥 営業訪問実績CSV取り込み...", flush=True)
    try:
        h_dr, r_dr = download_csv(token, INPUT_CSVS['daily_reports'])
        daily_reports = transform_daily_reports(h_dr, r_dr)
        print(f"  訪問報告: {len(daily_reports):,}件")
    except Exception as e:
        print(f"  ⚠️ daily_reports.csv 処理エラー: {e}", flush=True)
        print(f"  → 訪問報告は空として続行", flush=True)
    try:
        h_wl, r_wl = download_csv(token, INPUT_CSVS['web_logs'])
        web_logs = transform_web_logs(h_wl, r_wl)
        print(f"  HP閲覧ログ: {len(web_logs):,}件")
    except Exception as e:
        print(f"  ⚠️ web_tracking_logs.csv 処理エラー: {e}", flush=True)
        print(f"  → HP閲覧ログは空として続行", flush=True)
    try:
        h_wr, r_wr = download_csv(token, INPUT_CSVS['web_readers'])
        web_readers = transform_web_readers(h_wr, r_wr)
        print(f"  HP閲覧者: {len(web_readers):,}件")
    except Exception as e:
        print(f"  ⚠️ web_tracking_readers.csv 処理エラー: {e}", flush=True)
        print(f"  → HP閲覧者は空として続行", flush=True)

    # マージ
    rows = history_rows + sales_curr
    yms = [r[0] for r in rows if r[0]]
    facts = {
        'rows': rows,
        'order_rows': orders,
        'dept_monthly_targets': dept_targets,
        'rep_monthly_targets':  rep_targets,
        'build_meta': {
            'sales_count': len(rows),
            'orders_count': len(orders),
            'dept_targets_count': dept_total_keys,
            'rep_targets_count':  rep_total_keys,
            'daily_reports_count': len(daily_reports),
            'web_logs_count':      len(web_logs),
            'web_readers_count':   len(web_readers),
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
    print(f"  dept_monthly_targets: {dept_total_keys:,} keys")
    print(f"  rep_monthly_targets:  {rep_total_keys:,} keys")
    print(f"  daily_reports (訪問):  {len(daily_reports):,}件")
    print(f"  web_logs (HP閲覧):     {len(web_logs):,}件")
    print(f"  web_readers (HP閲覧者):{len(web_readers):,}件")
    print(f"  ym range:   {facts['build_meta']['ym_min']} 〜 {facts['build_meta']['ym_max']}")

    # === 訪問実績を別ファイルにアップロード (ログイン高速化のため分離) ===
    visits_facts = {
        'daily_reports': daily_reports,
        'web_logs':      web_logs,
        'web_readers':   web_readers,
        'build_meta': facts['build_meta'],
    }
    print(f"\n📤 dashboard_visits.json をアップロード...", flush=True)
    upload_json(token, 'dashboard_visits.json', visits_facts)

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
