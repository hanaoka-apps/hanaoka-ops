"""
fax_auto_register.py
====================
GitHub Actions から5分おきに実行される FAX 自動登録スクリプト。

処理フロー:
  1. SharePoint Results/ フォルダの *.result.json を検出
  2. registration セクションを FAX_EventHistory リストに POST
  3. PDF を Incoming/ → Inbox/ へ移動
  4. result.json を *.done.json にリネーム（処理済みマーク）

必要な GitHub Secrets:
  AZURE_TENANT_ID     : 3933e8a0-c945-4e97-ae67-c82131087cad
  AZURE_CLIENT_ID     : 2a53f9b9-48a7-47fe-94a6-f5ea63020b77  (花岡車輌 業務アプリ_daemon)
  AZURE_CLIENT_SECRET : Azure Portal → 証明書とシークレット で発行した値

Azure AD アプリの権限（アプリケーション権限・管理者の同意必須）:
  - Sites.ReadWrite.All
  - Files.ReadWrite.All
"""

import os
import json
import time
import sys
from datetime import datetime, timezone, timedelta

import msal
import requests

# ──────────────────────────────────────────────
# 設定
# ──────────────────────────────────────────────
TENANT_ID     = os.environ["AZURE_TENANT_ID"]
CLIENT_ID     = os.environ["AZURE_CLIENT_ID"]
CLIENT_SECRET = os.environ["AZURE_CLIENT_SECRET"]

# SharePoint サイト
SITE_ID       = "hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23"
EVENT_LIST_ID = "a7cee65e-1815-4992-b2fc-79d7cd9e6d05"   # FAX_EventHistory

# FAX_PDFStorage ドライブID（固定値 / 変更時はここを更新）
FAX_DRIVE_ID  = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyOcUvvzF3tkRZTWzGT0hFTa"

GRAPH_BASE    = "https://graph.microsoft.com/v1.0"
SCOPE         = ["https://graph.microsoft.com/.default"]

JST = timezone(timedelta(hours=9))


# ──────────────────────────────────────────────
# 認証（クライアント資格情報フロー）
# ──────────────────────────────────────────────
def get_token() -> str:
    app = msal.ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential=CLIENT_SECRET,
    )
    result = app.acquire_token_for_client(scopes=SCOPE)
    if "access_token" not in result:
        raise RuntimeError(f"トークン取得失敗: {result.get('error_description')}")
    return result["access_token"]


# ──────────────────────────────────────────────
# Graph API ラッパー
# ──────────────────────────────────────────────
class GraphClient:
    def __init__(self):
        self._token = get_token()
        self._headers = {"Authorization": f"Bearer {self._token}"}

    def _h(self):
        return {**self._headers, "Content-Type": "application/json"}

    def get(self, url: str) -> dict:
        r = requests.get(GRAPH_BASE + url, headers=self._headers)
        r.raise_for_status()
        return r.json()

    def post(self, url: str, body: dict) -> dict:
        r = requests.post(GRAPH_BASE + url, headers=self._h(), json=body)
        r.raise_for_status()
        return r.json()

    def patch(self, url: str, body: dict) -> dict:
        r = requests.patch(GRAPH_BASE + url, headers=self._h(), json=body)
        r.raise_for_status()
        return r.json()

    def delete(self, url: str):
        r = requests.delete(GRAPH_BASE + url, headers=self._headers)
        if r.status_code not in (200, 204):
            r.raise_for_status()

    def get_bytes(self, url: str) -> bytes:
        r = requests.get(GRAPH_BASE + url, headers=self._headers)
        r.raise_for_status()
        return r.content

    # ── フォルダ内アイテム一覧（FAX_PDFStorage 配下）──
    def list_folder(self, folder_path: str) -> list:
        data = self.get(f"/drives/{FAX_DRIVE_ID}/root:/{folder_path}:/children")
        return data.get("value", [])

    # ── ファイルダウンロード（テキスト） ──
    def download_text(self, item_id: str) -> str:
        meta = self.get(f"/drives/{FAX_DRIVE_ID}/items/{item_id}")
        dl_url = meta.get("@microsoft.graph.downloadUrl")
        if not dl_url:
            raise RuntimeError(f"ダウンロードURL取得失敗: {item_id}")
        r = requests.get(dl_url)
        r.raise_for_status()
        return r.text

    # ── ファイル移動（同一ドライブ内） ──
    def move_file(self, item_id: str, dest_folder_path: str, new_name: str | None = None):
        dest = self.get(f"/drives/{FAX_DRIVE_ID}/root:/{dest_folder_path}:")
        body: dict = {"parentReference": {"driveId": FAX_DRIVE_ID, "id": dest["id"]}}
        if new_name:
            body["name"] = new_name
        self.patch(f"/drives/{FAX_DRIVE_ID}/items/{item_id}", body)

    # ── ファイルリネーム ──
    def rename_file(self, item_id: str, new_name: str):
        self.patch(f"/drives/{FAX_DRIVE_ID}/items/{item_id}", {"name": new_name})


# ──────────────────────────────────────────────
# メイン処理
# ──────────────────────────────────────────────
def main():
    print(f"[{datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')}] FAX自動登録 開始")
    gc = GraphClient()
    sid = SITE_ID
    print(f"  Drive ID: {FAX_DRIVE_ID[:30]}...")

    # Results フォルダの一覧を取得
    results_items = gc.list_folder("Results")
    pending = [
        item for item in results_items
        if item["name"].endswith(".result.json")
    ]

    if not pending:
        print("  処理対象の result.json なし → 終了")
        return

    print(f"  未処理 result.json: {len(pending)} 件")

    ok_count  = 0
    err_count = 0

    for item in pending:
        name     = item["name"]           # e.g. 20260428103357833.result.json
        item_id  = item["id"]
        pdf_stem = name.replace(".result.json", "")
        pdf_name = pdf_stem + ".pdf"

        print(f"\n  📄 処理中: {name}")
        try:
            # ── 1. result.json をダウンロード・パース ──
            raw = gc.download_text(item_id)
            result = json.loads(raw)
            reg = result.get("registration")
            if not reg:
                raise ValueError("registration セクションが見つかりません")

            # Title の重複を避けるため epoch_ms を再生成
            reg["Title"] = f"EV-{int(time.time() * 1000)}"

            # ── 2. FAX_EventHistory に POST ──
            gc.post(
                f"/sites/{sid}/lists/{EVENT_LIST_ID}/items",
                {"fields": reg}
            )
            print(f"    ✅ EventHistory 登録完了: {reg.get('CaseName', '')}")

            # ── 3. PDF を Incoming/ → Inbox/ へ移動 ──
            incoming_items = gc.list_folder("Incoming")
            pdf_item = next(
                (i for i in incoming_items if i["name"] == pdf_name), None
            )
            if pdf_item:
                gc.move_file(pdf_item["id"], "Inbox")
                print(f"    📁 PDF移動完了: Incoming → Inbox ({pdf_name})")
            else:
                print(f"    ⚠️  PDF が Incoming に見つかりません（既移動の可能性）: {pdf_name}")

            # ── 4. result.json を .done.json にリネーム（処理済みマーク） ──
            done_name = pdf_stem + ".done.json"
            gc.rename_file(item_id, done_name)
            print(f"    🏷️  処理済みマーク: {name} → {done_name}")

            ok_count += 1

        except Exception as e:
            print(f"    ❌ エラー: {e}")
            err_count += 1
            # 1件失敗しても次の件を続行

    print(f"\n{'='*40}")
    print(f"完了: 成功 {ok_count} 件 / 失敗 {err_count} 件")
    if err_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
