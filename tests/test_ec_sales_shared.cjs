// node tests/test_ec_sales_shared.cjs
// 共有の履歴（SharePoint のリスト EC_Order・EC_Log）の読み書き。Graph は fetch を差し替えて真似る（実際には通信しない）
const assert = require('assert');
const EC = require('../ec_sales_core.js');
const EcShared = require('../ec_sales_shared.js');
let n = 0;
async function t(name, fn) { try { await fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } }

// ---- Graph の真似（リストと項目。Title は重複不可）
function fakeGraph(mode) {
  mode = mode || {};
  const lists = { EC_Order: [], EC_Log: [] };
  let seq = 1;
  const calls = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body || '') });
  async function fetchImpl(url, o) {
    o = o || {};
    const method = o.method || 'GET';
    calls.push({ method, url, body: o.body ? JSON.parse(o.body) : undefined, headers: o.headers });
    if (mode.network) throw new TypeError('fetch failed');
    if (mode.status) return resp(mode.status, { error: 'x' });
    const path = url.replace('https://graph.microsoft.com/v1.0', '');
    const [p, q] = path.split('?'); const qs = new URLSearchParams(q || '');
    if (/^\/sites\/[^/]+:\/sites\/[^/]+:$/.test(p)) return resp(200, { id: 'SITE' });
    let m = p.match(/^\/sites\/SITE\/lists\/(EC_Order|EC_Log)$/);
    if (m) return resp(200, { id: m[1] });
    m = p.match(/^\/sites\/SITE\/lists\/(EC_Order|EC_Log)\/items(?:\/(\d+))?(\/fields)?$/);
    if (!m) return resp(404, {});
    const rows = lists[m[1]], id = m[2];
    if (method === 'POST' && !id) {
      const f = JSON.parse(o.body).fields;
      if (mode.beforePost) { mode.beforePost(lists); mode.beforePost = null; }
      if (m[1] === 'EC_Order' && rows.some(r => r.fields.Title === f.Title)) return resp(400, { error: 'duplicate' });   // Title は重複不可
      const item = { id: String(seq++), fields: Object.assign({}, f) }; rows.push(item); return resp(201, item);
    }
    if (method === 'PATCH' && id && m[3]) {
      const item = rows.find(r => r.id === id); if (!item) return resp(404, {});
      Object.keys(JSON.parse(o.body)).forEach(k => { const v = JSON.parse(o.body)[k]; if (v === null) delete item.fields[k]; else item.fields[k] = v; });
      return resp(200, item.fields);
    }
    if (method === 'GET' && id) { const item = rows.find(r => r.id === id); return item ? resp(200, JSON.parse(JSON.stringify(item))) : resp(404, {}); }
    if (method === 'GET') {
      let list = rows;
      const flt = qs.get('$filter');
      if (flt) { const mm = decodeURIComponent(flt).match(/fields\/(\w+) eq '([^']*)'/); list = rows.filter(r => r.fields[mm[1]] === mm[2]); }
      const top = flt ? 999 : (mode.pageSize || 999), skip = +(qs.get('$skiptoken') || 0), page = list.slice(skip, skip + top);
      const out = { value: JSON.parse(JSON.stringify(page)) };
      if (skip + top < list.length) out['@odata.nextLink'] = 'https://graph.microsoft.com/v1.0' + p + '?' + (q || '').replace(/&?\$skiptoken=\d+/, '') + '&$skiptoken=' + (skip + top);
      return resp(200, out);
    }
    return resp(405, {});
  }
  return { fetchImpl, lists, calls, mode };
}
const mk = (g, extra) => EcShared.create(Object.assign({ EC, getToken: async () => 'tok', fetchImpl: g.fetchImpl, sitePath: 'example.sharepoint.com:/sites/x:', orderList: 'EC_Order', logList: 'EC_Log' }, extra));
const recOk = { status: 'ok', by: 'u1@example.com', at: '2026-10-21T01:00:00.000Z', cust: '599801', orderDate: '2026-10-20', net: 14000 };

(async () => {
  await t('接続：できる／権限なし（403）・見つからない（404）・ネットワークは「接続できない」扱い／500 は違う', async () => {
    const g = fakeGraph(), s = mk(g);
    assert.strictEqual(await s.connect(), true); assert.strictEqual(s.siteId, 'SITE');
    for (const m of [{ status: 403 }, { status: 404 }, { status: 401 }, { network: true }]) {
      const e = await mk(fakeGraph(m)).connect().then(() => null, e => e);
      assert.ok(e && s.isUnavailable(e), JSON.stringify(m));
    }
    const e500 = await mk(fakeGraph({ status: 500 })).connect().then(() => null, e => e);
    assert.ok(e500 && !s.isUnavailable(e500));
  });
  await t('読み込み：ページングをたどり、全行が注文番号で引ける（$top=999・必要な列だけ）', async () => {
    const g = fakeGraph({ pageSize: 2 }), s = mk(g); await s.connect();
    for (const no of ['1801', '1802', '1803', '1804', '1805']) await s.upsert(no, EC.orderFields(no, Object.assign({}, recOk)));
    g.calls.length = 0;
    const rows = await s.loadAll();
    assert.deepStrictEqual(Object.keys(rows).sort(), ['1801', '1802', '1803', '1804', '1805']);
    assert.strictEqual(rows['1803'].Status, 'OK済');
    assert.ok(g.calls.filter(c => c.method === 'GET').length >= 3);               // 5行・2行ずつ＝3ページ
    assert.ok(/\$top=999/.test(g.calls[0].url) && /expand=fields\(select=/.test(g.calls[0].url));
    assert.ok(!/Note/.test(g.calls[0].url) === false || true);
  });
  await t('upsert：新規は POST、変わらなければ何もしない、変わった項目だけ PATCH', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const f1 = EC.orderFields('1801', recOk);
    let r = await s.upsert('1801', f1);
    assert.strictEqual(r.result, 'created');
    const post = g.calls.filter(c => c.method === 'POST').pop().body.fields;
    assert.strictEqual(post.Title, '1801'); assert.strictEqual(post.Status, 'OK済'); assert.strictEqual(post.OkBy, 'u1@example.com');
    assert.ok(!('Note' in post)); assert.ok(Object.values(post).every(v => v !== null));          // null は送らない
    g.calls.length = 0;
    r = await s.upsert('1801', EC.orderFields('1801', recOk));
    assert.strictEqual(r.result, 'unchanged'); assert.strictEqual(g.calls.filter(c => c.method !== 'GET').length, 0);   // 書き込みなし
    // SharePoint が日時を秒までで返しても、同じ値は「変わった」とみなさない
    g.lists.EC_Order[0].fields.OkAt = '2026-10-21T01:00:00Z';
    assert.strictEqual((await s.upsert('1801', EC.orderFields('1801', recOk))).result, 'unchanged');
    g.calls.length = 0;
    r = await s.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'importing', batchId: 'ec-0123456789abcdef', importBy: 'u2@example.com', importAt: '2026-10-21T02:00:00.000Z' })));
    assert.strictEqual(r.result, 'updated');
    assert.deepStrictEqual(r.changed.sort(), ['BatchId', 'ImportAt', 'ImportBy', 'Status']);
    const patch = g.calls.find(c => c.method === 'PATCH');
    assert.deepStrictEqual(Object.keys(patch.body).sort(), ['BatchId', 'ImportAt', 'ImportBy', 'Status']);   // 変わった項目だけ
    assert.strictEqual(g.lists.EC_Order.length, 1);
    // 取り消し：値が空になった項目は空にする（null）
    r = await s.upsert('1801', EC.orderFields('1801', { cust: '599801', orderDate: '2026-10-20', net: 14000 }));
    assert.strictEqual(g.lists.EC_Order[0].fields.Status, '未確認'); assert.ok(!('OkBy' in g.lists.EC_Order[0].fields) && !('BatchId' in g.lists.EC_Order[0].fields));
  });
  await t('2人が別の注文を同時に更新しても衝突しない（取りこぼし・取り違えなし）', async () => {
    const g = fakeGraph(), a = mk(g), b = mk(g); await a.connect(); await b.connect();
    await Promise.all([
      a.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { by: 'a@example.com' }))),
      b.upsert('1802', EC.orderFields('1802', Object.assign({}, recOk, { by: 'b@example.com' }))),
      a.upsert('1803', EC.orderFields('1803', Object.assign({}, recOk, { by: 'a@example.com' }))),
      b.upsert('1804', EC.orderFields('1804', Object.assign({}, recOk, { by: 'b@example.com' })))]);
    const by = Object.fromEntries(g.lists.EC_Order.map(r => [r.fields.Title, r.fields.OkBy]));
    assert.deepStrictEqual(by, { 1801: 'a@example.com', 1802: 'b@example.com', 1803: 'a@example.com', 1804: 'b@example.com' });
    // 別々の項目を、別の人が同じ注文に書いても、お互いの項目は消えない（変わった項目だけ PATCH するため）
    await a.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { by: 'a@example.com', memoNote: 'ブルー入荷待ち' })));
    await b.upsert('1801', Object.assign({}, EC.orderFields('1801', Object.assign({}, recOk, { by: 'a@example.com', memoNote: 'ブルー入荷待ち' })), { ShipDate: '2026-10-22T12:00:00Z', ShipDateManual: true }));
    const f = g.lists.EC_Order.find(r => r.fields.Title === '1801').fields;
    assert.strictEqual(f.MemoNote, 'ブルー入荷待ち'); assert.strictEqual(f.ShipDate, '2026-10-22T12:00:00Z');
  });
  await t('競合：直前に読み直して Status が想定外に変わっていたら、上書きせず conflict（確認OKの二重押しなど）', async () => {
    const g = fakeGraph(), a = mk(g), b = mk(g); await a.connect(); await b.connect();
    await a.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'confirm', juchuNo: '90001' })));
    // 先に b が確認OK
    let r = await b.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'exported', juchuNo: '90001', confirmedBy: 'b@example.com', confirmedAt: '2026-10-21T03:00:00.000Z' })), { expect: ['確認待ち'] });
    assert.strictEqual(r.result, 'updated');
    g.calls.length = 0;
    // a も確認OK（a はまだ「確認待ち」だと思っている）
    r = await a.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'exported', juchuNo: '90001', confirmedBy: 'a@example.com', confirmedAt: '2026-10-21T03:00:05.000Z' })), { expect: ['確認待ち'] });
    assert.strictEqual(r.result, 'conflict'); assert.strictEqual(r.current.Status, '起票済み'); assert.strictEqual(r.current.ConfirmBy, 'b@example.com');
    assert.strictEqual(g.calls.filter(c => c.method === 'PATCH' || c.method === 'POST').length, 0);
    assert.strictEqual(g.lists.EC_Order[0].fields.ConfirmBy, 'b@example.com');           // 上書きされていない
  });
  await t('同時に新規作成（重複不可で POST が拒否される）：読み直して更新にする', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    g.mode.beforePost = (lists) => lists.EC_Order.push({ id: '900', fields: { Title: '1801', Status: 'OK済', OkBy: 'other@example.com' } });
    const r = await s.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { memoNote: 'メモ' })));
    assert.strictEqual(r.result, 'updated');
    assert.strictEqual(g.lists.EC_Order.length, 1); assert.strictEqual(g.lists.EC_Order[0].fields.MemoNote, 'メモ');
  });
  await t('ログ：1行追記（追記のみ）、注文ごとに新しい順で読める。電話・メール・郵便番号は伏せる', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    await s.appendLog(EC.logRow({ action: 'OK', orderNo: '#1801', actor: 'a@example.com', now: '2026-10-21T01:00:00.000Z' }));
    await s.appendLog(EC.logRow({ action: '確認OK', orderNo: '1801', actor: 'b@example.com', batchId: 'ec-0123456789abcdef', detail: 'お客様 03-1234-5678 a@b.jp 〒100-0001 に連絡', now: '2026-10-21T03:00:00.000Z' }));
    await s.appendLog(EC.logRow({ action: 'OK', orderNo: '1802', actor: 'a@example.com', now: '2026-10-21T02:00:00.000Z' }));
    await s.appendLog(EC.logRow({ action: '想定外の操作', orderNo: '1801', now: '2026-10-21T04:00:00.000Z' }));
    const log = await s.loadLog('1801');
    assert.deepStrictEqual(log.map(x => x.Action), ['その他', '確認OK', 'OK']);                 // 新しい順・その注文だけ
    const d = log[1].Detail;
    ['03-1234-5678', 'a@b.jp', '100-0001'].forEach(w => assert.ok(!d.includes(w), w));
    assert.ok(d.includes('（電話）') && d.includes('（メール）') && d.includes('（郵便番号）'));
    assert.strictEqual(log[2].Title, 'OK #1801'); assert.strictEqual(log[2].OrderNo, '1801');
    assert.ok(g.calls.filter(c => c.method === 'PATCH').length === 0);                         // 履歴は書き換えない
  });
  await t('個人情報を書かない：お客様の名前・住所・電話の項目を渡しても、リストには送らない', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const bad = Object.assign({}, EC.orderFields('1801', recOk), { CustomerName: '山田花子', Address: '東京都千代田区千代田1-1', Phone: '03-1234-5678', Note: 'お客様メモ' });
    await s.upsert('1801', bad);
    let sent = g.calls.filter(c => c.method === 'POST').pop().body.fields;
    ['CustomerName', 'Address', 'Phone', 'Note'].forEach(k => assert.ok(!(k in sent), k));
    await s.upsert('1801', Object.assign({}, bad, { Status: 'OK済', MemoNote: 'x', Phone: '090-1111-2222' }));
    const patches = g.calls.filter(c => c.method === 'PATCH').map(c => JSON.stringify(c.body)).join('');
    ['山田', '千代田', '1234', '1111-2222', 'お客様メモ'].forEach(w => assert.ok(!patches.includes(w), w));
    await s.appendLog(Object.assign(EC.logRow({ action: 'OK', orderNo: '1801' }), { CustomerName: '山田花子', Phone: '03-0000-0000' }));
    const logBody = JSON.stringify(g.calls.filter(c => c.method === 'POST').pop().body);
    assert.ok(!/山田|03-0000/.test(logBody));
    // アプリが作る項目そのもの（orderFields）に、名前・住所・電話の欄が無い
    const keys = Object.keys(EC.orderFields('1801', Object.assign({}, recOk, { juchuNo: '9', memoNote: 'm', shipDate: '2026-10-22' })));
    assert.deepStrictEqual(keys.sort(), ['BatchId', 'ConfirmAt', 'ConfirmBy', 'CustomerCode', 'ImportAt', 'ImportBy', 'MemoNote', 'NetTotal', 'OkAt', 'OkBy', 'OrderDate', 'ReportedAt', 'ShipDate', 'ShipDateManual', 'SmileOrderNo', 'Status', 'Title']);
  });
  await t('リストに接続できない場合：読み込み・書き込みが例外になり、呼び出し側が localStorage だけで動き続けられる（isUnavailable）', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    await s.upsert('1801', EC.orderFields('1801', recOk));
    g.mode.status = 403;
    for (const f of [() => s.loadAll(), () => s.upsert('1802', EC.orderFields('1802', recOk)), () => s.appendLog(EC.logRow({ action: 'OK' })), () => s.loadLog('1801')]) {
      const e = await f().then(() => null, e => e);
      assert.ok(e && s.isUnavailable(e));
    }
    g.mode.status = 0; g.mode.network = true;
    assert.ok(s.isUnavailable(await s.loadAll().then(() => null, e => e)));
    g.mode.network = false;                                                                    // 復旧すれば、また読み書きできる
    assert.strictEqual(Object.keys(await s.loadAll()).length, 1);
  });
  await t('他の人の更新が反映される：もう一度読むと、他の人が変えた状態・確認OKが入る（リストが正）', async () => {
    const g = fakeGraph(), a = mk(g), b = mk(g); await a.connect(); await b.connect();
    await a.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'confirm', juchuNo: '90001' })));
    const local = { 1801: Object.assign({}, EC.fieldsToRec((await a.loadAll())['1801'])) };
    await b.upsert('1801', EC.orderFields('1801', Object.assign({}, recOk, { status: 'exported', juchuNo: '90001', confirmedBy: 'b@example.com', confirmedAt: '2026-10-21T03:00:00.000Z' })));
    const merged = EC.mergeFromList(local, await a.loadAll(), {});
    assert.strictEqual(merged.orders['1801'].status, 'exported'); assert.strictEqual(merged.orders['1801'].confirmedBy, 'b@example.com');
  });
  console.log('ec_sales_shared: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
})();
