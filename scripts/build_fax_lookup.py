#!/usr/bin/env python3
"""
FAX の取引先の照合表 fax_relation_lookup.json を、SharedMasters の 得意先マスタ.csv・仕入先マスタ.csv から作る。

使っているのは FAX専用機の FAX の読み取り（fax-incoming-ocr の lookup.py）と、メールの取り込み（web-inquiry-parse の wimail.py）。
どちらも正規表現でレコードを取り出しているので、**出力の形を1文字も変えない**（以前の GitHub Actions の
generate_fax_lookup.py（2026-11 に削除）と同じ規則・同じ並び・空白なし・UTF-8（BOM なし））。

動かし方:
  RPA専用機の常駐スクリプト（rpa_queue_worker.ps1）が、後処理 build_fax_lookup として、毎回 GitHub の main から取得して実行する。
    - 毎日 1:30（rpa_jobs.json の schedules。SMILE の業務予定が 0:00 に両方の CSV を出したあと）
    - SMILE から CSV を出し直すジョブ（ap_purchase・ap_purchase_pre・customer_master）が終わった直後
  同期フォルダ（環境変数 SHARED_MASTERS_DIR）を直接読み書きする。Graph・秘密の鍵は使わない。
  作るのは RPA専用機だけ（ほかの PC で作ると OneDrive で衝突したファイルができる）。

モード（MODE。手で試すときは --mode で変えられる）:
  compare … 比べるだけ。作った内容を本番のファイルと比べて、結果をログに書く。本番は書き換えない（手で確かめるとき）
  write   … 本番の fax_relation_lookup.json を置き換える

規則（以前の generate_fax_lookup.py と同じ）:
  列：コード=0、正式名=1、略称=3、電話=10、FAX=11（得意先・仕入先とも同じ位置）。1行目は見出しなので読まない。正式名が空の行は入れない。
  文字コードは utf-8-sig を試して、だめなら cp932。
  {"relations":[{"c":..,"n":..,"a":..,"t":..,"f":..,"tp":"得意先|仕入先"},...],"updated":"YYYY-MM-DD HH:MM JST"}

安全策:
  - 一時ファイル（.tmp。OneDrive は同期しない）に書いてから置き換える。
  - 得意先・仕入先のどちらかの件数が、今のファイルより 10% 以上減ったら、置き換えずに止める（CSV が途中までしか同期されていないときなど）。
  - 見出しの列が 12 より少ない・1件も無いときも止める。
  - CSV の更新時刻がその日の 0:00 より前なら知らせる（JSON は作る。中身は前の日と同じなので害はない）。

ログと知らせ:
  - ログ：%USERPROFILE%\\fax_lookup.log（件数・CSV の更新時刻・結果だけ。取引先の名前・電話は書かない）。
  - 止めたとき・古い CSV のときは、Teams「自動処理アラート」へ知らせる。送り先の URL は専用機の環境変数
    ALERT_TEAMS_WEBHOOK_URL にだけ置く（リポジトリ・ログ・画面に出さない）。未設定なら知らせずにログだけ。

終了コード: 0＝作った・比べた（知らせだけのときも 0）／1＝止めた（本番はそのまま）
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

MODE = 'write'   # 2026-11-20 に、Actions の出力と1バイトも違わないことを確かめて切り替えた

CUSTOMERS_CSV = '得意先マスタ.csv'
SUPPLIERS_CSV = '仕入先マスタ.csv'
OUTPUT_FILE = 'fax_relation_lookup.json'

COL_CODE = 0    # コード
COL_NAME1 = 1   # 正式名
COL_ABBR = 3    # 略称
COL_TEL = 10    # 電話番号
COL_FAX = 11    # FAX番号
MIN_COLS = COL_FAX + 1

MAX_DROP = 0.10   # 前回より 10% 以上減ったら止める
WEBHOOK_ENV = 'ALERT_TEAMS_WEBHOOK_URL'
JST = timezone(timedelta(hours=9))


class Stop(Exception):
    """置き換えずに止める理由。"""


def log_path():
    return os.environ.get('FAX_LOOKUP_LOG') or os.path.join(os.path.expanduser('~'), 'fax_lookup.log')


def write_log(msg):
    line = '[%s] %s' % (datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    try:
        with open(log_path(), 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def notify(title, *lines):
    """Teams「自動処理アラート」（Power Automate の Webhook フロー。{title, text}）へ知らせる。失敗しても処理は続ける。URL は出さない。"""
    url = (os.environ.get(WEBHOOK_ENV) or '').strip()
    if not url:
        write_log('知らせ先（環境変数 %s）が未設定のため、知らせません: %s' % (WEBHOOK_ENV, title))
        return False
    esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    text = '<b>' + esc(title) + '</b>' + ''.join('<br>' + esc(t) for t in lines)
    req = urllib.request.Request(url, data=json.dumps({'title': title, 'text': text}).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30):
            pass
        return True
    except Exception as e:   # 例外の文に URL が入ることがあるので、種類だけ
        write_log('知らせに失敗しました（%s）' % type(e).__name__)
        return False


def read_csv(path):
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp932', errors='replace')
    return list(csv.reader(io.StringIO(text)))


def col(row, idx):
    return row[idx].strip() if len(row) > idx else ''


def relations_of(rows, tp):
    out = []
    for row in rows[1:]:   # 1行目は見出し
        name = col(row, COL_NAME1)
        if not name:
            continue
        out.append({'c': col(row, COL_CODE), 'n': name, 'a': col(row, COL_ABBR),
                    't': col(row, COL_TEL), 'f': col(row, COL_FAX), 'tp': tp})
    return out


def build_lookup(customer_rows, supplier_rows, now=None):
    now = now or datetime.now(JST)
    relations = relations_of(customer_rows, '得意先') + relations_of(supplier_rows, '仕入先')
    return {'relations': relations, 'updated': now.astimezone(JST).strftime('%Y-%m-%d %H:%M JST')}


def dump(lookup):
    return json.dumps(lookup, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def count_by_type(relations):
    c = {'得意先': 0, '仕入先': 0}
    for r in relations:
        c[r.get('tp')] = c.get(r.get('tp'), 0) + 1
    return c


def check_rows(rows, name):
    if not rows or len(rows[0]) < MIN_COLS:
        raise Stop('%s の見出しの列が %d より少ない（%d 列）' % (name, MIN_COLS, len(rows[0]) if rows else 0))


def check_drop(new_counts, old_counts):
    for tp in ('得意先', '仕入先'):
        new, old = new_counts.get(tp, 0), old_counts.get(tp, 0)
        if new == 0:
            raise Stop('%s が 0 件' % tp)
        if old and new < old * (1 - MAX_DROP):
            raise Stop('%s の件数が前回より大きく減った（%d → %d）' % (tp, old, new))


def read_current(path):
    """今の本番ファイル（無ければ None）。"""
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        return raw, json.loads(raw.decode('utf-8'))
    except FileNotFoundError:
        return None, None


def replace_file(path, data, tries=5):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    for i in range(tries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:   # OneDrive やウイルス対策が一瞬開いていることがある
            if i == tries - 1:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            time.sleep(3)


def stale_files(paths, now):
    """その日の 0:00 より前に更新された CSV の (名前, 更新時刻)。"""
    midnight = now.astimezone(JST).replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for p in paths:
        m = datetime.fromtimestamp(os.path.getmtime(p), JST)
        if m < midnight:
            out.append((os.path.basename(p), m))
    return out


def compare(new_lookup, cur_raw, cur):
    """本番と比べる（updated 以外）。(同じか, 説明) を返す。説明に名前・電話は入れない。"""
    if cur is None:
        return False, '本番のファイルがない'
    same_bytes = dump(dict(new_lookup, updated=cur.get('updated'))) == cur_raw
    if same_bytes:
        return True, '同じ（updated 以外は1バイトも違わない）'
    a = {json.dumps(r, ensure_ascii=False, sort_keys=True) for r in cur.get('relations', [])}
    b = {json.dumps(r, ensure_ascii=False, sort_keys=True) for r in new_lookup['relations']}
    return False, '違う（本番 %d 件・新 %d 件、本番だけ %d 件・新だけ %d 件%s）' % (
        len(cur.get('relations', [])), len(new_lookup['relations']), len(a - b), len(b - a),
        '・並びか書き方だけ違う' if a == b else '')


def run(shared_dir, mode, now=None):
    now = now or datetime.now(JST)
    cust_path = os.path.join(shared_dir, CUSTOMERS_CSV)
    supp_path = os.path.join(shared_dir, SUPPLIERS_CSV)
    out_path = os.path.join(shared_dir, OUTPUT_FILE)
    mtimes = ' / '.join('%s %s' % (os.path.basename(p), datetime.fromtimestamp(os.path.getmtime(p), JST).strftime('%m-%d %H:%M'))
                        for p in (cust_path, supp_path) if os.path.exists(p))
    try:
        for p in (cust_path, supp_path):
            if not os.path.exists(p):
                raise Stop('%s がない' % os.path.basename(p))
        cust_rows, supp_rows = read_csv(cust_path), read_csv(supp_path)
        check_rows(cust_rows, CUSTOMERS_CSV)
        check_rows(supp_rows, SUPPLIERS_CSV)
        lookup = build_lookup(cust_rows, supp_rows, now)
        counts = count_by_type(lookup['relations'])
        cur_raw, cur = read_current(out_path)
        check_drop(counts, count_by_type(cur['relations']) if cur else {})
    except Stop as e:
        write_log('[%s] 止めました（本番はそのまま）: %s（CSV: %s）' % (mode, e, mtimes))
        notify('【止めました】FAX の取引先の照合表（fax_relation_lookup.json）', str(e),
               '本番のファイルは前のまま。CSV: ' + mtimes, 'RPA専用機 build_fax_lookup.py')
        return 1

    stale = stale_files((cust_path, supp_path), now)
    summary = '得意先 %d・仕入先 %d（CSV: %s）' % (counts['得意先'], counts['仕入先'], mtimes)
    if mode == 'write':
        replace_file(out_path, dump(lookup))
        write_log('[write] 置き換えました: %s' % summary)
    else:
        same, desc = compare(lookup, cur_raw, cur)
        write_log('[compare] %s: %s / 本番の updated %s' % (desc, summary, cur.get('updated') if cur else '-'))
    if stale:
        msg = '・'.join('%s（%s）' % (n, m.strftime('%m-%d %H:%M')) for n, m in stale)
        write_log('[%s] 今日の分でない CSV があります: %s' % (mode, msg))
        notify('【確認】FAX の取引先の照合表：マスタの CSV が今日の分ではありません', msg,
               'SMILE の 0:00 の出力が動いたか確かめてください。照合表は前の日と同じ内容で作りました。',
               'RPA専用機 build_fax_lookup.py')
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='fax_relation_lookup.json を同期フォルダの CSV から作る')
    ap.add_argument('--mode', choices=('compare', 'write'), default=MODE)
    ap.add_argument('--dir', default=os.environ.get('SHARED_MASTERS_DIR'), help='SharedMasters の同期フォルダ')
    args = ap.parse_args(argv)
    if not args.dir or not os.path.isdir(args.dir):
        write_log('SharedMasters の同期フォルダが分かりません（環境変数 SHARED_MASTERS_DIR）')
        return 1
    return run(args.dir, args.mode)


if __name__ == '__main__':
    sys.exit(main())
