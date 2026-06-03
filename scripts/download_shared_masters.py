"""
SharedMasters (SharePoint) から必要なCSV/TXTをダウンロードして data/ に保存する。

GitHub Actions から実行される。環境変数に以下が必要:
  AZURE_TENANT_ID     - 花岡車輌テナントID
  AZURE_CLIENT_ID     - 花岡車輌 業務アプリ_daemon の Client ID
  AZURE_CLIENT_SECRET - 同上の Client Secret (GitHub Secrets)

Drive ID: SharedMasters ライブラリ
"""

import os
import sys
from pathlib import Path

import msal
import requests

# ---- 設定 ----------------------------------------------------------------

DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

# 必須ファイル（1つでもダウンロード失敗したら警告。404は許容してスキップ）
REQUIRED_FILES = [
    "未確定_購買手配データ.csv",
    "確定済_工程手配一覧.csv",
    "確定済_購買発注一覧.csv",
    "製造指図出力.csv",
    "受注明細出力.csv",
    "売上明細出力.csv",
    "受入明細出力.csv",
    "構成マスタ.csv",
    "工程マスタ.csv",
    "品目手順マスタ.csv",
    "仕入先マスタ.csv",
    "生産計画出力.csv",
    "有効在庫一覧表.csv",
]

# 任意ファイル（なくても続行）
OPTIONAL_FILES = [
    "品目マスタ.csv",
    "品目マスタ.txt",
    "製番マスタ.csv",
    "製番マスタ.txt",
]

# --------------------------------------------------------------------------

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"


def get_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    app = msal.ConfidentialClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
        client_credential=client_secret,
    )
    result = app.acquire_token_for_client(
        scopes=["https://graph.microsoft.com/.default"]
    )
    if "access_token" not in result:
        raise RuntimeError(
            f"トークン取得失敗: {result.get('error')} / {result.get('error_description')}"
        )
    return result["access_token"]


def get_file_last_modified(token: str, filename: str) -> str:
    """SharePoint上のファイルのlastModifiedDateTime(JST)を返す。取得失敗時は空文字。"""
    encoded = requests.utils.quote(filename, safe="")
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{encoded}"
    res = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if res.status_code == 200:
        from datetime import timezone, timedelta
        dt_str = res.json().get("lastModifiedDateTime", "")
        if dt_str:
            from datetime import datetime
            dt_utc = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
            dt_jst = dt_utc.astimezone(timezone(timedelta(hours=9)))
            return dt_jst.strftime("%Y-%m-%d %H:%M")
    return ""


def download_file(token: str, filename: str, dest_dir: Path, required: bool) -> bool:
    """ファイルをダウンロードして dest_dir に保存。成功したら True を返す。"""
    encoded = requests.utils.quote(filename, safe="")
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{encoded}:/content"
    res = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)

    if res.status_code == 200:
        dest = dest_dir / filename
        dest.write_bytes(res.content)
        size_kb = len(res.content) / 1024
        print(f"  [OK] {filename} ({size_kb:.0f} KB)")
        return True
    elif res.status_code == 404:
        print(f"  [WARN] {filename} が SharedMasters に見つかりません (スキップ)")
        return False
    else:
        raise RuntimeError(
            f"ダウンロード失敗 {filename}: HTTP {res.status_code} / {res.text[:200]}"
        )


def main():
    tenant_id = os.environ.get("AZURE_TENANT_ID", "").strip()
    client_id = os.environ.get("AZURE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("AZURE_CLIENT_SECRET", "").strip()

    if not all([tenant_id, client_id, client_secret]):
        print("[ERROR] 環境変数 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET が未設定です")
        sys.exit(1)

    DATA.mkdir(parents=True, exist_ok=True)
    print(f"出力先: {DATA}")
    print()

    print("トークン取得中...")
    token = get_token(tenant_id, client_id, client_secret)
    print("  [OK] 認証成功")
    print()

    print("=== 必須ファイル ===")
    missing_required = []
    for f in REQUIRED_FILES:
        try:
            ok = download_file(token, f, DATA, required=True)
            if not ok:
                missing_required.append(f)
        except RuntimeError as e:
            print(f"  [ERROR] {e}")
            missing_required.append(f)

    print()
    print("=== 任意ファイル ===")
    for f in OPTIONAL_FILES:
        try:
            download_file(token, f, DATA, required=False)
        except RuntimeError as e:
            print(f"  [WARN] {e}")

    # 有効在庫一覧表.csv の SharePoint 側 lastModifiedDateTime を保存
    # → build_shell.py が現在庫基準日として使用する
    print()
    print("=== 現在庫基準日メタデータ取得 ===")
    stock_mtime = get_file_last_modified(token, "有効在庫一覧表.csv")
    if stock_mtime:
        (DATA / "_stock_mtime.txt").write_text(stock_mtime, encoding="utf-8")
        print(f"  [OK] 有効在庫一覧表.csv の最終更新: {stock_mtime} (JST) → data/_stock_mtime.txt")
    else:
        print("  [WARN] 有効在庫一覧表.csv のメタデータ取得失敗")

    print()
    if missing_required:
        print(f"[WARN] 以下のファイルが取得できませんでした: {', '.join(missing_required)}")
        print("       ビルドは継続しますが、出力が不完全になる可能性があります。")
    else:
        print("[OK] 全必須ファイルのダウンロード完了")


if __name__ == "__main__":
    main()
