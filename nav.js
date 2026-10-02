(function () {
  /* アプリのグループ。現在開いているファイルが属するグループのタブだけを出す。
     支払管理のアプリを開いたときの挙動は従来と完全に同じ。 */
  var GROUPS = [
    {
      key: 'ap',
      apps: [
        { f: 'ap_dashboard.html',      l: 'ホーム' },
        { f: 'ap_review.html',         l: '経費のチェック' },
        { f: 'ap_smile_import.html',   l: '仕入（SMILE）' },
        { f: 'ap_entry.html',          l: '手入力' },
        { f: 'ap_recurring.html',      l: '毎月の支払' },
        { f: 'ap_payment.html',        l: '支払（決裁・出力）' }
      ]
    },
    {
      key: 'reserve',
      apps: [
        { f: 'my_schedule.html', l: '自分の予定' },
        { f: 'demo_reserve.html', l: 'デモ機' },
        { f: 'car_reserve.html',  l: '営業車' },
        { f: 'room_reserve.html', l: '会議室' },
        { f: 'staff_schedule.html', l: '全社員の予定' },
        { f: 'reserve_manual.html', l: '使い方' }
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

  /* ============================================================
     予約状況グループ：左のサイドバー
     ------------------------------------------------------------
     hanaoka_hub.html / sales_report_dashboard.html と同じデザイン。見た目は
     reserve_theme.css（各ページが読み込む）、メニューの中身はここ1か所だけで管理する。
     ============================================================ */
  var ICONS = {
    'my_schedule.html':    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="m9 15 2 2 4-4"/>',
    'demo_reserve.html':   '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    'car_reserve.html':    '<path d="M5 16h14l-1.5-6a2 2 0 0 0-1.9-1.5H8.4A2 2 0 0 0 6.5 10z"/><path d="M4 16v3M20 16v3"/><circle cx="8" cy="13" r=".6"/><circle cx="16" cy="13" r=".6"/>',
    'room_reserve.html':   '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M2 21h20M8 8h2M8 12h2M8 16h2"/>',
    'staff_schedule.html': '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/>',
    'reserve_manual.html': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>'
  };
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var SB_KEY = 'hanaoka.reserve.sidebar.v1';
  /* 開閉：手で切り替えたらその選択をこの端末に覚える。覚えていなければ画面幅で決める
     （広いPCは開く、それより狭いPCはアイコンだけ。1024px以下は上の横帯になる）。 */
  function sbState() {
    try { var v = localStorage.getItem(SB_KEY); if (v === 'open' || v === 'closed') return v; } catch (e) {}
    return window.innerWidth >= 1400 ? 'open' : 'closed';
  }
  function sbApply(v) {
    var h = document.documentElement;
    h.classList.toggle('hx-open', v === 'open');
    h.classList.toggle('hx-closed', v === 'closed');
  }
  function buildSidebar(g) {
    if (document.getElementById('hx-sidebar')) return;
    var aside = document.createElement('aside');
    aside.className = 'hx-sidebar'; aside.id = 'hx-sidebar';
    aside.innerHTML =
      '<a class="hx-brand" href="hanaoka_hub.html" title="HANAOKA HUB へ">' +
        '<div class="hx-mark">' + svg('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/>') + '</div>' +
        '<div class="hx-brand-name">予約状況<small>HANAOKA RESERVE</small></div>' +
      '</a>' +
      '<div class="hx-label">MENU</div>' +
      g.apps.map(function (a) {
        return '<a class="hx-item' + (a.f === cur ? ' active' : '') + '" href="' + a.f + '" title="' + a.l + '">' +
          svg(ICONS[a.f] || '') + '<span>' + a.l + '</span></a>';
      }).join('') +
      '<div class="hx-foot">' +
        '<a class="hx-item" href="hanaoka_hub.html" title="HANAOKA HUB">' +
          svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/>') + '<span>HANAOKA HUB</span></a>' +
        '<button type="button" class="hx-item hx-toggle" id="hx-toggle" title="サイドバーを開閉">' +
          '<svg class="hx-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span>たたむ</span></button>' +
      '</div>';
    document.body.insertBefore(aside, document.body.firstChild);
    sbApply(sbState());
    document.getElementById('hx-toggle').addEventListener('click', function () {
      var next = document.documentElement.classList.contains('hx-closed') ? 'open' : 'closed';
      try { localStorage.setItem(SB_KEY, next); } catch (e) {}
      sbApply(next);
    });
    /* 手で切り替えていない端末は、ウィンドウ幅を変えたときも既定に追従する */
    window.addEventListener('resize', function () {
      var saved = null; try { saved = localStorage.getItem(SB_KEY); } catch (e) {}
      if (!saved) sbApply(sbState());
    });
  }

  function build() {
    var g = currentGroup();
    if (g.key === 'reserve') { buildSidebar(g); return; }
    var slot = document.getElementById('app-nav-slot');
    if (!slot) return;
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
