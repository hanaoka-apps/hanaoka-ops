#!/usr/bin/env python3
"""当日入力率（受入）の集計用データを作る。

入力 : SharedMasters の 受入明細出力.csv（download_shared_masters.py が data/ に置く）
出力 : data/same_day_rate.json
配信 : upload_fujin_data.py が SharePoint の閲覧制限フォルダ（restricted_same_day_rate/）へ置く。
       そのフォルダを読める人（HL-幹部・石井絢子さん）だけに FUJIN の「当日入力率」が表示される。

遅れ = 操作日付（入力した日）− 伝票日付（入荷した日）。暦日。操作日付は日付のみ。
本人入力／代理入力 = 担当者名（発注の担当）とﾛｸﾞｲﾝ名（入力者）の名字一致で判定。
  「宮崎」と「宮崎 英美」、「齋藤」と「斎藤 拓也」のような表記ゆれがあるため、完全一致では判定しない。
月末の「消費税等」の行（明細区分＝消費税）は除く。

必要な列が無い場合も落とさず、meta.status="missing_columns" と不足列を出力する
（画面はその旨を表示する）。
"""
from __future__ import annotations

import csv
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
_SHARED_CANDIDATES = [
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    DATA,
]
SOURCE_NAME = "受入明細出力.csv"
OUT = DATA / "same_day_rate.json"
JST = ZoneInfo("Asia/Tokyo")

# 集計の開始月（年度の始め）。古すぎる明細は画面を重くするだけなので持たない。
START_YYYYMM = "202604"

FACTORY_BY_WAREHOUSE = {"鴻巣工場第一": "第一工場", "鴻巣工場第二": "第二工場", "鴻巣工場第三": "第三工場"}

COLS = {
    "slip_date": ("伝票日付", "受入日", "入荷日"),
    "op_date": ("操作日付", "入力日"),
    "inputter": ("ﾛｸﾞｲﾝ名", "ログイン名"),
    "owner": ("担当者名", "仕入担当者名"),
    "warehouse": ("倉庫名",),
    "supplier": ("仕入先名略称", "仕入先名１", "仕入先名1", "仕入先名"),
    "item_code": ("品目ｺｰﾄﾞ", "品目コード"),
    "item_name": ("品目名", "品目"),
    "qty": ("受入数量", "入荷数量", "数量"),
    "unit": ("入荷単位", "受入単位", "単位", "数量単位"),
    "po_no": ("発注№", "発注番号", "発注No"),
    "rc_no": ("受入№", "受入番号", "受入伝票№", "受入伝票番号"),
    "detail_kind": ("明細区分名", "明細区分"),
}
REQUIRED = ("slip_date", "op_date", "inputter", "owner")


def find_source() -> Path | None:
    for base in _SHARED_CANDIDATES:
        p = base / SOURCE_NAME
        if p.exists():
            return p
    return None


def pick(headers: list[str], names: tuple[str, ...]) -> str | None:
    norm = {h.strip().strip('"'): h for h in headers}
    for n in names:
        if n in norm:
            return norm[n]
    return None


def parse_ymd(s: str) -> date | None:
    s = re.sub(r"[^0-9]", "", s or "")
    if len(s) != 8:
        return None
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def norm_name(s: str) -> str:
    return re.sub(r"[\s　]|\(.*?\)|（.*?）", "", s or "").replace("齋", "斎")


def surname(s: str) -> str:
    return norm_name(re.split(r"[\s　]+", (s or "").strip())[0])


def is_self(owner: str, login: str) -> bool:
    a, sn = norm_name(login), surname(owner)
    return bool(a) and bool(sn) and a.startswith(sn)


def write(payload: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main() -> int:
    now = datetime.now(JST)
    meta = {"generated_at": now.isoformat(timespec="seconds"), "source": SOURCE_NAME, "status": "ok"}
    src = find_source()
    if src is None:
        meta.update(status="no_source")
        write({"meta": meta, "rows": []})
        print(f"[same_day_rate] {SOURCE_NAME} が見つからないため空データを出力")
        return 0
    meta["source_mtime"] = datetime.fromtimestamp(src.stat().st_mtime, JST).isoformat(timespec="seconds")

    with src.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        col = {k: pick(headers, v) for k, v in COLS.items()}
        missing = [COLS[k][0] for k in REQUIRED if not col[k]]
        if missing:
            meta.update(status="missing_columns", missing=missing)
            write({"meta": meta, "rows": []})
            print(f"[same_day_rate] 必要な列がありません: {missing}（ヘッダ先頭: {headers[:12]}）")
            return 0

        dic: dict[str, dict[str, int]] = {k: {} for k in ("fac", "wh", "sup", "own", "inp", "item")}

        def ix(kind: str, value: str) -> int:
            d = dic[kind]
            if value not in d:
                d[value] = len(d)
            return d[value]

        rows, skipped_tax, skipped_bad, future = [], 0, 0, 0
        get = lambda r, k: (r.get(col[k]) or "").strip().strip('"') if col[k] else ""
        for r in reader:
            kind = get(r, "detail_kind")
            if kind in ("消費税", "1"):
                skipped_tax += 1
                continue
            d0, d1 = parse_ymd(get(r, "slip_date")), parse_ymd(get(r, "op_date"))
            if not d0 or not d1:
                skipped_bad += 1
                continue
            if d0.strftime("%Y%m") < START_YYYYMM or d0 > now.date():
                continue
            lag = (d1 - d0).days
            if lag < 0:
                future += 1
            owner, login = get(r, "owner"), get(r, "inputter")
            wh = get(r, "warehouse")
            try:
                qty = float(get(r, "qty") or 0)
            except ValueError:
                qty = 0.0
            rows.append([
                int(d0.strftime("%Y%m%d")), int(d1.strftime("%Y%m%d")), lag,
                ix("fac", FACTORY_BY_WAREHOUSE.get(wh, "その他")), ix("wh", wh),
                ix("sup", get(r, "supplier")), ix("own", re.sub(r"[\s　]+", " ", owner)),
                ix("inp", login), 1 if is_self(owner, login) else 0,
                get(r, "item_code"), ix("item", get(r, "item_name")),
                qty, get(r, "unit"),
                get(r, "po_no"), get(r, "rc_no"),
            ])

    payload = {k: [x for x, _ in sorted(v.items(), key=lambda t: t[1])] for k, v in dic.items()}
    meta.update(row_count=len(rows), skipped_tax=skipped_tax, skipped_bad=skipped_bad,
                future_dated=future, start=START_YYYYMM,
                period_to=max((r[0] for r in rows), default=None))
    payload["meta"] = meta
    payload["rows"] = rows
    write(payload)
    print(f"[same_day_rate] 出力 {OUT.name}: {len(rows):,}明細（消費税行除外 {skipped_tax} / 日付不正 {skipped_bad} / 先日付 {future}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
