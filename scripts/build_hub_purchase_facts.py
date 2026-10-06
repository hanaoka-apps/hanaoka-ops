#!/usr/bin/env python3
"""HUB「会社の現在地」の仕入カード用に、軽量なデータファイルを作る。

value_analysis.json(付加価値分析。品目別・工数なども入った大きなファイルで、数百MBに
なることがある)から、日別仕入だけを取り出して data/hub_purchase_facts.json に書く。
HUB はこの小さいファイルだけを SharedMasters から読む(value_analysis.json は読まない)。

出力(直近2か月ぶん。前月同日比を出すため):
  {
    "generated_at": "2026-10-06T16:40:00+09:00",
    "updated_at":   "2026-10-06 16:31 JST",     # 日別仕入の取込時刻(value_analysis の meta)
    "latest_date":  "2026-10-05",               # 日別仕入にある最新の伝票日付
    "status": "ok" | "blocked" | ...,           # 日別仕入の取込状態
    "daily_status": "ok" | "partial" | ...,
    "months": {
      "202610": {
        "days": {"2026-10-01": {"total": 123, "zones": {"第一工場": 100}, "unclassified": 0}, ...},
        "monthly_purchase": 488140             # 月次仕入(確定月の保存値を含む。無ければ null)
      },
      "202609": {...}
    }
  }
金額・日付の意味は FUJIN の「日別仕入金額」(fujin/value_analysis.html の renderPurchaseDaily)と同じ。
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SOURCE = BASE / "data" / "value_analysis.json"
DESTINATION = BASE / "data" / "hub_purchase_facts.json"
KEEP_MONTHS = 2


def build(source: Path) -> dict:
    data = json.loads(source.read_text(encoding="utf-8-sig"))
    meta = data.get("meta") or {}
    imp = meta.get("daily_purchase_import") or {}
    daily = data.get("purchase_daily_by_month") or {}
    monthly = data.get("monthly") or {}

    months = {}
    for ym in sorted(daily)[-KEEP_MONTHS:]:
        total = ((monthly.get(ym) or {}).get("total") or {}).get("purchase")
        months[ym] = {"days": daily[ym], "monthly_purchase": total}

    jst = timezone(timedelta(hours=9))
    return {
        "generated_at": datetime.now(jst).isoformat(timespec="seconds"),
        "updated_at": meta.get("daily_purchase_updated_at"),
        "latest_date": meta.get("daily_purchase_latest_date"),
        "status": imp.get("status"),
        "daily_status": imp.get("daily_status"),
        "months": months,
    }


def main() -> int:
    if not SOURCE.is_file():
        print(f"[WARN] {SOURCE.name} が無いため hub_purchase_facts.json は作りません")
        return 0
    out = build(SOURCE)
    DESTINATION.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    days = sum(len(m["days"]) for m in out["months"].values())
    print(f"[OK] hub_purchase_facts.json: {len(out['months'])}か月 / {days}日 / 最新 {out['latest_date']} ({DESTINATION.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
