#!/usr/bin/env python3
"""
FUJIN 在庫探偵: 構成なし品目（孤立品目）データ生成
- 品目マスタから、構成マスタの親にも子にも登場しない品目を抽出
- 設計ミス疑い + マイナス在庫発生源の発見用
- 結果を orphan_items.js として出力（window.ORPHAN_ITEMS / window.ORPHAN_META）
"""
from __future__ import annotations
import csv, json, os
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent
if ROOT.name == "scripts":
    ROOT = ROOT.parent
DATA_DIR = ROOT / "data"

# ---- データソース解決: 環境変数 → SharedMasters直読 → data/ フォールバック ----
# 2026-07-14 修正: GitHub Actions には OneDrive マウントが無いため、従来はここで
# SystemExit → data/orphan_items.json が生成されず → SharePoint に orphan_items.json が
# 上がらず → 在庫探偵の3ボタン(構成なし/手順登録漏れ/使用禁止)が「未取得」のままだった。
# CI では download_shared_masters.py が SharedMasters と同名のCSVを data/ に保存する
# ため、SHARED=data/ とすれば全ての「SHARED / ファイル名」参照が最新版を指す
# (scripts/build_enhanced_summary.py / build_work_instructions.py と同じ流儀)。
SHARED_CANDIDATES = [
    Path(os.environ["FUJIN_SHARED"]) if os.environ.get("FUJIN_SHARED") else None,
    Path("/sessions/focused-kind-goldberg/mnt/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters"),
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
]
def _safe_exists(p: Path) -> bool:
    """Path.exists() は EACCES 等で例外を投げる環境がある(サンドボックス/権限制限)ため安全化"""
    try:
        return p.exists()
    except OSError:
        return False
SHARED = next((p for p in SHARED_CANDIDATES if p and _safe_exists(p)), None)
if SHARED is None:
    if (DATA_DIR / "構成マスタ.csv").exists():
        SHARED = DATA_DIR
        print(f"[データソース] SharedMasters直読不可 → data/ フォールバック (CI/スナップショット): {DATA_DIR}")
    else:
        raise SystemExit("SharedMasters フォルダも data/構成マスタ.csv も見つかりません")
else:
    print(f"[データソース] SharedMasters直読: {SHARED}")

# 基準日: 未確定_購買手配データの mtime（FUJIN本体と合わせる）
arr_csv = SHARED / "未確定_購買手配データ.csv"
if arr_csv.exists():
    TODAY = datetime.fromtimestamp(arr_csv.stat().st_mtime)
else:
    TODAY = datetime.now()
TODAY_YMD = TODAY.strftime("%Y%m%d")
TODAY_STR = TODAY.strftime("%Y/%m/%d")
print(f"[基準日] {TODAY_STR}")

# ---- 1. 構成マスタの親集合・子集合（フィルタ後） ----
parents: set[str] = set()
children: set[str] = set()
with open(SHARED / "構成マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        dummy = (r.get("ﾀﾞﾐｰ構成区分") or "0").strip()
        stop = (r.get("展開ｽﾄｯﾌﾟ区分") or "0").strip()
        prohibit = (r.get("使用禁止日") or "0").strip()
        if dummy not in ("", "0"): continue
        if stop not in ("", "0"): continue
        if prohibit and prohibit not in ("0", "00000000") and len(prohibit) == 8 and prohibit.isdigit():
            if prohibit <= TODAY_YMD:
                continue
        p = (r.get("親品目ｺｰﾄﾞ") or "").strip()
        c = (r.get("子品目ｺｰﾄﾞ") or "").strip()
        if p: parents.add(p)
        if c: children.add(c)
linked = parents | children
print(f"[構成マスタ] 親{len(parents):,}件 / 子{len(children):,}件 / ユニーク{len(linked):,}件")

# ---- 使用禁止品目を「子」として含む親品目集合（構成マスタ全行を再走査） ----
# memory:fujin_negative_stock_patterns.md / 雅さん指示2026-05-13
# 使用禁止子品目の親は「現在使えない品目構成」状態 → 警告表示
forbidden_children_by_parent: dict[str, list[dict]] = {}
with open(route_path := (SHARED / "構成マスタ.csv"), encoding="utf-8-sig") as f:
    pass  # noop (route_pathで上書きされる予防)
with open(SHARED / "構成マスタ.csv", encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        dummy = (r.get("ﾀﾞﾐｰ構成区分") or "0").strip()
        stop = (r.get("展開ｽﾄｯﾌﾟ区分") or "0").strip()
        if dummy not in ("", "0"): continue
        if stop not in ("", "0"): continue
        prohibit = (r.get("使用禁止日") or "0").strip()
        if not prohibit or prohibit in ("0", "00000000"): continue
        if not prohibit.isdigit() or len(prohibit) != 8: continue
        if prohibit > TODAY_YMD: continue  # 未来禁止日は対象外(今は生きている)
        parent = (r.get("親品目ｺｰﾄﾞ") or "").strip()
        child = (r.get("子品目ｺｰﾄﾞ") or "").strip()
        if not parent or not child: continue
        forbidden_children_by_parent.setdefault(parent, []).append({
            "code": child,
            "prohibit": prohibit,
        })
print(f"[使用禁止品目を含む構成] {len(forbidden_children_by_parent):,}親品目が該当")

# ---- 品目手順マスタの登録済み品目集合 ----
items_with_route: set[str] = set()
route_path = SHARED / "品目手順マスタ.csv"
route_master_found = route_path.exists()
if route_master_found:
    with open(route_path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            code = (r.get("品目ｺｰﾄﾞ") or "").strip()
            if not code: continue
            expire = (r.get("失効日") or "").strip()
            if expire and expire != "99999999" and len(expire) == 8 and expire.isdigit() and expire <= TODAY_YMD:
                continue
            items_with_route.add(code)
    # 「親としてBOMに登場するが品目手順未登録」=製造工程が定義されていない品目
    items_missing_route = parents - items_with_route
    print(f"[品目手順未登録] BOM親{len(parents):,}件中 {len(items_missing_route):,}件が登録漏れ")
else:
    # マスタ未取得時に「全親が登録漏れ」という誤リストを出さない(安全側=空)
    items_missing_route = set()
    print(f"[品目手順未登録] ⚠ {route_path.name} 未検出 → 登録漏れ判定スキップ(0件扱い)")

# ---- 2. 在庫情報の取得（未確定_購買手配データの「有効在庫数」を品目別に集約） ----
stock_by_code: dict[str, float] = {}
def _load_stock(path: Path) -> None:
    if not path.exists():
        print(f"[有効在庫] ⚠ {path.name} 未検出 → 在庫欄なしで続行")
        return
    with open(path, encoding="utf-8-sig") as f:
        rdr = csv.reader(f); header = next(rdr)
        # 品目コード列・有効在庫数列のインデックス検出
        try:
            idx_code = header.index("品目ｺｰﾄﾞ")
        except ValueError:
            # 半角・全角混在対応 (未確定_購買手配データは全角「品目コード」列 = index 11)
            # 2026-07-14 修正: 従来は半角ｶﾅのみ判定→不一致でindex 5(部門コード)に落ち、
            # 在庫が部門コードで集約される誤りがあった
            idx_code = next((i for i, h in enumerate(header)
                             if "品目" in h and ("ｺｰﾄﾞ" in h or "コード" in h)), 11)
        try:
            idx_eff = header.index("有効在庫数")
        except ValueError:
            idx_eff = next((i for i,h in enumerate(header) if "有効在庫" in h), -1)
        for row in rdr:
            if len(row) <= max(idx_code, idx_eff): continue
            code = row[idx_code].strip()
            if not code or idx_eff < 0: continue
            try:
                v = float((row[idx_eff] or "0").replace(",", ""))
                # 有効在庫は品目内で同じ値が並ぶので、最後の値を採用（任意の1つで十分）
                stock_by_code[code] = v
            except: pass

_load_stock(arr_csv)
print(f"[有効在庫] {len(stock_by_code):,}品目分を取得")

# ---- 3. 品目マスタを走査して 孤立品目 と 品目手順未登録品目 を抽出 ----
items: list[dict] = []
items_no_route: list[dict] = []  # 品目手順未登録(BOM親なのに登録漏れ)
total = 0
# 品目マスタを map にしてから両方の集合を一括処理
# CSV版(SharedMasters/CI data/)優先。無ければ TSV版 品目マスタ.txt にフォールバック
# (.txt はヘッダ2行: 1行目=列名(CSVと同一), 2行目=<00001>形式の擬似ヘッダ)
item_master_map: dict[str, dict] = {}
_item_candidates = [
    (SHARED / "品目マスタ.csv", ","),
    (SHARED / "品目マスタ.txt", "\t"),
    (DATA_DIR / "品目マスタ.txt", "\t"),
]
_item_path, _item_delim = next(((p, d) for p, d in _item_candidates if p.exists()), (None, None))
if _item_path is None:
    raise SystemExit("品目マスタ (.csv/.txt) が見つかりません")
print(f"[品目マスタ] 読込: {_item_path}")
with open(_item_path, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f, delimiter=_item_delim):
        code = (r.get("品目ｺｰﾄﾞ") or "").strip()
        if not code: continue
        if code.startswith("<"): continue  # .txt 2行目の擬似ヘッダ(<00001>...)を除外
        total += 1
        item_master_map[code] = r

# 品目手順未登録のリスト構築
for code in sorted(items_missing_route):
    r = item_master_map.get(code)
    if not r:
        # 品目マスタにすら無い場合は最小情報だけ
        items_no_route.append({"code": code, "name": "", "mgmt": "", "supplier": "", "prohibit": "", "category": "active", "stock": None})
        continue
    prohibit = (r.get("使用禁止日") or "0").strip()
    if prohibit and (not prohibit.isdigit() or len(prohibit) != 8):
        prohibit = "0"
    is_prohibited = (prohibit and prohibit != "0" and prohibit <= TODAY_YMD)
    items_no_route.append({
        "code": code,
        "name": (r.get("品目名") or "").strip(),
        "mgmt": (r.get("在庫管理区分名") or "").strip(),
        "supplier": (r.get("主仕入先名") or "").strip(),
        "prohibit": prohibit if prohibit != "0" else "",
        "category": "prohibited" if is_prohibited else "active",
        "stock": round(stock_by_code.get(code, 0), 2) if code in stock_by_code else None,
    })
print(f"[品目手順未登録 詳細] {len(items_no_route):,}件 (うち現役:{sum(1 for x in items_no_route if x['category']=='active'):,})")

# 孤立品目(構成マスタに親としても子としても登場しない)
for code, r in item_master_map.items():
    if code in linked: continue  # 構成マスタに登場するならスキップ
    prohibit = (r.get("使用禁止日") or "0").strip()
    if prohibit and (not prohibit.isdigit() or len(prohibit) != 8):
        prohibit = "0"
    is_prohibited = (prohibit and prohibit != "0" and prohibit <= TODAY_YMD)
    items.append({
        "code": code,
        "name": (r.get("品目名") or "").strip(),
        "mgmt": (r.get("在庫管理区分名") or "").strip(),
        "supplier": (r.get("主仕入先名") or "").strip(),
        "prohibit": prohibit if prohibit != "0" else "",
        "category": "prohibited" if is_prohibited else "active",
        "stock": round(stock_by_code.get(code, 0), 2) if code in stock_by_code else None,
    })

# 並び順: 現役孤立(active) を先、品目コード昇順
items.sort(key=lambda x: (0 if x["category"] == "active" else 1, x["code"]))

n_active = sum(1 for x in items if x["category"] == "active")
n_proh = sum(1 for x in items if x["category"] == "prohibited")
print(f"[孤立品目] 全{len(items):,}件 (品目マスタ全{total:,}件中 {len(items)*100/total:.1f}%)")
print(f"  現役孤立(設計ミス疑い): {n_active:,}件")
print(f"  廃番候補(使用禁止あり): {n_proh:,}件")

# 品目手順未登録リストも並び替え
items_no_route.sort(key=lambda x: (0 if x["category"] == "active" else 1, x["code"]))
nr_active = sum(1 for x in items_no_route if x["category"] == "active")
nr_proh = sum(1 for x in items_no_route if x["category"] == "prohibited")

# ---- 使用禁止品目を含む親品目のリスト ----
items_forbidden: list[dict] = []
for parent_code in sorted(forbidden_children_by_parent.keys()):
    forbidden = forbidden_children_by_parent[parent_code]
    r = item_master_map.get(parent_code)
    name = ""; mgmt = ""; supplier = ""; prohibit = ""; category = "active"; stock = None
    if r:
        name = (r.get("品目名") or "").strip()
        mgmt = (r.get("在庫管理区分名") or "").strip()
        supplier = (r.get("主仕入先名") or "").strip()
        prohibit = (r.get("使用禁止日") or "0").strip()
        if prohibit and (not prohibit.isdigit() or len(prohibit) != 8): prohibit = "0"
        is_proh = (prohibit and prohibit != "0" and prohibit <= TODAY_YMD)
        category = "prohibited" if is_proh else "active"
        if prohibit == "0": prohibit = ""
        if parent_code in stock_by_code:
            stock = round(stock_by_code[parent_code], 2)
    # 子品目に名前を追加
    for fc in forbidden:
        cm = item_master_map.get(fc["code"])
        fc["name"] = (cm.get("品目名") or "").strip() if cm else ""
    items_forbidden.append({
        "code": parent_code,
        "name": name,
        "mgmt": mgmt,
        "supplier": supplier,
        "prohibit": prohibit,
        "category": category,
        "stock": stock,
        "forbidden_children": forbidden[:10],  # 最大10件
        "n_forbidden": len(forbidden),
    })
# 並び替え: 現役を先, コード昇順
items_forbidden.sort(key=lambda x: (0 if x["category"] == "active" else 1, x["code"]))
fb_active = sum(1 for x in items_forbidden if x["category"] == "active")
fb_proh = sum(1 for x in items_forbidden if x["category"] == "prohibited")
print(f"[使用禁止品目を含む構成] 全{len(items_forbidden)}件 (現役:{fb_active} / 使用禁止親:{fb_proh})")

# ---- 4. JS出力 ----
meta = {
    "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    "basis_date": TODAY_STR,
    "n_active": n_active,
    "n_prohibited": n_proh,
    "n_total_items": total,
    "n_linked": len(linked),
    "n_bom_parents": len(parents),
    "n_noroute_total": len(items_no_route),
    "n_noroute_active": nr_active,
    "n_noroute_prohibited": nr_proh,
    "n_forbidden_total": len(items_forbidden),
    "n_forbidden_active": fb_active,
    "n_forbidden_prohibited": fb_proh,
    "route_master_found": route_master_found,  # False=品目手順マスタ未取得(登録漏れ判定スキップ)
}
out = ROOT / "orphan_items.js"
js = "window.ORPHAN_ITEMS = " + json.dumps(items, ensure_ascii=False, separators=(",", ":")) + ";\n"
js += "window.NOROUTE_ITEMS = " + json.dumps(items_no_route, ensure_ascii=False, separators=(",", ":")) + ";\n"
js += "window.FORBIDDEN_ITEMS = " + json.dumps(items_forbidden, ensure_ascii=False, separators=(",", ":")) + ";\n"
js += "window.ORPHAN_META = " + json.dumps(meta, ensure_ascii=False) + ";\n"
out.write_text(js, encoding="utf-8")
print(f"\n出力: {out}")
print(f"  サイズ: {len(js):,} chars (~{len(js)/1024:.0f} KB)")

# ---- 5. JSON出力 (2026-07 セキュリティ移行: 公開Pagesに置かず SharePoint 認証配信) ----
#   .js の window 代入値と同じ構造を純JSONで data/orphan_items.json に出力する。
#   upload_fujin_data.py が SharePoint へアップロード → 親FUJIN.htmlが認証fetchして
#   window._fujinOrphan にセット → stock_detective.html が top参照で採用する。
#   (item_history / work_instructions と同方式)
bundle = {
    "ORPHAN_ITEMS": items,
    "NOROUTE_ITEMS": items_no_route,
    "FORBIDDEN_ITEMS": items_forbidden,
    "ORPHAN_META": meta,
}
data_dir = ROOT / "data"
data_dir.mkdir(exist_ok=True)
out_json = data_dir / "orphan_items.json"
json_text = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
out_json.write_text(json_text, encoding="utf-8")
print(f"出力: {out_json}")
print(f"  サイズ: {len(json_text):,} chars (~{len(json_text)/1024:.0f} KB)")
