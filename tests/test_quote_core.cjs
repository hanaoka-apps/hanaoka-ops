// 見積・受注（quote_core.js）の確かめ
//   node tests/test_quote_core.cjs
// 実データ（価格・得意先）はリポジトリに置けないので、形だけ同じ見本データで確かめる。
const path = require('path');
const assert = require('node:assert/strict');
const Q = require(path.join(__dirname, '../quote_core.js'));

const data = {
  prices: [
    { 型式: 'UDL250', 品名: '見本リフト', 定価: 120000, 適用開始日: '2026-01-01', 商品の種類: '台車以外', 運賃の重量kg: 60 },
    { 型式: 'UDL250', 品名: '見本リフト', 定価: 132000, 適用開始日: '2026-11-01', 商品の種類: '台車以外', 運賃の重量kg: 60 },
    { 型式: 'UDL25', 品名: '', 定価: null, 適用開始日: '2026-01-01', 商品の種類: '台車以外', 運賃の重量kg: 60 }, // 重さだけの行
    { 型式: 'T1', 品名: '見本台車', 定価: 30000, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: 40 },
    { 型式: 'PB', 品名: '見本部品', 定価: 2000, 適用開始日: '2026-01-01', 商品の種類: '部品', 運賃の重量kg: 1 },
  ],
  classes: [
    { 対象の種類: '社名', 対象コード: 'G3', 対象名: '丙フォーク', 計算方式: '本部経由', 適用開始日: '2026-01-01' },
  ],
  exceptions: [],
  fares: [
    { 種類: '地域', 地域: '南関東', 県: '埼玉 千葉 東京 神奈川', 運送会社: '西濃運輸' },
    ...[[10, 1700], [20, 1800], [40, 2300], [125, 3900], [250, 5800]].map(([kg, yen]) => ({ 種類: '路線便', 地域: '南関東', 上限: kg, 金額: yen, 適用開始日: '2025-11-12' })),
  ],
  costs: [{ 型式: 'UDL250', 原価: 50000, 適用開始日: '2026-01-01' }],
  assembly: [],
};
// 品目マスタ：品目コード UDL25 の価格表記載名が UDL250
const items = { UDL25: { name: 'リフト UDL-250', kakaku: 'UDL250' }, T1: { name: '見本台車', kakaku: '' } };
const env = { items, index: Q.buildIndex(data.prices) };
const B = { code: 'C1', name: '見本商事 東京', fullName: '見本商事 東京支店', shaCode: 'G9', shaName: '見本商事', kakeName: '5.75掛(B)' };
const doc = (over) => Object.assign(Q.blank('quote', '2026-11-14', '見本 太郎'), { cust: B, dest: { name: '', pref: '埼玉県', personal: false } }, over);

// --- 品目コードの読み替え ---
assert.deepEqual(Q.resolveCode('UDL25', items, env.index), { code: 'UDL250', via: '価格表記載名' }); // 価格表記載名で定価のある型式へ
assert.equal(Q.resolveCode('udl-250', items, env.index).code, 'UDL250'); // 書き方違いはそろえる
assert.equal(Q.resolveCode('ZZZ', items, env.index).code, '');
assert.equal(Q.resolveCode('', items, env.index).code, '');

// --- ふつうの見積：単価・送料・合計・利益率・決め手 ---
let c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }] }), env);
assert.equal(c.lines[0].listCode, 'UDL250');
assert.equal(c.lines[0].unit, 75900); // 132000×0.575
assert.equal(c.lines[0].amount, 151800);
assert.equal(c.lines[0].base.why, '定価 132,000 × Bランク 5.75掛');
assert.equal(c.lines[0].changed, false);
assert.equal(c.fare.amount, 3900); // 60kg×2＝120kg → 125kg の帯
assert.equal(c.fare.carrier, '西濃運輸');
assert.deepEqual(c.totals, { subtotal: 151800, fare: 3900, beforeTax: 155700, tax: 15570, total: 171270 });
assert.ok(Math.abs(c.margin.rate - (151800 - 100000) / 151800) < 1e-9);
assert.ok(!c.checks.some(x => x.level === 'warn'));

// --- 単価を変える：金額で／掛け率で。理由がないと「確認すること」に出る ---
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2, ov: { price: 70000 } }] }), env);
assert.equal(c.lines[0].unit, 70000);
assert.equal(c.lines[0].changed, true);
assert.equal(c.lines[0].base.price, 75900); // 基本の単価は残る
assert.ok(c.checks.some(x => x.level === 'warn' && /理由/.test(x.text)));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2, ov: { k: 0.55, reason: '数量' } }] }), env);
assert.equal(c.lines[0].unit, 72600); // 132000×0.55
assert.ok(!c.checks.some(x => x.level === 'warn'));
assert.ok(c.checks.some(x => x.level === 'info' && /数量/.test(x.text)));
// 基本と同じ金額を入れたら「変えた」にしない
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 1, ov: { price: 75900 } }] }), env);
assert.equal(c.lines[0].changed, false);

// --- 定価は見積日で選ぶ（出荷の予定日では選ばない） ---
c = Q.compute(data, doc({ date: '2026-10-20', lines: [{ code: 'UDL250', qty: 1 }] }), env);
assert.equal(c.priceDate, '2026-10-20');
assert.equal(c.lines[0].unit, 69000); // 改定前の定価 120000×0.575
assert.ok(c.checks.some(x => /2026-11-01 に定価が変わります/.test(x.text)));
c = Q.compute(data, doc({ date: '2026-10-20', shipDate: '2026-11-10', lines: [{ code: 'UDL250', qty: 1 }] }), env);
assert.equal(c.priceDate, '2026-10-20');
assert.equal(c.lines[0].unit, 69000); // 出荷が改定日より後でも、見積日の定価
c = Q.compute(data, doc({ date: '2026-11-10', lines: [{ code: 'UDL250', qty: 1 }] }), env);
assert.equal(c.lines[0].unit, 75900); // 見積日が改定日より後 → 新しい定価
assert.ok(c.checks.some(x => /2026-11-01 に定価が変わりました/.test(x.text))); // 改定してすぐは知らせる
assert.ok(Q.REASONS.includes('価格改定前の見積'));

// --- 候補にない品：手入力の行 ---
c = Q.compute(data, doc({ lines: [{ manual: true, name: '特注の台', price: 5000, qty: 3 }] }), env);
assert.equal(c.lines[0].amount, 15000);
assert.equal(c.lines[0].base, null);
c = Q.compute(data, doc({ lines: [{ code: 'ZZZ', qty: 1 }] }), env);
assert.equal(c.lines[0].unit, null);
assert.ok(c.checks.some(x => x.level === 'warn' && /単価が入っていません/.test(x.text)));
c = Q.compute(data, doc({ lines: [{ code: 'ZZZ', qty: 2, price: 1000 }] }), env);
assert.equal(c.lines[0].amount, 2000);

// --- 枝番つき（/C・/T など）は、元の型式の定価で計算しない。元の型式の単価は参考、送料の重さは元の型式 ---
const items2 = Object.assign({}, items, { 'UDL25/C': { name: 'リフト UDL-250 キャスター変更', kakaku: 'UDL250' } });
const env2 = { items: items2, index: env.index };
assert.ok(Q.isVariant('UDL25/C') && Q.isVariant('RIDE/T') && Q.isVariant('SUS25/TEL'));
assert.ok(!Q.isVariant('OP/JB') && !Q.isVariant('P/0000000217') && !Q.isVariant('UDL25'));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25/C', qty: 1 }] }), env2);
assert.equal(c.lines[0].unit, null);
assert.equal(c.lines[0].variantOf, 'UDL250');
assert.equal(c.lines[0].refPrice, 75900);
assert.equal(c.lines[0].base, null);
assert.equal(c.fare.amount, 3900); // 元の型式の重さ 60kg
assert.ok(c.checks.some(x => x.level === 'warn' && /UDL25\/C の単価が入っていません/.test(x.text)));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25/C', qty: 2, price: 80000 }] }), env2);
assert.equal(c.lines[0].amount, 160000);
assert.equal(c.lines[0].changed, false);

// --- 送料の重さ：定価は読み替えた型式の行、重さは入れた品目コードの行、と分かれているとき ---
const data3 = Object.assign({}, data, { prices: data.prices.concat([
  { 型式: 'T2', 品名: '見本台車2', 定価: 20000, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: null }, // 定価だけ（重さなし）
  { 型式: 'T2S', 品名: '', 定価: null, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: 30 },           // 重さだけ
]) });
const env3 = { items: Object.assign({}, items, { T2S: { name: '見本台車2', kakaku: 'T2' } }), index: Q.buildIndex(data3.prices) };
c = Q.compute(data3, doc({ lines: [{ code: 'T2S', qty: 1 }] }), env3);
assert.equal(c.lines[0].unit, 11500); // T2 の定価 20000×0.575
assert.equal(c.fare.amount, 2300);    // T2S の重さ 30kg → 40kg の帯
assert.ok(!c.checks.some(x => /重さがわからない/.test(x.text)));
// 価格表の型式（T2）で入れても、同じ価格表記載名を持つ品目コード（T2S）の重さを使う
c = Q.compute(data3, doc({ lines: [{ code: 'T2', qty: 1 }] }), { items: env3.items, index: env3.index });
assert.equal(c.lines[0].unit, 11500);
assert.equal(c.fare.amount, 2300);

// --- 新しい取引先（ランクなし）：ルールでは決まらないので、入れた単価になる ---
c = Q.compute(data, doc({ cust: { name: '新しいお客さま', isNew: true }, lines: [{ code: 'T1', qty: 1, price: 24000 }] }), env);
assert.equal(c.lines[0].unit, 24000);
assert.equal(c.lines[0].changed, false);
assert.ok(c.checks.some(x => /新しい取引先/.test(x.text)));

// --- 本部経由：見積は販社への単価、受注伝票は本部からの受注単価 ---
const H = { code: 'C3', name: '丙フォーク 東京', shaCode: 'G3', shaName: '丙フォーク', kakeName: 'その他' };
c = Q.compute(data, doc({ cust: H, lines: [{ code: 'T1', qty: 1 }] }), env);
assert.equal(c.lines[0].unit, 17000); // 30000×0.525＝15750→15800、÷0.93 を100円単位で切り上げ
assert.equal(c.fare.amount, 2480);    // 40kg 2300 ÷0.93 を10円単位で切り上げ
c = Q.compute(data, doc({ kind: 'order', cust: H, lines: [{ code: 'T1', qty: 1 }] }), env);
assert.equal(c.lines[0].unit, 15810); // 17000×0.93
assert.equal(c.fare.amount, 2306);    // 2480×0.93

// --- 送料を手で決める ---
c = Q.compute(data, doc({ lines: [{ code: 'T1', qty: 1 }], fareManual: 0 }), env);
assert.equal(c.fare.amount, 0);
assert.equal(c.fare.changed, true);
assert.equal(c.totals.fare, 0);

// --- 見積書に載せる行 ---
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2, note: '特価' }] }), env);
let rows = Q.sheetRows(doc({ lines: [{ code: 'UDL25', qty: 2, note: '特価' }] }), c);
assert.equal(rows.length, 2);
assert.equal(rows[0].list, null); // 定価は「載せる」にしたときだけ
assert.equal(rows[1].name, '送料（埼玉県送り）');
assert.equal(rows[1].amount, 3900);
rows = Q.sheetRows(doc({ showList: true }), c);
assert.equal(rows[0].list, 132000);

// --- 番号 ---
assert.equal(Q.nextNumber('quote', '2026-11-14', ['Q261114-001', 'Q261114-007', 'Q261113-009', 'J261114-002']), 'Q261114-008');
assert.equal(Q.nextNumber('order', '2026-11-14', ['Q261114-001', 'J261114-002']), 'J261114-003');
assert.equal(Q.nextNumber('quote', '2026/11/14', []), 'Q261114-001');

// --- 保存する形：出したときの金額と決め手が残る ---
const d1 = doc({ no: 'Q261114-001', title: '見本の件', lines: [{ code: 'UDL25', qty: 2, ov: { price: 70000, reason: '競合', memo: '他社と比べて' } }] });
const rec = Q.toRecord(d1, Q.compute(data, d1, env), '見本 太郎', '2026-11-14T10:00:00');
assert.equal(rec.fields.Title, 'Q261114-001');
assert.equal(rec.fields.Kind, '見積');
assert.equal(rec.fields.CustomerCode, 'C1');
assert.equal(rec.fields.Total, Math.floor((140000 + 3900) * 1.1 + 1e-9));
const saved = JSON.parse(rec.fields.Data);
assert.equal(saved.snap.lines[0].basePrice, 75900);
assert.equal(saved.snap.lines[0].unit, 70000);
assert.equal(saved.snap.lines[0].reason, '競合');
assert.equal(saved.snap.lines[0].baseWhy, '定価 132,000 × Bランク 5.75掛');

// --- 複製 ---
const d2 = Q.duplicate(saved, '2026-12-01', '見本 花子');
assert.equal(d2.no, '');
assert.equal(d2.status, '下書き');
assert.equal(d2.date, '2026-12-01');
assert.equal(d2.copiedFrom, 'Q261114-001');
assert.equal(d2.snap, undefined);
assert.equal(d2.lines[0].ov.price, 70000);

// --- 探す ---
const list = [{ key: Q.norm('C1 見本商事 東京支店'), head: 'C1', id: 1 }, { key: Q.norm('C10 見本物産'), head: 'C10', id: 2 }, { key: Q.norm('D5 べつの会社'), head: 'D5', id: 3 }];
assert.deepEqual(Q.search(list, 'c1', 8).map(x => x.id), [1, 2]);
assert.deepEqual(Q.search(list, '見本　東京', 8).map(x => x.id), [1]);
assert.deepEqual(Q.search(list, '', 8), []);

// --- 送料の重さ：定価の行はハイフンつき（T-2）、重さの行はハイフンなし（T2）でも、同じ型式として重さを使う ---
{
  const d2 = Object.assign({}, data, { prices: data.prices.concat([
    { 型式: 'T-2', 品名: '見本台車2', 定価: 40000, 適用開始日: '2026-01-01', 商品の種類: '台車' },
    { 型式: 'T2', 品名: '', 定価: null, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: 60 },
  ]) });
  const e2 = { items, index: Q.buildIndex(d2.prices) };
  const base = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }] }), env);
  for (const code of ['T-2', 'T2', 't-2']) {
    const r = Q.compute(d2, doc({ lines: [{ code, qty: 2 }] }), e2);
    assert.equal(r.lines[0].listCode, 'T-2');
    assert.equal(r.fare.kg, 120);
    assert.equal(r.fare.amount, base.fare.amount); // 60kg×2 で同じ送料
  }
}

// --- 変えたときの2択：「アプリの計算が違う」は理由として残り、保存する形にも入る ---
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 1, ov: { price: 70000, reason: Q.WRONG, memo: '見本の決まり' } }] }), env);
assert.equal(c.lines[0].wrong, true);
assert.ok(!c.checks.some(x => x.level === 'warn'));
assert.ok(c.checks.some(x => /アプリの計算が違う/.test(x.text)));
assert.equal(Q.toRecord(doc({}), c, '見本 太郎', '').data.snap.lines[0].wrong, true);
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 1, ov: { price: 70000, reason: '数量' } }] }), env);
assert.equal(c.lines[0].wrong, false);
// 送料も同じ：変えたら理由を選ぶ
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }], fareManual: 0 }), env);
assert.ok(c.checks.some(x => x.level === 'warn' && /送料を変えた理由/.test(x.text)));
// 「アプリの計算が違う」は、正しい決め方をひとこと書くまで確認に残る
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 1, ov: { price: 70000, reason: Q.WRONG } }] }), env);
assert.ok(c.checks.some(x => x.level === 'warn' && /ひとこと/.test(x.text)));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }], fareManual: 0, fareReason: Q.WRONG }), env);
assert.ok(c.checks.some(x => x.level === 'warn' && /送料：正しくは/.test(x.text)));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }], fareManual: 0, fareReason: Q.WRONG, fareMemo: '見本の決まり' }), env);
assert.equal(c.fare.wrong, true);
assert.ok(!c.checks.some(x => x.level === 'warn'));
c = Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }], fareReason: Q.WRONG }), env); // 変えていなければ理由は残さない
assert.equal(c.fare.reason, '');

// --- 計算のしくみ：6つの段と、その組み合わせでの働き ---
{
  let f = Q.flow(data, null);
  assert.deepEqual(f.map(s => s.key), ['price', 'rank', 'cls', 'exc', 'round', 'fare']);
  assert.ok(f.every(s => s.state === '' && s.result.length === 0));
  f = Q.flow(data, Q.compute(data, doc({ lines: [{ code: 'UDL25', qty: 2 }] }), env));
  const by = {}; f.forEach(s => by[s.key] = s);
  assert.equal(by.price.state, 'used');
  assert.ok(by.price.result.some(t => /UDL250 と読み替え/.test(t)));
  assert.ok(by.price.result.some(t => /定価 132,000/.test(t)));
  assert.equal(by.rank.state, 'used'); // ランクで決まった
  assert.equal(by.cls.state, 'skip');
  assert.equal(by.exc.state, 'skip');
  assert.ok(by.round.result.some(t => /75,900/.test(t)));
  assert.equal(by.fare.state, 'used');
  // 定価リストにない型式
  f = Q.flow(data, Q.compute(data, doc({ lines: [{ code: 'ZZZ', qty: 1 }] }), env));
  assert.equal(f[0].state, 'skip');
  assert.ok(/定価リストにない/.test(f[0].result[0]));
}

// --- 見積書を出すまで あと○項目 ---
{
  const td = d => Q.todo(d, Q.compute(data, d, env));
  let d = Object.assign(Q.blank('quote', '2026-11-14', '見本 太郎'), {});
  let t = td(d);
  assert.deepEqual(t.items.map(x => x.key), ['cust', 'lines', 'price', 'pref']); // 決まった4つ
  assert.equal(t.left, 4);
  d = doc({ lines: [{ code: 'UDL25', qty: 2 }] });
  t = td(d);
  assert.equal(t.left, 0);
  assert.ok(t.notes.length === Q.compute(data, d, env).checks.filter(x => x.level !== 'warn').length); // 知っておくことは数に入れない
  // 数量がない行は、その行の番号を返す
  t = td(doc({ lines: [{ code: 'UDL25', qty: 2 }, { code: 'T1', qty: null }] }));
  assert.deepEqual(t.items.filter(x => !x.done).map(x => [x.key, x.line]), [['lines', 1]]);
  // 変えたときだけ「変えた理由」が出る。選ぶまで残る
  t = td(doc({ lines: [{ code: 'UDL25', qty: 2, ov: { price: 70000 } }] }));
  assert.deepEqual(t.items.filter(x => !x.done).map(x => [x.key, x.line]), [['reason', 0]]);
  t = td(doc({ lines: [{ code: 'UDL25', qty: 2, ov: { price: 70000, reason: '数量' } }] }));
  assert.equal(t.items.length, 5); assert.equal(t.left, 0);
  t = td(doc({ lines: [{ code: 'UDL25', qty: 2 }], fareManual: 0 }));
  assert.deepEqual(t.items.filter(x => !x.done).map(x => x.key), ['fareReason']);
  // 送料を手で入れたら、県がなくても「届け先の県」は済み
  t = td(doc({ dest: { name: '', pref: '', personal: false }, lines: [{ code: 'UDL25', qty: 2 }], fareManual: 0, fareReason: Q.ONCE }));
  assert.equal(t.left, 0);
}

// --- 前回の受注単価 ---
{
  const h = Q.historyNew();
  Q.historyPush(h, { date: '2026-08-01', cust: 'C1', sha: 'G9', code: 'UDL25', qty: 1, unit: 74000 });
  Q.historyPush(h, { date: '2026-09-10', cust: 'C1', sha: 'G9', code: 'UDL25', qty: 2, unit: 72000 }); // 新しいほうが残る
  Q.historyPush(h, { date: '2026-07-01', cust: 'C1', sha: 'G9', code: 'UDL25', qty: 2, unit: 70000 }); // 古いものは上書きしない
  Q.historyPush(h, { date: '2026-10-01', cust: 'C1', sha: 'G9', code: 'FR', qty: 1, unit: 3900 });     // 運賃
  Q.historyPush(h, { date: '2026-10-02', cust: 'C1', sha: 'G9', code: 'UDL25', qty: 1, unit: 0 });     // 0円（サンプル）
  Q.historyPush(h, { date: '2026-10-03', cust: 'C1', sha: 'G9', code: 'UDL25', qty: 1, unit: 60000, ret: true }); // 返品
  Q.historyPush(h, { date: '2026-09-20', cust: 'C2', sha: 'G9', code: 'T-1', qty: 1, unit: 16000 });   // 同じ社名の別の支店
  assert.deepEqual(Q.prevOf(h, B, ['UDL25']), { unit: 72000, date: '2026-09-10', from: 'cust' });
  assert.deepEqual(Q.prevOf(h, B, ['T1']), { unit: 16000, date: '2026-09-20', from: 'sha' }); // 書き方違いはそろえる・社名で探す
  assert.equal(Q.prevOf(h, B, ['ZZZ']), null);
  assert.equal(Q.prevOf(h, null, ['UDL25']), null);
  const e3 = { items, index: env.index, history: h };
  // 型式（UDL250）で入れても、品目コード（UDL25）の前回が出る。単価は変えない
  let r = Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 1 }] }), e3);
  assert.equal(r.lines[0].prev.unit, 72000);
  assert.equal(r.lines[0].unit, 75900);
  assert.equal(r.lines[0].changed, false);
  assert.equal(Q.toRecord(doc({}), r, '', '').data.snap.lines[0].prev, 72000);
  // 前回がなければ何も出ない
  r = Q.compute(data, doc({ lines: [{ code: 'PB', qty: 1 }] }), e3);
  assert.equal(r.lines[0].prev, null);
  r = Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 1 }] }), env);
  assert.equal(r.lines[0].prev, undefined);
}

// --- 在庫価格にする（営業の指示）と、この型式のほかの決まり ---
{
  const d3 = Object.assign({}, data, {
    classes: data.classes.concat([{ 対象の種類: '社名', 対象コード: 'G9', 対象名: '見本商事', 在庫口の掛率: 0.45, 適用開始日: '2026-01-01' }]),
    exceptions: [
      { 型式: 'UDL250', 対象の種類: '全部', 台数以上: 10, 金額: 60000, 適用開始日: '2026-01-01' },
      { 型式: 'UDL250', 対象の種類: '得意先', 対象コード: 'C9', 対象名: 'べつの会社', 掛率: 0.5, 適用開始日: '2026-01-01', メモ: '見本のメモ' },
      { 型式: 'UDL250', 対象の種類: '得意先', 対象コード: 'C8', 対象名: '終わった決まり', 掛率: 0.4, 適用開始日: '2026-01-01', 適用終了日: '2026-06-30' },
    ],
  });
  let r = Q.compute(d3, doc({ lines: [{ code: 'UDL250', qty: 1 }] }), env);
  assert.equal(r.lines[0].unit, 75900);
  assert.equal(r.lines[0].stockPrice, 59400); // 132000×0.45。見せるだけで、単価は変えない
  assert.deepEqual(r.lines[0].others.map(o => [o.price, o.text]), [[60000, '全員・10台以上：決まった金額'], [66000, 'べつの会社：5掛']]); // 終わった決まりは出さない
  assert.equal(r.lines[0].others[1].memo, '見本のメモ');
  r = Q.compute(d3, doc({ lines: [{ code: 'UDL250', qty: 1, stock: true }] }), env);
  assert.equal(r.lines[0].unit, 59400);
  assert.equal(r.lines[0].stock, true);
  assert.equal(r.lines[0].changed, false); // ルールどおりなので「変えた」にはしない
  assert.equal(r.lines[0].stockPrice, undefined);
  assert.equal(Q.toRecord(doc({}), r, '', '').data.snap.lines[0].stock, true);
  // 10台以上なら例外が使われ、ほかの決まりからは外れる
  r = Q.compute(d3, doc({ lines: [{ code: 'UDL250', qty: 10 }] }), env);
  assert.equal(r.lines[0].unit, 60000);
  assert.deepEqual(r.lines[0].others.map(o => o.price), [66000]);
  // 決まりがなければ何も出ない
  r = Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 1 }] }), env);
  assert.equal(r.lines[0].stockPrice, undefined);
  assert.deepEqual(r.lines[0].others, []);
}

// --- 受注伝票：受注明細から覚えるもの（担当者・部門・納品先・倉庫）と、SMILE に入る並び ---
{
  const h = Q.historyNew();
  const push = (o) => Q.historyPush(h, Object.assign({ cust: 'C1', sha: 'G9', qty: 1, unit: 70000, unitName: '台', tehai: '繰返(製作)' }, o));
  push({ date: '2026-08-01', code: 'UDL25', staff: 'S1', staffName: '見本 一郎', dept: 'B1', deptName: '見本部', dest: 'N1', destName: '見本倉庫', wh: 'W1', whName: '見本工場第一' });
  push({ date: '2026-09-01', code: 'UDL25', staff: 'S2', staffName: '見本 二郎', dept: 'B2', deptName: '見本二部', dest: 'N1', destName: '見本倉庫（新）', wh: 'W1', whName: '見本工場第一' });
  push({ date: '2026-07-01', code: 'UDL25', staff: 'S0', staffName: '古い人', dept: 'B0', deptName: '古い部', dest: 'N2', destName: '見本現場', wh: 'W2', whName: '見本工場第二' });
  push({ date: '2026-09-02', code: 'UDL25', unit: 0, wh: 'W1', whName: '見本工場第一' }); // 0円でも倉庫は覚える
  Q.historyDone(h);
  assert.deepEqual(h.k.C1.st, ['S2', '見本 二郎']); // いちばん新しい担当者
  assert.deepEqual(h.k.C1.dp, ['B2', '見本二部']);
  assert.deepEqual(h.k.C1.ds, [['N1', '見本倉庫（新）', 2], ['N2', '見本現場', 1]]); // 多い順・名前は新しいもの
  assert.deepEqual(h.i.UDL25.wh, ['W1', '見本工場第一']); // いちばん多い倉庫
  assert.equal(h.c['C1|UDL25'][0], 70000); // 前回の単価は 0円を入れない
  const e4 = { items, index: env.index, history: h };
  const od = Q.toOrder(doc({ no: 'Q261114-001', date: '2026-10-20', lines: [{ code: 'UDL250', qty: 2 }] }), '2026-11-16', '見本 太郎');
  assert.equal(od.kind, 'order');
  assert.equal(od.quoteNo, 'Q261114-001');
  assert.equal(od.priceDate, '2026-10-20');
  let r = Q.compute(data, od, e4);
  assert.equal(r.priceDate, '2026-10-20');
  assert.equal(r.lines[0].unit, 69000); // 見積の日の定価（改定前）を引き継ぐ
  const o = r.order;
  assert.equal(o.rows[0].code, 'UDL25'); // 型式 UDL250 → SMILE の品目コード UDL25（価格表記載名）
  assert.equal(o.rows[0].wh, 'W1');
  assert.equal(o.rows[0].tehai, '繰返(製作)');
  assert.equal(o.rows[1].code, 'FR'); // 送料の行
  assert.equal(o.rows[1].price, r.fare.amount);
  assert.equal(o.head.staff, 'S2');
  assert.equal(o.head.date, '2026-11-16');
  // 前の受注3行のうち2行が N1（半分以上）なので、いつもの納品先 N1 を最初から入れる
  assert.equal(h.k.C1.dn, 3);
  assert.deepEqual([o.head.dest, o.head.destName, o.head.destAuto], ['N1', '見本倉庫（新）', true]);
  let t = Q.todo(od, r);
  assert.deepEqual(t.items.filter(x => !x.done).map(x => x.key), ['ship']);
  // 毎回ちがう先へ送る取引先（半分に届かない）・前の受注が1行だけ は入れない
  assert.equal(Q.sameDestOf({ ds: [['N1', '', 2], ['N2', '', 2], ['N3', '', 1]], dn: 5 }), null);
  assert.equal(Q.sameDestOf({ ds: [['N1', '', 1]], dn: 1 }), null);
  assert.deepEqual(Q.sameDestOf({ ds: [['N1', '', 2], ['N2', '', 2]] }), ['N1', '', 2]); // 合計がない古い覚え方でも動く（ちょうど半分は入れる）
  assert.equal(Q.sameDestOf(null), null);
  od.order.dest = 'N1'; od.shipDate = '2026-11-20';
  r = Q.compute(data, od, e4);
  assert.equal(Q.todo(od, r).left, 0);
  assert.equal(r.order.rows[0].due, '2026-11-20');
  // 新しい納品先は、名前を書くまで済まない
  od.order.dest = 'new'; r = Q.compute(data, od, e4);
  assert.ok(Q.todo(od, r).items.some(x => x.key === 'dest' && !x.done));
  od.order.destName = '見本の新しい現場'; od.order.nd = { addr: '埼玉県見本市1-1', tel: '000-0000-0000' }; r = Q.compute(data, od, e4); // 名前・住所・電話がそろうと済む
  assert.ok(Q.todo(od, r).items.every(x => x.done));
  // 雑コード・キャスター変更・拠点の倉庫は、知っておくこと（数には入れない）に案内を出す
  assert.equal(Q.isZatsu('P/1'), true); assert.equal(Q.isZatsu('P/PD'), true); assert.equal(Q.isZatsu('P/0000000217'), false); assert.equal(Q.isZatsu('UDL25'), false);
  assert.deepEqual(Q.prodWhOf('000001'), ['000010', '本社生産依頼倉庫']); assert.equal(Q.prodWhOf('000105'), null);
  const od3 = Object.assign(Q.blank('order', '2026-11-16', ''), { cust: B, shipDate: '2026-11-20', dest: { name: '', pref: '埼玉県', personal: false }, order: { dest: 'N1', destName: 'x' },
    lines: [{ code: 'UDL25', qty: 1, smile: 'P/1', wh: '000001' }, { code: 'UDL25', qty: 1, smile: 'UDL25/C', wh: 'W1' }] });
  r = Q.compute(data, od3, e4); t = Q.todo(od3, r);
  assert.equal(t.left, 0);
  assert.ok(t.notes.some(n => /雑コード（P\/1）/.test(n)));
  assert.ok(t.notes.some(n => /キャスター変更/.test(n)));
  assert.ok(t.notes.some(n => /000010 本社生産依頼倉庫/.test(n)));
  // 「ここが違う」：アプリの計算が違う、と記録した単価・送料
  const od4 = doc({ lines: [{ code: 'UDL250', qty: 1, ov: { price: 60000, reason: Q.WRONG, memo: 'この取引先は5掛' } }], fareManual: 0, fareReason: Q.WRONG, fareMemo: '送料はいただかない' });
  const w4 = Q.wrongsOf(od4, Q.compute(data, od4, env));
  assert.deepEqual(w4.map(w => [w.where, w.set, w.memo]), [['単価', 60000, 'この取引先は5掛'], ['送料', 0, '送料はいただかない']]);
  assert.ok(w4[0].app > 0 && w4[1].app > 0);
  assert.deepEqual(Q.wrongsOf(doc({ lines: [{ code: 'UDL250', qty: 1, ov: { price: 60000, reason: Q.ONCE } }] }), Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 1, ov: { price: 60000, reason: Q.ONCE } }] }), env)), []); // 今回だけ特別は入らない
  // 品目コードが決まらない行・倉庫が決まらない行
  const od2 = Object.assign(Q.blank('order', '2026-11-16', ''), { cust: B, shipDate: '2026-11-20', dest: { name: '', pref: '埼玉県', personal: false }, order: { dest: 'N1', destName: 'x' }, lines: [{ manual: true, name: '特注の台', price: 5000, qty: 1 }, { code: 'T1', qty: 1 }] });
  r = Q.compute(data, od2, e4);
  t = Q.todo(od2, r);
  assert.deepEqual(t.items.filter(x => !x.done).map(x => [x.key, x.line]), [['code', 0], ['wh', 1]]);
  // 手で入れたら決まる
  od2.lines[0].smile = 'X9'; od2.lines[0].wh = 'W2'; od2.lines[1].wh = 'W1';
  r = Q.compute(data, od2, e4);
  assert.equal(Q.todo(od2, r).left, 0);
  assert.equal(r.order.rows[0].code, 'X9');
  // v27（2027-01-01 の価格改定用）があっても、今は元の品目コードを選ぶ
  const items2 = Object.assign({}, items, { UDL25v27: { name: 'リフト v27', kakaku: 'UDL250' } });
  const kk2 = { UDL250: ['UDL25v27', 'UDL25'] }, e5 = { items: items2, history: h };
  assert.equal(Q.smileCodeOf({ code: 'UDL250', listCode: 'UDL250' }, e5, kk2).code, 'UDL25');
  assert.equal(Q.smileCodeOf({ code: 'UDL250', listCode: 'UDL250' }, e5, kk2, '2026-12-28').code, 'UDL25');
  // 受注日が 2027-01-01 からは v27（旧コードは 2026-12-31 で使用禁止）
  let s27 = Q.smileCodeOf({ code: 'UDL250', listCode: 'UDL250' }, e5, kk2, '2027-01-05');
  assert.equal(s27.code, 'UDL25v27'); assert.equal(s27.by, '2027年からは v27');
  // 旧コードを入れても、2027年からは同じ価格表記載名の v27 にする。旧コードは候補に残る
  s27 = Q.smileCodeOf({ code: 'UDL25' }, e5, kk2, '2027-01-05');
  assert.deepEqual([s27.code, s27.cands], ['UDL25v27', ['UDL25v27', 'UDL25']]);
  assert.equal(Q.smileCodeOf({ code: 'UDL25' }, e5, kk2, '2026-12-31').code, 'UDL25');
  // 同じ価格表記載名に v27 が2つ（サイレント版など）あるときは、入れたコードと同じ形 → 短いもの
  const items3 = { PA1: { kakaku: 'PA1' }, 'PA1-GS': { kakaku: 'PA1' }, PA1GSv27: { kakaku: 'PA1' }, PA1v27: { kakaku: 'PA1' } };
  const kk3 = { PA1: ['PA1', 'PA1-GS', 'PA1GSv27', 'PA1v27'] }, e6 = { items: items3, history: h };
  assert.equal(Q.smileCodeOf({ code: 'PA1' }, e6, kk3, '2027-01-05').code, 'PA1v27');
  assert.equal(Q.smileCodeOf({ code: 'PA1-GS' }, e6, kk3, '2027-01-05').code, 'PA1GSv27');
  assert.equal(Q.smileCodeOf({ code: 'X', listCode: 'PA1' }, e6, kk3, '2027-01-05').code, 'PA1v27');
  // 事情があって旧コードで入れるときは、手で選んだものが勝つ
  assert.equal(Q.smileCodeOf({ code: 'UDL25', smile: 'UDL25' }, e5, kk2, '2027-01-05').code, 'UDL25');
  // 見積では作らない
  assert.equal(Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 1 }] }), e4).order, null);
}

// --- 答え合わせ：その日より前の受注だけで決めて、実際の受注と比べる ---
{
  assert.equal(Q.isPriceTarget('UDL25', 70000), true);
  ['IDO', 'CASTER', 'P/1', 'P/PD', 'R/3', 'OTHER3', 'FR'].forEach(c => assert.equal(Q.isPriceTarget(c, 1000), false));
  assert.equal(Q.isPriceTarget('P/0000000217', 1850), true); // ふつうの部品は比べる
  assert.equal(Q.isPriceTarget('UDL25', 0), false);           // 0円は比べない
  const R = (date, no, code, unit, staff, dest, wh) => ({ date, no, cust: 'C1', sha: 'G9', code, qty: 1, unit, staff, staffName: '', dept: 'B1', deptName: '', dest, destName: '', wh, whName: '', unitName: '台', tehai: '繰返(製作)' });
  const rows = [
    R('2026-10-01', '1', 'UDL25', 69000, 'S1', 'N1', 'W1'),
    R('2026-10-05', '2', 'UDL25', 69000, 'S1', 'N1', 'W1'),   // ルールどおり（改定前の定価 120000 × 5.75掛）
    R('2026-10-06', '3', 'UDL25', 66000, 'S2', 'N2', 'W2'),   // 単価・担当者・納品先・倉庫が違う
    R('2026-10-07', '4', 'UDL25', 66000, 'S2', 'N1', 'W1'),   // 単価はルールと違うが、前回（66000）と同じ
    R('2026-10-07', '4', 'IDO', 0, 'S2', 'N1', 'W1'),         // 比べない行
  ];
  rows.forEach((r, i) => r.no = r.no); // 並びはそのまま
  const res = Q.backtest(data, rows, Object.assign({}, env, { customers: { C1: B } }), { from: '2026-10-05' });
  assert.equal(res.orders, 3);
  assert.deepEqual(res.fields.price, { n: 3, ok: 1, either: 2, priced: 3 });
  assert.deepEqual(res.fields.staff, { n: 3, ok: 2 }); // 伝票2・4 は前回と同じ担当者
  // N2 は伝票3 で初めて使ったので、候補にない。
  // 伝票2 は前の受注が1件だけなので「毎回ちがう」側、伝票3・4 は前の受注の半分以上が N1 なので「いつも同じ」側
  assert.deepEqual(res.fields.dest, { n: 3, ok: 2, inList: 2, same: { n: 2, ok: 1 }, other: { n: 1, ok: 1 } });
  assert.ok(res.misses.some(m => m.field === 'dest' && m.no === '3')); // いつも同じ側で外れたものは一覧に出る
  assert.deepEqual(res.fields.wh, { n: 4, ok: 2 }); // IDO の行にも倉庫がある（IDO は前回がないので外れ）
  assert.ok(res.misses.some(m => m.field === 'price' && m.no === '3' && m.actual === 66000));
  // 1件目より前の受注がないときは「前回なし」
  const r1 = Q.backtest(data, rows.slice(0, 1), Object.assign({}, env, { customers: { C1: B } }), {});
  assert.ok(r1.misses.some(m => m.field === 'staff' && m.app === '（前回なし）'));
}

// --- 計算の内訳：行ごとに、送料に使った重さ（1台あたり）とその型式が残る ---
{
  const r = Q.compute(data, doc({ lines: [{ code: 'UDL250', qty: 2 }, { code: 'PB', qty: 1 }] }), env);
  assert.equal(r.lines[0].kg, 60);
  assert.equal(r.lines[0].kgCode, 'UDL250');
  assert.equal(r.lines[1].kg, 1);
  assert.ok(r.fare.explain.length > 0);
  // 路線便は、帯ごとの金額の合計が送料の基本と同じ
  const parts = r.fare.parts;
  assert.ok(parts.length >= 1);
  assert.equal(parts.reduce((s, p) => s + p.amount, 0), r.fare.rule);
  assert.equal(parts.reduce((s, p) => s + p.kg, 0), r.fare.kg);
}

// --- 受注伝票：運送会社は送料の地域から自動で入る／新しい納品先は名前・住所・電話がそろうまで残る ---
{
  const od = Object.assign(Q.blank('order', '2026-11-16', ''), { cust: B, shipDate: '2026-11-20', dest: { name: '', pref: '埼玉県', personal: false }, lines: [{ code: 'UDL250', qty: 1 }] });
  od.order.dest = 'N1';
  let r = Q.compute(data, od, env);
  assert.equal(r.fare.carrier, '西濃運輸');
  assert.equal(r.order.head.carrier, '西濃利用'); // 選んでいなければ、送料の運送会社
  od.order.carrier = 'トナミ利用';
  assert.equal(Q.compute(data, od, env).order.head.carrier, 'トナミ利用'); // 選んだらそちら
  od.order.dest = 'new'; od.order.nd = { name: '見本の新しい現場' };
  r = Q.compute(data, od, env);
  let it = Q.todo(od, r).items.find(x => x.key === 'dest');
  assert.equal(it.done, false);
  assert.ok(/住所・電話がまだ/.test(it.label));
  od.order.nd = { name: '見本の新しい現場', addr: '埼玉県見本市1-1', tel: '000-0000-0000' };
  r = Q.compute(data, od, env);
  assert.equal(Q.todo(od, r).items.find(x => x.key === 'dest').done, true);
  assert.equal(r.order.head.nd.addr, '埼玉県見本市1-1');
}

// --- ひらがなで探す：ひらがな・カタカナ・半角カナをそろえる ---
{
  assert.equal(Q.norm('やまぜん'), Q.norm('ﾔﾏｾﾞﾝ'));
  assert.equal(Q.norm('やまぜん'), Q.norm('ヤマゼン'));
  assert.equal(Q.norm('きょうと'), Q.norm('キョウト'));
  const list = [{ key: Q.norm('C1 見本商事 ﾐﾎﾝｼｮｳｼﾞ'), head: Q.norm('見本商事') + ' ' + Q.norm('ﾐﾎﾝｼｮｳｼﾞ'), id: 1 }, { key: Q.norm('C2 べつの会社 ﾍﾞﾂﾉｶｲｼｬ'), head: '', id: 2 }];
  assert.deepEqual(Q.search(list, 'みほん', 8).map(x => x.id), [1]);
  assert.deepEqual(Q.search(list, 'ミホンショウジ', 8).map(x => x.id), [1]);
  // 名前でもカナでも頭が合えば同じ扱い。同じくらい合うものは rank（最近の受注）の大きいほうを上に
  const l2 = [
    { key: Q.norm('ﾐﾎﾝｸﾘｴｲﾄ ﾐﾎﾝｸﾘｴｲﾄ'), head: Q.norm('ﾐﾎﾝｸﾘｴｲﾄ') + ' ' + Q.norm('ﾐﾎﾝｸﾘｴｲﾄ'), id: 1, rank: 20250101 },
    { key: Q.norm('㈱見本 東京支店 ﾐﾎﾝﾄｳｷｮｳｼﾃﾝ'), head: Q.norm('㈱見本 東京支店') .replace(/ /g, '') + ' ' + Q.norm('ﾐﾎﾝﾄｳｷｮｳｼﾃﾝ'), id: 2, rank: 20261110 },
  ];
  assert.deepEqual(Q.search(l2, 'みほん', 8).map(x => x.id), [2, 1]);
}

console.log('ok test_quote_core');
