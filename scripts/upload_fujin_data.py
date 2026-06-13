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
from pathlib import Path

import requests

TENANT_ID = os.environ.get("AZURE_TENANT_ID", "").strip()
CLIENT_ID = os.environ.get("AZURE_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("AZURE_CLIENT_SECRET", "").strip()

# SharedMasters ドライブ(sales_dashboard等が読むドライブと同一)
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"

# アップロード対象: (ローカルパス, SharePoint上の名前)
TARGETS = [
    (DATA / "item_history.json", "item_history.json"),  # 仕入先名・金額(最機微)
    (DATA / "yama_data.json", "yama_data.json"),         # 山積み台数 (2026-06-11追加)
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
    body = local_path.read_bytes()
    print(f"  📤 {sp_name} をアップロード中... ({len(body)/1024/1024:.2f} MB)", flush=True)
    r = requests.put(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=body,
        timeout=600,
    )
    r.raise_for_status()
    print(f"  [OK] {sp_name} アップロード完了")
    return True


def main():
    if not all([TENANT_ID, CLIENT_ID, CLIENT_SECRET]):
        print("[ERROR] 環境変数 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET が未設定")
        sys.exit(1)
    print("トークン取得中...")
    token = get_token()
    print("  [OK] 認証成功")
    ok = 0
    for local_path, sp_name in TARGETS:
        try:
            if upload_file(token, local_path, sp_name):
                ok += 1
        except Exception as e:
            print(f"  [ERROR] {sp_name}: {e}")
    print(f"完了: {ok}/{len(TARGETS)} 件アップロード")


if __name__ == "__main__":
    main()
