#!/usr/bin/env python3
"""
ワンショット: dashboard_facts_history.json を初回作成する

実施内容:
  1. SharedMasters の dashboard_facts.json をダウンロード
  2. rows のうち FY2024以前（ym < 202504）を抽出
  3. dashboard_facts_history.json として SharedMasters にアップロード

このスクリプトは一度だけ実行する。以降は regenerate_facts.py が
history.json + 当期CSV をマージする運用に切り替わる。

完了後は SharedMasters の 2024年度売上実績.csv は削除可能。

環境変数:
  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
"""
import os, sys, json, time, requests
from datetime import datetime, timezone, timedelta

TENANT_ID = os.environ['AZURE_TENANT_ID']
CLIENT_ID = os.environ['AZURE_CLIENT_ID']
CLIENT_SECRET = os.environ['AZURE_CLIENT_SECRET']
DRIVE_ID = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8"

# 履歴とみなす境界（これ未満は履歴に入れる）
CURRENT_FY_START_YM = 202504  # FY2025 開始 = 2025年4月 = 202504


def get_token():
    url = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = {
        'grant_type': 'client_credentials',
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'scope': 'https://graph.microsoft.com/.default',
    }
    r = requests.post(url, data=data, timeout=30)
    r.raise_for_status()
    return r.json()['access_token']


def download_json(token, filename):
    enc = requests.utils.quote(filename, safe='')
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{enc}:/content"
    r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=180)
    r.raise_for_status()
    return r.json()


def upload_json(token, filename, data):
    enc = requests.utils.quote(filename, safe='')
    url = f"https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{enc}:/content"
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    r = requests.put(url, headers={
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }, data=body, timeout=300)
    r.raise_for_status()
    return r.json()


def main():
    jst = timezone(timedelta(hours=9))
    print(f"🚀 履歴JSON初回生成 [{datetime.now(jst).strftime('%Y-%m-%d %H:%M:%S JST')}]")

    print("\n🔑 トークン取得...")
    token = get_token()

    print("\n📥 既存の dashboard_facts.json を取得...")
    facts = download_json(token, 'dashboard_facts.json')
    all_rows = facts.get('rows', [])
    print(f"  全 rows: {len(all_rows):,}件")

    # FY2024以前のみ抽出（ym < 202504）
    history_rows = [r for r in all_rows if r and len(r) > 0 and r[0] and r[0] < CURRENT_FY_START_YM]
    current_rows = [r for r in all_rows if r and len(r) > 0 and r[0] and r[0] >= CURRENT_FY_START_YM]

    print(f"\n📊 分割:")
    print(f"  履歴 (ym < {CURRENT_FY_START_YM}): {len(history_rows):,}件")
    print(f"  当期 (ym >= {CURRENT_FY_START_YM}): {len(current_rows):,}件")

    # ym 範囲確認
    if history_rows:
        h_yms = [r[0] for r in history_rows]
        print(f"  履歴の ym 範囲: {min(h_yms)} 〜 {max(h_yms)}")

    history = {
        'rows': history_rows,
        'order_rows': [],  # 受注は履歴に持たない
        'build_meta': {
            'rows_count': len(history_rows),
            'historical_fy_max': 2024,
            'cutoff_ym': CURRENT_FY_START_YM,
            'created_at': datetime.now(jst).isoformat(),
            'note': '不変の過去データ。regenerate_facts.py が当期CSVとマージする',
        }
    }

    print("\n📤 dashboard_facts_history.json をアップロード...")
    upload_json(token, 'dashboard_facts_history.json', history)

    print(f"\n✅ 完了！")
    print(f"\n📌 次のステップ:")
    print(f"  1. SharedMasters の 2024年度売上実績.csv を削除可能（任意）")
    print(f"  2. 以降は regenerate_facts.py が毎日自動実行")


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"\n❌ エラー: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
