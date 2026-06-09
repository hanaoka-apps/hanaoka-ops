#!/usr/bin/env python3
"""FUJIN 統合シェルHTML生成 (白ヘッダ版 / テンプレート方式)

2026-06-10 改修:
  これまで build_shell.py は HTML を Python 内の文字列で組み立てていたが、
  雅さんが 2026-05-31〜06-02 に作り込んだ「白コンパクトヘッダ版」(山リスト追加・
  Tablerアイコン・逆引き検証一時非公開・最終更新ホバー툴팁・戻るボタン) が
  git履歴(fujin/FUJIN.html @ 1a6e8ef)にしか残っておらず、日次ビルドの旧版build_shell.py
  (青verbose・4タブ)が毎朝それを上書きしていた。
  → 白版 FUJIN.html を scripts/fujin_shell.template.html としてテンプレ化し、
    日付プレースホルダだけ差し込んで出力する方式に変更。これで日次ビルドが
    白版を出し続ける。HTML本体(タブ構成・デザイン)はテンプレ側を編集すればよい。

  テンプレ内プレースホルダ:
    __LAST_UPDATE__  最終更新 (MM-DD)
    __DATA_BASIS__   データ基準日 (未確定_購買手配データ.csv mtime)
    __STOCK_BASIS__  現在庫基準日 (有効在庫一覧表.csv / _stock_mtime.txt)
    __GEN_TIME__     統合版生成 (このビルド時刻)
"""
from __future__ import annotations
from pathlib import Path
from datetime import datetime, date

ROOT = Path(__file__).resolve().parent
if ROOT.name == "scripts":
    ROOT = ROOT.parent

TEMPLATE_PATH = ROOT / "scripts" / "fujin_shell.template.html"

# ---- データ基準日: OneDrive直読 → data/ → 今日 の順で解決 ----
# (=「未確定_購買手配データ.csv」の更新時刻。SMILE→SharedMastersのRPA出力鮮度を表す。)
_shared_candidates = [
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    ROOT / "data",  # GitHub Actions フォールバック
]
SHARED = next((p for p in _shared_candidates if p.exists()), ROOT / "data")
shared_csv = SHARED / "未確定_購買手配データ.csv"
data_csv = ROOT / "data" / "未確定_購買手配データ.csv"
data_basis_full = ""
for _p in [shared_csv, data_csv]:
    if _p.exists():
        _dt = datetime.fromtimestamp(_p.stat().st_mtime)
        data_basis_full = _dt.strftime("%Y-%m-%d %H:%M")
        break
else:
    data_basis_full = date.today().isoformat()

# ---- 現在庫基準日: GitHub Actions では download_shared_masters.py が保存した
# data/_stock_mtime.txt（SharePoint の lastModifiedDateTime JST）を優先。
# ローカル実行時は 有効在庫一覧表.csv の mtime を直接使用。----
_stock_mtime_file = ROOT / "data" / "_stock_mtime.txt"
_stock_csv_shared = SHARED / "有効在庫一覧表.csv"
stock_basis_full = ""
if _stock_mtime_file.exists():
    _s = _stock_mtime_file.read_text(encoding="utf-8").strip()
    if _s:
        stock_basis_full = _s
elif _stock_csv_shared.exists():
    _sdt = datetime.fromtimestamp(_stock_csv_shared.stat().st_mtime)
    stock_basis_full = _sdt.strftime("%Y-%m-%d %H:%M")
if not stock_basis_full:
    stock_basis_full = "—"

# ---- ビルド時刻 ----
_now_dt = datetime.now()
now = _now_dt.strftime("%Y-%m-%d %H:%M")
last_update = _now_dt.strftime("%m-%d")  # 「最終更新 MM-DD」表記用

# ---- テンプレ読込 → 日付差込 → 出力 ----
if not TEMPLATE_PATH.exists():
    raise SystemExit(f"[ERROR] テンプレートが見つかりません: {TEMPLATE_PATH}")

html = TEMPLATE_PATH.read_text(encoding="utf-8")
html = (
    html.replace("__LAST_UPDATE__", last_update)
        .replace("__DATA_BASIS__", data_basis_full)
        .replace("__STOCK_BASIS__", stock_basis_full)
        .replace("__GEN_TIME__", now)
)

out_path = ROOT / "FUJIN.html"
out_path.write_text(html, encoding="utf-8")
print(f"出力: {out_path}")
print(f"テンプレ: {TEMPLATE_PATH.name} ({len(html):,} chars)")
print(f"最終更新: {last_update} / データ基準日: {data_basis_full} / 現在庫基準日: {stock_basis_full} / 生成: {now}")

# ── 静的タブHTMLを auth_dist/ にコピー ──────────────────────────────────
# auth_wrapper.py はROOT直下のファイルをコピーするが、GitHub Actions では
# ROOTに静的HTMLがない。build_shell.py 時点でまとめてコピーすることで確実に配置する。
import shutil as _shutil
_auth_dist = ROOT / "auth_dist"
_static_dir = ROOT / "static"
if _auth_dist.exists() and _static_dir.exists():
    print(f"\n[静的ファイルコピー] {_static_dir} → {_auth_dist}")
    _copied = 0
    for _item in _static_dir.iterdir():
        if _item.name.startswith('.'):
            _dst = _auth_dist / _item.name
            _shutil.copy2(_item, _dst)
            _copied += 1
            continue
        if _item.is_file():
            _dst = _auth_dist / _item.name
            _shutil.copy2(_item, _dst)
            _copied += 1
        elif _item.is_dir():
            _dst = _auth_dist / _item.name
            if _dst.exists():
                _shutil.rmtree(_dst)
            _shutil.copytree(_item, _dst)
            _copied += 1
    print(f"  コピー完了: {_copied} 件")
    _nojekyll = _auth_dist / ".nojekyll"
    if not _nojekyll.exists():
        _nojekyll.touch()
        print(f"  .nojekyll 作成")
elif not _static_dir.exists():
    print(f"[WARN] static/ フォルダが存在しません: {_static_dir}")
