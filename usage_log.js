/* ============================================================
   予約まわりの利用ログ（usage_log.js）
   ------------------------------------------------------------
   目的：施設・備品予約（デモ機・営業車・会議室）の「使われ方」を知り、画面の改善と、古い画面の
         廃止の判断に使う。個人の評価には使わない。見られるのは管理者だけ（usage_stats.html）。
   記録するもの：誰が・いつ・どの画面で・何をしたか（画面を開いた／絞り込み／空き検索／予約・変更・取消 など）、
                 パソコンかスマホか。予約の中身（件名・顧客名など）は記録しない。
   保存先：SharePoint のリスト「予約の利用ログ」（管理者が usage_stats.html で作る）。
   ・リストがない・権限がない・通信に失敗したときは、黙ってやめる（画面の動きには一切影響しない）。
   ・ページ本来のサインインには混ぜず、保存のたびに静かにトークンを取る（ポップアップは出さない）。
   使い方：UsageLog.init({ page:'reserve'|'demo'|'car'|'room', msal:()=>msalInstance, account:()=>currentAccount });
           UsageLog.log('open');  UsageLog.log('seek', '営業車,会議室');
   ============================================================ */
(function () {
  'use strict';
  const SITE_ID = 'hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23';
  const LIST_NAME = '予約の利用ログ';
  const VER = '20261105';
  const MAX_PER_PAGE_VIEW = 80;                /* 1回の画面表示あたりの上限（暴走防止） */
  const SAME_WITHIN_MS = 20000;                /* 同じ操作をすぐ繰り返したら1回にまとめる */
  let cfg = null, listId, count = 0, recent = new Map();

  const device = () => (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) ? 'phone' : 'pc';
  async function token() {
    try { return (await cfg.msal().acquireTokenSilent({ scopes: ['Sites.ReadWrite.All'], account: cfg.account() })).accessToken; }
    catch { return null; }
  }
  async function resolveList(tok) {
    if (listId !== undefined) return listId;
    try {
      const c = sessionStorage.getItem('listId:' + LIST_NAME);
      if (c) return (listId = c);
      const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists?$select=id,displayName&$top=200`, { headers: { Authorization: 'Bearer ' + tok } });
      if (!r.ok) return (listId = null);
      const hit = ((await r.json()).value || []).find(l => l.displayName === LIST_NAME);
      if (hit) sessionStorage.setItem('listId:' + LIST_NAME, hit.id);
      return (listId = hit ? hit.id : null);
    } catch { return (listId = null); }
  }
  async function send(action, detail) {
    try {
      const tok = await token(); if (!tok) return;
      const id = await resolveList(tok); if (!id) return;
      const a = cfg.account() || {};
      const fields = { Title: `${cfg.page}:${action}`, EventTime: new Date().toISOString(), UserMail: String(a.username || '').toLowerCase(),
        UserName: a.name || '', Page: cfg.page, Action: action, Detail: String(detail || '').slice(0, 240), Device: device(), Ver: VER };
      await fetch(`https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists/${id}/items`, { method: 'POST', keepalive: true,
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
    } catch { /* ログの失敗で画面を止めない */ }
  }
  window.UsageLog = {
    init(c) { cfg = c; count = 0; recent = new Map(); listId = undefined; },
    log(action, detail) {
      try {
        if (!cfg || count >= MAX_PER_PAGE_VIEW) return;
        const key = action + '|' + (detail || ''), now = Date.now();
        if (recent.has(key) && now - recent.get(key) < SAME_WITHIN_MS) return;
        recent.set(key, now); count++;
        send(action, detail);
      } catch {}
    }
  };
})();
