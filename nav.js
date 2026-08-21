(function () {
  /* アプリのグループ。現在開いているファイルが属するグループのタブだけを出す。
     支払管理のアプリを開いたときの挙動は従来と完全に同じ。 */
  var GROUPS = [
    {
      key: 'ap',
      apps: [
        { f: 'ap_dashboard.html',      l: 'ホーム' },
        { f: 'ap_review.html',         l: '経費のチェック' },
        { f: 'ap_purchase_match.html', l: '仕入のチェック' },
        { f: 'ap_entry.html',          l: '手入力' },
        { f: 'ap_recurring.html',      l: '毎月の支払' },
        { f: 'ap_payment.html',        l: '支払一覧・承認' }
      ]
    },
    {
      key: 'reserve',
      apps: [
        { f: 'demo_reserve.html', l: 'デモ機' },
        { f: 'car_reserve.html',  l: '営業車' }
      ]
    }
  ];

  var cur = (location.pathname.split('/').pop() || 'ap_dashboard.html').toLowerCase();

  function currentGroup() {
    for (var i = 0; i < GROUPS.length; i++) {
      for (var j = 0; j < GROUPS[i].apps.length; j++) {
        if (GROUPS[i].apps[j].f === cur) return GROUPS[i];
      }
    }
    /* どのグループにも載っていないページは、従来どおり支払管理タブを出す。
       nav.js を使っている既存ページ（case_management など）の挙動を変えないため。
       新しいグループに入れたいページは GROUPS に追記すればよい。 */
    return GROUPS[0];
  }

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
    var g = currentGroup();
    injectStyle();
    var html = '<div class="app-nav">' + g.apps.map(function (a) {
      var active = (a.f === cur) ? ' active' : '';
      return '<a data-file="' + a.f + '" class="' + active.trim() + '">' + a.l + '</a>';
    }).join('') + '</div>';
    slot.innerHTML = html;
    slot.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-file]');
      if (!a) return;
      e.preventDefault();
      if (a.getAttribute('data-file') === cur) return;
      var m = (g.key === 'ap') ? monthParam() : '';
      location.href = a.getAttribute('data-file') + (m ? ('?month=' + encodeURIComponent(m)) : '');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
