#!/usr/bin/env python3
"""
sync_m02_models.py
品目マスタ.csv (SharedMasters) → SharePointリスト M02機種

フィルタ : 大分類名（37列目, index 36）が「空港トレーラー」または「空港マテハン」
集約単位 : 小分類名（41列目, index 40）でユニーク → 機種型式（主キー）
特殊処理 : 「その他トレーラー」レコードは同期で廃止フラグを立てない
"""

import os, sys, io, csv
import msal, requests

# ── 設定 ──────────────────────────────────────────────────────────────────
DRIVE_ID   = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"
CSV_FILE   = "品目マスタ.csv"
LIST_NAME  = "M02機種"
SITE_PATH  = "hanaokacorp.sharepoint.com:/sites/msteams_7aab51"
PROTECTED  = "その他トレーラー"   # 手動登録分 — 廃止禁止

TARGET_CATEGORIES = {"空港トレーラー", "空港マテハン"}

# 列インデックス（0-based）
COL_HINMEI    = 1
COL_DAIBUNRUI = 36
COL_SHOBUNRUI = 40

# ── 認証 ──────────────────────────────────────────────────────────────────
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

def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

# ── Graph API ─────────────────────────────────────────────────────────────
def get_site_id(token: str) -> str:
    r = requests.get(
        f"https://graph.microsoft.com/v1.0/sites/{SITE_PATH}",
        headers=headers(token), timeout=30
    )
    r.raise_for_status()
    return r.json()["id"]

def download_csv(token: str) -> list[list[str]]:
    encoded = requests.utils.quote(CSV_FILE, safe="")
    r = requests.get(
        f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{encoded}:/content",
        headers={"Authorization": f"Bearer {token}"}, timeout=60
    )
    r.raise_for_status()
    # Shift-JIS / UTF-8 自動判定
    try:
        text = r.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = r.content.decode("cp932", errors="replace")
    return list(csv.reader(io.StringIO(text)))

def get_list_items(token: str, site_id: str) -> dict:
    """主キー（機種型式）→ {id, fields} のマップを返す"""
    items, url = {}, (
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items"
        "?$expand=fields&$top=4999"
    )
    while url:
        r = requests.get(url, headers=headers(token), timeout=60)
        r.raise_for_status()
        data = r.json()
        for item in data.get("value", []):
            key = (item["fields"].get("機種型式") or "").strip()
            if key:
                items[key] = {"id": item["id"], "fields": item["fields"]}
        url = data.get("@odata.nextLink")
    return items

def create_item(token: str, site_id: str, fields: dict):
    r = requests.post(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items",
        headers=headers(token), json={"fields": fields}, timeout=30
    )
    r.raise_for_status()

def update_item(token: str, site_id: str, item_id: str, fields: dict):
    r = requests.patch(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}"
        f"/lists/{requests.utils.quote(LIST_NAME, safe='')}/items/{item_id}/fields",
        headers=headers(token), json=fields, timeout=30
    )
    r.raise_for_status()

# ── メイン ────────────────────────────────────────────────────────────────
def main():
    print(f"\n===== {LIST_NAME} 同期開始 =====")
    errors = []

    token   = get_token()
    site_id = get_site_id(token)
    print(f"[ok] 認証・サイトID取得完了")

    # CSV ダウンロード & パース
    rows = download_csv(token)
    print(f"[ok] {CSV_FILE}: {len(rows)} 行")

    # フィルタ & 小分類でグルーピング
    groups: dict[str, dict] = {}
    for row in rows[1:]:  # ヘッダースキップ
        if len(row) <= COL_SHOBUNRUI:
            continue
        category   = row[COL_DAIBUNRUI].strip()
        shobunrui  = row[COL_SHOBUNRUI].strip()
        hinmei     = row[COL_HINMEI].strip() if len(row) > COL_HINMEI else ""
        if category not in TARGET_CATEGORIES or not shobunrui:
            continue
        if shobunrui not in groups:
            groups[shobunrui] = {"category": category, "hinmei_list": []}
        groups[shobunrui]["hinmei_list"].append(hinmei)

    print(f"[ok] CSVグループ数: {len(groups)}")

    # SharePoint現行レコード
    sp_map = get_list_items(token, site_id)
    print(f"[ok] SharePoint現行: {len(sp_map)} 件")

    inserted = updated = flagged = 0

    # Upsert
    for shobunrui, g in groups.items():
        hinmei_list  = g["hinmei_list"]
        kigata_mei   = max(hinmei_list, key=len) if hinmei_list else ""
        hasei_count  = len(hinmei_list)
        bikou        = f"派生型式{hasei_count}件" if hasei_count > 1 else ""

        fields = {
            "機種型式":  shobunrui,
            "機種名":    kigata_mei,
            "カテゴリ":  g["category"],
            "派生型式数": hasei_count,
            "使用区分":  "使用中",
            "備考":      bikou,
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

    # ソースにないキーを廃止フラグ（保護対象・既廃止はスキップ）
    for key, item in sp_map.items():
        if key == PROTECTED or key in groups:
            continue
        if (item["fields"].get("使用区分") or "") == "廃止":
            continue
        try:
            update_item(token, site_id, item["id"], {"使用区分": "廃止"})
            flagged += 1
            print(f"  [廃止] {key}")
        except Exception as e:
            msg = f"廃止フラグ失敗 [{key}]: {e}"
            print(f"  [ERROR] {msg}")
            errors.append(msg)

    print(f"\n[完了] INSERT {inserted} / UPDATE {updated} / 廃止フラグ {flagged} / エラー {len(errors)}")
    if errors:
        for e in errors:
            print(f"  !! {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
