#!/usr/bin/env python3
"""
案件管理アプリ：受注番号のある案件に、出荷・送り状の記録をタイムラインへ自動で入れる（GitHub Actions で1時間ごと）。

  受注番号（案件の OrderNumber。「J-26668」「26668・26670」など4桁以上の数字）
    → 出荷（SharedMasters の ship_index.json。送り状検索と同じ。分納＝得意先と客先注番が同じで30日以内の出荷も含む）
    → タイムラインに「📦 出荷」「🚚 送り状発行」を1回ずつ書く（イベントの Title を AUTO-SHIP-売上№ / AUTO-SLIP-運送会社-送り状№ にして二重に書かない）
  未完了の案件には、あわせて 🔔新着（NewInboundAt）と「完了候補」（LastAction＝出荷済み（送り状発行）／出荷済み（運送会社なし））を付ける。
  完了の案件（完了にしてから30日以内）は、記録だけ入れる（新着・完了候補は付けない）。

Teams への通知は Power Automate（「🚚 送り状発行」のイベントができたら担当者にメンション）。
送り状の日付が3日より前の分（過去分）は Summary に「（過去分の記録）」を付けて、通知の対象にしない。

  python scripts/case_ship_sync.py            … 書き込む（GitHub Actions。AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET）
  python scripts/case_ship_sync.py --dry-run  … 書かずに、書く予定の件数と例を出す（--token-file で手元の読み取り用トークンも使える）
  python scripts/case_ship_sync.py --initial  … 初回だけ：すでにある出荷・送り状をまとめて入れる（全部を過去分にして、Teams に一度にたくさん通知しない）
ログには件数と案件ID・番号だけを出す（取引先名・品目名は出さない）。
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import urllib.error
import urllib.request

G = 'https://graph.microsoft.com/v1.0'
SITE = 'hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23'
EVENTS = 'a7cee65e-1815-4992-b2fc-79d7cd9e6d05'   # FAX_EventHistory（タイムライン）
CASES = '674a2392-9a62-40f8-aab9-afebbb9f762a'    # 案件
DRIVE_ID = 'b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8'   # SharedMasters
JST = timezone(timedelta(hours=9))
DONE_KEEP_DAYS = 30       # 完了にしてから何日までの案件に記録を入れるか
BUNNO_DAYS = 30           # 分納とみなす出荷日の幅（送り状検索の設定 bunno.windowDays と同じ）
PAST_DAYS = 3             # これより前の送り状は「過去分」（Teams に通知しない）
NO_CARRIER = ('', '0')    # 運送業者利用区分：運送会社を使わない
CAND_SLIP = '出荷済み（送り状発行）'
CAND_NONE = '出荷済み（運送会社なし）'


def log(m):
    print('[case_ship_sync] ' + m, flush=True)


def token(args):
    if args.token_file:
        return open(args.token_file, encoding='utf-8').read().strip()
    import msal
    app = msal.ConfidentialClientApplication(os.environ['AZURE_CLIENT_ID'], authority='https://login.microsoftonline.com/' + os.environ['AZURE_TENANT_ID'],
                                             client_credential=os.environ['AZURE_CLIENT_SECRET'])
    r = app.acquire_token_for_client(scopes=['https://graph.microsoft.com/.default'])
    if 'access_token' not in r:
        raise RuntimeError(r.get('error_description'))
    return r['access_token']


class Graph:
    """Microsoft Graph を標準ライブラリだけで呼ぶ（手元の PC にも GitHub にも追加の部品が要らない）"""
    def __init__(self, tok):
        self.h = {'Authorization': 'Bearer ' + tok, 'Prefer': 'HonorNonIndexedQueriesWarningMayFailRandomly'}

    def _req(self, method, url, body=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        h = dict(self.h)
        if data is not None:
            h['Content-Type'] = 'application/json'
        req = urllib.request.Request(url if url.startswith('http') else G + url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                t = r.read()
                return json.loads(t) if t else {}
        except urllib.error.HTTPError as e:
            raise RuntimeError('%s %s → %s %s' % (method, url.split('?')[0], e.code, e.read()[:300].decode('utf-8', 'replace')))

    def get(self, url):
        return self._req('GET', url)

    def all(self, url):
        out = []
        while url:
            d = self.get(url)
            out += d.get('value', [])
            url = d.get('@odata.nextLink')
        return out

    def post(self, url, body):
        return self._req('POST', url, body)

    def patch(self, url, body):
        return self._req('PATCH', url, body)


ORDER_RANGE_MAX = 30
RANGE_RE = re.compile(r'(\d{4,})\s*[〜~ー−–—‐-]\s*(?:[A-Za-z]{1,3}\s*-?\s*)?(\d{2,})(?!\d)')


def nos_of(s):
    """受注番号の欄 → 受注№。「27410〜27412」「J-27410〜J-27412」「27410〜12」は続き番号（30件まで）。
    アプリ（case_management.html の orderNosOf）と同じ読み方。変えるときは両方"""
    t = unicodedata.normalize('NFKC', str(s or ''))
    out = set()

    def rng(m):
        a, b = m.group(1), m.group(2)
        end = a[:len(a) - len(b)] + b if len(b) < len(a) else b
        x, y = int(a), int(end)
        if not (x < y <= x + ORDER_RANGE_MAX):
            return m.group(0)
        out.update(str(i) for i in range(x, y + 1))
        return ' '
    t = RANGE_RE.sub(rng, t)
    out.update(x.lstrip('0') for x in re.findall(r'\d{4,}', t))
    return sorted(x for x in out if x)


def dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00')).astimezone(JST)
    except ValueError:
        return None


def day(iso):
    try:
        return datetime.strptime(iso, '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return None


def carrier_name(conf, key):
    c = (conf.get('carriers') or {}).get(key) or {}
    return c.get('name') or key


def kubun_name(conf, kubun):
    for k, c in (conf.get('carriers') or {}).items():
        if not k.startswith('_') and isinstance(c, dict) and str(c.get('kubun')) == str(kubun):
            return c.get('name') or k
    return '運送会社を使わない' if str(kubun or '') in NO_CARRIER else '区分 %s' % kubun


def ships_for(idx_by_juchu, by_po, nos):
    """受注№の出荷と、その分納（得意先＋客先注番が同じで BUNNO_DAYS 日以内）。売上№で重ねない"""
    found, seen = [], set()
    for n in nos:
        for s in idx_by_juchu.get(n, []):
            if s['no'] not in seen:
                seen.add(s['no']); found.append((s, False))
    for s, _ in list(found):
        d0 = day(s.get('date'))
        for p in s.get('po') or []:
            for x in by_po.get((s.get('cust') or '', p), []):
                if x['no'] in seen:
                    continue
                d1 = day(x.get('date'))
                if d0 and d1 and abs((d1 - d0).days) <= BUNNO_DAYS:
                    seen.add(x['no']); found.append((x, True))
    return sorted(found, key=lambda t: (t[0].get('date') or '', t[0]['no']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='書かずに、書く予定だけを出す')
    ap.add_argument('--initial', action='store_true', help='初回：すでにある出荷・送り状をまとめて入れる。全部を過去分にして Teams に通知しない')
    ap.add_argument('--token-file', help='手元で試すときのトークン（読み取りだけ。--dry-run と一緒に）')
    ap.add_argument('--config', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ship_config.json'))
    a = ap.parse_args()
    if a.token_file and not a.dry_run:
        sys.exit('--token-file は --dry-run と一緒に使ってください')
    g = Graph(token(a))
    now = datetime.now(JST)
    # タイムラインの「イベント種別」は選択肢の列（ほかの値は書けない）。「出荷」「送り状発行」が選択肢に無ければ止める
    col = next((c for c in g.all('/sites/%s/lists/%s/columns' % (SITE, EVENTS)) if c.get('name') == 'EventType'), {})
    lack = [v for v in ('出荷', '送り状発行') if v not in ((col.get('choice') or {}).get('choices') or [])]
    if lack:
        msg = 'タイムラインの「イベント種別」の選択肢に %s がありません。SharePoint のリストの設定で足してください' % '・'.join(lack)
        if not a.dry_run:
            sys.exit(msg)
        log('［注意］' + msg)
    conf = json.load(open(a.config, encoding='utf-8'))

    # 出荷の索引（SharedMasters）
    idx = g.get('/drives/%s/root:/ship_index.json:/content' % DRIVE_ID)
    by_j, by_po = {}, {}
    for s in idx.get('ships', []):
        for j in s.get('juchu') or []:
            by_j.setdefault(str(j).lstrip('0'), []).append(s)
        for p in s.get('po') or []:
            if p:
                by_po.setdefault((s.get('cust') or '', p), []).append(s)
    log('出荷 %d 件（%s 作成）' % (len(idx.get('ships', [])), idx.get('generatedAt')))
    # 受注の索引（受注データにある番号か。無い番号＝入力間違いの疑いは、完了候補の判定で数えない）
    try:
        juchu = g.get('/drives/%s/root:/juchu_index.json:/content' % DRIVE_ID).get('juchu') or {}
    except RuntimeError as e:
        log('［注意］受注の索引を読めませんでした（受注番号は全部数えます）：%s' % str(e)[:120])
        juchu = None

    # 対象の案件：受注番号があり、未完了か、完了にして30日以内（完了の日は Modified で近似）
    cases = [dict(v['fields'], _id=v['id']) for v in g.all('/sites/%s/lists/%s/items?$select=id&$expand=fields($select=CaseId,Status,OrderNumber,Modified,LastAction)&$top=999' % (SITE, CASES))]
    targets = []
    for c in cases:
        nos = nos_of(c.get('OrderNumber'))
        st = c.get('Status') or ''
        if not nos or st == 'アーカイブ':
            continue
        if st == '完了' and (not dt(c.get('Modified')) or now - dt(c.get('Modified')) > timedelta(days=DONE_KEEP_DAYS)):
            continue
        sh = ships_for(by_j, by_po, nos)
        if sh:
            targets.append((c, nos, sh))
    log('受注番号のある対象の案件 %d 件のうち、出荷のある案件 %d 件' % (sum(1 for c in cases if nos_of(c.get('OrderNumber')) and c.get('Status') != 'アーカイブ'), len(targets)))

    n_ship = n_slip = n_case = n_notify = n_part = 0
    for c, nos, sh in targets:
        cid = c['CaseId']
        open_case = (c.get('Status') or '') != '完了'
        # 完了候補は、紐づいた受注が全部出荷してから。途中は「一部出荷（1/3）」
        known = [n for n in nos if n in by_j or juchu is None or n in juchu]
        done_n = sum(1 for n in known if n in by_j)
        all_done = done_n == len(known)
        any_slip = any(s.get('slips') for s, _ in sh)
        all_nocar = all(str(s.get('kubun') or '') in NO_CARRIER for s, _ in sh)
        cand = (CAND_SLIP if any_slip else (CAND_NONE if all_nocar else '')) if all_done else '一部出荷（%d/%d）' % (done_n, len(known))
        last = c.get('LastAction') or ''
        # すでに完了候補になっている案件で、まだの受注があると分かったとき（範囲の読み取りで番号が増えたなど）は、一部出荷に戻す
        fix = open_case and not all_done and last.startswith('出荷済み（') and last != cand
        q = quote("fields/CaseId eq '%s'" % cid.replace("'", "''"))
        have = {(v['fields'].get('Title') or '') for v in g.all('/sites/%s/lists/%s/items?$select=id&$expand=fields($select=Title)&$filter=%s&$top=999' % (SITE, EVENTS, q))}
        new = []
        for s, bunno in sh:
            kub = str(s.get('kubun') or '')
            carrier = kubun_name(conf, kub)
            items = [l[1] or l[0] for l in (s.get('lines') or []) if (l[0] or '') not in ('FR',)]
            item_txt = (items[0] + ('ほか%d点' % (len(items) - 1) if len(items) > 1 else '')) if items else ''
            key = 'AUTO-SHIP-%s' % s['no']
            if key not in have:
                new.append({'Title': key, 'EventType': '出荷', 'EventDate': (s.get('date') or now.date().isoformat()) + 'T03:00:00Z',
                            'Summary': '📦 出荷　%s・売上№%s%s%s' % (carrier, s['no'], '・' + item_txt if item_txt else '', '（分納・受注' + '、'.join(s.get('juchu') or []) + '）' if bunno else ''),
                            '_kind': 'ship', '_ship': s})
            for sl in s.get('slips') or []:
                key2 = 'AUTO-SLIP-%s-%s' % (sl.get('c'), sl.get('no'))
                if key2 in have:
                    continue
                sd = day(sl.get('date') or s.get('date'))
                past = a.initial or not sd or (now.date() - sd).days > PAST_DAYS
                new.append({'Title': key2, 'EventType': '送り状発行', 'EventDate': ((sl.get('date') or s.get('date') or now.date().isoformat()) + 'T04:00:00Z'),
                            'Summary': '🚚 送り状発行　%s No.%s%s　売上№%s%s' % (carrier_name(conf, sl.get('c')), sl.get('no'), '（%s個）' % sl['qty'] if sl.get('qty') else '', s['no'],
                                                                     '（過去分の記録）' if past else ''),
                            '_kind': 'slip', '_ship': s, '_past': past})
        if not new:
            if fix:
                n_part += 1
                if a.dry_run:
                    log('［試し］%s：完了候補 → %s に戻す予定' % (cid, cand))
                else:
                    g.patch('/sites/%s/lists/%s/items/%s/fields' % (SITE, CASES, c['_id']), {'LastAction': cand})
            continue
        n_case += 1
        n_ship += sum(1 for e in new if e['_kind'] == 'ship')
        n_slip += sum(1 for e in new if e['_kind'] == 'slip')
        n_notify += sum(1 for e in new if e['_kind'] == 'slip' and not e['_past'])
        # 完了候補：受注が全部出荷して、送り状が出た（または運送会社を使わずに出荷した）。途中は「一部出荷（n/m）」
        if a.dry_run:
            log('［試し］%s：出荷 %d・送り状 %d を書く予定%s' % (cid, sum(1 for e in new if e['_kind'] == 'ship'), sum(1 for e in new if e['_kind'] == 'slip'),
                                                    ('、完了候補「%s」' % cand) if open_case and cand else ''))
            continue
        for e in new:
            s = e['_ship']
            g.post('/sites/%s/lists/%s/items' % (SITE, EVENTS), {'fields': {
                'Title': e['Title'], 'CaseId': cid, 'EventType': e['EventType'], 'EventDate': e['EventDate'], 'RelationType': '社内', 'Summary': e['Summary'],
                'AIOutput_JSON': json.dumps({'kind': 'auto_ship', 'shipNo': s['no'], 'juchu': s.get('juchu') or [], 'past': e.get('_past', False)}, ensure_ascii=False)}})
        if open_case:
            patch = {'NewInboundAt': now.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'LastEventDate': now.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
            if cand:
                patch['LastAction'] = cand
            g.patch('/sites/%s/lists/%s/items/%s/fields' % (SITE, CASES, c['_id']), patch)
    log('%s：案件 %d 件に、出荷 %d・送り状 %d（うち通知の対象 %d）。完了候補から一部出荷に戻した案件 %d 件' % ('試し（書いていない）' if a.dry_run else '書いた', n_case, n_ship, n_slip, n_notify, n_part))


if __name__ == '__main__':
    main()
