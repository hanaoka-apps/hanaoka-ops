#!/usr/bin/env python3
"""製番 製造スケジュール (BOM×リードタイム逆算ガント) 用データ生成。

雅さん 2026-06-17:
  製品(製番)を選ぶと、BOMを全階層展開し各部品のリードタイムから納期を起点に
  逆算した「あるべき製造日程」をガント表示する。受注J/計画K どちらからでも開ける。

データソース (SharedMasters 直読 → data/ フォールバック):
  - 構成マスタ.csv          : BOMツリー (親品目→子品目, 取数)
  - 品目マスタ.csv/.txt     : 累積/購買リードタイム, 品目名
  - 工程マスタ.csv          : 工程→手配先名(作業区)・内外
  - 製造指図出力.csv        : 品目→工程(作業区), 手配済, 報告済(=受入済)
  - 未確定_購買手配データ.csv: 手配済(所要量計算)
  - 発注明細出力.csv        : 手配済
  - 確定済_工程手配一覧.csv : 手配済, 報告済
  - 受入明細出力.csv        : 受入済(実績あり=来ている)
  - 受注明細出力.csv        : 受注J製番 (顧客・納期・残)
  - 生産計画出力.csv/生産計画.txt : 計画K製番

出力:
  data/seiban_gantt.json  (SharePointへアップロード → 画面は認証fetchで取得)
  data/seiban_gantt.js    (window.SEIBAN_GANTT = ...; ローカルfile://確認用)
"""
import csv
import json
import os
import collections
from datetime import datetime
from pathlib import Path

# 基準日(今日)。これより納期が過去の製番/計画は「終わったもの」として一覧から除外する。
TODAY = datetime.now().strftime("%Y/%m/%d")

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent if ROOT.name == "scripts" else ROOT
DATA = BASE / "data"

_cand = [
    os.environ.get("FUJIN_SHARED", ""),
    str(Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters"),
    str(BASE.parent / "OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters"),
    str(DATA),
]


def _ex(p):
    try:
        return bool(p) and Path(p).exists()
    except Exception:
        return False


SHARED = Path(next((p for p in _cand if _ex(p)), str(DATA)))


def mp(*names):
    """SharedMasters優先で存在するファイルパスを返す。なければ data/ フォールバック。"""
    for n in names:
        p = SHARED / n
        if p.exists():
            return p
    for n in names:
        p = DATA / n
        if p.exists():
            return p
    return None


def detect(p):
    with open(p, encoding="utf-8-sig", errors="replace") as f:
        first = f.readline()
    return "\t" if first.count("\t") > first.count(",") else ","


def sf(s):
    try:
        return float(str(s).replace(",", "").strip().strip('"'))
    except Exception:
        return 0.0


def nd(s):
    s = (s or "").strip().strip('"')
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}/{s[4:6]}/{s[6:]}"
    if "/" in s:
        q = s.split("/")
        if len(q) == 3:
            try:
                return f"{int(q[0]):04d}/{int(q[1]):02d}/{int(q[2]):02d}"
            except Exception:
                return s
    return ""


def K(ks, *nm):
    for n in nm:
        for k in ks:
            if k.strip().strip('"') == n:
                return k
    return None


# ---- BOM (構成マスタ) ----
bom = collections.defaultdict(list)
p_bom = mp("構成マスタ.csv")
if p_bom:
    d = detect(p_bom)
    with open(p_bom, encoding="utf-8-sig", errors="replace") as f:
        for r in csv.DictReader(f, delimiter=d):
            par = (r.get("親品目ｺｰﾄﾞ") or r.get("親品目コード") or "").strip().strip('"')
            ch = (r.get("子品目ｺｰﾄﾞ") or r.get("子品目コード") or "").strip().strip('"')
            if not par or not ch:
                continue
            qn = sf(r.get("取数(分子)") or r.get("取数（分子）") or 1) or 1.0
            qd = sf(r.get("取数(分母)") or r.get("取数（分母）") or 1) or 1.0
            bom[par].append({
                "child": ch,
                "child_name": (r.get("子品目名") or "").strip().strip('"')[:40],
                "qty_num": qn,
                "qty_den": qd,
            })
bom = dict(bom)
codes = set(bom)
for v in bom.values():
    for c in v:
        codes.add(c["child"])
print(f"[BOM] 親{len(bom):,} / 全コード{len(codes):,}  src={p_bom}")

# ---- リードタイム・品目名 (品目マスタ) ----
lt = {}
iname = {}
p_item = mp("品目マスタ.csv", "品目マスタ.txt")
if p_item:
    d = detect(p_item)
    with open(p_item, encoding="utf-8-sig", errors="replace") as f:
        rr = csv.reader(f, delimiter=d)
        next(rr, None)  # ヘッダ1行
        for row in rr:
            if len(row) < 2:
                continue
            code = row[0].strip().strip('"')
            if code not in codes:
                continue
            a = sf(row[96]) if len(row) > 96 else 0.0   # 累積リードタイム
            b = sf(row[108]) if len(row) > 108 else 0.0  # 購買リードタイム
            lt[code] = max(int(a if a > 0 else b), 1)
            iname[code] = row[1].strip().strip('"')
print(f"[品目マスタ] LT {len(lt):,}  src={p_item}")

# ---- 工程→作業区 ----
proc = {}
p_proc = mp("工程マスタ.csv")
if p_proc:
    for r in csv.DictReader(open(p_proc, encoding="utf-8-sig", errors="replace")):
        c = (r.get("工程ｺｰﾄﾞ") or r.get("工程コード") or "").strip()
        w = (r.get("手配先名") or "").strip()
        io = (r.get("内外区分名") or "").strip()
        if c and w:
            proc[c] = {"wp": w, "io": io}

# ---- item_wp / arr(手配済) / recv(受入済=来ている) ----
item_wp = {}
arr = set()
recv = set()


def scan(name, for_wp=False, count_arr=True):
    p = mp(name)
    if not p:
        print(f"  [scan] {name} 見つからず")
        return
    d = detect(p)
    rows = list(csv.DictReader(open(p, encoding="utf-8-sig", errors="replace"), delimiter=d))
    if not rows:
        return
    ks = rows[0].keys()
    ci = K(ks, "品目ｺｰﾄﾞ", "品目コード")
    cp = K(ks, "工程ｺｰﾄﾞ", "工程コード")
    cr = K(ks, "報告済数量", "受入数量")
    for r in rows:
        it = (r.get(ci) or "").strip().strip('"') if ci else ""
        if not it or it not in codes:
            continue
        if count_arr:
            arr.add(it)
        if cr and sf(r.get(cr)) > 0:
            recv.add(it)
        if for_wp and it not in item_wp and cp:
            pc = (r.get(cp) or "").strip().strip('"')
            info = proc.get(pc)
            if info:
                item_wp[it] = [info["wp"], info["io"]]
            elif pc.startswith("1"):
                item_wp[it] = ["外注", "社外"]


scan("製造指図出力.csv", for_wp=True)
scan("未確定_購買手配データ.csv", for_wp=True)
scan("発注明細出力.csv")
scan("確定済_工程手配一覧.csv")
scan("受入明細出力.csv", count_arr=False)  # 受入は recv のみ(手配ではない)
print(f"[手配/受入] 手配済 arr {len(arr):,} / 受入済 recv {len(recv):,} / 作業区 wp {len(item_wp):,}")

# ---- 製番リスト (受注J + 計画K, 完了は除外) ----
SB = []
pdue = collections.defaultdict(list)
pnm = {}
p_ord = mp("受注明細出力.csv")
if p_ord:
    d = detect(p_ord)
    rows = list(csv.DictReader(open(p_ord, encoding="utf-8-sig", errors="replace"), delimiter=d))
    ks = rows[0].keys()
    oc = K(ks, "品目ｺｰﾄﾞ"); od = K(ks, "納期"); oq = K(ks, "数量")
    ocu = K(ks, "得意先名略称"); osb = K(ks, "製番"); osold = K(ks, "売上済数量")
    ocomp = K(ks, "完納区分名"); onm = K(ks, "品目名")
    for r in rows:
        sb = (r.get(osb) or "").strip().strip('"')
        code = (r.get(oc) or "").strip().strip('"')
        if not sb.startswith("J") or code not in bom:
            continue
        q = sf(r.get(oq)); sold = sf(r.get(osold))
        due = nd(r.get(od)); comp = (r.get(ocomp) or "").strip().strip('"')
        pnm.setdefault(code, (r.get(onm) or "").strip().strip('"'))
        if comp == "完納":
            continue
        if due and due < TODAY:  # 納期が過去=終わったもの(または期限超過)は出さない
            continue
        SB.append({"sb": sb, "k": "J", "it": code,
                   "cu": (r.get(ocu) or "").strip().strip('"'),
                   "due": due, "q": round(q, 1), "rem": round(max(q - sold, 0), 1)})
        if due:
            pdue[code].append(due)

p_plan = mp("生産計画出力.csv", "生産計画.txt")
if p_plan:
    d = detect(p_plan)
    rows = list(csv.DictReader(open(p_plan, encoding="utf-8-sig", errors="replace"), delimiter=d))
    ks = rows[0].keys()
    pc = K(ks, "品目ｺｰﾄﾞ"); psb = K(ks, "製番"); ppd = K(ks, "生産計画日付")
    ppq = K(ks, "生産計画数量"); pdn = K(ks, "完成済数"); pnmn = K(ks, "品目名")
    for r in rows:
        code = (r.get(pc) or "").strip().strip('"')
        sb = (r.get(psb) or "").strip().strip('"')
        if code not in bom or not sb:
            continue
        pq = sf(r.get(ppq)); dn = sf(r.get(pdn)); rem = pq - dn
        if rem <= 0:
            continue
        due = min(pdue.get(code, []) or [nd(r.get(ppd))])
        if due and due < TODAY:  # 納期が過去=終わったもの(または期限超過)は出さない
            continue
        SB.append({"sb": sb, "k": "K", "it": code, "cu": "",
                   "due": due, "q": round(pq, 1), "rem": round(rem, 1)})
        pnm.setdefault(code, (r.get(pnmn) or "").strip().strip('"'))

for c in bom:
    if c not in pnm:
        pnm[c] = iname.get(c, "")
print(f"[製番] {len(SB):,} (受注J + 計画K, 完了除外)")

out = {"bom": bom, "lt": lt, "arr": sorted(arr), "recv": sorted(recv),
       "wp": item_wp, "sb": SB, "pnm": pnm}
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "seiban_gantt.json").write_text(
    json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(DATA / "seiban_gantt.js").write_text(
    "window.SEIBAN_GANTT = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n",
    encoding="utf-8")
_sz = (DATA / "seiban_gantt.json").stat().st_size
print(f"出力: data/seiban_gantt.json ({_sz/1024/1024:.2f} MB) "
      f"製番{len(SB):,} / BOM親{len(bom):,} / 手配済{len(arr):,} / 受入済{len(recv):,}")
