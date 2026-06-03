#!/usr/bin/env python3
"""FUJIN 統合シェルHTML生成
- 上部にタブバー（今日やること／手配確定／製品ビュー／その他）
- 各タブはiframeで既存HTMLを読み込む
- 共通ヘッダにデータ基準日・最終更新時刻を表示
- URL hash でタブ状態保持（例: FUJIN.html#tab=arrange）
"""
from __future__ import annotations
from pathlib import Path
from datetime import datetime, date

ROOT = Path(__file__).resolve().parent
if ROOT.name == "scripts":
    ROOT = ROOT.parent

# ---- 動的ファイル検索: 件数や日付サフィックス付きの最新版を自動選択 ----
def _latest_match(pattern: str, fallback: str) -> str:
    """ROOT直下で pattern にマッチする最新mtimeのファイル名を返す。なければfallback。"""
    import glob
    cands = glob.glob(str(ROOT / pattern))
    if not cands: return fallback
    cands.sort(key=lambda p: Path(p).stat().st_mtime, reverse=True)
    return Path(cands[0]).name

ARRANGE_SRC = "results_production.html"  # 固定エイリアス(build_enhanced_summary.pyが両方生成)
TODAY_SRC = (
    "today.html" if (ROOT / "today.html").exists()
    else ("今日やること.html" if (ROOT / "今日やること.html").exists()
        else _latest_match("今日やること_v??_*.html", "今日やること_v16_0422.html"))
)
ORDTRACK_SRC = (
    "order_tracking.html" if (ROOT / "order_tracking.html").exists()
    else "受注追跡.html"
)

# ---- タブ定義（左から重要度順）----
TABS = [
    {
        "id": "stock_detective",
        "label": "構成ツリー",
        "icon": "🌲",
        "src": "stock_detective.html",
        "desc": "品目コードから構成ツリーを開き、現在庫・SMILE有効在庫を確認。出荷エラー時の原因究明にも。",
    },
    {
        "id": "work",
        "label": "構成印刷",
        "icon": "🖨",
        "src": "work_instruction.html",
        "desc": "品目+製番(任意)でBOMを1台あたり取数で印刷・CSV出力する辞書ツール。",
    },
    {
        "id": "arrange",
        "label": "手配確定",
        "icon": "⚡",
        "src": ARRANGE_SRC,
        "desc": "未確定手配のAI判定。FUJINの本丸。",
    },
    {
        "id": "usage",
        "label": "使い方",
        "icon": "📖",
        "src": "usage.html",
        "desc": "各タブの使い方ガイド。",
    },
]

# その他メニュー
# 今日やること/受注追跡/製番進捗/Phase2差分/在庫前日比は上部タブから外して、こちらに格納
OTHER = [
    # seiban_graph は大塚商会の製番展開ロジック回答待ち。雅さんローカルでのみ動作確認
    # (配布物には含めない。回答が来てロジック確定したら復活させる)
    {"id": "today",          "label": "🏠 今日やること",                     "src": "today.html"},
    {"id": "ordtrack",       "label": "📋 受注追跡",                         "src": "order_tracking.html"},
    {"id": "seiban_progress","label": "🏭 製番進捗(旧版・要修正)",            "src": "seiban_progress.html"},
    {"id": "sep1",           "label": "---",                                  "src": ""},
    {"id": "stock_diff",     "label": "📊 在庫前日比アラート",               "src": "stock_diff.html"},
    {"id": "phase2_diff",    "label": "🔬 Phase 2 差分(製番別BOM判定 検証用)","src": "phase2_diff.html"},
    {"id": "diff",           "label": "📊 差分フロー分析 (4/16→4/21)",       "src": "①差分フロー分析_0421.html"},
    {"id": "past",           "label": "📋 過去未完了 318件",                  "src": "過去未完了_318件.html"},
    {"id": "rosenzu",        "label": "🗺 α路線図（ビジョン）",               "src": "α路線図プロトタイプ_0421.html"},
    {"id": "sep2",           "label": "---",                                  "src": ""},
    {"id": "old_ai",         "label": "[旧版] AI手配判断アシスタント (4/14)", "src": "AI手配判断アシスタント.html"},
    {"id": "old_view",       "label": "[旧版] 手配確定ビューア (4/11)",       "src": "手配確定ビューア.html"},
]

# ---- 各ファイルの最終更新時刻 ----
def mtime_str(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        return "—"
    return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")

for t in TABS:
    t["mtime"] = mtime_str(t["src"])
for t in OTHER:
    if t["src"]:
        t["mtime"] = mtime_str(t["src"])
    else:
        t["mtime"] = ""

# データ基準日: OneDrive直読 → data/ → 今日 の順で解決
# (=「未確定_購買手配データ.csv」の更新時刻。SMILE→SharedMastersのRPA出力鮮度を表す。)
_shared_candidates = [
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    ROOT / "data",  # GitHub Actions フォールバック
]
SHARED = next((p for p in _shared_candidates if p.exists()), ROOT / "data")
shared_csv = SHARED / "未確定_購買手配データ.csv"
data_csv = ROOT / "data" / "未確定_購買手配データ.csv"
data_basis_dt = None
data_basis_full = ""  # YYYY-MM-DD HH:MM
for _p in [shared_csv, data_csv]:
    if _p.exists():
        _dt = datetime.fromtimestamp(_p.stat().st_mtime)
        data_basis_dt = _dt.date()
        data_basis = _dt.strftime("%Y-%m-%d")
        data_basis_full = _dt.strftime("%Y-%m-%d %H:%M")
        break
else:
    data_basis = date.today().isoformat()
    data_basis_full = data_basis

# 現在庫基準日: GitHub Actions では download_shared_masters.py が保存した
# data/_stock_mtime.txt（SharePoint の lastModifiedDateTime JST）を優先。
# ローカル実行時は 有効在庫一覧表.csv の mtime を直接使用。
_stock_mtime_file = ROOT / "data" / "_stock_mtime.txt"
_stock_csv_shared = SHARED / "有効在庫一覧表.csv"
stock_basis_full = ""
stock_basis_dt = None
if _stock_mtime_file.exists():
    # GitHub Actions 経由（SharePoint の正確な更新日時）
    _s = _stock_mtime_file.read_text(encoding="utf-8").strip()
    if _s:
        stock_basis_full = _s
        from datetime import datetime as _dt2
        try:
            stock_basis_dt = _dt2.strptime(_s, "%Y-%m-%d %H:%M").date()
        except ValueError:
            pass
elif _stock_csv_shared.exists():
    # OneDrive 直読（ローカル実行）
    _sdt = datetime.fromtimestamp(_stock_csv_shared.stat().st_mtime)
    stock_basis_dt = _sdt.date()
    stock_basis_full = _sdt.strftime("%Y-%m-%d %H:%M")

# データ鮮度警告(3日以上古ければヘッダで強調)
days_old = 0
if data_basis_dt:
    days_old = (date.today() - data_basis_dt).days
data_basis_html = data_basis_full
if days_old >= 3:
    data_basis_html = (
        f'{data_basis_full} '
        f'<span style="background:#fbbf24;color:#7c2d12;padding:1px 8px;border-radius:6px;'
        f'font-size:10.5px;font-weight:700;margin-left:6px">⚠ {days_old}日前 ・ SMILE→SharedMasters同期確認</span>'
    )

# 現在庫基準日HTML: ヘッダに併記
stock_basis_html = ""
if stock_basis_full:
    stock_days_old = (date.today() - stock_basis_dt).days if stock_basis_dt else 0
    _warn = ""
    if stock_days_old >= 3:
        _warn = (f' <span style="background:#fbbf24;color:#7c2d12;padding:1px 6px;'
                 f'border-radius:5px;font-size:10px;font-weight:700">⚠ {stock_days_old}日前</span>')
    stock_basis_html = stock_basis_full + _warn

# 最新生成時刻
now = datetime.now().strftime("%Y-%m-%d %H:%M")

# ---- HTML生成 ----
tabs_html = "\n".join(
    f'      <button class="tab" data-tab="{t["id"]}" data-src="{t["src"]}" title="{t["desc"]}">'
    f'<span class="tab-icon">{t["icon"]}</span>'
    f'<span class="tab-label">{t["label"]}</span>'
    f'</button>'
    for t in TABS
)

other_html = ""
for t in OTHER:
    if t["id"] == "sep":
        other_html += '        <div class="other-sep"></div>\n'
    else:
        other_html += (
            f'        <a class="other-item" data-tab="{t["id"]}" data-src="{t["src"]}">'
            f'<span class="other-label">{t["label"]}</span>'
            f'<span class="other-mtime">{t["mtime"]}</span></a>\n'
        )

HTML = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>FUJIN 統合ダッシュボード</title>
<style>
:root {{
  --bg:#f4f5f7; --panel:#fff; --line:#e5e7eb; --muted:#6b7280; --text:#1f2937;
  --primary:#2563eb; --primary-dark:#1e3a8a; --primary-bg:#eff6ff;
  --header-h:56px; --tab-h:56px;
}}
* {{ box-sizing:border-box; }}
html, body {{ margin:0; padding:0; height:100%; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; color:var(--text); background:var(--bg); }}

/* ===== ヘッダ ===== */
header {{
  height:var(--header-h); display:flex; align-items:center; justify-content:space-between;
  padding:0 20px; background:linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
  color:#fff; box-shadow:0 1px 3px rgba(0,0,0,.08);
}}
header .brand {{ display:flex; align-items:center; gap:12px; flex:1; min-width:0; }}
header .brand-logo {{ font-size:22px; flex-shrink:0; }}
header .brand-text {{ display:flex; flex-direction:column; min-width:0; }}
header .brand-text h1 {{ margin:0; font-size:16px; font-weight:600; letter-spacing:.02em; }}
header .brand-text .tagline-row {{ display:flex; align-items:center; gap:14px; margin-top:1px; white-space:nowrap; }}
header .brand-text .tagline {{ font-size:11px; opacity:.85; }}
header .brand-text .meta-inline {{ display:flex; gap:14px; align-items:center; font-size:11px; white-space:nowrap; }}
header .brand-text .meta-inline .k {{ opacity:.7; margin-right:4px; }}
header .brand-text .meta-inline .v {{ font-weight:600; }}

/* ===== タブバー（ピル型）===== */
.tabbar {{
  height:var(--tab-h); display:flex; align-items:center; background:#f8fafc;
  border-bottom:1px solid var(--line); padding:0 16px; gap:6px; position:relative;
}}
.tab {{
  display:flex; align-items:center; gap:8px;
  height:40px; padding:0 20px; border:1px solid transparent; background:transparent;
  border-radius:999px; cursor:pointer;
  font-size:14px; font-weight:600; color:#64748b;
  transition:all .15s ease; font-family:inherit; white-space:nowrap;
}}
.tab .tab-icon {{ font-size:16px; line-height:1; }}
.tab .tab-label {{ letter-spacing:.02em; }}
.tab:hover {{ background:#fff; color:var(--primary); border-color:var(--line); }}
.tab.active {{
  background:linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
  color:#fff; border-color:#1e40af;
  box-shadow:0 2px 6px rgba(37,99,235,.3), 0 0 0 3px rgba(37,99,235,.1);
}}
.tab.active:hover {{ color:#fff; }}

/* その他メニュー(開発者モード) — 初期は非表示。URL末尾に #dev=1 で表示 */
.other-btn {{
  margin-left:auto; display:none; align-items:center; gap:4px;
  height:40px; padding:0 16px; border:1px solid transparent; background:transparent;
  cursor:pointer; font-size:13px; color:#64748b; font-family:inherit;
  border-radius:999px; font-weight:500;
}}
.dev-mode .other-btn {{ display:flex !important; }}
.dev-mode-badge {{
  margin-left:auto; padding:3px 10px; font-size:10.5px; font-weight:700;
  background:#fef3c7; color:#92400e; border-radius:999px; border:1px solid #fde68a;
  display:none;
}}
.dev-mode .dev-mode-badge {{ display:inline-block !important; margin-left:8px; }}
.other-btn:hover {{ background:#fff; color:var(--text); border-color:var(--line); }}
.other-btn.has-active {{ background:#fff; color:var(--primary); border-color:var(--primary); font-weight:600; }}
.other-menu {{
  position:absolute; top:calc(var(--tab-h) - 4px); right:16px; background:#fff; border:1px solid var(--line);
  border-radius:10px; box-shadow:0 12px 28px rgba(0,0,0,.14); padding:6px; min-width:340px;
  display:none; z-index:100;
}}
.other-menu.open {{ display:block; }}
.other-item {{
  display:flex; justify-content:space-between; align-items:center; padding:10px 12px;
  text-decoration:none; color:var(--text); font-size:13px; border-radius:6px; cursor:pointer;
}}
.other-item:hover {{ background:var(--primary-bg); color:var(--primary-dark); }}
.other-item.active {{ background:var(--primary-bg); color:var(--primary-dark); font-weight:600; }}
.other-item .other-mtime {{ font-size:10.5px; color:var(--muted); }}
.other-sep {{ height:1px; background:var(--line); margin:6px 8px; }}
.other-note {{ padding:6px 12px; font-size:10.5px; color:var(--muted); font-style:italic; }}

/* ===== コンテンツ ===== */
.content {{
  height: calc(100vh - var(--header-h) - var(--tab-h));
  background:#fff; position:relative; overflow:hidden;
}}
.content iframe {{
  width:100%; height:100%; border:none; display:block; background:#fff;
}}
.content-empty {{
  display:flex; align-items:center; justify-content:center; height:100%;
  color:var(--muted); font-size:14px;
}}
.loader {{
  position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
  color:var(--muted); font-size:13px;
}}

/* ===== レスポンシブ ===== */
@media (max-width:900px) {{
  header .brand-text .meta-inline {{ display:none; }}
  .tab {{ padding:0 10px; font-size:12px; }}
  .tab-mtime {{ display:none; }}
}}

/* ===== 全画面モード (iframe内ボタンから postMessage で切替) ===== */
/* 構成ツリーを画面いっぱいに見たいとき用。もう一度ボタンを押すと解除。
   ヘッダーとタブバーの上に iframeコンテナをfixed positioningでオーバーレイ展開。 */
body.fujin-fullscreen-mode .content {{
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  z-index: 9999 !important;
  background: #fff !important;
}}
body.fujin-fullscreen-mode .content iframe {{
  width: 100% !important;
  height: 100% !important;
}}
</style>
</head>
<body>

<header>
  <div class="brand">
    <div class="brand-logo">🌬</div>
    <div class="brand-text">
      <h1>FUJIN 統合ダッシュボード</h1>
      <div class="tagline-row">
        <div class="tagline">生産管理AI判定システム（プロトタイプ統合版）</div>
        <div class="meta-inline">
          <div title="未確定_購買手配データ.csv の最終更新時刻 (RPA出力鮮度の代表)"><span class="k">データ基準日</span><span class="v">{data_basis_html}</span></div>
          <div title="有効在庫一覧表.csv の最終更新時刻 (現在庫の鮮度)"><span class="k">現在庫基準日</span><span class="v">{stock_basis_html}</span></div>
          <div><span class="k">統合版生成</span><span class="v">{now}</span></div>
        </div>
      </div>
    </div>
  </div>
</header>

<div class="tabbar">
{tabs_html}
  <span class="dev-mode-badge" title="URL末尾に #dev=1 を付けると有効化される開発者モード。雅さんだけ使う前提。">🔧 開発者モード</span>
  <button class="other-btn" id="other-btn">⋯ その他 ▾</button>
  <div class="other-menu" id="other-menu">
{other_html}        <div class="other-note">※ 開発・検証用ビュー。班長/全社向けには公開していません。</div>
  </div>
</div>

<div class="content">
  <iframe id="main-frame" src="about:blank" title="FUJIN タブコンテンツ"></iframe>
</div>

<script>
const frame = document.getElementById('main-frame');
const tabs = document.querySelectorAll('.tab');
const otherBtn = document.getElementById('other-btn');
const otherMenu = document.getElementById('other-menu');
const otherItems = document.querySelectorAll('.other-item');

// 開発者モード: URL hash に dev=1 が含まれていれば「その他」メニューを表示
// (雅さん用ブックマーク: FUJIN.html#dev=1 / または #tab=xxx&dev=1)
// 2026-05-18修正: sessionStorageベース(ブラウザ閉じたら自動解除)に変更
//   localStorageだと一度#dev=1踏むと永続化して挙動が分からなくなる事故が起きた
function _checkDevMode() {{
  // 強制無効化: dev=0 がURLにあれば即解除
  if (/(?:^|[#&])dev=0(?:&|$)/.test(location.hash)) {{
    try {{ sessionStorage.removeItem('_fujin_dev_mode'); }} catch(_) {{}}
    try {{ localStorage.removeItem('_fujin_dev_mode'); }} catch(_) {{}}  // 旧版互換
    document.body.classList.remove('dev-mode');
    return;
  }}
  // 旧版localStorageの掃除(初回アクセス時に1度だけ)
  try {{ localStorage.removeItem('_fujin_dev_mode'); }} catch(_) {{}}
  // 現セッションのみ有効化(タブを閉じれば消える)
  const hashHasDev = /(?:^|[#&])dev=1(?:&|$)/.test(location.hash);
  if (hashHasDev) {{
    try {{ sessionStorage.setItem('_fujin_dev_mode', '1'); }} catch(_) {{}}
  }}
  const sessDev = (function() {{
    try {{ return sessionStorage.getItem('_fujin_dev_mode') === '1'; }} catch(_) {{ return false; }}
  }})();
  if (hashHasDev || sessDev) {{
    document.body.classList.add('dev-mode');
  }}
}}
_checkDevMode();

function openTab(id, src, extra) {{
  if (!src) return;
  // アクティブ表示
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  // その他メニューの強調解除
  otherItems.forEach(o => o.classList.remove('active'));
  otherBtn.classList.remove('has-active');
  // iframe 切替（extra hash付与で遷移先に追加情報を渡す）
  const finalSrc = extra ? (src.indexOf('#') >= 0 ? src + '&' + extra : src + '#' + extra) : src;
  if (frame.dataset.currentTab !== id || extra) {{
    frame.src = finalSrc;
    frame.dataset.currentTab = id;
  }}
  // URL hash 更新
  const newHash = '#tab=' + id + (extra ? '&' + extra : '');
  if (location.hash !== newHash) {{
    history.replaceState(null, '', newHash);
  }}
  // その他メニューを閉じる
  otherMenu.classList.remove('open');
}}

// iframe からの「全画面化」要求を受信 (構成ツリーパネルをポップアップ的に大表示)
// 2026-05-21: iPad向け、構成ツリーを画面全体で見るための切替
window.addEventListener('message', (e) => {{
  if (!e.data || e.data.type !== 'fujin-fullscreen') return;
  document.body.classList.toggle('fujin-fullscreen-mode', !!e.data.full);
}});

// hash 変更検知（受注追跡 → 手配確定にcode付きで飛ぶ用）
window.addEventListener('hashchange', () => {{
  const m = location.hash.match(/tab=([^&]+)/);
  if (!m) return;
  const id = m[1];
  const codeMatch = location.hash.match(/code=([^&]+)/);
  const tab = Array.from(tabs).find(t => t.dataset.tab === id);
  if (tab) {{
    openTab(id, tab.dataset.src, codeMatch ? 'code=' + codeMatch[1] : null);
  }}
}});

// タブクリック
tabs.forEach(t => {{
  t.addEventListener('click', () => openTab(t.dataset.tab, t.dataset.src));
}});

// その他メニュー
otherBtn.addEventListener('click', (e) => {{
  e.stopPropagation();
  otherMenu.classList.toggle('open');
}});
document.addEventListener('click', (e) => {{
  if (!otherMenu.contains(e.target)) otherMenu.classList.remove('open');
}});
otherItems.forEach(it => {{
  it.addEventListener('click', () => {{
    // その他のタブは上部タブをアクティブにせず、その他ボタンを強調
    tabs.forEach(t => t.classList.remove('active'));
    otherItems.forEach(o => o.classList.remove('active'));
    if (it.dataset.src) {{
      frame.src = it.dataset.src;
      frame.dataset.currentTab = it.dataset.tab;
      it.classList.add('active');
      otherBtn.classList.add('has-active');
      history.replaceState(null, '', '#tab=' + it.dataset.tab);
    }}
    otherMenu.classList.remove('open');
  }});
}});

// MSAL認証パラメータ除外 (iframe伝搬防止)
function _extractExtraFromHash() {{
  const params = location.hash.replace(/^#/, '').split('&');
  const MSAL_PREFIXES = ['code=', 'state=', 'session_state=', 'client_info=', 'error=', 'error_description=', 'id_token=', 'access_token='];
  const extra = params.filter(p => {{
    if (!p) return false;
    if (p.startsWith('tab=')) return false;
    if (MSAL_PREFIXES.some(pre => p.startsWith(pre))) return false;
    return true;
  }}).join('&');
  return extra || null;
}}

// 初期表示: URL hash優先 → なければ「構成ツリー」(軽量, 20KB)
// 手配確定(results_production_2355.html, 7.5MB)を初期にするとメモリ食い潰しの恐れ
function init() {{
  const m = location.hash.match(/tab=([^&]+)/);
  const wantId = m ? m[1] : 'stock_detective';
  const extra = _extractExtraFromHash();
  // 上部タブ
  const foundTab = Array.from(tabs).find(t => t.dataset.tab === wantId);
  if (foundTab) {{
    openTab(wantId, foundTab.dataset.src, extra);
    return;
  }}
  // その他
  const foundOther = Array.from(otherItems).find(t => t.dataset.tab === wantId);
  if (foundOther && foundOther.dataset.src) {{
    frame.src = foundOther.dataset.src;
    frame.dataset.currentTab = wantId;
    return;
  }}
  // fallback (軽量タブ)
  openTab('stock_detective', 'stock_detective.html');
}}

// 認証ゲートが完了するまで init() を遅延させる
// 認証戻り直後 (URL hash に code=, state= 等) に init() が走ると
// MSAL が hash を処理する前に上書きされてしまい認証ループになる
function _fujinStartInit() {{
  if (window._fujinAuthAlreadyInitialized) return;
  window._fujinAuthAlreadyInitialized = true;
  init();
}}
if (window._fujinAuthReady) {{
  _fujinStartInit();
}} else {{
  window.addEventListener("_fujin_auth_ready", _fujinStartInit, {{ once: true }});
  // フォールバック: 認証ゲート無効環境または応答なしの場合 (15秒後)
  setTimeout(function() {{
    if (!window._fujinAuthAlreadyInitialized) _fujinStartInit();
  }}, 15000);
}}
</script>
</body>
</html>"""

out_path = ROOT / "FUJIN.html"
out_path.write_text(HTML, encoding="utf-8")
print(f"出力: {out_path}")
print(f"サイズ: {len(HTML):,} chars")
print(f"データ基準日: {data_basis}")
print(f"主要タブ: {[t['label'] for t in TABS]}")
print(f"その他: {len([t for t in OTHER if t['id']!='sep'])}件")
