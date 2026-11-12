#!/usr/bin/env python3
"""
受注伝票の索引 juchu_index.json を作る（案件管理アプリで、受注番号から受注伝票を SMILE の伝票ふうに出すため）。

SMILE の受注明細（SharedMasters の 受注明細出力.csv。90MB 前後・毎晩0時ごろ更新）から、受注日が直近 keepDays 日の受注を
受注№ごとにまとめ、SharedMasters に juchu_index.json として置く。案件管理アプリは受注№で引くだけ（書き込みはしない）。
送り先は、納品先マスタ（納品先があるとき）か得意先マスタ（納品先なしのとき）から、使われる組み合わせの分だけ足す。

  {
    "generatedAt": "UTC ISO", "keepDays": 400, "from": "yyyy-mm-dd",
    "source": { "name": "受注明細出力.csv", "modified": "受注明細・納品先マスタ・得意先マスタの更新日時", "rows": 行数 },
    "juchu": { "<受注№>": {
        "date": 受注日, "cust": 得意先コード, "custName": 得意先名, "dest": 納品先コード, "destName": 納品先名,
        "po": 客先注番, "staff": 担当者名, "dept": 部門名, "tax": 消費税率, "tori": 取引区分名,
        "due": 受注納期, "plan": 出荷予定日, "mfg": 製造納期,
        "kubun": 運送業者利用区分（SMILE の値。出荷アプリの設定と同じ）, "wantDate": 配送指定日, "wantName": 配達指定名, "stop": 営業所止め名,
        "memo": 社内メモ, "note": 備考, "status": 受注区分名,
        "lines": [[行, 品目コード, 品目名, 数量, 単位, 単価, 金額, 手配区分名, 納期, 出荷予定日, 売上済数量, 完納区分名, 摘要1, 摘要2, 倉庫名, 製番, 製造納期, 製造数量]] } },
    "dests": { "<得意先コード>|<納品先コード>": { "c": 納品先コード, "n": 名前, "r1": 荷受け人名1, "r2": 荷受け人名2, "z": 郵便番号, "a1": 住所1, "a2": 住所2・3, "t": 電話番号 } }
  }
  日付は yyyy-mm-dd、数量・金額は SMILE の値のまま（1.00 → 1 のように整える）。原単価・原価・粗利は入れない。

使い方：
  GitHub Actions（AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET）… SharedMasters から読み、SharedMasters に書く。
    受注明細・マスタが前回から変わっていなければ何もしない（--force で必ず作る）。
  手元の試し：python scripts/build_juchu_index.py --src <受注明細出力.csv のあるフォルダ> --out <出力先.json>
個人情報（得意先・納品先の名前・住所・電話）が入るので、ログには件数だけを出す。
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_ship_index import read_rows, column_plan, iso_date, norm_key  # noqa: E402  出荷の索引と同じ読み方

SRC_NAME = '受注明細出力.csv'
DEST_NAME = '納品先マスタ.csv'
CUST_NAME = '得意先マスタ.csv'
OUT_NAME = 'juchu_index.json'
DEFAULT_KEEP_DAYS = 400
NO_DEST = '000000'   # 納品先コードが「納品先なし」（得意先そのものに送る）
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"   # SharedMasters（generate_fax_lookup.py と同じ）
JST = timezone(timedelta(hours=9))

# 受注明細から取る列（名前は NFKC にそろえて比べる。先頭が見出し）
COLS = [
    ['受注№'], ['行'], ['受注日付'], ['得意先コード', '得意先ｺｰﾄﾞ'], ['得意先名１', '得意先名'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'],
    ['担当者名'], ['部門名'], ['納期'], ['出荷予定日'], ['品目コード', '品目ｺｰﾄﾞ'], ['品目名'], ['数量'], ['数量単位'], ['単価'], ['金額'],
    ['手配区分名'], ['売上済数量'], ['完納区分名'], ['行摘要１'], ['行摘要２'], ['倉庫名'], ['備考'], ['社内メモ'], ['客先注番'],
    ['運送業者利用区分'], ['配達指定名'], ['配送指定日'], ['受注区分名'], ['消費税率％'], ['営業所止め名'], ['製番'], ['製造納期(年月日)'], ['取引区分名'], ['製造数量'],
]
REQUIRED = ['受注№', '受注日付']
DEST_COLS = [['得意先コード', '得意先ｺｰﾄﾞ'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'], ['荷受け人名１'], ['荷受け人名２'],
             ['郵便番号'], ['住所１'], ['住所２'], ['住所３'], ['電話番号']]
CUST_COLS = [['得意先コード', '得意先ｺｰﾄﾞ'], ['得意先名１', '得意先名'], ['郵便番号'], ['住所１'], ['住所２'], ['住所３'], ['電話番号']]


def log(msg):
    print('[build_juchu_index] ' + msg, flush=True)


def tidy(v):
    """数量・金額の 1.00 → 1、空白の整理"""
    v = (v or '').strip()
    try:
        f = float(v.replace(',', ''))
        return str(int(f)) if f == int(f) else ('%g' % f)
    except ValueError:
        return v


def zero_date(v):
    """SMILE は日付が無いとき 0 を入れる"""
    v = (v or '').strip()
    return '' if v in ('', '0') else (iso_date(v) or '')


def build(src_path, keep_days, dest_path=None, cust_path=None, now=None):
    now = now or datetime.now(JST)
    since = (now - timedelta(days=keep_days)).date().isoformat()
    it = read_rows(src_path)
    header = next(it)
    plan = column_plan(header, COLS, REQUIRED)
    ix = dict(zip([c[0] for c in COLS], plan))
    g = lambda r, k: (r[ix[k]].strip() if ix[k] >= 0 and ix[k] < len(r) else '')
    out, rows = {}, 0
    for r in it:
        rows += 1
        no = norm_key(g(r, '受注№'))
        d = iso_date(g(r, '受注日付'))
        if not no or not d or d < since:
            continue
        j = out.get(no)
        if j is None:
            j = out[no] = {
                'date': d, 'cust': g(r, '得意先コード'), 'custName': g(r, '得意先名１'), 'dest': g(r, '納品先コード'), 'destName': g(r, '納品先名'),
                'po': g(r, '客先注番'), 'staff': g(r, '担当者名'), 'dept': g(r, '部門名'), 'tax': tidy(g(r, '消費税率％')), 'tori': g(r, '取引区分名'),
                'due': zero_date(g(r, '納期')), 'plan': zero_date(g(r, '出荷予定日')), 'mfg': zero_date(g(r, '製造納期(年月日)')),
                'kubun': g(r, '運送業者利用区分'), 'wantDate': zero_date(g(r, '配送指定日')), 'wantName': g(r, '配達指定名'), 'stop': g(r, '営業所止め名'),
                'memo': g(r, '社内メモ'), 'note': g(r, '備考'), 'status': g(r, '受注区分名'), 'lines': [],
            }
        # 行によって入っていたりいなかったりする項目は、空なら後の行で埋める
        for k, col in (('memo', '社内メモ'), ('note', '備考'), ('po', '客先注番'), ('wantName', '配達指定名'), ('stop', '営業所止め名')):
            if not j[k]:
                j[k] = g(r, col)
        if not j['mfg']:
            j['mfg'] = zero_date(g(r, '製造納期(年月日)'))
        seiban = g(r, '製番').strip()
        j['lines'].append([
            tidy(g(r, '行')), g(r, '品目コード'), g(r, '品目名'), tidy(g(r, '数量')), g(r, '数量単位'), tidy(g(r, '単価')), tidy(g(r, '金額')),
            g(r, '手配区分名'), zero_date(g(r, '納期')), zero_date(g(r, '出荷予定日')), tidy(g(r, '売上済数量')), g(r, '完納区分名'),
            g(r, '行摘要１'), g(r, '行摘要２'), g(r, '倉庫名'), '' if seiban in ('', '00') else seiban, zero_date(g(r, '製造納期(年月日)')), tidy(g(r, '製造数量')),
        ])
    for j in out.values():
        j['lines'].sort(key=lambda l: int(l[0]) if str(l[0]).isdigit() else 9999)
    dests = build_dests(out, dest_path, cust_path)
    return {'generatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'keepDays': keep_days, 'from': since,
            'source': {'name': SRC_NAME, 'rows': rows}, 'juchu': out, 'dests': dests}


def build_dests(juchu, dest_path, cust_path):
    """受注で使われる送り先だけ、納品先マスタ（納品先あり）・得意先マスタ（納品先なし）から足す。電話・住所も入れる（社内の画面で SMILE と同じ値を見るため）"""
    want_dest = {(j['cust'], j['dest']) for j in juchu.values() if j['dest'] and j['dest'] != NO_DEST}
    want_cust = {j['cust'] for j in juchu.values() if not j['dest'] or j['dest'] == NO_DEST}
    out = {}
    if want_dest and dest_path and os.path.exists(dest_path):
        it = read_rows(dest_path)
        p = column_plan(next(it), DEST_COLS, ['得意先コード', '納品先コード'])
        for r in it:
            v = [(r[i].strip() if 0 <= i < len(r) else '') for i in p]
            if (v[0], v[1]) in want_dest:
                out[v[0] + '|' + v[1]] = {'c': v[1], 'n': v[2], 'r1': v[3], 'r2': v[4], 'z': v[5], 'a1': v[6], 'a2': ' '.join(x for x in v[7:9] if x), 't': v[9]}
    if want_cust and cust_path and os.path.exists(cust_path):
        it = read_rows(cust_path)
        p = column_plan(next(it), CUST_COLS, ['得意先コード'])
        for r in it:
            v = [(r[i].strip() if 0 <= i < len(r) else '') for i in p]
            if v[0] in want_cust:
                out[v[0] + '|'] = {'c': '', 'n': v[1], 'r1': '', 'r2': '', 'z': v[2], 'a1': v[3], 'a2': ' '.join(x for x in v[4:6] if x), 't': v[6]}
    return out


# ---- SharePoint（GitHub Actions） ----
def graph_token():
    import msal
    app = msal.ConfidentialClientApplication(os.environ['AZURE_CLIENT_ID'], authority='https://login.microsoftonline.com/' + os.environ['AZURE_TENANT_ID'],
                                             client_credential=os.environ['AZURE_CLIENT_SECRET'])
    res = app.acquire_token_for_client(scopes=['https://graph.microsoft.com/.default'])
    if 'access_token' not in res:
        raise RuntimeError(res.get('error_description'))
    return res['access_token']


def run_sharepoint(keep_days, force):
    import requests
    from requests.utils import quote
    H = {'Authorization': 'Bearer ' + graph_token()}
    base = 'https://graph.microsoft.com/v1.0/drives/%s/root:/' % DRIVE_ID
    mods = []
    for name in (SRC_NAME, DEST_NAME, CUST_NAME):
        m = requests.get(base + quote(name, safe=''), headers=H, timeout=60)
        mods.append(m.json().get('lastModifiedDateTime', '') if m.ok else '')
    src_mod = '|'.join(mods)
    if not force:
        cur = requests.get(base + quote(OUT_NAME, safe='') + ':/content', headers=H, timeout=120)
        if cur.ok:
            try:
                if (cur.json().get('source') or {}).get('modified') == src_mod:
                    log('受注明細・マスタは前回から変わっていないので、作り直さない')
                    return
            except ValueError:
                pass
    with tempfile.TemporaryDirectory() as td:
        paths = {}
        for name in (SRC_NAME, DEST_NAME, CUST_NAME):
            p = paths[name] = os.path.join(td, name)
            with requests.get(base + quote(name, safe='') + ':/content', headers=H, timeout=600, stream=True) as r:
                if not r.ok and name != SRC_NAME:
                    log('%s を読めなかったので、送り先は付けない（%d）' % (name, r.status_code)); continue
                r.raise_for_status()
                with open(p, 'wb') as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
        idx = build(paths[SRC_NAME], keep_days, paths[DEST_NAME], paths[CUST_NAME])
    idx['source']['modified'] = src_mod
    body = json.dumps(idx, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    up = requests.put(base + quote(OUT_NAME, safe='') + ':/content', headers={**H, 'Content-Type': 'application/json'}, data=body, timeout=300)
    up.raise_for_status()
    log('受注 %d 件・送り先 %d 件（明細 %d 行を読んだ）を %s に書いた（%d KB）' % (len(idx['juchu']), len(idx['dests']), idx['source']['rows'], OUT_NAME, len(body) // 1024))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', help='手元の SharedMasters フォルダ（受注明細出力.csv・納品先マスタ.csv・得意先マスタ.csv のある所。指定すると SharePoint は使わない）')
    ap.add_argument('--out', help='手元に書き出す先（--src と一緒に使う）')
    ap.add_argument('--keep-days', type=int, default=DEFAULT_KEEP_DAYS)
    ap.add_argument('--force', action='store_true', help='受注明細・マスタが変わっていなくても作り直す')
    a = ap.parse_args()
    if a.src:
        idx = build(os.path.join(a.src, SRC_NAME), a.keep_days, os.path.join(a.src, DEST_NAME), os.path.join(a.src, CUST_NAME))
        body = json.dumps(idx, ensure_ascii=False, separators=(',', ':'))
        if a.out:
            with open(a.out, 'w', encoding='utf-8') as f:
                f.write(body)
        log('受注 %d 件・送り先 %d 件（明細 %d 行を読んだ、%d KB）' % (len(idx['juchu']), len(idx['dests']), idx['source']['rows'], len(body.encode('utf-8')) // 1024))
        return
    run_sharepoint(a.keep_days, a.force)


if __name__ == '__main__':
    main()
