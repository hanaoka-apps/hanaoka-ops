"""SharedMastersの受入明細から月次仕入を付加価値分析JSONへ反映する。

経費などを仕入へ混入させないため、区分列を確認でき、かつ値が厳密に
「仕入」の行だけを集計する。区分列が見つからない場合は既存値を変更しない。
元CSVは読み取り専用で扱い、同じ年月は毎回置換して二重加算を防ぐ。
"""

from __future__ import annotations

import argparse
import csv
import json
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
DEFAULT_SOURCE = DATA / "受入明細出力.csv"
DEFAULT_DESTINATION = DATA / "value_analysis.json"
ZONES = ["第一工場", "第二工場", "第三工場", "購買", "運賃"]

DATE_COLUMNS = ("伝票日付", "仕入日付", "受入日", "年月度")
AMOUNT_COLUMNS = ("仕入金額", "受入金額", "金額")
CATEGORY_COLUMNS = (
    "仕入伝票区分名",
    "仕入区分名",
    "伝票区分名",
    "取引区分属性名",
    "区分名",
    "区分",
)
ZONE_COLUMNS = ("工場別付加価名", "部門名", "倉庫名")


def normalized(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def number(value: object) -> float | None:
    text = normalized(value).replace(",", "").replace("円", "").replace("¥", "")
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    try:
        parsed = float(text)
    except ValueError:
        return None
    return -parsed if negative else parsed


def first_column(headers: list[str], candidates: tuple[str, ...]) -> str | None:
    normalized_headers = {normalized(header): header for header in headers}
    return next((normalized_headers[name] for name in candidates if name in normalized_headers), None)


def month_key(value: object) -> str | None:
    digits = "".join(character for character in normalized(value) if character.isdigit())
    return digits[:6] if len(digits) >= 6 else None


def purchase_zone(row: dict[str, str], zone_column: str | None) -> str | None:
    text = normalized(row.get(zone_column)) if zone_column else ""
    for zone in ZONES:
        if zone in text:
            return zone
    if "第一" in text:
        return "第一工場"
    if "第二" in text:
        return "第二工場"
    if "第三" in text:
        return "第三工場"
    return None


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
    summary["value_added"] = (
        sales - purchase + change
        if sales is not None and purchase is not None and change is not None
        else None
    )
    summary["value_added_rate"] = rate(summary.get("value_added"), sales)
    summary["purchase_rate"] = rate(purchase, sales)
    summary["inventory_contribution_rate"] = rate(change, sales)


def blank_summary() -> dict:
    return {
        "sales": None,
        "purchase": None,
        "current_inventory": None,
        "previous_inventory": None,
        "inventory_change": None,
        "value_added": None,
        "value_added_rate": None,
        "purchase_rate": None,
        "inventory_contribution_rate": None,
    }


def read_purchases(source: Path) -> tuple[dict[str, int], dict[str, dict[str, int]], dict]:
    with source.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        first = handle.readline()
        delimiter = "\t" if first.count("\t") > first.count(",") else ","
        handle.seek(0)
        reader = csv.DictReader(handle, delimiter=delimiter)
        headers = list(reader.fieldnames or [])
        date_column = first_column(headers, DATE_COLUMNS)
        amount_column = first_column(headers, AMOUNT_COLUMNS)
        category_column = first_column(headers, CATEGORY_COLUMNS)
        zone_column = first_column(headers, ZONE_COLUMNS)
        missing = [
            label
            for label, column in (
                ("日付", date_column),
                ("金額", amount_column),
                ("仕入伝票の区分", category_column),
            )
            if column is None
        ]
        if missing:
            raise ValueError(f"{source.name} に必要列がありません: {', '.join(missing)}")

        totals: dict[str, float] = defaultdict(float)
        zones: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        stats = {
            "source_rows": 0,
            "included_rows": 0,
            "excluded_non_purchase_rows": 0,
            "invalid_rows": 0,
            "unclassified_zone_rows": 0,
            "category_column": category_column,
            "amount_column": amount_column,
            "date_column": date_column,
            "zone_column": zone_column,
        }
        for row in reader:
            stats["source_rows"] += 1
            if normalized(row.get(category_column)) != "仕入":
                stats["excluded_non_purchase_rows"] += 1
                continue
            ym = month_key(row.get(date_column))
            amount = number(row.get(amount_column))
            if ym is None or amount is None:
                stats["invalid_rows"] += 1
                continue
            totals[ym] += amount
            zone = purchase_zone(row, zone_column)
            if zone is None:
                stats["unclassified_zone_rows"] += 1
            else:
                zones[ym][zone] += amount
            stats["included_rows"] += 1
    rounded_totals = {ym: round(value) for ym, value in totals.items()}
    rounded_zones = {
        ym: {zone: round(value) for zone, value in values.items()}
        for ym, values in zones.items()
    }
    return rounded_totals, rounded_zones, stats


def merge(source: Path, destination: Path) -> int:
    if not source.is_file() or not destination.is_file():
        print(f"[WARN] {source.name} または {destination.name} が無いため仕入反映をスキップ")
        return 0
    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    try:
        totals, zone_totals, stats = read_purchases(source)
    except ValueError as error:
        output.setdefault("meta", {})["daily_purchase_import"] = {
            "status": "blocked",
            "reason": str(error),
        }
        destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"[WARN] {error}。既存の仕入値は変更しません")
        return 0

    finalized_months = set(output.get("finalized_months", []))
    skipped_finalized_months = 0
    for ym, purchase in totals.items():
        if ym in finalized_months:
            skipped_finalized_months += 1
            continue
        month = output.setdefault("monthly", {}).setdefault(
            ym,
            {"zones": {zone: blank_summary() for zone in ZONES}, "total": blank_summary()},
        )
        for zone in ZONES:
            zone_row = month.setdefault("zones", {}).setdefault(zone, blank_summary())
            zone_row["purchase"] = zone_totals.get(ym, {}).get(zone)
            recalculate(zone_row)
        month.setdefault("total", blank_summary())["purchase"] = purchase
        recalculate(month["total"])
        output.setdefault("month_status", {}).setdefault(ym, {})

    output["months"] = sorted(set(output.get("months", [])) | set(totals))
    jst = timezone(timedelta(hours=9))
    output.setdefault("meta", {}).update({
        "daily_purchase_source": source.name,
        "daily_purchase_updated_at": datetime.now(jst).strftime("%Y-%m-%d %H:%M JST"),
        "daily_purchase_import": {
            "status": "ok",
            **stats,
            "skipped_finalized_months": skipped_finalized_months,
        },
    })
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"[OK] 仕入を反映: {len(totals)}か月 / 採用{stats['included_rows']}行 / "
        f"仕入以外を除外{stats['excluded_non_purchase_rows']}行 / 工場未分類{stats['unclassified_zone_rows']}行 / "
        f"確定月を保持{skipped_finalized_months}か月"
    )
    return len(totals)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()
    merge(args.source, args.destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
