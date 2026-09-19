"""付加価値分析の月次確定状態を認証配信JSONへ保存する。

確定年月はコードへ固定せず、月次確定時の実行引数で受け取る。
JSONに既に存在する月だけを対象にし、将来月や存在しない月は生成しない。
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


BASE = Path(__file__).resolve().parent.parent
DEFAULT_DESTINATION = BASE / "data" / "value_analysis.json"
YM_PATTERN = re.compile(r"^\d{6}$")


def validate_ym(value: str) -> str:
    if not YM_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError("年月はYYYYMM形式で指定してください")
    month = int(value[4:])
    if month < 1 or month > 12:
        raise argparse.ArgumentTypeError("月は01から12で指定してください")
    return value


def apply_close_status(destination: Path, finalize_through: str) -> list[str]:
    output = json.loads(destination.read_text(encoding="utf-8-sig"))
    available_months = sorted({str(month) for month in output.get("months", [])})
    finalized = set(output.get("finalized_months", []))
    target_months = [month for month in available_months if month <= finalize_through]
    jst = timezone(timedelta(hours=9))
    updated_at = datetime.now(jst).strftime("%Y-%m-%d %H:%M JST")

    for month in target_months:
        finalized.add(month)
        output.setdefault("month_status", {}).setdefault(month, {}).update({
            "state": "finalized",
            "is_finalized": True,
            "updated_at": updated_at,
            "source": "monthly_close_control",
        })

    output["finalized_months"] = sorted(finalized)
    output.setdefault("meta", {})["monthly_close_control"] = {
        "status": "applied",
        "finalize_through": finalize_through,
        "updated_at": updated_at,
        "finalized_existing_months": len(target_months),
    }
    destination.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"[OK] 月次確定状態を保存: {len(target_months)}か月 / "
        f"確定対象の最終月 {finalize_through}"
    )
    return target_months


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--finalize-through", required=True, type=validate_ym)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    args = parser.parse_args()
    if not args.destination.is_file():
        print(f"[WARN] {args.destination.name} が無いため月次確定状態の保存をスキップ")
        return 0
    apply_close_status(args.destination, args.finalize_through)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
