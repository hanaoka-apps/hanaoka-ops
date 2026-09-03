"""Excel別管理在庫を認証配信用の付加価値JSONへ取り込む。

実データは ``data/inventory_manual.csv``（公開対象外）に置く。CSVはUTF-8 BOM、
金額列はカンマ・通貨記号・全角数字を許容する。元データは変更しない。
"""

from __future__ import annotations

import csv
import unicodedata
from collections import defaultdict
from pathlib import Path


REQUIRED_COLUMNS = ("ym", "factory", "category", "item_name", "qty", "unit_price", "amount")
OPTIONAL_COLUMNS = ("material_amount", "labor_amount", "note", "updated_by", "updated_at")
FACTORIES = {"第一工場", "第二工場", "第三工場", "購買"}


def _text(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def _number(value: object) -> float | None:
    text = _text(value).replace(",", "").replace("円", "").replace("¥", "")
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    try:
        number = float(text)
    except ValueError as exc:
        raise ValueError(f"数値として読めません: {value!r}") from exc
    return -number if negative else number


def load_manual_inventory(path: Path) -> dict[str, dict]:
    if not path.is_file():
        return {}
    result: dict[str, dict] = {}
    totals: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    with path.open(encoding="utf-8-sig", errors="strict", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = tuple(reader.fieldnames or ())
        missing = [column for column in REQUIRED_COLUMNS if column not in headers]
        if missing:
            raise ValueError(f"inventory_manual.csv に必要列がありません: {missing}")
        for line_number, row in enumerate(reader, 2):
            ym = _text(row.get("ym")).replace("/", "").replace("-", "")
            factory = _text(row.get("factory"))
            if len(ym) != 6 or not ym.isdigit():
                raise ValueError(f"{line_number}行目: ymはYYYYMMで指定してください")
            if factory not in FACTORIES:
                raise ValueError(f"{line_number}行目: factoryが許可値ではありません")
            qty = _number(row.get("qty"))
            unit_price = _number(row.get("unit_price"))
            amount = _number(row.get("amount"))
            if amount is None and qty is not None and unit_price is not None:
                amount = qty * unit_price
            if amount is None:
                raise ValueError(f"{line_number}行目: amount、またはqty×unit_priceが必要です")
            item = {
                "factory": factory,
                "category": _text(row.get("category")),
                "item_name": _text(row.get("item_name")),
                "qty": qty,
                "unit_price": unit_price,
                "amount": round(amount),
                "material_amount": round(_number(row.get("material_amount")) or 0),
                "labor_amount": round(_number(row.get("labor_amount")) or 0),
                "note": _text(row.get("note")),
                "updated_by": _text(row.get("updated_by")),
                "updated_at": _text(row.get("updated_at")),
            }
            month = result.setdefault(ym, {"rows": [], "zones": {}, "total": 0})
            month["rows"].append(item)
            totals[(ym, factory)]["amount"] += amount
            totals[(ym, factory)]["material_amount"] += item["material_amount"]
            totals[(ym, factory)]["labor_amount"] += item["labor_amount"]
    for (ym, factory), values in totals.items():
        rounded = {key: round(value) for key, value in values.items()}
        result[ym]["zones"][factory] = rounded
        result[ym]["total"] += rounded["amount"]
    return result


def attach_inventory_breakdown(output: dict, manual: dict[str, dict]) -> None:
    """月次決算の在庫総額からExcel別管理分を分離して表示用に保持する。

    月次決算値を正として上書きしない。FUJIN在庫は「月次決算総額－Excel別管理」
    として算出し、マイナスになる場合は不整合としてnullにする。
    """
    breakdown: dict[str, dict] = {}
    for ym, month in output.get("monthly", {}).items():
        manual_month = manual.get(ym)
        connected = manual_month is not None
        manual_month = manual_month or {"zones": {}, "rows": [], "total": 0}
        zone_rows: dict[str, dict] = {}
        for zone in output.get("zones", []):
            reported = month.get("zones", {}).get(zone, {}).get("current_inventory")
            manual_amount = manual_month.get("zones", {}).get(zone, {}).get("amount") if connected else None
            fujin = None if reported is None or manual_amount is None or manual_amount > reported else reported - manual_amount
            zone_rows[zone] = {
                "reported_total": reported,
                "fujin": fujin,
                "manual": manual_amount,
                "reconciled": connected and reported is not None and fujin is not None,
            }
        total = month.get("total", {}).get("current_inventory")
        manual_total = manual_month.get("total") if connected else None
        breakdown[ym] = {
            "zones": zone_rows,
            "reported_total": total,
            "fujin": None if total is None or manual_total is None or manual_total > total else total - manual_total,
            "manual": manual_total,
            "rows": manual_month.get("rows", []),
        }
    output["inventory_breakdown_by_month"] = breakdown
