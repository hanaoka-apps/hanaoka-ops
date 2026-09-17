#!/usr/bin/env python3
"""正式な構成マスタを付加価値分析JSONの品目詳細へ接続する。

構成マスタは読み取り専用で扱い、通常構成だけを全階層展開する。
構成品の月次原価はブラウザ側が standard_cost_history から対象月ごとに解決するため、
ここでは構成階層・必要数・品目名だけを保存する。
"""

from __future__ import annotations

import argparse
import csv
import json
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"


def normalize_code(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().strip('"').upper()


def number(value: object, default: float = 0.0) -> float:
    try:
        return float(str(value or "").replace(",", "").strip().strip('"'))
    except (TypeError, ValueError):
        return default


def delimiter_for(path: Path) -> str:
    with path.open(encoding="utf-8-sig", errors="replace") as handle:
        first = handle.readline()
    return "\t" if first.count("\t") > first.count(",") else ","


def read_bom(path: Path) -> tuple[dict[str, list[dict]], dict[str, int]]:
    """通常構成を読み、同一親子の重複・製番別構成・無効行を除く。"""
    children: dict[str, list[dict]] = defaultdict(list)
    seen: set[tuple[str, str]] = set()
    stats = {"source_rows": 0, "edges": 0, "duplicates": 0, "invalid": 0, "seiban": 0}
    today = datetime.now().strftime("%Y%m%d")

    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        for row in csv.DictReader(handle, delimiter=delimiter_for(path)):
            stats["source_rows"] += 1
            dummy = str(row.get("ﾀﾞﾐｰ構成区分") or "0").strip().strip('"')
            stop = str(row.get("展開ｽﾄｯﾌﾟ区分") or "0").strip().strip('"')
            prohibited = str(row.get("使用禁止日") or "0").strip().strip('"')
            if dummy not in ("", "0") or stop not in ("", "0"):
                stats["invalid"] += 1
                continue
            if (prohibited not in ("", "0", "00000000") and len(prohibited) == 8
                    and prohibited.isdigit() and prohibited <= today):
                stats["invalid"] += 1
                continue

            seiban = normalize_code(row.get("製番"))
            if seiban not in ("", "0", "000000000000", "0000000000-00"):
                stats["seiban"] += 1
                continue

            parent = normalize_code(row.get("親品目ｺｰﾄﾞ") or row.get("親品目コード"))
            child = normalize_code(row.get("子品目ｺｰﾄﾞ") or row.get("子品目コード"))
            if not parent or not child:
                continue
            key = (parent, child)
            if key in seen:
                stats["duplicates"] += 1
                continue
            seen.add(key)

            numerator = number(row.get("取数(分子)") or row.get("取数（分子）"), 1.0) or 1.0
            denominator = number(row.get("取数(分母)") or row.get("取数（分母）"), 1.0) or 1.0
            children[parent].append({
                "code": child,
                "name": str(row.get("子品目名") or "").strip().strip('"'),
                "quantity": numerator / denominator,
            })
            stats["edges"] += 1
    return dict(children), stats


def expand(root: str, children: dict[str, list[dict]], max_depth: int = 30) -> tuple[list[dict], int]:
    """親品目を構成順の深さ優先で全階層展開する。循環はその枝だけ停止する。"""
    result: list[dict] = []
    cycles = 0

    def walk(parent: str, level: int, cumulative: float, ancestors: frozenset[str]) -> None:
        nonlocal cycles
        if level > max_depth:
            cycles += 1
            return
        for child in children.get(parent, []):
            code = child["code"]
            quantity = cumulative * child["quantity"]
            result.append({
                "level": level,
                "parent": parent,
                "code": code,
                "name": child["name"] or code,
                "quantity": round(quantity, 8),
            })
            if code in ancestors:
                cycles += 1
                continue
            walk(code, level + 1, quantity, ancestors | {code})

    walk(root, 1, 1.0, frozenset({root}))
    return result, cycles


def merge(destination: Path, bom_path: Path) -> dict[str, int]:
    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    analysis = output.get("item_analysis")
    if not isinstance(analysis, dict) or not isinstance(analysis.get("items"), dict):
        raise ValueError(f"item_analysis.itemsがありません: {destination.name}")

    children, source_stats = read_bom(bom_path)
    roots = analysis["items"]
    connected = component_rows = cycles = 0
    for raw_code, item in roots.items():
        code = normalize_code(raw_code)
        rows, row_cycles = expand(code, children)
        item["bom"] = rows
        if rows:
            connected += 1
            component_rows += len(rows)
        cycles += row_cycles

    analysis["bom_status"] = (
        f"構成マスタの通常構成を全階層で接続済みです。"
        f"{connected:,}品目・{component_rows:,}構成行を表示します。"
        "構成品原価は選択月の品目別積上原価から取得し、未設定品は未設定と表示します。"
    )
    output.setdefault("meta", {}).update({
        "bom_source": bom_path.name,
        "bom_connected_items": connected,
        "bom_component_rows": component_rows,
    })
    destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {
        **source_stats,
        "roots": len(roots),
        "connected": connected,
        "component_rows": component_rows,
        "cycles": cycles,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, default=DATA / "value_analysis.json")
    parser.add_argument("--bom", type=Path, default=DATA / "構成マスタ.csv")
    args = parser.parse_args()
    if not args.destination.is_file():
        print(f"[WARN] {args.destination.name}が無いため構成接続をスキップ")
        return 0
    if not args.bom.is_file():
        print(f"[WARN] {args.bom.name}が無いため構成接続をスキップ")
        return 0
    stats = merge(args.destination, args.bom)
    print(
        f"[OK] 構成を接続: {stats['connected']:,}/{stats['roots']:,}品目 / "
        f"{stats['component_rows']:,}構成行 / 通常構成{stats['edges']:,}辺 "
        f"(重複除去{stats['duplicates']:,} / 無効除外{stats['invalid']:,} / "
        f"製番別除外{stats['seiban']:,} / 循環停止{stats['cycles']:,})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
