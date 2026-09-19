"""保護された月次確定値を付加価値分析JSONへ反映する。

金額や対象年月は公開コードに持たず、GitHub Actions Secret などの認証済み
入力からBase64 JSONとして受け取る。日次明細から再現できない確定済みの仕入・
月末在庫を一度だけ復元し、その後は ``value_analysis.json`` 内で保持する。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DEFAULT_DESTINATION = BASE / "data" / "value_analysis.json"


def rate(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return round(numerator / denominator * 100, 1)


def recalculate(summary: dict) -> None:
    sales = summary.get("sales")
    purchase = summary.get("purchase")
    current = summary.get("current_inventory")
    previous = summary.get("previous_inventory")
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


def number(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} は数値で指定してください")
    return round(value)


def validate_month(month: str) -> None:
    if len(month) != 6 or not month.isdigit() or not 1 <= int(month[4:]) <= 12:
        raise ValueError(f"年月がYYYYMM形式ではありません: {month}")


def merge_history(payload: dict, destination: Path) -> int:
    if not destination.is_file():
        raise FileNotFoundError(destination)
    source_months = payload.get("months")
    if not isinstance(source_months, dict) or not source_months:
        raise ValueError("確定履歴にmonthsがありません")

    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    zones = list(output.get("zones") or ["第一工場", "第二工場", "第三工場", "購買", "運賃"])
    finalized = set(output.get("finalized_months", []))
    updated = 0

    for ym in sorted(source_months):
        validate_month(ym)
        source = source_months[ym]
        if not isinstance(source, dict):
            raise ValueError(f"{ym} の確定履歴がオブジェクトではありません")
        month = output.setdefault("monthly", {}).setdefault(ym, {"zones": {}, "total": {}})
        total = month.setdefault("total", {})
        for field in ("purchase", "current_inventory", "previous_inventory"):
            if field in source:
                total[field] = number(source[field], f"{ym}.{field}")
        recalculate(total)

        source_zones = source.get("zones", {})
        if not isinstance(source_zones, dict):
            raise ValueError(f"{ym}.zones がオブジェクトではありません")
        inventory_rows = []
        for zone in zones:
            zone_source = source_zones.get(zone)
            if zone_source is None:
                continue
            if not isinstance(zone_source, dict):
                raise ValueError(f"{ym}.zones.{zone} がオブジェクトではありません")
            summary = month.setdefault("zones", {}).setdefault(zone, {})
            for field in ("purchase", "current_inventory", "previous_inventory"):
                if field in zone_source:
                    summary[field] = number(zone_source[field], f"{ym}.{zone}.{field}")
            recalculate(summary)
            if "current_inventory" in zone_source:
                inventory_rows.append({
                    "factory": zone,
                    "amount": summary["current_inventory"],
                    "note": str(zone_source.get("note") or "月次確定資料"),
                    "status": "confirmed",
                    "source_type": "manual",
                    "updated_at": str(payload.get("updated_at") or ""),
                })

        status = output.setdefault("month_status", {}).setdefault(ym, {})
        status.update({
            "state": "finalized",
            "is_finalized": True,
            "purchase_state": "confirmed",
            "purchase_confirmed": total.get("purchase") is not None,
            "inventory_state": "confirmed",
            "inventory_confirmed": total.get("current_inventory") is not None,
            "source": "protected_confirmed_history",
        })
        finalized.add(ym)
        if inventory_rows:
            output.setdefault("inventory_breakdown_by_month", {})[ym] = {
                "rows": inventory_rows,
                "zones": {row["factory"]: row["amount"] for row in inventory_rows},
                "total": total.get("current_inventory"),
            }
        updated += 1

    output["months"] = sorted(set(output.get("months", [])) | set(source_months))
    output["finalized_months"] = sorted(finalized)
    jst = timezone(timedelta(hours=9))
    output.setdefault("meta", {})["confirmed_history_import"] = {
        "status": "ok",
        "updated_at": datetime.now(jst).strftime("%Y-%m-%d %H:%M JST"),
        "months": updated,
        "source": "protected_workflow_input",
    }
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[OK] 保護された月次確定値を反映: {updated}か月")
    return updated


def payload_from_environment(name: str) -> dict:
    encoded = os.environ.get(name, "").strip()
    if not encoded:
        raise ValueError(f"{name} が設定されていません")
    try:
        raw = base64.b64decode(encoded, validate=True)
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("確定履歴の復号またはJSON解析に失敗しました") from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", default="VALUE_ANALYSIS_CONFIRMED_HISTORY_B64")
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()
    merge_history(payload_from_environment(args.env), args.destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
