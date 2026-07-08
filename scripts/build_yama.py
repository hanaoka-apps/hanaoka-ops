"""
山リスト用データ集計

雅さん 2026-05-23 構想:
  社内工程ごとに「いつ・どの作業区で・何台」必要かを集計し、棒グラフで可視化する。

データソース:
  - 工程マスタ.csv (工程コード → 手配先名=作業区 のマップ)
  - 製造指図出力.csv (確定済の工程実行手配)
  - 確定済_工程手配一覧.csv (確定済の工程手配、未完成残量)
  - 未確定_購買手配データ.csv (まだ確定されていない工程手配の候補)

集計粒度: 作業区別 × 日付 × 台数
  確定済 (status="確定済") / 確定前 (status="確定前/未確定") を分けて積み上げ可能に

出力:
  data/yama_data.json
  auth_dist/yama_data.js (window.YAMA_DATA = {...};)
"""
import csv
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict
try:
    from zoneinfo import ZoneInfo
    _JST = ZoneInfo("Asia/Tokyo")
except Exception:
    _JST = None

# パスを動的に解決
# scripts/ に置いた場合は .parent.parent でリポジトリルートを指す
BASE = Path(__file__).resolve().parent
if BASE.name == "scripts":
    BASE = BASE.parent
DATA = BASE / "data"
_onedrive_candidates = [
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    BASE.parent / "OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    BASE / "data",  # フォールバック: ローカルスナップショット / GitHub Actions
]
SHARED = next((p for p in _onedrive_candidates if p.exists()), _onedrive_candidates[0])
AUTH_DIST = BASE / "auth_dist"

# CI(GitHub Actions)はUTCのため、JSTで「今日」を確定する(基準日/期間窓が1日ズレる事故防止)。
TODAY = (datetime.now(_JST) if _JST else datetime.now()).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
HORIZON = TODAY + timedelta(days=90)  # 約3ヶ月先まで
PAST_WINDOW = TODAY - timedelta(days=60)  # 雅さん 2026-05-25: 過去2ヶ月までの実績取込


def _norm_date(s):
    if not s:
        return ""
    s = str(s).strip().strip('"')
    if not s:
        return ""
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}/{s[4:6]}/{s[6:8]}"
    if "/" in s and len(s) >= 8:
        parts = s.split("/")
        if len(parts) == 3:
            return f"{parts[0]:>04}/{parts[1].zfill(2)}/{parts[2].zfill(2)}"
    return s


def _parse_date(s):
    if not s:
        return None
    s = str(s).strip().strip('"')
    try:
        if len(s) == 8 and s.isdigit():
            return datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]))
        if "/" in s:
            p = s.split("/")
            return datetime(int(p[0]), int(p[1]), int(p[2]))
    except Exception:
        pass
    return None


def _sf(s):
    try:
        return float(str(s).replace(",", "").strip().strip('"'))
    except Exception:
        return 0.0


def _row_workplace(row):
    """手配行が持つ手配先名(=実際の作業区)を返す。雅さん 2026-06-17:
       工程マスタ参照だけだと工程000201(ロボット溶接)等が引けず第二工場が落ちる。
       行の手配先名(例: 第二工場 ロボット班)を直接作業区に使うのが正しい。"""
    for k in ("手配先名略称", "手配先略称", "手配先名１", "手配先名1", "手配先名"):
        v = (row.get(k) or "").strip().strip('"')
        if v and "使用禁止" not in v:
            return v
    return ""


def _detect_delimiter(path):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        first = f.readline()
    return "\t" if first.count("\t") > first.count(",") else ","


# ===== 2026-07-08 摘要(=音声入力の「適用」)/備考/分納(受入)対応 =====
_Z2H_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")


def _norm_header(s):
    """列名ゆらぎ吸収用の正規化: 空白(全半角)除去 / ｺｰﾄﾞ→コード / 全角数字→半角 / №→番号。
       例: 「行摘要ｺｰﾄﾞ」「行摘要コード」、「備  考 １」「備考１」を同一視する。"""
    if not s:
        return ""
    s = str(s).strip().strip('"')
    s = s.replace(" ", "").replace("　", "")
    s = s.replace("ｺｰﾄﾞ", "コード").replace("№", "番号").replace("Ｎｏ", "番号")
    s = s.translate(_Z2H_DIGITS)
    return s


class _FlexCols:
    """CSVヘッダの表記ゆらぎを吸収して値を引くヘルパ (ファイルごとに1回構築)。"""
    def __init__(self, fieldnames):
        self._m = {}
        for k in (fieldnames or []):
            nk = _norm_header(k)
            if nk and nk not in self._m:
                self._m[nk] = k

    def col(self, *names):
        for n in names:
            k = self._m.get(_norm_header(n))
            if k:
                return k
        return None

    def get(self, row, *names):
        k = self.col(*names)
        if not k:
            return ""
        return (row.get(k) or "").strip().strip('"')

    def find_contains(self, *keywords):
        """正規化ヘッダ名にキーワードを含む最初の実列名 (受入№等のキーワード検出用)"""
        for kw in keywords:
            nkw = _norm_header(kw)
            if not nkw:
                continue
            for nk, k in self._m.items():
                if nkw in nk:
                    return k
        return None


def _attach_tekiyo_biko(rec, row, fc):
    """摘要(行摘要)・備考をレコードに付与。空値はキー自体を付けない(JSON軽量化)。
       雅さん 2026-07-08: 音声入力の「適用」= 実データの「摘要」(行摘要コード/行摘要１/行摘要２)。
       備考は 備考１/備考２ (確定済_購買発注一覧のみ「備考」「備考２」)。"""
    v = fc.get(row, "行摘要コード")
    if v:
        rec["tekiyo_code"] = v
    v = fc.get(row, "行摘要１")
    if v:
        rec["tekiyo1"] = v
    v = fc.get(row, "行摘要２")
    if v:
        rec["tekiyo2"] = v
    v = fc.get(row, "備考１", "備考")  # 確定済_購買発注一覧は「備考」(数字なし)
    if v:
        rec["biko1"] = v
    v = fc.get(row, "備考２")
    if v:
        rec["biko2"] = v


def load_receipt_no_map():
    """受入明細出力.csv から 発注番号→受入№一覧 のマップを構築 (分納の「紐づくNo」用)。
       ファイルがローカルに無い環境でも落ちない (空マップで発注Noのみ運用)。
       列名は固定名でなくキーワード検出 (「受入番号」「入荷番号」「受入№」等) 。要確認: 実列名。"""
    candidates = [SHARED / "受入明細出力.csv", DATA / "受入明細出力.csv"]
    p = next((c for c in candidates if c.exists()), None)
    if p is None:
        print("[受入№] 受入明細出力.csv なし → 発注Noのみで運用 (受入Noは付与されません)")
        return {}
    m = {}
    try:
        delim = _detect_delimiter(p)
        with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            fc = _FlexCols(reader.fieldnames)
            rc_col = fc.find_contains("受入番号", "受入№", "入荷番号", "入荷№", "受入伝票番号", "受入伝票№")
            po_col = fc.find_contains("発注番号", "発注№")
            if not rc_col or not po_col:
                print(f"[受入№] 受入明細出力.csv に受入番号/発注番号列を検出できず → 発注Noのみで運用 "
                      f"(受入列={rc_col!r} / 発注列={po_col!r})")
                return {}
            for row in reader:
                po = (row.get(po_col) or "").strip().strip('"')
                rc = (row.get(rc_col) or "").strip().strip('"')
                if not po or po == "0" or not rc or rc == "0":
                    continue
                lst = m.setdefault(po, [])
                if rc not in lst:
                    lst.append(rc)
        print(f"[受入№] 発注番号→受入№マップ: {len(m):,}発注 (受入列={rc_col} / 発注列={po_col})")
    except Exception as e:
        print(f"[受入№] 読込エラー(継続): {e}")
        return {}
    return m


def _receipt_no_str(receipt_map, po_no):
    """発注番号に紐づく受入№を表示用文字列に (多い場合は先頭5件+件数)"""
    if not receipt_map or not po_no:
        return ""
    lst = receipt_map.get(po_no) or []
    if not lst:
        return ""
    if len(lst) > 5:
        return ",".join(lst[:5]) + f" 他{len(lst)-5}件"
    return ",".join(lst)


# 2026-06-13: 工程マスタ未登録の工程コードを「黙ってスキップ」せず暫定表示する仕組み。
# 例: 000201(第二工場フレーム)が工程マスタ未登録で山リストから丸ごと漏れていた事故対策。
# 工程コード接頭(0001=第一/0002=第二/0003=第三, 1xxxxx=外注)から工場を推定し暫定作業区にする。
def _fallback_wp(code):
    c = (code or "").strip().strip('"')
    if not c or c == "000000":
        return None  # 無効コードは従来通りスキップ
    if c.startswith("0001"):   fac = "第一工場"
    elif c.startswith("0002"): fac = "第二工場"
    elif c.startswith("0003"): fac = "第三工場"
    elif c.startswith("1"):
        return {"workplace": f"外注(未登録 {c})", "internal": False}
    else:
        fac = "その他工程"
    return {"workplace": f"{fac}(未登録工程 {c})", "internal": True}

class _WpMap(dict):
    """工程→作業区マップ。未登録コードは _fallback_wp で暫定値を返す(in/[]/get すべて対応)。"""
    def __contains__(self, code):
        return dict.__contains__(self, code) or (_fallback_wp(code) is not None)
    def __getitem__(self, code):
        if dict.__contains__(self, code):
            return dict.__getitem__(self, code)
        fb = _fallback_wp(code)
        if fb is None:
            raise KeyError(code)
        return fb
    def get(self, code, default=None):
        if dict.__contains__(self, code):
            return dict.__getitem__(self, code)
        fb = _fallback_wp(code)
        return fb if fb is not None else default


def load_process_workplace_map():
    """工程コード → {手配先名(作業区), 内外区分} のマップ。
       社内も社外も両方含める (社内は社内工程の山、社外は外注の山として別途集計)
       工程マスタ未登録の工程コードは _WpMap が工場推定で暫定作業区を返す(漏れ防止)。"""
    p = SHARED / "工程マスタ.csv"
    delim = _detect_delimiter(p)
    proc_to_wp = _WpMap()
    n_internal = 0
    n_external = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            code = (row.get("工程ｺｰﾄﾞ") or row.get("工程コード") or "").strip().strip('"')
            if not code or code == "000000":
                continue
            internal = (row.get("内外区分名") or "").strip().strip('"')
            wp = (row.get("手配先名") or "").strip().strip('"')
            if not wp:
                continue
            if "使用禁止" in wp:
                continue
            proc_to_wp[code] = {
                "workplace": wp,
                "internal": (internal == "社内"),
            }
            if internal == "社内":
                n_internal += 1
            else:
                n_external += 1
    print(f"[工程マスタ] 工程→作業区マップ: 社内{n_internal}件, 社外{n_external}件 / 合計{len(proc_to_wp)}キー")
    return proc_to_wp


def enrich_wp_map_from_arrangements(proc_to_wp):
    """手配データ各行の『工程コード→手配先名』から、工程マスタ未登録の工程を補完する。
       雅さん 2026-06-17: 工程000201(ロボット溶接)等は工程マスタに無いが、手配行は
       手配先名(第二工場 ロボット班)を持つ。これを正規の作業区として学習し、
       _WpMap の『未登録工程』フォールバック表記を出さない(第二工場が落ちる事故の本筋対策)。"""
    sources = [
        ("確定済_工程手配一覧.csv", "工程コード"),
        ("製造指図出力.csv", "工程ｺｰﾄﾞ"),
        ("未確定_購買手配データ.csv", "工程コード"),
    ]
    added = 0
    for fname, pcol in sources:
        p = SHARED / fname
        if not p.exists():
            p = DATA / fname
        if not p.exists():
            continue
        delim = _detect_delimiter(p)
        with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
            for row in csv.DictReader(f, delimiter=delim):
                code = (row.get(pcol) or "").strip().strip('"')
                if not code or code == "000000":
                    continue
                if dict.__contains__(proc_to_wp, code):
                    continue  # 工程マスタに既にあるものは尊重
                wp = _row_workplace(row)
                if not wp:
                    continue
                proc_to_wp[code] = {"workplace": wp, "internal": not code.startswith("1")}
                added += 1
    if added:
        print(f"[工程補完] 手配データから工程→作業区を{added}件学習(工程マスタ未登録分・例:000201ロボット溶接→第二工場ロボット班)")
    return proc_to_wp


def load_item_final_workplace_map(proc_to_wp):
    """品目コード → 最終工程の作業区(=出荷を担う部署) のマップ。
       品目手順マスタで最大の手順№の工程コードを取り、工程マスタから手配先名(=作業区)を引く。
       出荷業務の負荷を「品目の最終工程の部署」に積むため。

       同時に品目ごとの工程合計LT (工程ﾘｰﾄﾞﾀｲﾑ + 検査ﾘｰﾄﾞﾀｲﾑ の総和) を集計して返す。
       これが build_enhanced_summary の rtL に相当し、品目マスタの累積LTより正確。

       戻り値: (item_to_wp, item_route_lt_map)
         item_to_wp:       {item_code: workplace_name}
         item_route_lt_map: {item_code: total_lt_days (int)}
    """
    p = SHARED / "品目手順マスタ.csv"
    if not p.exists():
        # フォールバック: derived CSVから簡易マップを返す
        p_derived = BASE / "data" / "品目最終工程マスタ_derived.csv"
        if p_derived.exists():
            item_to_wp = {}
            with open(p_derived, "r", encoding="utf-8-sig") as f:
                for row in csv.DictReader(f):
                    code = row.get("品目ｺｰﾄﾞ","").strip()
                    wp = row.get("最終作業区","").strip()
                    if code and wp:
                        item_to_wp[code] = wp
            print(f"[品目手順マスタ] derived CSVから{len(item_to_wp)}件読込")
            return item_to_wp, {}
        return {}, {}
    delim = _detect_delimiter(p)
    # item -> (max_route_no, process_code)
    item_max = {}
    # item -> accumulated LT (工程ﾘｰﾄﾞﾀｲﾑ + 検査ﾘｰﾄﾞﾀｲﾑ for all steps)
    item_lt_acc = {}
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            route_no = (row.get("手順№") or "").strip().strip('"')
            proc_code = (row.get("工程ｺｰﾄﾞ") or "").strip().strip('"')
            if not code or not route_no or not proc_code:
                continue
            try:
                rn = int(float(route_no))
            except Exception:
                continue
            cur = item_max.get(code)
            if cur is None or rn > cur[0]:
                item_max[code] = (rn, proc_code)
            # 工程LT + 検査LT を累積
            try:
                lt_proc = float((row.get("工程ﾘｰﾄﾞﾀｲﾑ") or "0").replace(",", ""))
            except Exception:
                lt_proc = 0.0
            try:
                lt_insp = float((row.get("検査ﾘｰﾄﾞﾀｲﾑ") or "0").replace(",", ""))
            except Exception:
                lt_insp = 0.0
            item_lt_acc[code] = item_lt_acc.get(code, 0.0) + lt_proc + lt_insp

    # item_route_lt_map: 合計LTを整数に変換 (0 は除外)
    item_route_lt_map = {
        code: int(round(total))
        for code, total in item_lt_acc.items()
        if total > 0
    }

    # process_code → workplace のマップを引いて item → workplace に変換
    item_to_wp = {}
    for code, (rn, proc_code) in item_max.items():
        wp_info = proc_to_wp.get(proc_code)
        if wp_info and wp_info["internal"]:  # 社内工程のみ (出荷は社内部署が担当)
            item_to_wp[code] = wp_info["workplace"]
    print(f"[品目手順] 品目→最終工程の作業区マップ: {len(item_to_wp):,}品目")
    print(f"[品目手順] 品目→工程合計LTマップ: {len(item_route_lt_map):,}品目 "
          f"(例: {dict(list(item_route_lt_map.items())[:5])})")
    return item_to_wp, item_route_lt_map


def load_shipment_records(item_to_final_wp):
    """出荷山リスト用レコード生成。
       業務種別=「出荷」として、最終工程の作業区に積む (朝の出荷業務)
       データソース:
         過去: 売上明細出力.csv (実績)
         未来: 受注明細出力.csv (未完納分)
    """
    records = []
    # 過去30日の売上実績
    p_sales = SHARED / "売上明細出力.csv"
    if p_sales.exists():
        delim = _detect_delimiter(p_sales)
        with open(p_sales, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            for row in reader:
                d = _parse_date(row.get("伝票日付", ""))
                if d is None or d < PAST_WINDOW or d > HORIZON: continue
                code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
                if code not in item_to_final_wp: continue
                qty = _sf(row.get("数量"))
                if qty <= 0: continue
                records.append({
                    "date": _norm_date(row.get("伝票日付", "")),
                    "workplace": item_to_final_wp[code],
                    "process_code": "",
                    "process_name": "出荷",
                    "item_code": code,
                    "item_name": (row.get("品目名") or "").strip().strip('"'),
                    "seiban": (row.get("製番") or "").strip().strip('"'),
                    "qty": round(qty, 1),
                    "tehai_no": (row.get("売上№") or "").strip().strip('"'),
                    "kind": "shipment",       # 業務種別: 出荷
                    "status": "実績",         # 売上済=出荷実績 (過去) 2026-05-27修正
                    "source": "売上明細",
                })
    # 未来の受注残 (未完納)
    p_so = SHARED / "受注明細出力.csv"
    if p_so.exists():
        delim = _detect_delimiter(p_so)
        with open(p_so, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            for row in reader:
                kanno = (row.get("完納区分名") or "").strip().strip('"')
                if kanno == "完納": continue
                qty = _sf(row.get("数量"))
                sold = _sf(row.get("売上済数量"))
                remaining = qty - sold
                if remaining <= 0: continue
                shukka = (row.get("出荷予定日") or "").strip().strip('"')
                nouki = (row.get("納期") or "").strip().strip('"')
                target = shukka or nouki
                d = _parse_date(target)
                if d is None: continue
                if d < TODAY or d > HORIZON: continue
                code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
                if code not in item_to_final_wp: continue
                records.append({
                    "date": _norm_date(target),
                    "workplace": item_to_final_wp[code],
                    "process_code": "",
                    "process_name": "出荷予定",
                    "item_code": code,
                    "item_name": (row.get("品目名") or "").strip().strip('"'),
                    "seiban": (row.get("製番") or "").strip().strip('"'),
                    "qty": round(remaining, 1),
                    "tehai_no": (row.get("受注№") or "").strip().strip('"'),
                    "kind": "shipment",
                    "status": "所要量計算",  # 受注残=未来予定として中間扱い
                    "source": "受注明細",
                })
    records.sort(key=lambda r: (r["date"], r["workplace"]))
    n_actual = sum(1 for r in records if r["status"]=="確定済")
    n_plan = sum(1 for r in records if r["status"]=="所要量計算")
    print(f"[山リスト/出荷] レコード {len(records):,}件 (実績{n_actual:,} + 予定{n_plan:,})")
    return records


def load_supplier_map():
    """仕入先コード → 仕入先略称 のマップ (購買外注の山リスト用)"""
    p = SHARED / "仕入先マスタ.csv"
    if not p.exists():
        return {}
    delim = _detect_delimiter(p)
    suppliers = {}
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            code = (row.get("仕入先ｺｰﾄﾞ") or row.get("仕入先コード") or "").strip().strip('"')
            name = (row.get("仕入先名略称") or row.get("仕入先略称") or row.get("仕入先名１") or "").strip().strip('"')
            if code and name:
                suppliers[code] = name
    print(f"[仕入先マスタ] {len(suppliers):,}件")
    return suppliers


def load_records(proc_to_wp, scope="internal", supplier_map=None, receipt_map=None):
    """手配レコードを各ソースから収集して統合。
       scope:
         "internal" = 社内工程 (作業区別の山リスト用) … workplace = 工程マスタの手配先名
         "external" = 外注+購買発注 (仕入先別の山リスト用) … workplace = 仕入先略称
       戻り値: [{date, workplace, process_code, process_name, item_code, item_name, seiban, qty, status, kind, source}]
       2026-05-24 雅さん指示: kind={manufacture/external/shipment} × status={確定済/所要量計算/計画} の2軸
    """
    kind_default = "manufacture" if scope == "internal" else "external"
    records = []
    seen_keys = set()

    # 1. 確定済_工程手配一覧.csv (残量あり = 未完成)
    p1 = SHARED / "確定済_工程手配一覧.csv"
    if p1.exists():
        delim = _detect_delimiter(p1)
        with open(p1, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            fc = _FlexCols(reader.fieldnames)
            for row in reader:
                proc_code = (row.get("工程コード") or "").strip().strip('"')
                if proc_code not in proc_to_wp:
                    continue
                wp_info = proc_to_wp[proc_code]
                # scope によって対象を絞る
                if scope == "internal" and not wp_info["internal"]:
                    continue
                if scope == "external" and wp_info["internal"]:
                    continue
                # 完了予定 = 手配納期, 着手予定 = 手配予定日
                end_raw = row.get("手配納期(年月日）", "") or row.get("手配納期（年月日）", "") or row.get("手配日付（年月日）", "")
                start_raw = row.get("手配予定日（年月日）", "") or end_raw
                d = _parse_date(end_raw)
                if d is None: continue
                if d < PAST_WINDOW or d > HORIZON: continue
                qty = _sf(row.get("手配数量"))
                reported = _sf(row.get("報告済数量"))
                remaining = qty - reported
                if remaining <= 0: continue
                tehai_no = (row.get("手配番号") or "").strip().strip('"')
                # 2026-07-08: レコード自身の発注番号列を purchase_no に採用 (外注PO。内部工程は"0")
                #             (製番,コード)マップで別発注Noを撒く旧バグの是正
                hatchu_no = (row.get("発注番号") or "").strip().strip('"')
                seiban = (row.get("製番") or row.get("製　番") or "").strip().strip('"')
                key = (scope, "確定済", seiban, proc_code, tehai_no)
                if key in seen_keys: continue
                seen_keys.add(key)
                rec = {
                    "date": _norm_date(end_raw),
                    "start_date": _norm_date(start_raw),
                    "workplace": _row_workplace(row) or wp_info["workplace"],
                    "process_code": proc_code,
                    "process_name": (row.get("工程略称") or "").strip().strip('"'),
                    "item_code": (row.get("品目コード") or "").strip().strip('"'),
                    "item_name": (row.get("品目名") or row.get("品目名１") or "").strip().strip('"'),
                    "seiban": seiban,
                    "qty": round(remaining, 1),
                    "tehai_no": tehai_no,
                    "status": "確定済",
                    "kind": kind_default,
                    "source": "確定済_工程手配",
                    # 2026-07-08: 進捗表記「報告済/手配数量」用 (qty は従来通り残量)
                    "qty_total": round(qty, 1),
                    "qty_done": round(reported, 1),
                }
                if hatchu_no and hatchu_no != "0":
                    rec["purchase_no"] = hatchu_no
                _attach_tekiyo_biko(rec, row, fc)
                records.append(rec)

    # 2. 製造指図出力.csv (残量あり=未完成) - 確定済工程一覧の補完 (両者に同じデータあり得る、tehai_noで排他)
    p2 = SHARED / "製造指図出力.csv"
    if p2.exists():
        delim = _detect_delimiter(p2)
        with open(p2, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            fc = _FlexCols(reader.fieldnames)  # 行摘要ｺｰﾄﾞ(半角カナ)等のゆらぎ吸収
            for row in reader:
                proc_code = (row.get("工程ｺｰﾄﾞ") or "").strip().strip('"')
                if proc_code not in proc_to_wp:
                    continue
                wp_info = proc_to_wp[proc_code]
                if scope == "internal" and not wp_info["internal"]:
                    continue
                if scope == "external" and wp_info["internal"]:
                    continue
                # 完了予定 = 手配納期, 着手予定 = 手配予定日
                end_raw = row.get("手配納期(年月日)", "") or row.get("手配予定日(年月日)", "")
                start_raw = row.get("手配予定日(年月日)", "") or end_raw
                d = _parse_date(end_raw)
                if d is None: continue
                if d < PAST_WINDOW or d > HORIZON: continue
                qty = _sf(row.get("手配数量"))
                reported = _sf(row.get("報告済数量"))
                remaining = qty - reported
                if remaining <= 0: continue
                tehai_no = (row.get("手配№") or "").strip().strip('"')
                # 2026-07-08: レコード自身の発注№列を purchase_no に採用。
                #             ※手配№は偶然PO発注番号と衝突する例が実データにあるため突合に使わない
                hatchu_no = (row.get("発注№") or row.get("発注番号") or "").strip().strip('"')
                seiban = (row.get("製番") or "").strip().strip('"')
                key = (scope, "確定済", seiban, proc_code, tehai_no)
                if key in seen_keys: continue
                seen_keys.add(key)
                rec = {
                    "date": _norm_date(end_raw),
                    "start_date": _norm_date(start_raw),
                    "workplace": _row_workplace(row) or wp_info["workplace"],
                    "process_code": proc_code,
                    "process_name": (row.get("工程名") or "").strip().strip('"'),
                    "item_code": (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"'),
                    "item_name": (row.get("品目名") or "").strip().strip('"'),
                    "seiban": seiban,
                    "qty": round(remaining, 1),
                    "tehai_no": tehai_no,
                    "status": "確定済",
                    "kind": kind_default,
                    "source": "製造指図明細",
                    # 2026-07-08: 進捗表記「報告済/手配数量」用 (qty は従来通り残量)
                    "qty_total": round(qty, 1),
                    "qty_done": round(reported, 1),
                }
                if hatchu_no and hatchu_no != "0":
                    rec["purchase_no"] = hatchu_no
                _attach_tekiyo_biko(rec, row, fc)
                records.append(rec)

    # 3. 未確定_購買手配データ.csv (社内工程の未確定)
    p3 = SHARED / "未確定_購買手配データ.csv"
    if p3.exists():
        delim = _detect_delimiter(p3)
        with open(p3, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim)
            fc = _FlexCols(reader.fieldnames)
            for row in reader:
                proc_code = (row.get("工程コード") or "").strip().strip('"')
                if proc_code not in proc_to_wp:
                    continue
                wp_info = proc_to_wp[proc_code]
                if scope == "internal" and not wp_info["internal"]:
                    continue
                if scope == "external" and wp_info["internal"]:
                    continue
                # 完了予定 = 手配納期, 着手予定 = 手配予定日 (子部品出庫予定日と通常同じ)
                end_raw = row.get("手配納期(年月日）", "") or row.get("手配納期（年月日）", "") or row.get("最終工程納期（年月日）", "") or row.get("手配予定日（年月日）", "")
                start_raw = row.get("手配予定日（年月日）", "") or row.get("子部品出庫予定日（年月日）", "") or end_raw
                d = _parse_date(end_raw)
                if d is None: continue
                if d < TODAY or d > HORIZON: continue
                qty = _sf(row.get("手配数量"))
                if qty <= 0: continue
                tehai_no = (row.get("手配番号") or "").strip().strip('"')
                seiban = (row.get("内部製番") or "").strip().strip('"')
                key = (scope, "未確定", seiban, proc_code, tehai_no)
                if key in seen_keys: continue
                seen_keys.add(key)
                rec = {
                    "date": _norm_date(end_raw),
                    "start_date": _norm_date(start_raw),
                    "workplace": _row_workplace(row) or wp_info["workplace"],
                    "process_code": proc_code,
                    "process_name": (row.get("工程略称") or "").strip().strip('"'),
                    "item_code": (row.get("品目コード") or "").strip().strip('"'),
                    "item_name": (row.get("品目名") or row.get("品目名１") or "").strip().strip('"'),
                    "seiban": seiban,
                    "qty": round(qty, 1),
                    "tehai_no": tehai_no,
                    "status": "所要量計算",
                    "kind": kind_default,
                    "source": "未確定_購買手配",
                }
                _attach_tekiyo_biko(rec, row, fc)
                records.append(rec)

    # 4. 購買発注の山 (scope=external のみ): 確定済_購買発注一覧 + 未確定の購買データ
    if scope == "external" and supplier_map is not None:
        # 4a. 確定済_購買発注一覧.csv (未入荷分)
        p_po = SHARED / "確定済_購買発注一覧.csv"
        if p_po.exists():
            delim = _detect_delimiter(p_po)
            n_split = 0
            with open(p_po, "r", encoding="utf-8-sig", errors="replace") as f:
                reader = csv.DictReader(f, delimiter=delim)
                fc = _FlexCols(reader.fieldnames)
                for row in reader:
                    # 入庫=1かつ発注=1のみ採用 (出庫指示混入を排除)
                    nyuko = (row.get("入出庫区分") or "").strip().strip('"')
                    if not nyuko.startswith("1") and "入庫" not in nyuko:
                        continue
                    houchu = (row.get("発注区分") or "").strip().strip('"')
                    if houchu and not (houchu.startswith("1") or "購買" in houchu):
                        continue
                    forced = (row.get("強制完納区分") or "").strip().strip('"')
                    if forced and "未完" not in forced and ("完納" in forced or forced.startswith(("1", "2"))):
                        continue
                    d = _parse_date(row.get("納期日", ""))
                    if d is None: continue
                    if d < TODAY - timedelta(days=30) or d > HORIZON: continue
                    qty = _sf(row.get("発注数量"))
                    if qty <= 0: continue
                    supplier_code = (row.get("取引先コード") or "").strip().strip('"')
                    supplier = supplier_map.get(supplier_code) or (row.get("仕入先略称") or "").strip().strip('"')
                    if not supplier:
                        continue
                    hat_no = (row.get("発注番号") or "").strip().strip('"')
                    seiban = (row.get("製　番") or row.get("製番（メイン）") or "").strip().strip('"')
                    key = (scope, "確定済", seiban, "PO", hat_no)
                    if key in seen_keys: continue
                    seen_keys.add(key)
                    # 2026-07-08 分納(一部受入済)対応:
                    #   発注数量(発注単位) と 受入数量(発注単位) で分割し、
                    #   受入済=実績(グレー) / 未受入=確定済(青)。受入分+未受入分=発注数量 (二重計上なし)。
                    #   qty(グラフ集計) は従来通り在庫単位(発注数量)ベース → 受入率で按分して単位混在を防ぐ。
                    qty_ou = _sf(fc.get(row, "発注数量(発注単位)"))
                    recv_ou = _sf(fc.get(row, "受入数量(発注単位)"))
                    if recv_ou < 0: recv_ou = 0.0
                    if qty_ou > 0 and recv_ou > qty_ou: recv_ou = qty_ou
                    recv_stock = qty * (recv_ou / qty_ou) if qty_ou > 0 else 0.0
                    remain_stock = qty - recv_stock
                    receipt_no = _receipt_no_str(receipt_map, hat_no)
                    base = {
                        "date": _norm_date(row.get("納期日", "")),
                        "start_date": _norm_date(row.get("発注日", "")),  # リードタイム期間バラ撒き
                        "workplace": supplier,
                        "process_code": "",
                        "process_name": "購買",
                        "item_code": (row.get("商品コード") or "").strip().strip('"'),
                        "item_name": (row.get("商品名１") or row.get("品目名１") or "").strip().strip('"'),
                        "seiban": seiban,
                        "tehai_no": hat_no,
                        # 2026-07-08: 紐づくNoはこの行自身の発注番号を正とする
                        # (旧: (製番,コード)マップの最初の1件で上書き→別発注Noが複数品目に重複するバグ)
                        "purchase_no": hat_no,
                        "kind": kind_default,
                        # 分納表記「受入/発注」用 (発注単位の値。無ければ在庫単位)
                        "qty_total": round(qty_ou if qty_ou > 0 else qty, 1),
                        "qty_done": round(recv_ou, 1),
                    }
                    if receipt_no:
                        base["receipt_no"] = receipt_no
                    _attach_tekiyo_biko(base, row, fc)
                    # 未受入分 = 確定済(青)。0なら作らない
                    if remain_stock > 0.0001:
                        rec = dict(base)
                        rec["qty"] = round(remain_stock, 1)
                        rec["status"] = "確定済"
                        rec["source"] = "確定済_購買発注"
                        records.append(rec)
                    # 受入済分 = 実績(グレー)。0なら作らない
                    # ※受入明細出力.csv 由来の実績と重複し得るため main() 側で (品目,製番) 一致分を除去
                    if recv_stock > 0.0001:
                        rec = dict(base)
                        # 実績を未来日に置かない (受入は既に起きた事実)。個別の受入日は受入明細側が持つ。
                        recv_date = base["date"]
                        if d > TODAY:
                            recv_date = TODAY.strftime("%Y/%m/%d")
                        rec["date"] = recv_date
                        rec["start_date"] = recv_date
                        rec["qty"] = round(recv_stock, 1)
                        rec["status"] = "実績"
                        rec["source"] = "確定済_購買発注(受入済)"
                        records.append(rec)
                        n_split += 1
            if n_split:
                print(f"[分納] 確定済_購買発注: 一部/全部受入済 {n_split:,}件を実績(グレー)へ分割")
        # 4b. 未確定_購買手配 (購買データ=工程コードなしの分)
        p_un = SHARED / "未確定_購買手配データ.csv"
        if p_un.exists():
            delim = _detect_delimiter(p_un)
            with open(p_un, "r", encoding="utf-8-sig", errors="replace") as f:
                reader = csv.DictReader(f, delimiter=delim)
                fc = _FlexCols(reader.fieldnames)
                for row in reader:
                    proc_code = (row.get("工程コード") or "").strip().strip('"')
                    # 工程コードなしor000000 = 購買データ (工程あり=既にscope3で処理済み)
                    if proc_code and proc_code != "000000":
                        continue
                    # 完了予定 = 手配納期, 着手予定 = 手配予定日
                    end_raw = row.get("手配納期(年月日）", "") or row.get("手配納期（年月日）", "") or row.get("最終工程納期（年月日）", "") or row.get("手配予定日（年月日）", "")
                    start_raw = row.get("手配予定日（年月日）", "") or row.get("子部品出庫予定日（年月日）", "") or end_raw
                    d = _parse_date(end_raw)
                    if d is None: continue
                    if d < TODAY or d > HORIZON: continue
                    qty = _sf(row.get("手配数量"))
                    if qty <= 0: continue
                    supplier_code = (row.get("手配先コード") or "").strip().strip('"')
                    supplier = supplier_map.get(supplier_code) or (row.get("手配先略称") or "").strip().strip('"')
                    if not supplier:
                        continue
                    tehai_no = (row.get("手配番号") or "").strip().strip('"')
                    seiban = (row.get("内部製番") or "").strip().strip('"')
                    key = (scope, "未確定", seiban, "PO", tehai_no)
                    if key in seen_keys: continue
                    seen_keys.add(key)
                    rec = {
                        "date": _norm_date(end_raw),
                        "start_date": _norm_date(start_raw),
                        "workplace": supplier,
                        "process_code": "",
                        "process_name": "購買",
                        "item_code": (row.get("品目コード") or "").strip().strip('"'),
                        "item_name": (row.get("品目名") or row.get("品目名１") or "").strip().strip('"'),
                        "seiban": seiban,
                        "qty": round(qty, 1),
                        "tehai_no": tehai_no,
                        "status": "所要量計算",
                        "kind": kind_default,
                        "source": "未確定_購買手配",
                    }
                    _attach_tekiyo_biko(rec, row, fc)
                    records.append(rec)

    records.sort(key=lambda r: (r["date"], r["workplace"]))
    n_conf = sum(1 for r in records if r["status"]=="確定済")
    n_unconf = sum(1 for r in records if r["status"]=="確定前")
    print(f"[山リスト/{scope}] レコード {len(records):,}件 (確定済{n_conf:,} + 確定前{n_unconf:,})")
    return records


def aggregate_daily(records):
    """日付×作業区×(業務種別+確定度) で台数集計。
       業務種別 kind: manufacture / external / shipment
       確定度 status: 確定済 / 所要量計算 / 計画

       雅さん 2026-05-24 修正指示:
         「綿棒方式 (=日数で割って均す)」をやめる。
         各レコードは start_date〜date の期間に渡って full qty で計上する。
         = その日に「進行中の負荷」を表す。塊の存在が消えない。
         「早く終わらせれば早く次にかかれる」判断ができるように。
    """
    daily = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(float))))
    workplaces = set()
    # 雅さん 2026-05-24: 土日は稼働しないので進行カウントしない
    # ただしレコード単独 (sd == ed) で土日に着く場合はその日に加算 (マスタミスを潰すため可視化)
    # 祝日除外は calendar.PDF をパース後の TODO
    for r in records:
        kind = r.get("kind") or "manufacture"
        status = r.get("status") or "所要量計算"
        wp = r["workplace"]
        qty = r["qty"]
        end_date = r["date"]
        start_date = r.get("start_date") or end_date
        try:
            sd = datetime.strptime(start_date, "%Y/%m/%d")
            ed = datetime.strptime(end_date, "%Y/%m/%d")
            if sd > ed:
                sd, ed = ed, sd
        except Exception:
            sd = ed = None
        if sd is None or ed is None:
            daily[end_date][wp][kind][status] += qty
        elif sd == ed:
            # 雅さん 2026-05-24: 単発でも土日は除外 (日曜に生産指示はあり得ない)
            if sd.weekday() < 5:
                daily[end_date][wp][kind][status] += qty
        else:
            # 期間内の平日のみ full qty を積み上げ (土日除外)
            cur = sd
            while cur <= ed:
                if cur.weekday() < 5:  # 0=月 ... 4=金, 5=土, 6=日
                    dstr = cur.strftime("%Y/%m/%d")
                    daily[dstr][wp][kind][status] += qty
                cur += timedelta(days=1)
        workplaces.add(wp)
    daily_list = []
    for date in sorted(daily.keys()):
        entry = {"date": date, "by_wp": {}}
        for wp, k_map in daily[date].items():
            entry["by_wp"][wp] = {}
            for kind, s_map in k_map.items():
                entry["by_wp"][wp][kind] = {st: round(qty, 1) for st, qty in s_map.items()}
        daily_list.append(entry)
    return daily_list, sorted(workplaces)


def load_plan_records(item_to_final_wp):
    """生産計画出力.csv から計画レコードを取り込む (雅さん 2026-05-25: 計画のみフィルタ用)
       戻り値: [internal_plan_records, external_plan_records (なし、現状は社内側に積む)]"""
    p = SHARED / "生産計画出力.csv"
    rec_int = []
    if not p.exists():
        print(f"[計画] 生産計画出力.csv 見つからず")
        return rec_int, []
    try:
        with open(p, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            cnt = 0
            cnt_done = 0
            for row in reader:
                d_raw = (row.get("生産計画日付") or "").strip().strip('"')
                d = _parse_date(d_raw)
                if d is None: continue
                # 計画日付が過去すぎる or 未来すぎるものはスキップ
                if d < PAST_WINDOW or d > HORIZON: continue
                qty = _sf(row.get("生産計画数量"))
                done = _sf(row.get("完成済数"))
                remaining = qty - done
                if remaining <= 0:
                    cnt_done += 1
                    continue
                code = (row.get("品目ｺｰﾄﾞ") or row.get("品目コード") or "").strip().strip('"')
                name = (row.get("品目名") or "").strip().strip('"')
                seiban = (row.get("製番") or "").strip().strip('"').strip()
                staff = (row.get("担当者名") or row.get("担当者略称") or "").strip().strip('"')
                # 品目から最終工程の作業区
                wp = item_to_final_wp.get(code) or "計画(作業区未定)"
                dstr = _norm_date(d_raw)
                rec_int.append({
                    "date": dstr, "start_date": dstr,
                    "workplace": wp,
                    "process_code": "", "process_name": "計画",
                    "item_code": code, "item_name": name,
                    "seiban": seiban, "qty": remaining,
                    "kind": "manufacture", "status": "計画",
                    "source": "生産計画",
                    "orderer": staff,
                })
                cnt += 1
            print(f"[計画] {cnt:,}件 (完了済 {cnt_done:,}件スキップ)")
    except Exception as e:
        print(f"[計画] 読込エラー: {e}")
    return rec_int, []


def load_actual_records(proc_to_wp, item_to_final_wp, supplier_map=None):
    """過去2ヶ月の実績レコードを取り込む (雅さん 2026-05-25 要望)
       - 受入明細出力.csv: 社内製造完納分 + 外注/購買入荷分
       - 売上明細出力.csv: 出荷売上実績
       戻り値: [internal_actual_records, external_actual_records]
       status="実績" を付与。kind は工程/品目から判定。
    """
    rec_int = []
    rec_ext = []

    # 1. 受入明細出力.csv
    p_recv = SHARED / "受入明細出力.csv"
    if p_recv.exists():
        try:
            with open(p_recv, "r", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                fc = _FlexCols(reader.fieldnames)
                # 受入№列をキーワード検出 (無ければ付与しないだけで落ちない)
                rc_col = fc.find_contains("受入番号", "受入№", "入荷番号", "入荷№", "受入伝票番号", "受入伝票№")
                cnt_skip_old = cnt_int = cnt_ext = cnt_skip_proc = 0
                for row in reader:
                    d_raw = (row.get("伝票日付") or "").strip().strip('"')
                    d = _parse_date(d_raw)
                    if d is None: continue
                    # 過去2ヶ月以内かつ未来(取り間違い)でない
                    if d < PAST_WINDOW or d > TODAY:
                        cnt_skip_old += 1
                        continue
                    qty = _sf(row.get("受入数量"))
                    if qty <= 0: continue
                    code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
                    name = (row.get("品目名") or row.get("品目") or "").strip().strip('"')
                    seiban = (row.get("製番") or "").strip().strip('"').strip()
                    proc_code = (row.get("工程ｺｰﾄﾞ") or "").strip().strip('"')
                    proc_name = (row.get("工程名") or "").strip().strip('"')
                    supplier = (row.get("仕入先名略称") or "").strip().strip('"')
                    dept = (row.get("部門名") or "").strip().strip('"')
                    dstr = _norm_date(d_raw)
                    # 受入№ (列が検出できた場合のみ)
                    receipt_no = (row.get(rc_col) or "").strip().strip('"') if rc_col else ""
                    # 工程コードから internal/external 判定
                    if proc_code and proc_code in proc_to_wp:
                        wp_info = proc_to_wp[proc_code]
                        rec = {
                            "date": dstr, "start_date": dstr,
                            "workplace": wp_info["workplace"],
                            "process_code": proc_code, "process_name": proc_name,
                            "item_code": code, "item_name": name,
                            "seiban": seiban, "qty": qty,
                            "status": "実績", "source": "受入明細",
                        }
                        if receipt_no and receipt_no != "0":
                            rec["receipt_no"] = receipt_no
                        _attach_tekiyo_biko(rec, row, fc)
                        if wp_info["internal"]:
                            rec["kind"] = "manufacture"
                            rec_int.append(rec)
                            cnt_int += 1
                        else:
                            rec["kind"] = "external"
                            rec_ext.append(rec)
                            cnt_ext += 1
                    elif supplier:
                        # 工程なしで仕入先がある = 純粋な購買入荷
                        rec = {
                            "date": dstr, "start_date": dstr,
                            "workplace": supplier,
                            "process_code": "", "process_name": "購買",
                            "item_code": code, "item_name": name,
                            "seiban": seiban, "qty": qty,
                            "kind": "external", "status": "実績",
                            "source": "受入明細",
                        }
                        if receipt_no and receipt_no != "0":
                            rec["receipt_no"] = receipt_no
                        _attach_tekiyo_biko(rec, row, fc)
                        rec_ext.append(rec)
                        cnt_ext += 1
                    else:
                        cnt_skip_proc += 1
                print(f"[実績/受入] 社内{cnt_int:,} + 外注/購買{cnt_ext:,} (期間外{cnt_skip_old:,} / 工程不明{cnt_skip_proc:,})")
        except Exception as e:
            print(f"[実績/受入] 読込エラー: {e}")
    else:
        print(f"[実績/受入] 受入明細出力.csv が見つかりません")

    # 1b. 社内製造の完納実績 (確定済_工程手配一覧 の報告済数量から、雅さん 2026-05-25 Q3=必要)
    p_proc = SHARED / "確定済_工程手配一覧.csv"
    if p_proc.exists():
        try:
            delim = _detect_delimiter(p_proc)
            with open(p_proc, "r", encoding="utf-8-sig", errors="replace") as f:
                reader = csv.DictReader(f, delimiter=delim)
                fc = _FlexCols(reader.fieldnames)
                cnt_int_act = 0
                for row in reader:
                    proc_code = (row.get("工程コード") or "").strip().strip('"')
                    if proc_code not in proc_to_wp: continue
                    wp_info = proc_to_wp[proc_code]
                    if not wp_info["internal"]: continue  # 社内のみ
                    reported = _sf(row.get("報告済数量"))
                    if reported <= 0: continue
                    # 完納/中間報告日 = 操作日付 or 手配日付 (実績日として最も近いもの)
                    d_raw = row.get("操作日付（年月日）", "") or row.get("操作日付", "") or row.get("報告日付（年月日）", "") or row.get("手配納期(年月日）", "") or row.get("手配納期（年月日）", "")
                    d = _parse_date(d_raw)
                    if d is None: continue
                    if d < PAST_WINDOW or d > TODAY: continue
                    code = (row.get("品目コード") or "").strip().strip('"')
                    name = (row.get("品目名") or row.get("品目名１") or "").strip().strip('"')
                    seiban = (row.get("製番") or row.get("製　番") or "").strip().strip('"').strip()
                    dstr = _norm_date(d_raw)
                    rec = {
                        "date": dstr, "start_date": dstr,
                        "workplace": wp_info["workplace"],
                        "process_code": proc_code,
                        "process_name": (row.get("工程略称") or "").strip().strip('"'),
                        "item_code": code, "item_name": name,
                        "seiban": seiban, "qty": reported,
                        "kind": "manufacture", "status": "実績",
                        "source": "工程手配報告済",
                        "qty_total": round(_sf(row.get("手配数量")), 1),
                        "qty_done": round(reported, 1),
                    }
                    _attach_tekiyo_biko(rec, row, fc)
                    rec_int.append(rec)
                    cnt_int_act += 1
                print(f"[実績/社内製造] 工程手配の報告済 {cnt_int_act:,}件")
        except Exception as e:
            print(f"[実績/社内製造] 読込エラー: {e}")

    # 1c. 製造指図出力.csv の完了済レコード (報告済数量 >= 手配数量)
    # 2026-05-31 雅さん要望: 完了済の作業指示を過去実績としてグラフに表示
    p_seiz = SHARED / "製造指図出力.csv"
    if p_seiz.exists():
        try:
            delim = _detect_delimiter(p_seiz)
            with open(p_seiz, "r", encoding="utf-8-sig", errors="replace") as f:
                reader = csv.DictReader(f, delimiter=delim)
                fc = _FlexCols(reader.fieldnames)
                cnt_done = 0
                for row in reader:
                    proc_code = (row.get("工程ｺｰﾄﾞ") or "").strip().strip('"')
                    if proc_code not in proc_to_wp: continue
                    wp_info = proc_to_wp[proc_code]
                    if not wp_info["internal"]: continue  # 社内のみ
                    qty = _sf(row.get("手配数量"))
                    reported = _sf(row.get("報告済数量"))
                    if reported <= 0: continue  # 未着手はスキップ
                    remaining = qty - reported
                    if remaining > 0: continue  # 未完了はスキップ (確定済として別途取込済み)
                    # 完了済: 手配納期を実績日として使用
                    end_raw = row.get("手配納期(年月日)", "") or row.get("手配予定日(年月日)", "")
                    d = _parse_date(end_raw)
                    if d is None: continue
                    if d < PAST_WINDOW or d > TODAY: continue
                    code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
                    name = (row.get("品目名") or "").strip().strip('"')
                    seiban = (row.get("製番") or "").strip().strip('"').strip()
                    dstr = _norm_date(end_raw)
                    rec = {
                        "date": dstr, "start_date": dstr,
                        "workplace": wp_info["workplace"],
                        "process_code": proc_code,
                        "process_name": (row.get("工程名") or "").strip().strip('"'),
                        "item_code": code, "item_name": name,
                        "seiban": seiban, "qty": reported,
                        "kind": "manufacture", "status": "実績",
                        "source": "製造指図完了",
                        "qty_total": round(qty, 1),
                        "qty_done": round(reported, 1),
                    }
                    _attach_tekiyo_biko(rec, row, fc)
                    rec_int.append(rec)
                    cnt_done += 1
            print(f"[実績/製造指図完了] {cnt_done:,}件")
        except Exception as e:
            print(f"[実績/製造指図完了] 読込エラー: {e}")
    else:
        print(f"[実績/製造指図完了] 製造指図出力.csv が見つかりません")

    # 2. 売上明細出力.csv (出荷実績)
    # ※ load_shipment_records で status="実績" として既に取込済みのため、ここでは重複ロードしない
    # 2026-05-27: 二重積み上がりバグ修正 (確定済+実績が同じCSVから両方ロードされていた)
    print(f"[実績/売上] load_shipment_records で統合済のためスキップ")

    return rec_int, rec_ext


def load_order_assignee_map():
    """確定済_購買発注一覧.csv から発注者マップを構築。
       雅さん 2026-05-24 要望: 全タブで発注者を表示してフィルタできるようにする
                              + 発注No を検索に引っ掛けたい

       2026-07-08 バグ是正 (担当違い・発注No重複):
       - 発注番号→担当者 は実データで 1:1 (1,247件中ズレ0) → 発注No基準の突合が唯一安全。
       - (製番,商品コード) は製番"00"(在庫参照=製番なし)に購買が集まり多対多になる
         (543組中68組で発注Noが複数、29組で担当が複数)。
         → 従来の「最初の1件を全レコードに付与」は担当違い＆発注No重複を撒いていた。
       - フォールバックは (製番,コード) 内で担当が一意な場合のみ (曖昧なら付けない=誤りを出さない)。
         フォールバックでは purchase_no は絶対に配らない。
       戻り値: (po_map: 発注番号→{staff,login}, fallback_map: (seiban,code)→{staff,login} 一意分のみ)"""
    p = SHARED / "確定済_購買発注一覧.csv"
    po_map = {}
    fallback_map = {}
    if not p.exists():
        print(f"[発注者] 確定済_購買発注一覧.csv が見つかりません")
        return po_map, fallback_map
    try:
        by_sc = defaultdict(set)  # (seiban, code) → {(staff, login), ...}
        with open(p, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                seiban = (row.get("製　番") or row.get("製番") or "").strip().strip('"').strip()
                code = (row.get("商品コード") or "").strip().strip('"')
                staff = (row.get("担当者略称") or "").strip().strip('"')
                login = (row.get("ログインＩＤ") or "") .strip().strip('"')
                order_no = (row.get("発注番号") or "").strip().strip('"')
                if not staff: continue
                if order_no and order_no != "0":
                    po_map[order_no] = {"staff": staff, "login": login}
                by_sc[(seiban, code)].add((staff, login))
        ambiguous = 0
        for key, staffs in by_sc.items():
            if len(staffs) == 1:
                staff, login = next(iter(staffs))
                fallback_map[key] = {"staff": staff, "login": login}
            else:
                ambiguous += 1  # 担当が複数 → 付与しない (誤りを出さない方針)
        print(f"[発注者] 確定済_購買発注: 発注No {len(po_map):,}件 / "
              f"(seiban+code)一意 {len(fallback_map):,}組 (曖昧のため除外 {ambiguous:,}組)")
    except Exception as e:
        print(f"[発注者] 読込エラー: {e}")
    return po_map, fallback_map


def attach_orderer_to_records(records, po_map, fallback_map):
    """確定済の外注/購買レコードに発注者を付与。

       2026-07-08 バグ是正:
       - 突合は「レコード自身が持つ発注No (purchase_no)」→ 発注番号→担当(1:1) を正とする。
         purchase_no は load_records 側でレコード自身の発注番号列から設定済み。
         ここでは purchase_no を上書きしない (order_mapで別の発注Noを撒いた旧バグの再発防止)。
       - tehai_no での突合はしない (製造指図の手配№が偶然PO発注番号と衝突する例が実データに6件あり危険)。
       - 発注Noを持たないレコードは (seiban,code) フォールバック (担当一意の場合のみ) で
         発注者だけ付与。曖昧なら付けない。"""
    if not po_map and not fallback_map:
        return
    matched_po = 0
    matched_fb = 0
    for r in records:
        if r.get("status") != "確定済":
            continue
        pno = (r.get("purchase_no") or "").strip()
        if pno:
            info = po_map.get(pno)
            if info:
                r["orderer"] = info["staff"]
                r["orderer_login"] = info["login"]
                matched_po += 1
            # 発注Noはあるが購買発注一覧に無い(完納済/抽出範囲外) → 発注者は付けない
            continue
        seiban = (r.get("seiban") or "").strip()
        code = (r.get("item_code") or "").strip()
        info = fallback_map.get((seiban, code))
        if info:
            r["orderer"] = info["staff"]
            r["orderer_login"] = info["login"]
            matched_fb += 1
    print(f"[発注者付与] 発注No突合 {matched_po:,}件 / (seiban,code)一意フォールバック {matched_fb:,}件 / 全{len(records):,}件")


def load_bom_parent_map():
    """構成マスタから 子品目→親品目集合 のマップを構築。
       雅さん 2026-05-24 要望: 購買部品がどの最終製品に使われるかを表示するため。"""
    p = SHARED / "構成マスタ.csv"
    parent_map = defaultdict(set)
    if not p.exists():
        print(f"[BOM] 構成マスタ.csv が見つかりません: {p}")
        return parent_map
    try:
        with open(p, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                parent = (row.get("親品目ｺｰﾄﾞ") or "").strip().strip('"')
                child = (row.get("子品目ｺｰﾄﾞ") or "").strip().strip('"')
                if not parent or not child:
                    continue
                # 失効済はスキップ
                expire = (row.get("失効日") or "").strip().strip('"')
                if expire and expire not in ("99999999", "9999/99/99", "0", ""):
                    try:
                        # YYYYMMDD or YYYY/MM/DD
                        s = expire.replace("/", "")
                        if len(s) == 8 and s.isdigit():
                            ey, em, ed = int(s[:4]), int(s[4:6]), int(s[6:8])
                            if datetime(ey, em, ed) < TODAY:
                                continue
                    except Exception:
                        pass
                # 使用禁止日もスキップ
                ban = (row.get("使用禁止日") or "").strip().strip('"')
                if ban and ban not in ("99999999", "9999/99/99", "0", "", "00000000"):
                    try:
                        s = ban.replace("/", "")
                        if len(s) == 8 and s.isdigit():
                            by, bm, bd = int(s[:4]), int(s[4:6]), int(s[6:8])
                            if datetime(by, bm, bd) < TODAY:
                                continue
                    except Exception:
                        pass
                parent_map[child].add(parent)
        print(f"[BOM] 構成マスタ読込: 子品目{len(parent_map):,}種類")
    except Exception as e:
        print(f"[BOM] 読込エラー: {e}")
    return parent_map


def find_used_in_products(item_code, parent_map, item_names=None, max_depth=12, max_roots=10):
    """品目から親をたどってルート品目 (= 最終製品) を見つける。
       ルート = この parent_map に親として登場するが、子としては登場しない品目。
       簡易には parent_map[code] が空 = ルート扱い。"""
    if not item_code or item_code not in parent_map and not any(item_code in parents for parents in parent_map.values()):
        # 親としても子としても出てこない
        return []
    roots = set()
    visited = set()
    stack = [(item_code, 0)]
    while stack:
        code, depth = stack.pop()
        if code in visited or depth > max_depth:
            continue
        visited.add(code)
        parents = parent_map.get(code)
        if not parents:
            # 親がいない = ルート扱い
            if code != item_code:
                roots.add(code)
            continue
        for p in parents:
            stack.append((p, depth + 1))
    if len(roots) > max_roots:
        # 多すぎる場合は最初の max_roots だけ
        sorted_roots = sorted(roots)
        return sorted_roots[:max_roots] + [f"…他{len(roots) - max_roots}種"]
    return sorted(roots)


def load_item_name_map():
    """品目マスタから 品目コード→品目名 のマップ"""
    p = SHARED / "品目マスタ.csv"
    name_map = {}
    if not p.exists():
        return name_map
    try:
        with open(p, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                code = (row.get("品目ｺｰﾄﾞ") or row.get("品目コード") or "").strip().strip('"')
                name = (row.get("品目名") or "").strip().strip('"')
                if code and name:
                    name_map[code] = name
    except Exception as e:
        print(f"[品目名] 読込エラー: {e}")
    return name_map


def load_item_master_data():
    """品目マスタから 在庫管理区分 と 累積リードタイム を読み込む。
       SHARED/品目マスタ.csv が優先、なければ DATA/品目マスタ.txt を使う。
       戻り値: (stock_map, lt_map)
         stock_map: {item_code: True/False}  True=在庫管理あり
         lt_map:    {item_code: int}          累積リードタイム (日数)
    """
    candidates = [
        SHARED / "品目マスタ.csv",
        DATA / "品目マスタ.txt",
    ]
    p = next((c for c in candidates if c.exists()), None)
    if not p:
        print("[品目マスタ] ファイルが見つかりません")
        return {}, {}
    stock_map = {}
    lt_map = {}
    try:
        import csv as _csv
        _csv.field_size_limit(10_000_000)
        with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = _csv.DictReader(f, delimiter="\t" if p.suffix == ".txt" else ",")
            for row in reader:
                code = (row.get("品目ｺｰﾄﾞ") or row.get("品目コード") or "").strip().strip('"')
                if not code:
                    continue
                # 在庫管理区分: "0" = 行う(あり), それ以外 = なし
                zaiko = (row.get("在庫管理区分") or "").strip().strip('"')
                stock_map[code] = (zaiko == "0")
                # 累積リードタイム (カラム名がフルwidth/半width両対応)
                lt_raw = (
                    row.get("累積ﾘｰﾄﾞﾀｲﾑ") or
                    row.get("累積リードタイム") or ""
                ).strip().strip('"')
                try:
                    lt_map[code] = int(float(lt_raw)) if lt_raw else 0
                except Exception:
                    lt_map[code] = 0
        print(f"[品目マスタ] {len(stock_map):,}品目 読込 (在庫管理あり:{sum(stock_map.values()):,}件)")
    except Exception as e:
        print(f"[品目マスタ] 読込エラー: {e}")
    return stock_map, lt_map


def _business_days_subtract(end_date_str, n_days):
    """end_date から n_days 営業日(土日除く)を引いた日付を返す (YYYY/MM/DD形式)"""
    d = _parse_date(end_date_str)
    if d is None or n_days <= 0:
        return end_date_str
    count = 0
    while count < n_days:
        d -= timedelta(days=1)
        if d.weekday() < 5:   # 0=Mon … 4=Fri
            count += 1
    return d.strftime("%Y/%m/%d")


def attach_stock_managed(records, stock_map):
    """レコードに stock_managed フィールドを付加。
       在庫管理マスタにない品目はデフォルト True (あり) とする。"""
    for r in records:
        code = (r.get("item_code") or "").strip()
        r["stock_managed"] = stock_map.get(code, True)


def fix_start_dates(records, lt_map, route_lt_map=None):
    """start_date が date と同じ(未設定)のレコードをリードタイムで補完する。

    LT優先順位:
      1. route_lt_map (品目手順マスタの工程LT合計) — 製造品目の正確な製造LT
      2. lt_map (品目マスタの累積リードタイム)      — フォールバック
    LT=0 or 1 のときは単日品目とみなし補完しない。
    """
    if route_lt_map is None:
        route_lt_map = {}
    count = 0
    for r in records:
        sd = r.get("start_date") or ""
        ed = r.get("date") or ""
        if not ed:
            continue
        if sd and sd != ed:
            continue   # 既に正しいstart_dateあり → スキップ
        code = (r.get("item_code") or "").strip()
        # 品目手順マスタのLTを優先、なければ品目マスタの累積LTを使う
        lt = route_lt_map.get(code) or lt_map.get(code, 0)
        if lt > 1:
            new_sd = _business_days_subtract(ed, lt - 1)
            r["start_date"] = new_sd
            count += 1
    src_note = "品目手順優先" if route_lt_map else "品目マスタのみ"
    print(f"[LT補完] {count:,}件のstart_dateを補完 ({src_note})")


def build_final_product_set(parent_map):
    """最終製品 (=BOMで親としてのみ登場、子としては登場しない品目) のセット
       雅さん 2026-05-25 Q4: 最終製品のみフィルタ用"""
    children_set = set(parent_map.keys())  # parent_map のキーは「子」品目
    all_parents = set()
    for parents in parent_map.values():
        all_parents.update(parents)
    final_set = all_parents - children_set
    return final_set


def attach_final_flag(records, final_set):
    """レコードに is_final フラグを付加"""
    cnt = 0
    for r in records:
        code = (r.get("item_code") or "").strip()
        if code in final_set:
            r["is_final"] = True
            cnt += 1
    return cnt


def attach_used_in_to_records(records, parent_map, item_name_map):
    """外注/購買レコードに「使用先(最終製品)」を付加。
       used_in: list of [code, name] 最大10件。"""
    if not parent_map:
        return
    cache = {}
    for r in records:
        code = (r.get("item_code") or "").strip()
        if not code:
            continue
        if code in cache:
            roots = cache[code]
        else:
            roots = find_used_in_products(code, parent_map)
            cache[code] = roots
        if roots:
            r["used_in"] = [[c, item_name_map.get(c, "")] for c in roots]


def main():
    print(f"[基準日] TODAY = {TODAY.strftime('%Y/%m/%d')}")
    print(f"[期間] {PAST_WINDOW.strftime('%Y/%m/%d')} 〜 {HORIZON.strftime('%Y/%m/%d')}")
    print()
    proc_to_wp = load_process_workplace_map()
    proc_to_wp = enrich_wp_map_from_arrangements(proc_to_wp)
    supplier_map = load_supplier_map()
    item_to_final_wp, item_route_lt_map = load_item_final_workplace_map(proc_to_wp)
    # 雅さん 2026-05-24: 購買詳細に「使用先(最終製品)」を出すため BOM 親辿りマップを構築
    parent_map = load_bom_parent_map()
    item_name_map = load_item_name_map()
    # 雅さん 2026-05-29: 品目マスタから在庫管理区分・累積LTを取得
    stock_map, lt_map = load_item_master_data()
    # 雅さん 2026-05-24: 全タブで「発注者」を出してフィルタしたい
    # 2026-07-08: 発注No基準の一意突合に変更 (po_map=発注No→担当 1:1 / fallback=担当一意の(製番,コード)のみ)
    po_map, orderer_fallback_map = load_order_assignee_map()
    # 2026-07-08: 分納対応 — 受入明細出力.csv があれば 発注番号→受入№ を紐づけ (無ければ発注Noのみ)
    receipt_map = load_receipt_no_map()

    # 社内工程の山
    print("\n--- 社内工程 ---")
    rec_internal = load_records(proc_to_wp, scope="internal")

    # 出荷の山 (社内最終工程の部署に積む)
    print("\n--- 出荷 ---")
    rec_shipment = load_shipment_records(item_to_final_wp)

    # 社内+出荷 を統合 (同じ作業区集計に積む)
    rec_internal_combined = rec_internal + rec_shipment
    daily_int, wp_int = aggregate_daily(rec_internal_combined)

    # 外注/購買の山
    print("\n--- 外注/購買 ---")
    rec_external = load_records(proc_to_wp, scope="external", supplier_map=supplier_map, receipt_map=receipt_map)

    # 雅さん 2026-05-25: 過去2ヶ月の実績を取り込む (受入明細+売上明細)
    print("\n--- 過去実績 ---")
    rec_actual_int, rec_actual_ext = load_actual_records(proc_to_wp, item_to_final_wp, supplier_map)
    # 2026-07-08 分納の二重計上防止:
    #   確定済_購買発注の「受入済分(実績)」は、受入明細出力.csv 由来の実績と同じ入荷を指し得る。
    #   受入明細に (品目,製番) が存在する場合は受入明細側を正とし、購買発注(受入済) 側を落とす。
    recv_keys = {(r.get("item_code", ""), r.get("seiban", ""))
                 for r in rec_actual_ext if r.get("source") == "受入明細"}
    if recv_keys:
        n_before = len(rec_external)
        rec_external = [r for r in rec_external
                        if not (r.get("source") == "確定済_購買発注(受入済)"
                                and (r.get("item_code", ""), r.get("seiban", "")) in recv_keys)]
        n_drop = n_before - len(rec_external)
        if n_drop:
            print(f"[分納] 受入明細と重複する購買発注(受入済) {n_drop:,}件を除去 (受入明細側を正)")
    rec_internal_combined += rec_actual_int
    rec_external += rec_actual_ext

    # 雅さん 2026-05-25: 計画レコード取込 (生産計画出力.csv → status="計画")
    print("\n--- 生産計画 ---")
    rec_plan_int, _ = load_plan_records(item_to_final_wp)
    rec_internal_combined += rec_plan_int

    # 最終製品フラグ付与 (雅さん 2026-05-25)
    final_set = build_final_product_set(parent_map)
    cnt_final_int = attach_final_flag(rec_internal_combined, final_set)
    cnt_final_ext = attach_final_flag(rec_external, final_set)
    print(f"[最終製品] BOM親のみ品目: {len(final_set):,}種 / 社内{cnt_final_int:,}件・外注{cnt_final_ext:,}件にis_final付与")

    # 在庫管理区分フラグ付与 (雅さん 2026-05-29)
    attach_stock_managed(rec_internal_combined, stock_map)
    attach_stock_managed(rec_external, stock_map)

    # 品目手順マスタLT(優先) + 品目マスタ累積LT(フォールバック)でstart_dateを補完
    # (雅さん 2026-05-29: UDL25など累積LT誤りを品目手順LTで正しく補正)
    print("\n--- start_date LT補完 ---")
    fix_start_dates(rec_internal_combined, lt_map, route_lt_map=item_route_lt_map)
    fix_start_dates(rec_external, lt_map, route_lt_map=item_route_lt_map)

    # 使用先付与 (外注/購買のみ)
    attach_used_in_to_records(rec_external, parent_map, item_name_map)
    with_used = sum(1 for r in rec_external if r.get("used_in"))
    print(f"[使用先] {with_used:,}/{len(rec_external):,} レコードに使用先を付与")
    # 発注者付与 (確定済のみ)
    attach_orderer_to_records(rec_external, po_map, orderer_fallback_map)
    # 社内レコードにも、購買発注に紐づけば付与しておく (将来全タブで利用)
    attach_orderer_to_records(rec_internal_combined, po_map, orderer_fallback_map)
    # 実績を含めて再集計
    daily_int, wp_int = aggregate_daily(rec_internal_combined)
    daily_ext, wp_ext = aggregate_daily(rec_external)

    out = {
        "as_of": TODAY.strftime("%Y/%m/%d"),
        "horizon": HORIZON.strftime("%Y/%m/%d"),
        "internal": {
            "workplaces": wp_int,
            "daily": daily_int,
            "records": rec_internal_combined,
        },
        "external": {
            "workplaces": wp_ext,
            "daily": daily_ext,
            "records": rec_external,
        },
    }
    DATA.mkdir(exist_ok=True)
    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    (DATA / "yama_data.json").write_text(payload, encoding="utf-8")
    (DATA / "yama_data.js").write_text(f"window.YAMA_DATA = {payload};\n", encoding="utf-8")
    print(f"\n[出力] data/yama_data.json ({len(payload):,} bytes)")
    print(f"      [社内] 作業区{len(wp_int)} / 日{len(daily_int)} / レコード{len(rec_internal):,}")
    print(f"      [外注] 仕入先{len(wp_ext)} / 日{len(daily_ext)} / レコード{len(rec_external):,}")

    # 2026-06-11 セキュリティ移行: yama_data(山積み台数)を公開Pages(fujin/)に置かない。
    # auth_dist へのコピーを廃止し、scripts/upload_fujin_data.py が SharePoint へアップロード、
    # 画面側は auth_wrapper の認証fetch(window._fujinYamaData)で取得する。
    # ※ data/yama_data.json は upload_fujin_data.py のアップロード元として残す。
    print("[配置] yama_data は auth_dist にコピーしない(SharePoint認証配信へ移行済)")

    # FUJIN.html の「最終更新」メタ情報をビルド日時に書き換える
    _update_fujin_meta(TODAY)


def _update_fujin_meta(build_dt):
    """FUJIN.html (ソース + auth_dist) のヘッダー最終更新日をビルド日時に同期する。
    現在庫基準日は 有効在庫一覧表.csv の SharePoint 更新時刻 (data/_stock_mtime.txt) を優先。
    """
    import re
    mmdd   = build_dt.strftime("%m-%d")
    dt_str = build_dt.strftime("%Y-%m-%d %H:%M")

    # 現在庫基準日: _stock_mtime.txt があればそちらを使用、なければビルド日時
    _mtime_file = DATA / "_stock_mtime.txt"
    if _mtime_file.exists():
        stock_dt_str = _mtime_file.read_text(encoding="utf-8").strip() or dt_str
    else:
        stock_dt_str = dt_str

    targets = [BASE / "FUJIN.html", BASE / "auth_dist" / "FUJIN.html"]
    for path in targets:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(r'最終更新 \d{2}-\d{2}', f'最終更新 {mmdd}', text)
        text = re.sub(
            r'(<b>データ基準日</b>)\s*[\d-]+ [\d:]+',
            rf'\1 {dt_str}', text
        )
        text = re.sub(
            r'(<b>現在庫基準日</b>)\s*[\d-]+ [\d:]+',
            rf'\1 {stock_dt_str}', text   # ← 有効在庫一覧表.csv の更新日時
        )
        text = re.sub(
            r'(<b>統合版生成</b>)\s*[\d-]+ [\d:]+',
            rf'\1 {dt_str}', text
        )
        path.write_text(text, encoding="utf-8")
        print(f"[更新] {path.name} 最終更新 → {mmdd} / 現在庫基準日 → {stock_dt_str}")


if __name__ == "__main__":
    main()
