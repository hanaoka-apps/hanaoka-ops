#!/usr/bin/env python3
"""
ふるさと納税の注文メール（gyoumu@ 宛・パスワード付きZIP）を、専用機で解凍して CSV にする。

流れ: Power Automate が、届いたメールの ZIP を SharedMasters/<inboxDir>/ に保存する
      → このスクリプトが解凍して CSV を <inboxDir>/csv/<ZIPの名前>/ に置く
      → ZIP は done/（失敗は failed/）へ移す。
RPA専用機のタスクスケジューラーから、数分おきに実行する想定。手順は
scripts/rpa_setup/EC売上_RPA専用機への依頼内容.md の「3-11」。

パスワード = 英語（小文字・秘密）＋ 届いた日（形式は ec_sales_config.json の furusato.dateFormats）。
英語の部分はコード・設定・ログに書かない。専用機の環境変数 FURUSATO_ZIP_WORD にだけ置く。

ZIP のファイル名の先頭が yyyyMMdd（Power Automate が付ける）ならその日を「届いた日」とし、
なければファイルの更新日（日本時間）を使う。0時前後でずれることがあるので、
furusato.dateWindowDays 日ぶん前後の日付も試す。

解凍できたら、新しい注文を Teams のチャット「EC売上_自動入力通知」に通知する（例「ふるさと納税 新しい注文 1件：発注番号 2630248 9,240円」）。
  金額は、画面と同じく対応表（furusato_config.json。共有の設定ファイルがあればそちら）の契約単価（税抜）×数量×1.1。対応表に無い商品があれば「金額未確定」。
  載せるのは発注番号と金額だけ（お客様の名前・住所・電話は載せない）。最後に「アプリ：<URL>」を付ける（URL は furusato_config.json の notify.appUrl）。同じ発注番号は2回通知しない
  （通知済みは SharedMasters/_rpa_queue/state/furusato_notified.json。送れたときだけ更新し、送れなかった分は次の回に送り直す）。
  通知に失敗しても解凍は成功のまま（ログに「通知に失敗」）。詳しくは order_notify.py

環境変数:
  SHARED_MASTERS_DIR  - OneDrive 同期済みの SharedMasters のパス。必須
  FURUSATO_ZIP_WORD   - パスワードの英語の部分。必須（秘密）
  EC_TEAMS_WEBHOOK_URL - (任意) Teams の Webhook の URL（ec_report と同じ。秘密）。無ければ通知しない（ログに残す）
終了コード: 0=成功（処理するものがなかった場合も）、1=失敗した ZIP がある、2=設定が足りない
"""
import csv
import io
import json
import os
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

try:
    import pyzipper
except ImportError:  # AES の ZIP を読むために必要。pip install pyzipper
    pyzipper = None

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I で動かしても、同じフォルダの order_notify.py を読めるように
import order_notify  # noqa: E402

CONFIG = Path(__file__).resolve().parent.parent / 'ec_sales_config.json'
FURUSATO_CONFIG = Path(__file__).resolve().parent.parent / 'furusato_config.json'   # 商品番号→契約単価の対応表（画面と同じ金額を出すため）
JST = timezone(timedelta(hours=9))
LOG_NAME = 'furusato_unzip.log'
NOTIFIED_NAME = 'furusato_notified.json'   # 通知済みの発注番号（SharedMasters/_rpa_queue/state/）


def load_conf(path=CONFIG):
    f = json.loads(Path(path).read_text(encoding='utf-8')).get('furusato') or {}
    if not f.get('inboxDir') or not f.get('dateFormats'):
        raise ValueError('ec_sales_config.json に furusato（inboxDir・dateFormats）がありません')
    return {'inboxDir': f['inboxDir'], 'dateFormats': f['dateFormats'],
            'dateWindowDays': int(f.get('dateWindowDays', 1)), 'keepDays': int(f.get('keepDays', 30))}


def received_date(zip_path):
    m = re.match(r'^(\d{4})[-_]?(\d{2})[-_]?(\d{2})', zip_path.name)
    if m:
        try:
            return datetime(int(m[1]), int(m[2]), int(m[3])).date()
        except ValueError:
            pass
    return datetime.fromtimestamp(zip_path.stat().st_mtime, JST).date()


def candidate_passwords(word, day, formats, window):
    """届いた日 → 前後の日 の順。同じものは1回だけ"""
    out, seen = [], set()
    for off in [0] + [s * i for i in range(1, window + 1) for s in (-1, 1)]:
        d = day + timedelta(days=off)
        for fmt in formats:
            p = word + d.strftime(fmt)
            if p not in seen:
                seen.add(p); out.append(p)
    return out


def extract_csv(zip_path, passwords, dest):
    """CSV だけを dest に平らに取り出す。取り出したファイル名の一覧を返す。パスワードが合わなければ ValueError"""
    if pyzipper is None:
        raise RuntimeError('pyzipper が入っていません（pip install pyzipper）')
    last = None
    for pw in passwords:
        try:
            with pyzipper.AESZipFile(zip_path) as z:
                names = [n for n in z.namelist() if n.lower().endswith('.csv') and not n.endswith('/')]
                if not names:
                    raise ValueError('ZIP に CSV がありません')
                z.setpassword(pw.encode('ascii'))
                files = {Path(n).name: z.read(n) for n in names}   # パスワードが違うとここで例外。フォルダ名は捨てる（../ 対策）
            dest.mkdir(parents=True, exist_ok=True)
            for n, data in files.items():
                (dest / n).write_bytes(data)
            return list(files)
        except (RuntimeError, pyzipper.BadZipFile) as e:   # 違うパスワード＝RuntimeError
            last = e
    raise ValueError('パスワードが合いません（' + str(len(passwords)) + '通りを試しました）') from last


def log(logdir, msg):
    logdir.mkdir(parents=True, exist_ok=True)
    line = datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S ') + msg
    print(line)
    with open(logdir / LOG_NAME, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def sweep(folder, days):
    """古い処理済みの ZIP を消す（個人情報を残さない）"""
    limit = datetime.now().timestamp() - days * 86400
    for p in folder.glob('*.zip'):
        if p.stat().st_mtime < limit:
            p.unlink()


def unwrap(v):
    """Excel の式の形 ="A112170384" から値を取り出す（画面の FS.unwrap と同じ）"""
    s = str(v if v is not None else '').strip()
    m = re.match(r'^="?([\s\S]*?)"?$', s)
    return (m.group(1) if m else s).strip()


def mkey(t):
    """対応表の照合用（画面の EC.matchKey と同じ：全角半角・大文字小文字・空白・× を同じに見る）"""
    s = unicodedata.normalize('NFKC', str(t or '')).lower()
    return re.sub(r'\s+', '', s).replace('×', 'x').replace('✕', 'x').replace('✖', 'x')


def read_orders(csv_path):
    """注文CSV（Shift_JIS）→ {発注番号: [(商品番号, 数量), …]}。1行＝1品。読めない・列が無いときは空"""
    raw = Path(csv_path).read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp932', errors='replace')
    out = {}
    rows = csv.reader(io.StringIO(text, newline=''))
    head = next(rows, None) or []
    col = {unwrap(h): i for i, h in enumerate(head)}
    if '発注番号' not in col or '商品番号' not in col:
        return out
    for r in rows:
        get = lambda k: unwrap(r[col[k]]) if k in col and col[k] < len(r) else ''   # noqa: E731
        oid = get('発注番号')
        if not oid.isdigit():
            continue
        try:
            qty = int(get('数量')) or 1
        except ValueError:
            qty = 1
        out.setdefault(oid, []).append((get('商品番号'), qty))
    return out


def load_rules(shared, settings_name=None):
    """商品番号→契約単価（税抜）の対応表。リポジトリの furusato_config.json が基本で、
    SharedMasters に画面で保存した共有の設定ファイル（furusato_settings.json）があれば、その対応表を優先する（画面と同じ金額になるように）"""
    conf = json.loads(FURUSATO_CONFIG.read_text(encoding='utf-8-sig'))
    rules = (conf.get('mapping') or {}).get('rules') or []
    name = settings_name or (conf.get('files') or {}).get('settings')
    if name:
        try:
            shared_conf = json.loads((Path(shared) / name).read_text(encoding='utf-8-sig'))
            r2 = (shared_conf.get('mapping') or {}).get('rules')
            if isinstance(r2, list) and r2:
                rules = r2
        except (OSError, ValueError):
            pass   # 共有の設定が無い・読めないときは、リポジトリの対応表
    return rules


def order_total(lines, rules):
    """注文の合計金額（税込）。画面（FS.priceOrder）と同じく、契約単価（税抜）×数量×1.1 を行ごとに四捨五入して足す。
    対応表に無い商品が1つでもあれば None（金額未確定）"""
    total = Decimal(0)
    for sku, qty in lines:
        k = mkey(sku)
        rule = next((r for r in rules if any(mkey(w) == k for w in (r.get('words') or []))), None)
        if not rule or rule.get('net') is None:
            return None
        total += (Decimal(str(rule['net'])) * qty * Decimal('1.1')).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return total


def notify_candidates(csv_dirs, rules, logger):
    """解凍した CSV から、通知する注文 [(発注番号, '発注番号 2630248 9,240円')] を作る（同じ発注番号は1件。名前・住所・電話は入れない）"""
    seen = {}
    for d in csv_dirs:
        for p in sorted(Path(d).glob('*.csv')):
            try:
                orders = read_orders(p)
            except Exception as e:
                logger(f'注文を読めません（通知できません）: {p.name}: {type(e).__name__}')
                continue
            if not orders:
                logger(f'通知できる注文が見つかりません: {p.name}')
            for oid, lines in orders.items():
                if oid not in seen:
                    seen[oid] = f'発注番号 {oid} {order_notify.yen(order_total(lines, rules))}'
    return list(seen.items())


def run(shared, word, conf, session=None, rules=None):
    """session＝Teams に投稿する通信（試験用に差し替える。普通は None）／rules＝金額の計算に使う対応表（試験用。普通は読み込む）"""
    inbox = Path(shared) / conf['inboxDir']
    logdir = Path(shared) / '_rpa_queue' / 'logs'
    done, failed = inbox / 'done', inbox / 'failed'
    ng = 0
    new_dirs = []
    for z in sorted(inbox.glob('*.zip')) if inbox.is_dir() else []:
        try:
            day = received_date(z)
            pws = candidate_passwords(word, day, conf['dateFormats'], conf['dateWindowDays'])
            got = extract_csv(z, pws, inbox / 'csv' / z.stem)
            done.mkdir(exist_ok=True); shutil.move(str(z), str(done / z.name))
            log(logdir, f'解凍しました: {z.name} → csv/{z.stem}/ （{len(got)}ファイル）')
            new_dirs.append(inbox / 'csv' / z.stem)
        except Exception as e:      # パスワードや中身は書かない
            ng += 1
            failed.mkdir(exist_ok=True)
            try: shutil.move(str(z), str(failed / z.name))
            except OSError: pass
            log(logdir, f'失敗: {z.name}: {e}')
    for f in (done, failed):
        if f.is_dir(): sweep(f, conf['keepDays'])
    # 新しい注文の Teams 通知（解凍できたら、その場で。夜・土日も）。失敗しても解凍は成功のまま。
    # 通知済みの記録は送れたときだけ更新し、送れなかった注文は次の回に送り直す（pending）。同じ発注番号は2回通知しない
    try:
        if rules is None:
            rules = load_rules(shared)
        logger = lambda m: log(logdir, m)   # noqa: E731
        cands = notify_candidates(new_dirs, rules, logger)
        order_notify.notify_new('ふるさと納税', cands, order_notify.state_path(shared, NOTIFIED_NAME), logger,
                                first_run_silent=False, keep_pending=True, session=session,
                                footer=order_notify.app_footer(FURUSATO_CONFIG))   # 最後に「アプリ：<URL>」（URL は furusato_config.json の notify.appUrl）
    except Exception as e:
        log(logdir, f'Teams への通知に失敗（{type(e).__name__}）')
    return 1 if ng else 0


def main():
    shared, word = os.environ.get('SHARED_MASTERS_DIR'), os.environ.get('FURUSATO_ZIP_WORD')
    if not shared or not word:
        print('SHARED_MASTERS_DIR と FURUSATO_ZIP_WORD の環境変数が必要です', file=sys.stderr); return 2
    return run(shared, word, load_conf())


if __name__ == '__main__':
    sys.exit(main())
