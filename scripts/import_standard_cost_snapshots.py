"""SharedMastersの月次積上原価表を既存の付加価値分析JSONへ追加する。

元の売上・在庫・仕入データは保持し、item_analysis内の標準原価履歴だけを更新する。
対象年月はファイル名ではなく帳票2行目から取得する。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"


def normalize_code(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().upper()


def source_rows(path: Path):
    if path.suffix.lower() == ".xlsx":
        from openpyxl import load_workbook

        workbook = load_workbook(path, read_only=True, data_only=True)
        try:
            yield from workbook.active.iter_rows(values_only=True)
        finally:
            workbook.close()
        return
    if path.suffix.lower() != ".csv":
        raise ValueError(f"対応していないファイル形式です: {path.name}")
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        yield from csv.reader(handle)


def parse(path: Path) -> tuple[str, dict[str, dict], int, int]:
    rows = iter(source_rows(path))
    title = next(rows, [])
    target = next(rows, [])
    headers = next(rows, [])
    if not title or "品目別積上原価一覧表" not in str(title[0] or ""):
        raise ValueError(f"帳票タイトルを確認できません: {path.name}")
    match = re.search(r"(\d{4})年\s*(\d{1,2})月", str(target[0] or "") if target else "")
    if not match:
        raise ValueError(f"対象年月を確認できません: {path.name}")
    ym = f"{int(match.group(1)):04d}{int(match.group(2)):02d}"
    if len(headers) < 16 or headers[0] != "コード" or headers[15] != "積上原価計":
        raise ValueError(f"列構成が想定と異なります: {path.name}")

    costs: dict[str, dict] = {}
    duplicates = conflicts = 0
    for row in rows:
        if len(row) < 16:
            continue
        code = normalize_code(row[0])
        if not code:
            continue

        def number(index: int) -> float:
            value = row[index]
            if isinstance(value, str):
                value = value.replace(",", "").strip()
            try:
                return float(value or 0)
            except (TypeError, ValueError):
                return 0

        current = {
            "name": str(row[1] or "").strip(),
            "department_code": str(row[2] or "").strip(),
            "department_name": str(row[3] or "").strip(),
            "inventory_unit_cost": number(4),
            "variation_rate": number(5),
            "material": number(11),
            "labor": number(12),
            "outsourcing": number(13),
            "expense": number(14),
            "total": number(15),
            "error": str(row[16] or "").strip() if len(row) > 16 else "",
            "source": path.name,
        }
        if code in costs:
            duplicates += 1
            conflicts += costs[code]["total"] != current["total"]
            # 帳票の後続0円行で正しい先頭行を上書きしない。
            continue
        costs[code] = current
    return ym, costs, duplicates, conflicts


def previous_month(ym: str) -> str:
    year, month = int(ym[:4]), int(ym[4:])
    if month == 1:
        return f"{year - 1}12"
    return f"{year}{month - 1:02d}"


def merge(path: Path, destination: Path) -> tuple[str, int, int]:
    output = json.loads(destination.read_text(encoding="utf-8"))
    items = output.get("item_analysis")
    if not isinstance(items, dict):
        raise ValueError(f"item_analysisがありません: {destination.name}")
    ym, costs, duplicates, conflicts = parse(path)
    if duplicates:
        print(f"[WARN] {path.name}: 重複{duplicates}行（原価相違{conflicts}行）は先頭行を採用")
    history = items.setdefault("standard_cost_history", {})
    history[ym] = costs
    months = items.setdefault("months", [])
    if ym not in months:
        months.append(ym)
        months.sort()

    prior = history.get(previous_month(ym), {})
    updated = missing = 0
    for row in items.get("rows", []):
        if row.get("y") != ym:
            continue
        current = costs.get(normalize_code(row.get("i")))
        if current is None:
            continue
        total = current["total"]
        row["st"] = total
        row["mt"] = current["material"]
        row["ot"] = current["labor"] + current["outsourcing"] + current["expense"]
        row["previous_standard_cost"] = prior.get(normalize_code(row.get("i")), {}).get("total")
        sales, quantity = row.get("a"), row.get("q")
        if total > 0 and sales is not None and quantity is not None:
            row["va"] = round(sales - total * quantity)
            row["vr"] = round(row["va"] / sales * 100, 1) if sales else None
        else:
            row["va"] = row["vr"] = None
            missing += 1
        updated += 1
    items["standard_cost_history_status"] = (
        f"{ym[:4]}年{int(ym[4:])}月の品目別積上原価一覧表を反映済みです。"
        "前月値は保存済みの月次表がある品目だけを表示します。"
    )
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return ym, updated, missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--destination", type=Path, default=DATA / "value_analysis.json")
    args = parser.parse_args()
    if not args.destination.is_file():
        print(f"[WARN] {args.destination.name}が無いため標準原価取込をスキップ")
        return 0
    for source in args.sources:
        ym, updated, missing = merge(source, args.destination)
        print(f"[OK] {source.name}: {ym} / 売上{updated}行を更新 / 原価未設定{missing}行")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
