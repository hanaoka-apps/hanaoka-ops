"""月次決算PDFとClaude引継ぎの品目分析を非公開データへ変換する。

数値は data/ 配下の生成JSONにだけ保存し、公開HTMLへは埋め込まない。
PDFの在庫行は決算表上の控除表記（負数）のため、在庫絶対額として正数化する。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
ZONE_LABELS = {
    "第一工場": "第一工場",
    "第二工場": "第二工場",
    "第三工場": "第三工場",
    "購買(第一・第三)": "購買",
}


def numbers(line: str) -> list[int]:
    return [int(value.replace(",", "")) for value in re.findall(r"(?<![\w.])-?\d[\d,]*", line)]


def extract_lines(path: Path) -> list[str]:
    import pdfplumber

    with pdfplumber.open(path) as document:
        return [line.strip() for page in document.pages for line in (page.extract_text(x_tolerance=1, y_tolerance=2) or "").splitlines()]


def parse_pdf(path: Path, fiscal_year: int) -> dict:
    lines = extract_lines(path)
    month_header = next((line for line in lines if "4月実績" in line and "3月実績" in line), None)
    if not month_header:
        raise ValueError(f"月見出しを確認できません: {path.name}")
    total_sales = numbers(next(line for line in lines if line.startswith("売上 ")))
    total_purchase = numbers(next(line for line in lines if line.startswith("仕入TOTAL ")))
    domestic_sales = numbers(next(line for line in lines if line.startswith("国内営業 ")))
    solution_sales = numbers(next(line for line in lines if line.startswith("ソリューション営業")))
    active_count = next((i for i, value in enumerate(total_sales[:12]) if i > 0 and value == 0), 12)
    if total_sales[0] == 0:
        raise ValueError(f"4月売上が0のため確定月を判定できません: {path.name}")

    zone_sales: dict[str, list[int]] = {}
    zone_purchase: dict[str, list[int]] = {}
    for index, line in enumerate(lines):
        label = next((source for source in ZONE_LABELS if line.startswith(f"■{source}")), None)
        if not label:
            continue
        zone = ZONE_LABELS[label]
        if label == "購買(第一・第三)":
            pass
        purchase_line = next((candidate for candidate in lines[index + 1:index + 4] if candidate.startswith("仕入金額 ")), None)
        sales_line = next((candidate for candidate in lines[index + 1:index + 4] if candidate.startswith("売上金額 ")), None)
        if purchase_line and sales_line:
            zone_purchase[zone] = numbers(purchase_line)[:active_count]
            zone_sales[zone] = numbers(sales_line)[:active_count]
    freight = next((line for line in lines if line.startswith("■運賃 売上金額 ")), None)
    if freight:
        zone_sales["運賃"] = numbers(freight)[:active_count]
        zone_purchase["運賃"] = [0] * active_count

    inventory_start = next(i for i, line in enumerate(lines) if line.startswith("期首在庫 "))
    inventory_lines = lines[inventory_start:]
    zone_inventory: dict[str, list[int]] = {}
    for source, zone in ZONE_LABELS.items():
        line = next(line for line in inventory_lines if line.startswith(f"{source} "))
        zone_inventory[zone] = [abs(value) for value in numbers(line)[:active_count + 1]]
    factory_total = [abs(value) for value in numbers(next(line for line in inventory_lines if line.startswith("工場TOTAL ")))[:active_count + 1]]

    monthly: dict[str, dict] = {}
    for offset in range(active_count):
        calendar_month = 4 + offset
        year = fiscal_year + (calendar_month > 12)
        month = calendar_month if calendar_month <= 12 else calendar_month - 12
        ym = f"{year}{month:02d}"
        zones: dict[str, dict] = {}
        for zone in ["第一工場", "第二工場", "第三工場", "購買", "運賃"]:
            inventory = zone_inventory.get(zone)
            previous = inventory[offset] if inventory else 0
            current = inventory[offset + 1] if inventory else 0
            zones[zone] = {
                "sales": zone_sales.get(zone, [None] * active_count)[offset],
                "purchase": zone_purchase.get(zone, [None] * active_count)[offset],
                "previous_inventory": previous,
                "current_inventory": current,
                "inventory_change": current - previous,
            }
        previous_total, current_total = factory_total[offset:offset + 2]
        monthly[ym] = {
            "sales_departments": {
                "国内営業": domestic_sales[offset],
                "ソリューション営業": solution_sales[offset],
            },
            "total": {
                "sales": total_sales[offset],
                "purchase": total_purchase[offset],
                "previous_inventory": previous_total,
                "current_inventory": current_total,
                "inventory_change": current_total - previous_total,
            },
            "zones": zones,
        }
    return {"months": monthly, "finalized_months": list(monthly), "source_file": path.name}


def normalize_items(path: Path) -> dict:
    source = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(source.get("im"), dict) or not isinstance(source.get("rows"), list):
        raise ValueError(f"品目分析の形式が正しくありません: {path.name}")
    return {
        "basis": "standard_cost",
        "notice": "品目別付加価値は売上−標準原価×数量の参考分析です。実際の仕入・在庫増減による全社付加価値とは一致しません。",
        "months": source.get("yms", source.get("months", [])),
        "items": source["im"],
        "rows": source["rows"],
    }


def parse_standard_costs(path: Path) -> tuple[str, dict[str, dict]]:
    """品目別積上原価一覧表を月次標準原価履歴へ変換する。"""
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        rows = csv.reader(handle)
        title = next(rows, [])
        target = next(rows, [])
        headers = next(rows, [])
        if not title or "品目別積上原価一覧表" not in title[0]:
            raise ValueError(f"積上原価一覧表のタイトルを確認できません: {path.name}")
        target_text = target[0] if target else ""
        match = re.search(r"(\d{4})年\s*(\d{1,2})月", target_text)
        if not match:
            raise ValueError(f"積上原価一覧表の対象年月を確認できません: {path.name}")
        ym = f"{int(match.group(1)):04d}{int(match.group(2)):02d}"
        if len(headers) < 16 or headers[0] != "コード" or headers[15] != "積上原価計":
            raise ValueError(f"積上原価一覧表の列構成が想定と異なります: {path.name}")
        costs: dict[str, dict] = {}
        for row in rows:
            if len(row) < 16:
                continue
            code = row[0].strip()
            if not code:
                continue
            values = [number.replace(",", "").strip() for number in row]

            def numeric(index: int) -> float:
                try:
                    return float(values[index] or 0)
                except ValueError:
                    return 0

            costs[code] = {
                "name": row[1].strip(),
                "department_code": row[2].strip(),
                "department_name": row[3].strip(),
                "inventory_unit_cost": numeric(4),
                "variation_rate": numeric(5),
                "material": numeric(11),
                "labor": numeric(12),
                "outsourcing": numeric(13),
                "expense": numeric(14),
                "total": numeric(15),
                "error": row[16].strip() if len(row) > 16 else "",
                "source": path.name,
            }
    return ym, costs


def merge_standard_costs(path: Path) -> tuple[str, int, int]:
    """既存の品目別売上データへ月次積上原価を安全に追加する。"""
    destination = DATA / "value_analysis_items.json"
    if not destination.is_file():
        raise FileNotFoundError(f"先に品目別売上データを生成してください: {destination.name}")
    items = json.loads(destination.read_text(encoding="utf-8"))
    ym, costs = parse_standard_costs(path)
    items.setdefault("standard_cost_history", {})[ym] = costs
    if ym not in items.setdefault("months", []):
        items["months"].append(ym)
        items["months"].sort()

    previous_ym = f"{int(ym[:4]) - (ym[4:] == '01')}{12 if ym[4:] == '01' else int(ym[4:]) - 1:02d}"
    previous_costs = items.get("standard_cost_history", {}).get(previous_ym, {})
    updated = 0
    missing = 0
    for row in items.get("rows", []):
        if row.get("y") != ym:
            continue
        code = row.get("i", "")
        current = costs.get(code)
        if current is None:
            continue
        total = current["total"]
        previous = previous_costs.get(code, {}).get("total")
        row["st"] = total
        row["mt"] = current["material"]
        row["ot"] = current["labor"] + current["outsourcing"] + current["expense"]
        row["previous_standard_cost"] = previous
        sales, quantity = row.get("a"), row.get("q")
        if total > 0 and sales is not None and quantity is not None:
            row["va"] = round(sales - total * quantity)
            row["vr"] = round(row["va"] / sales * 100, 1) if sales else None
        else:
            row["va"] = None
            row["vr"] = None
            missing += 1
        updated += 1
    items["standard_cost_history_status"] = (
        f"{ym[:4]}年{int(ym[4:])}月の品目別積上原価一覧表を反映済みです。"
        "前月値は保存済みの月次積上原価表がある品目だけを表示します。"
    )
    destination.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return ym, updated, missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", action="append", default=[], metavar="FISCAL_YEAR=PATH")
    parser.add_argument("--item-source", type=Path)
    parser.add_argument("--cost-source", action="append", default=[], type=Path)
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    overlay = {"schema_version": 1, "finalized_months": [], "monthly": {}, "sources": []}
    for value in args.pdf:
        year_text, separator, path_text = value.partition("=")
        if not separator:
            raise ValueError("--pdf は FISCAL_YEAR=PATH 形式で指定してください")
        parsed = parse_pdf(Path(path_text), int(year_text))
        overlay["monthly"].update(parsed["months"])
        overlay["finalized_months"].extend(parsed["finalized_months"])
        overlay["sources"].append(parsed["source_file"])
    if args.pdf:
        destination = DATA / "value_analysis_financial_overlay.json"
        destination.write_text(json.dumps(overlay, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"[OK] {destination.name}: {len(overlay['monthly'])}か月")
    if args.item_source:
        items = normalize_items(args.item_source)
        destination = DATA / "value_analysis_items.json"
        destination.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"[OK] {destination.name}: {len(items['items'])}品目 / {len(items['rows'])}月次行")
    for cost_source in args.cost_source:
        ym, updated, missing = merge_standard_costs(cost_source)
        print(f"[OK] {cost_source.name}: {ym} / 売上{updated}品目へ反映 / 原価未設定{missing}品目")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
