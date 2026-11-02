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
  - 電話・住所・お届け先の名前は索引に入れない（送り状番号・個数・重量・出荷日だけ）。

出力（SharedMasters）:
  - ship_index.json … 一時ファイルに書いてから置き換える。失敗したら前回のファイルをそのまま残す。
    {
      "generatedAt": "UTC ISO", "keepDays": 365, "from": "yyyy-mm-dd（これ以降の出荷だけ入っている）",
      "sources":  [{ "name", "modified"(UTC ISO), "rows" }],
      "carriers": { "<キー>": { "name", "kubun", "files", "rows", "from", "to", "newest"(UTC ISO) } },   … 運送会社データがいつからいつまで・いつ届いたか
      "ships":    [ { "no": 売上№, "date", "shipNo", "cust", "custName", "dest", "destName", "staff", "kubun", "want", "time", "ret",
                      "juchu": [受注№], "po": [客先注番], "lines": [[品目コード, 品目名, 数量, 受注№]],
                      "slips": [{ "c": 運送会社キー, "no": 送り状番号, "qty", "kg", "date" }] } ],
      "juchu":    { "<受注№>": { "date", "due", "plan", "lines", "staff" } },
      "unmatched": [{ "c", "key", "slip", "date" }],   … 運送会社にあって、SMILE の出荷明細に売上№が無いもの（SMILE の出力待ちか、番号の違い）
      "counts":   { ... }
    }
  日付は yyyy-mm-dd にそろえる。それ以外の値は SMILE・運送会社の出力のまま（数量だけ 1.00 → 1 のように整える）。

引数・環境変数:
  --dir    … SharedMasters フォルダ（既定は環境変数 SHARED_MASTERS_DIR）
  --config … ship_config.json のパス（運送会社の読み方・keepDays・ファイル名。コードに埋め込まない。常駐スクリプトが main から取得して渡す）
  --keep-days … 直近何日の出荷を入れるか（設定ファイルより優先）

個人情報（得意先・納品先の名前）が入るので、ログには件数だけを出し、値は出さない。
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
DEFAULT_KEEP_DAYS = 365
JST = timezone(timedelta(hours=9))

# 出荷明細から取り出す列。名前は NFKC にそろえて比べる（ｺｰﾄﾞ／コード、全角半角、№／No の違いを吸収する）。
# 先頭の名前が出力の見出しになる。別名があれば後ろに並べる。
SHIP_COLS = [
    ['伝票日付'], ['売上№'], ['出荷№'], ['得意先コード', '得意先ｺｰﾄﾞ'], ['得意先名１', '得意先名'], ['納品先コード', '納品先ｺｰﾄﾞ'], ['納品先名'],
    ['担当者名'], ['品目コード', '品目ｺｰﾄﾞ'], ['品目名'], ['数量'], ['受注№'], ['配送指定日'], ['配達指定名'],
    ['運送業者利用区分'], ['客先注番'], ['明細区分名'], ['取引区分名'],
]
SHIP_REQUIRED = ['伝票日付', '売上№', '品目コード', '受注№']
JUCHU_COLS = [['受注№'], ['行'], ['受注日付'], ['納期', '受注納期'], ['出荷予定日'], ['担当者名']]
JUCHU_REQUIRED = ['受注№']


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


def carrier_plan(conf, header):
    """運送会社の cols（列の名前 or 位置）→ 位置。header=False なら cols は位置（数）、True なら見出しの名前。"""
    cols = conf['cols']
    names = ['key', 'slip', 'date', 'qty', 'weight']
    if not conf.get('header', True):
        return {n: int(cols[n]) if cols.get(n) is not None else -1 for n in names}
    index = {}
    for i, h in enumerate(header):
        index.setdefault(norm(h), i)
    plan = {n: index.get(norm(cols[n]), -1) if cols.get(n) else -1 for n in names}
    for n in ('key', 'slip'):
        if plan[n] < 0:
            raise ValueError('必須の列がありません: ' + str(cols.get(n)))
    return plan


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
                return r[p].strip() if 0 <= p < len(r) else ''
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
            mine.setdefault(key, []).append({'c': ckey, 'no': slip, 'qty': num(g('qty')), 'kg': num(g('weight')), 'date': d})
        for key, recs in mine.items():
            best[key] = recs    # 古い順に読むので、あとのファイルが上書きする
    meta = {'name': conf.get('name', ckey), 'kubun': str(conf.get('kubun', '')), 'files': used, 'rows': rows_total, 'from': dmin, 'to': dmax, 'newest': newest}
    return {'meta': meta, 'best': best, 'blank': blank, 'bad': bad}


# ---------------------------------------------------------------- 出荷明細
def build_ships(path, cutoff):
    """出荷明細から売上№ごとの出荷（cutoff 以降）を作る。(ships の dict, 全売上№の集合, 行数) を返す。"""
    it = read_rows(path)
    try:
        header = next(it)
    except StopIteration:
        raise ValueError('中身が空です')
    plan = column_plan(header, SHIP_COLS, SHIP_REQUIRED)
    P = {names[0]: plan[i] for i, names in enumerate(SHIP_COLS)}
    ships, all_nos, total = {}, set(), 0
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
        if g('明細区分名') == '消費税':   # 消費税の行は品目ではない
            continue
        code = g('品目コード')
        if code:
            s['lines'].append([code, g('品目名'), num(g('数量')), jn])
    return ships, all_nos, total


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
    """今回の送り状を先に、前回にだけあるものを後ろに足す（同じ運送会社・同じ番号は今回を使う）。"""
    seen = {(x['c'], x['no']) for x in current}
    return list(current) + [x for x in previous if (x.get('c'), x.get('no')) not in seen]


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
    ships, all_nos, total = build_ships(p, cutoff)
    sources.append({'name': os.path.basename(p), 'modified': mtime_iso(p), 'rows': total})
    # 品目の行が1つも無い売上№（消費税だけの伝票）は、出荷ではないので検索の対象にしない（実データでは出荷の2割ほど。all_nos には残すので、運送会社の番号の突き合わせには影響しない）
    tax_only = [k for k, s in ships.items() if not s['lines']]
    for k in tax_only:
        del ships[k]
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
        'ships': out_ships, 'juchu': juchu, 'unmatched': unmatched,
        'counts': {'ships': len(out_ships), 'withSlip': attached, 'carried': carried, 'unmatched': len(unmatched), 'blankKey': blank_total},
    }
    dest = os.path.join(shared_dir, OUT_NAME)
    tmp = dest + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, dest)   # 置き換えは一瞬。途中で失敗しても前回のファイルは壊れない
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
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
