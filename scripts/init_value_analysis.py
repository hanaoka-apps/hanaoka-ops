"""付加価値分析JSONの安全な初期ファイルを作る。

公開リポジトリには業務データを置かず、日次処理でSharePointから取得した
売上・標準原価を後続スクリプトが反映できる最小構造だけを生成する。
既存ファイルがある場合は一切変更しない。
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


BASE = Path(__file__).resolve().parent.parent
DEFAULT_DESTINATION = BASE / "data" / "value_analysis.json"


def initial_payload() -> dict:
    generated_at = datetime.now(ZoneInfo("Asia/Tokyo")).isoformat(timespec="seconds")
    return {
        "schema_version": 1,
        "meta": {
            "generated_at": generated_at,
            "source": "SharedMasters（日次取得）",
            "notice": (
                "売上・受注・標準原価を日次データから反映します。"
                "仕入は伝票区分が仕入の明細だけを反映します。"
                "在庫は自由入力の確定行を反映します。"
            ),
        },
        "months": [],
        "default_month": "",
        "finalized_months": [],
        "month_status": {},
        "zones": ["第一工場", "第二工場", "第三工場", "購買", "運賃"],
        "monthly": {},
        "checks_by_month": {},
        "sales_departments_by_month": {},
        "item_analysis": {
            "basis": "標準原価ベースの参考分析",
            "notice": (
                "品目別付加価値額は売上－標準原価×数量です。"
                "仕入・在庫増減を使う月次サマリーとは計算方法が異なります。"
            ),
            "months": [],
            "items": {},
            "rows": [],
            "standard_cost_history": {},
            "standard_cost_history_status": "月別の標準原価を日次処理で更新します。",
        },
        "inventory_breakdown_by_month": {},
        "inventory_input_capabilities": {
            "schema_version": 1,
            "sources": {
                "manual": {"enabled": True, "label": "自由入力"},
                "iot": {"enabled": False, "label": "IoT（接続準備中）"},
            },
        },
    }


def initialize(destination: Path) -> bool:
    if destination.exists():
        print(f"[OK] {destination.name}は既存のため初期化しません")
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(initial_payload(), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"[OK] {destination.name}の安全な初期ファイルを作成しました")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()
    initialize(args.destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
