/* 領収証の画面の部品（発行の画面・「領収証：発行済み」の札・「領収証を発行」のボタン）。
 * EC受注の状況（ec_viewer.html。営業向け・見るだけの画面）と、EC売上（ec_sales.html。作業用）の両方に、同じ呼び出しで付ける。
 * どちらから発行しても、同じ記録（SharePoint のリスト EC_Receipt）になる。計算は receipt_core.js、記録の読み書きは receipt_store.js。
 *
 * 使い方（画面側）:
 *   const rc = ReceiptUi.create({ conf, source: 'ec_viewer', getToken: async write => token, fetchFile: async name => ({ buf }), user: () => ({ username, name }),
 *                                 getOrder: no => 注文の情報, ulog: name => …, onChange: () => 札を描き直す, EC: window.EcSales });
 *   await rc.ready;                      // リストが読めない（権限なし・リストなし・列が足りない）ときは、available() が false のまま。ボタンも札も出ない（エラーは出さない）
 *   rc.badge(no) / rc.button(order)      // 札・ボタンの HTML（読めないときは空）。ボタンの押下は、この部品が自分で受け取る（data-receipt）
 * 注文の情報（order）＝ { no, financial, cancelledAt, total, refunded, shipCompany, shipName, billCompany, billName }（Shopify の値）。
 * 会社の情報（社名・登録番号・拠点の住所・電話・FAX）は、見積アプリの設定（SharePoint の SD_設定）を、サインインした人の権限で読む（読むだけ）。
 * 社印の画像などの上書きは、SharedMasters の設定ファイル receipt_settings.json（なくてもよい）。実際の値は、リポジトリに入れない。
 * 利用ログには、操作の名前だけを送る（宛名・金額・注文番号・お客様名は送らない）。 */
(function (root) {
  'use strict';
  var R = root.ReceiptCore;

  var CSS = '' +
    '.rc-scrim{position:fixed;inset:0;background:rgba(20,22,50,.45);z-index:1000}' +
    '.rc-modal{position:fixed;z-index:1001;top:4vh;left:50%;transform:translateX(-50%);width:min(860px,94vw);max-height:92vh;overflow:auto;background:var(--surface,#fff);color:var(--txt,#1d1f33);border-radius:14px;box-shadow:0 12px 40px rgba(20,22,50,.35);padding:16px 20px 20px;font-size:13px;line-height:1.55}' +
    '.rc-modal h2{margin:0;font-size:17px;color:var(--navy,#23268f)}.rc-modal h3{font-size:13px;margin:14px 0 6px;color:var(--navy,#23268f)}' +
    '.rc-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}.rc-head .grow{flex:1}' +
    '.rc-info{margin:4px 0 8px;color:var(--sub,#5d6591)}.rc-info b{color:var(--txt,#1d1f33)}' +
    '.rc-alert{border-radius:8px;padding:8px 12px;margin:8px 0;font-size:12.5px;border:1px solid transparent}' +
    '.rc-alert.warn{background:var(--amber-soft,#fff4e0);color:var(--amber,#9a5b00);border-color:#f3d6a8}.rc-alert.err{background:var(--red-soft,#fdecee);color:var(--red,#b3261e);border-color:#f0b4bd}' +
    '.rc-alert.ok{background:var(--green-soft,#e8f6ed);color:var(--green,#1a7a45);border-color:#9bd2b1}.rc-alert.info{background:var(--bg,#f4f5fb);color:var(--sub,#5d6591);border-color:var(--line,#e3e5f0)}' +
    '.rc-tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin:4px 0}.rc-tbl th,.rc-tbl td{padding:5px 8px;border-bottom:1px solid var(--line,#e3e5f0);text-align:left;vertical-align:top}.rc-tbl th{color:var(--sub,#5d6591);font-weight:600;font-size:11.5px}.rc-tbl td.num{text-align:right;white-space:nowrap}' +
    '.rc-tbl tr.void td{color:var(--mute,#9aa0b8);text-decoration:line-through}.rc-tbl tr.void td.st{text-decoration:none}' +
    '.rc-act{border:1px solid var(--line-strong,#c9cde6);background:var(--bg,#f4f5fb);border-radius:10px;padding:10px 12px;margin:10px 0}.rc-act .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}' +
    '.rc-form{display:grid;grid-template-columns:130px 1fr;gap:8px 12px;align-items:center;margin:8px 0}.rc-form label{font-weight:600}' +
    '.rc-form input[type=text],.rc-form input[type=date],.rc-form select{font:inherit;font-size:13.5px;padding:6px 9px;border:1px solid var(--line-strong,#c9cde6);border-radius:7px;background:#fff;color:var(--txt,#1d1f33);min-width:0}' +
    '.rc-form input[type=text]{width:100%}.rc-form .in2{display:flex;gap:8px;align-items:center}.rc-form .hint{grid-column:2;color:var(--sub,#5d6591);font-size:12px;margin-top:-4px}' +
    '.rc-chip{display:inline-block;padding:2px 10px;border:1px solid var(--line-strong,#c9cde6);border-radius:14px;background:#fff;cursor:pointer;font-size:12px;margin:0 6px 4px 0}.rc-chip:hover{background:var(--navy-soft,#eef0fb)}' +
    '.rc-bk{grid-column:1/-1;background:var(--bg,#f4f5fb);border-radius:8px;padding:6px 12px;font-size:12.5px}' +
    '.rc-btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}' +
    '.rc-docwrap{width:100%;overflow:hidden;border:1px solid var(--line-strong,#c9cde6);border-radius:8px;background:#fff;margin-top:8px}' +
    '.rc-doc{display:block;width:794px;height:1123px;border:0;background:#fff;transform-origin:0 0}' +   /* A4（96dpi で 794×1123）。画面の幅に合わせて縮めて見せる（fitDoc）。印刷は、この大きさのまま */
    '.rc-modal details{margin:8px 0}.rc-modal pre{background:var(--bg,#f4f5fb);border-radius:8px;padding:8px 12px;font-size:12px;overflow:auto;white-space:pre-wrap}' +
    '.rc-row{margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.rc-badge{margin-right:2px}' +
    '@media (max-width:640px){.rc-form{grid-template-columns:1fr}.rc-form .hint{grid-column:1}}';

  function create(ctx) {
    var E = R.esc, store = null, state = 'init', byOrder = {}, M = null, SET = null, api = {};
    var rcConf = (ctx.conf && ctx.conf.receipt) || {};
    var SRC_LABEL = ctx.source === 'ec_sales' ? 'EC売上アプリ' : '閲覧画面';

    function ulog(name) { try { if (ctx.ulog) ctx.ulog(name); } catch (e) { /* 記録の失敗で止めない */ } }
    function who(u) { return String(u || '').split('@')[0]; }
    function md(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) : ''; }
    function me() { var u = ctx.user ? ctx.user() : null; return (u && (u.username || u.name)) || ''; }

    /* ------------------------------------------------------------ 準備（読めなければ、静かにオフ） */
    function init() {
      return (async function () {
        var L = (ctx.conf && ctx.conf.sharepoint && ctx.conf.sharepoint.lists) || {};
        var sitePath = rcConf.sitePath || L.sitePath;
        if (rcConf.enabled !== true || !sitePath || !root.ReceiptStore) { state = 'off'; return false; }
        try {
          store = root.ReceiptStore.create({ R: R, getToken: ctx.getToken, sitePath: sitePath, listName: rcConf.list || 'EC_Receipt', logList: L.log });
          await store.connect();
          byOrder = await store.loadAll();
          state = 'ok'; return true;
        } catch (e) {
          // 権限がない・リストがない・列が足りない：エラーは出さず、ボタンも札も出さない
          console.warn('領収証の記録を読めません（ボタンと札は出しません）', e && (e.status || e.message));
          state = 'off'; return false;
        }
      })();
    }
    api.ready = init().then(function (ok) { if (ok) { ensureStyle(); if (ctx.onChange) ctx.onChange(); } return ok; });   // 読めたら、札・ボタンを出してもらう
    api.available = function () { return state === 'ok'; };
    api.records = function (no) { return byOrder[R.orderNo(no)] || []; };
    api.active = function (no) { return R.activeOf(api.records(no)); };
    api.activeMap = function () { var m = {}; Object.keys(byOrder).forEach(function (k) { var a = R.activeOf(byOrder[k]); if (a) m[k] = a; }); return m; };
    api.reload = async function () {
      if (state !== 'ok') return;
      try { byOrder = await store.loadAll(); if (ctx.onChange) ctx.onChange(); } catch (e) { console.warn('領収証の記録を読み直せません', e); }
    };

    /* ------------------------------------------------------------ 札・ボタン（画面の一覧・詳細に埋める HTML） */
    api.badge = function (no) {
      if (state !== 'ok') return '';
      var a = api.active(no); if (!a) return '';
      return '<span class="tag ok rc-badge" title="' + E(a.number + '（' + md(a.issueDate) + '・' + who(a.issuedBy) + '）') + '">領収証：発行済み</span>';
    };
    api.button = function (order) {
      if (state !== 'ok') return '';
      var o = R.orderInfo(order), a = api.active(o.no);
      if (!a && !R.eligibility(o).ok) return '';
      return '<button type="button" class="btn sec sm rc-btn" data-receipt="' + E(o.no) + '" title="' + (a ? '発行済みの領収証の確認・再発行・取消' : 'この注文の領収証を発行します') + '">' + (a ? '領収証を開く' : '領収証を発行') + '</button>';
    };
    // 詳細に出す、領収証の状況の1行（発行済み／発行できない理由）。何も言うことがなければ空
    api.note = function (order) {
      if (state !== 'ok') return '';
      var o = R.orderInfo(order), a = api.active(o.no);
      if (a) return E(a.number + '　' + R.jaDate(a.issueDate) + '　発行者 ' + who(a.issuedBy) + (a.reissueCount ? '　再発行 ' + a.reissueCount + '回' : ''));
      var el = R.eligibility(o); return el.ok ? '未発行' : '<span class="muted">' + E(el.reason) + '</span>';
    };
    api.searchText = function (no) { var a = api.active(no); return a ? '領収証 発行済み ' + a.number : ''; };

    // ボタンの押下は、画面のほかの処理（行を開く・カードを開く）より先に受け取る
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-receipt]');
      if (!b || state !== 'ok') return;
      e.preventDefault(); e.stopPropagation();
      var order = ctx.getOrder ? ctx.getOrder(b.getAttribute('data-receipt')) : null;
      if (order) api.open(order);
    }, true);

    /* ------------------------------------------------------------ 設定ファイル・社印（初めて開くときに読む。サインインした人の権限） */
    function utf8(buf) { return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''); }
    function dataUrl(buf, name) {
      var b = new Uint8Array(buf), s = '', i;
      for (i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      var mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : /\.svg$/i.test(name) ? 'image/svg+xml' : 'image/png';
      return 'data:' + mime + ';base64,' + btoa(s);
    }
    async function loadSettings() {
      if (SET) return SET;
      var name = rcConf.settingsFile || 'receipt_settings.json', out = { ok: false, err: '', settings: null, stamp: '', warns: [] };
      var comp = store ? await store.loadCompany() : null, ov = null;   // 見積アプリの会社の情報（読めなければ null）
      try {
        var f = await ctx.fetchFile(name);
        try { ov = JSON.parse(utf8(f.buf)); } catch (pe) { out.warns.push('上書きの設定（' + name + '）の形が正しくありません（JSON として読めません）。見積アプリの会社の情報だけで続けます'); }
      } catch (e) { /* 上書きのファイルは、なくてもよい */ }
      var s = R.mergeSettings(comp, ov), c = R.checkSettings(s);
      if (!s.stampFile && rcConf.stampFile) s.stampFile = String(rcConf.stampFile).trim();   // 社印の画像の名前は、設定ファイルになければ、ec_sales_config.json の receipt.stampFile を使う
      if (!c.ok) { out.err = comp ? '会社の設定に、足りない項目があります：' + c.missing.join('、') + '（見積アプリの会社の情報を確認してください）' : R.NO_COMPANY; SET = out; return out; }
      out.settings = s; out.ok = true; out.warns = out.warns.concat(c.warnings);
      if (s.stampFile) {
        try { var sf = await ctx.fetchFile(s.stampFile); out.stamp = dataUrl(sf.buf, s.stampFile); }
        catch (se) { out.warns.push('社印の画像（' + s.stampFile + '）を読めません。社印なしで出ます'); }
      }
      SET = out; return out;
    }

    /* ------------------------------------------------------------ 画面（発行の画面） */
    function ensureStyle() {
      if (document.getElementById('rc-style')) return;
      var st = document.createElement('style'); st.id = 'rc-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    function root$() { return document.getElementById('rc-modal'); }
    function mount() {
      ensureStyle();
      close(true);
      var s = document.createElement('div'); s.className = 'rc-scrim'; s.id = 'rc-scrim';
      var m = document.createElement('div'); m.className = 'rc-modal'; m.id = 'rc-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', '領収証');
      document.body.appendChild(s); document.body.appendChild(m);
      s.addEventListener('click', function () { close(); });
      m.addEventListener('click', onClick);
      m.addEventListener('input', onInput);
      m.addEventListener('change', onInput);
    }
    function close(silent) {
      ['rc-scrim', 'rc-modal'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
      if (!silent) M = null;
    }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && M && !M.busy) close(); });
    api.close = function () { close(); };

    api.open = function (order) {
      if (state !== 'ok') return;
      var o = R.orderInfo(order);
      M = { o: o, elig: R.eligibility(o), mode: 'list', recs: api.records(o.no).slice(), busy: false, msg: null, form: null, doc: null, cancelId: null, replaceOf: null, prev: false };
      mount(); draw();
      refreshRecs(); loadSettings().then(function () { if (M && M.o.no === o.no) draw(); });
    };
    async function refreshRecs() {
      var no = M && M.o.no;
      try {
        var recs = await store.loadFor(no);
        if (!M || M.o.no !== no) return;
        var changed = JSON.stringify(api.records(no)) !== JSON.stringify(recs);
        byOrder[no] = recs; if (!recs.length) delete byOrder[no];
        M.recs = recs.slice(); if (M.mode === 'list') draw();
        if (changed && ctx.onChange) ctx.onChange();
      } catch (e) { /* 読み直せなくても、いま持っている記録で続ける */ }
    }
    function msgHtml() { return M.msg ? '<div class="rc-alert ' + M.msg.type + '">' + M.msg.html + '</div>' : ''; }
    function setMsg(type, text) { M.msg = text ? { type: type, html: E(text) } : null; }
    function warnsHtml() { return SET && SET.ok ? SET.warns.map(function (w) { return '<div class="rc-alert warn">' + E(w) + '</div>'; }).join('') : ''; }
    function offices() { return (SET && SET.ok && SET.settings.offices) || []; }
    function officeAt(i) { return offices()[+i || 0] || offices()[0] || null; }
    // 拠点が2つ以上のときだけ選べる（初めは先頭の拠点）。書類の住所・電話に使う
    function officeSelect(id, cur) {
      var l = offices(); if (l.length < 2) return '';
      return '<select id="' + id + '" aria-label="拠点">' + l.map(function (o, i) { return '<option value="' + i + '"' + (String(i) === String(cur || 0) ? ' selected' : '') + '>' + E(o.name || o.addr) + '</option>'; }).join('') + '</select>';
    }
    // 書類の「担当者」＝発行した人。見本と新しく出すときは、いまの人。発行済みの再印刷は、記録の発行者
    function staffName(rec) {
      var u = ctx.user ? ctx.user() : null, mine = me();
      if (!rec || !rec.issuedBy || rec.issuedBy === mine) return (u && u.name) || who(mine);
      return who(rec.issuedBy);
    }
    function settingsHtml() {
      if (!SET) return '<div class="rc-alert info">領収証の設定を読み込み中…</div>';
      var h = '';
      if (!SET.ok) {
        h += '<div class="rc-alert err">' + E(SET.err) + '<br>設定ができるまで、領収証の発行・再発行はできません（記録の確認と取消はできます）。</div>' +
          '<details><summary>会社の情報について（管理者向け）</summary><div class="muted">社名・登録番号・拠点の住所・電話・FAX は、見積・受注アプリの会社の情報（SharePoint のリスト SD_設定）から読みます。見積・受注アプリの「会社の情報」の設定を確かめてください。社印の画像などを足したいときだけ、SharedMasters に <b>' + E(rcConf.settingsFile || 'receipt_settings.json') + '</b> を置きます（なくても発行できます。下は架空の見本です）。リポジトリ（公開）には、実際の社名・住所・登録番号・社印を入れません。</div><pre>' + E(JSON.stringify(R.SAMPLE_SETTINGS, null, 2)) + '</pre></details>';
      } else h += warnsHtml();
      return h;
    }
    function infoHtml() {
      var o = M.o;
      return '<div class="rc-info">注文 <b>#' + E(o.no) + '</b>　支払済み <b>' + E(R.yen(o.total)) + '</b>' + (o.refunded ? '　返金 <b>' + E(R.yen(o.refunded)) + '</b>' : '') + '　（税込）</div>';
    }
    function draw() {
      var el = root$(); if (!el || !M) return;
      var title = M.mode === 'form' ? (M.replaceOf ? '領収証を出し直す' : '領収証を発行') : M.mode === 'doc' ? '領収証' : '領収証';
      var h = '<div class="rc-head"><h2>' + title + '</h2><span class="grow"></span><button type="button" class="btn sec sm" data-rc="close">閉じる ✕</button></div>' + infoHtml() + msgHtml();
      h += M.mode === 'form' ? formHtml() : M.mode === 'doc' ? docHtml() : listHtml();
      el.innerHTML = h;
      if (M.mode === 'form') { syncBreakdown(); if (M.prev) drawPreview(); }
      fitDoc();
    }

    // ---- 一覧（この注文の発行の記録と、できる操作）
    function recsTable() {
      if (!M.recs.length) return '';
      return '<h3>発行の記録</h3><div style="overflow:auto"><table class="rc-tbl"><thead><tr><th>番号</th><th>発行日</th><th>宛名</th><th>金額（税込）</th><th>状態</th><th>発行者</th><th>どこから</th><th>メモ</th></tr></thead><tbody>' +
        M.recs.map(function (r) {
          var v = !R.isActive(r);
          return '<tr class="' + (v ? 'void' : '') + '"><td><b>' + E(r.number) + '</b></td><td>' + E(R.jaDate(r.issueDate)) + '</td><td>' + E(r.atena) + '</td><td class="num">' + E(R.yen(r.amount)) + '</td>' +
            '<td class="st"><span class="tag ' + (v ? 'info' : 'ok') + '">' + E(r.status) + '</span>' + (v ? ' <a href="#" data-rc="viewvoid" data-id="' + E(r.id) + '">控えを見る</a>' : '') + (r.reissueCount ? ' <span class="muted">再発行 ' + r.reissueCount + '回</span>' : '') + '</td><td>' + E(who(r.issuedBy)) + '</td><td>' + E(r.source === 'ec_sales' ? 'EC売上アプリ' : r.source === 'ec_viewer' ? '閲覧画面' : r.source) + '</td><td class="muted">' + E(r.note) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    function listHtml() {
      var actives = M.recs.filter(R.isActive), h = '';
      if (M.elig.refundNote) h += '<div class="rc-alert warn">' + E(M.elig.refundNote) + '</div>';
      h += settingsHtml();
      if (actives.length > 1) h += '<div class="rc-alert err">この注文に、有効な領収証が ' + actives.length + '枚あります（ほぼ同時に発行された可能性があります）。不要なほうを取り消してください。</div>';
      actives.forEach(function (a) {
        h += '<div class="rc-act"><b>発行済み</b>　' + E(a.number) + '　' + E(R.jaDate(a.issueDate)) + '　' + E(a.atena) + '　' + E(R.yen(a.amount)) + '（発行者 ' + E(who(a.issuedBy)) + '）' +
          (needStamp(a.amount) ? '<div class="muted" style="color:var(--amber,#9a5b00)">' + E(STAMP_NOTE) + '</div>' : '') + '<div class="muted">もう一度出すときは「再発行」です（再発行の回数が記録され、書類に「再発行」と入ります）。宛名や金額を変えるときは、元を取消にして、新しく発行します。</div>';
        if (M.cancelId === a.id) {
          h += '<div class="row"><input type="text" id="rc-reason" placeholder="取り消す理由（任意）" maxlength="100" style="flex:1;min-width:200px;font:inherit;padding:6px 9px;border:1px solid var(--line-strong,#c9cde6);border-radius:7px">' +
            '<button type="button" class="btn" data-rc="cancel-ok" data-id="' + E(a.id) + '"' + (M.busy ? ' disabled' : '') + '>取り消す</button><button type="button" class="btn sec" data-rc="cancel-no">やめる</button></div>' +
            '<div class="muted">取り消した番号は、使い回しません（記録は残ります）。</div>';
        } else {
          var can = M.elig.ok && SET && SET.ok;
          h += '<div class="row"><button type="button" class="btn" data-rc="reissue" data-id="' + E(a.id) + '"' + (can && !M.busy ? '' : ' disabled') + '>もう一度出す（再発行）</button>' +
            '<button type="button" class="btn sec" data-rc="replace" data-id="' + E(a.id) + '"' + (can && !M.busy ? '' : ' disabled') + '>宛名・金額を変えて出し直す</button>' +
            '<button type="button" class="btn sec" data-rc="cancel" data-id="' + E(a.id) + '"' + (M.busy ? ' disabled' : '') + '>取り消す</button></div>' +
            (!M.elig.ok ? '<div class="muted">' + E(M.elig.reason) + '（取消はできます）</div>' : '');
        }
        h += '</div>';
      });
      if (!actives.length) {
        if (!M.elig.ok) h += '<div class="rc-alert warn">' + E(M.elig.reason) + '</div>';
        else h += '<div class="rc-btns"><button type="button" class="btn" data-rc="new"' + (SET && SET.ok && !M.busy ? '' : ' disabled') + '>新しく発行する</button></div>';
      }
      h += recsTable();
      return h;
    }

    // ---- 発行の画面（宛名・但し書き・金額・発行日）
    function openForm(replaceRec) {
      var d = R.defaults(M.o, { proviso: rcConf.proviso });
      if (replaceRec) { var sp = R.splitTitle(replaceRec.atena); d.atena = sp.name; d.title = sp.title; d.proviso = replaceRec.proviso; d.amount = Math.min(replaceRec.amount, M.elig.max); }
      M.form = { atena: d.atena, title: d.title, proviso: d.proviso, amount: String(d.amount), issueDate: d.issueDate, note: '', office: '0' };
      M.cands = d.candidates; M.provs = d.provisos || []; M.replaceOf = replaceRec || null; M.mode = 'form'; M.prev = false; M.msg = null; draw();
    }
    function formHtml() {
      var f = M.form, c = M.cands || [];
      var h = settingsHtml();
      if (M.elig.refundNote) h += '<div class="rc-alert warn">' + E(M.elig.refundNote) + '</div>';
      if (M.replaceOf) h += '<div class="rc-alert info">' + E(M.replaceOf.number) + ' を取消にして、新しい番号で出し直します。</div>';
      h += '<div class="rc-form">' +
        '<label for="rc-atena">宛名</label><div><div class="in2"><input type="text" id="rc-atena" maxlength="60" value="' + E(f.atena) + '" placeholder="例：株式会社○○ ／ 山田 太郎"><select id="rc-title" aria-label="敬称">' +
        R.TITLES.map(function (t) { return '<option value="' + E(t) + '"' + (t === f.title ? ' selected' : '') + '>' + (t || '（付けない）') + '</option>'; }).join('') + '</select></div>' +
        (c.length ? '<div style="margin-top:4px">' + c.map(function (x, i) { return '<span class="rc-chip" data-rc="cand" data-i="' + i + '" title="宛名に入れる">' + E(x.text) + '</span>'; }).join('') + '<span class="muted">← お届け先・請求先の名前から選べます</span></div>' : '') + '</div>' +
        '<label for="rc-proviso">但し書き</label><div><input type="text" id="rc-proviso" maxlength="60" value="' + E(f.proviso) + '">' +
        ((M.provs || []).length ? '<div style="margin-top:4px">' + M.provs.map(function (x, i) { return '<span class="rc-chip" data-rc="prov" data-i="' + i + '" title="但し書きに入れる">' + E(x) + '</span>'; }).join('') + '<span class="muted">← 注文の商品名から選べます（取引の内容が分かる書き方にします）</span></div>' : '') + '</div>' +
        '<label for="rc-amount">金額（税込・円）</label><div class="in2"><input type="text" id="rc-amount" inputmode="numeric" style="width:160px" value="' + E(f.amount) + '"><span class="muted">発行できる上限 ' + E(R.yen(M.elig.max)) + '</span></div>' +
        '<label for="rc-date">発行日</label><div class="in2"><input type="date" id="rc-date" value="' + E(f.issueDate) + '"><span class="muted">初めは今日（日本時間）です。変えられます</span></div>' +
        (offices().length > 1 ? '<label for="rc-office">拠点</label><div class="in2">' + officeSelect('rc-office', f.office) + '<span class="muted">書類の住所・電話に使います</span></div>' : '') +
        '<label for="rc-note">メモ（社内用）</label><input type="text" id="rc-note" maxlength="200" value="' + E(f.note) + '" placeholder="書類には印刷されません（任意）">' +
        '<div class="rc-bk" id="rc-bk"></div><div id="rc-errs" style="grid-column:1/-1"></div></div>' +
        '<div class="rc-btns"><button type="button" class="btn sec" data-rc="preview">プレビュー</button><button type="button" class="btn" data-rc="issue"' + (SET && SET.ok && !M.busy ? '' : ' disabled') + '>' + (M.replaceOf ? '取り消して、出し直す' : '発行する') + '</button><button type="button" class="btn sec" data-rc="back">やめる</button></div>' +
        '<div id="rc-prev"></div>';
      return h;
    }
    function readForm() {
      var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
      M.form = { atena: g('rc-atena'), title: g('rc-title'), proviso: g('rc-proviso'), amount: g('rc-amount'), issueDate: g('rc-date'), note: g('rc-note'), office: document.getElementById('rc-office') ? g('rc-office') : (M.form && M.form.office) || '0' };
      return R.validate(M.form, { max: M.elig.max });
    }
    function syncBreakdown() {
      var v = readForm(), el = document.getElementById('rc-bk'); if (!el) return v;
      el.innerHTML = (v.value.amount ? '消費税の内訳（10%）：税抜 <b>' + E(R.yen(v.value.net)) + '</b>　＋　消費税 <b>' + E(R.yen(v.value.tax)) + '</b>　＝　税込 <b>' + E(R.yen(v.value.amount)) + '</b>　<span class="muted">（税込 ÷ 1.1 を四捨五入して税抜を出し、残りを消費税にしています）</span>' : '') +
        (needStamp(v.value.amount) ? '<div class="rc-alert warn" style="margin:6px 0 0">' + E(STAMP_NOTE) + '</div>' : '');
      return v;
    }
    function showErrors(v) {
      var el = document.getElementById('rc-errs'); if (!el) return;
      el.innerHTML = (v.errors.length ? '<div class="rc-alert err">' + v.errors.map(E).join('<br>') + '</div>' : '') + (v.warnings.length ? '<div class="rc-alert warn">' + v.warnings.map(E).join('<br>') + '</div>' : '');
    }
    function onInput(e) {
      if (M && M.mode === 'doc' && e.target && e.target.id === 'rc-paper') { M.doc.paper = e.target.checked; draw(); return; }
      if (M && M.mode === 'doc' && e.target && e.target.id === 'rc-office-doc') { M.doc.office = e.target.value; draw(); return; }
      if (!M || M.mode !== 'form') return;
      if (e.target && /^rc-/.test(e.target.id || '')) {
        var v = syncBreakdown();
        if (M.prev) { M.prev = false; var pv = document.getElementById('rc-prev'); if (pv) pv.innerHTML = ''; }   // 入力を変えたら、前のプレビューは消す
        showErrors({ errors: [], warnings: v.warnings });
      }
    }
    // 収入印紙が必要な金額か（基準の金額は設定 receipt.stampNoticeAmount。空なら、判定しない）
    function needStamp(amount) { return R.stampNeeded(amount, rcConf.stampNoticeAmount); }
    var STAMP_NOTE = '収入印紙が必要な場合があります。この金額は、電子（PDF）ではなく、印刷して収入印紙を貼って郵送してください（印紙が要るかどうかは、経理に確認してください）';
    function docOptions(rec, extra, officeIdx) { return Object.assign({ stampSrc: SET && SET.stamp, staff: staffName(rec), office: officeAt(officeIdx) }, extra || {}); }
    function iframeHtml(html) { return '<div class="rc-docwrap" id="rc-wrap"><iframe class="rc-doc" id="rc-frame" title="領収証" srcdoc="' + E(html) + '"></iframe></div>'; }
    function fitDoc() {   // 書類（A4）を、画面の幅に合わせて縮めて見せる
      var w = document.getElementById('rc-wrap'), f = document.getElementById('rc-frame'); if (!w || !f) return;
      var k = Math.min(1, (w.clientWidth || 794) / 794);
      f.style.transform = 'scale(' + k + ')'; w.style.height = Math.ceil(1123 * k) + 'px';
    }
    window.addEventListener('resize', fitDoc);
    function drawPreview() {
      var v = readForm(); showErrors(v); var box = document.getElementById('rc-prev'); if (!box) return;
      if (!v.ok) { box.innerHTML = ''; M.prev = false; return; }
      if (!SET || !SET.ok) { box.innerHTML = ''; return; }
      M.prev = true;
      var rec = { number: '', orderNo: M.o.no, atena: v.value.atena, proviso: v.value.proviso, amount: v.value.amount, tax: v.value.tax, issueDate: v.value.issueDate, status: R.STATUS.issued };
      box.innerHTML = '<div class="muted" style="margin-top:10px">これは見本です（まだ発行していません）。「発行する」を押すと、番号が付いて、印刷・PDF にできます。</div>' + iframeHtml(R.printHtml(rec, SET.settings, docOptions(rec, { preview: true, stampBox: needStamp(rec.amount) }, M.form.office)));
      fitDoc();
    }

    // ---- 書類（発行したあと・再発行・控え）
    function showDoc(rec, opt) { M.doc = { rec: rec, reissue: !!(opt && opt.reissue), view: !!(opt && opt.view), paper: true, office: (opt && opt.office) || '0' }; M.mode = 'doc'; draw(); }   // paper＝紙で出す（収入印紙が必要な金額のとき、貼付欄を付ける。初めは付ける）
    function docHtml() {
      var d = M.doc, voided = !R.isActive(d.rec);
      if (!SET || !SET.ok) return settingsHtml() + '<div class="rc-btns"><button type="button" class="btn sec" data-rc="back">戻る</button></div>';
      var stamp = !voided && needStamp(d.rec.amount);
      return '<div class="muted">' + E(d.rec.number) + (d.reissue ? '（再発行）' : '') + (voided ? '（取消済み・控え）' : '') + '</div>' +
        (offices().length > 1 ? '<div class="rc-row"><span class="muted">拠点（書類の住所・電話）</span>' + officeSelect('rc-office-doc', d.office) + '</div>' : '') +
        (stamp ? '<div class="rc-alert warn">' + E(STAMP_NOTE) + '<br><label><input type="checkbox" id="rc-paper"' + (d.paper !== false ? ' checked' : '') + '> 紙で出す（収入印紙の貼付欄を付けて印刷する）</label></div>' : '') +
        iframeHtml(R.printHtml(d.rec, SET.settings, docOptions(d.rec, { reissue: d.reissue, stampBox: stamp && d.paper !== false }, d.office))) +
        '<div class="rc-btns">' + (voided ? '' : '<button type="button" class="btn" data-rc="print">印刷 ／ PDF に保存</button>') + '<button type="button" class="btn sec" data-rc="back">戻る</button></div>' +
        (voided ? '' : '<div class="muted" style="margin-top:6px">印刷の画面で、送信先を「PDF に保存」にすると、PDF のファイルになります（ファイル名の初めは「' + E(R.fileName(d.rec)) + '」）。PDF は、このアプリには保存されません（記録から、いつでも作り直せます）。</div>') + warnsHtml();
    }
    function doPrint() {
      var fr = document.getElementById('rc-frame'); if (!fr || !fr.contentWindow || !M.doc) return;
      var old = document.title, w = fr.contentWindow, restored = false;
      var restore = function () { if (restored) return; restored = true; document.title = old; };
      document.title = R.fileName(M.doc.rec);   // 「PDF に保存」の初めのファイル名になる
      try { w.addEventListener('afterprint', restore); } catch (e) { /* 使えない場合は、下のタイマーで戻す */ }
      setTimeout(restore, 60000);
      try { w.focus(); w.print(); } catch (e) { restore(); setMsg('err', '印刷を始められませんでした。ブラウザの設定を確かめてください'); draw(); return; }
      ulog('receipt_pdf');
    }

    /* ------------------------------------------------------------ 操作 */
    function errText(e, what) {
      var s = e && e.status;
      if (s === 403 || s === 401) return what + 'できませんでした：この操作の権限がありません（領収証は、営業と EC 担当だけが書き込めます）';
      if (s === 400) return what + 'できませんでした：記録のリストの列が足りない可能性があります（管理者に、scripts/create_ec_lists.ps1 を実行してもらってください）';
      if (s === 404) return what + 'できませんでした：記録のリスト（EC_Receipt）が見つかりません';
      return what + 'できませんでした：' + ((e && e.message) || e);
    }
    async function needWrite() {   // 書き込みの権限（はじめての人には、ここで同意の画面が出る）
      try { await ctx.getToken(true); return true; }
      catch (e) { setMsg('err', '書き込みの権限を得られませんでした（同意の画面で「承諾」を押してください）。' + ((e && e.message) ? '（' + e.message + '）' : '')); M.busy = false; draw(); return false; }
    }
    async function logEvent(action, rec, what) {
      try {
        var EC = ctx.EC || root.EcSales; if (!EC || !store) return;
        await store.appendLog(EC.logRow({ action: action, orderNo: M.o.no, actor: me(), detail: R.logDetail(rec, what) }));
      } catch (e) { console.warn('履歴（EC_Log）に書けませんでした', e && e.status); }   // 履歴が書けなくても、発行は止めない
    }
    async function afterWrite() {
      try { var recs = await store.loadFor(M.o.no); byOrder[M.o.no] = recs; if (!recs.length) delete byOrder[M.o.no]; M.recs = recs.slice(); } catch (e) { /* いまの記録で続ける */ }
      if (ctx.onChange) ctx.onChange();
    }
    function existsMsg(cur) { return 'この注文には、すでに領収証が発行されています（' + cur.number + '・' + md(cur.issueDate) + '・' + who(cur.issuedBy) + '）。ほかの人が先に発行しました。内容は、下の記録で確かめてください'; }

    async function doIssue() {
      var v = syncBreakdown(); showErrors(v);
      if (!v.ok) return;
      if (!SET || !SET.ok) { setMsg('err', SET ? SET.err : '設定を読み込み中です'); draw(); return; }
      var rp = M.replaceOf;
      if (!confirm((rp ? rp.number + ' を取り消して、新しい領収証を発行します。\n' : '領収証を発行します。\n') + '\n宛名：' + v.value.atena + '\n但し書き：' + v.value.proviso + '\n金額：' + R.yen(v.value.amount) + '（税込）\n発行日：' + R.jaDate(v.value.issueDate) + '\n\nよろしいですか？')) return;
      M.busy = true;
      if (!(await needWrite())) return;
      var data = { orderNo: M.o.no, atena: v.value.atena, proviso: v.value.proviso, amount: v.value.amount, tax: v.value.tax, issueDate: v.value.issueDate, note: v.value.note };
      var opt = { user: me(), source: ctx.source };
      try {
        var r = rp ? await store.replace(rp, data, opt) : await store.issue(data, opt);
        M.busy = false;
        if (r.result === 'exists') { await afterWrite(); M.mode = 'list'; setMsg('warn', existsMsg(r.current)); draw(); return; }
        ulog('receipt_issue');
        await logEvent('領収証発行', r.rec, rp ? '（' + rp.number + ' の差し替え）' : '');
        if (rp && !r.cancelFailed) await logEvent('領収証取消', rp, '（' + r.rec.number + ' に差し替え）');
        await afterWrite();
        if (rp) ulog('receipt_cancel');
        var rec = M.recs.filter(function (x) { return x.id === r.rec.id; })[0] || r.rec;
        M.msg = null; M.replaceOf = null;
        if (r.cancelFailed) { M.mode = 'doc'; M.doc = { rec: rec, reissue: false }; M.msg = { type: 'warn', html: E('新しい領収証 ' + rec.number + ' は発行できましたが、古い ' + rp.number + ' を取消にできませんでした。このあと、記録の画面で ' + rp.number + ' を取り消してください') }; draw(); return; }
        setMsg('ok', '発行しました（' + rec.number + '）。下の「印刷 ／ PDF に保存」で、PDF にできます');
        showDoc(rec, { reissue: false, office: M.form && M.form.office });
      } catch (e) {
        M.busy = false;
        if (e && e.code === 'NUMBER') {
          await afterWrite(); M.mode = 'list';
          setMsg('warn', '記録は作りましたが、番号を付けるところで止まりました。もう一度開いて、記録に番号（' + e.number + '）が出ているか確かめてください');
        } else setMsg('err', errText(e, '発行'));
        draw();
      }
    }
    async function doReissue(id) {
      var rec = M.recs.filter(function (x) { return x.id === id; })[0]; if (!rec) return;
      if (!confirm(rec.number + ' を、再発行として出します（再発行 ' + (rec.reissueCount + 1) + '回目として記録します。書類に「再発行」と入ります）。\nよろしいですか？')) return;
      M.busy = true;
      if (!(await needWrite())) return;
      try {
        var r = await store.reissue(id);
        M.busy = false; ulog('receipt_reissue');
        await logEvent('領収証再発行', r, '（' + r.reissueCount + '回目）');
        await afterWrite();
        var cur = M.recs.filter(function (x) { return x.id === id; })[0] || r;
        setMsg('ok', '再発行として記録しました（' + cur.number + '・再発行 ' + cur.reissueCount + '回目）');
        showDoc(cur, { reissue: true });
      } catch (e) {
        M.busy = false;
        setMsg('err', e && e.code === 'VOID' ? '取り消された領収証は、再発行できません' : errText(e, '再発行'));
        await afterWrite(); M.mode = 'list'; draw();
      }
    }
    async function doCancel(id) {
      var rec = M.recs.filter(function (x) { return x.id === id; })[0]; if (!rec) return;
      var reason = ((document.getElementById('rc-reason') || {}).value || '').trim();
      if (!confirm(rec.number + ' を取り消します。取り消した番号は、使い回しません（記録は残ります）。\nよろしいですか？')) return;
      M.busy = true;
      if (!(await needWrite())) return;
      try {
        await store.cancel(id, { reason: reason });
        M.busy = false; ulog('receipt_cancel');
        await logEvent('領収証取消', rec, '');
        await afterWrite(); M.cancelId = null;
        setMsg('ok', rec.number + ' を取り消しました。新しく出すときは、「新しく発行する」から');
      } catch (e) { M.busy = false; setMsg('err', errText(e, '取消')); }
      draw();
    }

    function onClick(e) {
      if (!M) return;
      var b = e.target.closest('[data-rc]'); if (!b) return;
      var k = b.getAttribute('data-rc'), id = b.getAttribute('data-id');
      e.preventDefault();
      if (M.busy && k !== 'close') return;
      if (k === 'close') close();
      else if (k === 'new') { setMsg(); openForm(null); }
      else if (k === 'replace') openForm(M.recs.filter(function (x) { return x.id === id; })[0]);
      else if (k === 'back') { M.mode = 'list'; M.msg = null; M.replaceOf = null; draw(); refreshRecs(); }
      else if (k === 'cand') { var c = (M.cands || [])[+b.getAttribute('data-i')]; if (c) { document.getElementById('rc-atena').value = c.text; document.getElementById('rc-title').value = c.title; onInput({ target: document.getElementById('rc-atena') }); } }
      else if (k === 'prov') { var pv = (M.provs || [])[+b.getAttribute('data-i')]; if (pv) { document.getElementById('rc-proviso').value = pv; onInput({ target: document.getElementById('rc-proviso') }); } }
      else if (k === 'preview') drawPreview();
      else if (k === 'issue') doIssue();
      else if (k === 'reissue') doReissue(id);
      else if (k === 'cancel') { M.cancelId = id; M.msg = null; draw(); }
      else if (k === 'cancel-no') { M.cancelId = null; draw(); }
      else if (k === 'cancel-ok') doCancel(id);
      else if (k === 'print') doPrint();
      else if (k === 'viewvoid') { var v = M.recs.filter(function (x) { return x.id === id; })[0]; if (v) showDoc(v, { view: true }); }
    }
    return api;
  }

  root.ReceiptUi = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ReceiptUi;
})(typeof window !== 'undefined' ? window : globalThis);
