"""dashboard_facts.json の売上明細を付加価値分析JSONへ反映する。

SharePointから取得済みの data/dashboard_facts.json と
data/value_analysis.json だけを読み、元データは変更しない。
同じ年月の品目別行を毎回置換するため、日次実行で二重加算しない。
サマリーの売上もSharedMastersを正として毎回置換し、月次資料に依存しない。
"""

from __future__ import annotations

import csv
import json
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
FACTS = DATA / "dashboard_facts.json"
DESTINATION = DATA / "value_analysis.json"
ZONES = ["第一工場", "第二工場", "第三工場", "購買", "運賃"]

IDX = {
    "ym": 0, "cust_abbr": 3, "voucher_date": 7, "bumon": 12,
    # dashboard_facts の15列目は元帳票の「売上営業/ｿﾘｭ名」。
    # 部門名（12列目）ではなくこちらを営業別売上の正とする。
    "sales_division": 15,
    "dai_bunrui": 16, "chu_bunrui": 17, "item_cd": 18,
    "item_nm": 19, "qty": 20, "amount": 21, "unit_price": 22,
    "kind": 23,
}


def normalize_code(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().upper()


def number(value: object) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value or "").replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def value(row: list, name: str, default=None):
    index = IDX[name]
    return row[index] if len(row) > index else default


def rate(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return round(numerator / denominator * 100, 1)


def recalculate(summary: dict) -> None:
    sales, purchase = summary.get("sales"), summary.get("purchase")
    current, previous = summary.get("current_inventory"), summary.get("previous_inventory")
    if current is not None and previous is not None:
        summary["inventory_change"] = current - previous
    change = summary.get("inventory_change")
    if sales is not None and purchase is not None and change is not None:
        summary["value_added"] = sales - purchase + change
    summary["value_added_rate"] = rate(summary.get("value_added"), sales)
    summary["purchase_rate"] = rate(purchase, sales)
    summary["inventory_contribution_rate"] = rate(change, sales)


def blank_summary() -> dict:
    return {
        "sales": None, "purchase": None, "current_inventory": None,
        "previous_inventory": None, "inventory_change": None,
        "value_added": None, "value_added_rate": None,
        "purchase_rate": None, "inventory_contribution_rate": None,
    }


def read_item_master() -> dict[str, dict]:
    path = next((candidate for candidate in (DATA / "品目マスタ.txt", DATA / "品目マスタ.csv") if candidate.is_file()), None)
    if path is None:
        return {}
    result: dict[str, dict] = {}
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        first = handle.readline()
        delimiter = "\t" if first.count("\t") > first.count(",") else ","
        handle.seek(0)
        for row in csv.DictReader(handle, delimiter=delimiter):
            code = normalize_code(row.get("品目ｺｰﾄﾞ"))
            if not code or code.startswith("<"):
                continue
            result[code] = {
                "dc": (row.get("大分類ｺｰﾄﾞ") or "").strip(),
                "d": (row.get("大分類名") or "").strip(),
                "cc": (row.get("中分類ｺｰﾄﾞ") or "").strip(),
                "c": (row.get("中分類名") or "").strip(),
                "sc": (row.get("小分類ｺｰﾄﾞ") or "").strip(),
                "s": (row.get("小分類名") or "").strip(),
                # SharedMasters の出力形式差に対応する。画面上の
                # 「分類 > 工場別付加価値」は、旧出力では工場別付加価名。
                "factory": (row.get("工場別付加価名") or row.get("工場別付加価値") or "").strip(),
            }
    return result


def zone_for(row: list, master: dict) -> str:
    dai = str(value(row, "dai_bunrui", "") or "")
    chu = str(value(row, "chu_bunrui", "") or "")
    factory = str(master.get("factory") or "")
    combined = f"{dai} {chu} {factory}"
    if "運賃" in combined or dai.startswith("運賃・クレーム他") or dai.startswith("ｿﾘｭ運賃・他GSE"):
        return "運賃"
    if dai == "輸入仕入" or factory.startswith("購買"):
        return "購買"
    for zone in ("第一工場", "第二工場", "第三工場"):
        if zone in factory:
            return zone
    return "第三工場"


def main() -> int:
    if not FACTS.is_file() or not DESTINATION.is_file():
        print("[WARN] dashboard_facts.json または value_analysis.json が無いため売上反映をスキップ")
        return 0
    facts = json.loads(FACTS.read_text(encoding="utf-8-sig"))
    output = json.loads(DESTINATION.read_text(encoding="utf-8-sig"))
    rows = facts.get("rows", []) if isinstance(facts, dict) else []
    analysis = output.get("item_analysis")
    if not isinstance(analysis, dict) or not isinstance(rows, list):
        raise ValueError("売上または付加価値分析JSONの形式が正しくありません")

    master = read_item_master()
    existing_keys = {normalize_code(code): code for code in analysis.get("items", {})}
    history = analysis.get("standard_cost_history", {})
    grouped: dict[tuple[str, str], dict] = {}
    zone_sales: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    department_sales: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    excluded = {"returns": 0, "tax": 0, "internal_zero": 0}

    for fact in rows:
        if not isinstance(fact, list):
            continue
        ym = "".join(character for character in str(value(fact, "ym", "")) if character.isdigit())[:6]
        code_normalized = normalize_code(value(fact, "item_cd", ""))
        name = str(value(fact, "item_nm", "") or "").strip()
        quantity = number(value(fact, "qty"))
        amount = number(value(fact, "amount"))
        unit_price = number(value(fact, "unit_price"))
        if int(number(value(fact, "kind"))) == 2:
            excluded["returns"] += 1
            continue
        if "消費税" in name:
            excluded["tax"] += 1
            continue
        if unit_price == 0 and quantity == 0:
            excluded["internal_zero"] += 1
            continue
        if len(ym) != 6 or not code_normalized:
            continue

        code = existing_keys.get(code_normalized, code_normalized)
        master_row = master.get(code_normalized, {})
        zone = zone_for(fact, master_row)
        sales_division = str(value(fact, "sales_division", "") or "").strip()
        # 既存のdashboard_facts（旧配列）にも対応するため、売上営業/ソリューション
        # 列が空のときだけ部門名へフォールバックする。
        department_source = sales_division or str(value(fact, "bumon", "") or "").strip()
        department = {
            "国内営業部": "国内営業",
            "国内営業": "国内営業",
            "ソリューション営業部": "ソリューション営業",
            "ｿﾘｭｰｼｮﾝ営業部": "ソリューション営業",
            "ソリューション営業": "ソリューション営業",
        }.get(department_source, "未分類")
        zone_sales[ym][zone] += amount
        department_sales[ym][department] += amount
        current = grouped.setdefault((ym, code), {
            "q": 0.0, "a": 0.0, "prices": [], "customers": defaultdict(float),
            "dates": [], "count": 0, "name": name, "zone": zone,
            "d": str(value(fact, "dai_bunrui", "") or "").strip(),
            "c": str(value(fact, "chu_bunrui", "") or "").strip(),
        })
        current["q"] += quantity
        current["a"] += amount
        if unit_price:
            current["prices"].append(unit_price)
        customer = str(value(fact, "cust_abbr", "") or "").strip()
        if customer:
            current["customers"][customer] += amount
        date = "".join(character for character in str(value(fact, "voucher_date", "")) if character.isdigit())[:8]
        if date:
            current["dates"].append(date)
        current["count"] += 1

    source_months = sorted({ym for ym, _ in grouped})
    if not source_months:
        print("[WARN] 反映対象の売上行がありません")
        return 0

    items = analysis.setdefault("items", {})
    generated = []
    for (ym, code), current in grouped.items():
        normalized = normalize_code(code)
        item = items.setdefault(code, {})
        master_row = master.get(normalized, {})
        item.update({
            "n": current["name"] or item.get("n") or code,
            "d": master_row.get("d") or current["d"] or item.get("d", ""),
            "c": master_row.get("c") or current["c"] or item.get("c", ""),
            "s": master_row.get("s") or item.get("s", ""),
            "k": current["zone"],
            "dc": master_row.get("dc") or item.get("dc", ""),
            "cc": master_row.get("cc") or item.get("cc", ""),
            "sc": master_row.get("sc") or item.get("sc", ""),
        })
        # 品目に残る最新原価を過去月へ流用しない。当月の原価履歴がある場合だけ算定する。
        cost = history.get(ym, {}).get(normalized) or history.get(ym, {}).get(code)
        standard_cost = number(cost.get("total")) if cost else None
        if standard_cost:
            item["st"] = standard_cost
            item["mt"] = number(cost.get("material"))
            item["ot"] = max(0, standard_cost - item["mt"])
        sales = round(current["a"])
        quantity = current["q"]
        cost_sum = round(standard_cost * quantity) if standard_cost else None
        value_added = sales - cost_sum if cost_sum is not None else None
        detail = {
            "y": ym, "i": code, "q": quantity, "a": sales,
            "cs": cost_sum, "g": value_added,
            "av": round(sales / quantity) if quantity else 0,
            "mn": round(min(current["prices"])) if current["prices"] else None,
            "mx": round(max(current["prices"])) if current["prices"] else None,
            "mc": max(current["customers"], key=current["customers"].get) if current["customers"] else "",
            "md": min(current["dates"]) if current["dates"] else "",
            "ct": current["count"], "k": current["zone"],
        }
        if value_added is not None:
            detail.update({"va": value_added, "vr": rate(value_added, sales), "gr": rate(value_added, sales)})
        generated.append(detail)

    analysis["rows"] = [row for row in analysis.get("rows", []) if row.get("y") not in source_months] + generated
    analysis["months"] = sorted(set(analysis.get("months", [])) | set(source_months))
    for ym in source_months:
        month = output.setdefault("monthly", {}).setdefault(
            ym, {"zones": {zone: blank_summary() for zone in ZONES}, "total": blank_summary()}
        )
        for zone in ZONES:
            zone_row = month.setdefault("zones", {}).setdefault(zone, blank_summary())
            zone_row["sales"] = round(zone_sales[ym].get(zone, 0))
            recalculate(zone_row)
        month.setdefault("total", blank_summary())["sales"] = round(sum(zone_sales[ym].values()))
        recalculate(month["total"])
        if ym not in set(output.get("finalized_months", [])):
            output.setdefault("month_status", {}).setdefault(ym, {}).update({"state": "collecting", "is_finalized": False})
        output.setdefault("sales_departments_by_month", {})[ym] = {
            department: round(amount) for department, amount in department_sales[ym].items()
        }

    output["months"] = sorted(set(output.get("months", [])) | set(source_months))
    jst = timezone(timedelta(hours=9))
    output.setdefault("meta", {}).update({
        "daily_sales_source": FACTS.name,
        "daily_sales_updated_at": datetime.now(jst).strftime("%Y-%m-%d %H:%M JST"),
        "daily_sales_rows": len(rows),
        "daily_sales_excluded": excluded,
    })
    DESTINATION.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[OK] 売上を反映: {len(source_months)}か月 / {len(generated)}品目月 / 除外{excluded}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
