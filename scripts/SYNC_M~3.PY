#!/usr/bin/env python3
"""
sync_m06_customers.py
得意先マスタ.csv (SharedMasters) → SharePointリスト M06客先（全件同期）

主キー: 客先コード（= 得意先コード, A列・index 0）
使用区分: 出先名が「×」で始まる → 「使用禁止」、それ以外 → 「使用中」
"""

import os, sys, io, csv
import msal, requests

DRIVE_ID  = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"
CSV_FILE  = "得意先マスタ.csv"
LIST_NAME = "M06客先"
SITE_PATH = "hanaokacorp.sharepoint.com:/sites/msteams_7aab51"

# 列インデックス（0-based）
COL_CODE    = 0   # 得意先コード
COL_DESAKI  = 1   # 得意先名１（出先名）
COL_POSTAL  = 5   # 郵便番号
COL_ADDR1   = 6   # 住所１
COL_ADDR2   = 7   # 住所２
COL_ADDR3   = 8   # 住所３
COL_TEL     = 10  # 電話番号
COL_SHACODE = 14  # 得意先社名コード
COL_SHANAME = 15  # 得意先社名名
COL_TANTOU  = 56  # 担当者名（57列目）

def get_token() -> str:
    app = msal.ConfidentialClientApplication(
        os.environ["AZURE_CLIENT_ID"],
        authority=f"https://login.microsoftonline.com/{os.environ['AZURE_TENANT_ID']}",
        client_credential=os.environ["AZURE_CLIENT_SECRET"],
    )
    result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        raise RuntimeError(f"トークン取得失敗: {result.get('error_description')}")
    return result["access_token"]

def hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def get_site_id(token: str) -> str:
    r = requests.get(f"https://graph.microsoft.com/v1.0/sites/{SITE_PATH}",
                     headers=hdr(token), timeout=30)
    r.raise_for_status()
    return r.json()["id"]

def download_csv(token: str) -> list[list[str]]:
    encoded = requests.utils.quote(CSV_FILE, safe="")
    r = requests.get(
        f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{encoded}:/content",
        headers={"Authorization": f"Bearer {token}"}, timeout=120)
    r.raise_for_status()
    try:
        text = r.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = r.content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))

def get_list_items(token: str, site_id: str) -> dict:
    """主キー（客先コード）→ {id, use_flag} のマップ"""
    items, url = {}, (
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items"
        "?$expand=fields&$top=4999"
    )
    while url:
        r = requests.get(url, headers=hdr(token), timeout=60)
        r.raise_for_status()
        data = r.json()
        for item in data.get("value", []):
            key = (item["fields"].get("客先コード") or "").strip()
            if key:
                items[key] = {
                    "id": item["id"],
                    "use_flag": (item["fields"].get("使用区分") or "").strip(),
                }
        url = data.get("@odata.nextLink")
    return items

def col(row, idx): return row[idx].strip() if len(row) > idx else ""

def row_to_fields(row: list[str]) -> dict:
    desaki   = col(row, COL_DESAKI)
    use_flag = "使用禁止" if desaki.startswith("×") else "使用中"
    addr     = "".join(filter(None, [col(row, COL_ADDR1), col(row, COL_ADDR2), col(row, COL_ADDR3)]))
    return {
        "客先コード": col(row, COL_CODE),
        "出先名":     desaki,
        "社名コード": col(row, COL_SHACODE),
        "社名":       col(row, COL_SHANAME),
        "使用区分":   use_flag,
        "郵便番号":   col(row, COL_POSTAL),
        "住所":       addr,
        "電話番号":   col(row, COL_TEL),
        "担当者名":   col(row, COL_TANTOU),
    }

def create_item(token, site_id, fields):
    r = requests.post(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items",
        headers=hdr(token), json={"fields": fields}, timeout=30)
    r.raise_for_status()

def update_item(token, site_id, item_id, fields):
    r = requests.patch(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items/{item_id}/fields",
        headers=hdr(token), json=fields, timeout=30)
    r.raise_for_status()

def main():
    print(f"\n===== {LIST_NAME} 同期開始 =====")
    errors = []

    token   = get_token()
    site_id = get_site_id(token)
    print("[ok] 認証・サイトID取得完了")

    rows = download_csv(token)
    print(f"[ok] {CSV_FILE}: {len(rows)} 行")

    csv_map = {}
    for row in rows[1:]:
        code = col(row, COL_CODE)
        if code:
            csv_map[code] = row
    print(f"[ok] CSVレコード数: {len(csv_map)}")

    sp_map = get_list_items(token, site_id)
    print(f"[ok] SharePoint現行: {len(sp_map)} 件")

    inserted = updated = flagged = 0

    for code, row in csv_map.items():
        fields = row_to_fields(row)
        if code in sp_map:
            try:
                update_item(token, site_id, sp_map[code]["id"], fields)
                updated += 1
            except Exception as e:
                msg = f"UPDATE失敗 [{code}]: {e}"
                print(f"  [ERROR] {msg}")
                errors.append(msg)
        else:
            try:
                create_item(token, site_id, fields)
                inserted += 1
            except Exception as e:
                msg = f"INSERT失敗 [{code}]: {e}"
                print(f"  [ERROR] {msg}")
                errors.append(msg)

    # ソースにないレコードを使用禁止フラグ
    for code, item in sp_map.items():
        if code in csv_map or item["use_flag"] == "使用禁止":
            continue
        try:
            update_item(token, site_id, item["id"], {"使用区分": "使用禁止"})
            flagged += 1
            print(f"  [使用禁止] {code}")
        except Exception as e:
            msg = f"使用禁止フラグ失敗 [{code}]: {e}"
            print(f"  [ERROR] {msg}")
            errors.append(msg)

    print(f"\n[完了] INSERT {inserted} / UPDATE {updated} / 使用禁止フラグ {flagged} / エラー {len(errors)}")
    if errors:
        for e in errors:
            print(f"  !! {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
