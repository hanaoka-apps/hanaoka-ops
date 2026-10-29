// node tests/test_ec_sales_settings.cjs
// 対応表・設定の共有保存（SharedMasters の ec_sales_settings.json）。表示文・検証・差分・編集者・移行・ETag 競合。Graph は fetch を差し替えて真似る
const assert = require('assert');
const EC = require('../ec_sales_core.js');
const S = require('../ec_sales_settings.js');
const CONF = require('../ec_sales_config.json');
let n = 0;
async function t(name, fn) { try { await fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } }
const clone = x => JSON.parse(JSON.stringify(x));
const base = () => ({ mapping: clone(CONF.mapping), cfg: clone(CONF.config) });
const ITEMS = { FCARTDIN: { name: 'FLATCART DINING' }, TC: { name: 'テーブルコンテナ(グレー)' }, TCBK: { name: 'テーブルコンテナ(ブラック)' }, FR: { name: 'フレーム' } };

(async () => {
  await t('表示文：本体＋セット内・オプション（数量の単位）・色の差し替え・単品', () => {
    const set = base().mapping.rules.find(r => r.id === 'body-dinset-bk');
    const d = S.describeRule(set, ITEMS, 3);
    assert.strictEqual(d.scopeLabel, '本体');
    assert.deepStrictEqual(d.lines.map(l => l.role + ':' + l.code), ['本体:FCARTDIN', '＋セット内:TCBK']);
    assert.ok(/合計から計算/.test(d.lines[0].price) && /値引き/.test(d.lines[0].price));
    assert.strictEqual(d.lines[1].qty, '×2（注文の数量ごと）'); assert.strictEqual(d.lines[1].price, '標準単価 ¥7,000'); assert.strictEqual(d.lines[1].name, 'テーブルコンテナ(ブラック)');
    assert.strictEqual(d.lead, '既定 3営業日');
    const op = { id: 'o1', scope: 'option', label: 'コンテナ追加', words: ['テーブルコンテナ', 'TC'], match: 'contains', code: 'TC', qtyUnit: '個', net: 7000, leadDays: 5 };
    const o = S.describeRule(op, ITEMS, 3);
    assert.strictEqual(o.lines[0].qty, '×N（商品名の「N」個）'); assert.strictEqual(o.lead, '5営業日'); assert.strictEqual(o.words, '「テーブルコンテナ」、「TC」 のどれか を含む'.replace(' のどれか を', ' のどれかを'));
    const sw = S.describeRule({ id: 's1', scope: 'option', label: '黒', words: ['ブラック'], match: 'contains', swap: { from: 'TC', to: 'TCBK' } }, ITEMS, 3);
    assert.strictEqual(sw.lines[0].text, '色はオプションの文言で TC→TCBK');
    const sg = S.describeRule({ id: 'g1', scope: 'single', label: 'x', words: ['バッグ'], match: 'exact', code: 'NOPE', net: null }, ITEMS, 3);
    assert.deepStrictEqual(sg.missing, ['NOPE']); assert.ok(/ちょうど同じ/.test(sg.words) && !/どれか/.test(sg.words));
    assert.ok(/^詳細な指定（旧）：/.test(S.wordsText({ pattern: 'a.*b' })));
    assert.deepStrictEqual(S.describeRule(op, null, 3).missing, []);   // 品目マスタを読めていないときは赤にしない
  });

  await t('検証：言葉・コード・数値', () => {
    const ok = { scope: 'option', label: 'x', words: ['a'], match: 'contains', code: 'FR', net: 100 };
    assert.deepStrictEqual(S.validateRule(ok), []);
    assert.ok(S.validateRule(Object.assign({}, ok, { words: [] })).some(x => /言葉/.test(x)));
    assert.ok(S.validateRule(Object.assign({}, ok, { code: ' ' })).some(x => /品目コード/.test(x)));
    assert.ok(S.validateRule(Object.assign({}, ok, { net: 'abc' })).some(x => /標準単価/.test(x)));
    assert.ok(S.validateRule(Object.assign({}, ok, { net: -1 })).some(x => /標準単価/.test(x)));
    assert.ok(S.validateRule(Object.assign({}, ok, { leadDays: 1.5 })).some(x => /納期/.test(x)));
    assert.ok(S.validateRule(Object.assign({}, ok, { label: '' })).some(x => /名前/.test(x)));
    assert.ok(S.validateRule({ scope: 'body', label: 'b', words: ['a'], code: 'FR', includes: [{ code: '', qty: 0 }] }).length >= 2);
    assert.deepStrictEqual(S.validateRule({ scope: 'option', label: 's', words: ['a'], swap: { from: 'TC', to: 'TCBK' } }), []);   // 差し替えは品目コード不要
    const nr = S.normalizeRule({ scope: 'body', label: ' b ', words: [' a ', ''], code: ' FR ', net: '', leadDays: '', qtyUnit: '個', swap: { from: 'x', to: 'y' }, includes: [{ code: 'TC', qty: '2', net: '7000' }] });
    assert.deepStrictEqual(nr.words, ['a']); assert.strictEqual(nr.code, 'FR'); assert.strictEqual(nr.net, null); assert.ok(!('leadDays' in nr) && !('qtyUnit' in nr) && !('swap' in nr));
    assert.deepStrictEqual(nr.includes, [{ code: 'TC', qty: 2, net: 7000 }]);
  });

  await t('共有ファイルの形と読込：cfg は納期の2項目だけ、既定に重ねる', () => {
    const b = base(), f = S.fileOf(b.mapping, Object.assign(b.cfg, { cutoffTime: '14:00', closedDates: ['2026-12-31'] }), 'a@h.co.jp', '2026-10-29T01:00:00Z');
    assert.deepStrictEqual(Object.keys(f), ['version', 'updatedAt', 'updatedBy', 'mapping', 'cfg']);
    assert.deepStrictEqual(Object.keys(f.cfg), ['cutoffTime', 'closedDates']); assert.deepStrictEqual(Object.keys(f.mapping), ['rules', 'leadDays', 'leadOverrides']);
    assert.ok(!/customers|staff|defaultCustomer/.test(JSON.stringify(f)));
    const r = S.applyFile(base(), f);
    assert.strictEqual(r.cfg.cutoffTime, '14:00'); assert.deepStrictEqual(r.cfg.closedDates, ['2026-12-31']);
    assert.ok(r.cfg.customers && r.cfg.defaultCustomer);   // 業務設定は既定のまま
    assert.strictEqual(r.mapping.rules.length, f.mapping.rules.length);
    const same = S.applyFile(base(), null); assert.deepStrictEqual(same.mapping, base().mapping);   // ファイルが無ければ既定
    const withRe = base(); withRe.mapping.rules[0]._re = /x/; assert.ok(!JSON.stringify(S.fileOf(withRe.mapping, withRe.cfg, 'a', 'b')).includes('_re'));
  });

  await t('編集者の判定：管理者＋編集者、無くてもよい、大文字小文字を区別しない', () => {
    assert.strictEqual(S.canEdit('A@H.co.jp', { admins: ['a@h.co.jp'] }, null), true);
    assert.strictEqual(S.canEdit('b@h.co.jp', ['a@h.co.jp'], { editors: ['B@h.co.jp'] }), true);
    assert.strictEqual(S.canEdit('c@h.co.jp', { admins: ['a@h.co.jp'] }, { editors: ['b@h.co.jp'] }), false);
    assert.strictEqual(S.canEdit('', { admins: [''] }, null), false);
    assert.strictEqual(S.canEdit('a@h.co.jp', null, undefined), false);
  });

  await t('差分：編集・追加・削除・順番・設定', () => {
    const b = base(), a = base();
    assert.strictEqual(S.diffSettings(b, a).count, 0);
    a.mapping.rules[2].label = '名前を変えた'; a.mapping.rules[2].net = 123; a.mapping.rules[2].words = ['新1', '新2'];
    a.mapping.rules.push({ id: 'rnew', scope: 'option', label: '追加ルール', words: ['x'], match: 'contains', code: 'FR', net: 500 });
    const removed = a.mapping.rules.splice(5, 1)[0];
    a.mapping.leadDays = 4; a.cfg.cutoffTime = '14:30'; a.cfg.closedDates = ['2026-12-30'];
    const d = S.diffSettings(b, a);
    const edit = d.rules.find(x => x.type === 'edit');
    assert.deepStrictEqual(edit.fields.map(f => f.label), ['名前', '商品名の言葉', '標準単価（税抜）'].sort((x, y) => ['名前', '商品名の言葉', '標準単価（税抜）'].indexOf(x) - ['名前', '商品名の言葉', '標準単価（税抜）'].indexOf(y)));
    assert.strictEqual(edit.fields.find(f => f.label === '商品名の言葉').after, '新1、新2');
    assert.ok(d.rules.some(x => x.type === 'add' && x.label === '追加ルール')); assert.ok(d.rules.some(x => x.type === 'del' && x.label === removed.label));
    assert.deepStrictEqual(d.settings.map(x => x.label), ['既定の納期（営業日）', '締め時刻', '個別の休み']);
    assert.ok(d.summary.some(x => /^ルール「.*」を編集（/.test(x)) && d.summary.some(x => /設定の変更（締め時刻）/.test(x)));
    // 順番
    const m = base(), m2 = base(); [m2.mapping.rules[0], m2.mapping.rules[1]] = [m2.mapping.rules[1], m2.mapping.rules[0]];
    const mv = S.diffSettings(m, m2); assert.ok(mv.rules.length >= 1 && mv.rules.every(x => x.type === 'move')); assert.ok(/順番を変更/.test(mv.summary[0]));
    // ログ：要約だけ・長さの上限
    assert.ok(S.logDetail(d).length <= 250); assert.ok(!/@/.test(S.logDetail(d)));
    const big = { rules: [], settings: [], count: 1, summary: ['あ'.repeat(400)] }; assert.ok(S.logDetail(big).length <= 250);
  });

  await t('旧データの移行：この端末の対応表が既定と違うときだけ', () => {
    assert.strictEqual(S.migrationPlan(null, base()).needed, false);
    assert.strictEqual(S.migrationPlan({ mapping: base().mapping, cfg: { cutoffTime: base().cfg.cutoffTime } }, base()).needed, false);
    const lg = { mapping: base().mapping, cfg: { cutoffTime: '13:00', closedDates: ['2026-11-20'] } }; lg.mapping.rules[0].net = 999;
    const p = S.migrationPlan(lg, base()); assert.strictEqual(p.needed, true); assert.ok(p.diff.rules.length === 1 && p.diff.settings.length === 2);
  });

  await t('このルールで当たる最近の注文（新しい順・最大n件）／新規ルールも試せる', () => {
    const mk = (i, name, date) => ({ id: String(i), name: '#' + i, createdAt: date, lines: [{ name, qty: 1, price: 0 }] });
    const orders = [mk(1, 'FLATCART 2x4（ブラック）', '2026-10-01'), mk(2, 'キャスター', '2026-10-05'), mk(3, 'FLATCART 2x4（ブラック）', '2026-10-10')];
    const m = base().mapping, hit = m.rules.find(r => EC.mapLine({ name: 'FLATCART 2x4（ブラック）', qty: 1, price: 1 }, m, '2026-10-01').items.some(i => i.ruleId === r.id));
    const r = S.recentMatches(hit, orders, m, 5); assert.deepStrictEqual(r.map(x => x.orderName), ['#3', '#1']);
    assert.strictEqual(S.recentMatches(hit, orders, m, 1).length, 1);
    const draft = { id: 'draft', scope: 'single', label: 'キャスター', words: ['キャスター'], match: 'contains', code: 'FR', net: 1 };
    assert.deepStrictEqual(S.recentMatches(draft, orders, m, 5).map(x => x.orderName), ['#2']);
  });

  await t('検索：言葉・名前・品目コード（空白・全角半角を無視）', () => {
    const rules = base().mapping.rules;
    assert.strictEqual(S.searchRules(rules, '').length, rules.length);
    const i = S.searchRules(rules, 'ｔｃｂｋ'); assert.ok(i.length >= 1 && i.every(k => JSON.stringify(rules[k]).toLowerCase().includes('tcbk')));
    assert.strictEqual(S.searchRules(rules, '存在しない言葉zzz').length, 0);
  });

  // ---- Graph の真似（ドライブ上の1ファイル。ETag と If-Match を持つ）
  function fakeDrive(mode) {
    mode = mode || {};
    const files = {}; let ver = 1; const calls = [];
    const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body || '') });
    async function fetchImpl(url, o) {
      o = o || {}; const method = o.method || 'GET'; calls.push({ method, url, headers: o.headers, body: o.body });
      if (mode.network) throw new TypeError('fetch failed');
      if (mode.status) return resp(mode.status, {});
      const m = url.match(/\/drives\/D\/root:\/([^:?]+)(:\/content)?(\?.*)?$/); if (!m) return resp(400, {});
      const name = decodeURIComponent(m[1]), f = files[name];
      if (method === 'GET' && !m[2]) return f ? resp(200, { id: 'i', eTag: f.etag, lastModifiedDateTime: '2026-10-29T00:00:00Z' }) : resp(404, {});
      if (method === 'GET' && m[2]) { if (mode.bumpOnRead && f) { f.etag = '"v' + (++ver) + '"'; mode.bumpOnRead--; } return f ? resp(200, JSON.parse(f.body)) : resp(404, {}); }
      if (method === 'PUT') {
        const im = o.headers['If-Match'];
        if (im && (!f || f.etag !== im)) return resp(412, { error: 'precondition' });
        if (!im && /conflictBehavior=fail/.test(m[3] || '') && f) return resp(409, { error: 'exists' });
        files[name] = { body: o.body, etag: '"v' + (++ver) + '"' }; return resp(f ? 200 : 201, { eTag: files[name].etag });
      }
      return resp(405, {});
    }
    return { fetchImpl, files, calls };
  }
  const mkIo = (g, extra) => S.create(Object.assign({ getToken: async () => 'T', getWriteToken: async () => 'W', driveId: 'D', fileName: 'ec_sales_settings.json', fetchImpl: g.fetchImpl }, extra || {}));

  await t('共有の読み書き：無ければ null、新規作成、ETag つきの更新、書込はWriteトークン', async () => {
    const g = fakeDrive(), io = mkIo(g);
    assert.deepStrictEqual(await io.read(), { settings: null, etag: null, modified: '' });
    const f1 = S.fileOf(base().mapping, base().cfg, 'a@h.co.jp', '2026-10-29T00:00:00Z');
    const w1 = await io.write(f1, null); assert.ok(w1.etag);
    const r1 = await io.read(); assert.strictEqual(r1.etag, w1.etag); assert.strictEqual(r1.settings.updatedBy, 'a@h.co.jp');
    const f2 = clone(f1); f2.cfg.cutoffTime = '13:00';
    const w2 = await io.write(f2, r1.etag); assert.notStrictEqual(w2.etag, r1.etag);
    assert.strictEqual((await io.read()).settings.cfg.cutoffTime, '13:00');
    const put = g.calls.filter(c => c.method === 'PUT'); assert.ok(put.every(c => c.headers.Authorization === 'Bearer W'));
    assert.ok(g.calls.filter(c => c.method === 'GET').every(c => c.headers.Authorization === 'Bearer T'));
    assert.ok(/conflictBehavior=fail/.test(put[0].url) && put[1].headers['If-Match'] === r1.etag);
  });

  await t('競合：読んだあとに他の人が更新していたら上書きしない（412）／新規作成が同時なら409', async () => {
    const g = fakeDrive(), io = mkIo(g);
    const f = S.fileOf(base().mapping, base().cfg, 'a', 'x');
    await io.write(f, null);
    const mine = await io.read();
    await io.write(Object.assign(clone(f), { updatedBy: 'someone-else' }), mine.etag);   // 他の人が先に保存
    await assert.rejects(() => io.write(Object.assign(clone(f), { updatedBy: 'me' }), mine.etag), e => io.isConflict(e) && e.status === 412);
    assert.strictEqual((await io.read()).settings.updatedBy, 'someone-else');
    await assert.rejects(() => io.write(f, null), e => io.isConflict(e) && e.status === 409);   // 新規作成の競合
  });

  await t('読込中に他の人が保存したら読み直す／何度も変わるなら諦める', async () => {
    const g = fakeDrive({ bumpOnRead: 1 }), io = mkIo(g);
    await io.write(S.fileOf(base().mapping, base().cfg, 'a', 'x'), null);
    const r = await io.read(); assert.ok(r.etag);
    const g2 = fakeDrive({ bumpOnRead: 99 }), io2 = mkIo(g2);
    await io2.write(S.fileOf(base().mapping, base().cfg, 'a', 'x'), null);
    await assert.rejects(() => io2.read(), /落ち着きません/);
  });

  await t('接続できない（403・ネットワーク）／編集者の一覧は無くてもよい', async () => {
    const g403 = fakeDrive({ status: 403 }), io = mkIo(g403);
    await assert.rejects(() => io.read(), e => io.isUnavailable(e));
    await assert.rejects(() => mkIo(fakeDrive({ network: true })).read(), e => io.isUnavailable(e));
    const g = fakeDrive(); g.files['_rpa_queue/ec_settings_editors.json'] = { body: JSON.stringify({ editors: ['b@h.co.jp'] }), etag: '"e"' };
    const ok = mkIo(g);
    assert.deepStrictEqual(await ok.readJson('_rpa_queue/ec_settings_editors.json'), { editors: ['b@h.co.jp'] });
    assert.strictEqual(await ok.readJson('_rpa_queue/nothing.json'), null);
  });

  await t('明細の行ごとの差：セット内の追加・削除・変更、本体の品目コード変更', () => {
    const b = clone(base().mapping.rules.find(r => r.id === 'body-dinset-bk'));   // 本体 FCARTDIN ＋ セット内 TCBK×2(7000)
    const a = clone(b); a.includes = [{ code: 'TCBK', qty: 3, net: 7000 }, { code: 'FR', qty: 1, net: 500 }];
    let rows = S.lineDiff(b, a, ITEMS, 2);
    assert.deepStrictEqual(rows.map(r => r.status), ['same', 'chg', 'add']);
    assert.ok(/×3/.test(rows[1].after) && /×2/.test(rows[1].before) && /FR/.test(rows[2].after) && rows[2].before === '');
    const a2 = clone(b); a2.includes = [];
    rows = S.lineDiff(b, a2, ITEMS, 2); assert.deepStrictEqual(rows.map(r => r.status), ['same', 'del']);
    const a3 = clone(b); a3.code = 'FCARTXX'; rows = S.lineDiff(b, a3, ITEMS, 2);
    assert.deepStrictEqual(rows.map(r => r.status), ['chg', 'same']);   // 本体の品目コードを変えても、同じ「本体」の行の変更になる
    const a4 = clone(b); a4.includes = [{ code: 'TC', qty: 2, net: 7000 }]; rows = S.lineDiff(b, a4, ITEMS, 2);
    assert.deepStrictEqual(rows.map(r => r.status).sort(), ['add', 'del', 'same']);   // セット内の品目コードを変えたら、削除＋追加
    // 差分に行ごとの差が入る（追加・削除のルールも）
    const bb = base(), aa = base(); const i = aa.mapping.rules.findIndex(r => r.id === 'body-dinset-bk'); aa.mapping.rules[i].includes.push({ code: 'FR', qty: 1, net: 500 });
    aa.mapping.rules.push({ id: 'nr', scope: 'option', label: '新', words: ['x'], match: 'contains', code: 'FR', net: 1 });
    const d = S.diffSettings(bb, aa, ITEMS), e = d.rules.find(x => x.type === 'edit'), ad = d.rules.find(x => x.type === 'add');
    assert.ok(e.lines.some(l => l.status === 'add') && e.lines.some(l => l.status === 'same')); assert.ok(ad.lines.length === 1 && ad.lines[0].status === 'add');
    const dd = S.diffSettings(aa, bb, ITEMS); assert.ok(dd.rules.find(x => x.type === 'del').lines.every(l => l.status === 'del'));
  });

  await t('品目マスタの引き当て：名前・単位・手配区分、無ければ赤（found=false）、マスタ未読込なら赤にしない', () => {
    const items = { FR: { name: 'フレーム', unit: '台', teihai: '2' } };
    assert.deepStrictEqual(S.itemInfo(items, 'FR'), { found: true, name: 'フレーム', unit: '台', teihai: '2' });
    assert.strictEqual(S.itemInfo(items, 'NOPE').found, false); assert.strictEqual(S.itemInfo(null, 'NOPE').found, true); assert.strictEqual(S.itemInfo(items, '').found, true);
    const d = S.describeRule({ id: 'x', scope: 'body', label: 'b', words: ['a'], code: 'FR', includes: [{ code: 'NOPE', qty: 1, net: 1 }] }, items, 2);
    assert.deepStrictEqual(d.lines.map(l => [l.code, l.found, l.unit]), [['FR', true, '台'], ['NOPE', false, '']]); assert.deepStrictEqual(d.missing, ['NOPE']);
  });

  await t('数量：固定（1以上の整数）／言葉の中のN個。保存の形', () => {
    const op = { scope: 'option', label: 'x', words: ['a'], match: 'contains', code: 'FR' };
    assert.deepStrictEqual(S.validateRule(Object.assign({}, op, { qty: 2 })), []); assert.deepStrictEqual(S.validateRule(Object.assign({}, op, { qty: 'g1' })), []);
    assert.ok(S.validateRule(Object.assign({}, op, { qty: 0 })).some(x => /数量/.test(x))); assert.ok(S.validateRule(Object.assign({}, op, { qty: 1.5 })).some(x => /数量/.test(x)));
    assert.deepStrictEqual(S.validateRule(Object.assign({}, op, { qtyUnit: '個', qty: 0 })), []);   // 単位があれば固定の数量は使わない
    assert.strictEqual(S.normalizeRule(Object.assign({}, op, { qty: '3' })).qty, 3);
    assert.ok(!('qty' in S.normalizeRule(Object.assign({}, op, { qty: '3', qtyUnit: '個' }))));
    assert.ok(!('qty' in S.normalizeRule(Object.assign({}, op, { qty: '' }))));
    assert.strictEqual(S.normalizeRule(Object.assign({}, op, { qty: 'g1' })).qty, 'g1');
    assert.ok(/×N（商品名の「N」個）/.test(S.describeRule(Object.assign({}, op, { qtyUnit: '個' }), null, 2).lines[0].qty)); assert.strictEqual(S.describeRule(Object.assign({}, op, { qty: 2 }), null, 2).lines[0].qty, '×2');
  });

  await t('実際の注文での組み合わせ・よく一緒に付くオプション・関連ルール', () => {
    const m = base().mapping, mk = (i, name, date, q) => ({ id: String(i), name: '#' + i, createdAt: date, lines: [{ name, qty: q || 1, price: 0 }] });
    const orders = [mk(1, 'FLATCART 2x4（ブラック） - テーブルコンテナ(グレー)2個追加', '2026-10-01'), mk(2, 'FLATCART 2x4（ブラック） - テーブルコンテナ(グレー)2個追加', '2026-10-03'),
      mk(3, 'FLATCART 2x4（ブラック）', '2026-10-05'), mk(4, 'FLATCART 2x4（ブラック） - テーブルコンテナ(ブラック)1個追加', '2026-10-07', 2), mk(5, 'キャスター', '2026-10-08')];
    const body = m.rules.find(r => EC.mapLine({ name: 'FLATCART 2x4（ブラック）', qty: 1, price: 1 }, m, '2026-10-01').items.some(i => i.kind === 'body' && i.ruleId === r.id));
    const combos = S.comboStats(body, orders, m, 5);
    assert.deepStrictEqual(combos.map(c => [c.productName, c.count]), [['FLATCART 2x4（ブラック） - テーブルコンテナ(ブラック)1個追加', 1], ['FLATCART 2x4（ブラック）', 1], ['FLATCART 2x4（ブラック） - テーブルコンテナ(グレー)2個追加', 2]]);   // 新しい順
    assert.deepStrictEqual(combos[2].items.map(i => i.code + '×' + i.qty), ['FCART2x4BK×1', 'TC×2']);
    assert.deepStrictEqual(combos[0].items.map(i => i.code + '×' + i.qty), ['FCART2x4BK×1', 'TCBK×1']);   // 数量は注文の数量（2）で割って、1台あたりにする
    assert.strictEqual(S.comboStats(body, orders, m, 2).length, 2);
    const st = S.optionStats(orders, m), top = S.topOptions(st, body.id, m.rules, 3);
    assert.deepStrictEqual(top.map(x => x.count), [2, 1]); assert.ok(/グレー/.test(top[0].label) && /ブラック/.test(top[1].label));
    assert.deepStrictEqual(S.topOptions(st, 'nothing', m.rules, 3), []);
    // swap の関連ルール：セット内の TC／TCBK を持つ本体 ↔ 色の差し替えルール
    const sw = { id: 'sw', scope: 'option', label: '黒に', words: ['ブラック'], match: 'contains', swap: { from: 'TC', to: 'TCBK' } };
    const rules = m.rules.concat([sw]), set = rules.find(r => r.id === 'body-dinset');
    const rel = S.relatedRules(sw, rules); assert.ok(rel.length >= 2 && rel.every(r => r.scopeLabel === '本体')); assert.ok(rel.some(r => r.id === 'body-dinset'));
    const rel2 = S.relatedRules(set, rules); assert.deepStrictEqual(rel2.map(r => r.id), ['opt-swap-bk', 'sw']); assert.ok(rel2.every(r => r.swap));
    assert.deepStrictEqual(S.relatedRules(rules.find(r => r.id === 'opt-tc'), rules), []);
  });

  console.log('ec_sales_settings: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
})();
