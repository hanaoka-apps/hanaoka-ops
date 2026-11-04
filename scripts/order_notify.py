#!/usr/bin/env python3
"""
新しい注文が届いたことを、Teams のチャットに知らせる共通の部品。
shopify_fetch.py（Shopify の毎時の取得）と furusato_unzip.py（ふるさと納税のZIP解凍）が使う。

送り方は post_teams.py（EC売上の取込結果の報告 ec_report と同じ）に合わせる：
  投稿先の URL は専用機の環境変数 EC_TEAMS_WEBHOOK_URL（Teams のワークフローの Webhook）。コード・ログ・チャットに出さない。
載せるのは件数・注文番号・金額だけ。お客様の名前・住所・電話は載せない。

通知済みの記録（SharedMasters/_rpa_queue/state/*.json）：
  { "orders": { "<注文番号>": "<通知済みにした日時 UTC>" }, "pending": { "<注文番号>": "<通知の文>" } }
  ・通知を送れたときだけ更新する（失敗したら記録しない。次の回に送り直せる）。
  ・記録のファイルがまだ無い最初の1回は、記録だけして通知しない（first_run_silent。今ある注文を一度に送らないため）。
  ・記録のファイルを読めないときは、通知を止める（空として扱うと、過去の注文を一度に送ってしまうため）。ファイルを直すか消す。
  ・pending は keep_pending=True のとき、送れなかった注文を次の回に持ち越す（ふるさと納税。Shopify は毎時の取得で自然に再判定される）。
通知の失敗は呼び出し元の取得・解凍を失敗にしない（このモジュールは例外を外に出さない）。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I で動かしても、同じフォルダの post_teams.py を読めるように
import post_teams  # noqa: E402

DEFAULT_ENV = post_teams.DEFAULT_ENV
STATE_DIR = ('_rpa_queue', 'state')
MAX_CHARS = 3000        # 1通の長さ（ec_report と同じ。長いときは分ける）
KEEP_DAYS = 120         # 記録を残す日数（Shopify の取得は直近55日。これより古い注文は二度と出てこない）


def state_path(shared_dir, name):
    return Path(shared_dir).joinpath(*STATE_DIR, name)


def _now_iso(now=None):
    return (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')


def load_state(path):
    """('missing', 空の記録) / ('ok', 記録) / ('broken', 理由)"""
    p = Path(path)
    if not p.exists():
        return 'missing', {'orders': {}, 'pending': {}}
    try:
        d = json.loads(p.read_text(encoding='utf-8-sig'))
        if not isinstance(d, dict) or not isinstance(d.get('orders', {}), dict):
            raise ValueError('形が違います')
        pend = d.get('pending', {})
        return 'ok', {'orders': dict(d.get('orders') or {}), 'pending': dict(pend) if isinstance(pend, dict) else {}}
    except Exception as e:
        return 'broken', type(e).__name__


def save_state(path, state, now=None, keep_days=KEEP_DAYS):
    """一時ファイルに書いてから置き換える（途中で失敗しても前の記録は壊れない）。古い記録は消す。"""
    limit = _now_iso((now or datetime.now(timezone.utc)) - timedelta(days=keep_days))
    out = {'orders': {k: v for k, v in state['orders'].items() if str(v) >= limit}, 'pending': state.get('pending', {})}
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.tmp')
    try:
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def yen(amount, currency='JPY'):
    """12800 → '12,800円'。円以外の通貨は金額の後ろに通貨コードを付ける。None は '金額未確定'"""
    if amount is None:
        return '金額未確定'
    d = Decimal(str(amount))
    txt = '{:,}'.format(int(d)) if d == d.to_integral_value() else '{:,.2f}'.format(d)
    return txt + '円' if (currency or 'JPY') == 'JPY' else '{} {}'.format(txt, currency)


def app_footer(config_path):
    """設定ファイルの notify.appUrl があれば「アプリ：<URL>」の1行を返す。無い・読めないときは ''（通知は止めない）。
    URL はコードに書かず、設定ファイル（ec_sales_config.json・furusato_config.json）に置く。"""
    try:
        url = str(((json.loads(Path(config_path).read_text(encoding='utf-8-sig')).get('notify')) or {}).get('appUrl') or '').strip()
    except Exception:
        return ''
    return 'アプリ：' + url if url else ''


def build_messages(label, items, max_chars=MAX_CHARS, footer=''):
    """items＝[(注文番号, 表示の文)] → 通知の文のリスト [(文, [この文に入れた注文番号])]。
    例：「Shopify 新しい注文 2件：#1801 12,800円、#1802 3,300円」。長いときは分けて、末尾に（1/2）を付ける。
    footer（例「アプリ：https://…」）があれば、分けた各通の最後に空行をはさんで付ける。"""
    if footer:
        max_chars = max(1, max_chars - len(footer) - 2)   # 各通に付ける分の長さを引いて分ける
    chunks, cur, cur_len = [], [], 0
    for oid, text in items:
        add = len(text) + 1
        if cur and cur_len + add > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append((oid, text))
        cur_len += add
    if cur:
        chunks.append(cur)
    out = []
    for i, ch in enumerate(chunks, 1):
        msg = '{} 新しい注文 {}件：{}'.format(label, len(ch), '、'.join(t for _, t in ch))
        if len(chunks) > 1:
            msg += '（{}/{}）'.format(i, len(chunks))
        if footer:
            msg += '\n\n' + footer
        out.append((msg, [oid for oid, _ in ch]))
    return out


def send(text, env_name=DEFAULT_ENV, session=None):
    """1通送る。成功なら (True, '')、失敗なら (False, 理由)。理由に URL は入れない。"""
    url = (os.environ.get(env_name) or '').strip()
    if not url:
        return False, 'Teams への投稿先が未設定です（専用機の環境変数 {} に Webhook の URL を設定してください）'.format(env_name)
    try:
        post_teams.post_all(url, [text], session)
    except Exception as e:
        return False, post_teams.scrub(e if str(e) else type(e).__name__, url)
    return True, ''


def notify_new(label, candidates, path, log, first_run_silent=True, keep_pending=False, env_name=DEFAULT_ENV, session=None, now=None, footer='', silent=False):
    """まだ通知していない注文があれば、まとめて通知する。結果の文字列を返す（例外は出さない）：
       'seeded'（最初の1回。記録だけ）／'none'（新しい注文なし）／'sent'（全部送れた）／'failed'（送れなかった分がある）／'skipped'（記録を読めない）
    candidates＝[(注文番号, 表示の文)]。キャンセル・テストの注文は呼び出し側で除いておく。
    footer＝各通の最後に付ける1行（開くアプリの URL。app_footer で設定ファイルから作る）。"""
    try:
        kind, state = load_state(path)
        if kind == 'broken':
            log('通知の記録を読めません（{}）。通知を止めています。ファイルを直すか削除してください（削除すると次回は記録だけします）'.format(state))
            return 'skipped'
        if kind == 'missing' and first_run_silent:
            now_s = _now_iso(now)
            state['orders'] = {oid: now_s for oid, _ in candidates}
            save_state(path, state, now)
            log('通知の記録を作りました（{}件。最初の1回なので通知はしません）'.format(len(state['orders'])))
            return 'seeded'
        known = state['orders']
        if silent:   # 過去分の取り込み（バックフィル）：通知はせず、通知済みとして記録だけする（あとから通知が出ないように）
            now_s = _now_iso(now)
            added = 0
            for oid, _ in candidates:
                if oid not in known:
                    known[oid] = now_s; added += 1
                state['pending'].pop(oid, None)
            if added:
                save_state(path, state, now)
            log('通知を止めて記録しました（{}件。過去分の取り込み）'.format(added))
            return 'seeded'
        todo, seen = [], set()
        pending = state.get('pending', {}) if keep_pending else {}
        for oid, text in list(pending.items()) + list(candidates):
            if oid not in known and oid not in seen:
                seen.add(oid)
                todo.append((oid, text))
        if not todo:
            return 'none'
        failed_reason, sent_ids = '', []
        for msg, ids in build_messages(label, todo, MAX_CHARS, footer):
            ok, reason = send(msg, env_name, session)
            if not ok:
                failed_reason = reason
                break
            now_s = _now_iso(now)
            for oid in ids:
                known[oid] = now_s
                state['pending'].pop(oid, None)
            sent_ids += ids
            save_state(path, state, now)   # 送れた分だけ、その場で記録（途中で失敗しても、送った注文を二重に送らない）
        left = [(oid, text) for oid, text in todo if oid not in set(sent_ids)]
        if keep_pending:
            for oid, text in left:
                state['pending'][oid] = text
            if left or sent_ids:
                save_state(path, state, now)
        if sent_ids:
            log('Teams に通知しました（{}件）'.format(len(sent_ids)))
        if left:
            log('Teams への通知に失敗（{}件。{}）{}'.format(len(left), failed_reason, '。次の回に送り直します'))
            return 'failed'
        return 'sent'
    except Exception as e:   # 通知のせいで取得・解凍を失敗にしない。詳細は型名だけ
        log('Teams への通知に失敗（{}）'.format(type(e).__name__))
        return 'failed'
