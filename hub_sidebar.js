/* ============================================================
   HANAOKA HUB の左メニュー（hub_sidebar.js）
   ------------------------------------------------------------
   HUB と、HUB から開くアプリ（スケジュールなど）で「まったく同じ」左メニューを
   出す。メニューの中身（項目・順番・アイコン）はこのファイル1か所だけで決める。
   見た目は hub_sidebar.css。

   使い方
     ・HUB：<head> で hub_sidebar.css を読み、<body> の先頭でこのファイルを読む
     ・スケジュール系：nav.js が自動で読み込む（ページ側の変更は不要）
   開いているページ（ファイル名）に合わせて、該当の項目を光らせ、そのグループを開く。
   ============================================================ */
(function () {
  if (document.getElementById('hubSidebar')) return;

  var cur = (location.pathname.split('/').pop() || 'hanaoka_hub.html').toLowerCase();
  if (cur === 'index.html') cur = 'hanaoka_hub.html';
  var onHub = cur === 'hanaoka_hub.html';

  function line(inner, w) {
    return '<svg width="' + (w || 18) + '" height="' + (w || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var P = {
    home:     '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/>',
    schedule: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/>',
    status:   '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    apps:     '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    // スケジュールAPPの中の項目
    company:  '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="M7.5 13.5h.01M12 13.5h.01M16.5 13.5h.01M7.5 17h.01M12 17h.01"/>',
    mine:     '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 3v3M16 3v3"/><path d="m9 15 2 2 4-4"/>',
    staff:    '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.4 0 4 1.8 4 4.5"/>',
    demo:     '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    car:      '<path d="M5 16h14l-1.5-6a2 2 0 0 0-1.9-1.5H8.4A2 2 0 0 0 6.5 10z"/><path d="M4 16v3M20 16v3"/><circle cx="8" cy="13" r=".6"/><circle cx="16" cy="13" r=".6"/>',
    room:     '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 9h5a1 1 0 0 1 1 1v11M2 21h20M8 8h2M8 12h2M8 16h2"/>',
    manual:   '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>'
  };
  // 項目のアイコン。kind: line=線のアイコン / mark=ファビコン(紺の角丸) / logo=外部サービスのロゴ / raw=そのままのHTML
  function lineIcon(k) { return { kind: 'line', html: line(P[k], 14) }; }
  function mark(src) { return { kind: 'mark', html: '<img src="' + src + '" alt="">' }; }
  function logo(src, size, bg) { return { kind: 'logo', bg: bg, html: '<img src="' + src + '" alt="" width="' + size + '" height="' + size + '">' }; }

  var MENU = [
    { t: 'item', f: 'hanaoka_hub.html', l: 'ホーム', icon: P.home },
    { t: 'group', id: 'schedule', l: 'スケジュールAPP', icon: P.schedule, children: [
      { f: 'company_schedule.html', l: '全社スケジュール', ic: lineIcon('company') },
      { f: 'my_schedule.html',      l: '自分の予定',       ic: lineIcon('mine') },
      { f: 'staff_schedule.html',   l: '全員の予定',       ic: lineIcon('staff') },
      { f: 'demo_reserve.html',     l: 'デモ機',           ic: lineIcon('demo') },
      { f: 'car_reserve.html',      l: '営業車',           ic: lineIcon('car') },
      { f: 'room_reserve.html',     l: '会議室',           ic: lineIcon('room') },
      { f: 'reserve_manual.html',   l: '使い方',           ic: lineIcon('manual') }
    ] },
    { t: 'item', f: 'hanaoka_hub.html', hash: '#sec-status', l: '会社の状況', icon: P.status },
    { t: 'group', id: 'apps', l: 'アプリ一覧', icon: P.apps, children: [
      { label: 'HANAOKA APPS' },
      { f: 'fujin/FUJIN.html',       l: 'FUJIN', ext: true, ic: logo('fujin/favicon-fujin.png', 38) },   // FUJINだけ別タブで開く
      { f: 'sales_dashboard.html',   l: 'Sales HUB',        ic: mark('favicon_sales.svg') },
      { f: 'case_management.html',   l: '案件管理',         ic: mark('favicon_case.svg') },
      { f: 'task_board.html',        l: 'タスク管理',       ic: mark('favicon_task.svg') },
      { f: 'master_viewer.html',     l: 'マスタビューワー', ic: mark('favicon_master.svg') },
      { label: '外部アプリ' },
      { f: 'https://teams.microsoft.com', l: 'Teams', ext: true,
        ic: { kind: 'raw', bg: '#5b5fc7', html: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z"/></svg>' } },
      { f: 'https://hammock.hotprofile.biz/auth/login/', l: 'Hot Profile', ext: true, ic: logo('icon_hotprofile.png', 22) },
      { f: 'https://www1.shalom-house.jp/komon/login.aspx', l: '勤怠システム', ext: true, ic: logo('icon_komon.png', 24) },
      { f: 'https://gridy.net/home', l: 'ワークフロー', ext: true, ic: logo('icon_gridy.png', 24) },
      { f: 'https://tunag.jp/m/home', l: 'TUNAG', ext: true, ic: logo('icon_tunag.png', 22) },
      { f: 'https://ww4dceaztthy.cybozu.com/login?redirect=https%3A%2F%2Fww4dceaztthy.cybozu.com%2Fk%2F', l: 'キントーン', ext: true, ic: logo('icon_kintone.png', 24) },
      { f: 'https://hanaoka.paintory.com/auth', l: '社販販売', ext: true, ic: logo('icon_paintory.png', 36, '#000') }
    ] }
  ];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isCur(f) { return f.toLowerCase() === cur; }

  function iconHtml(ic) {
    var cls = 'app-icon' + (ic.kind === 'mark' ? ' app-icon-mark' : ic.kind === 'logo' ? ' app-icon-logo' : ic.kind === 'line' ? ' app-icon-line' : '');
    var bg = ic.bg ? ' style="background:' + ic.bg + '"' : '';
    return '<span class="' + cls + '"' + bg + ' aria-hidden="true">' + ic.html + '</span>';
  }
  function childHtml(c) {
    if (c.label) return '<div class="app-submenu-label">' + esc(c.label) + '</div>';
    var active = !c.ext && isCur(c.f) ? ' active' : '';
    var ext = c.ext ? ' target="_blank" rel="noopener"' : '';
    return '<a class="' + active.trim() + '" href="' + esc(c.f) + '"' + ext + '>' + iconHtml(c.ic) + esc(c.l) + '</a>';
  }

  var html =
    '<a class="brand" href="hanaoka_hub.html" style="text-decoration:none" title="HANAOKA HUB">' +
      '<div class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + P.home + '</svg></div>' +
      '<div class="brand-name">HANAOKA HUB<small>HANAOKA CORP.</small></div>' +
    '</a>' +
    '<div class="nav-label">MENU</div>';

  MENU.forEach(function (m) {
    if (m.t === 'item') {
      // 同じページ内の見出しへ行く項目は、HUBでは #hash だけにする(ページを読み直さない)
      var href = m.hash ? (onHub ? m.hash : m.f + m.hash) : m.f;
      var act = onHub && isCur(m.f) && !m.hash ? ' active' : (!onHub && isCur(m.f) && !m.hash ? ' active' : '');
      html += '<a class="nav-item' + act + '" href="' + esc(href) + '">' + line(m.icon) + esc(m.l) + '</a>';
    } else {
      var has = m.children.some(function (c) { return c.f && !c.ext && isCur(c.f); });
      html +=
        '<button type="button" class="nav-item expandable' + (has ? ' has-active' : '') + '" data-group="' + m.id + '" aria-expanded="' + (has ? 'true' : 'false') + '" aria-controls="sub-' + m.id + '">' +
          '<span class="nav-item-label">' + line(m.icon) + esc(m.l) + '</span>' +
          '<svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>' +
        '</button>' +
        '<div class="app-submenu' + (has ? ' open' : '') + '" id="sub-' + m.id + '">' + m.children.map(childHtml).join('') + '</div>';
    }
  });

  // ---- アカウント欄(バーの一番下): 名前・メール・サインアウト ----
  // 表示は、MSALが保存している(全アプリ共通の)アカウント情報を読むだけ。サインアウトは、押したときに
  // MSALを用意して、Microsoftのサインアウトを経由しHUBへ戻る。全アプリ共通の保存先(localStorage)から
  // アカウントを消すので、HUB・スケジュール系のどこで押しても、ほかの画面もサインアウトになる。
  var MSAL_CLIENT_ID = 'd338d61b-01dc-4c7c-ac6b-aecf7f30d716';
  var MSAL_AUTHORITY = 'https://login.microsoftonline.com/3933e8a0-c945-4e97-ae67-c82131087cad';
  var PICK_ACCOUNT_KEY = 'hanaoka.hub.pickAccount.v1';   // HUBの「サインアウト直後はアカウント選択を出す」と共通
  var USER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-3.9 3.4-7 7.5-7s7.5 3.1 7.5 7"/></svg>';
  var OUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>';

  function cachedAccount() {
    try {
      var keys = JSON.parse(localStorage.getItem('msal.account.keys') || '[]');
      var found = null;
      keys.forEach(function (k) {
        if (found) return;
        var a = JSON.parse(localStorage.getItem(k) || 'null');
        if (a && a.username) found = a;
      });
      return found;
    } catch (e) { return null; }
  }
  function renderAccount() {
    var box = document.getElementById('sideAccount');
    if (!box) return;
    var a = cachedAccount();
    if (!a) { box.hidden = true; return; }
    box.querySelector('b').textContent = a.name || a.username;
    box.querySelector('.side-account-text span').textContent = a.username;
    box.hidden = false;
  }
  function loadMsal(cb) {
    if (window.msal) { cb(); return; }
    var sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.10.0/lib/msal-browser.min.js';
    sc.crossOrigin = 'anonymous'; sc.onload = cb; document.head.appendChild(sc);
  }
  function signOutNow(btn) {
    btn.disabled = true;
    try { localStorage.setItem(PICK_ACCOUNT_KEY, '1'); } catch (e) {}
    loadMsal(function () {
      var pca = new msal.PublicClientApplication({
        auth: { clientId: MSAL_CLIENT_ID, authority: MSAL_AUTHORITY, redirectUri: new URL('auth.html', location.href).href },
        cache: { cacheLocation: 'localStorage' }
      });
      pca.initialize().then(function () {
        var cached = cachedAccount();
        var acc = (cached && pca.getAllAccounts().filter(function (x) { return x.username === cached.username; })[0]) || pca.getAllAccounts()[0];
        // HUBへ戻る(HUBのURLはAzureにリダイレクトURIとして登録済み)
        return pca.logoutRedirect({ account: acc, postLogoutRedirectUri: new URL('hanaoka_hub.html', location.href).href });
      }).catch(function (e) { console.error('サインアウト失敗', e); btn.disabled = false; });
    });
  }
  function mountAccount(aside) {
    var box = document.createElement('div');
    box.className = 'side-account'; box.id = 'sideAccount'; box.hidden = true;
    box.innerHTML =
      '<div class="side-account-who"><span class="side-account-ic">' + USER_ICON + '</span>' +
        '<div class="side-account-text"><b></b><span></span></div></div>' +
      '<button type="button" class="side-signout">' + OUT_ICON + 'サインアウト</button>';
    aside.appendChild(box);
    box.querySelector('.side-signout').addEventListener('click', function (e) { signOutNow(e.currentTarget); });
    renderAccount();
    // サインイン・サインアウトで変わるので、ときどき見直す(localStorageを読むだけで軽い)
    setInterval(renderAccount, 2000);
  }

  function mount() {
    var aside = document.createElement('aside');
    aside.className = 'sidebar'; aside.id = 'hubSidebar';
    aside.innerHTML = html;
    var backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop'; backdrop.id = 'sidebarBackdrop';
    document.body.insertBefore(backdrop, document.body.firstChild);
    document.body.insertBefore(aside, document.body.firstChild);
    mountAccount(aside);

    // 開閉(アコーディオン)
    aside.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button.expandable');
      if (!btn) return;
      var open = document.getElementById('sub-' + btn.getAttribute('data-group')).classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // スマホ: ≡ボタンでサイドバーを引き出す(暗幕・リンクのタップで閉じる)。
  // ボタンはページ側(HUBは上部バー)にあればそれを使い、無いページ(スケジュール系)は
  // ページ上部のバーの先頭に足す。ページ全体を読み終えてから結びつける
  function wireMenuButton() {
    var aside = document.getElementById('hubSidebar');
    var backdrop = document.getElementById('sidebarBackdrop');
    var btn = document.getElementById('menuBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'menu-btn'; btn.id = 'menuBtn';
      btn.setAttribute('aria-label', 'メニューを開く'); btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
      var host = document.querySelector('header .logo') || document.querySelector('.topbar > :first-child') || document.querySelector('header');
      if (host) { btn.style.marginRight = '6px'; btn.style.verticalAlign = 'middle'; host.insertBefore(btn, host.firstChild); }
    }
    function setOpen(open) {
      document.body.classList.toggle('sidebar-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    btn.addEventListener('click', function () { setOpen(!document.body.classList.contains('sidebar-open')); });
    backdrop.addEventListener('click', function () { setOpen(false); });
    aside.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  function start() {
    mount();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireMenuButton);
    else wireMenuButton();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
