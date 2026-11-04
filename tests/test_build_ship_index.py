"""scripts/build_ship_index.py のテスト。架空の出荷明細・運送会社CSVで ship_index.json ができることを確かめる（実データは使わない）。
実行: python -m unittest tests.test_build_ship_index  （または python tests/test_build_ship_index.py）"""
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_ship_index', ROOT / 'scripts/build_ship_index.py')
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)
CONF = json.loads((ROOT / 'ship_config.json').read_text(encoding='utf-8'))
NOW = datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc)   # 日本時間 11/2 12:00 → keepDays 180 の境目は 2026-05-06

SHIP_HEAD = ['伝票日付', '年月度', '出荷№', '売上№', '明細区分名', '得意先ｺｰﾄﾞ', '得意先名１', '納品先ｺｰﾄﾞ', '納品先名', '担当者名', '取引区分名',
             '品目ｺｰﾄﾞ', '品目名', '数量', '受注№', '配送指定日', '配達指定名', '運送業者利用区分', '運送業者利用区分', '客先注番']


def ship_row(date, no, code, qty='1.00', juchu='9001', kubun='1', po='PO-1', kind='通常', torihiki='掛売上', want='0', time='', ship_no='0', dest='架空商事 本社', dest_code='000010'):
    return [date, date[:6], ship_no, no, kind, '100001', '架空得意先', dest_code, dest, '山田', torihiki, code, code + '名', qty, juchu, want, time,
            kubun, {'0': '', '1': '西濃利用', '2': 'トナミ利用', '3': '第一貨物利用'}[kubun], po]


def csv_text(rows, delim=','):
    def cell(c):
        c = str(c)
        return '"' + c.replace('"', '""') + '"' if any(x in c for x in ('"', delim, '\n')) else c
    return '\r\n'.join(delim.join(cell(c) for c in r) for r in rows) + '\r\n'


class BuildShipIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def write(self, rel, text, enc='utf-8-sig', mtime=None):
        p = os.path.join(self.dir, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding=enc, newline='') as f:
            f.write(text)
        if mtime:
            os.utime(p, (mtime, mtime))
        return p

    def write_ships(self):
        self.write('出荷明細出力.txt', csv_text([SHIP_HEAD,
            ship_row('20261002', '0036683', 'UDL-250', '2.00', juchu='9001', kubun='3'),
            ship_row('20261002', '0036683', 'FR', '1.00', juchu='9001', kubun='3'),
            ship_row('20261002', '0036683', '消費税', '0', juchu='0', kubun='3', kind='消費税'),   # 実物の消費税の行は、受注№ が 0
            ship_row('20261030', '37610', 'DA-P', '1.00', juchu='9002', kubun='1', po='PO-2', want='20261105', time='午前', ship_no='555'),
            ship_row('20261031', '37611', 'XA', '3.00', juchu='9002', kubun='1', po='PO-2'),
            ship_row('20261101', '37620', 'KOTEI', '1', juchu='9003', kubun='0', po=''),
            ship_row('20261005', '36729', 'UDL-150', '1', juchu='9004', kubun='2', po='PO-4'),
            ship_row('20261020', '37300', 'RET', '-1.00', juchu='9005', kubun='1', torihiki='掛返品'),
            ship_row('20261026', '37630', 'DIRECT', '1', juchu='0', kubun='1', po=''),      # 受注を通さない売上（受注№ が 0）
            ship_row('20250301', '12345', 'OLD', '1', juchu='7000', kubun='1')]))      # 180日より前

    def write_carriers(self):
        phone, addr = '03-9999-0000', '架空県架空市1-2-3'
        seino_head = ['出荷予定日', '管理番号', 'お問合せ番号', '個数', '重量（Ｋ)', 'お届け先電話番号', 'お届け先住所１']
        self.write('_ship_inbox/seino/0485415711_old.csv', csv_text([seino_head,
            ['20261030', '37610', '9072200001', '4', '110', phone, addr],     # 後のファイルで発行し直された
            ['20261031', '037611', '9072200002', '1', '73', phone, addr]]), 'cp932', mtime=1_780_000_000)
        self.write('_ship_inbox/seino/0485415711_new.csv', csv_text([seino_head,
            ['20261030', '37610', '9072200101', '4', '110', phone, addr],
            ['20261030', '37610', '9072200102', '1', '20', phone, addr],      # 同じ売上№に2つめの送り状
            ['20261101', '', '9072200999', '1', '5', phone, addr],            # 管理番号が空
            ['20261101', '39999', '9072200998', '1', '5', phone, addr],       # SMILE に無い売上№
            ['20250301', '12345', '9072200001', '1', '5', phone, addr]]), 'cp932', mtime=1_790_000_000)   # 古い出荷（索引の対象外だが、SMILE には有る）
        def dai(slip, key, date, qty, kg):
            r = [''] * 45
            r[0], r[2], r[8], r[35], r[36], r[37], r[42] = slip, addr, phone, date, qty, kg, key
            return r
        self.write('_ship_inbox/daiichi/ID123download.csv', csv_text([dai('40100000001', '36683', '2026/10/02', '3', '60')]), 'cp932', mtime=1_790_000_000)   # 見出しなし
        self.write('_ship_inbox/tonami/csv/SYUKKA_LIST_20261102/SYUKKA_LIST.csv', csv_text([
            ['送り状No', '指定No記号', '出荷日', '個数', '重量', '荷受人電話番号'], ['5910000002', '36729', '2026/10/05', '1', '70', phone]]), 'cp932', mtime=1_790_000_000)

    def write_juchu(self):
        head = ['受注日付', '受注№', '行', '納期', '出荷予定日', '担当者名', '客先注番']
        self.write('受注明細出力.csv', csv_text([head,
            ['20260925', '9001', '1', '20261002', '20261002', '山田', 'PO-1'],
            ['20260925', '9001', '2', '20261002', '20261002', '山田', 'PO-1'],
            ['20261020', '9002', '1', '20261030', '20261029', '佐藤', 'PO-2'],
            ['20200101', '8888', '1', '20200105', '20200105', '誰か', 'PO-X']], '\t'))

    def run_build(self, **kw):
        with redirect_stdout(io.StringIO()) as out:
            res = B.build(self.dir, CONF, now=NOW, **kw)
        return res, out.getvalue()

    def read_index(self):
        with open(os.path.join(self.dir, 'ship_index.json'), encoding='utf-8') as f:
            return json.load(f)

    def ships(self, idx):
        return {s['no']: s for s in idx['ships']}

    def test_売上番号ごとにまとめる(self):
        self.write_ships(); self.write_carriers(); self.write_juchu()
        self.run_build()
        idx = self.read_index()
        S = self.ships(idx)
        self.assertEqual(sorted(S), ['36683', '36729', '37300', '37610', '37611', '37620', '37630'])      # 先頭の 0 は外す・古い出荷は入らない
        s = S['36683']
        self.assertEqual((s['date'], s['cust'], s['dest'], s['destName'], s['kubun']), ('2026-10-02', '100001', '000010', '架空商事 本社', '3'))
        self.assertEqual(s['lines'], [['UDL-250', 'UDL-250名', '2', '9001'], ['FR', 'FR名', '1', '9001']])     # 消費税の行は品目に入れない・数量は 2.00 → 2
        self.assertEqual((s['juchu'], s['po'], s['shipNo']), (['9001'], ['PO-1'], ''))
        s = S['37610']
        self.assertEqual((s['shipNo'], s['want'], s['time']), ('555', '2026-11-05', '午前'))
        self.assertEqual(S['37620']['po'], [])
        self.assertEqual((S['37630']['juchu'], S['37630']['lines']), ([], [['DIRECT', 'DIRECT名', '1', '']]))   # 受注№ 0 は受注なし（'0' を受注として出さない）
        self.assertTrue(S['37300']['ret'])
        self.assertFalse(S['37610']['ret'])
        self.assertEqual([x['no'] for x in idx['ships']], ['37620', '37611', '37610', '37630', '37300', '36729', '36683'])   # 出荷日の新しい順

    def test_3社の送り状番号が売上番号でつながる(self):
        self.write_ships(); self.write_carriers()
        self.run_build()
        S = self.ships(self.read_index())
        self.assertEqual(S['36683']['slips'], [{'c': 'daiichi', 'no': '40100000001', 'qty': '3', 'kg': '60', 'date': '2026-10-02'}])   # 見出しなしの CSV
        self.assertEqual(S['36729']['slips'][0]['no'], '5910000002')                                                                  # トナミ（サブフォルダの CSV）
        self.assertEqual(S['36729']['slips'][0]['c'], 'tonami')
        self.assertEqual(S['37611']['slips'][0]['no'], '9072200002')                                                                  # 管理番号 '037611' の先頭の 0 を外して比べる
        self.assertEqual(S['37620']['slips'], [])                                                                                      # 運送会社を使わない出荷

    def test_新しいファイルの送り状を使い_同じ売上番号の複数の送り状は残す(self):
        self.write_ships(); self.write_carriers()
        self.run_build()
        S = self.ships(self.read_index())
        self.assertEqual([x['no'] for x in S['37610']['slips']], ['9072200101', '9072200102'])    # 古いファイルの 9072200001 は発行し直し前

    def test_SMILEに無い送り状と管理番号が空の行を数える(self):
        self.write_ships(); self.write_carriers()
        res, _ = self.run_build()
        self.assertEqual(res['unmatched'], [{'c': 'seino', 'key': '39999', 'slip': '9072200998', 'date': '2026-11-01'}])   # 古い出荷（12345）は SMILE に有るので不一致にしない
        self.assertEqual(res['counts']['blankKey'], 1)
        self.assertEqual(res['counts']['ships'], 7)
        self.assertEqual(res['counts']['withSlip'], 4)

    def test_運送会社ごとの取得期間と最新のファイル(self):
        self.write_ships(); self.write_carriers()
        res, _ = self.run_build()
        c = res['carriers']
        self.assertEqual((c['seino']['name'], c['seino']['kubun'], c['seino']['files']), ('西濃運輸', '1', 2))
        self.assertEqual((c['seino']['from'], c['seino']['to']), ('2025-03-01', '2026-11-01'))
        self.assertEqual((c['daiichi']['from'], c['daiichi']['to'], c['tonami']['from']), ('2026-10-02', '2026-10-02', '2026-10-05'))
        self.assertTrue(c['seino']['newest'].endswith('Z'))

    def test_受注の要約が付く(self):
        self.write_ships(); self.write_carriers(); self.write_juchu()
        res, _ = self.run_build()
        self.assertEqual(res['juchu']['9001'], {'date': '2026-09-25', 'due': '2026-10-02', 'plan': '2026-10-02', 'lines': 2, 'staff': '山田'})
        self.assertEqual(res['juchu']['9002']['plan'], '2026-10-29')
        self.assertNotIn('8888', res['juchu'])      # 出荷に出てこない受注は入れない
        self.assertNotIn('9003', res['juchu'])      # 受注明細に無い受注は要約なし（出荷は入る）

    def test_受注明細が無くても作れる(self):
        self.write_ships()
        res, out = self.run_build()
        self.assertEqual(res['juchu'], {})
        self.assertIn('受注明細出力.csv はありません', out)

    def test_運送会社のフォルダが無くても作れる(self):
        self.write_ships()
        res, _ = self.run_build()
        self.assertEqual(res['unmatched'], [])
        self.assertEqual(res['carriers']['seino']['files'], 0)
        self.assertTrue(all(s['slips'] == [] for s in res['ships']))

    def test_運送会社のCSVの電話や住所は索引に入れない(self):
        self.write_ships(); self.write_carriers(); self.write_juchu()
        self.run_build()
        with open(os.path.join(self.dir, 'ship_index.json'), encoding='utf-8') as f:
            text = f.read()
        self.assertNotIn('03-9999-0000', text)
        self.assertNotIn('架空県架空市', text)

    # ---- 送り先の住所（納品先マスタ・得意先マスタ）
    DEST_HEAD = ['得意先ｺｰﾄﾞ', '得意先名', '納品先ｺｰﾄﾞ', '納品先名', '荷受け人名１', '郵便番号', '住所１', '住所２', '住所３', '電話番号', 'ＦＡＸ番号']
    CUST_HEAD = ['得意先ｺｰﾄﾞ', '得意先名１', '郵便番号', '住所１', '住所２', '住所３', '電話番号']

    def write_masters(self):
        self.write('納品先マスタ.csv', csv_text([self.DEST_HEAD,
            ['100001', '架空得意先', '000010', '架空商事 本社', '山田様', '123-0001', '架空県架空市', '1-2-3', '', '03-1111-2222', '03-1111-3333'],
            ['100001', '架空得意先', '000020', '別の納品先', '', '', '', '', '', '03-1111-4444', ''],      # 住所なし
            ['999999', '関係ない得意先', '000010', '関係ない納品先', '', '999-9999', '関係ない県', '', '', '', '']]))
        self.write('得意先マスタ.csv', csv_text([self.CUST_HEAD,
            ['100001', '架空得意先', '456-0002', '架空県本社市', '4-5-6', '架空ビル', '03-5555-6666'],
            ['888888', '関係ない得意先', '888-8888', '関係ない県', '', '', '']]))

    # ---- 伝票の詳細（ship_detail.json）
    def test_伝票の詳細は行と金額と消費税とメモが入り_原価は入らない(self):
        head = SHIP_HEAD + ['行', '数量単位', '単価', '金額', '課税区分名', '行摘要１', '行摘要２', '備考', '社内メモ', '営業所止め名', '倉庫名', '原単価', '原価金額', '粗利']

        def row(no, code, kind, line, unit, price, amount, tax, t1, t2, memo, note, cost='7777', juchu='9001'):
            return ship_row('20261030', no, code, '2.00', juchu=juchu, kind=kind) + [line, unit, price, amount, tax, t1, t2, note, memo, '', '本社倉庫', cost, cost, '8888']
        self.write('出荷明細出力.txt', csv_text([head,
            row('40001', 'A-1', '通常', '1', '台', '1000.00', '2000', '税抜き', '摘要甲', '', '社内の連絡', 'お客様への備考'),
            row('40001', 'B-2', '通常', '2', '個', '1100.00', '2200', '税抜き', '', '摘要乙', '社内の連絡', 'お客様への備考'),
            row('40001', '消費税', '消費税', '1', '', '0.00', '420', '消費税等', '', '', '社内の連絡', 'お客様への備考', juchu='0'),
            row('40002', 'C-3', '通常', '1', '式', '300.00', '300', '非課税', '', '', '', '')]))
        res, _ = self.run_build()
        with open(os.path.join(self.dir, 'ship_detail.json'), encoding='utf-8') as f:
            raw = f.read()
        d = json.loads(raw)['details']
        self.assertEqual(sorted(d), ['40001', '40002'])
        self.assertEqual(d['40001']['tax'], 420)                                        # 消費税の行の金額
        self.assertEqual((d['40001']['memo'], d['40001']['note']), ('社内の連絡', 'お客様への備考'))
        self.assertEqual([l[1] for l in d['40001']['lines']], ['A-1', 'B-2'])           # 消費税の行は品目に入れない
        self.assertEqual(d['40001']['lines'][0], ['1', 'A-1', 'A-1名', '2', '台', '1000', '2000', '税抜き', '摘要甲', '', '本社倉庫'])
        self.assertEqual(d['40002']['tax'], 0)
        for secret in ('7777', '8888'):                                                 # 原単価・原価金額・粗利は入れない
            self.assertNotIn(secret, raw)
        self.assertEqual(len(res['ships']), 2)

    def test_消費税だけの伝票は詳細に入れない(self):
        self.write('出荷明細出力.txt', csv_text([SHIP_HEAD,
            ship_row('20261030', '40001', 'DA-P', '1.00'),
            ship_row('20261030', '40002', '消費税', '0', juchu='0', kind='消費税')]))
        self.run_build()
        with open(os.path.join(self.dir, 'ship_detail.json'), encoding='utf-8') as f:
            self.assertEqual(sorted(json.load(f)['details']), ['40001'])

    def test_住所は納品先マスタから付く_電話は入れない(self):
        self.write_ships(); self.write_masters()
        res, out = self.run_build()
        self.assertEqual(res['addr']['100001|000010'], {'z': '123-0001', 'a': '架空県架空市1-2-3'})   # 住所１〜３をつなぐ
        self.assertNotIn('999999|000010', res['addr'])                      # 出荷に出てこない組み合わせは入れない
        self.assertEqual(res['counts']['withAddr'], len(res['ships']))
        with open(os.path.join(self.dir, 'ship_index.json'), encoding='utf-8') as f:
            text = f.read()
        for secret in ('03-1111-2222', '03-1111-3333', '03-5555-6666', '山田様', '関係ない'):
            self.assertNotIn(secret, text)
        self.assertEqual([m['name'] for m in res['masters']], ['納品先マスタ.csv'])
        self.assertNotIn('架空県架空市', out)                               # ログには値を出さない

    def test_納品先なしの出荷は得意先マスタの住所(self):
        self.write('出荷明細出力.txt', csv_text([SHIP_HEAD,
            ship_row('20261030', '40001', 'A', dest_code='000000', dest=''),
            ship_row('20261030', '40002', 'B', dest_code='', dest=''),
            ship_row('20261030', '40003', 'C', dest_code='000020'),        # 納品先マスタに住所が無い → 得意先の住所は使わない
            ship_row('20261030', '40004', 'D')]))
        self.write_masters()
        res, _ = self.run_build()
        self.assertEqual(res['addr']['100001|000000'], {'z': '456-0002', 'a': '架空県本社市4-5-6架空ビル'})
        self.assertEqual(res['addr']['100001|'], res['addr']['100001|000000'])
        self.assertNotIn('100001|000020', res['addr'])
        self.assertEqual(res['counts']['withAddr'], 3)
        self.assertEqual([m['name'] for m in res['masters']], ['納品先マスタ.csv', '得意先マスタ.csv'])

    def test_マスタが無い_読めなくても作れる(self):
        self.write_ships()
        res, _ = self.run_build()
        self.assertEqual((res['addr'], res['masters'], res['counts']['withAddr']), ({}, [], 0))
        self.write('納品先マスタ.csv', csv_text([['全然違う見出し', 'x'], ['1', '2']]))     # 必須の列が無い
        res, out = self.run_build()
        self.assertEqual(res['addr'], {})
        self.assertIn('住所を読めませんでした', out)
        self.assertTrue(res['ships'])

    def test_消費税だけの伝票は出荷として出さない(self):
        self.write('出荷明細出力.txt', csv_text([SHIP_HEAD,
            ship_row('20261030', '40001', 'DA-P', '1.00', juchu='9002'),
            ship_row('20261030', '40001', '消費税', '0', juchu='0', kind='消費税'),
            ship_row('20261030', '40002', '消費税', '0', juchu='0', kind='消費税')]))      # 品目の行が無い（消費税だけの伝票）
        res, _ = self.run_build()
        self.assertEqual([s['no'] for s in res['ships']], ['40001'])
        self.assertEqual(res['counts']['ships'], 1)

    def test_送り状は前回の索引から引き継いで積み足す(self):
        self.write_ships(); self.write_carriers()
        self.run_build()
        shutil.rmtree(os.path.join(self.dir, '_ship_inbox'))        # 運送会社のCSVが無くなっても（古いファイルを消した）、送り状番号は残る
        res, _ = self.run_build()
        S = self.ships(self.read_index())
        self.assertEqual(S['36683']['slips'][0]['no'], '40100000001')
        self.assertEqual(sorted(x['no'] for x in S['37610']['slips']), ['9072200101', '9072200102'])
        self.assertEqual(S['36729']['slips'][0]['no'], '5910000002')
        self.assertEqual((res['counts']['withSlip'], res['counts']['carried']), (4, 4))
        self.assertEqual(res['unmatched'], [])                                  # 運送会社のCSVが無いので、SMILE に無い送り状は今回の分だけ（空）

    def test_積み足しは今回の送り状を優先し前回にだけあるものを足す(self):
        self.write_ships(); self.write_carriers()
        self.run_build()
        shutil.rmtree(os.path.join(self.dir, '_ship_inbox'))
        head = ['出荷予定日', '管理番号', 'お問合せ番号', '個数', '重量（Ｋ)']
        self.write('_ship_inbox/seino/new2.csv', csv_text([head, ['20261030', '37610', '9072200101', '9', '999'],      # 同じ番号（今回の個数・重量を使う）
                                                           ['20261030', '37610', '9072200103', '1', '5']]), 'cp932', mtime=1_795_000_000)   # 新しい送り状
        self.run_build()
        slips = {x['no']: x for x in self.ships(self.read_index())['37610']['slips']}
        self.assertEqual(sorted(slips), ['9072200101', '9072200102', '9072200103'])     # 前回の 102 も残る
        self.assertEqual((slips['9072200101']['qty'], slips['9072200101']['kg']), ('9', '999'))

    def test_前回の索引が壊れていても作れる(self):
        self.write_ships(); self.write_carriers()
        self.write('ship_index.json', '{ broken')
        res, _ = self.run_build()
        self.assertEqual(res['counts']['carried'], 0)
        self.assertEqual(self.ships(self.read_index())['36683']['slips'][0]['no'], '40100000001')

    def test_保持期間より古い出荷は引き継がない(self):
        self.write_ships(); self.write_carriers()
        self.run_build()
        shutil.rmtree(os.path.join(self.dir, '_ship_inbox'))
        res, _ = self.run_build(keep_days=20)                                    # 境目は 2026-10-13。10/2 の 36683 は対象外
        S = self.ships(self.read_index())
        self.assertNotIn('36683', S)
        self.assertEqual(S['37610']['slips'][0]['no'][:8], '90722001')

    def test_keepDaysで期間を変えられる(self):
        self.write_ships()
        res, _ = self.run_build(keep_days=20)      # 境目は 2026-10-13
        self.assertEqual(sorted(s['no'] for s in res['ships']), ['37300', '37610', '37611', '37620', '37630'])
        self.assertEqual(res['from'], '2026-10-13')

    def test_読めない運送会社ファイルは飛ばす(self):
        self.write_ships(); self.write_carriers()
        self.write('_ship_inbox/seino/broken.csv', '全然ちがう,見出し\r\n1,2\r\n', 'cp932', mtime=1_795_000_000)
        res, out = self.run_build()
        self.assertEqual(res['carriers']['seino']['files'], 2)
        self.assertIn('読めないファイルを飛ばしました', out)

    def test_失敗したら前回のファイルを残す(self):
        self.write('ship_index.json', '{"keep":"me"}', 'utf-8')
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(FileNotFoundError):
                B.build(self.dir, CONF, now=NOW)       # 出荷明細が無い
        self.assertEqual(self.read_index(), {'keep': 'me'})
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'ship_index.json.tmp')))

    def test_出荷明細の必須の列が無ければ失敗(self):
        self.write('出荷明細出力.txt', csv_text([['伝票日付', '品目ｺｰﾄﾞ'], ['20261002', 'X']]))
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(ValueError):
                B.build(self.dir, CONF, now=NOW)

    def test_Shift_JISの出荷明細も読める(self):
        self.write('出荷明細出力.txt', csv_text([SHIP_HEAD, ship_row('20261002', '100', 'A')]), 'cp932')
        res, _ = self.run_build()
        self.assertEqual(res['ships'][0]['destName'], '架空商事 本社')

    def test_main(self):
        self.write_ships()
        conf = os.path.join(self.dir, 'conf.json')
        Path(conf).write_text(json.dumps(CONF, ensure_ascii=False), encoding='utf-8')
        with redirect_stdout(io.StringIO()):
            self.assertEqual(B.main(['--dir', self.dir, '--config', conf]), 0)
            self.assertEqual(B.main(['--dir', os.path.join(self.dir, 'nothing'), '--config', conf]), 1)
            self.assertEqual(B.main(['--dir', self.dir, '--config', os.path.join(self.dir, 'none.json')]), 1)
        self.assertTrue(os.path.exists(os.path.join(self.dir, 'ship_index.json')))


class HelpersTest(unittest.TestCase):
    def test_norm_key(self):
        self.assertEqual(B.norm_key('037339'), '37339')
        self.assertEqual(B.norm_key('３７３３９'), '37339')
        self.assertEqual(B.norm_key(' 37339 '), '37339')
        self.assertEqual(B.norm_key('000'), '')
        self.assertEqual(B.norm_key(''), '')

    def test_iso_date(self):
        self.assertEqual(B.iso_date('20261002'), '2026-10-02')
        self.assertEqual(B.iso_date('2026/10/2'), '2026-10-02')
        self.assertEqual(B.iso_date('2026-10-02 10:00'), '2026-10-02')
        self.assertEqual(B.iso_date('0'), '')
        self.assertEqual(B.iso_date('00000000'), '')
        self.assertEqual(B.iso_date(''), '')

    def test_num(self):
        self.assertEqual((B.num('1.00'), B.num('1.50'), B.num('-1.00'), B.num('1,200.00'), B.num('abc'), B.num('')), ('1', '1.5', '-1', '1200', 'abc', ''))


if __name__ == '__main__':
    unittest.main()
