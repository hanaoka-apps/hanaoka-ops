/* ============================================================
   花岡車輌 業務アプリ 共通サインイン（hanaoka_auth.js）
   ------------------------------------------------------------
   ★HUBで1回サインインすれば、ほかのアプリはそのまま開ける★
     すべてのアプリは同じ Azure AD アプリ（業務アプリ）で、
     同じ場所（hanaoka-apps.github.io）から配信している。
     サインイン情報を localStorage に置けば、タブをまたいで共有される。
     （sessionStorage だとタブごとに別なので、HUBから新しいタブで
       開くたびにサインインを求められていた）

   ★iPhone・iPad・Safari はポップアップを使わない★
     SafariはMSALのポップアップと相性が悪い（ブロックされる・
     応答が親ウィンドウに戻らない）。HUB と同じく、端末を見て
     ページ全体で Microsoft のサインイン画面へ移る方式に切り替える。
     戻り先は共通の auth.html。auth.html が元のページ（?や#も含む）へ
     戻してくれるので、アプリごとに Azure へ URL を登録しなくてよい。

   ------------------------------------------------------------
   使い方
   ------------------------------------------------------------
     const pca = new msal.PublicClientApplication(HanaokaAuth.msalConfig());
     await pca.initialize();
     await pca.handleRedirectPromise();
     const acc = await HanaokaAuth.restore(pca, SCOPES);   // 起動時。だめなら null
     ...
     const acc = await HanaokaAuth.login(pca, SCOPES);     // ボタンを押したとき
     HanaokaAuth.done();                                   // サインイン画面をまた見せるとき

     サインインボタンと「サインインしてください」の文には data-ha-login を付ける
     （サインイン済みなら、確認中も隠しておくため。下の hasCachedAccount）

   ------------------------------------------------------------
   約束
   ------------------------------------------------------------
   ・restore は例外を投げない。だめなら null を返し、呼び出し側は
     今までどおりサインインボタンを出す（今より悪くはならない）。
   ・ページ全体の移動は、ボタンを押したとき（login）だけ。
     作業中にトークンが切れても勝手に移動しない（入力が消えるため）。
   ・auth.html はリポジトリのルートにある。アプリもルートに置くこと
     （フォルダに入れると folder/auth.html を探して404になる）。
   ============================================================ */
(function () {
  var CLIENT_ID = 'd338d61b-01dc-4c7c-ac6b-aecf7f30d716';
  var TENANT_ID = '3933e8a0-c945-4e97-ae67-c82131087cad';

  function authUrl() { return new URL('auth.html', window.location.href).href; }

  /* ------------------------------------------------------------
     ★サインイン済みなら、サインインボタンを一瞬も見せない★
     画面はまず「サインイン前」の状態で描かれ、保存済みのサインインを
     確かめ終わってから切り替わる。その間（約1秒）ボタンが見えて
     「またサインイン？」と思わせていた。
     保存済みのアカウントがあるときだけ、data-ha-login を付けた要素
     （ボタンと「サインインしてください」の文）を隠しておく。
       ・確認できた   → そのままアプリの画面へ（ボタンは出ないまま）
       ・確認できない → done() でボタンを出す
     このファイルは <head> で読む（本文が描かれる前に隠すため）。
     ------------------------------------------------------------ */
  function hasCachedAccount() {
    try {
      var keys = JSON.parse(localStorage.getItem('msal.account.keys') || '[]');
      if (keys.length) return true;
      for (var i = 0; i < localStorage.length; i++) {
        if (/-login\.windows\.net-/.test(localStorage.key(i) || '')) return true;
      }
    } catch (e) { /* 読めなければ隠さない */ }
    return false;
  }
  var safety = null, watcher = null;
  function done() {
    clearTimeout(safety);
    if (watcher) { watcher.disconnect(); watcher = null; }
    document.documentElement.classList.remove('ha-restoring');
  }
  function hide() {
    document.documentElement.classList.add('ha-restoring');
    if (!document.getElementById('ha-style')) {
      var st = document.createElement('style');
      st.id = 'ha-style';
      st.textContent = 'html.ha-restoring [data-ha-login]{display:none !important}';
      (document.head || document.documentElement).appendChild(st);
    }
  }
  if (hasCachedAccount()) {
    hide();
    /* 隠すのは最大3秒。サインインが有効なら確認は1秒もかからない。
       期限切れのときは MSAL が裏で約10秒粘ってから諦めるので、
       その間ずっとボタンが無い画面にしないよう、3秒で先にボタンを出す
       （確認が後から通れば、そのままアプリの画面に切り替わる） */
    safety = setTimeout(done, 3000);
  }

  /* ------------------------------------------------------------
     サインインは確認できたが、データを読み終えるまでサインイン画面を
     出したままにする作りの画面がある（給与：ゲートに「読み込み中」と出す）。
     そのままだと3秒の保険でボタンが出てしまうので、保険を止めて、
     エラー欄（ids）に何か表示されるまでボタンを隠したままにする。
     読み込めれば画面が切り替わってゲートごと消えるので、ボタンは出ない。
     念のため60秒たっても何も起きなければボタンを出す。
     ------------------------------------------------------------ */
  function holdUntilError(ids) {
    clearTimeout(safety);
    hide();
    if (watcher) watcher.disconnect();
    watcher = new MutationObserver(function () {
      var shown = ids.some(function (id) {
        var e = document.getElementById(id);
        return e && e.textContent.trim();
      });
      if (shown) done();
    });
    ids.forEach(function (id) {
      var e = document.getElementById(id);
      if (e) watcher.observe(e, { childList: true, characterData: true, subtree: true });
    });
    safety = setTimeout(done, 60000);
  }

  function msalConfig() {
    return {
      auth: {
        clientId: CLIENT_ID,
        authority: 'https://login.microsoftonline.com/' + TENANT_ID,
        redirectUri: authUrl()
      },
      cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false }
    };
  }

  /* HUB（hanaoka_hub.html の shouldUseRedirectFlow）と同じ判定 */
  function useRedirect() {
    var ua = navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua)
      /* iPadOS 13以降はMacのふりをする。タッチがあればiPadとみなす */
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
    return isIOS || isSafari;
  }

  /* HUBで選んだアカウント（アクティブアカウント）を優先する。
     getAllAccounts()[0] だけだと、2つのアカウントを使い分けている人で
     別人として動くことがある。 */
  function pickAccount(pca) {
    var acc = (pca.getActiveAccount && pca.getActiveAccount()) || pca.getAllAccounts()[0] || null;
    if (acc && pca.setActiveAccount) pca.setActiveAccount(acc);
    return acc;
  }

  /* 起動時：保存済みのサインインがまだ使えるかを、ここで1回だけ確かめる。
     確かめずに画面を出すと、期限切れのとき各データ取得が個別にポップアップを
     試みて軒並みブロックされ、何も表示されなくなる（以前これが起きた）。 */
  async function restore(pca, scopes) {
    try {
      var acc = pickAccount(pca);
      if (!acc) { done(); return null; }
      var r = await pca.acquireTokenSilent({ scopes: scopes, account: acc });
      if (r && r.account && pca.setActiveAccount) pca.setActiveAccount(r.account);
      /* 成功時は done() しない。アプリが自分でサインイン画面を消すまで
         ボタンは隠したまま（room_reserve などは消す前に通信を挟むため） */
      return (r && r.account) || acc;
    } catch (e) {
      console.warn('[HanaokaAuth] 保存済みのサインインが使えないため、サインインボタンを出します', e);
      done();
      return null;
    }
  }

  /* ボタンを押したとき。PCはポップアップ、iPhone/iPad/Safari はページ移動。
     ページ移動のときは戻ってこない（Promiseは解決しない）。 */
  async function login(pca, scopes) {
    if (useRedirect()) {
      await pca.loginRedirect({ scopes: scopes, redirectUri: authUrl(), redirectStartPage: window.location.href });
      return new Promise(function () {});
    }
    var r = await pca.loginPopup({ scopes: scopes, redirectUri: authUrl() });
    if (pca.setActiveAccount) pca.setActiveAccount(r.account);
    return r.account;
  }

  window.HanaokaAuth = {
    CLIENT_ID: CLIENT_ID,
    TENANT_ID: TENANT_ID,
    msalConfig: msalConfig,
    useRedirect: useRedirect,
    pickAccount: pickAccount,
    restore: restore,
    login: login,
    /* サインイン画面をもう一度見せるとき（サインアウト・読み込み失敗）に呼ぶ */
    done: done,
    holdUntilError: holdUntilError
  };
})();
