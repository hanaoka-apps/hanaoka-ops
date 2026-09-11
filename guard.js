/* ============================================================
   サインインした人が、このアプリを使えるアカウントかを見る
   ------------------------------------------------------------
   営業車・会議室・全社員の予定は、どれも
   「サインインした人のメールボックス」を足場に Microsoft を読んでいる。

     ・/me/calendar/getSchedule        … 他人の空きを聞く
     ・/places/microsoft.graph.room    … 会議室の一覧（Exchange）
     ・/users/{相手}/calendarView      … 相手の予定表

   ★メールボックスが無い人は、権限を足しても動かない★
     ゲスト（社外招待・#EXT#）は Exchange 上では MailUser（外部への
     転送先）で、メールボックスを持てない。ライセンスを割り当てても
     作られない。退職処理でライセンスを外したアカウントも同じ。

   そういう人がサインインすると、以前は
     「読めず」が全員に付いた53行の表 ＋ 赤いエラー3本
   が出るだけだった。何が悪いのか分からないので、
   ★何が起きているかを1枚で伝えて、表は出さない★ ことにした。

   ------------------------------------------------------------
   使い方（各アプリの showApp の先頭で1行）
   ------------------------------------------------------------
     if (!await guardAppUser(getToken)) return;

   ------------------------------------------------------------
   誤って社員を閉め出さないための約束
   ------------------------------------------------------------
   ★判定できなかったときは通す★
     /me が読めない・通信が失敗した、などのときに止めると、
     本来使える人が使えなくなる。害が大きいほうを避ける。
   ============================================================ */
(function () {

  /* 総務部の連絡先。文面をここだけで直せるようにしておく */
  var SOUMU = '総務部';

  function panelHtml(me) {
    var upn  = String((me && me.userPrincipalName) || '');
    var name = String((me && me.displayName) || '');
    var guest = /#EXT#/i.test(upn) || String((me && me.userType) || '') === 'Guest';
    return ''
      + '<div class="ga-card">'
      +   '<h2>この画面は花岡車輌の社内アカウント専用です</h2>'
      +   '<p>' + (name ? '<b>' + esc(name) + '</b> さんは、' : '')
      +     (guest ? '<b>社外から招待されたアカウント（ゲスト）</b>でサインインしています。'
                   : '<b>メールボックスを持たないアカウント</b>でサインインしています。')
      +   '</p>'
      +   '<p>この画面は、サインインした方の予定表を足場にして Outlook を読んでいます。'
      +     '足場となるメールボックスが花岡車輌側に無いため、<b>予定を1件も読めません。</b>'
      +     'アクセス権を追加しても直りません。</p>'
      +   '<div class="ga-note">'
      +     '<b>Teams のチャットと投稿は、これまでどおりご利用いただけます。</b>'
      +     'この画面だけが使えません。'
      +   '</div>'
      +   '<p class="ga-sub">予定の共有が必要な場合は' + esc(SOUMU) + 'までご連絡ください。'
      +     '（社内アカウントの発行が必要になります）</p>'
      +   '<p class="ga-sub">上のタブから<b>「デモ機」</b>と<b>「使い方」</b>は開けます。</p>'
      +   (upn ? '<p class="ga-upn">サインイン中：' + esc(upn) + '</p>' : '')
      + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  function injectStyle() {
    if (document.getElementById('ga-style')) return;
    var s = document.createElement('style');
    s.id = 'ga-style';
    s.textContent =
      '#guard-view{padding:18px;max-width:760px;margin:0 auto}' +
      '#guard-view .ga-card{background:#fff;border:1px solid #dde2ec;border-left:5px solid #c0392b;' +
        'border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:18px 22px;' +
        'font-family:"Meiryo","Hiragino Sans",sans-serif;line-height:1.8;color:#1e2533}' +
      '#guard-view h2{font-size:16px;color:#c0392b;margin:0 0 10px;padding:0 0 6px;' +
        'border-bottom:2px solid #f0c9c4}' +
      '#guard-view p{font-size:13.5px;margin:8px 0}' +
      '#guard-view .ga-note{background:#f2f7fd;border-left:4px solid #1a5fa8;border-radius:0 5px 5px 0;' +
        'padding:9px 13px;margin:12px 0;font-size:13px}' +
      '#guard-view .ga-sub{font-size:12.5px;color:#6b7a99}' +
      '#guard-view .ga-upn{font-size:11.5px;color:#6b7a99;margin-top:14px;' +
        'border-top:1px solid #eef1f6;padding-top:8px;word-break:break-all}';
    document.head.appendChild(s);
  }

  /* true＝このまま使ってよい／false＝案内を出したので呼び出し側は止まる */
  window.guardAppUser = async function (getToken) {
    var me = null;
    try {
      var tk = await getToken();
      var r = await fetch('https://graph.microsoft.com/v1.0/me'
        + '?$select=id,displayName,mail,userPrincipalName,userType',
        { headers: { Authorization: 'Bearer ' + tk } });
      if (r.ok) me = await r.json();
    } catch (e) { /* 判定できない。通す */ }

    if (!me) return true;                               /* ★判定できなければ通す★ */

    var upn   = String(me.userPrincipalName || '');
    var guest = String(me.userType || '') === 'Guest' || /#EXT#/i.test(upn);
    /* mail が空＝このテナントにメールボックスが無い。
       ゲストと、ライセンスを外したアカウントの両方がここに入る。 */
    var noMbx = !String(me.mail || '').trim();
    if (!guest && !noMbx) return true;

    injectStyle();
    /* ★#app-view をまるごと隠してはいけない★
       タブ（#app-nav-slot）はこの中に入っている。隠すと案内も一緒に消えて
       真っ白な画面になる（一度これをやった）。
       中身だけ1つずつ隠して、タブは残す。 */
    var app = document.getElementById('app-view');
    if (app) {
      app.style.display = 'block';
      Array.prototype.slice.call(app.children).forEach(function (c) {
        if (c.id !== 'app-nav-slot') c.style.display = 'none';
      });
    }
    var login = document.getElementById('login-view');
    if (login) login.style.display = 'none';

    var v = document.getElementById('guard-view');
    if (!v) {
      v = document.createElement('div');
      v.id = 'guard-view';
      /* タブ（app-nav-slot）は残す。デモ機と使い方には行けるようにする */
      var nav = document.getElementById('app-nav-slot');
      if (nav && nav.parentNode) nav.parentNode.insertBefore(v, nav.nextSibling);
      else document.body.appendChild(v);
    }
    v.innerHTML = panelHtml(me);

    var un = document.getElementById('user-name');
    if (un) un.textContent = me.displayName || upn;
    console.warn('[guard] メールボックスが無いアカウントです：' + upn
      + '（userType=' + (me.userType || '?') + ' / mail=' + (me.mail || 'なし') + '）');
    return false;
  };
})();
