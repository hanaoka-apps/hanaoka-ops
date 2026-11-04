#!/usr/bin/env python3
"""
出荷・配送の検索アプリ（ship_search.html）用の軽量ファイル ship_index.json を作る。

SMILE の出荷明細（出荷明細出力.txt は 90MB 前後）と、運送会社 3社の CSV（送り状番号）を売上№でつなぎ、
直近 keepDays 日の出荷だけを SharedMasters 直下の ship_index.json に書き出す。受注明細出力.csv からは、
出荷に出てくる受注№の分だけ、受注日・納期・出荷予定日を足す（検索画面で受注と出荷をつなげて見るため）。

入力（SharedMasters。OneDrive 同期済みのフォルダ。環境変数 SHARED_MASTERS_DIR）:
  - 出荷明細出力.txt     … 必須。売上№ごとに1出荷にまとめる（消費税の行は品目に入れない）
  - 受注明細出力.csv     … 任意（無くてもよい）。受注日・納期・出荷予定日・行数
  - _ship_inbox/<会社>/  … 運送会社のCSV（任意。サブフォルダも含めて *.csv をすべて読む）。読み方は ship_config.json の carriers
  （タブ区切り・カンマ区切り、UTF-8 / Shift-JIS のどれでも読む。1行ずつ処理するのでメモリは少なくて済む）

運送会社のCSVの扱い:
  - つなぎの項目は「売上№」（西濃・第一貨物＝管理番号、トナミ＝指定No記号）。先頭の 0 は外して比べる（'037339' と '37339' は同じ）。空は除く。
  - 取得期間が重なる複数のファイルは、売上№ごとに「新しいファイルに載っているもの」を使う（1回抜けても前のファイルで補える。送り状を発行し直したときは新しい方）。
  - 運送会社のCSVの電話は索引に入れない。お届け先の名前・郵便番号・住所・配達指定・記事（品名のメモ）は、伝票と見比べるために、送り状ごとに入れる
    （n＝名前（名称１・２をつなげたもの）、n1・n2＝名称１・名称２、z＝郵便番号、a＝住所、w＝配達指定、m＝記事。列は ship_config.json の cols の toName・toZip・toAddr・want・note）。
  - 送り先の住所は、SMILE のマスタから足す（下の「住所」）。電話・FAX は入れない。

住所（出荷明細には住所の列が無い）:
  - 納品先が決まっている出荷 … 納品先マスタ.csv（得意先ｺｰﾄﾞ＋納品先ｺｰﾄﾞ）の郵便番号・住所１〜３
  - 納品先なし（納品先ｺｰﾄﾞが 000000 か空）の出荷 … 得意先マスタ.csv（得意先ｺｰﾄﾞ）の郵便番号・住所１〜３
  - マスタに無い組み合わせは、住所なし。マスタは「いまの」住所で、出荷した時点のものとは限らない。
  - 出荷ごとには持たず、"addr": { "<得意先>|<納品先>": { "z": 郵便番号, "a": 住所 } } に、使われる組み合わせの分だけ入れる。
  - マスタのファイル名・納品先なしの値は、設定 smile.destMaster / custMaster / noDest。

出力（SharedMasters）:
  - ship_detail.json … 伝票の詳細 { "generatedAt", "details": { "<売上№>": { "memo": 社内メモ, "note": 備考, "stop": 営業所止め, "tax": 消費税の合計,
                         "lines": [[行, 品目コード, 品名, 数量, 単位, 単価, 金額, 課税区分, 行摘要１, 行摘要２, 倉庫]] } } }
                       画面は、カードを押したときに初めて読む（索引を重くしない）。原単価・原価金額・粗利は入れない。
  - ship_index.json … 一時ファイルに書いてから置き換える。失敗したら前回のファイルをそのまま残す。
    {
      "generatedAt": "UTC ISO", "keepDays": 365, "from": "yyyy-mm-dd（これ以降の出荷だけ入っている）",
      "sources":  [{ "name", "modified"(UTC ISO), "rows" }],
      "carriers": { "<キー>": { "name", "kubun", "files", "rows", "from", "to", "newest"(UTC ISO) } },   … 運送会社データがいつからいつまで・いつ届いたか
      "ships":    [ { "no": 売上№, "date", "shipNo", "cust", "custName", "dest", "destName", "staff", "kubun", "want", "time", "ret",
                      "juchu": [受注№], "po": [客先注番], "lines": [[品目コード, 品目名, 数量, 受注№]],
                      "slips": [{ "c": 運送会社キー, "no": 送り状番号, "qty", "kg", "date", "n", "n1", "n2", "z", "a", "w", "m" }] } ],
      "juchu":    { "<受注№>": { "date", "due", "plan", "lines", "staff" } },
      "addr":     { "<得意先>|<納品先>": { "z": 郵便番号, "a": 住所, "r": 荷受け人名（納品先マスタの荷受け人名１・２。宛名の２行目に入る） } },   … 送り先の住所（上の「住所」）
      "masters":  [{ "name", "modified"(UTC ISO), "rows" }],              … 住所を読んだマスタ（古さの警告には使わない）
      "unmatched": [{ "c", "key", "slip", "date" }],   … 運送会社にあって、SMILE の出荷明細に売上№が無いもの（SMILE の出力待ちか、番号の違い）
      "counts":   { ... }
    }
  日付は yyyy-mm-dd にそろえる。それ以外の値は SMILE・運送会社の出力のまま（数量だけ 1.00 → 1 のように整える）。

引数・環境変数:
  --dir    … SharedMasters フォルダ（既定は環境変数 SHARED_MASTERS_DIR）
  --config … ship_config.json のパス（運送会社の読み方・keepDays・ファイル名。コードに埋め込まない。常駐スクリプトが main から取得して渡す）
  --keep-days … 直近何日の出荷を入れるか（設定ファイルより優先）

個人情報（得意先・納品先の名前・住所）が入るので、ログには件数だけを出し、値は出さない。
標準ライブラリだけで動く（requests などは不要）。専用機の常駐スクリプトが毎回 GitHub の最新を取得して実行する。
"""
import argparse
import codecs
import csv
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

OUT_NAME = 'ship_index.json'
DETAIL_NAME = 'ship_detail.json'   # 伝票の詳細（品目の全行・単価・金額・摘要・備考・社内メモ）。カードを押したときだけ画面が読む
DEFAULT_KEEP_DAYS = 365
JST = timezone(timedelta(hours=9))

# 出荷明細から取り出す列。名前は NFKC にそろえて比べる（ｺｰﾄﾞ／コード、全角半角、№／No の違いを吸収する）。
# 先頭の名前が出力の見出しになる。別名があれば後ろに並べる。
SHIP_COLS = [
    ['伝票日付'], ['売上№'], ['出荷№'], ['得意先コード', '得意先ｺｰﾄﾞ'], ['得意先名１', '得意先名'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'],
    ['担当者名'], ['品目コード', '品目ｺｰﾄﾞ'], ['品目名'], ['数量'], ['受注№'], ['配送指定日'], ['配達指定名'],
    ['運送業者利用区分'], ['客先注番'], ['明細区分名'], ['取引区分名'],
    # 伝票の詳細（ship_detail.json）用。原単価・原価金額・粗利は取らない
    ['行'], ['数量単位'], ['単価'], ['金額'], ['課税区分名'], ['行摘要１'], ['行摘要２'], ['備考'], ['社内メモ'], ['営業所止め名'], ['倉庫名'],
]
SHIP_REQUIRED = ['伝票日付', '売上№', '品目コード', '受注№']
JUCHU_COLS = [['受注№'], ['行'], ['受注日付'], ['納期', '受注納期'], ['出荷予定日'], ['担当者名']]
JUCHU_REQUIRED = ['受注№']
# 納品先マスタ・得意先マスタから取り出す列（住所。電話は取らない）
DEST_COLS = [['得意先コード', '得意先ｺｰﾄﾞ'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['郵便番号'], ['住所１'], ['住所２'], ['住所３'], ['荷受け人名１'], ['荷受け人名２']]
CUST_COLS = [['得意先コード', '得意先ｺｰﾄﾞ'], ['郵便番号'], ['住所１'], ['住所２'], ['住所３']]
NO_DEST = '000000'   # 納品先コードが「納品先なし」（得意先そのものに送る）のときの値（設定 smile.noDest で変えられる）


def log(msg):
    print('[build_ship_index] ' + msg, flush=True)


def norm(s):
    return unicodedata.normalize('NFKC', str(s)).replace(' ', '').replace('　', '').strip()


def norm_key(s):
    """売上№・管理番号をそろえる。全角→半角、先頭の 0 を外す。空（や 0 だけ）は ''。"""
    v = unicodedata.normalize('NFKC', str(s)).strip()
    if v.isdigit():
        return v.lstrip('0')
    return v


def iso_date(s):
    """20261002 / 2026/10/02 / 2026-10-2 → 2026-10-02。読めなければ ''（0 だけの日付なども '')。"""
    m = re.match(r'^\s*(\d{4})[/\-.]?(\d{1,2})[/\-.]?(\d{1,2})', unicodedata.normalize('NFKC', str(s)))
    if not m:
        return ''
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    if y < 2000 or not (1 <= mo <= 12 and 1 <= d <= 31):
        return ''
    return '%04d-%02d-%02d' % (y, mo, d)


def num(s):
    """1.00 → 1、1.50 → 1.5。数でなければそのまま。"""
    t = str(s).strip().replace(',', '')
    try:
        f = float(t)
    except ValueError:
        return t
    return str(int(f)) if f == int(f) else ('%g' % f)


def detect_encoding(path):
    """先頭の一部を UTF-8 として読めれば UTF-8（BOM 付きを含む）、だめなら Shift-JIS(cp932)。"""
    with open(path, 'rb') as f:
        head = f.read(1 << 20)
    dec = codecs.getincrementaldecoder('utf-8-sig')()
    try:
        dec.decode(head, final=False)
        return 'utf-8-sig'
    except UnicodeDecodeError:
        return 'cp932'


def read_rows(path):
    """CSV/TSV を1行ずつ返す（区切りは1行目のタブ数・カンマ数で判定。見出しの有無は呼び出し側で扱う）。"""
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
    return [row[p].strip() if 0 <= p < len(row) else '' for p in plan]


def mtime_iso(path):
    return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------- 運送会社の CSV
def carrier_files(inbox, cdir):
    """inbox/cdir の下の *.csv（サブフォルダも含む）。古い順（更新日時、同じなら名前）に並べる。"""
    root = os.path.join(inbox, cdir)
    out = []
    if not os.path.isdir(root):
        return out
    for dp, _dn, fns in os.walk(root):
        for fn in fns:
            if fn.lower().endswith('.csv'):
                p = os.path.join(dp, fn)
                out.append((os.path.getmtime(p), fn, p))
    out.sort()
    return [p for _m, _n, p in out]


CARRIER_SINGLE = ['key', 'slip', 'date', 'qty', 'weight', 'toZip']        # 1つの列
CARRIER_MULTI = ['toName', 'toAddr', 'want', 'note']                      # 複数の列をつなげるもの（名前１・２、住所１・２ など）


def carrier_plan(conf, header):
    """運送会社の cols（列の名前 or 位置）→ 位置。header=False なら cols は位置（数）、True なら見出しの名前。
    toName・toAddr・want・note は、複数の列（リスト）。お届け先の名前・住所・郵便番号・配達指定・品名などの記事は、
    伝票と見比べるための控え（送り状に載る内容）。電話は取らない。列が見つからないものは、無いものとして飛ばす。"""
    cols = conf['cols']
    index = {}
    if conf.get('header', True):
        for i, h in enumerate(header):
            index.setdefault(norm(h), i)

    def pos(spec):
        if spec is None or spec == '':
            return -1
        if not conf.get('header', True):
            return int(spec)
        return index.get(norm(spec), -1)
    plan = {n: pos(cols.get(n)) for n in CARRIER_SINGLE}
    for n in CARRIER_MULTI:
        specs = cols.get(n) or []
        plan[n] = [p for p in (pos(s) for s in (specs if isinstance(specs, list) else [specs])) if p >= 0]
    if conf.get('header', True):
        for n in ('key', 'slip'):
            if plan[n] < 0:
                raise ValueError('必須の列がありません: ' + str(cols.get(n)))
    return plan


def join_cols(r, positions, sep=''):
    """行 r の、positions の列の値を、空でないものだけ sep でつなぐ。"""
    return sep.join(v for v in (r[p].strip() for p in positions if 0 <= p < len(r)) if v)


def load_carrier(inbox, ckey, conf):
    """運送会社 1社ぶん。{ 'meta': {...}, 'best': { 売上№: [記録…] }, 'blank': 管理番号が空の行数 } を返す。
    売上№ごとに、その売上№が載っている中で一番新しいファイルの記録だけを残す。"""
    files = carrier_files(inbox, conf['dir'])
    best, blank, rows_total, bad = {}, 0, 0, 0
    dmin = dmax = ''
    newest = ''
    used = 0
    for path in files:
        try:
            it = read_rows(path)
            header = []
            if conf.get('header', True):
                header = next(it)
            plan = carrier_plan(conf, header)
        except Exception:   # 空・別の形式のファイルは読み飛ばす（ファイル名だけログに残す。中身は出さない）
            bad += 1
            log('  %s: 読めないファイルを飛ばしました（%s）' % (conf.get('name', ckey), os.path.basename(path)))
            continue
        used += 1
        newest = max(newest, mtime_iso(path))
        mine = {}
        for r in it:
            def g(k):
                p = plan.get(k, -1)
                return r[p].strip() if isinstance(p, int) and 0 <= p < len(r) else ''
            rows_total += 1
            key, slip = norm_key(g('key')), unicodedata.normalize('NFKC', g('slip')).strip()
            if not slip:
                continue
            if not key:
                blank += 1
                continue
            d = iso_date(g('date'))
            if d:
                dmin = d if not dmin or d < dmin else dmin
                dmax = d if d > dmax else dmax
            rec = {'c': ckey, 'no': slip, 'qty': num(g('qty')), 'kg': num(g('weight')), 'date': d}
            # 送り状に載るお届け先など（伝票と見比べる用）。n＝お届け先の名前、z＝郵便番号、a＝住所、w＝配達指定、m＝記事（品名のメモ）。電話は入れない
            tn = [r[p].strip() for p in plan['toName'][:2] if 0 <= p < len(r)]   # 名称１・名称２（宛名の欄ごとに、切れているか見るため）
            for k, v in (('n', join_cols(r, plan['toName'], ' ')), ('n1', tn[0] if tn else ''), ('n2', tn[1] if len(tn) > 1 else ''), ('z', g('toZip')), ('a', join_cols(r, plan['toAddr'])),
                         ('w', join_cols(r, plan['want'], ' ')), ('m', join_cols(r, plan['note'], ' / '))):
                if v:
                    rec[k] = v
            mine.setdefault(key, []).append(rec)
        for key, recs in mine.items():
            best[key] = recs    # 古い順に読むので、あとのファイルが上書きする
    meta = {'name': conf.get('name', ckey), 'kubun': str(conf.get('kubun', '')), 'files': used, 'rows': rows_total, 'from': dmin, 'to': dmax, 'newest': newest}
    return {'meta': meta, 'best': best, 'blank': blank, 'bad': bad}


# ---------------------------------------------------------------- 出荷明細
def build_ships(path, cutoff):
    """出荷明細から売上№ごとの出荷（cutoff 以降）を作る。(ships の dict, 全売上№の集合, 行数, 伝票の詳細の dict) を返す。
    詳細＝{売上№: {memo 社内メモ, note 備考, stop 営業所止め, tax 消費税の合計, lines [[行, コード, 品名, 数量, 単位, 単価, 金額, 課税区分, 行摘要１, 行摘要２, 倉庫]]}}"""
    it = read_rows(path)
    try:
        header = next(it)
    except StopIteration:
        raise ValueError('中身が空です')
    plan = column_plan(header, SHIP_COLS, SHIP_REQUIRED)
    P = {names[0]: plan[i] for i, names in enumerate(SHIP_COLS)}
    ships, all_nos, total, details = {}, set(), 0, {}
    for r in it:
        total += 1

        def g(k):
            p = P[k]
            return r[p].strip() if 0 <= p < len(r) else ''
        no = norm_key(g('売上№'))
        if not no:
            continue
        all_nos.add(no)
        date = iso_date(g('伝票日付'))
        if not date or date < cutoff:
            continue
        s = ships.get(no)
        if s is None:
            ship_no = g('出荷№').strip()
            kubun = norm(g('運送業者利用区分'))
            s = ships[no] = {
                'no': no, 'date': date, 'shipNo': '' if ship_no in ('', '0') else ship_no,
                'cust': g('得意先コード'), 'custName': g('得意先名１'), 'dest': g('納品先コード'), 'destName': g('納品先名'),
                'staff': g('担当者名'), 'kubun': kubun, 'want': iso_date(g('配送指定日')), 'time': g('配達指定名'),
                'ret': '返品' in g('取引区分名'), 'juchu': [], 'po': [], 'lines': [],
            }
        jn = g('受注№')
        if not jn.strip('0'):   # 受注№ が 0 は「受注なし」（消費税の行・受注を通さない売上）。受注として扱わない
            jn = ''
        if jn and jn not in s['juchu']:
            s['juchu'].append(jn)
        po = g('客先注番')
        if po and po not in s['po']:
            s['po'].append(po)
        d = details.get(no)
        if d is None:
            d = details[no] = {'memo': '', 'note': '', 'stop': '', 'tax': 0, 'lines': []}
        for key, col in (('memo', '社内メモ'), ('note', '備考'), ('stop', '営業所止め名')):   # 伝票の項目は、どの行にも同じものが入っている
            if not d[key] and g(col):
                d[key] = g(col)
        if g('明細区分名') == '消費税':   # 消費税の行は品目ではない（金額＝消費税）
            try:
                d['tax'] += int(float(g('金額').replace(',', '') or 0))
            except ValueError:
                pass
            continue
        code = g('品目コード')
        if code:
            s['lines'].append([code, g('品目名'), num(g('数量')), jn])
            d['lines'].append([g('行'), code, g('品目名'), num(g('数量')), g('数量単位'), num(g('単価')), num(g('金額')), g('課税区分名'),
                               g('行摘要１'), g('行摘要２'), g('倉庫名')])
    return ships, all_nos, total, details


def build_juchu(path, wanted):
    """受注明細から、wanted（受注№の集合）の要約を作る。受注№ごとに最初の行から日付など、行数は数える。"""
    it = read_rows(path)
    try:
        header = next(it)
    except StopIteration:
        raise ValueError('中身が空です')
    plan = column_plan(header, JUCHU_COLS, JUCHU_REQUIRED)
    out, total = {}, 0
    for r in it:
        total += 1
        v = pick(r, plan)
        no = v[0]
        if no not in wanted:
            continue
        j = out.get(no)
        if j is None:
            out[no] = {'date': iso_date(v[2]), 'due': iso_date(v[3]), 'plan': iso_date(v[4]), 'lines': 1, 'staff': v[5]}
        else:
            j['lines'] += 1
    return out, total


def addr_entry(zip_code, parts, recv=''):
    """郵便番号と住所１〜３（と、あれば荷受け人名）から {z, a, r}。みな空なら None。住所は、１〜３をそのままつなぐ。
    荷受け人名は、送り状の宛名（お届け先の名称２）に入るもの（納品先マスタの荷受け人名１・２）。"""
    a = ''.join(p for p in parts if p)
    z = zip_code.strip()
    r = recv.strip()
    if not z and not a and not r:
        return None
    e = {}
    if z:
        e['z'] = z
    if a:
        e['a'] = a
    if r:
        e['r'] = r
    return e


def build_addr(dest_path, cust_path, ships, no_dest):
    """出荷の送り先の住所 {"<得意先>|<納品先>": {z, a}} を作る。ships に出てくる組み合わせだけ。
    納品先が決まっている出荷＝納品先マスタ（得意先＋納品先）、納品先なし（no_dest か空）の出荷＝得意先マスタ（得意先そのもの）。
    マスタに無ければ入れない（住所は付かない）。電話・FAX は取らない。(addr の dict, 読んだマスタの情報のリスト) を返す。"""
    want_dest, want_cust = set(), set()
    for s in ships.values():
        if s['dest'] and s['dest'] != no_dest:
            want_dest.add((s['cust'], s['dest']))
        else:
            want_cust.add(s['cust'])
    out, meta = {}, []
    if want_dest and dest_path and os.path.exists(dest_path):
        it = read_rows(dest_path)
        plan = column_plan(next(it), DEST_COLS, ['得意先コード', '納品先コード'])
        total = 0
        for r in it:
            total += 1
            v = pick(r, plan)
            if (v[0], v[1]) in want_dest:
                e = addr_entry(v[2], v[3:6], ' '.join(x for x in (v[6], v[7]) if x))
                if e:
                    out[v[0] + '|' + v[1]] = e
        meta.append({'name': os.path.basename(dest_path), 'modified': mtime_iso(dest_path), 'rows': total})
    if want_cust and cust_path and os.path.exists(cust_path):
        it = read_rows(cust_path)
        plan = column_plan(next(it), CUST_COLS, ['得意先コード'])
        total = 0
        keys = {}
        for s in ships.values():
            if not s['dest'] or s['dest'] == no_dest:
                keys.setdefault(s['cust'], set()).add(s['dest'])
        for r in it:
            total += 1
            v = pick(r, plan)
            if v[0] in keys:
                e = addr_entry(v[1], v[2:5])
                if e:
                    for d in keys[v[0]]:
                        out[v[0] + '|' + d] = e
        meta.append({'name': os.path.basename(cust_path), 'modified': mtime_iso(cust_path), 'rows': total})
    return out, meta


def load_previous_slips(path):
    """前回の ship_index.json から、売上№ごとの送り状 {売上№: [送り状…]} を読む（積み足しのため）。
    無い・読めないときは空（今回の分だけで作る）。送り状番号・個数・重量・出荷日だけで、お客様の名前・住所・電話は入っていない。"""
    try:
        with open(path, encoding='utf-8') as f:
            prev = json.load(f)
        return {s['no']: [x for x in (s.get('slips') or []) if isinstance(x, dict) and x.get('no')]
                for s in prev.get('ships') or [] if s.get('slips')}
    except Exception:
        return {}


def merge_slips(current, previous):
    """今回の送り状を使い、前回の送り状は、今回のCSVにその運送会社の分が無い売上№のぶんだけ引き継ぐ。
    今回のCSVにその売上№の送り状がある運送会社は、今回の分だけ（送り状を発行し直すと、前の番号は無効になる。前の番号を残すと、お客様に古い番号を伝えてしまう）。
    今回のCSVに、その運送会社の分が無いもの（取得期間より前の出荷・運送会社のCSVが届いていない）は、前回から引き継ぐ。"""
    cur_carriers = {x['c'] for x in current}
    return list(current) + [x for x in previous if x.get('c') not in cur_carriers]


def write_json_atomic(dest, obj):
    """一時ファイルに書いてから置き換える。途中で失敗しても、前回のファイルは壊れない。"""
    tmp = dest + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, dest)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def build(shared_dir, conf, now=None, keep_days=None):
    """ship_index.json を作って書き出す。成功したら書いた内容（dict）を返す。失敗したら例外（前回のファイルは残る）。"""
    now = now or datetime.now(timezone.utc)
    keep = int(keep_days or conf.get('keepDays') or DEFAULT_KEEP_DAYS)
    cutoff = (now.astimezone(JST) - timedelta(days=keep)).strftime('%Y-%m-%d')
    smile = conf.get('smile') or {}
    sources = []

    p = os.path.join(shared_dir, smile.get('shipment') or '出荷明細出力.txt')
    if not os.path.exists(p):
        raise FileNotFoundError(os.path.basename(p) + ' がありません')
    ships, all_nos, total, details = build_ships(p, cutoff)
    sources.append({'name': os.path.basename(p), 'modified': mtime_iso(p), 'rows': total})
    # 品目の行が1つも無い売上№（消費税だけの伝票）は、出荷ではないので検索の対象にしない（実データでは出荷の2割ほど。all_nos には残すので、運送会社の番号の突き合わせには影響しない）
    tax_only = [k for k, s in ships.items() if not s['lines']]
    for k in tax_only:
        del ships[k]
    details = {k: v for k, v in details.items() if k in ships}
    log('出荷明細: 全 %d 行のうち、%s 以降の出荷 %d 件（消費税だけの伝票 %d 件は除く）' % (total, cutoff, len(ships), len(tax_only)))

    inbox = os.path.join(shared_dir, conf.get('inboxDir') or '_ship_inbox')
    carriers, slips_by_key, unmatched = {}, {}, []
    blank_total = 0
    for ckey, cconf in (conf.get('carriers') or {}).items():
        if ckey.startswith('_') or not isinstance(cconf, dict):
            continue
        res = load_carrier(inbox, ckey, cconf)
        carriers[ckey] = res['meta']
        blank_total += res['blank']
        for key, recs in res['best'].items():
            if key in all_nos:
                slips_by_key.setdefault(key, []).extend(recs)
            else:
                unmatched.extend({'c': r['c'], 'key': key, 'slip': r['no'], 'date': r['date']} for r in recs)
        log('%s: ファイル %d 個・%d 行・売上№ %d 件%s' % (cconf.get('name', ckey), res['meta']['files'], res['meta']['rows'], len(res['best']),
                                                  '（読めないファイル %d 個）' % res['bad'] if res['bad'] else ''))
    # 運送会社のCSVは直近45日ぶんだけなので、前回の索引にある送り状は引き継いで積み足す（出荷の保持期間 keepDays の間は、送り状番号が残る）
    previous = load_previous_slips(os.path.join(shared_dir, OUT_NAME))
    attached = carried = 0
    for key, s in ships.items():
        cur = slips_by_key.get(key, [])
        s['slips'] = merge_slips(cur, previous.get(key, []))
        carried += 1 if len(s['slips']) > len(cur) else 0
        attached += 1 if s['slips'] else 0

    # 送り先の住所（出荷明細には住所が無い）。マスタが無い・読めないときは、住所なしで作る（検索はできる）
    addr, masters = {}, []
    try:
        addr, masters = build_addr(os.path.join(shared_dir, smile.get('destMaster') or '納品先マスタ.csv'),
                                   os.path.join(shared_dir, smile.get('custMaster') or '得意先マスタ.csv'),
                                   ships, str(smile.get('noDest') or NO_DEST))
    except Exception as e:
        log('住所を読めませんでした（住所なしで作ります）: %s: %s' % (type(e).__name__, e))
    with_addr = sum(1 for s in ships.values() if s['cust'] + '|' + s['dest'] in addr)
    log('住所: 出荷 %d 件のうち %d 件に付きました（マスタ %s）' % (len(ships), with_addr, '・'.join(m['name'] for m in masters) or 'なし'))

    wanted = {j for s in ships.values() for j in s['juchu']}
    juchu = {}
    jp = os.path.join(shared_dir, smile.get('juchu') or '受注明細出力.csv')
    if wanted and os.path.exists(jp):
        juchu, jtotal = build_juchu(jp, wanted)
        sources.append({'name': os.path.basename(jp), 'modified': mtime_iso(jp), 'rows': jtotal})
        log('受注明細: 全 %d 行のうち、出荷に出てくる受注 %d 件' % (jtotal, len(juchu)))
    elif wanted:
        log('受注明細出力.csv はありません（受注の要約なしで出力します）')

    out_ships = sorted(ships.values(), key=lambda s: (s['date'], int(s['no']) if s['no'].isdigit() else 0), reverse=True)
    unmatched.sort(key=lambda u: (u['date'], u['key']), reverse=True)
    out = {
        'generatedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'keepDays': keep, 'from': cutoff, 'sources': sources, 'carriers': carriers,
        'ships': out_ships, 'juchu': juchu, 'unmatched': unmatched, 'addr': addr, 'masters': masters,
        'counts': {'ships': len(out_ships), 'withSlip': attached, 'withAddr': with_addr, 'carried': carried, 'unmatched': len(unmatched), 'blankKey': blank_total},
    }
    dest = os.path.join(shared_dir, OUT_NAME)
    write_json_atomic(dest, out)
    # 伝票の詳細（カードを押したときだけ画面が読む別のファイル）。失敗しても索引は有効（詳細だけ出ない）
    try:
        write_json_atomic(os.path.join(shared_dir, DETAIL_NAME), {'generatedAt': out['generatedAt'], 'details': details})
        log('伝票の詳細 %d 件 → %s（%.2f MB）' % (len(details), DETAIL_NAME, os.path.getsize(os.path.join(shared_dir, DETAIL_NAME)) / 1048576))
    except Exception as e:
        log('伝票の詳細を書けませんでした（索引はできています）: %s: %s' % (type(e).__name__, e))
    log('出荷 %d 件（送り状あり %d 件・うち前回から引き継ぎ %d 件）・SMILE に無い送り状 %d 件 → %s（%.2f MB）' % (len(out_ships), attached, carried, len(unmatched), OUT_NAME, os.path.getsize(dest) / 1048576))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='出荷・配送の検索アプリ用の軽量ファイル ship_index.json を作る')
    ap.add_argument('--dir', default=os.environ.get('SHARED_MASTERS_DIR'), help='SharedMasters フォルダ')
    ap.add_argument('--config', default=None, help='ship_config.json のパス（運送会社の読み方などをここから読む）')
    ap.add_argument('--keep-days', default=None, help='直近何日の出荷を入れるか（設定ファイルより優先）')
    args = ap.parse_args(argv)
    if not args.dir:
        log('SHARED_MASTERS_DIR（または --dir）を指定してください')
        return 2
    config = args.config or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ship_config.json')
    try:
        with open(config, encoding='utf-8-sig') as f:
            conf = json.load(f)
    except Exception as e:
        log('設定ファイルを読めません（%s）: %s' % (type(e).__name__, e))
        return 1
    try:
        build(args.dir, conf, keep_days=args.keep_days)
    except Exception as e:   # 失敗しても前回の ship_index.json は残っている
        log('失敗しました（前回のファイルはそのままです）: %s: %s' % (type(e).__name__, e))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
