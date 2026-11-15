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

// --- 定価は納期で選ぶ ---
c = Q.compute(data, doc({ date: '2026-10-20', lines: [{ code: 'UDL250', qty: 1 }] }), env);
assert.equal(c.priceDate, '2026-10-20');
assert.equal(c.lines[0].unit, 69000); // 改定前の定価 120000×0.575
assert.ok(c.checks.some(x => /2026-11-01 に定価が変わります/.test(x.text)));
c = Q.compute(data, doc({ date: '2026-10-20', shipDate: '2026-11-10', lines: [{ code: 'UDL250', qty: 1 }] }), env);
assert.equal(c.priceDate, '2026-11-10');
assert.equal(c.lines[0].unit, 75900); // 納期が改定日より後 → 新しい定価
assert.ok(c.checks.some(x => /新しい定価で出しています/.test(x.text)));

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

console.log('ok test_quote_core');
