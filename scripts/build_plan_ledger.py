#!/usr/bin/env python3
"""納期確認画面 (plan_ledger.json) を生成する。

目的:
  営業・業務センターが工場に聞かずに納期の目安を答えられるよう、
  型式 → 部品(フレーム／ハンドル／キャスター) または 完成品(第3工場リフト等) について
  日別の入出と予測在庫・回答可能数を出す元データを作る。(弟・尚さん設計の画面 + 2026-10 雅さん確認ルール)

入力(data/ = download_shared_masters.py の取得先):
  item_history.json(build_item_history.py出力) / 生産計画出力.csv / 品目マスタ.csv / 有効在庫一覧表.csv /
  構成マスタ.csv / 確定済_工程手配一覧.csv / 未確定_購買手配データ.csv

数量の考え方(確定・仮説の区別は画面の「数字の出どころ」にも記載):
  入(供給)
    plan : 生産計画(K製番)の残。状態「手配確定」と「手配予定」を区別。計画日が過去で未完成=付け替え漏れ(当日中に先へずらすルール違反)
    conf : 確定済み手配の残。社内/外注工程は 確定済_工程手配一覧 の最終工程行(M製番のみ。K製番は計画側で数える)、
           購買品は item_history の確定発注残。納期が過去のものは「遅れ(実績未入力の可能性)」として本日に置く
    unc  : 所要量計算の未確定手配(未確定_購買手配データ、M製番の最終工程/購買行)。納期が過去のものは件数だけ警告
    実績 : 製造報告(K/M別)・受入
  出(需要)
    req  : 親品目の組立による使用予定(所要量の考え方。親の在庫は所要量計算で差し引き済み)
           = 親のK計画残 × 取数 + 親の確定手配残(子部品登録行) × 取数 + 親の未確定手配(子部品登録行) × 取数
    ord  : 参考。親機種の受注残 × 取数(出荷予定日)。計算には使わず、客先の確認用
    完成品(リフト等)は自品目の受注残(出荷予定日)を出とする
    使用実績: 親の完組での使用 / 完成品は売上(出荷)
  在庫: 有効在庫一覧表の現在庫(全社)。品目コードが無いため品目名で突き合わせ

出力: data/plan_ledger.json (公開Pagesに置かず upload_fujin_data.py で SharePoint へ)
"""
import csv
import json
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent
if BASE.name == "scripts":
    BASE = BASE.parent
DATA = BASE / "data"

PAST_DAYS = 14      # 表示する過去日数
FUTURE_DAYS = 100   # 表示する先の日数(まとめ計画を拾えるよう長め)
FRAME_KEY = "ﾌﾚｰﾑ FULL ASSY"
HANDLE_KEY = "ﾊﾝﾄﾞﾙ FULL ASSY"


def nk(s):
    return unicodedata.normalize("NFKC", s or "").strip()


def sf(s):
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def pd(s):
    s = (s or "").replace("/", "").replace("-", "").strip()
    if len(s) != 8 or not s.isdigit() or s in ("00000000", "99999999"):
        return None
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def read_dicts(path):
    """UTF-8 BOM / タブorカンマ 自動判定。列名の前後空白と全角スペースのゆれを吸収した dict を返す"""
    if not path.exists():
        print(f"[WARN] {path.name} が無い")
        return []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        head = f.readline()
        f.seek(0)
        delim = "\t" if head.count("\t") > head.count(",") else ","
        rows = []
        for r in csv.DictReader(f, delimiter=delim):
            rows.append({nk(k).replace(" ", ""): (v or "").strip().strip('"') for k, v in r.items() if k})
        return rows


def g(r, *keys):
    for k in keys:
        v = r.get(nk(k).replace(" ", ""))
        if v not in (None, ""):
            return v
    return ""


def main():
    ih = json.loads((DATA / "item_history.json").read_text(encoding="utf-8"))
    items_h = ih["items"]
    today = datetime.strptime(ih["as_of"], "%Y/%m/%d").date()
    start, end = today - timedelta(days=PAST_DAYS), today + timedelta(days=FUTURE_DAYS)
    DATES = [start + timedelta(i) for i in range((end - start).days + 1)]
    di = {d: i for i, d in enumerate(DATES)}
    T = di[today]

    def idx(d, clamp_past=True):
        """日付→列番号。過去(表示開始より前)は clamp_past なら本日扱いにせず None"""
        if d is None:
            return None
        if d < start:
            return None
        if d > end:
            return None
        return di[d]

    # ---- マスタ
    master = {}
    for r in read_dicts(DATA / "品目マスタ.csv"):
        c = g(r, "品目ｺｰﾄﾞ", "品目コード")
        if not c:
            continue
        master[c] = {
            "name": nk(g(r, "品目名")), "big": nk(g(r, "大分類名")), "gyomu": g(r, "業務納期確認名"),
            "safety": sf(g(r, "安全在庫数")), "plan_flag": g(r, "生産計画区分名"),
            "banned": g(r, "使用禁止日") not in ("", "0"), "lt": sf(g(r, "累積ﾘｰﾄﾞﾀｲﾑ", "累積リードタイム")),
            "unit": nk(g(r, "単位")),
        }

    # ---- 在庫(全社・品目名で突合)
    stock = {}
    p = DATA / "有効在庫一覧表.csv"
    if p.exists():
        with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
            rows = list(csv.reader(f))
        hi = next((i for i, r in enumerate(rows) if r and nk(r[0]) == "品目名"), None)
        if hi is not None:
            h = {nk(k): i for i, k in enumerate(rows[hi])}
            for r in rows[hi + 1:]:
                if r and r[0].strip():
                    gg = lambda k: r[h[k]] if k in h and h[k] < len(r) else ""
                    stock[nk(r[0])] = sf(gg("現在庫数"))
    stock_mtime = ""
    if (DATA / "_stock_mtime.txt").exists():
        stock_mtime = (DATA / "_stock_mtime.txt").read_text(encoding="utf-8").strip()[:16]

    # ---- BOM 親→子, 子→親
    bom = defaultdict(dict)
    for r in read_dicts(DATA / "構成マスタ.csv"):
        pa, ch = g(r, "親品目ｺｰﾄﾞ"), g(r, "子品目ｺｰﾄﾞ")
        if not pa or not ch:
            continue
        fb = pd(g(r, "使用禁止日"))
        if fb and fb <= today:
            continue
        ex = pd(g(r, "失効日"))
        if ex and ex < today:
            continue
        num, den = sf(g(r, "取数(分子)")), sf(g(r, "取数(分母)")) or 1
        if num <= 0:
            continue
        bom[pa][ch] = bom[pa].get(ch, 0) + num / den
    parents_of = defaultdict(dict)
    for pa, chs in bom.items():
        for ch, q in chs.items():
            parents_of[ch][pa] = q

    # ---- 生産計画
    plans = defaultdict(list)
    plan_upd = {}
    for r in read_dicts(DATA / "生産計画出力.csv"):
        c = g(r, "品目ｺｰﾄﾞ")
        d = pd(g(r, "生産計画日付"))
        if not c or not d:
            continue
        plans[c].append({"d": d, "sb": g(r, "製番"), "q": sf(g(r, "生産計画数量")), "done": sf(g(r, "完成済数")),
                         "st": g(r, "製番状態区分名")})
        od = pd(g(r, "操作日付"))
        if od and (c not in plan_upd or od > plan_upd[c]):
            plan_upd[c] = od

    # ---- 確定済み工程手配(最終工程=供給 / 子部品登録行=親の使用)
    conf_proc = defaultdict(list)
    conf_parent_use = defaultdict(list)
    for r in read_dicts(DATA / "確定済_工程手配一覧.csv"):
        c = g(r, "品目コード")
        if not c:
            continue
        if "完納" in g(r, "手配強制完納区分") and "未完" not in g(r, "手配強制完納区分"):
            continue
        qty = sf(g(r, "手配数量(在庫単位)", "手配数量"))
        done = sf(g(r, "報告済数量(在庫単位)", "報告済数量"))
        rem = qty - done
        if rem <= 0:
            continue
        sb = g(r, "製番")
        due = pd(g(r, "手配納期(年月日）", "手配納期(年月日)"))
        if "最終工程" in g(r, "最終工程区分") and sb.startswith("M"):
            conf_proc[c].append({"d": due, "q": rem, "sb": sb, "who": nk(g(r, "手配先略称")), "proc": nk(g(r, "工程略称"))})
        if "あり" in g(r, "子部品登録区分"):
            ud = pd(g(r, "子部品出庫予定日(年月日)", "子部品出庫予定日（年月日）")) or due
            conf_parent_use[c].append({"d": ud, "q": rem, "sb": sb})

    # ---- 未確定手配(所要量計算の結果)
    unc_sup = defaultdict(list)
    unc_parent_use = defaultdict(list)
    seen = set()
    for r in read_dicts(DATA / "未確定_購買手配データ.csv"):
        c = g(r, "品目コード")
        if not c:
            continue
        qty = sf(g(r, "手配数量"))
        if qty <= 0:
            continue
        sb = g(r, "製番", "内部製番")
        due = pd(g(r, "手配納期(年月日）", "手配納期(年月日)"))
        plan_d = pd(g(r, "手配予定日（年月日）", "手配予定日(年月日)"))
        final = "最終工程" in g(r, "最終工程区分") or "購買" in g(r, "手配データ区分")
        if final and not sb.startswith("K"):  # K製番は生産計画側で数える
            key = (c, sb, g(r, "手配番号"), due)
            if key not in seen:
                seen.add(key)
                unc_sup[c].append({"d": due or plan_d, "q": qty, "sb": sb, "who": nk(g(r, "手配先略称")),
                                   "kind": "購買" if "購買" in g(r, "手配データ区分") else "工程"})
        if "あり" in g(r, "子部品登録区分"):
            ud = pd(g(r, "子部品出庫予定日（年月日）", "子部品出庫予定日(年月日)")) or plan_d
            unc_parent_use[c].append({"d": ud, "q": qty, "sb": sb})

    # ---- 対象品目の決定
    frames = {c for c, m in master.items() if FRAME_KEY in m["gyomu"] and not m["banned"]}
    handles_all = {c for c, m in master.items() if HANDLE_KEY in m["gyomu"] and not m["banned"]}
    # 仮説: キャスター本体は名称に「固定キャスター」「自在キャスター」を含む(キャスターストッパー等の付属品は除外)
    is_caster = lambda c: c in master and ("固定キャスター" in master[c]["name"] or "自在キャスター" in master[c]["name"])

    def is_model(c):
        m = master.get(c)
        return bool(m) and not m["banned"] and m["big"] not in ("", "部品", "輸入仕入", "運賃・クレーム他") \
            and c not in frames and c not in handles_all

    models = {}
    for fc in frames:
        for pa, q in parents_of.get(fc, {}).items():
            if not is_model(pa):
                continue
            parts = []
            for ch, per in bom.get(pa, {}).items():
                if ch in frames:
                    parts.append((ch, per, "frame"))
                elif ch in handles_all or ("ハンドル" in master.get(ch, {}).get("name", "") and "FullASSY".lower() in master.get(ch, {}).get("name", "").replace(" ", "").lower()):
                    parts.append((ch, per, "handle"))
                elif is_caster(ch):
                    parts.append((ch, per, "caster"))
            if parts:
                models[pa] = parts
    products = {c for c, m in master.items() if m["plan_flag"] == "行う" and not m["banned"]
                and c not in frames and c not in handles_all
                and any(start <= p["d"] <= end for p in plans.get(c, []))}

    kind_of = {}
    for c in frames:
        kind_of[c] = "frame"
    for parts in models.values():
        for ch, _, k in parts:
            kind_of.setdefault(ch, k)
    for c in products:
        kind_of.setdefault(c, "product")

    # ---- メッキ品(フレームFULL ASSYの子孫で名称に「ﾒｯｷ」)
    def find_plating(fc):
        frontier, depth = [fc], 0
        while frontier and depth < 3:
            nxt = []
            for x in frontier:
                for ch in bom.get(x, {}):
                    nm = master.get(ch, {}).get("name", "")
                    if "メッキ" in nm and "戻" not in nm:
                        return ch
                    nxt.append(ch)
            frontier, depth = nxt, depth + 1
        return None

    # ---- 品目ごとのイベント
    def item_events(c, kind):
        ev = []  # [dateIdx, type, qty, info]
        late = {"plan": 0.0, "conf": 0.0, "unc": 0}
        it = items_h.get(c, {})
        for p in plans.get(c, []):
            i = idx(p["d"])
            rem = p["q"] - p["done"]
            firm = "確定" in p["st"]
            if p["d"] < today and rem > 0 and "完了" not in p["st"]:
                late["plan"] += rem
                ev.append([T, "planLate", rem, {"sb": p["sb"], "d": p["d"].isoformat(), "st": p["st"], "q": p["q"], "done": p["done"]}])
            if i is not None:
                ev.append([i, "plan", p["q"], {"sb": p["sb"], "done": p["done"], "st": p["st"], "firm": firm}])
        for r in it.get("production", []):
            d = pd(r.get("date"))
            i = idx(d)
            if i is None or d > today:
                continue
            sb = str(r.get("seiban", ""))
            ev.append([i, "actK" if sb.startswith("K") else "actM", sf(r.get("reported_qty")), {"sb": sb, "pd": r.get("planned_date", "")}])
        for r in it.get("receipts", []):
            d = pd(r.get("date"))
            i = idx(d)
            if i is None or d > today:
                continue
            ev.append([i, "rcv", sf(r.get("qty")), {"who": r.get("supplier", "")}])
        for r in conf_proc.get(c, []):
            d = r["d"] or today
            if d < today:
                late["conf"] += r["q"]
            i = idx(max(d, today))
            if i is not None:
                ev.append([i, "conf", r["q"], {"sb": r["sb"], "who": r["who"], "late": d < today, "due": d.isoformat()}])
        for r in it.get("purchase_orders_conf", []):
            d = pd(r.get("date")) or today
            q = sf(r.get("qty"))
            if q <= 0:
                continue
            if d < today:
                late["conf"] += q
            i = idx(max(d, today))
            if i is not None:
                ev.append([i, "conf", q, {"sb": r.get("seiban", ""), "who": r.get("supplier", ""), "late": d < today, "due": d.isoformat()}])
        for r in unc_sup.get(c, []):
            d = r["d"] or today
            if d < today:
                late["unc"] += 1
                continue
            i = idx(d)
            if i is not None:
                ev.append([i, "unc", r["q"], {"sb": r["sb"], "who": r["who"], "k": r["kind"]}])
        # 出
        if kind == "product":
            for o in it.get("sales_orders", []):
                q = sf(o.get("remaining_qty"))
                if q <= 0:
                    continue
                d0 = pd(o.get("shipment_date") or o.get("due")) or today
                i = idx(max(d0, today))
                if i is not None:
                    ev.append([i, "req", q, {"c": o.get("customer", ""), "no": o.get("order_no", ""), "due": o.get("due", ""), "late": d0 < today, "src": "受注"}])
            for s in it.get("sales", []):
                d = pd(s.get("date"))
                i = idx(d)
                if i is not None and d <= today:
                    ev.append([i, "use", sf(s.get("qty")), {"p": s.get("customer", "")}])
        else:
            for pa, per in parents_of.get(c, {}).items():
                if master.get(pa, {}).get("banned"):
                    continue
                for p in plans.get(pa, []):
                    rem = p["q"] - p["done"]
                    if rem <= 0 or p["d"] < today or "完了" in p["st"]:
                        continue
                    i = idx(p["d"])
                    if i is not None:
                        ev.append([i, "req", rem * per, {"p": pa, "sb": p["sb"], "per": per, "src": "親の計画"}])
                for r in conf_parent_use.get(pa, []):
                    d = r["d"] or today
                    i = idx(max(d, today))
                    if i is not None:
                        ev.append([i, "req", r["q"] * per, {"p": pa, "sb": r["sb"], "per": per, "src": "親の確定手配", "late": d < today}])
                for r in unc_parent_use.get(pa, []):
                    d = r["d"] or today
                    if d < today:
                        continue
                    i = idx(d)
                    if i is not None:
                        ev.append([i, "req", r["q"] * per, {"p": pa, "sb": r["sb"], "per": per, "src": "親の未確定手配"}])
                for o in items_h.get(pa, {}).get("sales_orders", []):
                    q = sf(o.get("remaining_qty"))
                    if q <= 0:
                        continue
                    d0 = pd(o.get("shipment_date") or o.get("due")) or today
                    i = idx(max(d0, today))
                    if i is not None:
                        ev.append([i, "ord", q * per, {"p": pa, "c": o.get("customer", ""), "no": o.get("order_no", ""), "q": q, "per": per, "due": o.get("due", "")}])
            for r in it.get("consumption", []):
                d = pd(r.get("date"))
                i = idx(d)
                if i is not None and d <= today:
                    ev.append([i, "use", sf(r.get("qty")), {"p": r.get("parent_code", ""), "per": sf(r.get("qty_per")) or 1}])
        return ev, late

    out_items = {}
    for c, kind in kind_of.items():
        m = master.get(c)
        if not m:
            continue
        ev, late = item_events(c, kind)
        nm = m["name"]
        upcoming = [p for p in plans.get(c, []) if today <= p["d"] <= today + timedelta(days=14)]
        rec = {
            "code": c, "name": nm, "kind": kind, "grp": m["big"] or "", "unit": m["unit"], "safety": m["safety"],
            "stock": stock.get(nm, 0.0), "stockFound": nm in stock, "lt": m["lt"],
            "planUpd": plan_upd[c].isoformat() if c in plan_upd else "",
            "planned": m["plan_flag"] == "行う", "noPlan14": m["plan_flag"] == "行う" and not upcoming,
            "late": late, "ev": ev, "parents": len(parents_of.get(c, {})),
        }
        if kind == "frame":
            pc = find_plating(c)
            if pc and pc in master:
                pev, _ = item_events(pc, "plating")
                rec["plating"] = {"code": pc, "name": master[pc]["name"],
                                  "ev": [e for e in pev if e[1] in ("conf", "unc", "actK", "actM", "rcv")]}
        out_items[c] = rec

    out_models = {}
    for pa, parts in models.items():
        m = master[pa]
        out_models[pa] = {"name": m["name"], "grp": m["big"], "lt": m["lt"], "stock": stock.get(m["name"]),
                          "parts": [[ch, round(per, 4), k] for ch, per, k in parts if ch in out_items]}
    for c in products:
        if c in out_items:
            m = master[c]
            out_models[c] = {"name": m["name"], "grp": m["big"], "lt": 0, "stock": stock.get(m["name"]),
                             "parts": [[c, 1, "product"]], "self": True}

    payload = {"asOf": today.isoformat(), "stockAsOf": stock_mtime, "dates": [d.isoformat() for d in DATES],
               "today": T, "items": out_items, "models": out_models}
    DATA.mkdir(exist_ok=True)
    p = DATA / "plan_ledger.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cnt = defaultdict(int)
    for r in out_items.values():
        cnt[r["kind"]] += 1
    print(f"[出力] {p} ({p.stat().st_size:,} bytes) 品目 {dict(cnt)} / 型式 {len(out_models)}")
    miss = [c for c, r in out_items.items() if not r["stockFound"]]
    if miss:
        print(f"[WARN] 有効在庫一覧表に品目名が無く現在庫0扱い: {len(miss)}件 例 {miss[:8]}")


if __name__ == "__main__":
    main()
