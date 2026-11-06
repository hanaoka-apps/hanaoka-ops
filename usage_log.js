/* ============================================================
   HANAOKA HUB アプリの利用ログ（usage_log.js）
   ------------------------------------------------------------
   目的：HUBのアプリが「何が・誰に・いつ」使われているかを知り、アプリの改善に使う。
         個人の評価には使わない。見られるのは管理者だけ（usage_stats.html）。
   記録するもの：誰が・いつ・どの画面で・何をしたか、パソコンかスマホか。
                 画面の中身（件名・顧客名・金額・検索の言葉など）は記録しない。

   ★各アプリは何もしなくてよい★
     共通サインイン（hanaoka_auth.js）がサインインに成功した時点でこのファイルを読み込み、
     UsageLog.auto() を呼ぶ。自動で記録するのは次の3つ。
       open  … 画面を開いた（どこから来たか：HUB／ほかのアプリ／ブックマークなど）
       leave … 画面を閉じた・隠した（その画面を見ていた秒数）
       error … 画面で起きたエラー（1回の表示につき5件まで）
     ページの名前はファイル名（例 case_management）。
   ★細かい操作を知りたいアプリだけ★ UsageLog.log('seek', '営業車') のように呼ぶ。
     名前を自分で決めたいアプリは UsageLog.init({ page:'reserve', msal, account }) を先に呼ぶ
     （そのときは open もアプリが自分で記録する。施設・備品予約・出荷・配送がこの形）。

   ★記録しない画面★ EXCLUDE（集計画面だけ）。FUJIN と Sales HUB は共通サインインを使っていないので、
     それぞれのサインインの後で読み込む（FUJIN は scripts/auth_wrapper.py、Sales HUB は sales_dashboard.html の startUsageLog）。

   保存先：SharePoint のリスト「HUBの利用ログ」（管理者が usage_stats.html で作る）。
   ・リストがない・権限がない・通信に失敗したときは、黙ってやめる（画面の動きには一切影響しない）。
   ・ポップアップは出さない。トークンは静かに取れたときだけ使う。
   ============================================================ */
(function () {
  'use strict';
  if (window.UsageLog) return;
  const SITE_ID = 'hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23';
  const LIST_NAME = 'HUBの利用ログ';
  const VER = '20261106';
  const MAX_PER_PAGE_VIEW = 80;                /* 1回の画面表示あたりの上限（暴走防止）。init の max で画面ごとに変えられる */
  const SAME_WITHIN_MS = 20000;                /* 同じ操作をすぐ繰り返したら1回にまとめる */
  const MAX_ERRORS = 5;                        /* 1回の画面表示あたりのエラーの記録数 */
  const AUTO_OPEN_WAIT_MS = 1500;              /* アプリが自分で init するのを待つ時間（その場合は自動の open を出さない） */
  /* 集計画面（usage_stats）は、管理者が見るたびに数が増えるだけなので記録しない */
  const EXCLUDE = [/^usage_stats$/i];

  let cfg = null, manual = false, listId, count = 0, errCount = 0, recent = new Map();
  let tok = null, tokExp = 0;                  /* 画面を閉じるときは待てないので、トークンを先に持っておく */
  let shownAt = document.visibilityState === 'visible' ? Date.now() : 0;

  /* このファイルの置き場所（＝リポジトリのルート）からの相対パスを、ページの名前にする */
  const ROOT = (function () {
    try { return new URL('.', (document.currentScript && document.currentScript.src) || location.href).href; }
    catch (e) { return ''; }
  })();
  function pageId() {
    let p = location.href.split(/[?#]/)[0];
    if (ROOT && p.indexOf(ROOT) === 0) p = p.slice(ROOT.length); else p = p.split('/').pop();
    return decodeURIComponent(p || 'index.html').replace(/\.html?$/i, '') || 'index';
  }
  const excluded = id => EXCLUDE.some(re => re.test(id));
  const device = () => (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) ? 'phone' : 'pc';
  const clean = s => String(s || '').replace(/[,\n\r]+/g, '、').slice(0, 120);

  function from() {
    const r = document.referrer || '';
    if (!r) return 'direct';
    try {
      const u = new URL(r);
      if (u.origin !== location.origin) return 'other';
      const f = u.pathname.split('/').pop() || '';
      if (u.pathname === location.pathname) return 'reload';
      if (/^hanaoka_hub\.html$/i.test(f) || f === '' || /^index\.html$/i.test(f)) return 'hub';
      return 'app:' + f.replace(/\.html?$/i, '');
    } catch (e) { return 'other'; }
  }

  async function refreshToken() {
    try {
      const r = await cfg.msal().acquireTokenSilent({ scopes: ['Sites.ReadWrite.All'], account: cfg.account() });
      tok = r.accessToken; tokExp = r.expiresOn ? new Date(r.expiresOn).getTime() : Date.now() + 30 * 60e3;
      return tok;
    } catch (e) { tok = null; return null; }
  }
  async function token() {
    if (tok && Date.now() < tokExp - 5 * 60e3) return tok;
    return refreshToken();
  }
  async function resolveList(t) {
    if (listId !== undefined) return listId;
    try {
      const c = sessionStorage.getItem('listId:' + LIST_NAME);
      if (c) return (listId = c);
      const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists?$select=id,displayName&$top=200`, { headers: { Authorization: 'Bearer ' + t } });
      if (!r.ok) return (listId = null);
      const hit = ((await r.json()).value || []).find(l => l.displayName === LIST_NAME);
      if (hit) sessionStorage.setItem('listId:' + LIST_NAME, hit.id);
      return (listId = hit ? hit.id : null);
    } catch (e) { return (listId = null); }
  }
  function body(action, detail) {
    const a = cfg.account() || {};
    return JSON.stringify({ fields: { Title: `${cfg.page}:${action}`, EventTime: new Date().toISOString(),
      UserMail: String(a.username || '').toLowerCase(), UserName: a.name || '', Page: cfg.page, Action: action,
      Detail: String(detail || '').slice(0, 240), Device: device(), Ver: VER } });
  }
  function post(t, id, b) {
    return fetch(`https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists/${id}/items`, { method: 'POST', keepalive: true,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: b });
  }
  async function send(action, detail) {
    try {
      const t = await token(); if (!t) return;
      const id = await resolveList(t); if (!id) return;
      await post(t, id, body(action, detail));
    } catch (e) { /* ログの失敗で画面を止めない */ }
  }
  /* 画面を閉じる瞬間は await できない。持っているトークンとリストで、その場で送る */
  function sendNow(action, detail) {
    try { if (tok && listId) post(tok, listId, body(action, detail)).catch(function () {}); } catch (e) {}
  }

  function log(action, detail, opt) {
    try {
      if (!cfg || cfg.off || count >= (cfg.max || MAX_PER_PAGE_VIEW)) return;
      const key = action + '|' + (detail || ''), now = Date.now();
      if (!(opt && opt.every) && recent.has(key) && now - recent.get(key) < SAME_WITHIN_MS) return;
      recent.set(key, now); count++;
      (opt && opt.now) ? sendNow(action, detail) : send(action, detail);
    } catch (e) {}
  }

  /* ---- 見ていた時間（leave）。タブを隠す・閉じる・別アプリへ移るたびに、その間の秒数を送る ---- */
  function onHide() {
    if (!shownAt) return;
    const sec = Math.round((Date.now() - shownAt) / 1000); shownAt = 0;
    if (sec >= 3) log('leave', 'sec=' + sec, { every: true, now: true });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') onHide();
    else { shownAt = Date.now(); if (cfg) refreshToken(); }
  });
  window.addEventListener('pagehide', onHide);

  /* ---- エラー。hanaoka_auth.js が読み込み前のエラーを window.__haErrors に貯めている ---- */
  function logError(msg) {
    if (errCount >= MAX_ERRORS) return; errCount++;
    log('error', clean(msg));
  }
  function errMsg(e) {
    if (!e) return '';
    if (e.reason !== undefined) { const r = e.reason; return 'promise: ' + (r && (r.message || r.toString()) || ''); }
    const at = e.filename ? ` @${String(e.filename).split('/').pop()}:${e.lineno || ''}` : '';
    return (e.message || (e.error && e.error.message) || 'error') + at;
  }
  window.addEventListener('error', function (e) { if (cfg) logError(errMsg(e)); });
  window.addEventListener('unhandledrejection', function (e) { if (cfg) logError(errMsg(e)); });
  function flushEarlyErrors() {
    (window.__haErrors || []).splice(0).forEach(logError);
  }

  function start(c) {
    cfg = c; count = 0; errCount = 0; recent = new Map(); listId = undefined;
    cfg.off = excluded(cfg.page);
    if (cfg.off) return;
    refreshToken().then(t => t && resolveList(t));
    flushEarlyErrors();
  }

  window.UsageLog = {
    /* アプリが自分で名前を決めるとき。open もアプリが記録する */
    init(c) { manual = true; start(c); },
    /* hanaoka_auth.js がサインイン成功時に呼ぶ。アプリが init しなければ、少し待ってから open を記録する */
    auto(pca, account) {
      /* ページが自分で usage_log.js を読み込んでいる＝自分で init して open も記録する画面。
         init がサインインより遅れても二重に記録しないよう、ここでは何もしない */
      if (manual || document.querySelector('script[src*="usage_log.js"]:not([data-ha-auto])')) return;
      start({ page: pageId(), msal: () => pca, account: () => (pca.getActiveAccount && pca.getActiveAccount()) || account });
      setTimeout(function () {
        if (manual || !cfg || cfg.off) return;
        log('open', 'from=' + from() + ',title=' + clean(document.title));
      }, AUTO_OPEN_WAIT_MS);
    },
    // opt.every＝同じ操作を続けても、そのたびに1回と数える（「お客様へ報告」を開いた回数のように、回数そのものを見たい操作）
    log: log,
    pageId: pageId,
    LIST_NAME: LIST_NAME
  };
})();
