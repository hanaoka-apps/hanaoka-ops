(function () {
  /* アプリのグループ。現在開いているファイルが属するグループのタブだけを出す。
     支払管理のアプリを開いたときの挙動は従来と完全に同じ。 */
  var GROUPS = [
    {
      key: 'ap',
      apps: [
        { f: 'ap_dashboard.html',      l: 'ホーム' },
        { f: 'ap_expense.html',        l: '経費' },
        { f: 'ap_smile_import.html',   l: '仕入（SMILE）' },
        { f: 'ap_entry.html',          l: '手入力' },
        { f: 'ap_recurring.html',      l: '毎月の支払' },
        { f: 'ap_payment.html',        l: '支払（決裁・出力）' }
      ]
    },
    {
      key: 'reserve',
      /* スケジュール（HANAOKA SCHEDULE）。HUBの「全社スケジュール」カードからもここへ来る */
      apps: [
        { f: 'company_schedule.html', l: '全社スケジュール' },
        { f: 'my_schedule.html', l: '自分の予定' },
        { f: 'staff_schedule.html', l: '全社員の予定' },
        { f: 'demo_reserve.html', l: 'デモ機' },
        { f: 'car_reserve.html',  l: '営業車' },
        { f: 'room_reserve.html', l: '会議室' },
        { f: 'reserve_manual.html', l: '使い方' }
      ]
    },
    {
      key: 'kaikei',
      apps: [
        { f: 'kaikei_dashboard.html', l: '会計サマリー' },
        { f: 'kaikei_monthly.html',   l: '月次資料' },
        { f: 'kaikei_cash.html',      l: '資金繰り' },
        { f: 'kaikei_ledger.html',    l: '仕訳明細' },
        { f: 'kaikei_budget.html',    l: '予算' },
        { f: 'kaikei_upload.html',    l: 'データ取り込み' }
      ]
    },
    {
      key: 'payroll',
      /* 給与ダッシュボード（モダン）と同じメニュー。モダンは自前のサイドバーを持っているので
         nav.js は読まない。クラシック表示（payroll_dashboard.html）を開いているときも
         「給与ダッシュボード」を光らせる（alt）。アップロードはメニューに載せない（also） */
      apps: [
        { f: 'payroll_dashboard_modern.html', l: '給与ダッシュボード', alt: ['payroll_dashboard.html'] },
        { f: 'payroll_detail.html',   l: '支給控除一覧表' },
        { f: 'payroll_leave.html',    l: '年次有給休暇管理' },
        { f: 'payroll_people.html',   l: '人事情報' },
        { f: 'payroll_overtime.html', l: '時間外確認' }
      ],
      also: ['payroll_upload.html'],
      /* 時間外確認は、給与の権限が無い総務の担当者も使う。給与の項目は、画面側が権限を
         確かめてから出す（.payroll-only の hide を外す）。サイドバーの項目もそれに乗せる */
      gate: { page: 'payroll_overtime.html', cls: 'payroll-only' }
    }
  ];

  var cur = (location.pathname.split('/').pop() || 'ap_dashboard.html').toLowerCase();

  function isCur(a) { return a.f === cur || (a.alt || []).indexOf(cur) >= 0; }
  function currentGroup() {
    for (var i = 0; i < GROUPS.length; i++) {
      if ((GROUPS[i].also || []).indexOf(cur) >= 0) return GROUPS[i];
      for (var j = 0; j < GROUPS[i].apps.length; j++) {
        if (isCur(GROUPS[i].apps[j])) return GROUPS[i];
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
    if (!m) { var sel = document.getElementById('month-select') || document.getElementById('month'); if (sel && sel.value) m = sel.value; }
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
    'company_schedule.html': '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="M7.5 13.5h.01M12 13.5h.01M16.5 13.5h.01M7.5 17h.01M12 17h.01"/>',
    'my_schedule.html':    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="m9 15 2 2 4-4"/>',
    'demo_reserve.html':   '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    'car_reserve.html':    '<path d="M5 16h14l-1.5-6a2 2 0 0 0-1.9-1.5H8.4A2 2 0 0 0 6.5 10z"/><path d="M4 16v3M20 16v3"/><circle cx="8" cy="13" r=".6"/><circle cx="16" cy="13" r=".6"/>',
    'room_reserve.html':   '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M2 21h20M8 8h2M8 12h2M8 16h2"/>',
    'staff_schedule.html': '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/>',
    'reserve_manual.html': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
    // 支払管理
    'ap_dashboard.html':     '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    'ap_expense.html':       '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h7"/>',
    'ap_smile_import.html':  '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    'ap_entry.html':         '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    'ap_recurring.html':     '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    'ap_payment.html':       '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
    // 会計
    'kaikei_dashboard.html': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'kaikei_monthly.html':   '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 13h7M9 17h4"/>',
    'kaikei_cash.html':      '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>',
    'kaikei_ledger.html':    '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
    'kaikei_budget.html':    '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/>',
    'kaikei_upload.html':    '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    // 給与・労務
    'payroll_dashboard_modern.html': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'payroll_detail.html':   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    'payroll_leave.html':    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="m9 15 2 2 4-4"/>',
    'payroll_people.html':   '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/>',
    'payroll_overtime.html': '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4"/>'
  };
  // グループごとの名前とマーク（サイドバーの上）
  var BRAND = {
    reserve: { name: 'スケジュール', sub: 'HANAOKA SCHEDULE', mark: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/>', key: 'hanaoka.reserve.sidebar.v1' },
    ap:      { name: '支払管理', sub: 'HANAOKA AP', mark: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8.5 9h4M8.5 12h3"/><path d="M12.5 14l1.75 2.25L16 14M14.25 16.25V19M12.75 17h3"/>', key: 'hanaoka.ap.sidebar.v1' },
    kaikei:  { name: '会計', sub: 'HANAOKA ACCOUNTING', mark: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', key: 'hanaoka.kaikei.sidebar.v1' },
    payroll: { name: '給与・労務', sub: 'HANAOKA PAYROLL', mark: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 8v8M14.5 10.5h5M14.5 13.5h5"/>', key: 'hanaoka.payroll.sidebar.v1' }
  };
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var SB_KEY = 'hanaoka.reserve.sidebar.v1';   // グループごとに buildSidebar で入れ替える
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
    var b = BRAND[g.key] || BRAND.reserve; SB_KEY = b.key;
    var aside = document.createElement('aside');
    aside.className = 'hx-sidebar'; aside.id = 'hx-sidebar';
    aside.innerHTML =
      /* ロゴと下部の「HANAOKA HUB」から HUB へ戻れる（HUB の HANAOKA APPS は同じタブで開くため） */
      '<a class="hx-brand" href="hanaoka_hub.html" title="HANAOKA HUB へ">' +
        '<div class="hx-mark">' + svg(b.mark) + '</div>' +
        '<div class="hx-brand-name">' + b.name + '<small>' + b.sub + '</small></div>' +
      '</a>' +
      '<div class="hx-label">MENU</div>' +
      g.apps.map(function (a) {
        /* gate：権限を確かめてから出す項目（画面側がクラスの hide を外す） */
        var gated = g.gate && g.gate.page === cur && a.f !== cur ? ' ' + g.gate.cls + ' hide' : '';
        return '<a class="hx-item' + (isCur(a) ? ' active' : '') + gated + '" href="' + a.f + '" data-file="' + a.f + '" title="' + a.l + '">' +
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
    // 支払管理は、開いている決済月を次の画面へ引き継ぐ
    if (g.key === 'ap') aside.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-file]'); if (!a) return;
      e.preventDefault(); if (a.getAttribute('data-file') === cur) return;
      var m = monthParam(); location.href = a.getAttribute('data-file') + (m ? ('?month=' + encodeURIComponent(m)) : '');
    });
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
    // 支払管理は、新しい見た目（ap_theme.css）を読み込んだ画面だけサイドバーにする（読み込んでいない画面と case_management などは今までの上のタブ）
    // メニューに載せていない画面（仕入突合・支払確認・承認。ホーム・手入力からリンクで開く）も
    // サイドバーにする。どの項目も光らない（ap_theme.css は上のタブを隠すので、そうしないとメニューが無くなる）
    // 会計・給与も同じ：kaikei_theme.css / payroll_theme.css を読み込んだ画面はサイドバーにする
    if (document.querySelector('link[href*="' + g.key + '_theme.css"]')) { buildSidebar(g); return; }
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
