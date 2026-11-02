#!/usr/bin/env python3
"""
出荷・配送の検索用：運送会社がメールで送ってくるパスワード付きZIPを、専用機で解凍して CSV にする（トナミ運輸のイージープロWeb「送信」）。

流れ: 業務センターが、出荷した日にイージープロWebの出荷指示一覧で「送信」を押す
      → 運送会社からメールが届く → Power Automate が、添付の ZIP を SharedMasters/<inboxDir>/<会社のフォルダ>/ に保存する
      → このスクリプトが解凍して、CSV を <会社のフォルダ>/csv/<ZIPの名前>/ に置く
      → ZIP は done/（失敗は failed/）へ移す。CSV は scripts/build_ship_index.py が読んで、売上№と送り状番号をつなぐ。
RPA専用機のタスクスケジューラーから、数分おきに実行する想定。手順は scripts/rpa_setup/出荷_送り状番号_専用機への依頼内容.md。

どの会社を解凍するかは ship_config.json の carriers.<キー>.zip で決める（書いてある会社だけ）：
  "zip": { "passwordEnv": "環境変数の名前", "keepDays": 14, "csvKeepDays": 200 }
パスワード（トナミは、イージープロWebのユーザーID）は、passwordEnv の名前の環境変数にだけ置く。
**値はコード・設定・ログ・チャットに書かない**（環境変数の「名前」だけが設定ファイルにある）。

環境変数:
  SHARED_MASTERS_DIR  - OneDrive 同期済みの SharedMasters のパス。必須
  <passwordEnv>       - ZIP のパスワード。必須（秘密）
引数: --config <ship_config.json のパス>（省略するとリポジトリの ship_config.json）
標準ライブラリで動く。AES 暗号の ZIP を読むときだけ pyzipper を使う（pip install pyzipper。あれば常にこちらを使う）。
終了コード: 0=成功（処理するものがなかった場合も）、1=失敗した ZIP がある、2=設定が足りない
"""
import argparse
import json
import os
import shutil
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pyzipper
except ImportError:
    pyzipper = None

CONFIG = Path(__file__).resolve().parent.parent / 'ship_config.json'
JST = timezone(timedelta(hours=9))
LOG_NAME = 'ship_unzip.log'


def load_conf(path=CONFIG):
    """設定から、解凍する会社の一覧 [{key, name, dir, passwordEnv, keepDays, csvKeepDays}] と inboxDir を返す。"""
    conf = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    inbox = conf.get('inboxDir')
    if not inbox:
        raise ValueError('ship_config.json に inboxDir がありません')
    targets = []
    for key, c in (conf.get('carriers') or {}).items():
        if key.startswith('_') or not isinstance(c, dict) or not c.get('zip'):
            continue
        z = c['zip']
        if not z.get('passwordEnv') or not c.get('dir'):
            raise ValueError('carriers.%s の zip.passwordEnv と dir が必要です' % key)
        targets.append({'key': key, 'name': c.get('name', key), 'dir': c['dir'], 'passwordEnv': z['passwordEnv'],
                        'keepDays': int(z.get('keepDays', 14)), 'csvKeepDays': int(z.get('csvKeepDays', 200))})
    return {'inboxDir': inbox, 'targets': targets}


def extract_csv(zip_path, password, dest):
    """CSV だけを dest に平らに取り出す。取り出したファイル名の一覧を返す。パスワードが合わなければ ValueError"""
    opener = pyzipper.AESZipFile if pyzipper is not None else zipfile.ZipFile
    try:
        with opener(zip_path) as z:
            names = [n for n in z.namelist() if n.lower().endswith('.csv') and not n.endswith('/')]
            if not names:
                raise ValueError('ZIP に CSV がありません')
            z.setpassword(password.encode('utf-8'))
            files = {Path(n).name: z.read(n) for n in names}     # パスワードが違うとここで例外。フォルダ名は捨てる（../ 対策）
    except NotImplementedError as e:                              # AES の ZIP を pyzipper なしで開こうとした
        raise ValueError('AES 暗号の ZIP です（pip install pyzipper が必要です）') from e
    except (RuntimeError, zipfile.BadZipFile) as e:               # 違うパスワード＝RuntimeError
        raise ValueError('パスワードが合いません（または ZIP が壊れています）') from e
    dest.mkdir(parents=True, exist_ok=True)
    for n, data in files.items():
        (dest / n).write_bytes(data)
    return list(files)


def log(logdir, msg):
    logdir.mkdir(parents=True, exist_ok=True)
    line = datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S ') + msg
    print(line)
    with open(logdir / LOG_NAME, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def sweep(folder, days, pattern='*.zip'):
    """古い処理済みのファイル・フォルダを消す（個人情報を残さない）"""
    limit = datetime.now().timestamp() - days * 86400
    for p in folder.glob(pattern):
        if p.stat().st_mtime < limit:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink()


def run(shared, conf, env=None):
    env = os.environ if env is None else env
    logdir = Path(shared) / '_rpa_queue' / 'logs'
    ng = 0
    for t in conf['targets']:
        folder = Path(shared) / conf['inboxDir'] / t['dir']
        if not folder.is_dir():
            continue
        zips = sorted(folder.glob('*.zip'))
        password = env.get(t['passwordEnv'])
        if zips and not password:
            log(logdir, '%s: 環境変数 %s が設定されていません（解凍できません）' % (t['name'], t['passwordEnv']))
            ng += 1
            continue
        done, failed = folder / 'done', folder / 'failed'
        for z in zips:
            try:
                got = extract_csv(z, password, folder / 'csv' / z.stem)
                done.mkdir(exist_ok=True)
                shutil.move(str(z), str(done / z.name))
                log(logdir, '%s: 解凍しました: %s → csv/%s/ （%dファイル）' % (t['name'], z.name, z.stem, len(got)))
            except Exception as e:     # パスワードや中身は書かない
                ng += 1
                failed.mkdir(exist_ok=True)
                try:
                    shutil.move(str(z), str(failed / z.name))
                except OSError:
                    pass
                log(logdir, '%s: 失敗: %s: %s' % (t['name'], z.name, e))
        for f in (done, failed):
            if f.is_dir():
                sweep(f, t['keepDays'])
        if (folder / 'csv').is_dir():
            sweep(folder / 'csv', t['csvKeepDays'], '*')
    return 1 if ng else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='運送会社のパスワード付きZIPを解凍して CSV にする')
    ap.add_argument('--config', default=str(CONFIG), help='ship_config.json のパス')
    args = ap.parse_args(argv)
    shared = os.environ.get('SHARED_MASTERS_DIR')
    if not shared:
        print('SHARED_MASTERS_DIR の環境変数が必要です', file=sys.stderr)
        return 2
    try:
        conf = load_conf(args.config)
    except Exception as e:
        print('設定ファイルを読めません（%s）: %s' % (type(e).__name__, e), file=sys.stderr)
        return 2
    return run(shared, conf)


if __name__ == '__main__':
    sys.exit(main())
