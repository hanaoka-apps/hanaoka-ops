#!/usr/bin/env python3
"""
FUJIN: 作業指示書データ生成

確定済_工程手配一覧 + 構成マスタ(製番別構成対応) から、
作業指示書タブで使う「手配一覧」と「BOM展開（1台あたり個数）」を生成する。

雅さん要件 (2026-05-13):
- 検索条件: 手配No / 品目コード / 工程コード(作業区) / 製造日
- 出力: 親→子→孫…の縦型ツリー、1台あたり個数
- J製番(特注/T)は構成マスタの「製番」列で個別BOMを引く
- 通常品は「製番」列が空の汎用構成を使う

出力: work_instructions.js
  window.WI_ORDERS = [手配リスト]
  window.WI_BOM_DEFAULT = {親code: [{c:子code, q:数量}]}   # 通常品BOM
  window.WI_BOM_BY_SEIBAN = {製番: {親code: [{c, q}]}}     # 製番別BOM
  window.WI_ITEMS = {code: {n:品目名, ...}}                # 品目辞書
  window.WI_WORK_AREAS = {作業区コード: 作業区名}
"""
from __future__ import annotations
import csv, json, glob
from pathlib import Path
from collections import defaultdict
from datetime import datetime
try:
    from zoneinfo import ZoneInfo
    _JST = ZoneInfo("Asia/Tokyo")
except Exception:
    _JST = None

import os as _os
ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent if ROOT.name == "scripts" else ROOT
DATA = BASE / "data"
# CI/ローカル両対応: 環境変数 → OneDrive → data/ フォールバック(古いスナップショットでも動く)
_shared_cands = [
    _os.environ.get("FUJIN_SHARED", ""),
    str(Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters"),
    str(BASE.parent / "OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters"),
    str(DATA),
]
SHARED = next((Path(p) for p in _shared_cands if p and Path(p).exists()), DATA)
print(f"[SharedMasters] {SHARED}")

# 基準日(直近の動的取得)
# CI(GitHub Actions)はUTCのため、mtime/nowともにJSTで解釈する(基準日が1日ズレる事故防止)。
arr_csv = SHARED / "未確定_購買手配データ.csv"
TODAY = (datetime.fromtimestamp(arr_csv.stat().st_mtime, _JST) if arr_csv.exists()
         else datetime.now(_JST)) if _JST else \
        (datetime.fromtimestamp(arr_csv.stat().st_mtime) if arr_csv.exists() else datetime.now())
if _JST:
    TODAY = TODAY.replace(tzinfo=None)
TODAY_YMD = TODAY.strftime("%Y%m%d")

def _f(v):
    try: return float((v or "0").replace(",", ""))
    except: return 0.0

# ---- 1. 品目マスタ (名前辞書) ----
items_dict = {}
n_prohibited = 0
with open(SHARED / "品目マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        code = (r.get("品目ｺｰﾄﾞ") or "").strip()
        if not code: continue
        # 使用禁止日: 8桁数字。今日以前のものは現在使用禁止状態
        prohibit_raw = (r.get("使用禁止日") or "").strip()
        is_prohibited = False
        if prohibit_raw and prohibit_raw not in ("0", "00000000", "99999999") and len(prohibit_raw) == 8 and prohibit_raw.isdigit():
            if prohibit_raw <= TODAY_YMD:
                is_prohibited = True
                n_prohibited += 1
        item_row = {
            "n": (r.get("品目名") or "").strip(),
            "u": (r.get("単位") or "").strip(),
            "wh": (r.get("基準倉庫名") or "").strip(),
        }
        if is_prohibited:
            item_row["p"] = prohibit_raw  # 使用禁止日(YYYYMMDD)
        items_dict[code] = item_row
print(f"[品目マスタ] {len(items_dict):,}件 (うち使用禁止: {n_prohibited:,}件)")

# ---- 2. 作業区マスタ ----
work_areas = {}
with open(SHARED / "作業区マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        code = (r.get("作業区ｺｰﾄﾞ") or "").strip()
        if not code: continue
        work_areas[code] = (r.get("作業区名") or "").strip()
print(f"[作業区マスタ] {len(work_areas):,}件")

# ---- 3. 構成マスタ (BOM展開) ----
# 同一親→同一子の複数レコードは「重複」として1件のみ採用(取数は代表値=最初の値)
# ※雅さん指示 2026-05-14: SMILE構成マスタには同一親子で72件など重複登録あり、加算は誤り
# 結果: bom_default[parent][child] = qty(代表値)
bom_default_raw: dict[str, dict[str, float]] = defaultdict(dict)
bom_seiban_raw: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
# 品目→製番リスト (検索UIで「品目選んだら製番一覧」)
item_seibans: dict[str, set[str]] = defaultdict(set)
all_seibans: set[str] = set()
n_def_rows = 0; n_sb_rows = 0
n_def_dup = 0; n_sb_dup = 0
with open(SHARED / "構成マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        dummy = (r.get("ﾀﾞﾐｰ構成区分") or "0").strip()
        stop = (r.get("展開ｽﾄｯﾌﾟ区分") or "0").strip()
        if dummy not in ("","0"): continue
        if stop not in ("","0"): continue
        prohibit = (r.get("使用禁止日") or "0").strip()
        if prohibit and prohibit not in ("0","00000000") and len(prohibit)==8 and prohibit.isdigit():
            if prohibit <= TODAY_YMD: continue
        parent = (r.get("親品目ｺｰﾄﾞ") or "").strip()
        child = (r.get("子品目ｺｰﾄﾞ") or "").strip()
        if not parent or not child: continue
        try: num = float((r.get("取数(分子)") or "1").replace(",",""))
        except: num = 1.0
        try: den = float((r.get("取数(分母)") or "1").replace(",",""))
        except: den = 1.0
        qty = (num/den) if den else 1.0
        seiban = (r.get("製番") or "").strip()
        if seiban and seiban not in ("0","000000000000","0000000000-00"):
            n_sb_rows += 1
            # 重複は無視(最初の取数を採用)
            if child in bom_seiban_raw[seiban][parent]:
                n_sb_dup += 1
                continue
            bom_seiban_raw[seiban][parent][child] = qty
            item_seibans[parent].add(seiban)
            all_seibans.add(seiban)
        else:
            n_def_rows += 1
            if child in bom_default_raw[parent]:
                n_def_dup += 1
                continue
            bom_default_raw[parent][child] = qty

# 出力形式に変換: {親: [{c:子, q:数量}]}
bom_default = {parent: [{"c": c, "q": round(q, 4)} for c, q in children.items()]
               for parent, children in bom_default_raw.items()}
bom_by_seiban = {sb: {parent: [{"c": c, "q": round(q, 4)} for c, q in children.items()]
                       for parent, children in d.items()}
                 for sb, d in bom_seiban_raw.items()}
n_def_pairs = sum(len(v) for v in bom_default.values())
n_sb_pairs = sum(len(v) for d in bom_by_seiban.values() for v in d.values())
print(f"[構成マスタ] 通常BOM:{n_def_rows:,}行→{n_def_pairs:,}ペア(重複{n_def_dup:,}スキップ) / 親{len(bom_default):,}")
print(f"[構成マスタ] 製番別BOM:{n_sb_rows:,}行→{n_sb_pairs:,}ペア(重複{n_sb_dup:,}スキップ) / {len(bom_by_seiban):,}製番")
# 品目→製番マップを出力可能形式に
item_seibans_out = {code: sorted(sbs) for code, sbs in item_seibans.items()}
all_seibans_sorted = sorted(all_seibans)

# ---- 4. 確定済_工程手配一覧 → 作業指示候補リスト ----
# 列インデックス参照: [3]手配番号 [9]工程ｺｰﾄﾞ [10]工程略称 [11]品目ｺｰﾄﾞ [12]品目名 [16]倉庫ｺｰﾄﾞ [18]製　番 [42]手配数量
orders = []
with open(SHARED / "確定済_工程手配一覧.csv", encoding="utf-8-sig") as f:
    rdr = csv.reader(f)
    header = next(rdr)
    # 列名→indexマップ
    def idx(name):
        for i,h in enumerate(header):
            if h.strip('"') == name: return i
        return -1
    I_DATE   = idx("手配日付（年月日）")
    I_DUE    = idx("手配納期(年月日）") if idx("手配納期(年月日）") >= 0 else idx("手配納期（年月日）")
    I_NO     = idx("手配番号")
    I_DEPT   = idx("部門コード")
    I_AREA   = idx("工程コード")
    I_AREAN  = idx("工程略称")
    I_CODE   = idx("品目コード")
    I_NAME   = idx("品目名")
    I_WH     = idx("倉庫コード")
    I_SEIBAN = idx("製　番") if idx("製　番") >= 0 else idx("製番")
    I_QTY    = idx("手配数量(在庫単位)") if idx("手配数量(在庫単位)") >= 0 else idx("手配数量")
    I_REP    = idx("報告済数量(在庫単位)") if idx("報告済数量(在庫単位)") >= 0 else idx("報告済数量")
    for row in rdr:
        if len(row) <= max(I_NO, I_CODE, I_AREA, I_QTY): continue
        no = row[I_NO].strip().strip('"') if I_NO >= 0 else ""
        code = row[I_CODE].strip().strip('"') if I_CODE >= 0 else ""
        if not no or not code: continue
        try: qty = float((row[I_QTY].strip().strip('"') or "0").replace(",",""))
        except: qty = 0
        if qty <= 0: continue
        try: rep = float((row[I_REP].strip().strip('"') or "0").replace(",","")) if I_REP >= 0 else 0
        except: rep = 0
        orders.append({
            "no":   no,
            "date": (row[I_DATE].strip().strip('"').replace("/","").replace("-","") if I_DATE>=0 else ""),
            "due":  (row[I_DUE].strip().strip('"').replace("/","").replace("-","") if I_DUE>=0 else ""),
            "area": (row[I_AREA].strip().strip('"') if I_AREA>=0 else ""),
            "an":   (row[I_AREAN].strip().strip('"') if I_AREAN>=0 else ""),
            "code": code,
            "name": (row[I_NAME].strip().strip('"') if I_NAME>=0 else ""),
            "wh":   (row[I_WH].strip().strip('"') if I_WH>=0 else ""),
            "sb":   (row[I_SEIBAN].strip().strip('"') if I_SEIBAN>=0 else ""),
            "qty":  round(qty, 2),
            "rep":  round(rep, 2),
        })
print(f"[作業指示候補] {len(orders):,}件")

# ---- 5. JS出力 ----
meta = {
    "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    "basis_date": TODAY.strftime("%Y/%m/%d"),
    "n_orders": len(orders),
    "n_bom_default": len(bom_default),
    "n_bom_seiban": len(bom_by_seiban),
}
# 2026-06 セキュリティ移行: 業務データを公開Pagesに置かず、SharePoint認証配信にする。
#   data/work_instructions.json をアップロード → 画面は window.top._fujinWorkInstructions を読む。
#   data/work_instructions.js はローカルfile://確認用フォールバック(公開しない)。
_bundle = {
    "orders": orders,
    "bom_default": bom_default,          # {親: [{c,q}]}
    "bom_by_seiban": bom_by_seiban,      # {製番: {親: [{c,q}]}}
    "items": items_dict,
    "work_areas": work_areas,
    "item_seibans": item_seibans_out,
    "all_seibans": all_seibans_sorted,
    "meta": meta,
}
DATA.mkdir(parents=True, exist_ok=True)
_json = json.dumps(_bundle, ensure_ascii=False, separators=(",", ":"))
(DATA / "work_instructions.json").write_text(_json, encoding="utf-8")
(DATA / "work_instructions.js").write_text("window.WI_BUNDLE = " + _json + ";\n", encoding="utf-8")
print(f"\n出力: data/work_instructions.json ({len(_json)/1024:.0f} KB) → SharePoint認証配信")
