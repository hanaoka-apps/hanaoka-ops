"""自由入力した月末在庫を付加価値分析JSONへ反映する。

入力CSVは公開リポジトリに置かず、日次処理の ``data/inventory_manual.csv``
として一時取得する。status=confirmed の行だけを反映し、draftは保持しない。
source_type は manual / iot を受け入れ、IoT接続後も同じ形式を使う。
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
DEFAULT_SOURCE = DATA / "inventory_manual.csv"
DEFAULT_DESTINATION = DATA / "value_analysis.json"
ZONES = ["第一工場", "第二工場", "第三工場", "購買", "運賃"]
REQUIRED = ("ym", "factory", "amount", "note", "status", "source_type")


def text(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def number(value: object) -> float:
    value_text = text(value).replace(",", "").replace("円", "").replace("¥", "")
    if not value_text:
        raise ValueError("amountが空です")
    negative = value_text.startswith("(") and value_text.endswith(")")
    if negative:
        value_text = value_text[1:-1]
    parsed = float(value_text)
    return -parsed if negative else parsed


def rate(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return round(numerator / denominator * 100, 1)


def recalculate(summary: dict) -> None:
    sales, purchase = summary.get("sales"), summary.get("purchase")
    current, previous = summary.get("current_inventory"), summary.get("previous_inventory")
    summary["inventory_change"] = current - previous if current is not None and previous is not None else None
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


def read_confirmed(source: Path) -> tuple[dict[str, dict], dict]:
    months: dict[str, dict] = {}
    zone_totals: dict[tuple[str, str], float] = defaultdict(float)
    with source.open(encoding="utf-8-sig", errors="strict", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = tuple(reader.fieldnames or ())
        missing = [column for column in REQUIRED if column not in headers]
        if missing:
            raise ValueError(f"{source.name} に必要列がありません: {missing}")
        stats = {"source_rows": 0, "confirmed_rows": 0, "draft_rows": 0, "iot_rows": 0}
        for line_number, row in enumerate(reader, 2):
            stats["source_rows"] += 1
            status = text(row.get("status")).lower()
            if status != "confirmed":
                stats["draft_rows"] += 1
                continue
            ym = text(row.get("ym")).replace("/", "").replace("-", "")
            factory = text(row.get("factory"))
            source_type = text(row.get("source_type")).lower()
            if len(ym) != 6 or not ym.isdigit():
                raise ValueError(f"{line_number}行目: ymはYYYYMMで指定してください")
            if factory not in ZONES:
                raise ValueError(f"{line_number}行目: factoryが許可値ではありません")
            if source_type not in {"manual", "iot"}:
                raise ValueError(f"{line_number}行目: source_typeはmanualまたはiotです")
            amount = number(row.get("amount"))
            item = {
                "factory": factory,
                "amount": round(amount),
                "note": text(row.get("note")),
                "status": "confirmed",
                "source_type": source_type,
                "updated_by": text(row.get("updated_by")),
                "updated_at": text(row.get("updated_at")),
            }
            month = months.setdefault(ym, {"rows": [], "zones": {}, "total": 0})
            month["rows"].append(item)
            zone_totals[(ym, factory)] += amount
            stats["confirmed_rows"] += 1
            if source_type == "iot":
                stats["iot_rows"] += 1
    for (ym, factory), amount in zone_totals.items():
        months[ym]["zones"][factory] = round(amount)
        months[ym]["total"] += round(amount)
    return months, stats


def merge(source: Path, destination: Path) -> int:
    if not source.is_file() or not destination.is_file():
        print(f"[WARN] {source.name} または {destination.name} が無いため在庫反映をスキップ")
        return 0
    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    months, stats = read_confirmed(source)
    for ym in sorted(months):
        month = output.setdefault("monthly", {}).setdefault(
            ym,
            {"zones": {zone: blank_summary() for zone in ZONES}, "total": blank_summary()},
        )
        previous_ym = f"{int(ym[:4]) - 1}12" if ym[4:] == "01" else f"{ym[:4]}{int(ym[4:]) - 1:02d}"
        previous_month = output.get("monthly", {}).get(previous_ym, {})
        for zone in ZONES:
            summary = month.setdefault("zones", {}).setdefault(zone, blank_summary())
            summary["current_inventory"] = months[ym]["zones"].get(zone)
            summary["previous_inventory"] = previous_month.get("zones", {}).get(zone, {}).get("current_inventory")
            recalculate(summary)
        total = month.setdefault("total", blank_summary())
        total["current_inventory"] = months[ym]["total"]
        total["previous_inventory"] = previous_month.get("total", {}).get("current_inventory")
        recalculate(total)
        output.setdefault("month_status", {}).setdefault(ym, {}).update({
            "inventory_state": "confirmed",
            "inventory_confirmed": True,
        })

    output["months"] = sorted(set(output.get("months", [])) | set(months))
    inventory_history = output.setdefault("inventory_breakdown_by_month", {})
    inventory_history.update(months)
    output["inventory_input_capabilities"] = {
        "schema_version": 1,
        "sources": {
            "manual": {"enabled": True, "label": "自由入力"},
            "iot": {"enabled": False, "label": "IoT（接続準備中）"},
        },
    }
    jst = timezone(timedelta(hours=9))
    output.setdefault("meta", {}).update({
        "inventory_input_source": source.name,
        "inventory_input_updated_at": datetime.now(jst).strftime("%Y-%m-%d %H:%M JST"),
        "inventory_input_import": {"status": "ok", **stats},
    })
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"[OK] 月末在庫を反映: {len(months)}か月 / 確定{stats['confirmed_rows']}行 / "
        f"下書き除外{stats['draft_rows']}行 / IoT{stats['iot_rows']}行"
    )
    return len(months)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()
    merge(args.source, args.destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
