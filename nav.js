/*
 * 支払管理アプリ 共通ナビ。
 * 各HTMLの <head> に <script src="nav.js" defer></script> を入れ、
 * ヘッダー直下に <div id="app-nav-slot"></div> を置くだけで、
 * 全アプリ共通のタブナビ（現在地表示・アプリ切替・決済月引き継ぎ）を描画する。
 * 「単体HTML」原則はアプリ本体の話。共有jsの読込は msal-browser(CDN) と同じ構図で問題なし。
 */
(function () {
  var APPS = [
    { f: 'ap_dashboard.html',      l: 'ホーム' },
    { f: 'ap_review.html',         l: '経費のチェック' },
    { f: 'ap_purchase_match.html', l: '仕入のチェック' },
    { f: 'ap_entry.html',          l: '手入力' },
    { f: 'ap_recurring.html',      l: '毎月の支払' },
    { f: 'ap_payment.html',        l: '支払一覧・承認' }
  ];
  var cur = (location.pathname.split('/').pop() || 'ap_dashboard.html').toLowerCase();

  // 決済月：URLの ?month= 優先、なければ画面内の月セレクタの現在値
  function monthParam() {
    var u = new URLSearchParams(location.search);
    var m = u.get('month');
    if (!m) { var sel = document.getElementById('month-select'); if (sel && sel.value) m = sel.value; }
    return m || '';
  }

  function injectStyle() {
    if (document.getElementById('app-nav-style')) return;
    var s = document.createElement('style');
    s.id = 'app-nav-style';
    s.textContent =
      '#app-nav-slot .app-nav{display:flex;gap:2px;background:#fff;border-bottom:1px solid #d7dde6;padding:0 10px;overflow-x:auto;position:sticky;top:0;z-index:40}' +
      '#app-nav-slot .app-nav a{padding:11px 16px;font-size:14px;color:#48505a;text-decoration:none;border-bottom:3px solid transparent;white-space:nowrap;font-family:"Segoe UI","Meiryo",sans-serif;cursor:pointer}' +
      '#app-nav-slot .app-nav a:hover{background:#f4f6f9}' +
      '#app-nav-slot .app-nav a.active{color:#1a5fa8;font-weight:700;border-bottom-color:#1a5fa8}';
    document.head.appendChild(s);
  }

  function build() {
    var slot = document.getElementById('app-nav-slot');
    if (!slot) return;
    injectStyle();
    var html = '<div class="app-nav">' + APPS.map(function (a) {
      var active = (a.f === cur) ? ' active' : '';
      return '<a data-file="' + a.f + '" class="' + active.trim() + '">' + a.l + '</a>';
    }).join('') + '</div>';
    slot.innerHTML = html;
    // クリック時に「その時点の決済月」を付けて遷移（月セレクタは後から埋まるため）
    slot.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-file]');
      if (!a) return;
      e.preventDefault();
      if (a.getAttribute('data-file') === cur) return;
      var m = monthParam();
      location.href = a.getAttribute('data-file') + (m ? ('?month=' + encodeURIComponent(m)) : '');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
