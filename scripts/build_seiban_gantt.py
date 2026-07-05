#!/usr/bin/env python3
"""製番 製造スケジュール (BOM×リードタイム逆算ガント) 用データ生成。

雅さん 2026-06-17:
  製品(製番)を選ぶと、BOMを全階層展開し各部品のリードタイムから納期を起点に
  逆算した「あるべき製造日程」をガント表示する。受注J/計画K どちらからでも開ける。

データソース (SharedMasters 直読 → data/ フォールバック):
  - 構成マスタ.csv          : BOMツリー (親品目→子品目, 取数)
  - 品目マスタ.csv/.txt     : 累積/購買リードタイム, 品目名
  - 工程マスタ.csv          : 工程→手配先名(作業区)・内外
  - 製造指図出力.csv        : 品目→工程(作業区), 実手配(arr), 報告済(=受入済)
  - 未確定_購買手配データ.csv: 要発注(req)=所要量計算(MRP)の不足提案
  - 発注明細出力.csv        : 実手配(arr)
  - 確定済_工程手配一覧.csv : 実手配(arr), 報告済
  - 受入明細出力.csv        : 受入済(実績あり=来ている)

手配状態の考え方 (雅さん 2026-07-06, 実データ検証済):
  未確定_購買手配データ = SMILEの所要量計算(MRP)出力。MRPは在庫+発注残から将来の
  所要量を時系列で差し引き、不足分だけ手配提案する(検証: 総所要量>有効在庫数が96%,
  残りは手配方式「需要数」=在庫を見ず必ず手配する品目)。したがって
    req  = 未確定に載る       = 将来所要を加味しても不足 = 要発注(赤)
    arr  = 発注/指図/確定工程 = 実際に手配済(入荷待ち)   = 黄
    recv = 受入/報告済        = 来ている                 = グレー
    どれにも無い              = MRPが提案していない = 将来所要込みで足りる = 手配不要(グレー)
  ※有効在庫一覧の有効在庫数>=0 は要発注の否定材料にならない(未確定に載る品目の
    99%が有効在庫>=0だった。一覧の出庫予定は確定済の予定のみで未確定所要を含まない)。
    cov は二次的な裏付け表示(在庫あり)としてのみ残す。
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
try:
    from zoneinfo import ZoneInfo
    _JST = ZoneInfo("Asia/Tokyo")
except Exception:
    _JST = None

# 基準日(今日)。これより納期が過去の製番/計画は「終わったもの」として一覧から除外する。
# CI(GitHub Actions)はUTCのため、JSTで「今日」を確定する(日付が1日ズレて除外がずれる事故防止)。
TODAY = (datetime.now(_JST) if _JST else datetime.now()).strftime("%Y/%m/%d")

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

# ---- 在庫 (有効在庫一覧): cov = 有効在庫数>=0 (二次情報「在庫あり」表示用) ----
# 注意: 有効在庫一覧の有効在庫数 = 現在庫+入庫予定-出庫予定 (実データで全行一致を確認)。
# ただし出庫予定は確定済の予定のみで、未確定の将来所要(MRP計算対象)は含まれない。
# → 要発注(req=未確定手配)の判定を cov で打ち消してはいけない。covは補助表示のみ。
# 有効在庫一覧(UTF-16 TSV / UTF-8 CSV 両対応, 先頭3行ヘッダ, 列: 品目名/単位/現在庫数/(空)/入庫予定/出庫予定/有効在庫数/適正在庫)
cov = set()  # 有効在庫数>=0 の品目コード
def _read_stock(path):
    if not path or not path.exists():
        return None
    content = None
    try:
        with open(path, encoding="utf-16") as f:
            content = f.read()
        if "品目名" not in content[:500]:
            content = None
    except Exception:
        content = None
    if content is None:
        try:
            with open(path, encoding="utf-8-sig", errors="replace") as f:
                content = f.read()
        except Exception:
            return None
    if not content:
        return None
    sample = "\n".join(content.splitlines()[:6])
    use_csv = ("\t" not in sample) and ("," in sample)
    if use_csv:
        import io as _io
        rows = list(csv.reader(_io.StringIO(content)))
    else:
        rows = [ln.split("\t") for ln in content.splitlines()]
    eff_by_name = {}
    for cols in rows[3:]:  # 先頭3行はヘッダ
        if len(cols) < 7:
            continue
        nm = (cols[0] or "").strip()
        if not nm:
            continue
        s = (cols[6] or "").strip().strip('"').replace(",", "")  # 有効在庫数
        try:
            eff_by_name[nm] = float(s)
        except Exception:
            continue
    return eff_by_name or None

p_stk = mp("有効在庫一覧表.csv", "有効在庫一覧.csv", "有効在庫一覧表.txt", "有効在庫一覧.txt")
_eff_by_name = _read_stock(p_stk) or {}
for c in codes:
    nm = iname.get(c, "")
    if nm and _eff_by_name.get(nm, -1) >= 0:
        cov.add(c)
print(f"[在庫] 有効在庫>=0(補助表示「在庫あり」) {len(cov):,}  src={p_stk}")

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

# ---- item_wp / arr(実手配=発注・指図・確定工程) / req(要発注=MRP不足提案) / recv(受入済) ----
item_wp = {}
arr = set()   # 実手配あり(入荷待ち=黄)
req = set()   # 未確定_購買手配データ=所要量計算(MRP)の不足提案(要発注=赤)
recv = set()  # 受入/報告済(来ている=グレー)


def scan(name, into=None, for_wp=False):
    """into: 品目コードを追加する集合(arr/req)。Noneなら状態集合には入れない(recv/wpのみ)。"""
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
        if into is not None:
            into.add(it)
        if cr and sf(r.get(cr)) > 0:
            recv.add(it)
        if for_wp and it not in item_wp and cp:
            pc = (r.get(cp) or "").strip().strip('"')
            info = proc.get(pc)
            if info:
                item_wp[it] = [info["wp"], info["io"]]
            elif pc.startswith("1"):
                item_wp[it] = ["外注", "社外"]


scan("製造指図出力.csv", into=arr, for_wp=True)          # 実手配(製造)
scan("未確定_購買手配データ.csv", into=req, for_wp=True)  # MRP不足提案=要発注
scan("発注明細出力.csv", into=arr)                        # 実手配(購買)
scan("確定済_工程手配一覧.csv", into=arr)                 # 実手配(工程確定)
scan("受入明細出力.csv")                                  # 受入は recv のみ(手配ではない)
req -= (arr | recv)  # 既に実手配/受入済のものは要発注から外す(古い提案の残り等)
print(f"[手配/受入] 実手配 arr {len(arr):,} / 要発注 req {len(req):,} / 受入済 recv {len(recv):,} "
      f"/ 手配不要 {len(codes - arr - req - recv):,} / 作業区 wp {len(item_wp):,}")

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

out = {"bom": bom, "lt": lt, "arr": sorted(arr), "req": sorted(req), "recv": sorted(recv),
       "cov": sorted(cov), "wp": item_wp, "sb": SB, "pnm": pnm}
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "seiban_gantt.json").write_text(
    json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(DATA / "seiban_gantt.js").write_text(
    "window.SEIBAN_GANTT = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n",
    encoding="utf-8")
_sz = (DATA / "seiban_gantt.json").stat().st_size
print(f"出力: data/seiban_gantt.json ({_sz/1024/1024:.2f} MB) "
      f"製番{len(SB):,} / BOM親{len(bom):,} / 実手配{len(arr):,} / 要発注{len(req):,} / 受入済{len(recv):,}")
