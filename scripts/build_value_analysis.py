"""FUJIN 全社付加価値・在庫分析の認証配信用JSONを生成する。

現段階では Claude Cowork 引継ぎの集計済み d5.json / check.json を入力にする
移行ビルダー。元CSVからの月次自動生成へ切り替えるまでの間も、公開HTMLへ
業務データを埋め込まず SharePoint 認証配信の構成を守る。

入力ディレクトリは次の順で解決する。
1. FUJIN_VALUE_HANDOFF_DIR 環境変数
2. data/value_analysis_handoff/

出力: data/value_analysis.json（data/ は .gitignore 対象）
"""

from __future__ import annotations

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from value_analysis_store import load_snapshot, save_snapshot
from value_analysis_inventory import attach_inventory_breakdown, load_manual_inventory


BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
ZONES = ["第一工場", "第二工場", "第三工場", "購買", "運賃"]


def number(value: str | None) -> float | None:
    text = (value or "").strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def sharedmaster_file(filename: str) -> Path | None:
    """日次ビルドで取得したSharedMastersファイルを解決する。"""
    candidates = []
    configured = os.environ.get("FUJIN_SHARED_MASTERS_DIR", "").strip()
    if configured:
        candidates.append(Path(configured) / filename)
    candidates.extend((DATA / "_sharedmasters_latest" / filename, DATA / filename))
    return next((path for path in candidates if path.is_file()), None)


def read_daily_purchase_totals() -> tuple[dict[str, int], str | None]:
    """受入明細の受入金額を年月別に再集計する。

    累積加算ではなく毎回明細全体から再計算するため、日次実行しても重複しない。
    """
    path = sharedmaster_file("受入明細出力.csv")
    if path is None:
        return {}, None
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        first = handle.readline()
        delimiter = "\t" if first.count("\t") > first.count(",") else ","
        handle.seek(0)
        reader = csv.DictReader(handle, delimiter=delimiter)
        headers = reader.fieldnames or []
        missing = [name for name in ("伝票日付", "受入金額") if name not in headers]
        if missing:
            raise ValueError(f"受入明細出力.csv に必要列がありません: {missing}")
        totals: dict[str, float] = defaultdict(float)
        for row in reader:
            digits = "".join(character for character in (row.get("伝票日付") or "") if character.isdigit())
            amount = number(row.get("受入金額"))
            if len(digits) < 6 or amount is None:
                continue
            totals[digits[:6]] += amount
    return {ym: round(value) for ym, value in totals.items()}, path.name


def merge_daily_purchases(output: dict) -> int:
    """未確定月の全社仕入だけをSharedMastersの日次受入実績で更新する。

    工場配賦の根拠はまだ確定していないため、全社合計だけを更新する。
    月次確定済みの値は上書きしない。
    """
    totals, source_name = read_daily_purchase_totals()
    if not totals:
        return 0
    finalized = set(output.get("finalized_months", []))
    updated = 0
    for ym, purchase in totals.items():
        if ym in finalized or ym not in output.get("monthly", {}):
            continue
        month = output["monthly"][ym]
        month.setdefault("total", {})["purchase"] = purchase
        recalculate(month["total"])
        status = output.setdefault("month_status", {}).setdefault(ym, {})
        status.update({"state": "collecting", "is_finalized": False})
        updated += 1
    if updated:
        output.setdefault("meta", {})["daily_purchase_source"] = source_name
        output["meta"]["daily_purchase_updated_at"] = datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M JST")
    return updated


def merge_manual_inventory(output: dict) -> int:
    configured = os.environ.get("FUJIN_MANUAL_INVENTORY_FILE", "").strip()
    path = Path(configured) if configured else DATA / "inventory_manual.csv"
    manual = load_manual_inventory(path)
    attach_inventory_breakdown(output, manual)
    if manual:
        output.setdefault("meta", {})["manual_inventory_source"] = path.name
    return sum(len(month.get("rows", [])) for month in manual.values())


def read_item_master() -> dict[str, dict]:
    """品目マスタから分類コード、適正在庫数量、原価内訳を読み取る。"""
    path = DATA / "品目マスタ.txt"
    if not path.is_file():
        return {}
    result: dict[str, dict] = {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle, delimiter="\t")
        for row in rows:
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code or code.startswith("<"):
                continue
            cost_candidates = [
                ("原価計", number(row.get("原価計"))),
                ("粗利算出用単価", number(row.get("粗利算出用単価"))),
                ("在庫評価単価", number(row.get("在庫評価単価"))),
                ("標準仕入単価", number(row.get("標準仕入単価"))),
            ]
            component_cost_source, component_cost = next(
                ((name, value) for name, value in cost_candidates if value is not None and value > 0),
                ("未設定", 0),
            )
            result[code] = {
                "dc": (row.get("大分類ｺｰﾄﾞ") or "").strip(),
                "d": (row.get("大分類名") or "").strip(),
                "cc": (row.get("中分類ｺｰﾄﾞ") or "").strip(),
                "c": (row.get("中分類名") or "").strip(),
                "sc": (row.get("小分類ｺｰﾄﾞ") or "").strip(),
                "s": (row.get("小分類名") or "").strip(),
                "proper_stock_qty": number(row.get("適正在庫数量")),
                "cost_parts": {
                    "material": number(row.get("材料費")) or 0,
                    "labor": number(row.get("労務費")) or 0,
                    "outsourcing": number(row.get("外注費")) or 0,
                    "expense": number(row.get("経費")) or 0,
                    "total": number(row.get("原価計")) or 0,
                },
                "component_cost": component_cost,
                "component_cost_source": component_cost_source,
            }
    return result


def read_bom(item_master: dict[str, dict], wanted: set[str]) -> dict[str, list[dict]]:
    """対象品目の全構成階層と、取得できる構成品原価を返す。"""
    path = DATA / "構成マスタ.csv"
    if not path.is_file():
        return {}
    graph: dict[str, list[dict]] = defaultdict(list)
    seen_edges: set[tuple[str, str, float]] = set()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            parent = (row.get("親品目ｺｰﾄﾞ") or "").strip()
            child = (row.get("子品目ｺｰﾄﾞ") or "").strip()
            if not parent or not child:
                continue
            qty_num = number(row.get("取数(分子)")) or 0
            qty_den = number(row.get("取数(分母)")) or 1
            quantity = qty_num / qty_den if qty_den else 0
            edge = (parent, child, quantity)
            if edge in seen_edges:
                continue
            seen_edges.add(edge)
            graph[parent].append({
                "code": child,
                "name": (row.get("子品目名") or "").strip(),
                "quantity": quantity,
            })

    result: dict[str, list[dict]] = {}
    for root in wanted:
        flattened: list[dict] = []

        def walk(parent: str, effective_parent_qty: float, level: int, path_codes: tuple[str, ...]) -> None:
            if level > 12:
                return
            for child_row in graph.get(parent, []):
                child = child_row["code"]
                if child in path_codes:
                    continue
                quantity = child_row["quantity"]
                effective_quantity = effective_parent_qty * quantity
                master_row = item_master.get(child, {})
                unit_cost = master_row.get("component_cost") or 0
                flattened.append({
                    "level": level,
                    "parent": parent,
                    "code": child,
                    "name": child_row["name"],
                    "quantity": round(effective_quantity, 6),
                    "unit_cost": unit_cost,
                    "extended_cost": round(unit_cost * effective_quantity),
                    "cost_source": master_row.get("component_cost_source", "未設定"),
                    "previous_unit_cost": None,
                    "cost_delta": None,
                })
                walk(child, effective_quantity, level + 1, (*path_codes, child))

        walk(root, 1, 1, (root,))
        if flattened:
            result[root] = flattened
    return result


def read_lowest_sales() -> dict[str, dict]:
    """品目・月ごとの最低売価明細を、詳細表示用に1件だけ保持する。"""
    path = DATA / "売上明細出力.csv"
    if not path.is_file():
        return {}
    result: dict[str, dict] = {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            ym = (row.get("年月度") or "").strip()
            code = (row.get("品目ｺｰﾄﾞ") or "").strip()
            unit_price = number(row.get("単価"))
            if not ym or not code or unit_price is None:
                continue
            key = f"{ym}:{code}"
            if key in result and result[key]["unit_price"] <= unit_price:
                continue
            quantity = number(row.get("数量")) or 0
            result[key] = {
                "sales_no": (row.get("売上№") or "").strip(),
                "date": (row.get("伝票日付") or "").strip(),
                "customer": (row.get("得意先名略称") or row.get("得意先名１") or "").strip(),
                "quantity": quantity,
                "unit_price": unit_price,
                "amount": round(unit_price * quantity),
            }
    return result


def enrich_item_analysis(analysis: dict) -> dict:
    """分類順・明細・構成原価の表示に必要な非公開情報を付加する。"""
    items = analysis.get("items", {})
    master = read_item_master()
    bom = read_bom(master, set(items))
    for code, item in items.items():
        source = master.get(code, {})
        for key in ("dc", "cc", "sc"):
            item[key] = source.get(key, "")
        for key in ("d", "c", "s"):
            if source.get(key):
                item[key] = source[key]
        item["proper_stock_qty"] = source.get("proper_stock_qty")
        item["master_cost_parts"] = source.get("cost_parts", {})
        item["bom"] = bom.get(code, [])
    analysis["lowest_sales"] = read_lowest_sales()
    analysis.setdefault(
        "standard_cost_history_status",
        "月別の標準原価マスタ履歴は未接続です。前月差は取得できた月だけ表示します。",
    )
    return analysis


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"入力ファイルがありません: {path.name}")
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} のルートはobjectである必要があります")
    return value


def ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return round(numerator / denominator * 100, 1)


def zone_row(source: dict) -> dict:
    sales = source.get("sales")
    purchase = source.get("buy", source.get("purchase"))
    current = source.get("zc", source.get("current_inventory"))
    previous = source.get("zp", source.get("previous_inventory"))
    change = source.get("zd", source.get("inventory_change"))
    if change is None and current is not None and previous is not None:
        change = current - previous
    value_added = source.get("va", source.get("value_added"))
    if value_added is None and sales is not None and purchase is not None and change is not None:
        value_added = sales - purchase + change
    return {
        "sales": sales,
        "purchase": purchase,
        "current_inventory": current,
        "previous_inventory": previous,
        "inventory_change": change,
        "value_added": value_added,
        "value_added_rate": source.get("vr", ratio(value_added, sales)),
        "purchase_rate": ratio(purchase, sales),
        "inventory_contribution_rate": ratio(change, sales),
    }


def total_row(rows: dict[str, dict]) -> dict:
    fields = ["sales", "purchase", "current_inventory", "previous_inventory", "inventory_change", "value_added"]
    result: dict[str, float | None] = {}
    for field in fields:
        values = [row.get(field) for row in rows.values()]
        result[field] = sum(values) if values and all(value is not None for value in values) else None
    result["value_added_rate"] = ratio(result["value_added"], result["sales"])
    result["purchase_rate"] = ratio(result["purchase"], result["sales"])
    result["inventory_contribution_rate"] = ratio(result["inventory_change"], result["sales"])
    return result


def recalculate(row: dict) -> None:
    sales, purchase = row.get("sales"), row.get("purchase")
    current, previous = row.get("current_inventory"), row.get("previous_inventory")
    if current is not None and previous is not None:
        row["inventory_change"] = current - previous
    change = row.get("inventory_change")
    if sales is not None and purchase is not None and change is not None:
        row["value_added"] = sales - purchase + change
    value_added = row.get("value_added")
    row["value_added_rate"] = ratio(value_added, sales)
    row["purchase_rate"] = ratio(purchase, sales)
    row["inventory_contribution_rate"] = ratio(change, sales)


def merge_financial_overlay(monthly: dict, overlay: dict) -> None:
    """決算資料は欠損だけを補完し、検算済みの既存実績は上書きしない。"""
    fields = ("sales", "purchase", "previous_inventory", "current_inventory", "inventory_change")
    for ym, supplied_month in overlay.get("monthly", {}).items():
        if ym not in monthly:
            continue
        target_month = monthly[ym]
        for group in ("total", "zones"):
            if group == "total":
                pairs = [(target_month["total"], supplied_month.get("total", {}))]
            else:
                pairs = [(target_month["zones"].setdefault(zone, zone_row({})), source) for zone, source in supplied_month.get("zones", {}).items()]
            for target, source in pairs:
                for field in fields:
                    if target.get(field) is None and source.get(field) is not None:
                        target[field] = source[field]
                recalculate(target)


def make_months(d5: dict) -> tuple[dict, str]:
    months: dict[str, dict] = {}
    actual = d5.get("act", {})
    actual_month = actual.get("ym", "")
    for ym in d5.get("yms", []):
        zone_values: dict[str, dict] = {}
        if ym == actual_month:
            for zone in ZONES:
                zone_values[zone] = zone_row(actual.get("rows", {}).get(zone, {}))
            total = zone_row(actual.get("tot", {}))
        else:
            sales = d5.get("sales", {}).get(ym, {})
            purchases = d5.get("buy", {}).get(ym, {})
            for zone in ZONES:
                # 伝票倉庫で識別できる工場分のみ。購買への切り分け根拠は未確定。
                purchase = purchases.get(zone) if zone in {"第一工場", "第二工場", "第三工場"} else None
                zone_values[zone] = zone_row({"sales": sales.get(zone), "buy": purchase})
            total = total_row(zone_values)
        months[ym] = {"zones": zone_values, "total": total}
    return months, actual_month


def check_item(identifier: int, name: str, status: str, summary: str, count: int | None, source: str) -> dict:
    return {"id": identifier, "name": name, "status": status, "summary": summary, "affected_count": count, "source": source}


def make_checks(check: dict, monthly: dict, actual_month: str) -> list[dict]:
    actual = monthly.get(actual_month, {})
    zone_rows = actual.get("zones", {})
    calculated_total = total_row(zone_rows)
    stated_total = actual.get("total", {})
    total_fields = ("sales", "purchase", "current_inventory", "inventory_change")
    totals_ok = all(calculated_total.get(field) == stated_total.get(field) for field in total_fields)
    inventory_rows = check.get("tana_rows")
    book_equal = check.get("book_eq_actual")
    coverage = check.get("cover")
    missing_cost = check.get("nostd")
    code_mismatch = check.get("code_mismatch", missing_cost)
    negative = check.get("tana_neg")
    cost_gap = check.get("stk_gap")
    three_digit_inventory = check.get("tana3")
    second_factory_rows = check.get("f2_rows")
    unclassified = check.get("sales_unclassified")
    tax_rows = check.get("tax_rows")
    continuity_gap = check.get("inventory_continuity_gap")
    zero_cost_inventory = check.get("zero_cost_inventory")
    return [
        check_item(1, "売上の分類漏れ", "needs_review" if unclassified else "ok" if unclassified == 0 else "pending", f"分類が空欄の売上明細が{unclassified}件" if unclassified is not None else "分類漏れを判定する明細が未接続", unclassified, "売上明細出力.csv"),
        check_item(2, "縦計の一致", "ok" if totals_ok else "needs_review", "工場合計とTOが一致" if totals_ok else "工場合計とTOに差があります", 0 if totals_ok else None, "付加価値月次集計"),
        check_item(3, "消費税行の除外", "ok" if tax_rows is not None else "pending", f"消費税行を{tax_rows}件除外" if tax_rows is not None else "除外前後を判定する明細が未接続", tax_rows, "売上明細出力.csv"),
        check_item(4, "在庫の単価カバー率", "ok" if coverage is not None and coverage >= 98 else "warning" if coverage is not None else "pending", f"単価取得率 {coverage:.1f}%" if coverage is not None else "単価取得率を算出するデータが未接続", missing_cost, "棚卸明細・積上原価一覧"),
        check_item(5, "品目コードの表記不一致", "needs_review" if code_mismatch else "ok" if code_mismatch == 0 else "pending", f"棚卸コードと原価表コードが一致しない行が{code_mismatch}件" if code_mismatch is not None else "棚卸・原価表の突合データが未接続", code_mismatch, "棚卸明細・積上原価一覧"),
        check_item(6, "マイナス在庫", "warning" if negative else "ok" if negative == 0 else "pending", f"実地棚卸数量がマイナスの行が{negative}件" if negative is not None else "棚卸明細が未接続", negative, "棚卸明細出力"),
        check_item(7, "帳簿在庫と実地棚卸の差異", "ok" if inventory_rows is not None and inventory_rows == book_equal else "needs_review" if inventory_rows is not None and book_equal is not None else "pending", "全棚卸行で一致" if inventory_rows is not None and inventory_rows == book_equal else "一致しない行があります" if inventory_rows is not None and book_equal is not None else "棚卸明細が未接続", 0 if inventory_rows is not None and inventory_rows == book_equal else None, "棚卸明細出力"),
        check_item(8, "標準原価の更新前後の乖離", "needs_review" if cost_gap else "ok" if cost_gap == 0 else "pending", f"1%を超えて乖離する品目が{cost_gap}件" if cost_gap is not None else "比較用原価データが未接続", cost_gap, "品目別積上原価一覧"),
        check_item(9, "3桁コード品目の在庫計上", "warning" if three_digit_inventory == 0 else "ok" if three_digit_inventory is not None else "pending", "棚卸計上なし（在庫管理外の構造）" if three_digit_inventory == 0 else "棚卸計上あり" if three_digit_inventory is not None else "棚卸明細が未接続", three_digit_inventory, "棚卸明細出力"),
        check_item(10, "在庫を持つべき工場の欠落", "warning" if second_factory_rows is not None and second_factory_rows <= 4 else "ok" if second_factory_rows is not None else "pending", f"第二工場の棚卸行は{second_factory_rows}件" if second_factory_rows is not None else "工場別棚卸明細が未接続", second_factory_rows, "棚卸明細出力"),
        check_item(11, "前月末在庫と当月初在庫の連続性", "needs_review" if continuity_gap else "ok" if continuity_gap == 0 else "pending", f"前月末と当月初が一致しない品目が{continuity_gap}件" if continuity_gap is not None else "前月・当月棚卸データが未接続", continuity_gap, "前月・当月棚卸明細"),
        check_item(12, "在庫評価単価0の品目", "needs_review" if zero_cost_inventory else "ok" if zero_cost_inventory == 0 else "pending", f"在庫を持ち評価単価が0の品目が{zero_cost_inventory}件" if zero_cost_inventory is not None else "在庫数量と評価単価の突合データが未接続", zero_cost_inventory, "棚卸明細・積上原価一覧"),
    ]


def ensure_monthly_checks(output: dict) -> None:
    checks_by_month = output.setdefault("checks_by_month", {})
    for ym in output.get("months", []):
        if len(checks_by_month.get(ym, [])) != 12:
            checks_by_month[ym] = make_checks({}, output.get("monthly", {}), ym)
        for item in checks_by_month[ym]:
            if item.get("id") == 5 and item.get("name") != "品目コードの表記不一致":
                item["name"] = "品目コードの表記不一致"
                count = item.get("affected_count")
                item["summary"] = (
                    f"棚卸コードと原価表コードが一致しない行が{count}件（表記揺れを含む）"
                    if count is not None else "棚卸・原価表の突合データが未接続"
                )


def main() -> int:
    source_dir = Path(os.environ.get("FUJIN_VALUE_HANDOFF_DIR", DATA / "value_analysis_handoff"))
    try:
        destination = DATA / "value_analysis.json"
        # Claude引継ぎ元が退避済みの環境では、検算済みの既存スナップショットを
        # 壊さず、品目マスタ由来の補助情報だけを更新する。
        if not (source_dir / "d5.json").is_file() and destination.is_file():
            output = load_json(destination)
            daily_purchase_months = merge_daily_purchases(output)
            manual_inventory_rows = merge_manual_inventory(output)
            ensure_monthly_checks(output)
            items_path = DATA / "value_analysis_items.json"
            if items_path.is_file():
                output["item_analysis"] = enrich_item_analysis(load_json(items_path))
            output.setdefault("meta", {})["generated_at"] = datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M JST")
            destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"[OK] {destination.name} を更新しました ({len(output.get('item_analysis', {}).get('items', {}))}品目 / 日次仕入{daily_purchase_months}か月 / Excel別管理在庫{manual_inventory_rows}行)")
            return 0
        d5 = load_json(source_dir / "d5.json")
        check = load_json(source_dir / "check.json")
        monthly, actual_month = make_months(d5)
        overlay_path = DATA / "value_analysis_financial_overlay.json"
        overlay = load_json(overlay_path) if overlay_path.is_file() else {}
        merge_financial_overlay(monthly, overlay)
        if not actual_month or actual_month not in monthly:
            raise ValueError("d5.json に検算済み基準月がありません")
        output = {
            "schema_version": 1,
            "meta": {
                "generated_at": datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d %H:%M JST"),
                "source": "Claude Cowork引継ぎ集計＋非公開の月次決算補完（移行期間）",
                "notice": "月次決算資料で不足項目を補完しました。既に検算済みの値は上書きせず、進行月は未確定のまま表示します。",
            },
            "months": list(monthly),
            "default_month": actual_month,
            # 移行入力では検算済み基準月だけを月次確定扱いにする。
            # 正規運用ではSharePoint側の月次確定台帳から明示指定する。
            "finalized_months": sorted(set([actual_month, *overlay.get("finalized_months", [])])),
            "zones": ZONES,
            "monthly": monthly,
            "checks_by_month": {actual_month: make_checks(check, monthly, actual_month)},
        }
        merge_daily_purchases(output)
        merge_manual_inventory(output)
        ensure_monthly_checks(output)
        DATA.mkdir(parents=True, exist_ok=True)
        database = Path(os.environ.get("FUJIN_VALUE_DB_PATH", DATA / "value_analysis.sqlite3"))
        save_snapshot(database, output)
        output = load_snapshot(database)
        merge_manual_inventory(output)
        output["sales_departments_by_month"] = {
            ym: month["sales_departments"]
            for ym, month in overlay.get("monthly", {}).items()
            if "sales_departments" in month
        }
        items_path = DATA / "value_analysis_items.json"
        if items_path.is_file():
            output["item_analysis"] = enrich_item_analysis(load_json(items_path))
        destination.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(
            f"[OK] {database.name} に保存し {destination.name} を生成しました "
            f"({len(output['months'])}か月 / 基準月 {actual_month})"
        )
        return 0
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
