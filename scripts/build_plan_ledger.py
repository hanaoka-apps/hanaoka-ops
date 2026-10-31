#!/usr/bin/env python3
"""計画品 出入り台帳 (plan_ledger.json) を生成する。

目的:
  生産計画を入れている品目(Dフレーム FullASSY・ダンディリフト・レベラー等)について、
  日別に「計画 / 計画分の完成 / 所要量分の実績 / 所要量(確定指示残) / 出(使用・出荷)」を並べ、
  現在庫(全社)からの予定残と安全在庫を比べる。営業・業務の納期回答の根拠に使う。

入力 (data/ = download_shared_masters.py の取得先、item_history は build_item_history.py の出力):
  - data/item_history.json   … 製造実績・使用実績(親機種の完組)・売上・受注残・確定済工程手配
  - data/生産計画出力.csv     … 計画(完了分も含む: 計画数量・完成済数・状態)
  - data/品目マスタ.csv       … 生産計画区分・安全在庫数・大分類・業務納期確認
  - data/有効在庫一覧表.csv   … 現在庫(全社)。品目コードが無いため品目名で突き合わせ

ルール(2026-10 雅さん確認):
  - 対象: 品目マスタで「生産計画区分=行う」かつ使用禁止でない品目のうち、表示期間に計画がある品目
  - グループ: 業務納期確認が「Dﾌﾚｰﾑ FULL ASSY」→ Dフレーム、それ以外は大分類
  - フレームの出: 親機種の受注残 × 使用数 を出荷予定日に計上 / 実績は親機種の完組での使用
  - 完成品の出: 自品目の受注残(出荷予定日) / 実績は売上(出荷)
  - 計画日を過ぎて未完成の計画は「付け替え漏れ」(できない計画は当日中に先へずらすルール)。
    いつ入るか不明なため予定残には含めない
  - 予定残「計画のみ」と「計画+所要量(確定済M製番の残)」の2本
  - 過去日の残は現在庫から実績入出を逆算した参考値

出力: data/plan_ledger.json (業務データのため公開Pagesには置かず、upload_fujin_data.py で SharePoint へ)
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

FRAME_KEY = "ﾌﾚｰﾑ FULL ASSY"  # 品目マスタ「業務納期確認名」
GROUP_ORDER = ["Dフレーム", "ダンディリフト", "レベラー"]


def nk(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def sf(s) -> float:
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def pd(s: str):
    s = (s or "").replace("/", "").replace("-", "").strip()
    if len(s) != 8 or not s.isdigit() or s == "00000000":
        return None
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def read_csv(path: Path):
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        head = f.readline()
        f.seek(0)
        delim = "\t" if head.count("\t") > head.count(",") else ","
        return list(csv.reader(f, delimiter=delim))


def load_master():
    rows = read_csv(DATA / "品目マスタ.csv")
    h = {k: i for i, k in enumerate(rows[0])}
    out = {}
    for r in rows[1:]:
        if len(r) < len(h):
            continue
        g = lambda k: r[h[k]] if k in h else ""
        out[g("品目ｺｰﾄﾞ")] = {
            "name": g("品目名"),
            "big": g("大分類名"),
            "gyomu": g("業務納期確認名"),
            "safety": sf(g("安全在庫数")),
            "plan_flag": g("生産計画区分名"),
            "banned": g("使用禁止日") not in ("", "0"),
        }
    return out


def load_plans():
    rows = read_csv(DATA / "生産計画出力.csv")
    h = {k: i for i, k in enumerate(rows[0])}
    plans = defaultdict(list)
    for r in rows[1:]:
        if len(r) < len(h):
            continue
        d = pd(r[h["生産計画日付"]])
        if not d:
            continue
        plans[r[h["品目ｺｰﾄﾞ"]]].append({
            "date": d, "sb": r[h["製番"]], "q": sf(r[h["生産計画数量"]]),
            "done": sf(r[h["完成済数"]]), "st": r[h["製番状態区分名"]],
        })
    return plans


def load_stock():
    """有効在庫一覧表.csv: 先頭に表題行があり、『品目名』で始まる行が見出し。"""
    rows = read_csv(DATA / "有効在庫一覧表.csv")
    hi = next((i for i, r in enumerate(rows) if r and nk(r[0]) == "品目名"), None)
    if hi is None:
        return {}
    h = {nk(k): i for i, k in enumerate(rows[hi])}
    out = {}
    for r in rows[hi + 1:]:
        if not r or not r[0].strip():
            continue
        g = lambda k: r[h[k]] if k in h and h[k] < len(r) else ""
        out[nk(r[0])] = {"stock": sf(g("現在庫数")), "in": sf(g("入庫予定数")),
                         "out": sf(g("出庫予定数")), "eff": sf(g("有効在庫数"))}
    return out


def short_name(code, name, kind):
    n = nk(name)
    if kind == "frame":
        i = n.find("フレーム")
        s = n[:i].strip(" /") if i > 0 else ""
        return s if 0 < len(s) <= 12 else code
    return code.replace("/SW", " SW")


def main():
    ih = json.loads((DATA / "item_history.json").read_text(encoding="utf-8"))
    items = ih["items"]
    as_of = datetime.strptime(ih["as_of"], "%Y/%m/%d").date()
    master, plans, stock = load_master(), load_plans(), load_stock()
    stock_mtime = ""
    meta_p = DATA / "_stock_mtime.txt"  # download_shared_masters.py が保存(JST)
    if meta_p.exists():
        stock_mtime = meta_p.read_text(encoding="utf-8").strip()[:16]

    start = (as_of.replace(day=1) - timedelta(days=1)).replace(day=1)  # 前月1日
    end_m = (as_of.replace(day=1) + timedelta(days=95)).replace(day=1)  # 3か月先の月初
    end = end_m - timedelta(days=1)
    dates = [start + timedelta(i) for i in range((end - start).days + 1)]

    targets = [c for c, m in master.items()
               if m["plan_flag"] == "行う" and not m["banned"]
               and any(start <= p["date"] <= end for p in plans.get(c, []))]

    out = []
    for code in targets:
        m = master[code]
        kind = "frame" if FRAME_KEY in (m["gyomu"] or "") else "product"
        group = "Dフレーム" if kind == "frame" else (m["big"] or "その他")
        it = items.get(code, {})
        st = stock.get(nk(m["name"]), {})
        cur = st.get("stock", 0.0)
        days = defaultdict(lambda: defaultdict(float))
        lists = defaultdict(lambda: defaultdict(list))

        for p in plans.get(code, []):
            d = p["date"]
            if not (start <= d <= end):
                continue
            days[d]["plan"] += p["q"]
            days[d]["planDone"] += p["done"]
            lists[d]["plan_l"].append({"sb": p["sb"], "q": p["q"], "done": p["done"], "st": p["st"]})
            if p["q"] > p["done"] and d < as_of:
                days[as_of]["planLate"] += p["q"] - p["done"]

        for r in it.get("production", []):
            d = pd(r.get("date"))
            if not d or d < start:
                continue
            k = "actK" if str(r.get("seiban", "")).startswith("K") else "actM"
            q = sf(r.get("reported_qty"))
            days[d][k] += q
            lists[d]["act_l"].append({"sb": r.get("seiban", ""), "q": q, "pd": r.get("planned_date", ""), "k": k[-1]})

        for r in it.get("process_orders_conf", []):
            if str(r.get("seiban", "")).startswith("M") and sf(r.get("remaining_qty")) > 0:
                d = max(pd(r.get("date")) or as_of, as_of)
                days[d]["mrp"] += sf(r.get("remaining_qty"))

        orders, cons = [], []
        if kind == "frame":
            per = {}
            for c in it.get("consumption", []) + it.get("planned_consumption", []):
                if c.get("parent_code"):
                    per[c["parent_code"]] = sf(c.get("qty_per")) or 1.0
            for pc, qp in per.items():
                for o in items.get(pc, {}).get("sales_orders", []):
                    rq = sf(o.get("remaining_qty"))
                    if rq > 0:
                        orders.append({"p": pc, "c": o.get("customer", ""), "no": o.get("order_no", ""), "q": rq,
                                       "per": qp, "f": rq * qp, "ship": o.get("shipment_date") or o.get("due"), "due": o.get("due", "")})
            for c in it.get("consumption", []):
                cons.append({"date": c.get("date"), "p": c.get("parent_code", ""), "q": sf(c.get("qty")), "per": sf(c.get("qty_per")) or 1})
            n_par = len(per)
        else:
            for o in it.get("sales_orders", []):
                rq = sf(o.get("remaining_qty"))
                if rq > 0:
                    orders.append({"p": code, "c": o.get("customer", ""), "no": o.get("order_no", ""), "q": rq,
                                   "per": 1, "f": rq, "ship": o.get("shipment_date") or o.get("due"), "due": o.get("due", "")})
            for s in it.get("sales", []):
                cons.append({"date": s.get("date"), "p": s.get("customer", ""), "q": sf(s.get("qty")), "per": 1})
            n_par = 0

        for c in cons:
            d = pd(c.pop("date"))
            if not d or d < start or d > end:
                continue
            days[d]["cons"] += c["q"]
            lists[d]["cons_l"].append(c)
        for o in orders:
            d0 = pd(o["ship"]) or as_of
            o["late"] = d0 < as_of
            d = max(d0, as_of)
            if d > end:
                continue
            days[d]["ord"] += o["f"]
            lists[d]["ord_l"].append(o)

        # 残: 過去は現在庫から逆算(参考) / 本日以降は予定
        bal = {}
        b = cur
        for d in reversed([x for x in dates if x < as_of]):
            bal[d] = b
            x = days.get(d)
            if x:
                b = b - (x["actK"] + x["actM"]) + x["cons"]
        bp = bm = cur
        for d in [x for x in dates if x >= as_of]:
            x = days.get(d)
            if x:
                pr = sum(p["q"] - p["done"] for p in lists[d]["plan_l"])
                bp += pr - x["ord"]
                bm += pr + x["mrp"] - x["ord"]
            bal[d] = (bp, bm)

        rows = []
        for d in dates:
            if d.weekday() >= 5 and d not in days and d != as_of:
                continue
            r = {"d": d.isoformat()}
            for k, v in days.get(d, {}).items():
                if v:
                    r[k] = round(v, 2)
            for k, v in lists.get(d, {}).items():
                if v:
                    r[k] = v
            if d < as_of:
                r["bal"] = round(bal[d], 2)
            else:
                r["balP"], r["balM"] = round(bal[d][0], 2), round(bal[d][1], 2)
            rows.append(r)

        out.append({
            "code": code, "group": group, "kind": kind,
            "short": short_name(code, m["name"], kind), "name": nk(m["name"]),
            "safety": m["safety"], "stock": cur, "inSched": st.get("in", 0), "outSched": st.get("out", 0),
            "eff": st.get("eff", 0), "stockFound": bool(st), "parents": n_par, "days": rows,
        })

    # 略称の重複(例: SLフレーム/スポット と SLフレーム/裾きり)は「/」以降を付けて区別
    cnt = defaultdict(int)
    for f in out:
        cnt[f["short"]] += 1
    for f in out:
        if cnt[f["short"]] > 1 and "/" in f["name"]:
            f["short"] = f"{f['short']} {f['name'].split('/', 1)[1].strip()}"

    groups = [g for g in GROUP_ORDER if any(f["group"] == g for f in out)]
    groups += sorted({f["group"] for f in out} - set(groups))
    out.sort(key=lambda f: (groups.index(f["group"]), f["code"]))
    payload = {"asOf": as_of.isoformat(), "stockAsOf": stock_mtime, "groups": groups, "frames": out}
    DATA.mkdir(exist_ok=True)
    p = DATA / "plan_ledger.json"
    p.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[出力] {p} ({p.stat().st_size:,} bytes) 品目 {len(out)} / グループ {groups}")
    miss = [f["code"] for f in out if not f["stockFound"]]
    if miss:
        print(f"[WARN] 有効在庫一覧表に品目名が見つからず現在庫0扱い: {miss}")


if __name__ == "__main__":
    main()
