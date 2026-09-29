#!/usr/bin/env python3
"""
総務部が毎月作成する「支払決済スケジュール」(Excel/PDF)の中から、
全社に関係する重要日だけを company-calendar@hanaoka-corp.co.jp の
共有カレンダー(会社共通予定表)へ終日予定として登録する。

総務が確定させた月次スケジュールの日付をそのまま使う(営業日計算・祝日
調整をここで再現しない。手動修正が入ることがあるため、必ず総務が確定
させた月次ファイルから人が読み取った値を渡すこと)。

イベントは2種類に分けて登録する(company_schedule.html側で列を分けて
表示するため、Outlookのカテゴリ機能でタグ付けする):
  - "main": 総合会議・支払決済・給与決済など、その月のスケジュールの本編
  - "sub" : 資料完成・各部提出確認・銀行送金確認など、本編に対する
            内部の作業ステップ(締め日の数営業日前に発生するもの)
このスクリプトで作っていないイベント(担当者が手入力する入社案内や
ReHANAOKA展のような単発行事)にはカテゴリを付けないので、
company_schedule.html側では「カテゴリなし=イレギュラースケジュール」
として自動的に別列に表示される。

毎月の流れ:
  1. 総務から最新月のExcel/PDFを共有してもらう
  2. 対象イベント(日付・件名・main/subの別)を抽出する
     (詳しくは scripts/payment_schedule_ingest.md 参照)
  3. このスクリプトをローカルで実行する(EVENTS_JSON にイベント一覧の
     JSON文字列を渡す)

EVENTS_JSON の形式 (日付はYYYY-MM-DD、終日予定、column省略時は"main"):
  [
    {"date": "2026-10-06", "subject": "総合会議", "column": "main"},
    {"date": "2026-10-09", "subject": "<10日>支払決済資料 完成（担当：幹部）", "column": "sub"}
  ]

同じ日付・件名の予定が既にあれば作り直さない。ただしカテゴリが
未設定・不一致であれば付け直す(以前カテゴリ無しで登録した分の
後付け修正にも使える)。

環境変数:
  AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET - regenerate_facts.pyと共通
  EVENTS_JSON - 登録するイベントの一覧(JSON配列文字列)
"""
import os
import json
import requests
from datetime import datetime, timedelta

TENANT_ID = os.environ['AZURE_TENANT_ID']
CLIENT_ID = os.environ['AZURE_CLIENT_ID']
CLIENT_SECRET = os.environ['AZURE_CLIENT_SECRET']

CALENDAR_MAIL = 'company-calendar@hanaoka-corp.co.jp'
TZ = 'Tokyo Standard Time'

CATEGORY_BY_COLUMN = {
    'main': '総務スケジュール',
    'sub': '総務スケジュール補足',
}


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


def graph(token, method, path, **kwargs):
    url = path if path.startswith('http') else f"https://graph.microsoft.com/v1.0{path}"
    headers = kwargs.pop('headers', {})
    headers['Authorization'] = f'Bearer {token}'
    r = requests.request(method, url, headers=headers, timeout=60, **kwargs)
    r.raise_for_status()
    return r


def existing_events_on(token, date_str):
    """指定日(YYYY-MM-DD)に既に登録されている予定(id/件名/カテゴリ)の一覧。"""
    start = f"{date_str}T00:00:00"
    end = f"{date_str}T23:59:59"
    path = (f"/users/{CALENDAR_MAIL}/calendarView"
            f"?startDateTime={start}&endDateTime={end}&$select=id,subject,categories&$top=50")
    r = graph(token, 'GET', path, headers={'Prefer': f'outlook.timezone="{TZ}"'})
    return r.json().get('value', [])


def create_event(token, date_str, subject, category):
    start_date = datetime.strptime(date_str, '%Y-%m-%d')
    end_date = start_date + timedelta(days=1)
    body = {
        'subject': subject,
        'isAllDay': True,
        'showAs': 'free',
        'categories': [category],
        'start': {'dateTime': start_date.strftime('%Y-%m-%dT00:00:00'), 'timeZone': TZ},
        'end': {'dateTime': end_date.strftime('%Y-%m-%dT00:00:00'), 'timeZone': TZ},
    }
    graph(token, 'POST', f"/users/{CALENDAR_MAIL}/events", json=body)


def update_categories(token, event_id, category):
    graph(token, 'PATCH', f"/users/{CALENDAR_MAIL}/events/{event_id}", json={'categories': [category]})


def main():
    events = json.loads(os.environ['EVENTS_JSON'])
    token = get_token()

    existing_by_date = {}
    for ev in events:
        d = ev['date']
        if d not in existing_by_date:
            existing_by_date[d] = existing_events_on(token, d)

    created, updated, skipped = 0, 0, 0
    for ev in events:
        date_str, subject = ev['date'], ev['subject']
        column = ev.get('column', 'main')
        category = CATEGORY_BY_COLUMN[column]

        match = next((e for e in existing_by_date.get(date_str, []) if e['subject'] == subject), None)
        if match is None:
            create_event(token, date_str, subject, category)
            print(f"  登録: {date_str} [{column}] {subject}", flush=True)
            created += 1
        elif category not in (match.get('categories') or []):
            update_categories(token, match['id'], category)
            print(f"  カテゴリ更新: {date_str} [{column}] {subject}", flush=True)
            updated += 1
        else:
            print(f"  スキップ(既存): {date_str} {subject}", flush=True)
            skipped += 1

    print(f"完了: 登録{created}件 / カテゴリ更新{updated}件 / 既存スキップ{skipped}件", flush=True)


if __name__ == '__main__':
    main()
