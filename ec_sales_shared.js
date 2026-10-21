/* EC売上アプリの共有の履歴（SharePoint のリスト EC_Order・EC_Log）を、Microsoft Graph で読み書きする部品。
 * 画面（ec_sales.html）に依存しないので Node でテストできる（tests/test_ec_sales_shared.cjs。fetch を差し替えて Graph を真似る）。
 * 列の定義は scripts/create_ec_lists.ps1、変換と差分は ec_sales_core.js（EcSales.orderFields / diffFields / logRow）。
 *
 * 使い方:
 *   const shared = EcShared.create({ getToken, sitePath: 'hanaokacorp.sharepoint.com:/sites/xxxx:', orderList: 'EC_Order', logList: 'EC_Log' });
 *   await shared.connect();                    // 接続できなければ例外（shared.isUnavailable(e) が true なら「共有の履歴に接続できません」扱い）
 *   const rows = await shared.loadAll();       // { 注文番号: 項目 }
 *   await shared.upsert('1801', EcSales.orderFields('1801', rec), { expect: ['確認待ち'] });   // 注文番号（Title）で探して、変わった項目だけ PATCH／なければ POST
 *   await shared.appendLog(EcSales.logRow({ action: '確認OK', orderNo: '1801', actor: 'a@b' }));
 * お客様の名前・住所・電話は、リストに書かない（呼び出し側が項目を選んで渡す。ここでも Title 以外の未知の項目は書かない）。 */
(function (root) {
  'use strict';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var ORDER_COLS = ['Title', 'OrderDate', 'CustomerCode', 'Status', 'BatchId', 'SmileOrderNo', 'ShipDate', 'ShipDateManual', 'MemoNote', 'NetTotal', 'OkBy', 'OkAt', 'ImportBy', 'ImportAt', 'ConfirmBy', 'ConfirmAt', 'ReportedAt', 'Note'];
  var LOG_COLS = ['Title', 'LogTime', 'Actor', 'OrderNo', 'Action', 'BatchId', 'Detail'];
  var LOG_WRITABLE = LOG_COLS.slice();
  var ORDER_WRITABLE = ORDER_COLS.filter(function (c) { return c !== 'Note'; });   // Note は人が手で書く欄。アプリは書かない（個人情報を入れない）

  function create(opt) {
    var EC = opt.EC || root.EcSales;
    var fetchFn = opt.fetchImpl || function () { return root.fetch.apply(root, arguments); };
    var siteId = null, itemIds = {};
    var api = {};

    async function req(method, path, body) {
      var token = await opt.getToken();
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
    function sel(cols) { return 'expand=fields(select=' + cols.join(',') + ')'; }
    function clean(fields, writable) {   // 書いてよい項目だけ。null は POST では送らない
      var out = {};
      Object.keys(fields).forEach(function (k) { if (writable.indexOf(k) >= 0 && fields[k] != null) out[k] = fields[k]; });
      return out;
    }

    // 接続できない（権限なし・見つからない・ネットワーク）か。そのときは localStorage だけで動き続ける
    api.isUnavailable = function (e) { return !e || !e.status || e.status === 401 || e.status === 403 || e.status === 404; };

    api.connect = async function () {
      var site = await req('GET', '/sites/' + opt.sitePath + '?$select=id');
      siteId = site.id;
      await req('GET', listPath(opt.orderList) + '?$select=id');
      await req('GET', listPath(opt.logList) + '?$select=id');
      return true;
    };

    // EC_Order の全行（ページングをたどる）。{ 注文番号: 項目 }
    api.loadAll = async function () {
      var rows = {}, url = listPath(opt.orderList) + '/items?' + sel(ORDER_COLS) + '&$top=999', guard = 0;
      itemIds = {};
      while (url && guard++ < 200) {
        var page = await req('GET', url);
        (page.value || []).forEach(function (it) {
          var f = it.fields || {}, no = String(f.Title || '').trim();
          if (!no) return;
          rows[no] = f; itemIds[no] = it.id;
        });
        url = page['@odata.nextLink'] || '';
      }
      return rows;
    };

    // 注文番号の行（{ id, fields }）。なければ null
    api.getRow = async function (no) {
      no = EC.orderNo(no);
      if (itemIds[no]) {
        try { var it = await req('GET', listPath(opt.orderList) + '/items/' + itemIds[no] + '?' + sel(ORDER_COLS)); return { id: it.id, fields: it.fields || {} }; }
        catch (e) { if (e.status !== 404) throw e; delete itemIds[no]; }
      }
      var page = await req('GET', listPath(opt.orderList) + '/items?' + sel(ORDER_COLS) + '&$filter=' + encodeURIComponent("fields/Title eq '" + no + "'") + '&$top=1');
      var hit = (page.value || [])[0];
      if (!hit) return null;
      itemIds[no] = hit.id;
      return { id: hit.id, fields: hit.fields || {} };
    };

    // 注文番号（Title）で upsert。opt.expect＝いまの Status がこの中にあるときだけ書く（直前に読み直して確かめる。違えば書かず conflict）。
    // 戻り値 { result: 'created' | 'updated' | 'unchanged' | 'conflict', changed:[項目名], current }
    api.upsert = async function (no, next, o) {
      o = o || {}; no = EC.orderNo(no);
      next = Object.assign({}, next, { Title: no });
      var row = await api.getRow(no);
      if (row) return patchRow(no, row, next, o);
      try {
        var made = await req('POST', listPath(opt.orderList) + '/items', { fields: clean(next, ORDER_WRITABLE) });
        itemIds[no] = made.id;
        return { result: 'created', changed: Object.keys(clean(next, ORDER_WRITABLE)) };
      } catch (e) {
        if (e.status === 400 || e.status === 409) {   // 同時に別の人が作った（重複不可）：読み直して更新にする
          row = await api.getRow(no);
          if (row) return patchRow(no, row, next, o);
        }
        throw e;
      }
    };
    async function patchRow(no, row, next, o) {
      if (o.expect && o.expect.length && o.expect.indexOf(row.fields.Status) < 0) return { result: 'conflict', changed: [], current: row.fields };
      var diff = EC.diffFields(row.fields, next);
      Object.keys(diff).forEach(function (k) { if (ORDER_WRITABLE.indexOf(k) < 0) delete diff[k]; });
      if (!Object.keys(diff).length) return { result: 'unchanged', changed: [], current: row.fields };
      await req('PATCH', listPath(opt.orderList) + '/items/' + row.id + '/fields', diff);
      return { result: 'updated', changed: Object.keys(diff), current: row.fields };
    }

    // EC_Log に1行追記（追記のみ。消さない・直さない）
    api.appendLog = async function (fields) {
      await req('POST', listPath(opt.logList) + '/items', { fields: clean(fields, LOG_WRITABLE) });
    };
    // その注文の履歴（新しい順）
    api.loadLog = async function (no) {
      no = EC.orderNo(no);
      var page = await req('GET', listPath(opt.logList) + '/items?' + sel(LOG_COLS) + '&$filter=' + encodeURIComponent("fields/OrderNo eq '" + no + "'") + '&$top=200');
      return (page.value || []).map(function (it) { return it.fields || {}; }).sort(function (a, b) { return Date.parse(b.LogTime || 0) - Date.parse(a.LogTime || 0); });
    };

    Object.defineProperty(api, 'siteId', { get: function () { return siteId; } });
    return api;
  }

  var EcShared = { create: create, ORDER_COLS: ORDER_COLS, LOG_COLS: LOG_COLS };
  root.EcShared = EcShared;
  if (typeof module !== 'undefined' && module.exports) module.exports = EcShared;
})(typeof window !== 'undefined' ? window : globalThis);
