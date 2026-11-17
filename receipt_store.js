/* 領収証の発行の記録（SharePoint のリスト EC_Receipt）を、Microsoft Graph で読み書きする部品。
 * 画面に依存しないので Node でテストできる（tests/test_receipt_store.cjs。fetch を差し替えて Graph を真似る）。EcShared（ec_sales_shared.js）と同じ作り。
 * 列の定義は scripts/create_ec_lists.ps1、計算・変換は receipt_core.js（ReceiptCore）。PDF は保存しない（記録から、いつでも作り直す）。
 *
 * 使い方:
 *   const store = ReceiptStore.create({ getToken: async (write) => token, sitePath: 'xxx.sharepoint.com:/sites/yyy:', listName: 'EC_Receipt', logList: 'EC_Log' });
 *   await store.connect();                       // 読めなければ例外（store.isUnavailable(e) が true なら、画面は静かにボタンも札も隠す）
 *   const map = await store.loadAll();           // { 注文番号: [記録（新しい順）] }
 *   const r = await store.issue({ orderNo, atena, proviso, amount, tax, issueDate, paidDate, note }, { user, source });   // { result:'created', rec } か { result:'exists', current }
 * getToken(true) は書き込み用（呼ぶ画面が、押したときに初めて書き込みの権限を求める）。getToken(false) は読み取り用。 */
(function (root) {
  'use strict';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var COLS = ['Title', 'OrderNo', 'Atena', 'Proviso', 'Amount', 'Tax', 'IssueDate', 'PaidDate', 'IssuedBy', 'Status', 'ReissueCount', 'Note', 'Source'];   // PaidDate＝領収日（あとから足した列。なくても動く：api.hasPaidDate）
  var WRITABLE = COLS.slice();
  // 会社の情報は、見積アプリ（quote_store.js）と同じ場所（SharedMasters と同じサイトのリスト SD_設定、Title＝「会社」の行の Data）から、読むだけ
  var COMPANY_SITE_ID = 'hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23';
  var COMPANY_LIST = 'SD_設定', COMPANY_TITLE = '会社';

  function create(opt) {
    var R = opt.R || root.ReceiptCore;
    var fetchFn = opt.fetchImpl || function () { return root.fetch.apply(root, arguments); };
    var siteId = null, api = {}, cols = COLS.slice();

    async function req(method, path, body, write) {
      var token = await opt.getToken(!!write);
      var url = path.indexOf('http') === 0 ? path : GRAPH + path;
      var res = await fetchFn(url, {
        method: method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!res.ok) {
        var e = new Error('Graph ' + res.status);
        e.status = res.status;
        try { e.detail = String(await res.text()).slice(0, 300); } catch (x) { e.detail = ''; }
        throw e;
      }
      if (res.status === 204) return null;
      return res.json();
    }
    function listPath(name) { return '/sites/' + siteId + '/lists/' + encodeURIComponent(name); }
    function sel() { return 'expand=fields(select=' + cols.join(',') + ')'; }
    function clean(fields) {
      var out = {};
      Object.keys(fields).forEach(function (k) { if (WRITABLE.indexOf(k) >= 0 && cols.indexOf(k) >= 0 && fields[k] != null) out[k] = fields[k]; });
      return out;
    }

    // 読めない（権限なし・リストなし・列が足りない・ネットワーク）か。そのとき画面は、ボタンも札も静かに隠す（エラーは出さない）
    api.isUnavailable = function (e) { return !e || !e.status || e.status === 400 || e.status === 401 || e.status === 403 || e.status === 404; };

    api.connect = async function () {
      var site = await req('GET', '/sites/' + opt.sitePath + '?$select=id');
      siteId = site.id;
      await req('GET', listPath(opt.listName) + '?$select=id');
      // 領収日の列（PaidDate）があるか。なければ、その列を使わずに動く（管理者が scripts/create_ec_lists.ps1 を実行すると、列が足される）
      try {
        var have = ((await req('GET', listPath(opt.listName) + '/columns?$select=name')).value || []).map(function (c) { return c.name; });
        if (have.length && have.indexOf('PaidDate') < 0) cols = cols.filter(function (c) { return c !== 'PaidDate'; });
      } catch (e) { /* 列の一覧を読めないときは、列があるものとして進む */ }
      return true;
    };

    // EC_Receipt の全行（ページングをたどる）。{ 注文番号: [記録（新しい順）] }。列が足りないと 400 になり、例外（画面は隠す）
    api.loadAll = async function () {
      var all = [], url = listPath(opt.listName) + '/items?' + sel() + '&$top=999', guard = 0;
      while (url && guard++ < 200) {
        var page = await req('GET', url);
        (page.value || []).forEach(function (it) { all.push(R.fromItem(it)); });
        url = page['@odata.nextLink'] || '';
      }
      return R.groupByOrder(all);
    };

    // 見積アプリの会社の情報（{ company, regNo, bank, offices }）を読む。読み取りの権限（Sites.Read.All）で足りる。
    // 読めない（権限なし・リストなし・行なし・形が壊れている・ネットワーク）ときは null（画面は「会社の設定がありません」と出す）。書き込みはしない
    api.loadCompany = async function () {
      try {
        var site = opt.companySiteId || COMPANY_SITE_ID, list = opt.companyList || COMPANY_LIST;
        var page = await req('GET', '/sites/' + site + '/lists/' + encodeURIComponent(list) + '/items?expand=fields(select=Title,Data)&$top=999');
        var hit = (page.value || []).filter(function (it) { return it && it.fields && it.fields.Title === COMPANY_TITLE; })[0];
        if (!hit) return null;
        var d = JSON.parse(hit.fields.Data || '{}');
        return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
      } catch (e) { return null; }
    };

    // その注文の記録（新しい順）。発行の直前に、最新を読み直すために使う
    api.loadFor = async function (orderNo) {
      var no = R.orderNo(orderNo);
      var page = await req('GET', listPath(opt.listName) + '/items?' + sel() + '&$filter=' + encodeURIComponent("fields/OrderNo eq '" + no + "'") + '&$top=100');
      return R.sortNewest((page.value || []).map(R.fromItem));
    };

    async function getItem(id) {
      var it = await req('GET', listPath(opt.listName) + '/items/' + id + '?' + sel());
      return R.fromItem(it);
    }
    async function patch(id, diff) {
      await req('PATCH', listPath(opt.listName) + '/items/' + id + '/fields', diff, true);
    }

    /* 発行：その注文に有効な記録がすでにあれば、作らない（{ result:'exists', current }）。作る直前に読み直す（同時に別の人が発行した場合に備える）。
     * form＝{ orderNo, atena（敬称つき）, proviso, amount, tax, issueDate（発行日）, paidDate（領収日）, note }、o＝{ user, source, now, ignoreId（差し替えで取り消す予定の記録の id。これは重複とみなさない） }
     * 項目を作ってから、その ID で領収証番号（Title）を付ける。番号が付かなかったら、E.code='NUMBER' の例外（記録は残る。次に開いたときも、同じ番号で出る）。 */
    api.issue = async function (form, o) {
      o = o || {};
      var cur = (await api.loadFor(form.orderNo)).filter(function (r) { return R.isActive(r) && r.id !== String(o.ignoreId || ''); });
      if (cur.length) return { result: 'exists', current: cur[0] };
      var rec = { orderNo: form.orderNo, atena: form.atena, proviso: form.proviso, amount: form.amount, tax: form.tax, issueDate: form.issueDate, paidDate: form.paidDate || '', issuedBy: o.user || '', status: R.STATUS.issued, reissueCount: 0, note: form.note || '', source: o.source || '' };
      var made = await req('POST', listPath(opt.listName) + '/items', { fields: clean(R.toFields(rec)) }, true);   // Title は仮のまま作る
      var number = R.numberOf(made.id, R.yearJst(o.now));
      try { await patch(made.id, { Title: number }); }
      catch (e1) {
        try { await patch(made.id, { Title: number }); }   // もう1回だけ
        catch (e2) { var er = new Error('領収証番号を付けられませんでした'); er.code = 'NUMBER'; er.status = e2.status; er.id = String(made.id); er.number = number; throw er; }
      }
      rec.id = String(made.id); rec.number = number;
      // 作った直後にも、もう一度確かめる：ほぼ同時に別の人が発行していたら、番号（ID）の小さいほうだけを有効にする（あとの人の分は、自動で取消にする）。
      // 2人が同時に読み直しても、必ず小さいほうが残るので、有効な領収証が2枚になることはない
      var others = (await api.loadFor(form.orderNo)).filter(function (r) { return R.isActive(r) && r.id !== rec.id && r.id !== String(o.ignoreId || ''); });
      var winner = others.filter(function (r) { return (+r.id || 0) < (+rec.id || 0); })[0];
      if (winner) {
        try { await patch(rec.id, { Status: R.STATUS.voided, Note: '取消：同時に発行されたため（' + winner.number + ' が先）' }); } catch (e) { /* 取消せなくても、先の記録が正。画面が「有効が2枚」を知らせる */ }
        return { result: 'exists', current: winner };
      }
      return { result: 'created', rec: rec };
    };

    // 再発行：再発行の回数を1つ増やす（読み直してから）。取消済みの記録は再発行できない
    api.reissue = async function (id) {
      var cur = await getItem(id);
      if (!R.isActive(cur)) { var e = new Error('取り消した領収証は、再発行できません'); e.code = 'VOID'; throw e; }
      var n = cur.reissueCount + 1;
      await patch(id, { ReissueCount: n });
      cur.reissueCount = n;
      return cur;
    };

    // 取消：状態を「取消」にし、理由をメモに足す。取消した番号は使い回さない（行は消さない）
    api.cancel = async function (id, o) {
      o = o || {};
      var cur = await getItem(id);
      if (!R.isActive(cur)) return cur;   // すでに取消
      var note = [cur.note, o.reason ? '取消：' + o.reason : '取消'].filter(Boolean).join(' / ').slice(0, 1000);
      await patch(id, { Status: R.STATUS.voided, Note: note });
      cur.status = R.STATUS.voided; cur.note = note;
      return cur;
    };

    /* 宛名・金額を変えて出し直す：先に新しい記録を作り（古いものは重複とみなさない）、そのあと古いものを取消にする。
     * 取消だけが失敗したら { result:'created', rec, cancelFailed:true }（新しい記録は有効。古いものを手で取り消してもらう）。 */
    api.replace = async function (oldRec, form, o) {
      o = o || {};
      var made = await api.issue(Object.assign({}, form, { note: [form.note, oldRec.number + ' の差し替え'].filter(Boolean).join(' / ') }), Object.assign({}, o, { ignoreId: oldRec.id }));
      if (made.result !== 'created') return made;
      try { var old = await api.cancel(oldRec.id, { reason: made.rec.number + ' に差し替え' }); return { result: 'created', rec: made.rec, old: old }; }
      catch (e) { return { result: 'created', rec: made.rec, cancelFailed: true, cancelError: e }; }
    };

    // EC_Log に1行追記（追記のみ）。うまくいかなくても、発行そのものは止めない（呼ぶ側で握りつぶす）。EC.logRow（ec_sales_core.js）が作った行を渡す
    api.appendLog = async function (row) {
      if (!opt.logList || !siteId) return false;
      var f = {}; ['Title', 'LogTime', 'Actor', 'OrderNo', 'Action', 'BatchId', 'Detail'].forEach(function (k) { if (row[k] != null) f[k] = row[k]; });
      try { await req('POST', listPath(opt.logList) + '/items', { fields: f }, true); }
      catch (e) {
        // 「操作」の選択肢に無い名前だと、リストが断ることがある。「その他」にして、名前を詳細の頭に付けて書き直す（EcShared.appendLog と同じ）
        if (!e || e.status !== 400 || !f.Action || f.Action === 'その他') throw e;
        await req('POST', listPath(opt.logList) + '/items', { fields: Object.assign({}, f, { Action: 'その他', Detail: (f.Action + '：' + (f.Detail || '')).slice(0, 1000) }) }, true);
      }
      return true;
    };

    Object.defineProperty(api, 'siteId', { get: function () { return siteId; } });
    Object.defineProperty(api, 'hasPaidDate', { get: function () { return cols.indexOf('PaidDate') >= 0; } });
    return api;
  }

  var ReceiptStore = { create: create, COLS: COLS, COMPANY_SITE_ID: COMPANY_SITE_ID };
  root.ReceiptStore = ReceiptStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = ReceiptStore;
})(typeof window !== 'undefined' ? window : globalThis);
