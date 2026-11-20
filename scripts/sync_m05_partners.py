#!/usr/bin/env python3
"""
sync_m05_partners.py
仕入先マスタ.csv (SharedMasters) → SharePointリスト M05協力工場

内部フィールド名（SharePoint REST APIで確認済み）:
  協力工場コード → Title
  略称          → field_1
  正式名称      → field_2
  ジャンル      → field_3
  電話番号      → field_4
  住所          → field_5
  備考          → field_6
"""

import os, sys, io, csv
import msal, requests
from requests.utils import quote

DRIVE_ID  = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"
CSV_FILE  = "仕入先マスタ.csv"
LIST_NAME = "M05協力工場"
SITE_PATH = "hanaokacorp.sharepoint.com:/sites/msteams_7aab51"

COL_CODE  = 0
COL_NAME1 = 1
COL_ABBR  = 3
COL_ADDR1 = 6
COL_ADDR2 = 7
COL_TEL   = 10
COL_GENRE = 15

F_PK    = "Title"
F_ABBR  = "field_1"
F_NAME  = "field_2"
F_GENRE = "field_3"
F_TEL   = "field_4"
F_ADDR  = "field_5"
F_BIKO  = "field_6"

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
    # 専用機では OneDrive で同期した SharedMasters のフォルダ（環境変数 SHARED_MASTERS_DIR）から直接読む
    local = os.environ.get("SHARED_MASTERS_DIR")
    if local:
        with open(os.path.join(local, CSV_FILE), "rb") as f:
            content = f.read()
    else:
        r = requests.get(
            f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{quote(CSV_FILE, safe='')}:/content",
            headers={"Authorization": f"Bearer {token}"}, timeout=60)
        r.raise_for_status()
        content = r.content
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))

def col(row, idx): return row[idx].strip() if len(row) > idx else ""

def unchanged(current, fields):
    """SharePoint の今の値（current）と、書こうとしている値（fields）がすべて同じか。
    同じ行は書き直さない（毎日すべての行を書き直していたため、件数が多いと30分を超えて止まっていた）"""
    for k, v in fields.items():
        a = current.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            try:
                if a is not None and a != "" and float(a) == float(v):
                    continue
            except (TypeError, ValueError):
                pass
            return False
        if ("" if a is None else str(a).strip()) != ("" if v is None else str(v).strip()):
            return False
    return True

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

    csv_map = {}
    for row in rows[1:]:
        code = col(row, COL_CODE)
        if code:
            csv_map[code] = row
    print(f"[ok] CSVレコード数: {len(csv_map)}")

    sp_map = get_list_items(token, site_id)
    print(f"[ok] SharePoint現行: {len(sp_map)} 件")

    inserted = updated = same = 0

    for code, row in csv_map.items():
        addr = (col(row, COL_ADDR1) + col(row, COL_ADDR2)).strip()
        fields = {
            F_PK:    code,
            F_ABBR:  col(row, COL_ABBR),
            F_NAME:  col(row, COL_NAME1),
            F_GENRE: col(row, COL_GENRE),
            F_TEL:   col(row, COL_TEL),
            F_ADDR:  addr,
            F_BIKO:  "",
        }
        if code in sp_map:
            if unchanged(sp_map[code]["fields"], fields):
                same += 1
                continue
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

    DELETED_MARK = "[削除済み: ソースCSV未存在]"
    for code, item in sp_map.items():
        if code not in csv_map:
            if (item["fields"].get(F_BIKO) or "").strip() == DELETED_MARK:
                continue   # もう印が付いている
            try:
                update_item(token, site_id, item["id"], {F_BIKO: DELETED_MARK})
                print(f"  [削除マーク] {code}")
            except Exception as e:
                errors.append(f"削除マーク失敗 [{code}]: {e}")

    print(f"\n[完了] INSERT {inserted} / UPDATE {updated} / 変わらず {same} / エラー {len(errors)}")
    if errors:
        for e in errors: print(f"  !! {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
