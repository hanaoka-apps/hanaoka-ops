#!/usr/bin/env python3
"""FUJIN のデータファイルを SharePoint(SharedMasters ドライブ)へアップロードする。

目的(2026-06-10 セキュリティ移行):
  item_history.json 等の業務データ(仕入先名・金額・受注/売上を含む)を、
  公開GitHub Pages/リポジトリに置く代わりに SharePoint に置き、
  FUJIN画面はログインユーザーのトークンで認証取得する方式へ移行する。
  本スクリプトはビルド(デーモン)側のアップロード担当。

  認証: クライアント資格情報(client_credentials)。regenerate_facts.py と同方式。
  必要env: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
  アップロード先: SharedMasters ドライブのルート直下(sales_dashboard等が読むのと同じドライブ)

  対象ファイル(data/配下にビルドで生成済みのもののみアップロード):
    - item_history.json   ← 段階Aの対象(最も機微: 仕入先名・金額)
  ※今後 yama_data.json / reverse_data.json / results_production用JSON も追加予定
"""
import os
import sys
import hashlib
from pathlib import Path

import requests

TENANT_ID = os.environ.get("AZURE_TENANT_ID", "").strip()
CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("AZURE_CLIENT_SECRET", "").strip()

# SharedMasters ドライブ(sales_dashboard等が読むドライブと同一)
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"

# Microsoft Graph's single-request upload is intended for small files. Use a
# resumable upload session for larger protected data (value_analysis.json can
# exceed 250 MB). Graph requires non-final fragments to be multiples of 320 KiB.
UPLOAD_SESSION_THRESHOLD = 10 * 1024 * 1024
UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024  # 32 * 320 KiB

# アップロード対象: (ローカルパス, SharePoint上の名前)
TARGETS = [
    (DATA / "item_history.json", "item_history.json"),  # 仕入先名・金額(最機微)
    (DATA / "yama_data.json", "yama_data.json"),         # 山積み台数 (2026-06-11追加)
    (DATA / "results_production_data.json", "results_production_data.json"),  # 手配/在庫/受注/BOM (2026-06-13追加)
    (DATA / "seiban_progress.json", "seiban_progress.json"),  # 製番進捗(受注/部品/手配状態) (2026-06-13追加)
    (DATA / "seiban_gantt.json", "seiban_gantt.json"),  # 製番製造スケジュール(BOM×L/T逆算) (2026-06-17追加)
    (DATA / "work_instructions.json", "work_instructions.json"),  # 構成印刷(作業指示) (2026-06セキュリティ移行)
    (DATA / "orphan_items.json", "orphan_items.json"),  # 構成なし/登録漏れ/使用禁止品目(在庫探偵チップ) (2026-07セキュリティ移行)
    (DATA / "value_analysis.json", "value_analysis.json"),  # 付加価値分析（認証配信）
    (DATA / "hub_purchase_facts.json", "hub_purchase_facts.json"),  # HUB「会社の現在地」仕入カード用の軽量版(日別仕入のみ)
]


def get_token() -> str:
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default",
    }
    r = requests.post(url, data=data, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def upload_file(token: str, local_path: Path, sp_name: str) -> bool:
    if not local_path.exists():
        print(f"  [SKIP] {local_path.name} が無い(ビルド未生成)")
        return False
    enc = requests.utils.quote(sp_name, safe="")
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{enc}:/content"
    size = local_path.stat().st_size
    print(f"  📤 {sp_name} をアップロード中... ({size/1024/1024:.2f} MB)", flush=True)
    if size >= UPLOAD_SESSION_THRESHOLD:
        upload_large_file(token, local_path, sp_name, enc, size)
    else:
        with local_path.open("rb") as body:
            r = requests.put(
                url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                data=body,
                timeout=600,
            )
            r.raise_for_status()
    if sp_name == "value_analysis.json":
        verify_uploaded_file(token, local_path, url, size)
    print(f"  [OK] {sp_name} アップロード完了")
    return True


def verify_uploaded_file(token: str, local_path: Path, content_url: str, expected_size: int) -> None:
    """Read back protected data and compare bytes without logging its contents."""
    local_hash = hashlib.sha256()
    with local_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            local_hash.update(chunk)
    response = requests.get(
        content_url,
        headers={"Authorization": f"Bearer {token}"},
        stream=True,
        timeout=(30, 600),
    )
    try:
        response.raise_for_status()
        remote_hash = hashlib.sha256()
        remote_size = 0
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                remote_size += len(chunk)
                remote_hash.update(chunk)
        if remote_size != expected_size or remote_hash.digest() != local_hash.digest():
            raise RuntimeError("SharePoint上の保護JSONが生成ファイルと一致しません")
    finally:
        response.close()
    print("  [OK] 保護JSONの保存後照合に成功")


def upload_large_file(token: str, local_path: Path, sp_name: str, encoded_name: str, size: int) -> None:
    """Upload a large file in sequential Graph upload-session fragments."""
    session_url = (
        f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/"
        f"{encoded_name}:/createUploadSession"
    )
    session_response = requests.post(
        session_url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"item": {"@microsoft.graph.conflictBehavior": "replace", "name": sp_name}},
        timeout=30,
    )
    session_response.raise_for_status()
    upload_url = session_response.json().get("uploadUrl")
    if not upload_url:
        raise RuntimeError("SharePointの大容量アップロードセッションURLを取得できません")

    with local_path.open("rb") as source:
        start = 0
        while start < size:
            chunk = source.read(min(UPLOAD_CHUNK_SIZE, size - start))
            if not chunk:
                raise RuntimeError("大容量アップロード中にファイル末尾へ到達しました")
            end = start + len(chunk) - 1
            response = requests.put(
                upload_url,
                headers={
                    "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {start}-{end}/{size}",
                },
                data=chunk,
                timeout=600,
            )
            response.raise_for_status()
            if end + 1 < size and response.status_code != 202:
                raise RuntimeError("SharePointの分割アップロード応答が不正です")
            if end + 1 == size:
                if response.status_code not in (200, 201):
                    raise RuntimeError("SharePointの最終アップロードが確定していません")
                committed_size = response.json().get("size")
                if committed_size != size:
                    raise RuntimeError("SharePointの確定ファイルサイズが一致しません")
            start = end + 1


def main():
    if not all([TENANT_ID, CLIENT_ID, CLIENT_SECRET]):
        print("[ERROR] 環境変数 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET が未設定")
        sys.exit(1)
    print("トークン取得中...")
    token = get_token()
    print("  [OK] 認証成功")
    ok = 0
    skipped = 0   # ファイル未生成(そのビルドで作られていない)。異常ではない。
    failed = 0    # 実際のアップロード失敗(例外)。これがある時だけ異常終了。
    for local_path, sp_name in TARGETS:
        try:
            if upload_file(token, local_path, sp_name):
                ok += 1
            else:
                skipped += 1
        except Exception as e:
            failed += 1
            print(f"  [ERROR] {sp_name}: {e}")
    print(f"完了: アップロード{ok} / 未生成スキップ{skipped} / 失敗{failed} (全{len(TARGETS)})")
    # 実際のアップロード失敗(例外)があった時だけ異常終了。未生成ファイルは許容(ビルド差分のため)。
    if failed > 0:
        print(f"[ERROR] アップロード失敗 {failed} 件")
        sys.exit(1)


if __name__ == "__main__":
    main()
