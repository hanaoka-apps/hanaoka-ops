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

メンション（依頼した人への通知）:
  入力の JSON に "mention": { "id": "<メール(UPN)>", "name": "<表示名>" } があれば、最初の投稿の本文の先頭に「<at>表示名</at> EC取込の結果です。」を入れ、
  Adaptive Card の msteams.entities に { "type": "mention", "text": "<at>表示名</at>", "mentioned": { "id": メール, "name": 表示名 } } を付ける。
  mention が無い・使えない形（メールの形でない・表示名が空など）のときは、メンションなしで投稿する（失敗にはしない）。
  表示名・メールは社員の情報で、お客様の名前・住所・電話ではない。
  投稿先は、チャネルでも、チャット（ワークフローの「Webhook アラートをチャットに送信する」）でもよい（Webhook の形は同じ）。

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
import re
import sys

DEFAULT_ENV = 'EC_TEAMS_WEBHOOK_URL'
MAIL_RE = re.compile(r'^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$')
TIMEOUT = 30


def out(msg):
    print(msg, flush=True)


def normalize_mention(raw):
    """メンション情報 { "id": メール(UPN), "name": 表示名 } を検べて (id, name) を返す。使えない形なら None（メンションなしで投稿する）。
    表示名・メールは社員の情報（お客様の個人情報ではない）。< > や制御文字は取り除く（本文の <at> の形を壊さないため）。"""
    if not isinstance(raw, dict):
        return None
    uid, name = raw.get('id'), raw.get('name')
    if not isinstance(uid, str) or not isinstance(name, str):
        return None
    uid = uid.strip()
    name = ''.join(ch for ch in name if ch.isprintable() and ch not in '<>&').strip()[:100]
    if not name or not MAIL_RE.match(uid) or len(uid) > 254:
        return None
    return uid, name


def build_payload(text, mention=None):
    """Teams ワークフローの Webhook に送る JSON（Adaptive Card）。
    mention（normalize_mention の結果）があれば、本文の先頭に <at>表示名</at> を入れ、msteams.entities にメンションを付ける。"""
    body_text = text
    content = {
        '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
        'type': 'AdaptiveCard',
        'version': '1.4',
    }
    if mention:
        uid, name = mention
        tag = '<at>%s</at>' % name
        body_text = '%s EC取込の結果です。\n\n%s' % (tag, text)
        content['msteams'] = {'entities': [{'type': 'mention', 'text': tag, 'mentioned': {'id': uid, 'name': name}}]}
    content['body'] = [{'type': 'TextBlock', 'wrap': True, 'text': body_text}]
    return {
        'type': 'message',
        'attachments': [{'contentType': 'application/vnd.microsoft.card.adaptive', 'content': content}],
    }


def read_input(path):
    """parts.json（または標準入力）から (本文の配列, メンション情報) を読む。
    形：{ "parts": [...], "mention": { "id": "メール", "name": "表示名" } }（mention は省略できる）か、文字列の配列。
    mention が無い・使えない形のときは None（メンションなしで投稿する。投稿は失敗させない）。"""
    if path:
        with open(path, encoding='utf-8-sig') as f:
            raw = f.read()
    else:
        raw = sys.stdin.read()
    data = json.loads(raw)
    parts = data.get('parts') if isinstance(data, dict) else data
    if not isinstance(parts, list) or not parts or not all(isinstance(p, str) and p.strip() for p in parts):
        raise ValueError('本文（parts）が空か、文字列の配列ではありません')
    mention = normalize_mention(data.get('mention')) if isinstance(data, dict) else None
    return parts, mention


def read_parts(path):
    """本文の配列だけ（互換用）。"""
    return read_input(path)[0]


def scrub(text, url):
    """エラー文に URL（秘密）が入らないようにする。"""
    return str(text).replace(url, '<webhook>') if url else str(text)


def post_all(url, parts, session=None, mention=None):
    """parts を順に投稿する（メンションは最初の1件だけ）。失敗したら例外（メッセージに URL は含めない）。"""
    if session is None:
        import requests
        session = requests
    for i, text in enumerate(parts, 1):
        try:
            res = session.post(url, json=build_payload(text, mention if i == 1 else None), timeout=TIMEOUT)
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
        parts, mention = read_input(args.input)
    except Exception as e:
        out('NG: 報告の本文を読めません（%s）' % scrub(type(e).__name__ + ': ' + str(e)[:80], url))
        return 2
    try:
        post_all(url, parts, session, mention)
    except Exception as e:
        out('NG: %s' % scrub(e, url))
        return 1
    out('OK: %d 件を投稿しました%s' % (len(parts), '（メンションあり）' if mention else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
