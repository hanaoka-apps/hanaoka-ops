#!/usr/bin/env python3
"""
sync_m02_models.py
品目マスタ.csv (SharedMasters) → SharePointリスト M02機種

内部フィールド名（SharePoint REST APIで確認済み）:
  機種型式  → Title
  機種名    → field_1
  派生型式数 → field_3
  備考      → field_5
  カテゴリ  → _x30ab__x30c6__x30b4__x30ea_
  使用区分  → _x4f7f__x7528__x533a__x5206_
"""

import os, sys, io, csv
import msal, requests
from requests.utils import quote

DRIVE_ID  = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"
CSV_FILE  = "品目マスタ.csv"
LIST_NAME = "M02機種"
SITE_PATH = "hanaokacorp.sharepoint.com:/sites/msteams_7aab51"
PROTECTED = "その他トレーラー"

TARGET_CATEGORIES = {"空港トレーラー", "空港マテハン"}

COL_HINMEI    = 1
COL_DAIBUNRUI = 36
COL_SHOBUNRUI = 40

# 確認済み内部名
F_PK       = "Title"
F_NAME     = "field_1"
F_COUNT    = "field_3"
F_BIKO     = "field_5"
F_CATEGORY = "_x30ab__x30c6__x30b4__x30ea_"
F_USE      = "_x4f7f__x7528__x533a__x5206_"

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
        headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    try:
        text = r.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = r.content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))

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
                items[key] = {"id": item["id"], "fields": item["fields"]}
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

    groups = {}
    for row in rows[1:]:
        if len(row) <= COL_SHOBUNRUI:
            continue
        category  = row[COL_DAIBUNRUI].strip()
        shobunrui = row[COL_SHOBUNRUI].strip()
        hinmei    = row[COL_HINMEI].strip() if len(row) > COL_HINMEI else ""
        if category not in TARGET_CATEGORIES or not shobunrui:
            continue
        if shobunrui not in groups:
            groups[shobunrui] = {"category": category, "hinmei_list": []}
        groups[shobunrui]["hinmei_list"].append(hinmei)
    print(f"[ok] CSVグループ数: {len(groups)}")

    sp_map = get_list_items(token, site_id)
    print(f"[ok] SharePoint現行: {len(sp_map)} 件")

    inserted = updated = flagged = 0

    for shobunrui, g in groups.items():
        hl = g["hinmei_list"]
        fields = {
            F_PK:       shobunrui,
            F_NAME:     max(hl, key=len) if hl else "",
            F_CATEGORY: g["category"],
            F_COUNT:    len(hl),
            F_USE:      "使用中",
            F_BIKO:     f"派生型式{len(hl)}件" if len(hl) > 1 else "",
        }
        if shobunrui in sp_map:
            try:
                update_item(token, site_id, sp_map[shobunrui]["id"], fields)
                updated += 1
            except Exception as e:
                msg = f"UPDATE失敗 [{shobunrui}]: {e}"
                print(f"  [ERROR] {msg}")
                errors.append(msg)
        else:
            try:
                create_item(token, site_id, fields)
                inserted += 1
            except Exception as e:
                msg = f"INSERT失敗 [{shobunrui}]: {e}"
                print(f"  [ERROR] {msg}")
                errors.append(msg)

    for key, item in sp_map.items():
        if key == PROTECTED or key in groups:
            continue
        if (item["fields"].get(F_USE) or "") == "廃止":
            continue
        try:
            update_item(token, site_id, item["id"], {F_USE: "廃止"})
            flagged += 1
            print(f"  [廃止] {key}")
        except Exception as e:
            msg = f"廃止フラグ失敗 [{key}]: {e}"
            print(f"  [ERROR] {msg}")
            errors.append(msg)

    print(f"\n[完了] INSERT {inserted} / UPDATE {updated} / 廃止フラグ {flagged} / エラー {len(errors)}")
    if errors:
        for e in errors: print(f"  !! {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
