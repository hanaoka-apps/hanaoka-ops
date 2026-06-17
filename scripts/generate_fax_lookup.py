#!/usr/bin/env python3
"""
generate_fax_lookup.py
得意先マスタ.csv / 仕入先マスタ.csv (SharedMasters) から
FAXマッチング用コンパクトJSON を生成して SharedMasters に書き戻す。

認証・DriveID パターンは sync_m06_customers.py と同一。
"""

import csv
import io
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import msal
import requests
from requests.utils import quote

# ── 設定（sync_m06_customers.py と同じ値）────────────────────
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

CUSTOMERS_CSV = "得意先マスタ.csv"
SUPPLIERS_CSV = "仕入先マスタ.csv"
OUTPUT_FILE   = "fax_relation_lookup.json"

# 使用する列インデックス（得意先・仕入先ともに同じ位置）
COL_CODE  = 0   # コード
COL_NAME1 = 1   # 正式名
COL_ABBR  = 3   # 略称
COL_TEL   = 10  # 電話番号
COL_FAX   = 11  # FAX番号
# ─────────────────────────────────────────────────────────────


def get_token() -> str:
    app = msal.ConfidentialClientApplication(
        os.environ["AZURE_CLIENT_ID"],
        authority=f"https://login.microsoftonline.com/{os.environ['AZURE_TENANT_ID']}",
        client_credential=os.environ["AZURE_CLIENT_SECRET"],
    )
    result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        raise RuntimeError(result.get("error_description"))
    return result["access_token"]


def hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def download_csv(token: str, filename: str) -> list[list[str]]:
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{quote(filename, safe='')}:/content"
    r = requests.get(url, headers=hdr(token), timeout=120)
    r.raise_for_status()
    try:
        text = r.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = r.content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))


def upload_json(token: str, filename: str, data: dict) -> None:
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{quote(filename, safe='')}:/content"
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    r = requests.put(
        url,
        headers={**hdr(token), "Content-Type": "application/json"},
        data=body,
        timeout=60,
    )
    r.raise_for_status()


def col(row: list, idx: int) -> str:
    return row[idx].strip() if len(row) > idx else ""


def build_lookup(customer_rows: list, supplier_rows: list) -> dict:
    relations = []

    for row in customer_rows[1:]:   # 1行目はヘッダ
        name = col(row, COL_NAME1)
        if not name:
            continue
        relations.append({
            "c":  col(row, COL_CODE),
            "n":  name,
            "a":  col(row, COL_ABBR),
            "t":  col(row, COL_TEL),
            "f":  col(row, COL_FAX),
            "tp": "得意先",
        })

    for row in supplier_rows[1:]:
        name = col(row, COL_NAME1)
        if not name:
            continue
        relations.append({
            "c":  col(row, COL_CODE),
            "n":  name,
            "a":  col(row, COL_ABBR),
            "t":  col(row, COL_TEL),
            "f":  col(row, COL_FAX),
            "tp": "仕入先",
        })

    jst = timezone(timedelta(hours=9))
    updated = datetime.now(jst).strftime("%Y-%m-%d %H:%M JST")
    return {"relations": relations, "updated": updated}


def main():
    print("===== fax_relation_lookup.json 生成開始 =====")

    token = get_token()
    print("[ok] 認証完了")

    customer_rows = download_csv(token, CUSTOMERS_CSV)
    print(f"[ok] {CUSTOMERS_CSV}: {len(customer_rows)}行")

    supplier_rows = download_csv(token, SUPPLIERS_CSV)
    print(f"[ok] {SUPPLIERS_CSV}: {len(supplier_rows)}行")

    lookup = build_lookup(customer_rows, supplier_rows)
    total    = len(lookup["relations"])
    size_kb  = len(json.dumps(lookup, ensure_ascii=False).encode()) // 1024
    print(f"[ok] 生成完了: {total}件 / {size_kb}KB")

    upload_json(token, OUTPUT_FILE, lookup)
    print(f"[ok] アップロード完了: {OUTPUT_FILE} ({lookup['updated']})")
    print("=============================================")


if __name__ == "__main__":
    main()
