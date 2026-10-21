#!/usr/bin/env python3
"""
Teams のチャネルへ、報告の文章を投稿する（EC売上アプリの「取込と突合の結果」の報告用）。

RPA専用機の常駐スクリプト（rpa_queue_worker.ps1 の ジョブ type: notify = ec_report）が、毎回 GitHub の main から取得して実行する。
PAD は使わない。標準ライブラリ以外は requests だけ。

使い方:
  python post_teams.py --input parts.json
    parts.json = { "parts": ["本文1", "本文2", ...] }（アプリが作る。長い報告は分割してある）か、文字列の配列。
    --input を省くと標準入力から同じ形の JSON を読む。

投稿先:
  環境変数 EC_TEAMS_WEBHOOK_URL（Teams のチャネルの「ワークフロー」の Webhook の URL。名前は --webhook-env で変えられる）。
  **専用機の環境変数にだけ置く。リポジトリ・アプリ・ログ・エラー文には出さない**（この中でも、URL を含む文字を出力しない）。
  Webhook の作成（Teams 側の「ワークフロー」→「Webhook 要求を受信したらチャネルに投稿する」）の細かい手順は要確認。

投稿の形（Teams ワークフローの Webhook が受け付ける Adaptive Card のメッセージ）:
  { "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive",
      "content": { "type": "AdaptiveCard", "version": "1.4", "body": [{ "type": "TextBlock", "wrap": true, "text": "本文" }] } }] }

差し替え方（専用機の担当が既存の Teams 通知の仕組みに置き換えたいとき）:
  rpa_jobs.json の ec_report の "script" を別のスクリプト名にする。同じ引数（--input <parts.json> --webhook-env <環境変数名>）を受け取り、
  成功したら終了コード 0、失敗したら 0 以外で、理由を1行（URL を含めない）標準出力に出せばよい。

終了コード: 0＝投稿した／1＝投稿に失敗／2＝URL（環境変数）が未設定・入力が不正
標準出力の最後の行が、常駐スクリプトを通して依頼の失敗理由（画面の「報告に失敗」）になる。
"""
import argparse
import json
import os
import sys

DEFAULT_ENV = 'EC_TEAMS_WEBHOOK_URL'
TIMEOUT = 30


def out(msg):
    print(msg, flush=True)


def build_payload(text):
    """Teams ワークフローの Webhook に送る JSON（Adaptive Card）。"""
    return {
        'type': 'message',
        'attachments': [{
            'contentType': 'application/vnd.microsoft.card.adaptive',
            'content': {
                '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                'type': 'AdaptiveCard',
                'version': '1.4',
                'body': [{'type': 'TextBlock', 'wrap': True, 'text': text}],
            },
        }],
    }


def read_parts(path):
    """parts.json（または標準入力）から本文の配列を読む。"""
    if path:
        with open(path, encoding='utf-8-sig') as f:
            raw = f.read()
    else:
        raw = sys.stdin.read()
    data = json.loads(raw)
    parts = data.get('parts') if isinstance(data, dict) else data
    if not isinstance(parts, list) or not parts or not all(isinstance(p, str) and p.strip() for p in parts):
        raise ValueError('本文（parts）が空か、文字列の配列ではありません')
    return parts


def scrub(text, url):
    """エラー文に URL（秘密）が入らないようにする。"""
    return str(text).replace(url, '<webhook>') if url else str(text)


def post_all(url, parts, session=None):
    """parts を順に投稿する。失敗したら例外（メッセージに URL は含めない）。"""
    if session is None:
        import requests
        session = requests
    for i, text in enumerate(parts, 1):
        try:
            res = session.post(url, json=build_payload(text), timeout=TIMEOUT)
        except Exception as e:   # requests の例外には URL が入ることがある
            raise RuntimeError('%d/%d 件目の投稿で通信エラー（%s）' % (i, len(parts), type(e).__name__))
        status = getattr(res, 'status_code', 0)
        if not (200 <= status < 300):
            raise RuntimeError('%d/%d 件目の投稿が拒否されました（HTTP %s）' % (i, len(parts), status))


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(description='Teams のチャネルへ報告を投稿する')
    ap.add_argument('--input', default=None, help='本文の JSON（省略すると標準入力）')
    ap.add_argument('--webhook-env', default=DEFAULT_ENV, help='Webhook の URL を入れた環境変数の名前')
    args = ap.parse_args(argv)
    url = (os.environ.get(args.webhook_env) or '').strip()
    if not url:
        out('NG: 環境変数 %s が設定されていません（専用機の環境変数に Teams の Webhook の URL を設定してください）' % args.webhook_env)
        return 2
    try:
        parts = read_parts(args.input)
    except Exception as e:
        out('NG: 報告の本文を読めません（%s）' % scrub(type(e).__name__ + ': ' + str(e)[:80], url))
        return 2
    try:
        post_all(url, parts, session)
    except Exception as e:
        out('NG: %s' % scrub(e, url))
        return 1
    out('OK: %d 件を投稿しました' % len(parts))
    return 0


if __name__ == '__main__':
    sys.exit(main())
