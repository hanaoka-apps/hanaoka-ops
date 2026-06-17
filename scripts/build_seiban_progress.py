#!/usr/bin/env python3
"""
FUJIN: 製番進捗ビュー データ生成

製番ごとに以下を集約して seiban_progress.json を生成する:
  - 受注情報: 顧客、納期、数量、残量
  - 部品一覧 (BOM展開): 製番別BOM優先、なければ通常BOM
  - 各部品の手配状態 (確定済_工程手配一覧から):
      manufactured: 確定済 + 報告済数量 >= 手配数量 (完納)
      in_progress:  確定済 + 0 < 報告済数量 < 手配数量 (進行中)
      arranged:     確定済 + 報告済数量 == 0 (手配済・未着手)
      unarranged:   確定済_工程手配一覧に該当なし (手配漏れの可能性)
  - 進捗率: (manufactured + in_progress*0.5) / 全部品数
  - 期限超過部品数

出力: seiban_progress.json
  {
    "generated": "YYYY-MM-DD HH:MM",
    "basis_date": "YYYY/MM/DD",
    "seibans": [
      {
        "sb": 製番,
        "pref": "J"/"M"/"K"/...,
        "product_code": 最終製品コード(代表),
        "product_name": 製品名,
        "customer": 顧客名,
        "due_date": 納期,
        "qty": 受注数量,
        "qty_remain": 残量,
        "is_uncomp": 受注未完納フラグ,
        "parts_total": 全部品数,
        "parts_manufactured": 完納部品数,
        "parts_in_progress": 進行中部品数,
        "parts_arranged": 手配済部品数,
        "parts_unarranged": 手配漏れ部品数,
        "parts_overdue": 期限超過部品数,
        "progress_rate": 0.0-1.0,
        "parts": [ ... 部品詳細 ... ]
      }
    ]
  }
"""
from __future__ import annotations
import csv, json, os
from pathlib import Path
from datetime import datetime, date
from collections import defaultdict

# 2026-06-13 CI対応リファクタ: 固定セッションパスを廃し __file__基準。OneDrive直読を優先しつつ
# 無ければ data/ にフォールバック(GitHub Actions では download_shared_masters.py が
# SharedMasters名で data/ に最新CSVを置く)。.exists() が権限エラーで落ちないよう安全化。
ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent if ROOT.name == "scripts" else ROOT
DATA = BASE / "data"

def _exists_safe(p):
    try:
        return p is not None and p.exists()
    except Exception:
        return False

SHARED_CANDIDATES = [
    Path(os.environ["FUJIN_SHARED"]) if os.environ.get("FUJIN_SHARED") else None,
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    DATA,
]
SHARED = next((p for p in SHARED_CANDIDATES if _exists_safe(p)), DATA)
print(f"[seiban_progress] SHARED={'(OneDrive直読)' if SHARED != DATA else '(data/フォールバック)'} {SHARED}")

def _master_file(name_base):
    """name_base(拡張子なし)を .csv 優先で探す。無ければ .txt。"""
    for ext in (".csv", ".txt"):
        p = SHARED / (name_base + ext)
        if _exists_safe(p):
            return p
    return SHARED / (name_base + ".csv")

# 基準日 (未確定_購買手配データのmtime)
arr_csv = SHARED / "未確定_購買手配データ.csv"
TODAY = datetime.fromtimestamp(arr_csv.stat().st_mtime) if arr_csv.exists() else datetime.now()
TODAY_DATE = TODAY.date()
TODAY_YMD = TODAY.strftime("%Y%m%d")
print(f"[seiban_progress] 基準日: {TODAY_DATE}")

# ---- 品目マスタ (CIは.csv / フォールバックは.txt=TSV2行ヘッダ にも対応) ----
item_names = {}
_p_item = _master_file("品目マスタ")
_item_is_csv = _p_item.suffix.lower() == ".csv"
with open(_p_item, encoding="utf-8-sig" if _item_is_csv else "utf-8") as f:
    if _item_is_csv:
        for r in csv.DictReader(f):
            code = (r.get("品目ｺｰﾄﾞ") or "").strip()
            if code:
                item_names[code] = (r.get("品目名") or "").strip()
    else:
        rdr = csv.reader(f, delimiter="\t")
        next(rdr, None); next(rdr, None)  # TSVは2行ヘッダをスキップ
        for r in rdr:
            if len(r) >= 2 and r[0].strip():
                item_names[r[0].strip()] = r[1].strip()
print(f"[品目マスタ] {len(item_names):,}件 ({_p_item.name})")

# ---- 構成マスタ (製番別 / 通常) ----
bom_default: dict[str, list[tuple[str, float]]] = defaultdict(list)
bom_seiban: dict[str, dict[str, list[tuple[str, float]]]] = defaultdict(lambda: defaultdict(list))
with open(SHARED / "構成マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        if (r.get("ﾀﾞﾐｰ構成区分") or "0").strip() not in ("", "0"): continue
        if (r.get("展開ｽﾄｯﾌﾟ区分") or "0").strip() not in ("", "0"): continue
        prohibit = (r.get("使用禁止日") or "0").strip()
        if prohibit and prohibit not in ("0", "00000000") and len(prohibit) == 8 and prohibit.isdigit():
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
        if seiban and seiban not in ("0", "000000000000", "0000000000-00"):
            # 重複は無視 (最初の取数を採用) - 雅さん指示
            existing = {c for c, _ in bom_seiban[seiban][parent]}
            if child not in existing:
                bom_seiban[seiban][parent].append((child, qty))
        else:
            existing = {c for c, _ in bom_default[parent]}
            if child not in existing:
                bom_default[parent].append((child, qty))
print(f"[構成マスタ] 製番別{len(bom_seiban):,}製番 / 通常BOM親{len(bom_default):,}件")

def expand_bom(seiban: str, root_code: str, max_depth=8) -> dict[str, float]:
    """ある製番の最終製品を起点にBOMを展開し、全部品の合計取数を返す。
    製番別BOMを優先、なければデフォルト。循環防止。
    戻り値: {部品コード: 合計取数}
    """
    parts: dict[str, float] = {}
    def walk(code, multiplier, depth, ancestors):
        if depth > max_depth or code in ancestors: return
        children = []
        if seiban and code in bom_seiban.get(seiban, {}):
            children = bom_seiban[seiban][code]
        elif code in bom_default:
            children = bom_default[code]
        for ch, qty in children:
            if ch in ancestors: continue
            new_mult = multiplier * qty
            parts[ch] = parts.get(ch, 0) + new_mult
            walk(ch, new_mult, depth + 1, ancestors | {code})
    walk(root_code, 1.0, 0, set())
    return parts

# ---- 受注明細から製番別受注情報を取得 ----
# 受注明細出力.csv の列構造 (build_enhanced_summary.py より):
#   [102] 納期, [103] オーダー№, [106] 品目コード, [107] 受注品目名,
#   [128] 受注数量, [141] 完納区分名, [142] 売上済数量, [185] 製番
# 顧客名は別列。CSVヘッダから探す方が安全。
seiban_orders: dict[str, list[dict]] = defaultdict(list)
P_ORD = SHARED / "受注明細出力.csv"
if P_ORD.exists():
    # 区切り文字自動判定(SMILEがTSVで吐く場合がある)
    with open(P_ORD, encoding="utf-8-sig") as _pk:
        _peek = _pk.readline()
    _ord_delim = "\t" if _peek.count("\t") > _peek.count(",") else ","
    _ord_label = "TAB" if _ord_delim == "\t" else "CSV"
    print(f"[受注明細] 区切り={_ord_label}")
    with open(P_ORD, encoding="utf-8-sig") as f:
        rdr = csv.reader(f, delimiter=_ord_delim)
        header = next(rdr)
        # 列インデックス自動検出 (複数候補対応)
        def _col(*names):
            for n in names:
                for i, h in enumerate(header):
                    if h.strip('"') == n: return i
            return -1
        I_DUE      = _col("納期")
        I_ONUM     = _col("オーダー№", "オーダーNo", "オーダー No")
        # SMILEは「品目ｺｰﾄﾞ」(カナ小文字)。互換のため「品目コード」も探す
        I_CODE     = _col("品目ｺｰﾄﾞ", "品目コード")
        I_NAME     = _col("品目名", "受注品目名")
        I_QTY      = _col("数量", "受注数量")
        I_COMP     = _col("完納区分名")
        I_SOLD     = _col("売上済数量")
        I_SEIBAN   = _col("製番", "製　番")
        I_CUSTOMER = _col("得意先名略称", "得意先略称", "得意先名１", "得意先名")
        print(f"[受注明細列マップ] DUE={I_DUE} ONUM={I_ONUM} CODE={I_CODE} NAME={I_NAME} "
              f"QTY={I_QTY} COMP={I_COMP} SOLD={I_SOLD} SEIBAN={I_SEIBAN} CUSTOMER={I_CUSTOMER}")
        for r in rdr:
            if len(r) <= max(I_CODE, I_QTY): continue
            sn = (r[I_SEIBAN] if I_SEIBAN >= 0 else "").strip()
            if not sn or sn in ("0", "000000000000"): continue
            try: qty = float(r[I_QTY]) if r[I_QTY] else 0.0
            except: qty = 0.0
            try: sold = float(r[I_SOLD]) if r[I_SOLD] else 0.0
            except: sold = 0.0
            is_comp = (r[I_COMP].strip() == "完納") if I_COMP >= 0 else False
            seiban_orders[sn].append({
                "code":     r[I_CODE].strip() if I_CODE >= 0 else "",
                "name":     r[I_NAME].strip() if I_NAME >= 0 else "",
                "due":      r[I_DUE].strip() if I_DUE >= 0 else "",
                "onum":     r[I_ONUM].strip() if I_ONUM >= 0 else "",
                "qty":      qty,
                "sold":     sold,
                "remain":   max(qty - sold, 0),
                "is_comp":  is_comp,
                "customer": (r[I_CUSTOMER].strip() if I_CUSTOMER >= 0 else ""),
            })
print(f"[受注明細] {len(seiban_orders):,}製番に受注あり")

# ---- 確定済_工程手配一覧 から手配状態を集計 ----
# 製番ごとに「その製番に紐づく実手配品目」を全て収集
# 製番ごとに集計しつつ、工程レベルでも保持する（部品×工程の進捗を見るため）
arrange_by_seiban: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
# arrange_by_seiban[製番][品目コード] = [{qty, rep, due, area, area_name, no, ...}, ...]
P_ARR = SHARED / "確定済_工程手配一覧.csv"
if P_ARR.exists():
    with open(P_ARR, encoding="utf-8-sig") as f:
        rdr = csv.reader(f); header = next(rdr)
        def _ai(*names):
            for n in names:
                for i, h in enumerate(header):
                    if h.strip('"') == n: return i
            return -1
        I_NO     = _ai("手配番号")
        I_DUE    = _ai("手配納期(年月日）", "手配納期（年月日）")
        I_AREA   = _ai("工程コード")
        I_AREAN  = _ai("工程略称", "工程名")
        I_CODE   = _ai("品目コード")
        I_NAME   = _ai("品目名")
        I_SEIBAN = _ai("製　番", "製番")
        I_QTY    = _ai("手配数量(在庫単位)", "手配数量")
        I_REP    = _ai("報告済数量(在庫単位)", "報告済数量")
        I_DEPT   = _ai("部門略称")
        for r in rdr:
            if len(r) <= max(I_CODE, I_QTY): continue
            sn   = (r[I_SEIBAN] if I_SEIBAN >= 0 else "").strip()
            code = (r[I_CODE] if I_CODE >= 0 else "").strip()
            if not sn or not code: continue
            try: qty = float(r[I_QTY]) if r[I_QTY] else 0.0
            except: qty = 0.0
            try: rep = float(r[I_REP]) if r[I_REP] else 0.0
            except: rep = 0.0
            arrange_by_seiban[sn][code].append({
                "qty":  qty,
                "rep":  rep,
                "due":  (r[I_DUE] if I_DUE >= 0 else "").strip(),
                "area": (r[I_AREA] if I_AREA >= 0 else "").strip(),
                "area_name": (r[I_AREAN] if I_AREAN >= 0 else "").strip(),
                "no":   (r[I_NO] if I_NO >= 0 else "").strip(),
                "name": (r[I_NAME] if I_NAME >= 0 else "").strip(),
            })
n_arrange_rows = sum(sum(len(v) for v in d.values()) for d in arrange_by_seiban.values())
n_arrange_pairs = sum(len(d) for d in arrange_by_seiban.values())
print(f"[手配状態] {n_arrange_rows:,}行 / {n_arrange_pairs:,}件(製番×品目) / {len(arrange_by_seiban):,}製番に手配あり")

def _parse_date(s):
    s = (s or "").strip().replace("/","").replace("-","")
    if len(s) == 8 and s.isdigit():
        try: return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except: return None
    return None

def _status_of(qty, rep):
    if qty <= 0: return "unknown"
    if rep >= qty: return "manufactured"
    if rep > 0:    return "in_progress"
    return "arranged"

# ---- 製番ごとに集約 ----
# 戦略: BOM展開ではなく「実手配ベース」+「BOM補完」
#   - 製番に紐づく実手配 (arrange_by_seiban[sn]) を主軸
#   - 製番別BOMがあればそれと突き合わせて「BOMにあるが手配なし=漏れ」も検出
#   - 受注しかない(手配ゼロ)製番は「未着手」として表示
results = []
all_seibans = set(seiban_orders.keys()) | set(arrange_by_seiban.keys())
for sn in all_seibans:
    orders = seiban_orders.get(sn, [])
    arr = arrange_by_seiban.get(sn, {})
    # 受注の代表 (未完納優先) / 受注ない場合は手配のみ製番
    primary = None
    if orders:
        primary = next((o for o in orders if not o["is_comp"]), None) or orders[0]
    root_code = primary["code"] if primary else ""
    pref = sn[:1] if sn else ""

    # 製番別BOM (登録されてれば部品の予測リストが参考に取れる)
    bom_parts_qty = expand_bom(sn, root_code) if root_code else {}
    has_seiban_bom = sn in bom_seiban  # 真の製番別BOMがあるか

    # 部品リスト = 実手配ベース (手配されてない予測部品は混ぜない)
    parts_detail = []
    cnt_man = cnt_ip = cnt_arr = cnt_overdue = 0
    for code in sorted(arr.keys()):
        rows = arr[code]
        # 最も進捗の進んだ工程で代表
        for_status = max(rows, key=lambda r: (r["rep"]/max(r["qty"],1e-9)))
        status = _status_of(for_status["qty"], for_status["rep"])
        latest = max((r["due"] for r in rows if r["due"]), default="")
        due_d = _parse_date(latest)
        is_overdue = (status != "manufactured") and due_d is not None and due_d < TODAY_DATE
        if is_overdue: cnt_overdue += 1
        if status == "manufactured": cnt_man += 1
        elif status == "in_progress": cnt_ip += 1
        elif status == "arranged":    cnt_arr += 1
        koutei_chain = [{"k": r["area"], "kn": r["area_name"], "q": r["qty"], "r": r["rep"], "due": r["due"], "no": r["no"]} for r in rows]
        disp_name = next((r["name"] for r in rows if r["name"]), "") or item_names.get(code,"")
        parts_detail.append({
            "c": code, "n": disp_name,
            "q": round(bom_parts_qty[code],3) if code in bom_parts_qty else None,
            "s": status,
            "aq": sum(r["qty"] for r in rows),
            "ar": sum(r["rep"] for r in rows),
            "due": latest,
            "ov": is_overdue,
            "in_bom": code in bom_parts_qty,
            "k_cnt": len(rows),
            "k": koutei_chain,
        })

    # BOM予測にあるが手配無いコード = 「未手配候補」 (製番別BOMがある場合のみ意味あり)
    bom_only_codes = [c for c in bom_parts_qty.keys() if c not in arr]
    cnt_bom_pending = len(bom_only_codes) if has_seiban_bom else 0

    parts_total = len(arr)  # 実手配の部品数
    # 進捗率: 完納+進行中*0.5 / 実手配数
    progress_rate = (cnt_man + cnt_ip * 0.5) / parts_total if parts_total > 0 else 0.0

    # 受注集計
    qty_total = sum(o["qty"] for o in orders) if orders else 0
    remain_total = sum(o["remain"] for o in orders if not o["is_comp"]) if orders else 0
    is_uncomp = any(not o["is_comp"] for o in orders) if orders else (parts_total > cnt_man)

    # 受注一覧 (複数受注対応で全て返す)
    orders_list = [{
        "onum":     o["onum"],
        "code":     o["code"],
        "name":     o["name"],
        "customer": o["customer"],
        "due":      o["due"],
        "qty":      o["qty"],
        "sold":     o["sold"],
        "remain":   o["remain"],
        "comp":     o["is_comp"],
    } for o in orders]

    # 製番の状況フラグ
    has_orders = bool(orders)
    has_arrange = bool(arr)
    if not has_arrange:
        situation = "no_arrange"   # 手配なし(未着手)
    elif cnt_man == parts_total and parts_total > 0:
        situation = "all_done"     # 全部完納
    elif (cnt_ip + cnt_arr) > 0:
        situation = "in_progress"  # 進行中
    else:
        situation = "stopped"      # 進行中も無く、未完納部品あり=止まってる

    results.append({
        "sb": sn,
        "pref": pref,
        "product_code": root_code,
        "product_name": (primary["name"] if primary else "") or item_names.get(root_code,""),
        "customer":     primary["customer"] if primary else "",
        "due_date":     primary["due"] if primary else "",
        "qty":          qty_total,
        "qty_remain":   remain_total,
        "is_uncomp":    is_uncomp,
        "orders_count": len(orders),
        "has_orders":   has_orders,
        "has_arrange":  has_arrange,
        "situation":    situation,
        "parts_total":        parts_total,
        "parts_manufactured": cnt_man,
        "parts_in_progress":  cnt_ip,
        "parts_arranged":     cnt_arr,
        "parts_unarranged":   cnt_bom_pending,   # 製番別BOMにあるが未手配
        "parts_overdue":      cnt_overdue,
        "progress_rate":      round(progress_rate, 3),
        "has_seiban_bom":     has_seiban_bom,
        "orders": orders_list,
        "parts":  parts_detail,
    })

# 未完納 → 納期早い順、完納 → 製番降順 (最近)
def _sort_key(r):
    return (
        0 if r["is_uncomp"] else 1,  # 未完納優先
        r["due_date"] or "99999999",
        -int(r["sb"][1:].replace("-","")[:10] if r["sb"][1:].replace("-","")[:10].isdigit() else 0),
    )
results.sort(key=_sort_key)

meta = {
    "generated":  datetime.now().strftime("%Y-%m-%d %H:%M"),
    "basis_date": TODAY.strftime("%Y/%m/%d"),
    "n_seibans":  len(results),
    "n_uncomp":   sum(1 for r in results if r["is_uncomp"]),
    "pref_counts": {p: sum(1 for r in results if r["pref"]==p) for p in sorted({r["pref"] for r in results}) if p},
}
out = {"meta": meta, "seibans": results}
# 2026-06-13: 出力は data/ へ(upload_fujin_data.py が SharePoint へアップロード→画面は認証fetch)。
DATA.mkdir(parents=True, exist_ok=True)
out_path = DATA / "seiban_progress.json"
out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
# JS版も data/ に残す(ローカルfile://確認用フォールバック。公開Pagesには配置しない)
js_path = DATA / "seiban_progress.js"
js_body = "window.SEIBAN_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
js_path.write_text(js_body, encoding="utf-8")
print(f"\n出力: {out_path} / {js_path}")
print(f"  製番数: {len(results):,}")
print(f"  未完納: {meta['n_uncomp']:,}")
print(f"  接頭辞: {meta['pref_counts']}")
print(f"  サイズ: JSON {out_path.stat().st_size:,}B / JS {js_path.stat().st_size:,}B")
