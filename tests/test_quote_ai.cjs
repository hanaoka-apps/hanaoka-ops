// 見積・受注の「AIに任せる」（quote_ai.js）の確かめ
//   node tests/test_quote_ai.cjs
// AI は呼ばない。AI に渡す形・返事のそろえ方・マスタへの当て方（ここはアプリの決まり）を、架空のデータで確かめる。
const path = require('path');
const assert = require('node:assert/strict');
const A = require(path.join(__dirname, '../quote_ai.js'));
const Q = require(path.join(__dirname, '../quote_core.js'));
const P = require(path.join(__dirname, '../price_core.js'));

// --- AI に渡す形 ---
let body = A.buildBody({ text: '見積をお願いします', files: [{ data: 'AAAA', type: 'application/pdf', name: 'fax.pdf' }, { data: 'BBBB', type: '', name: 'photo.png' }], today: '2026-11-15', kind: 'quote' }, 'model-x');
assert.equal(body.model, 'model-x');
assert.equal(body.output_config.format.type, 'json_schema');
assert.equal(body.output_config.format.schema.additionalProperties, false);
assert.deepEqual(body.output_config.format.schema.required.sort(), Object.keys(body.output_config.format.schema.properties).sort()); // 全部の項目が必須
assert.equal(body.messages[0].content[0].type, 'document'); // PDF
assert.equal(body.messages[0].content[1].type, 'image');    // 画像（名前から種類を決める）
assert.equal(body.messages[0].content[1].source.media_type, 'image/png');
assert.ok(/今日：2026-11-15/.test(body.messages[0].content[2].text));
assert.ok(/見積をお願いします/.test(body.messages[0].content[2].text));
assert.ok(/値段は計算しない/.test(body.system[0].text));
assert.ok(/受注伝票/.test(A.buildBody({ text: 'x', kind: 'order' }).messages[0].content[0].text));

// --- 返事をそろえる ---
let r = A.parse(JSON.stringify({ customer_name: ' 見本商事株式会社 東京支店 ', contact_name: '山田', items: [{ model: 'LF-250', name: '', quantity: 2, unit_price: 0 }, { model: '', name: '', quantity: 1, unit_price: 0 }, { model: '', name: '特注の台', quantity: 0, unit_price: 5000 }],
  delivery_name: '', delivery_address: '埼玉県川口市見本3-3', desired_date: '2026/12/10', customer_order_no: 'PO-1', subject: '', remarks: '', unclear: ['', '色の指定なし'] }));
assert.equal(r.customer, '見本商事株式会社 東京支店');
assert.equal(r.items.length, 2);           // 型式も品名もない行は捨てる
assert.equal(r.items[1].qty, 0);
assert.equal(r.shipDate, '');              // 形の違う日付は使わない
assert.deepEqual(r.unclear, ['色の指定なし']);
assert.throws(() => A.parse('こわれた返事'));
assert.equal(A.parse('```json\n{"customer_name":"x","items":[]}\n```').customer, 'x');

// --- マスタに当てる ---
const C = (code, name, fullName, shaName, kake) => ({ code, name, fullName, shaCode: 'G' + code.slice(0, 1), shaName, kakeName: kake });
const cust = [C('100101', '見本商事 東京', '見本商事株式会社 東京支店', '見本商事', '5.75掛(B)'), C('100102', '見本商事 大阪', '見本商事株式会社 大阪支店', '見本商事', '5.75掛(B)'), C('200201', '見本物産 本社', '株式会社見本物産', '見本物産', '5.25掛(A)')];
const env = {
  custRows: cust.map(c => ({ key: Q.norm(c.code + ' ' + c.name + ' ' + c.fullName + ' ' + c.shaName), head: Q.norm(c.name), c })),
  itemRows: [['LF250', '見本リフト 250kg'], ['LF500', '見本リフト 500kg'], ['DC-LS', '見本台車 スチール'], ['DC-PL', '見本台車 樹脂']].map(([code, name]) => ({ key: Q.norm(code + ' ' + name), head: Q.norm(code), code, name })),
  prefOf: P.prefOf, prefs: P.PREFS, today: '2026-11-15'
};
const base = Q.blank('quote', '2026-11-15', '見本 太郎');
const read = o => A.parse(JSON.stringify(Object.assign({ customer_name: '', contact_name: '', items: [], delivery_name: '', delivery_address: '', desired_date: '', customer_order_no: '', subject: '', remarks: '', unclear: [] }, o)));
const texts = a => a.notes.map(n => n.text).join(' / ');

// 取引先がぴったり1件・型式は書き方違い・届け先の県・納期・担当の方
let a = A.apply(base, read({ customer_name: '見本商事(株)東京支店', contact_name: '山田', items: [{ model: 'lf-250', name: '', quantity: 2, unit_price: 0 }], delivery_name: '川口倉庫', delivery_address: '埼玉県川口市見本3-3', desired_date: '2026-12-10', customer_order_no: 'PO-1', subject: 'リフトの件' }), env);
assert.equal(a.doc.cust.code, '100101');
assert.equal(a.doc.toName, '見本商事株式会社 東京支店　山田');
assert.equal(a.doc.honor, '様');
assert.deepEqual(a.doc.lines, [{ code: 'LF250', qty: 2 }]);
assert.equal(a.doc.dest.pref, '埼玉県');
assert.equal(a.doc.dest.name, '川口倉庫 川口市見本3-3');
assert.equal(a.doc.shipDate, '2026-12-10');
assert.equal(a.doc.title, 'リフトの件');
assert.equal(a.doc.orderNo, 'PO-1');
assert.equal(a.notes.length, 0);
assert.equal(a.custQuery, '');
assert.equal(base.cust, null); // 元の書類は書きかえない

// 取引先が2件に当たる → 決めずに、探す欄に入れる
a = A.apply(base, read({ customer_name: '見本商事', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }] }), env);
assert.equal(a.doc.cust, null);
assert.equal(a.custQuery, '見本商事');
assert.ok(a.notes.some(n => n.k === 'cust' && /候補が 2 件/.test(n.text)));
// 取引先が見つからない
a = A.apply(base, read({ customer_name: 'どこにもない会社', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }] }), env);
assert.equal(a.doc.cust, null);
assert.ok(/見つかりません/.test(texts(a)));
// 名前の一部から1件に決まったときは、確かめてもらう
a = A.apply(base, read({ customer_name: '見本物産 本', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }] }), env);
assert.equal(a.doc.cust.code, '200201');
assert.ok(/合っているか確かめてください/.test(texts(a)));
// 「株式会社」の有無だけの違いは、ぴったり合ったことにする
a = A.apply(base, read({ customer_name: '見本物産', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }] }), env);
assert.equal(a.doc.cust.code, '200201');
assert.equal(a.notes.length, 0);

// 商品：数量なしは 1、候補が複数は決めない、文面の単価は使わずに知らせる、決まらない品はそのままの行
a = A.apply(base, read({ customer_name: '株式会社見本物産', items: [
  { model: 'DC-PL', name: '', quantity: 0, unit_price: 20000 },
  { model: '', name: '見本リフト', quantity: 3, unit_price: 0 },
  { model: 'XYZ-9', name: '特注の台', quantity: 1, unit_price: 5000 }] }), env);
assert.deepEqual(a.doc.lines[0], { code: 'DC-PL', qty: 1 });
assert.ok(/DC-PL の数量が書いてありません/.test(texts(a)));
assert.ok(/DC-PL：文面には単価 20,000/.test(texts(a)));
assert.deepEqual(a.doc.lines[1], { code: '見本リフト', qty: 3, price: null }); // LF250 と LF500 のどちらか決まらない
assert.deepEqual(a.doc.lines[2], { code: 'XYZ-9 特注の台', qty: 1, price: 5000 });
assert.equal(a.notes.filter(n => n.k === 'line' && /1つに決まりません/.test(n.text)).length, 2);

// 過ぎた日付は入れない・文面のメモと読めなかった所は確認することへ
a = A.apply(base, read({ customer_name: '株式会社見本物産', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }], desired_date: '2026-11-01', remarks: '色は黒', unclear: ['納期があいまい'] }), env);
assert.equal(a.doc.shipDate, '');
assert.ok(/今日より前/.test(texts(a)) && /文面より：色は黒/.test(texts(a)) && /読み取り：納期があいまい/.test(texts(a)));

// 住所が県から始まっていなくても、県を拾う
a = A.apply(base, read({ customer_name: '株式会社見本物産', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }], delivery_address: '納入先は広島県広島市見本区6-6' }), env);
assert.equal(a.doc.dest.pref, '広島県');

// 確認することに出る。取引先を選んだら、取引先の注意は消える
const data = { prices: [{ 型式: 'DC-LS', 品名: '見本台車', 定価: 30000, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: 18 }], classes: [], exceptions: [], fares: [], costs: [], assembly: [] };
a = A.apply(base, read({ customer_name: '見本商事', items: [{ model: 'DC-LS', name: '', quantity: 1, unit_price: 0 }] }), env);
const d1 = Object.assign({}, a.doc, { ai: { notes: a.notes } });
assert.ok(Q.compute(data, d1, { items: {} }).checks.some(c => /候補が 2 件/.test(c.text)));
d1.cust = env.custRows[0].c;
assert.ok(!Q.compute(data, d1, { items: {} }).checks.some(c => /候補が 2 件/.test(c.text)));

console.log('ok test_quote_ai');
