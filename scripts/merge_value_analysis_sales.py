"""dashboard_facts.json の売上明細を付加価値分析JSONへ反映する。

SharePointから取得済みの data/dashboard_facts.json と
data/value_analysis.json だけを読み、元データは変更しない。
同じ年月の品目別行を毎回置換するため、日次実行で二重加算しない。
サマリーの売上もSharedMastersを正として毎回置換し、月次資料に依存しない。
"""

from __future__ import annotations

import csv
import json
import statistics
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
    # regenerate_facts.py が既存の配列末尾へ追加する売上明細の復元情報。
    # 旧 dashboard_facts.json でも安全に空値になる（value() が範囲外を返す）。
    "sales_no": 27, "remark1": 28, "remark2": 29, "order_no": 30,
    "order_line": 31, "return_type": 32, "source_index": 33,
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


def text(value: object) -> str:
    return str(value or "").strip()


def master_value(row: dict, *headers: str) -> str:
    """品目マスタの列名差（全半角・表記差）を吸収して値を取得する。"""
    normalized = {
        unicodedata.normalize("NFKC", text(key)).replace(" ", ""): value
        for key, value in row.items() if key
    }
    for header in headers:
        value = normalized.get(unicodedata.normalize("NFKC", header).replace(" ", ""))
        if text(value):
            return text(value)
    return ""


def date_digits(value: object) -> str:
    return "".join(character for character in text(value) if character.isdigit())[:8]


def stable_detail_key(unit_price: float, date: str, sales_no: str, source_index: int) -> tuple:
    """最低単価が同額のときも、日付→売上№→元CSV行順で一意に決める。"""
    return (unit_price, date or "99999999", sales_no, source_index)


def stable_main_name_key(amount: float, date: str, sales_no: str, source_index: int) -> tuple:
    """主要伝票名は最大売上額、同額時は日付→売上№→元CSV行順で決める。"""
    return (-amount, date or "99999999", sales_no, source_index)


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
            code = normalize_code(master_value(row, "品目コード", "品目CD"))
            if not code or code.startswith("<"):
                continue
            result[code] = {
                "dc": master_value(row, "大分類コード"),
                "d": master_value(row, "大分類名"),
                "cc": master_value(row, "中分類コード"),
                "c": master_value(row, "中分類名"),
                "sc": master_value(row, "小分類コード"),
                "s": master_value(row, "小分類名"),
                "n": master_value(row, "品目名", "品名", "品目名称"),
                # SharedMasters の出力形式差に対応する。画面上の
                # 「分類 > 工場別付加価値」は、旧出力では工場別付加価名。
                "factory": master_value(row, "工場別付加価名", "工場別付加価値"),
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


def read_csv_records(path: Path, required: tuple[str, ...]) -> tuple[list[dict], list[str]]:
    """CSV/TSVを読み、必要列が無いときは行を推測せず理由だけを返す。"""
    if not path.is_file():
        return [], [f"{path.name} が未取得"]
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        first = handle.readline()
        delimiter = "\t" if first.count("\t") > first.count(",") else ","
        handle.seek(0)
        reader = csv.DictReader(handle, delimiter=delimiter)
        headers = [text(header).lstrip("\ufeff") for header in (reader.fieldnames or [])]
        missing = [column for column in required if column not in headers]
        if missing:
            return [], [f"{path.name} に必要列がありません: {'、'.join(missing)}"]
        return list(reader), []


def parse_calendar_date(value: object):
    digits = date_digits(value)
    if len(digits) != 8:
        return None
    try:
        return datetime.strptime(digits, "%Y%m%d").date()
    except ValueError:
        return None


def calculate_lead_time() -> dict:
    """品目手順マスタと受注/売上明細から、厳密に一意な実績LTだけを集計する。

    出荷実績日は売上明細の伝票日付を使う。受注行は売上側だけにあり、受注明細に
    同じ明細番号列がないため、受注№+品目コードの組が双方で一意な場合だけ結合する。
    """
    sales_required = ("伝票日付", "受注№", "品目ｺｰﾄﾞ", "明細区分", "返品区分")
    order_required = ("受注日付", "受注№", "品目ｺｰﾄﾞ", "完納区分名")
    route_required = ("品目ｺｰﾄﾞ", "工程ﾘｰﾄﾞﾀｲﾑ", "検査ﾘｰﾄﾞﾀｲﾑ")
    sales, sales_errors = read_csv_records(DATA / "売上明細出力.csv", sales_required)
    orders, order_errors = read_csv_records(DATA / "受注明細出力.csv", order_required)
    routes, route_errors = read_csv_records(DATA / "品目手順マスタ.csv", route_required)
    required_columns = {
        "売上明細出力.csv": list(sales_required),
        "受注明細出力.csv": list(order_required),
        "品目手順マスタ.csv": list(route_required),
    }
    base = {
        "status": "unavailable",
        "formula": "標準LT＝品目手順マスタの全工程（工程リードタイム＋検査リードタイム）の合計。実績LT＝売上明細の伝票日付−受注明細の受注日付（暦日）。差＝実績LT−標準LT。",
        "shipment_date_basis": "出荷実績日は売上明細の伝票日付を使用",
        "join_rule": "受注№＋品目コードが、受注・売上の双方で各1行だけ存在する場合に限り結合（曖昧な推測結合はしない）。",
        "required_columns": required_columns,
        "excluded": defaultdict(int),
        "months": {},
    }
    errors = sales_errors + order_errors + route_errors
    if errors:
        base["reason"] = "；".join(errors)
        base["excluded"] = dict(base["excluded"])
        return base

    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")
    standard_by_code: dict[str, float] = defaultdict(float)
    for route in routes:
        code = normalize_code(route.get("品目ｺｰﾄﾞ"))
        expiry = date_digits(route.get("失効日"))
        if not code:
            base["excluded"]["standard_missing_item_code"] += 1
            continue
        if expiry and expiry != "99999999" and expiry <= today:
            base["excluded"]["standard_expired_route"] += 1
            continue
        standard_by_code[code] += number(route.get("工程ﾘｰﾄﾞﾀｲﾑ")) + number(route.get("検査ﾘｰﾄﾞﾀｲﾑ"))

    order_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in orders:
        order_no, code = text(row.get("受注№")), normalize_code(row.get("品目ｺｰﾄﾞ"))
        if not order_no or not code:
            base["excluded"]["order_missing_join_key"] += 1
            continue
        if any(word in text(row.get("完納区分名")) for word in ("取消", "キャンセル")):
            base["excluded"]["order_cancelled"] += 1
            continue
        if parse_calendar_date(row.get("受注日付")) is None:
            base["excluded"]["order_missing_date"] += 1
            continue
        order_groups[(order_no, code)].append(row)

    sales_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in sales:
        # 0=通常。消費税等の非売上明細はLT母数にしない。
        if text(row.get("明細区分")) != "0":
            base["excluded"]["sales_non_sales_detail"] += 1
            continue
        if text(row.get("返品区分")) not in ("", "0"):
            base["excluded"]["sales_return"] += 1
            continue
        order_no, code = text(row.get("受注№")), normalize_code(row.get("品目ｺｰﾄﾞ"))
        if not order_no or not code:
            base["excluded"]["sales_missing_join_key"] += 1
            continue
        if parse_calendar_date(row.get("伝票日付")) is None:
            base["excluded"]["sales_missing_date"] += 1
            continue
        sales_groups[(order_no, code)].append(row)

    actual_by_month: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for key, sales_lines in sales_groups.items():
        order_lines = order_groups.get(key, [])
        if len(sales_lines) != 1 or len(order_lines) != 1:
            base["excluded"]["join_not_unique_or_missing"] += len(sales_lines)
            continue
        standard = standard_by_code.get(key[1])
        if standard is None:
            base["excluded"]["standard_lt_missing"] += 1
            continue
        sale_date = parse_calendar_date(sales_lines[0].get("伝票日付"))
        order_date = parse_calendar_date(order_lines[0].get("受注日付"))
        actual = (sale_date - order_date).days
        if actual < 0:
            base["excluded"]["negative_actual_lt"] += 1
            continue
        actual_by_month[sale_date.strftime("%Y%m")].append((actual, standard))

    for ym, values in actual_by_month.items():
        actuals = [actual for actual, _ in values]
        standards = [standard for _, standard in values]
        differences = [actual - standard for actual, standard in values]
        base["months"][ym] = {
            "count": len(values),
            "actual_average": round(statistics.mean(actuals), 1),
            "actual_median": round(statistics.median(actuals), 1),
            "actual_min": min(actuals),
            "actual_max": max(actuals),
            "standard_average": round(statistics.mean(standards), 1),
            "difference_average": round(statistics.mean(differences), 1),
        }
    base["status"] = "available" if base["months"] else "unavailable"
    if not base["months"]:
        base["reason"] = "厳密な結合条件を満たす受注・売上明細がありません。結合キー、取消・返品、日付、品目手順マスタの取得状況を確認してください。"
    base["excluded"] = dict(base["excluded"])
    return base


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

    for row_ordinal, fact in enumerate(rows):
        if not isinstance(fact, list):
            continue
        ym = "".join(character for character in str(value(fact, "ym", "")) if character.isdigit())[:6]
        code_normalized = normalize_code(value(fact, "item_cd", ""))
        name = text(value(fact, "item_nm", ""))
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
            "dates": [], "count": 0, "name": name, "zone": zone, "names": set(),
            "main_name": None, "lowest": None,
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
        date = date_digits(value(fact, "voucher_date", ""))
        if date:
            current["dates"].append(date)
        current["count"] += 1
        if name:
            current["names"].add(name)
            main_candidate = {
                "name": name, "amount": amount, "date": date,
                "sales_no": text(value(fact, "sales_no", "")),
                "source_index": int(number(value(fact, "source_index", row_ordinal)) or row_ordinal),
            }
            if current["main_name"] is None or stable_main_name_key(
                main_candidate["amount"], main_candidate["date"], main_candidate["sales_no"], main_candidate["source_index"]
            ) < stable_main_name_key(
                current["main_name"]["amount"], current["main_name"]["date"], current["main_name"]["sales_no"], current["main_name"]["source_index"]
            ):
                current["main_name"] = main_candidate
        # 最低売価と伝票情報は、この明細1行の値をひとまとまりで保持する。
        # 正値の単価だけを候補とし、同額は日付→売上№→CSV行順で安定決定する。
        if unit_price > 0:
            lowest_candidate = {
                "unit_price": unit_price, "customer": customer, "date": date,
                "sales_no": text(value(fact, "sales_no", "")), "quantity": quantity,
                "amount": amount, "item_name": name,
                "remark1": text(value(fact, "remark1", "")),
                "remark2": text(value(fact, "remark2", "")),
                "source_index": int(number(value(fact, "source_index", row_ordinal)) or row_ordinal),
            }
            if current["lowest"] is None or stable_detail_key(
                lowest_candidate["unit_price"], lowest_candidate["date"], lowest_candidate["sales_no"], lowest_candidate["source_index"]
            ) < stable_detail_key(
                current["lowest"]["unit_price"], current["lowest"]["date"], current["lowest"]["sales_no"], current["lowest"]["source_index"]
            ):
                current["lowest"] = lowest_candidate

    source_months = sorted({ym for ym, _ in grouped})
    if not source_months:
        print("[WARN] 反映対象の売上行がありません")
        return 0

    items = analysis.setdefault("items", {})
    generated = []
    lowest_sales = {
        key: row for key, row in (analysis.get("lowest_sales") or {}).items()
        if key.split(":", 1)[0] not in source_months
    }
    for (ym, code), current in grouped.items():
        normalized = normalize_code(code)
        item = items.setdefault(code, {})
        master_row = master.get(normalized, {})
        main = current["main_name"] or {}
        primary_voucher_name = main.get("name") or current["name"] or item.get("n") or code
        voucher_display_name = primary_voucher_name + ("＋他" if len(current["names"]) > 1 else "")
        item.update({
            # 品目マスタ名と伝票名を別項目で保持する。画面の上段は必ずこちらを使う。
            "master_name": master_row.get("n") or item.get("master_name") or "",
            # 既存の画面・データ利用者との互換用。正式名がある場合は同じ値を入れる。
            "n": master_row.get("n") or item.get("n") or current["name"] or code,
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
            # 下段は当月・同一品目の最大売上明細の伝票品目名。
            "pv": primary_voucher_name, "pn": voucher_display_name,
        }
        if value_added is not None:
            detail.update({"va": value_added, "vr": rate(value_added, sales), "gr": rate(value_added, sales)})
        generated.append(detail)
        if current["lowest"] is not None:
            lowest_sales[f"{ym}:{code}"] = current["lowest"]

    analysis["rows"] = [row for row in analysis.get("rows", []) if row.get("y") not in source_months] + generated
    analysis["months"] = sorted(set(analysis.get("months", [])) | set(source_months))
    analysis["lowest_sales"] = lowest_sales
    analysis["lead_time"] = calculate_lead_time()
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
        # これは付加価値分析JSONを最後に再生成した時刻。初期作成時の値を
        # 残したままにすると、日次更新済みでも画面が古い日付に見えてしまう。
        "generated_at": datetime.now(jst).isoformat(timespec="seconds"),
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
