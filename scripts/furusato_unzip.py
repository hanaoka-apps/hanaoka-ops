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

環境変数:
  SHARED_MASTERS_DIR  - OneDrive 同期済みの SharedMasters のパス。必須
  FURUSATO_ZIP_WORD   - パスワードの英語の部分。必須（秘密）
終了コード: 0=成功（処理するものがなかった場合も）、1=失敗した ZIP がある、2=設定が足りない
"""
import json
import os
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pyzipper
except ImportError:  # AES の ZIP を読むために必要。pip install pyzipper
    pyzipper = None

CONFIG = Path(__file__).resolve().parent.parent / 'ec_sales_config.json'
JST = timezone(timedelta(hours=9))
LOG_NAME = 'furusato_unzip.log'


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


def run(shared, word, conf):
    inbox = Path(shared) / conf['inboxDir']
    logdir = Path(shared) / '_rpa_queue' / 'logs'
    done, failed = inbox / 'done', inbox / 'failed'
    ng = 0
    for z in sorted(inbox.glob('*.zip')) if inbox.is_dir() else []:
        try:
            day = received_date(z)
            pws = candidate_passwords(word, day, conf['dateFormats'], conf['dateWindowDays'])
            got = extract_csv(z, pws, inbox / 'csv' / z.stem)
            done.mkdir(exist_ok=True); shutil.move(str(z), str(done / z.name))
            log(logdir, f'解凍しました: {z.name} → csv/{z.stem}/ （{len(got)}ファイル）')
        except Exception as e:      # パスワードや中身は書かない
            ng += 1
            failed.mkdir(exist_ok=True)
            try: shutil.move(str(z), str(failed / z.name))
            except OSError: pass
            log(logdir, f'失敗: {z.name}: {e}')
    for f in (done, failed):
        if f.is_dir(): sweep(f, conf['keepDays'])
    return 1 if ng else 0


def main():
    shared, word = os.environ.get('SHARED_MASTERS_DIR'), os.environ.get('FURUSATO_ZIP_WORD')
    if not shared or not word:
        print('SHARED_MASTERS_DIR と FURUSATO_ZIP_WORD の環境変数が必要です', file=sys.stderr); return 2
    return run(shared, word, load_conf())


if __name__ == '__main__':
    sys.exit(main())
