#!/usr/bin/env python3
"""
総務部が毎月作成する「支払決済スケジュール」(Excel/PDF)の中から、
全社に関係する重要日だけを company-calendar@hanaoka-corp.co.jp の
共有カレンダー(会社共通予定表)へ終日予定として登録する。

総務が確定させた月次スケジュールの日付をそのまま使う(営業日計算・祝日
調整をここで再現しない。手動修正が入ることがあるため、必ず総務が確定
させた月次ファイルから人が読み取った値を渡すこと)。

毎月の流れ:
  1. 総務から最新月のExcel/PDFを共有してもらう
  2. 対象イベント(日付・件名)を抽出する
  3. このスクリプトをGitHub Actionsのworkflow_dispatchから実行する
     (EVENTS_JSON にイベント一覧のJSON文字列を渡す)

EVENTS_JSON の形式 (日付はYYYY-MM-DD、終日予定):
  [
    {"date": "2026-10-06", "subject": "総合会議"},
    {"date": "2026-10-08", "subject": "10日支払決済（担当：総務幹部）"}
  ]

同じ日付・件名の予定が既にあれば登録をスキップする
(誤って複数回実行しても重複登録しない)。

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


def existing_subjects_on(token, date_str):
    """指定日(YYYY-MM-DD)に既に登録されている予定の件名一覧(重複防止用)。"""
    start = f"{date_str}T00:00:00"
    end = f"{date_str}T23:59:59"
    path = (f"/users/{CALENDAR_MAIL}/calendarView"
            f"?startDateTime={start}&endDateTime={end}&$select=subject&$top=50")
    r = graph(token, 'GET', path, headers={'Prefer': f'outlook.timezone="{TZ}"'})
    return {ev['subject'] for ev in r.json().get('value', [])}


def create_event(token, date_str, subject):
    start_date = datetime.strptime(date_str, '%Y-%m-%d')
    end_date = start_date + timedelta(days=1)
    body = {
        'subject': subject,
        'isAllDay': True,
        'showAs': 'free',
        'start': {'dateTime': start_date.strftime('%Y-%m-%dT00:00:00'), 'timeZone': TZ},
        'end': {'dateTime': end_date.strftime('%Y-%m-%dT00:00:00'), 'timeZone': TZ},
    }
    graph(token, 'POST', f"/users/{CALENDAR_MAIL}/events", json=body)


def main():
    events = json.loads(os.environ['EVENTS_JSON'])
    token = get_token()

    existing_by_date = {}
    for ev in events:
        d = ev['date']
        if d not in existing_by_date:
            existing_by_date[d] = existing_subjects_on(token, d)

    created, skipped = 0, 0
    for ev in events:
        date_str, subject = ev['date'], ev['subject']
        if subject in existing_by_date.get(date_str, set()):
            print(f"  スキップ(既存): {date_str} {subject}", flush=True)
            skipped += 1
            continue
        create_event(token, date_str, subject)
        print(f"  登録: {date_str} {subject}", flush=True)
        created += 1

    print(f"完了: 登録{created}件 / 既存スキップ{skipped}件", flush=True)


if __name__ == '__main__':
    main()
