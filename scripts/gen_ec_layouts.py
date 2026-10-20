"""EC売上アプリ用：SMILE取込ファイルの見出し行を既存の取込ファイルから取り出して ec_sales_layouts.js を作る。
使い方: python scripts/gen_ec_layouts.py  （見出しはSMILEの取込レイアウトで、変わらない限り再生成は不要）"""
import csv, json, os, sys
BASE = os.environ.get('SMILE_MANUAL_DIR') or os.path.join(os.path.expanduser('~'), 'OneDrive - 花岡車輌 株式会社', 'ドキュメント', 'Claude', 'SMILEマニュアル一式')
def head(path):
    with open(path, encoding='utf-16', newline='') as f:
        return next(csv.reader(f, delimiter='\t'))
juchu = head(os.path.join(BASE, '明細取込', '受注明細_テスト_新規1伝票.txt'))
nyukin = head(os.path.join(BASE, '明細取込', '入金明細_取込用_上書きベース_FY2026.txt'))
nouhin = head(os.path.join(BASE, 'マスタ取込', '納品先マスタ_テスト_新規110101-999999.txt'))
out = '// 自動生成: scripts/gen_ec_layouts.py（SMILEの取込ファイルの見出し行）。手で直さない。\n'
out += 'var EC_LAYOUTS = ' + json.dumps({'juchu': juchu, 'nyukin': nyukin, 'nouhin': nouhin}, ensure_ascii=False) + ';\n'
out += 'if (typeof module !== "undefined") module.exports = EC_LAYOUTS;\n'
with open(os.path.join(os.path.dirname(__file__), '..', 'ec_sales_layouts.js'), 'w', encoding='utf-8', newline='\n') as f:
    f.write(out)
print(len(juchu), len(nyukin), len(nouhin))
