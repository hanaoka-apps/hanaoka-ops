#!/usr/bin/env python3
"""
sync_m06_customers.py
得意先マスタ.csv (SharedMasters) → SharePointリスト M06客先

内部フィールド名（SharePoint REST APIで確認済み）:
  客先コード → Title
  出先名    → field_1
  社名コード → field_2  ※数値型
  社名      → field_3
  郵便番号  → field_5
  住所      → field_6
  電話番号  → field_7
  担当者名  → field_8
  使用区分  → _x4f7f__x7528__x533a__x5206_
"""

import os, sys, io, csv
import msal, requests
from requests.utils import quote

DRIVE_ID  = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"
CSV_FILE  = "得意先マスタ.csv"
LIST_NAME = "M06客先"
SITE_PATH = "hanaokacorp.sharepoint.com:/sites/msteams_7aab51"

COL_CODE    = 0
COL_DESAKI  = 1
COL_POSTAL  = 5
COL_ADDR1   = 6
COL_ADDR2   = 7
COL_ADDR3   = 8
COL_TEL     = 10
COL_SHACODE = 14
COL_SHANAME = 15
COL_TANTOU  = 56

F_PK      = "Title"
F_DESAKI  = "field_1"
F_SHACODE = "field_2"   # 数値型
F_SHANAME = "field_3"
F_POSTAL  = "field_5"
F_ADDR    = "field_6"
F_TEL     = "field_7"
F_TANTOU  = "field_8"
F_USE     = "_x4f7f__x7528__x533a__x5206_"

def get_token():
    app = msal.ConfidentialClientApplication(
        os.environ["AZURE_CLIENT_ID"],
        authority=f"https://login.microsoftonline.com/{os.environ['AZURE_TENANT_ID']}",
        client_credential=os.environ["AZURE_CLIENT_SECRET"],
    )
    result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        raise RuntimeError(result.get("error_description"))
    return result["access_token"]

def hdr(token): return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def get_site_id(token):
    r = requests.get(f"https://graph.microsoft.com/v1.0/sites/{SITE_PATH}", headers=hdr(token), timeout=30)
    r.raise_for_status()
    return r.json()["id"]

def download_csv(token):
    r = requests.get(
        f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{quote(CSV_FILE, safe='')}:/content",
        headers={"Authorization": f"Bearer {token}"}, timeout=120)
    r.raise_for_status()
    try:
        text = r.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = r.content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))

def col(row, idx): return row[idx].strip() if len(row) > idx else ""

def to_int(val):
    """社名コード（数値型列）用。変換できなければ None を返す"""
    try:
        return int(val) if val else None
    except ValueError:
        return None

def get_list_items(token, site_id):
    items, url = {}, (
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{quote(LIST_NAME, safe='')}/items?$expand=fields&$top=4999"
    )
    while url:
        r = requests.get(url, headers=hdr(token), timeout=60)
        r.raise_for_status()
        data = r.json()
        for item in data.get("value", []):
            key = (item["fields"].get(F_PK) or "").strip()
            if key:
                items[key] = {
                    "id": item["id"],
                    "use_flag": (item["fields"].get(F_USE) or "").strip(),
                }
        url = data.get("@odata.nextLink")
    return items

def create_item(token, site_id, fields):
    r = requests.post(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{quote(LIST_NAME, safe='')}/items",
        headers=hdr(token), json={"fields": fields}, timeout=30)
    r.raise_for_status()

def update_item(token, site_id, item_id, fields):
    r = requests.patch(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{quote(LIST_NAME, safe='')}/items/{item_id}/fields",
        headers=hdr(token), json=fields, timeout=30)
    r.raise_for_status()

def main():
    print(f"\n===== {LIST_NAME} 同期開始 =====")
    errors = []

    token   = get_token()
    site_id = get_site_id(token)
    print("[ok] 認証完了")

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
        desaki = col(row, COL_DESAKI)
        addr   = "".join(filter(None, [col(row, COL_ADDR1), col(row, COL_ADDR2), col(row, COL_ADDR3)]))
        shacode_val = to_int(col(row, COL_SHACODE))

        fields = {
            F_PK:     code,
            F_DESAKI: desaki,
            F_USE:    "使用禁止" if desaki.startswith("×") else "使用中",
            F_SHANAME: col(row, COL_SHANAME),
            F_POSTAL: col(row, COL_POSTAL),
            F_ADDR:   addr,
            F_TEL:    col(row, COL_TEL),
            F_TANTOU: col(row, COL_TANTOU),
        }
        # 社名コードは数値型。値があるときだけセット
        if shacode_val is not None:
            fields[F_SHACODE] = shacode_val

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

    for code, item in sp_map.items():
        if code in csv_map or item["use_flag"] == "使用禁止":
            continue
        try:
            update_item(token, site_id, item["id"], {F_USE: "使用禁止"})
            flagged += 1
            print(f"  [使用禁止] {code}")
        except Exception as e:
            msg = f"使用禁止フラグ失敗 [{code}]: {e}"
            print(f"  [ERROR] {msg}")
            errors.append(msg)

    print(f"\n[完了] INSERT {inserted} / UPDATE {updated} / 使用禁止フラグ {flagged} / エラー {len(errors)}")
    if errors:
        for e in errors: print(f"  !! {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
