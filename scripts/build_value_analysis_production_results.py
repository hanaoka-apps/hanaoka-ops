#!/usr/bin/env python3
"""Aggregate final in-house production reports into a protected, separate JSON.

The source CSVs are read-only. The output belongs under data/ (git-ignored) and
must be uploaded only to authenticated SharePoint storage, never to fujin/.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

from merge_value_analysis_bom import normalize_code
from merge_value_analysis_labor import (
    JST,
    choose_internal_routes,
    csv_rows,
    month_key,
    norm,
    parse_date,
    today_jst,
)

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
DEFAULT_ACTUALS = DATA / "製造実績明細出力.csv"
DEFAULT_ROUTES = DATA / "品目手順マスタ.csv"
DEFAULT_ITEMS = DATA / "品目マスタ.csv"
DEFAULT_OUTPUT = DATA / "value_analysis_production_results.json"

ACTUAL_REQUIRED = ("伝票日付", "品目ｺｰﾄﾞ", "手順№", "報告数量", "手配先名")
ROUTE_REQUIRED = ("品目ｺｰﾄﾞ", "手順№", "内外区分", "有効日", "失効日", "優先№")
ITEM_REQUIRED = (
    "品目ｺｰﾄﾞ", "品目名", "単位", "大分類ｺｰﾄﾞ", "大分類名",
    "中分類ｺｰﾄﾞ", "中分類名", "小分類ｺｰﾄﾞ", "小分類名",
)
FACTORIES = ("第一工場", "第二工場", "第三工場")
# 重点品目の条件で選べる分類（あれば持つ。列が無くても止めない）。キーは画面側と共通：<k>c=コード, <k>n=名前
OPTIONAL_CLASSES = (
    ("h", "標/部/特売上ｺｰﾄﾞ", "標/部/特売上名"),
    ("p", "価格表記載名ｺｰﾄﾞ", "価格表記載名名"),
    ("b", "仕入大分類ｺｰﾄﾞ", "仕入大分類名"),
    ("g", "工場別出荷郡ｺｰﾄﾞ", "工場別出荷郡名"),
    ("o", "仕入諸口ｺｰﾄﾞｺｰﾄﾞ", "仕入諸口ｺｰﾄﾞ名"),
    ("f", "工場別付加価ｺｰﾄﾞ", "工場別付加価名"),
    ("n", "業務納期確認ｺｰﾄﾞ", "業務納期確認名"),
    ("x1", "詳細分類ｺｰﾄﾞ", "詳細分類/部品名①"),
    ("x2", "詳細分類②ｺｰﾄﾞ", "詳細分類②/部品名②"),
    ("x3", "詳細分類③ｺｰﾄﾞ", "詳細分類③/部品名③"),
    ("x4", "詳細分類④ｺｰﾄﾞ", "詳細分類④/部品名④"),
    ("x5", "詳細分類⑤ｺｰﾄﾞ", "詳細分類⑤/部品名⑤"),
    ("x6", "詳細分類⑥ｺｰﾄﾞ", "詳細分類⑥/部品名⑥"),
)


def require_columns(headers: list[str], required: tuple[str, ...], source: str) -> None:
    missing = sorted(set(required) - set(headers))
    if missing:
        raise ValueError(f"{source} の必須列が不足: {', '.join(missing)}")


def fiscal_months(today: date) -> list[str]:
    current_start = today.year if today.month >= 4 else today.year - 1
    first_year = current_start - 1
    return [f"{first_year + (3 + offset) // 12:04d}-{(3 + offset) % 12 + 1:02d}" for offset in range(24)]


def month_end(year_month: str) -> date:
    first = date(int(year_month[:4]), int(year_month[4:6]), 1)
    next_month = (first.replace(day=28) + timedelta(days=4)).replace(day=1)
    return next_month - timedelta(days=1)


def numeric_step(value: object) -> Decimal | None:
    try:
        return Decimal(norm(value))
    except (InvalidOperation, ValueError):
        return None


def quantity(value: object) -> Decimal | None:
    try:
        result = Decimal(norm(value).replace(",", ""))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() and result > 0 else None


def minutes(value: object) -> Decimal | None:
    try:
        result = Decimal(norm(value).replace(",", ""))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() and result >= 0 else None


def json_number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def factory_from_work_area(work_area: str) -> str | None:
    for factory in FACTORIES:
        if work_area == factory or work_area.startswith(factory + " "):
            return factory
    return None


def build(
    actual_rows: list[dict[str, str]],
    route_rows: list[dict[str, str]],
    item_rows: list[dict[str, str]],
    *,
    today: date,
) -> dict:
    """Count only each item's last active internal route, by slip month.

    Route choice (effective date, latest version, priority, ambiguity) reuses
    the labor calculation's selector. The actual report's work area is the
    completion location; missing/unknown areas are excluded, never guessed.
    """
    months = fiscal_months(today)
    allowed = set(months)
    master = {}
    for row in item_rows:
        code = normalize_code(row.get("品目ｺｰﾄﾞ"))
        if code:
            if code in master:
                raise ValueError("品目マスタに品目コードの重複があります")
            master[code] = {
                "name": norm(row.get("品目名")), "unit": norm(row.get("単位")),
                "dc": norm(row.get("大分類ｺｰﾄﾞ")), "dn": norm(row.get("大分類名")),
                "mc": norm(row.get("中分類ｺｰﾄﾞ")), "mn": norm(row.get("中分類名")),
                "sc": norm(row.get("小分類ｺｰﾄﾞ")), "sn": norm(row.get("小分類名")),
            }
            for key, code_col, name_col in OPTIONAL_CLASSES:
                if norm(row.get(code_col)) or norm(row.get(name_col)):
                    master[code][key + "c"] = norm(row.get(code_col))
                    master[code][key + "n"] = norm(row.get(name_col))
            if norm(row.get("品目名索引")):
                master[code]["idx"] = norm(row.get("品目名索引"))

    selected_by_month: dict[str, dict] = {}
    final_by_month: dict[str, dict] = {}
    totals: dict[tuple[str, str, str, str], Decimal] = defaultdict(Decimal)
    daily: dict[tuple[str, str, str, str], Decimal] = defaultdict(Decimal)
    # 日別の作業時間（全工程・社内作業区）。付加価値アプリの工数と同じ式：
    #   基準内＝作業時間×人数、基準外＝基準外工数/分×基準外人数/人（別に集計し、引き算しない）
    labor: dict[tuple[str, str, str, str], list] = defaultdict(lambda: [Decimal(0), Decimal(0), 0])
    used_items: set[str] = set()
    observed_months: set[str] = set()
    diagnostics: dict[str, int] = defaultdict(int)
    source_latest_date = ""
    for row in actual_rows:
        day = parse_date(row.get("伝票日付"))
        if day is None or day > today:
            diagnostics["invalid_or_future_date"] += 1
            continue
        ym = month_key(day)
        month = f"{ym[:4]}-{ym[4:]}"
        if month not in allowed:
            continue
        observed_months.add(month)
        source_latest_date = max(source_latest_date, day.isoformat())
        labor_area = norm(row.get("手配先名"))
        labor_factory = factory_from_work_area(labor_area)
        labor_item = normalize_code(row.get("品目ｺｰﾄﾞ"))
        if labor_factory and labor_item:
            work = minutes(row.get("作業時間"))
            people = minutes(row.get("人数"))
            inside = work * people if work is not None and people is not None else Decimal(0)
            outside = (minutes(row.get("基準外工数/分")) or Decimal(0)) * (minutes(row.get("基準外人数/人")) or Decimal(0))
            entry = labor[(day.isoformat(), labor_item, labor_factory, labor_area)]
            entry[0] += inside
            entry[1] += outside
            reported = quantity(row.get("報告数量"))
            if reported is not None and inside == 0 and outside == 0:
                entry[2] += 1  # 完成数はあるのに作業時間が入っていない報告
        if ym not in selected_by_month:
            selected, ambiguous = choose_internal_routes(route_rows, month_end(ym))
            selected_by_month[ym] = selected
            diagnostics["ambiguous_route_keys"] += ambiguous
            final: dict[str, Decimal] = {}
            for item, step in selected:
                number = numeric_step(step)
                if number is not None and (item not in final or number > final[item]):
                    final[item] = number
            final_by_month[ym] = final

        item = normalize_code(row.get("品目ｺｰﾄﾞ"))
        step = norm(row.get("手順№"))
        route = selected_by_month[ym].get((item, step))
        if route is None:
            diagnostics["not_internal_or_unmatched_route"] += 1
            continue
        if numeric_step(step) != final_by_month[ym].get(item):
            diagnostics["earlier_internal_step"] += 1
            continue
        qty = quantity(row.get("報告数量"))
        if qty is None:
            diagnostics["invalid_quantity"] += 1
            continue
        work_area = norm(row.get("手配先名"))
        factory = factory_from_work_area(work_area)
        if factory is None:
            diagnostics["unknown_work_area"] += 1
            continue
        if item not in master:
            diagnostics["item_master_missing"] += 1
            continue
        if norm(route.get("手配先名")) != work_area:
            diagnostics["route_work_area_differs"] += 1
        totals[(month, item, factory, work_area)] += qty
        daily[(day.isoformat(), item, factory, work_area)] += qty
        used_items.add(item)
        diagnostics["counted_reports"] += 1

    # 日別（当日・月内累計・日別グラフ用）。サイズを抑えるため、実績がある直近2か月だけ持つ。
    daily_months = sorted(observed_months)[-2:]
    return {
        "generated_at": datetime.now(JST).isoformat(timespec="seconds"),
        "source": "製造実績明細出力.csv",
        "method": "last_active_internal_route_report_quantity",
        "months": months,
        "observed_months": sorted(observed_months),
        "source_latest_date": source_latest_date,
        "items": {code: master[code] for code in sorted(used_items)},
        "rows": [
            {"m": month, "item": item, "factory": factory, "ws": work_area, "qty": json_number(qty)}
            for (month, item, factory, work_area), qty in sorted(totals.items())
        ],
        "daily_months": daily_months,
        "daily_rows": [
            {"d": day_key, "item": item, "factory": factory, "ws": work_area, "qty": json_number(qty)}
            for (day_key, item, factory, work_area), qty in sorted(daily.items())
            if day_key[:7] in daily_months
        ],
        "labor_formula": "基準内=作業時間×人数、基準外=基準外工数/分×基準外人数/人（分）",
        "daily_labor": [
            {"d": day_key, "item": item, "factory": factory, "ws": work_area,
             "in": json_number(values[0]), "ex": json_number(values[1]), "z": values[2]}
            for (day_key, item, factory, work_area), values in sorted(labor.items())
            if day_key[:7] in daily_months and (values[0] or values[1] or values[2])
        ],
        "diagnostics": dict(sorted(diagnostics.items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actuals", type=Path, default=DEFAULT_ACTUALS)
    parser.add_argument("--routes", type=Path, default=DEFAULT_ROUTES)
    parser.add_argument("--items", type=Path, default=DEFAULT_ITEMS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    headers, actuals = csv_rows(args.actuals)
    require_columns(headers, ACTUAL_REQUIRED, args.actuals.name)
    headers, routes = csv_rows(args.routes)
    require_columns(headers, ROUTE_REQUIRED, args.routes.name)
    headers, items = csv_rows(args.items)
    require_columns(headers, ITEM_REQUIRED, args.items.name)
    payload = build(actuals, routes, items, today=today_jst())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        "[OK] 保護された完成実績JSONを生成: "
        f"月{len(payload['observed_months'])} / 品目{len(payload['items'])} / "
        f"集計行{len(payload['rows'])} / 除外等{payload['diagnostics']}"
    )


if __name__ == "__main__":
    main()
