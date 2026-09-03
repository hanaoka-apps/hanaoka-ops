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
import sys
from pathlib import Path

import requests


BASE = Path(__file__).resolve().parent.parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from shared.m365_auth import acquire_application_token, graph_drive_item_url, load_settings

DATA = BASE / "data"

# アップロード対象: (ローカルパス, SharePoint上の名前)
TARGETS = [
    (DATA / "item_history.json", "item_history.json"),  # 仕入先名・金額(最機微)
    (DATA / "yama_data.json", "yama_data.json"),         # 山積み台数 (2026-06-11追加)
    (DATA / "results_production_data.json", "results_production_data.json"),  # 手配/在庫/受注/BOM (2026-06-13追加)
    (DATA / "seiban_progress.json", "seiban_progress.json"),  # 製番進捗(受注/部品/手配状態) (2026-06-13追加)
    (DATA / "seiban_gantt.json", "seiban_gantt.json"),  # 製番製造スケジュール(BOM×L/T逆算) (2026-06-17追加)
    (DATA / "work_instructions.json", "work_instructions.json"),  # 構成印刷(作業指示) (2026-06セキュリティ移行)
    (DATA / "orphan_items.json", "orphan_items.json"),  # 構成なし/登録漏れ/使用禁止品目(在庫探偵チップ) (2026-07セキュリティ移行)
    (DATA / "value_analysis.json", "value_analysis.json"),  # 全社付加価値・在庫分析 (認証配信)
]


def upload_file(token: str, drive_id: str, local_path: Path, sp_name: str) -> bool:
    if not local_path.exists():
        print(f"  [SKIP] {local_path.name} が無い(ビルド未生成)")
        return False
    url = graph_drive_item_url(drive_id, sp_name, content=True)
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
    try:
        settings = load_settings(base_dir=BASE)
    except RuntimeError as error:
        print(f"[ERROR] {error}")
        sys.exit(1)
    print("トークン取得中...")
    token = acquire_application_token(settings)
    print("  [OK] 認証成功")
    ok = 0
    skipped = 0   # ファイル未生成(そのビルドで作られていない)。異常ではない。
    failed = 0    # 実際のアップロード失敗(例外)。これがある時だけ異常終了。
    for local_path, sp_name in TARGETS:
        try:
            if upload_file(token, settings.shared_masters_drive_id, local_path, sp_name):
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
