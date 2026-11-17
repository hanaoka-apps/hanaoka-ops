// node tests/test_receipt_store.cjs
// 領収証の記録（SharePoint のリスト EC_Receipt）の読み書き。Graph は fetch を差し替えて真似る（実際には通信しない。値はすべて架空）
const assert = require('assert');
const EC = require('../ec_sales_core.js');
const R = require('../receipt_core.js');
const ReceiptStore = require('../receipt_store.js');
let n = 0;
async function t(name, fn) { try { await fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } }

// ---- Graph の真似（リストと項目。項目の ID は、リストごとの連番）
function fakeGraph(mode) {
  mode = mode || {};
  const lists = { EC_Receipt: [], EC_Log: [] };
  const seq = { EC_Receipt: 1, EC_Log: 1 };
  const calls = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body || '') });
  async function fetchImpl(url, o) {
    o = o || {};
    const method = o.method || 'GET';
    calls.push({ method, url, body: o.body ? JSON.parse(o.body) : undefined });
    if (mode.network) throw new TypeError('fetch failed');
    if (mode.status) return resp(mode.status, { error: 'x' });
    const path = url.replace('https://graph.microsoft.com/v1.0', '');
    // 見積アプリの会社の情報（SD_設定）。mode.company＝行の並び（なければリストなし）
    const cm = decodeURIComponent(path.split('?')[0]).match(/^\/sites\/([^/]+)\/lists\/SD_設定\/items$/);
    if (cm) {
      calls[calls.length - 1].companySite = cm[1];
      if (method !== 'GET') return resp(405, {});
      return mode.company ? resp(200, { value: mode.company }) : resp(404, {});
    }
    const [p, q] = path.split('?'); const qs = new URLSearchParams(q || '');
    if (/^\/sites\/[^/]+:\/sites\/[^/]+:$/.test(p)) return resp(200, { id: 'SITE' });
    let m = p.match(/^\/sites\/SITE\/lists\/(EC_Receipt|EC_Log)$/);
    if (m) return mode.noList === m[1] ? resp(404, {}) : resp(200, { id: m[1] });
    m = p.match(/^\/sites\/SITE\/lists\/(EC_Receipt|EC_Log)\/items(?:\/(\d+))?(\/fields)?$/);
    if (!m) return resp(404, {});
    const name = m[1], rows = lists[name], id = m[2];
    if (mode.badColumns && method === 'GET' && name === 'EC_Receipt') return resp(400, { error: 'Field not found' });   // 列が足りない
    if (method === 'POST' && !id) {
      const f = JSON.parse(o.body).fields;
      if (mode.beforePost) { const f0 = mode.beforePost; mode.beforePost = null; f0(lists, seq); }
      if (name === 'EC_Log' && (mode.rejectActions || []).includes(f.Action)) return resp(400, { error: 'invalid choice' });
      if (mode.readOnly) return resp(403, {});
      const item = { id: String(seq[name]++), createdDateTime: mode.created || '2026-11-16T01:00:00Z', fields: Object.assign({}, f) }; rows.push(item); return resp(201, item);
    }
    if (method === 'PATCH' && id && m[3]) {
      if (mode.patchFail && mode.patchFail(id, JSON.parse(o.body))) return resp(500, {});
      const item = rows.find(r => r.id === id); if (!item) return resp(404, {});
      const b = JSON.parse(o.body); Object.keys(b).forEach(k => { if (b[k] === null) delete item.fields[k]; else item.fields[k] = b[k]; });
      return resp(200, item.fields);
    }
    if (method === 'GET' && id) { const item = rows.find(r => r.id === id); return item ? resp(200, JSON.parse(JSON.stringify(item))) : resp(404, {}); }
    if (method === 'GET') {
      let list = rows; const flt = qs.get('$filter');
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
function mk(g, extra) {
  const tokens = [];
  const s = ReceiptStore.create(Object.assign({ R, getToken: async w => { tokens.push(!!w); return 'tok'; }, fetchImpl: g.fetchImpl, sitePath: 'example.sharepoint.com:/sites/x:', listName: 'EC_Receipt', logList: 'EC_Log' }, extra));
  s.tokens = tokens; return s;
}
const form = (o) => Object.assign({ orderNo: '1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, tax: 1000, issueDate: '2026-11-16', note: '' }, o);
const NOW = new Date('2026-11-16T01:00:00Z');

(async () => {
  await t('接続：できる／権限なし（403）・リストなし（404）・ネットワークは「読めない」扱い（画面は静かに隠す）／500 は違う', async () => {
    const g = fakeGraph(), s = mk(g);
    assert.strictEqual(await s.connect(), true); assert.strictEqual(s.siteId, 'SITE');
    for (const m of [{ status: 403 }, { status: 404 }, { status: 401 }, { network: true }, { noList: 'EC_Receipt' }]) {
      const e = await mk(fakeGraph(m)).connect().then(() => null, e => e);
      assert.ok(e && s.isUnavailable(e), JSON.stringify(m));
    }
    const e500 = await mk(fakeGraph({ status: 500 })).connect().then(() => null, e => e);
    assert.ok(e500 && !s.isUnavailable(e500));
  });

  await t('列が足りない（400）：読み込みの例外が「読めない」扱い→画面は壊れず、ボタンを隠す', async () => {
    const g = fakeGraph({ badColumns: true }), s = mk(g); await s.connect();
    const e = await s.loadAll().then(() => null, e => e);
    assert.ok(e && e.status === 400 && s.isUnavailable(e));
  });

  await t('読み込み：ページングをたどり、注文番号ごと・新しい順。読み取りの権限（write=false）で読む', async () => {
    const g = fakeGraph({ pageSize: 2 }), s = mk(g); await s.connect();
    for (const no of ['1801', '1802', '1803']) await s.issue(form({ orderNo: no }), { user: 'a@example.com', source: 'ec_viewer', now: NOW });
    await s.cancel('1');                                                   // 1801 の最初の記録を取消
    await s.issue(form({ orderNo: '1801', amount: 5000, tax: 455 }), { user: 'b@example.com', source: 'ec_sales', now: NOW });   // 取消のあとなので、新しく出せる
    s.tokens.length = 0; g.calls.length = 0;
    const map = await s.loadAll();
    assert.deepStrictEqual(Object.keys(map).sort(), ['1801', '1802', '1803']);
    assert.deepStrictEqual(map['1801'].map(r => r.number + ':' + r.status), ['R-2026-00004:発行済', 'R-2026-00001:取消']);
    assert.strictEqual(map['1802'][0].amount, 11000); assert.strictEqual(map['1802'][0].issueDate, '2026-11-16');
    assert.ok(g.calls.filter(c => c.method === 'GET').length >= 2 && g.calls.every(c => c.method === 'GET'));
    assert.ok(/\$top=999/.test(g.calls[0].url) && /expand=fields\(select=/.test(g.calls[0].url));
    assert.ok(s.tokens.length && s.tokens.every(w => w === false));        // 読むだけなら、書き込みの権限は求めない
  });

  await t('発行：項目を作り、その ID で番号（R-年-5桁）を付ける。書き込みの権限で書く。お客様の名前は宛名の列だけ', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect(); s.tokens.length = 0;
    const r = await s.issue(form(), { user: 'a@example.com', source: 'ec_viewer', now: NOW });
    assert.strictEqual(r.result, 'created'); assert.strictEqual(r.rec.number, 'R-2026-00001'); assert.strictEqual(r.rec.id, '1');
    const row = g.lists.EC_Receipt[0].fields;
    assert.strictEqual(row.Title, 'R-2026-00001'); assert.strictEqual(row.OrderNo, '1801'); assert.strictEqual(row.Atena, '山田 太郎 様');
    assert.strictEqual(row.Amount, 11000); assert.strictEqual(row.Tax, 1000); assert.strictEqual(row.IssueDate, '2026-11-16T12:00:00Z');
    assert.strictEqual(row.IssuedBy, 'a@example.com'); assert.strictEqual(row.Status, '発行済'); assert.strictEqual(row.ReissueCount, 0); assert.strictEqual(row.Source, 'ec_viewer');
    const post = g.calls.find(c => c.method === 'POST').body.fields;
    assert.strictEqual(post.Title, R.PENDING_TITLE); assert.ok(Object.values(post).every(v => v !== null));
    assert.ok(g.calls.some(c => c.method === 'PATCH' && c.body.Title === 'R-2026-00001'));
    assert.deepStrictEqual(Object.keys(post).sort(), ['Amount', 'Atena', 'IssueDate', 'IssuedBy', 'Note', 'OrderNo', 'Proviso', 'ReissueCount', 'Source', 'Status', 'Tax', 'Title']);   // 未知の項目は書かない
    assert.ok(s.tokens.includes(true));                                    // 書き込みの権限
  });

  await t('番号の年は、発行した日の日本時間の年（UTC の大みそか夕方は、日本では元日）。連番は ID なので続く', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const a = await s.issue(form({ orderNo: '1' }), { now: new Date('2026-12-31T14:00:00Z') });
    const b = await s.issue(form({ orderNo: '2' }), { now: new Date('2026-12-31T15:00:00Z') });
    assert.strictEqual(a.rec.number, 'R-2026-00001'); assert.strictEqual(b.rec.number, 'R-2027-00002');
  });

  await t('二重発行の防止：有効な記録があれば、作らず exists を返す（発行者・日付が出せる）', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    await s.issue(form(), { user: 'a@example.com', now: NOW });
    const posts = g.calls.filter(c => c.method === 'POST').length;
    const r = await s.issue(form({ atena: '別の人 様' }), { user: 'b@example.com', now: NOW });
    assert.strictEqual(r.result, 'exists'); assert.strictEqual(r.current.number, 'R-2026-00001'); assert.strictEqual(r.current.issuedBy, 'a@example.com');
    assert.strictEqual(g.calls.filter(c => c.method === 'POST').length, posts);          // 新しく作っていない
    assert.strictEqual(g.lists.EC_Receipt.length, 1);
    assert.strictEqual((await s.issue(form({ orderNo: '1802' }), { now: NOW })).result, 'created');   // 別の注文は出せる
  });

  await t('同時に別の人が発行：作る直前の読み直しで見つけて作らない／割り込まれても、番号の小さいほうだけ有効（あとの人の分は自動で取消）', async () => {
    // ① 読み直しより前に、別の人が発行していた
    const g2 = fakeGraph(), s2 = mk(g2); await s2.connect();
    g2.lists.EC_Receipt.push({ id: '1', createdDateTime: '2026-11-16T01:00:00Z', fields: { Title: 'R-2026-00001', OrderNo: '1801', Amount: 11000, Status: '発行済' } });
    assert.strictEqual((await s2.issue(form(), { now: NOW })).result, 'exists');
    // ② 読み直しのあと・作る前に、別の人が発行した（あとから作った自分が、取り消される）
    const g = fakeGraph(), s = mk(g); await s.connect();
    g.mode.beforePost = (lists, seq) => { lists.EC_Receipt.push({ id: String(seq.EC_Receipt++), createdDateTime: '2026-11-16T01:00:00Z', fields: { Title: 'R-2026-00001', OrderNo: '1801', Amount: 11000, Status: '発行済', Atena: '先の人 様' } }); };
    const r = await s.issue(form(), { user: 'b@example.com', now: NOW });
    assert.strictEqual(r.result, 'exists'); assert.strictEqual(r.current.number, 'R-2026-00001');
    const recs = await s.loadFor('1801');
    assert.strictEqual(recs.filter(R.isActive).length, 1); assert.strictEqual(recs.filter(R.isActive)[0].id, '1');   // 有効は先の1枚だけ
    assert.strictEqual(g.lists.EC_Receipt[1].fields.Status, '取消'); assert.ok(/同時に発行されたため/.test(g.lists.EC_Receipt[1].fields.Note));
    // ③ 自分のほうが先（小さい ID）なら、そのまま残る（割り込んだ人が、あとの人）
    const g3 = fakeGraph(), s3 = mk(g3); await s3.connect();
    const mine = await s3.issue(form(), { now: NOW });
    assert.strictEqual(mine.result, 'created');
    g3.lists.EC_Receipt.push({ id: '5', createdDateTime: '2026-11-16T01:00:00Z', fields: { Title: 'R-2026-00005', OrderNo: '1801', Status: '発行済' } });   // 後から来た別の人
    const late = (await s3.loadFor('1801')).filter(R.isActive).sort((a, b) => a.id - b.id);
    assert.strictEqual(late[0].id, mine.rec.id);                                  // 先の人（自分）が有効の先頭
  });

  await t('番号を付けるのに失敗：1回やり直す／それでも失敗なら NUMBER の例外。行は残り、読むと同じ番号で出る', async () => {
    let fails = 1;
    const g = fakeGraph({ patchFail: (id, b) => b.Title && fails-- > 0 }), s = mk(g); await s.connect();
    const r = await s.issue(form(), { now: NOW });
    assert.strictEqual(r.rec.number, 'R-2026-00001');                         // 1回目は失敗、2回目で成功
    fails = 99;
    const e = await s.issue(form({ orderNo: '1802' }), { now: NOW }).then(() => null, e => e);
    assert.ok(e && e.code === 'NUMBER' && e.number === 'R-2026-00002');
    assert.strictEqual(g.lists.EC_Receipt[1].fields.Title, R.PENDING_TITLE);
    const rec = (await s.loadFor('1802'))[0];
    assert.strictEqual(rec.number, 'R-2026-00002'); assert.ok(rec.numberPending);   // 番号が付いていない行も、ID から同じ番号
  });

  await t('再発行：回数を1つずつ足す（読み直してから）。取消済みは再発行できない', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const { rec } = await s.issue(form(), { now: NOW });
    let x = await s.reissue(rec.id); assert.strictEqual(x.reissueCount, 1);
    x = await s.reissue(rec.id); assert.strictEqual(x.reissueCount, 2);
    assert.strictEqual(g.lists.EC_Receipt[0].fields.ReissueCount, 2);
    await s.cancel(rec.id);
    const e = await s.reissue(rec.id).then(() => null, e => e);
    assert.ok(e && e.code === 'VOID'); assert.strictEqual(g.lists.EC_Receipt[0].fields.ReissueCount, 2);
  });

  await t('取消：状態を取消にして理由をメモに足す。行は消さない。番号は使い回さない（次は新しい番号）。2回押しても変わらない', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const { rec } = await s.issue(form({ note: '先方の依頼' }), { now: NOW });
    const c = await s.cancel(rec.id, { reason: '宛名の間違い' });
    assert.strictEqual(c.status, '取消'); assert.strictEqual(g.lists.EC_Receipt.length, 1);
    assert.strictEqual(g.lists.EC_Receipt[0].fields.Status, '取消'); assert.strictEqual(g.lists.EC_Receipt[0].fields.Note, '先方の依頼 / 取消：宛名の間違い');
    const patches = g.calls.filter(c => c.method === 'PATCH').length;
    await s.cancel(rec.id, { reason: 'もう一度' });
    assert.strictEqual(g.calls.filter(c => c.method === 'PATCH').length, patches);   // すでに取消なら、何もしない
    const again = await s.issue(form({ amount: 3000, tax: 273 }), { now: NOW });
    assert.strictEqual(again.result, 'created'); assert.strictEqual(again.rec.number, 'R-2026-00002');   // 取消した 00001 は、使わない
  });

  await t('出し直し（差し替え）：新しい記録を作ってから、古いものを取消にする。メモに互いの番号', async () => {
    const g = fakeGraph(), s = mk(g); await s.connect();
    const { rec } = await s.issue(form(), { user: 'a@example.com', now: NOW });
    const r = await s.replace(rec, form({ atena: '別の会社 御中', amount: 9000, tax: 818 }), { user: 'a@example.com', source: 'ec_sales', now: NOW });
    assert.strictEqual(r.result, 'created'); assert.strictEqual(r.rec.number, 'R-2026-00002'); assert.ok(!r.cancelFailed);
    const rows = g.lists.EC_Receipt.map(x => x.fields);
    assert.strictEqual(rows[0].Status, '取消'); assert.ok(/R-2026-00002 に差し替え/.test(rows[0].Note));
    assert.strictEqual(rows[1].Status, '発行済'); assert.ok(/R-2026-00001 の差し替え/.test(rows[1].Note)); assert.strictEqual(rows[1].Atena, '別の会社 御中');
    assert.strictEqual((await s.loadFor('1801')).filter(R.isActive).length, 1);
  });
  await t('出し直し：古いものの取消だけ失敗したら、新しい記録は有効のまま cancelFailed を返す／他の人が先に出していたら exists', async () => {
    const g = fakeGraph({ patchFail: (id, b) => b.Status === '取消' }), s = mk(g); await s.connect();
    const { rec } = await s.issue(form(), { now: NOW });
    const r = await s.replace(rec, form({ amount: 9000, tax: 818 }), { now: NOW });
    assert.strictEqual(r.result, 'created'); assert.strictEqual(r.cancelFailed, true); assert.ok(r.cancelError);
    const g2 = fakeGraph(), s2 = mk(g2); await s2.connect();
    const o = await s2.issue(form(), { now: NOW });
    g2.lists.EC_Receipt.push({ id: '9', createdDateTime: '2026-11-16T01:00:00Z', fields: { Title: 'R-2026-00009', OrderNo: '1801', Status: '発行済' } });   // 別の人が、別の有効な1枚
    const r2 = await s2.replace(o.rec, form({ amount: 9000, tax: 818 }), { now: NOW });
    assert.strictEqual(r2.result, 'exists');
  });

  await t('権限なし（書き込みが 403）：読めても書けないときは、例外（画面が「権限がありません」と出す）', async () => {
    const g = fakeGraph({ readOnly: true }), s = mk(g); await s.connect();
    const e = await s.issue(form(), { now: NOW }).then(() => null, e => e);
    assert.ok(e && e.status === 403);
    assert.strictEqual(g.lists.EC_Receipt.length, 0);
  });

  await t('EC_Log：履歴を1行追記（番号だけ）／操作の選択肢に無い名前は「その他」にして詳細の頭に名前を付けて書き直す／リストなしでも落ちない', async () => {
    const g = fakeGraph({ rejectActions: ['領収証発行'] }), s = mk(g); await s.connect();
    const row = EC.logRow({ action: '領収証発行', orderNo: '1801', actor: 'a@example.com', detail: R.logDetail({ number: 'R-2026-00001' }, '発行') });
    assert.strictEqual(row.Action, '領収証発行'); assert.strictEqual(row.Detail, 'R-2026-00001 発行'); assert.ok(!/山田|11000/.test(JSON.stringify(row)));   // 番号だけ。宛名・金額は入らない
    assert.strictEqual(await s.appendLog(row), true);
    assert.strictEqual(g.lists.EC_Log[0].fields.Action, 'その他'); assert.strictEqual(g.lists.EC_Log[0].fields.Detail, '領収証発行：R-2026-00001 発行');   // リストが断ったので「その他」で書き直した（EcShared.appendLog と同じ）
    const g2 = fakeGraph({ rejectActions: ['領収証発行'] }), s2 = mk(g2); await s2.connect();
    assert.strictEqual(await s2.appendLog({ Title: 'x', Action: '領収証発行', OrderNo: '1801', Detail: 'R-2026-00001 発行' }), true);
    assert.strictEqual(g2.lists.EC_Log[0].fields.Action, 'その他'); assert.strictEqual(g2.lists.EC_Log[0].fields.Detail, '領収証発行：R-2026-00001 発行');
    const s3 = ReceiptStore.create({ R, getToken: async () => 't', fetchImpl: g.fetchImpl, sitePath: 'example.sharepoint.com:/sites/x:', listName: 'EC_Receipt' });
    await s3.connect(); assert.strictEqual(await s3.appendLog(row), false);    // ログのリスト名がなければ、何もしない
  });

  const row = (data, title) => ({ id: '1', fields: { Title: title || '会社', Data: typeof data === 'string' ? data : JSON.stringify(data) } });
  const COMP = { company: 'サンプル商事株式会社', regNo: 'T0000000000000', bank: '見本銀行', offices: [{ name: '本社', zip: '000-0000', addr: 'サンプル県0-0-0', tel: '000-000-0000', fax: '000-000-0001' }, { name: '第二工場', zip: '111-1111', addr: '別の県1-1-1', tel: '111-111-1111', fax: '' }] };
  await t('会社の情報（見積アプリの SD_設定「会社」の行）：読み取りだけで読む。拠点が複数でもそのまま。ほかの行は無視', async () => {
    const g = fakeGraph({ company: [row({ x: 1 }, '別の設定'), row(COMP)] }), s = mk(g);   // connect しなくても読める
    const c = await s.loadCompany();
    assert.deepStrictEqual(c, COMP); assert.strictEqual(c.offices.length, 2);
    assert.deepStrictEqual(s.tokens, [false]);                                                  // 読み取り用の権限（write=false）
    assert.ok(g.calls.every(x => x.method === 'GET') && g.calls[0].companySite === ReceiptStore.COMPANY_SITE_ID);   // 見積アプリと同じサイト・読むだけ
    const m = R.mergeSettings(c, null); assert.ok(R.checkSettings(m).ok); assert.strictEqual(m.offices[1].name, '第二工場');
  });
  await t('会社の情報が読めない（リストなし・行なし・形が壊れている・配列・権限なし・ネットワーク）：null を返し、例外にしない', async () => {
    for (const [label, mode] of [['リストなし', {}], ['行なし', { company: [row(COMP, '別の設定')] }], ['行が空', { company: [] }], ['JSON が壊れている', { company: [row('{こわれた')] }],
      ['配列', { company: [row('[1,2]')] }], ['文字列', { company: [row('"abc"')] }], ['権限なし', { status: 403 }], ['ネットワーク', { network: true }]]) {
      const g = fakeGraph(mode), s = mk(g);
      assert.strictEqual(await s.loadCompany(), null, label);
    }
    const g = fakeGraph({ company: [row('')] });                                                 // Data が空の行は、空の設定（社名・住所なし＝足りない）
    const c = await mk(g).loadCompany(); assert.deepStrictEqual(c, {});
    assert.ok(!R.checkSettings(R.mergeSettings(c, null)).ok);
    assert.ok(!R.checkSettings(R.mergeSettings(null, null)).ok);
  });
  await t('会社の情報：サイト・リスト名は差し替えられる（見積アプリの設定を、別の場所で確かめたいとき）', async () => {
    const g = fakeGraph({ company: [row(COMP)] });
    const s = ReceiptStore.create({ R, getToken: async () => 't', fetchImpl: g.fetchImpl, sitePath: 'example.sharepoint.com:/sites/x:', listName: 'EC_Receipt', companySiteId: 'TESTSITE' });
    assert.deepStrictEqual(await s.loadCompany(), COMP); assert.strictEqual(g.calls[0].companySite, 'TESTSITE');
  });

  await t('EC.LOG_ACTIONS に、領収証の操作名が入っている（リストの選択肢・画面と同じ言葉）', async () => {
    for (const a of ['領収証発行', '領収証再発行', '領収証取消']) assert.ok(EC.LOG_ACTIONS.includes(a), a);
  });

  console.log('ok receipt_store: ' + n + ' tests');
})();
