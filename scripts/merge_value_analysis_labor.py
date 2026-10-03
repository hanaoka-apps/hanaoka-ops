#!/usr/bin/env python3
"""Build protected labor estimates for FUJIN value analysis.

Source CSVs are read-only. Only the dedicated value_analysis.json is updated;
this script intentionally emits aggregate counts only to stdout.
"""

from __future__ import annotations

import argparse
import csv
import json
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from merge_value_analysis_bom import expand, normalize_code, read_bom

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
DEFAULT_DESTINATION = DATA / "value_analysis.json"
DEFAULT_ACTUALS = DATA / "製造実績明細出力.csv"
DEFAULT_ROUTES = DATA / "品目手順マスタ.csv"
DEFAULT_BOM = DATA / "構成マスタ.csv"

ACTUAL_REQUIRED = (
    "伝票日付", "品目ｺｰﾄﾞ", "手順№", "報告数量", "人数", "作業時間",
    "基準外人数/人", "基準外工数/分", "基準外項目",
)
ROUTE_REQUIRED = ("品目ｺｰﾄﾞ", "手順№", "内外区分", "有効日", "失効日", "優先№")
DEFAULT_SETTINGS = {
    "period_months": 3,
    "period_options": [3, 6],
    "allocated_exception_keywords": ["段取り"],
    "excluded_exception_keywords": ["手直し", "修正作業"],
    "labor_rate_history": [{"from": "202604", "through": "202608", "yen_per_minute": 124.64}],
}
JST = timezone(timedelta(hours=9))


def today_jst() -> date:
    """Return the current business date, independent of the Actions runner's UTC date."""
    return datetime.now(JST).date()
RATE_NOT_REGISTERED = "レート未確定"
HANDOFF_VERSION_ID = "labor-p1-v1"


def norm(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().strip('"')


def delimiter_for(path: Path) -> str:
    with path.open(encoding="utf-8-sig", errors="replace") as handle:
        line = handle.readline()
    return "\t" if line.count("\t") > line.count(",") else ","


def csv_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=delimiter_for(path))
        headers = [str(name or "").strip().strip('"') for name in (reader.fieldnames or [])]
        rows = [{str(k).strip().strip('"'): norm(v) for k, v in row.items() if k is not None} for row in reader]
    return headers, rows


def parse_number(value: object) -> float | None:
    text = norm(value).replace(",", "").replace("分", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_date(value: object) -> date | None:
    text = norm(value)
    digits = "".join(ch for ch in text if ch.isdigit())
    for fmt, candidate in (("%Y%m%d", digits[:8]), ("%Y%m", digits[:6])):
        if len(candidate) == (8 if fmt == "%Y%m%d" else 6):
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                pass
    return None


def month_key(value: date) -> str:
    return value.strftime("%Y%m")


def period_start(anchor: str, months: int) -> str:
    year, month = int(anchor[:4]), int(anchor[4:6])
    index = year * 12 + month - 1 - (months - 1)
    return f"{index // 12:04d}{index % 12 + 1:02d}"


def rate_for_month(settings: dict, ym: str) -> float | None:
    for row in settings.get("labor_rate_history", []):
        if str(row.get("from", "")) <= ym <= str(row.get("through", "")):
            value = parse_number(row.get("yen_per_minute"))
            return value if value is not None and value >= 0 else None
    return None


def active_on(row: dict[str, str], day: date) -> bool:
    start, end = parse_date(row.get("有効日")), parse_date(row.get("失効日"))
    return (start is None or start <= day) and (end is None or end >= day)


def choose_internal_routes(rows: list[dict[str, str]], anchor: date) -> tuple[dict[tuple[str, str], dict], int]:
    candidates: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        if norm(row.get("内外区分")) != "0" or not active_on(row, anchor):
            continue
        item = normalize_code(row.get("品目ｺｰﾄﾞ"))
        step = norm(row.get("手順№"))
        if item and step:
            candidates[(item, step)].append(row)
    selected: dict[tuple[str, str], dict] = {}
    ambiguous = 0
    for key, choices in candidates.items():
        latest = max((parse_date(row.get("有効日")) or date.min) for row in choices)
        newest = [row for row in choices if (parse_date(row.get("有効日")) or date.min) == latest]
        priorities = [(parse_number(row.get("優先№")), row) for row in newest]
        known = [entry for entry in priorities if entry[0] is not None]
        if known:
            best = min(value for value, _ in known)
            finalists = [row for value, row in known if value == best]
        else:
            finalists = newest
        identities = {(norm(r.get("工程ｺｰﾄﾞ")), norm(r.get("工程名"))) for r in finalists}
        if len(identities) > 1:
            ambiguous += 1
            continue
        selected[key] = finalists[0]
    return selected, ambiguous


def setup_keyword(settings: dict, reason: str) -> bool:
    text = norm(reason)
    excluded = [norm(v) for v in settings.get("excluded_exception_keywords", []) if norm(v)]
    if any(keyword in text for keyword in excluded):
        return False
    allocated = [norm(v) for v in settings.get("allocated_exception_keywords", []) if norm(v)]
    return bool(allocated) and any(keyword in text for keyword in allocated)


def aggregate_monthly_actuals(
    actual_rows: list[dict[str, str]], route_rows: list[dict[str, str]], settings: dict,
    included_codes: set[str] | None = None,
) -> tuple[dict[str, dict], dict[str, dict]]:
    """Aggregate item-level recorded work time by slip month, without BOM rollup."""
    monthly: dict[str, dict[str, dict]] = defaultdict(
        lambda: defaultdict(lambda: {
            "actual_minutes": 0.0, "processing_minutes": 0.0, "setup_minutes": 0.0,
            "excluded_exception_minutes": 0.0, "rows": 0, "positive_rows": 0,
            "zero_rows": 0, "unmatched_rows": 0, "quantity": 0.0,
            "latest_date": "",
        })
    )
    diagnostics: dict[str, dict] = defaultdict(lambda: {"latest_date": "", "valid_rows": 0, "unmatched_rows": 0})
    month_routes: dict[str, dict[tuple[str, str], dict]] = {}
    for row in actual_rows:
        day = parse_date(row.get("伝票日付"))
        if not day or day > today_jst():
            continue
        ym = month_key(day)
        if ym not in month_routes:
            month_end = (datetime.strptime(ym, "%Y%m").date().replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            month_routes[ym], _ = choose_internal_routes(route_rows, month_end)
        item, step = normalize_code(row.get("品目ｺｰﾄﾞ")), norm(row.get("手順№"))
        route = month_routes[ym].get((item, step))
        qty, work = parse_number(row.get("報告数量")), parse_number(row.get("作業時間"))
        if not item or qty is None or qty <= 0 or work is None or work < 0:
            continue
        diag = diagnostics[ym]
        diag["latest_date"] = max(diag["latest_date"], day.isoformat())
        diag["valid_rows"] += 1
        if included_codes is not None and item not in included_codes:
            continue
        entry = monthly[ym][item]
        if not route:
            entry["unmatched_rows"] += 1
            diag["unmatched_rows"] += 1
            continue
        people = parse_number(row.get("人数"))
        total = work * (people if people is not None and people > 0 else 1)
        exception = min(total, max(0.0, (parse_number(row.get("基準外工数/分")) or 0.0) * (parse_number(row.get("基準外人数/人")) or 0.0)))
        reason = norm(row.get("基準外項目"))
        setup = exception if setup_keyword(settings, reason) else 0.0
        excluded_exception = exception - setup
        entry["actual_minutes"] += total
        entry["processing_minutes"] += total - exception
        entry["setup_minutes"] += setup
        entry["excluded_exception_minutes"] += excluded_exception
        entry["rows"] += 1
        entry["positive_rows"] += int(total > 0)
        entry["zero_rows"] += int(total == 0)
        entry["quantity"] += qty
        entry["latest_date"] = max(entry["latest_date"], day.isoformat())

    output: dict[str, dict] = {}
    for ym, items in monthly.items():
        rate = rate_for_month(settings, ym)
        rows = {}
        for code, row in items.items():
            matched = row["rows"]
            input_rate = round(row["positive_rows"] / matched * 100, 1) if matched else None
            amount = row["actual_minutes"] * rate if rate is not None else None
            rows[code] = {
                **row,
                "actual_minutes": row["actual_minutes"] if matched else None,
                "processing_minutes": row["processing_minutes"] if matched else None,
                "setup_minutes": row["setup_minutes"] if matched else None,
                "excluded_exception_minutes": row["excluded_exception_minutes"] if matched else None,
                "input_rate": input_rate,
                "rate_per_minute": rate if matched else None,
                "actual_amount_yen": round(amount, 2) if amount is not None and matched else None,
                "status": (
                    "route_mismatch" if not matched and row["unmatched_rows"]
                    else "partial_route_mismatch" if row["unmatched_rows"]
                    else "zero_only" if matched and not row["positive_rows"]
                    else "available"
                ),
            }
        output[ym] = {"status": "available" if rows else "no_results", "latest_date": diagnostics[ym]["latest_date"], "items": rows}
    return output, {month: dict(values) for month, values in diagnostics.items()}


def calculate_window(
    anchor: str,
    months: int,
    actual_rows: list[dict[str, str]],
    routes: dict[tuple[str, str], dict],
    bom_children: dict[str, list[dict]],
    settings: dict,
    root_codes: set[str] | None = None,
) -> tuple[dict, dict]:
    start = period_start(anchor, months)
    accum: dict[tuple[str, str], dict] = defaultdict(lambda: {"qty": 0.0, "processing": 0.0, "setup": 0.0, "positive": 0, "zero": 0})
    excluded: dict[str, int] = defaultdict(int)
    needs_review: dict[str, int] = defaultdict(int)
    reason_counts: dict[str, int] = defaultdict(int)
    review_rows: list[dict[str, str]] = []
    for row in actual_rows:
        day = parse_date(row.get("伝票日付"))
        if not day:
            excluded["sales_missing_date"] += 1
            review_rows.append({"date": "", "item_code": normalize_code(row.get("品目ｺｰﾄﾞ")), "step": norm(row.get("手順№")), "reason": "sales_missing_date"})
            continue
        if day > today_jst():
            excluded["future_date"] += 1
            review_rows.append({"date": day.isoformat(), "item_code": normalize_code(row.get("品目ｺｰﾄﾞ")), "step": norm(row.get("手順№")), "reason": "future_date"})
            continue
        ym = month_key(day)
        if not start <= ym <= anchor:
            continue
        item, step = normalize_code(row.get("品目ｺｰﾄﾞ")), norm(row.get("手順№"))
        route = routes.get((item, step))
        if not route:
            excluded["route_missing_or_not_internal"] += 1
            review_rows.append({"date": day.isoformat(), "item_code": item, "step": step, "reason": "route_missing_or_not_internal"})
            continue
        qty = parse_number(row.get("報告数量"))
        work = parse_number(row.get("作業時間"))
        if qty is None or qty <= 0 or work is None or work < 0:
            excluded["invalid_quantity_or_worktime"] += 1
            review_rows.append({"date": day.isoformat(), "item_code": item, "step": step, "reason": "invalid_quantity_or_worktime"})
            continue
        people = parse_number(row.get("人数"))
        total = work * (people if people is not None and people > 0 else 1)
        exception_unit = parse_number(row.get("基準外工数/分")) or 0.0
        exception_people = parse_number(row.get("基準外人数/人")) or 0.0
        raw_exception = max(0.0, exception_unit * exception_people)
        if raw_exception > total:
            needs_review["exception_exceeds_total"] += 1
            review_rows.append({"date": day.isoformat(), "item_code": item, "step": step, "reason": "exception_exceeds_total"})
        exception = min(total, raw_exception)
        reason = norm(row.get("基準外項目"))
        if reason:
            reason_counts[reason] += 1
        setup = exception if setup_keyword(settings, reason) else 0.0
        bucket = accum[(item, step)]
        bucket["qty"] += qty
        bucket["processing"] += total - exception
        bucket["setup"] += setup
        if total > 0:
            bucket["positive"] += 1
        else:
            bucket["zero"] += 1

    own: dict[str, dict] = defaultdict(lambda: {"steps": [], "positive": 0, "zero": 0, "complete": True})
    route_items = {item for item, _step in routes}
    for (item, step), route in routes.items():
        data = accum.get((item, step))
        if not data or not data["qty"]:
            own[item]["complete"] = False
            own[item]["steps"].append({"step": step, "process_code": norm(route.get("工程ｺｰﾄﾞ")), "process_name": norm(route.get("工程名")), "process_minutes": None, "setup_minutes": None, "rows": 0, "status": "期間内実績なし"})
            continue
        own[item]["steps"].append({
            "step": step,
            "process_code": norm(route.get("工程ｺｰﾄﾞ")),
            "process_name": norm(route.get("工程名")),
            "process_minutes": data["processing"] / data["qty"],
            "setup_minutes": data["setup"] / data["qty"],
            "rows": data["positive"] + data["zero"],
            "status": "集計済み",
        })
        own[item]["positive"] += data["positive"]
        own[item]["zero"] += data["zero"]
    for item in own:
        own[item]["steps"].sort(key=lambda row: row["step"])
        own[item]["process_minutes"] = sum(row["process_minutes"] or 0 for row in own[item]["steps"])
        own[item]["setup_minutes"] = sum(row["setup_minutes"] or 0 for row in own[item]["steps"])
        own[item]["standard_minutes"] = (
            own[item]["process_minutes"] + own[item]["setup_minutes"] if own[item]["complete"] else None
        )
        total_rows = own[item]["positive"] + own[item]["zero"]
        own[item]["input_rate"] = round(own[item]["positive"] / total_rows * 100, 1) if total_rows else None

    # BOM in this pipeline is already deduplicated by parent/child. Memoization
    # prevents repeated shared subtrees from causing exponential recursion.
    memo: dict[str, dict] = {}
    subtree_has_route: dict[str, bool] = {}
    def has_internal_route(code: str, seen: frozenset[str] = frozenset()) -> bool:
        if code in subtree_has_route:
            return subtree_has_route[code]
        if code in seen:
            return False
        result = code in route_items or any(
            has_internal_route(normalize_code(child.get("code")), seen | {code})
            for child in bom_children.get(code, [])
        )
        subtree_has_route[code] = result
        return result

    def rollup(code: str, stack: frozenset[str] = frozenset()) -> dict:
        if code in memo:
            return memo[code]
        if code in stack:
            return {"standard_minutes": None, "process_minutes": None, "setup_minutes": None, "complete": False, "positive": 0.0, "zero": 0.0, "contributions": [], "cycle": True, "child_missing": True}
        direct = own.get(code)
        process = direct["process_minutes"] if direct else 0.0
        setup = direct["setup_minutes"] if direct else 0.0
        complete = direct["complete"] if direct else True
        positive = float(direct["positive"]) if direct else 0.0
        zero = float(direct["zero"]) if direct else 0.0
        child_missing = False
        contributions = []
        for child in bom_children.get(code, []):
            child_code = normalize_code(child.get("code"))
            quantity = float(child.get("quantity") or 0)
            part = rollup(child_code, stack | {code})
            contributions.append({"code": child_code, "name": child.get("name") or child_code, "quantity": quantity, "cum_std_per_unit": part["standard_minutes"], "standard_minutes": None if part["standard_minutes"] is None else part["standard_minutes"] * quantity})
            if part["standard_minutes"] is None:
                complete = False
                child_missing = True
            else:
                process += (part["process_minutes"] or 0) * quantity
                setup += (part["setup_minutes"] or 0) * quantity
            positive += part["positive"] * quantity
            zero += part["zero"] * quantity
        result = {
            "standard_minutes": process + setup if complete else None,
            "process_minutes": process if complete else None,
            "setup_minutes": setup if complete else None,
            "complete": complete,
            "child_missing": child_missing,
            "positive": positive,
            "zero": zero,
            "input_rate": round(positive / (positive + zero) * 100, 1) if positive + zero else None,
            "contributions": contributions,
        }
        memo[code] = result
        return result

    all_codes = set(own) | set(bom_children)
    for children in bom_children.values():
        all_codes.update(normalize_code(part.get("code")) for part in children)
    anchor_date = datetime.strptime(anchor, "%Y%m").date()
    rate = rate_for_month(settings, anchor)
    report_count = sum(bucket["positive"] + bucket["zero"] for bucket in accum.values())
    positive_count = sum(bucket["positive"] for bucket in accum.values())
    item_details = {}
    # Months without production actuals have no defensible standard. Keeping a
    # full empty-value BOM for every such month made the protected JSON huge.
    display_codes = (all_codes if root_codes is None else all_codes | {normalize_code(code) for code in root_codes}) if report_count else set()
    for code in sorted(display_codes):
        result = rollup(code)
        if result["standard_minutes"] is None and code not in route_items and not bom_children.get(code):
            # A purchased leaf with no internal route contributes no in-house labor.
            result = {**result, "standard_minutes": 0.0, "process_minutes": 0.0, "setup_minutes": 0.0, "complete": True}
        amount = result["standard_minutes"] * rate if result["standard_minutes"] is not None and rate is not None else None
        own_data = own.get(code, {})
        own_steps = own_data.get("steps", [])
        flags = []
        if result["standard_minutes"] in (None, 0):
            flags.append("工数なし")
        if result.get("input_rate") is not None and result["input_rate"] < 100:
            flags.append("入力率低")
        low_sample_threshold = parse_number(settings.get("low_sample_rows_threshold"))
        if low_sample_threshold and 0 < int(result["positive"] + result["zero"]) < low_sample_threshold:
            flags.append("件数少")
        if any(row.get("reason") in ("exception_exceeds_total", "future_date", "route_missing_or_not_internal") for row in review_rows if row.get("item_code") == code):
            flags.append("要確認")
        own_missing = any(row.get("status") == "期間内実績なし" for row in own_steps)
        if result["standard_minutes"] is None:
            labor_status = "子部品工数未取得" if result.get("child_missing") else "社内工程あり・期間内実績なし" if own_missing else "工数未取得"
        elif result["standard_minutes"] == 0:
            labor_status = "社内工程なし（対象外）" if not has_internal_route(code) else (
                "実測0分" if result["positive"] + result["zero"] else "有効実績なし"
            )
        else:
            labor_status = "集計済み"
        item_details[code] = {
            "standard_minutes": result["standard_minutes"],
            "processing_minutes": result["process_minutes"],
            "setup_minutes": result["setup_minutes"],
            "own_run_per_unit": own_data.get("process_minutes") if own_data.get("complete", True) else None,
            "own_setup_per_unit": own_data.get("setup_minutes") if own_data.get("complete", True) else None,
            "own_std_per_unit": own_data.get("standard_minutes"),
            "cum_std_per_unit": result["standard_minutes"],
            "labor_amount_yen": round(amount, 2) if amount is not None else None,
            "rate_status": "registered" if rate is not None else RATE_NOT_REGISTERED,
            "input_rate": result.get("input_rate"),
            "reported_positive": int(result["positive"]),
            "reported_zero": int(result["zero"]),
            "rows": int(result["positive"] + result["zero"]),
            "zero_rows": int(result["zero"]),
            "flags": flags,
            "complete": result["complete"],
            "labor_status": labor_status,
            "steps": [{
                "手順№": row["step"], "工程": row.get("process_name") or row.get("process_code") or "",
                "工程コード": row.get("process_code") or "", "run": row["process_minutes"],
                "setup": row["setup_minutes"], "rows": row["rows"], "status": row["status"],
            } for row in own_steps],
            "children": [{
                "品目コード": row["code"], "必要数": row["quantity"],
                "cum_std_per_unit": row["cum_std_per_unit"],
            } for row in result["contributions"]],
        }
    window = {
        "status": "no_internal_routes" if not routes else ("no_results" if not report_count else "ok"),
        "period_months": months,
        "period_start": start,
        "period_end": anchor,
        "internal_route_count": len(routes),
        "actual_record_count": report_count,
        "input_positive_count": positive_count,
        "input_zero_count": report_count - positive_count,
        "input_rate": round(positive_count / report_count * 100, 1) if report_count else None,
        "exception_reasons": dict(sorted(reason_counts.items())),
        "excluded": dict(sorted(excluded.items())),
        "needs_review": dict(sorted(needs_review.items())),
        "review_rows": review_rows,
    }
    source_metadata_path = DATA / "_value_analysis_labor_sources.json"
    source_metadata = {}
    if source_metadata_path.is_file():
        try:
            source_metadata = json.loads(source_metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            source_metadata = {}
    actual_dates = [parse_date(row.get("伝票日付")) for row in actual_rows]
    actual_dates = [day for day in actual_dates if day is not None and day <= today_jst()]
    rate_history = [{
        "from_month": str(row.get("from", "")),
        "through_month": str(row.get("through", "")),
        "yen_per_min": parse_number(row.get("yen_per_minute")),
    } for row in settings.get("labor_rate_history", [])]
    period_end_date = (datetime.strptime(anchor, "%Y%m").date().replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    window["handoff"] = {
        "meta": {
            "version_id": HANDOFF_VERSION_ID,
            "generated_at": None,
            "period_from": f"{start[:4]}-{start[4:]}-01",
            "period_to": period_end_date.isoformat(),
            "settings": {
                "months": months,
                "allocate_items": list(settings.get("allocated_exception_keywords", [])),
                "exclude_items": list(settings.get("excluded_exception_keywords", [])),
            },
            "sources": {
                "製造実績の最終日付": max(actual_dates).isoformat() if actual_dates else None,
                "品目手順マスタ更新日時": source_metadata.get("routes_updated_at") or None,
                "構成マスタ更新日時": source_metadata.get("bom_updated_at") or None,
            },
        },
        "items": {
            code: {
                "own_run_per_unit": item["own_run_per_unit"],
                "own_setup_per_unit": item["own_setup_per_unit"],
                "own_std_per_unit": item["own_std_per_unit"],
                "cum_std_per_unit": item["cum_std_per_unit"],
                "standard_minutes": item["standard_minutes"],
                "processing_minutes": item["processing_minutes"],
                "setup_minutes": item["setup_minutes"],
                "labor_amount_yen": item["labor_amount_yen"],
                "rate_status": item["rate_status"],
                "input_rate": item["input_rate"], "rows": item["rows"], "zero_rows": item["zero_rows"],
                "reported_positive": item["reported_positive"], "reported_zero": item["reported_zero"],
                "flags": item["flags"], "complete": item["complete"],
                "labor_status": item["labor_status"],
                "steps": item["steps"], "children": item["children"],
            } for code, item in item_details.items()
        },
        "rates": rate_history,
    }
    diagnostics = {
        "status": window["status"], "period_months": months,
        "actual_record_count": report_count,
        "input_zero_count": report_count - positive_count,
        "excluded": dict(excluded), "low_level_item_count": len(item_details),
        "needs_review": dict(needs_review),
    }
    return window, diagnostics


def merge(destination: Path, actuals_path: Path, routes_path: Path, bom_path: Path) -> dict:
    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    analysis = output.get("item_analysis")
    if not isinstance(analysis, dict) or not isinstance(analysis.get("items"), dict):
        raise ValueError("item_analysis.items がありません")
    for path in (actuals_path, routes_path, bom_path):
        if not path.is_file():
            raise FileNotFoundError(f"工数計算の入力ファイルがありません: {path.name}")
    actual_headers, actuals = csv_rows(actuals_path)
    route_headers, route_rows = csv_rows(routes_path)
    missing_actual = [col for col in ACTUAL_REQUIRED if col not in actual_headers]
    missing_route = [col for col in ROUTE_REQUIRED if col not in route_headers]
    if missing_actual or missing_route:
        raise ValueError("工数入力CSVの必須列が不足しています")
    bom_children, bom_stats = read_bom(bom_path)
    settings = {**DEFAULT_SETTINGS, **((analysis.get("labor") or {}).get("settings") or {})}
    relevant_codes = {normalize_code(code) for code in analysis.get("items", {})}
    relevant_codes.update(normalize_code(row.get("i")) for row in analysis.get("rows", []) if normalize_code(row.get("i")))
    pending_codes = list(relevant_codes)
    while pending_codes:
        parent = pending_codes.pop()
        for part in bom_children.get(parent, []):
            child = normalize_code(part.get("code"))
            if child and child not in relevant_codes:
                relevant_codes.add(child)
                pending_codes.append(child)
    monthly_actuals, monthly_actual_diagnostics = aggregate_monthly_actuals(actuals, route_rows, settings, relevant_codes)
    for ym, data in monthly_actuals.items():
        month_end = (datetime.strptime(ym, "%Y%m").date().replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        selected_routes, _ = choose_internal_routes(route_rows, month_end)
        data["internal_route_codes"] = sorted({item for item, _step in selected_routes if item in relevant_codes})
    all_source_months = {month_key(day) for row in actuals if (day := parse_date(row.get("伝票日付"))) and day <= today_jst()}
    for ym in sorted(set(analysis.get("months", [])) | all_source_months):
        month_end = (datetime.strptime(ym, "%Y%m").date().replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        selected_routes, _ = choose_internal_routes(route_rows, month_end)
        if ym not in monthly_actuals:
            monthly_actuals[ym] = {"status": "no_results", "latest_date": None, "items": {}}
        monthly_actuals[ym]["internal_route_codes"] = sorted({item for item, _step in selected_routes if item in relevant_codes})
        monthly_actuals[ym]["latest_date"] = monthly_actual_diagnostics.get(ym, {}).get("latest_date") or monthly_actuals[ym].get("latest_date")
    anchors = sorted(set(analysis.get("months", [])) | {month_key(d) for row in actuals if (d := parse_date(row.get("伝票日付"))) and d <= today_jst()})
    labor_months, diagnostics = {}, {}
    for anchor in anchors:
        end_date = datetime.strptime(anchor, "%Y%m").date()
        last_day = (end_date.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        routes, ambiguous = choose_internal_routes(route_rows, last_day)
        windows = {}
        diagnostics[anchor] = {}
        root_codes = {normalize_code(row.get("i")) for row in analysis.get("rows", []) if row.get("y") == anchor and normalize_code(row.get("i"))}
        root_codes.update(normalize_code(code) for code in analysis.get("items", {}))
        root_codes.update(normalize_code(code) for code in (analysis.get("standard_cost_history", {}).get(anchor, {}) or {}))
        for period in (3, 6):
            result, stats = calculate_window(anchor, period, actuals, routes, bom_children, settings, root_codes)
            result["ambiguous_route_count"] = ambiguous
            windows[str(period)] = result
            diagnostics[anchor][str(period)] = stats
        labor_months[anchor] = {"windows": windows}
    analysis["labor"] = {
        "status": "ok",
        "source": {"actuals": actuals_path.name, "routes": routes_path.name, "bom": bom_path.name},
        "required_columns": {"actuals": list(ACTUAL_REQUIRED), "routes": list(ROUTE_REQUIRED)},
        "settings": settings,
        "default_period_months": int(settings.get("period_months", 3)),
        "period_options": [3, 6],
        "months": labor_months,
        "monthly_actuals": monthly_actuals,
        "monthly_actual_diagnostics": monthly_actual_diagnostics,
        "diagnostics": diagnostics,
        "bom_deduplication": {"duplicate_parent_child_rows_removed": bom_stats["duplicates"]},
    }
    source_metadata_path = DATA / "_value_analysis_labor_sources.json"
    source_metadata = {}
    if source_metadata_path.is_file():
        try:
            source_metadata = json.loads(source_metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            source_metadata = {}
    available_cost_months = sorted(analysis.get("standard_cost_source_months", []))
    source_actual_dates = [day for row in actuals if (day := parse_date(row.get("伝票日付"))) and day <= today_jst()]
    source_meta = output.setdefault("meta", {})
    sales_import_status = source_meta.get("daily_sales_import", {}).get("status")
    purchase_import_status = source_meta.get("daily_purchase_import", {}).get("status")
    freshness = {
        "sales": {
            "status": "not_downloaded" if source_metadata.get("required_sources_downloaded", {}).get("dashboard_facts.json") is False else "blocked" if sales_import_status == "blocked" else "no_rows" if sales_import_status == "no_rows" else "available" if analysis.get("rows") else "no_results",
            "latest_month": max((row.get("y", "") for row in analysis.get("rows", [])), default="") or None,
            "latest_record_date": source_meta.get("daily_sales_latest_date"),
            "source_modified_at": source_metadata.get("sales_facts_updated_at") or None,
            "loaded_at": source_meta.get("daily_sales_updated_at"),
            "downloaded": source_metadata.get("required_sources_downloaded", {}).get("dashboard_facts.json"),
        },
        "purchases": {
            "status": "not_downloaded" if source_metadata.get("required_sources_downloaded", {}).get("受入明細出力.csv") is False else "blocked" if purchase_import_status == "blocked" else "partial" if (source_meta.get("daily_purchase_import") or {}).get("daily_status") == "partial" else "available" if output.get("purchase_daily_by_month") else "no_results",
            "latest_month": max(output.get("purchase_daily_by_month", {}), default="") or None,
            "latest_record_date": source_meta.get("daily_purchase_latest_date"),
            "source_modified_at": source_metadata.get("purchases_updated_at") or None,
            "loaded_at": source_meta.get("daily_purchase_updated_at"),
            "downloaded": source_metadata.get("required_sources_downloaded", {}).get("受入明細出力.csv"),
        },
        "manufacturing": {
            "status": "not_downloaded" if source_metadata.get("required_sources_downloaded", {}).get("製造実績明細出力.csv") is False else "available" if source_actual_dates else "no_results",
            "latest_month": max((day.strftime("%Y%m") for day in source_actual_dates), default="") or None,
            "latest_record_date": max((day.isoformat() for day in source_actual_dates), default="") or None,
            "source_modified_at": source_metadata.get("actuals_updated_at") or None,
            "loaded_at": source_meta.get("generated_at"),
            "downloaded": source_metadata.get("required_sources_downloaded", {}).get("製造実績明細出力.csv"),
        },
        "standard_cost": {
            "status": "available" if available_cost_months else "missing",
            "available_months": available_cost_months,
            "latest_month": max(available_cost_months, default="") or None,
            "source_modified_at": source_metadata.get("standard_cost_updated_at", {}).get(max(available_cost_months, default="")) or None,
            "source_modified_by_month": source_metadata.get("standard_cost_updated_at", {}),
            "loaded_at": source_meta.get("standard_cost_imported_at"),
            "downloaded_months": source_metadata.get("standard_cost_downloaded_months", []),
        },
    }
    source_meta["data_freshness"] = freshness
    generated_at = (output.get("meta") or {}).get("generated_at")
    for month_data in labor_months.values():
        for window_data in month_data["windows"].values():
            window_data["handoff"]["meta"]["generated_at"] = generated_at
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    excluded_reasons = {month: diagnostics[month]["3"]["excluded"] for month in anchors}
    return {
        "status": "ok", "months": anchors,
        "monthly_actual_records": {m: diagnostics[m]["3"]["actual_record_count"] for m in anchors},
        "monthly_zero_worktime": {m: diagnostics[m]["3"]["input_zero_count"] for m in anchors},
        "excluded_reasons": excluded_reasons,
        "needs_review_reasons": {month: diagnostics[month]["3"]["needs_review"] for month in anchors},
        "generated_at": (output.get("meta") or {}).get("generated_at"),
        "low_value_counts": (output.get("meta") or {}).get("low_value_item_counts", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--actuals", type=Path, default=DEFAULT_ACTUALS)
    parser.add_argument("--routes", type=Path, default=DEFAULT_ROUTES)
    parser.add_argument("--bom", type=Path, default=DEFAULT_BOM)
    args = parser.parse_args()
    if not args.destination.is_file():
        raise FileNotFoundError("保護されたvalue_analysis.jsonがありません")
    summary = merge(args.destination, args.actuals, args.routes, args.bom)
    print(f"[OK] 工数分析: status={summary['status']} / 対象月={summary['months']}")
    print(f"[OK] 工数集計件数: 月別={summary['monthly_actual_records']} / ゼロ時間={summary['monthly_zero_worktime']} / 除外理由={summary['excluded_reasons']} / 要確認={summary['needs_review_reasons']}")
    print(f"[OK] meta.generated_at={summary['generated_at']} / 低付加価値品目件数={summary['low_value_counts']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
