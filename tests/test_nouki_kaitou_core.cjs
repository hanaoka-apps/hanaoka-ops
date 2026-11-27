// 納期回答（試作）の計算（nouki_kaitou_core.js）の確認。
// 実データ（Excel・FUJIN のデータ）はリポジトリに置けないので、小さな表を作って確かめる。
//   node tests/test_nouki_kaitou_core.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '../nouki_kaitou_core.js'));

// ---- Excel の日付 ----
assert.equal(C.isoDay(C.xlDate(46357)), '2026-12-01');
assert.equal(C.isoDay(C.xlDate('2026/12/1')), '2026-12-01');
assert.equal(C.xlDate('4月以降'), null);

// ---- Excel の表（引き当て・注残）を、行・列の配列で作る ----
// 日付は 12/1〜12/5 の5日分。G 列（c=6）から。
function makeSheets() {
  const H = {}, O = {};
  const put = (S, r, c, v) => { (S[r] = S[r] || {})[c] = v; };
  put(H, 1, 3, '注残：見本');
  const d0 = 46357; // 2026/12/1
  for (let j = 0; j < 5; j++) put(H, 2, 6 + j, d0 + j);
  put(H, 2, 11, '4月以降');
  // フレーム X：起点在庫 10、毎日 5 作る、12/3 に 30 出る
  const blk = (r, name, stock0, make, order) => {
    put(H, r, 0, name); put(H, r, 1, '＋完成（全周ゴム）'); put(H, r, 2, d0); if (stock0 != null) put(H, r, 3, stock0);
    let s = stock0 || 0; const st = [];
    for (let j = 0; j < 5; j++) { put(H, r, 6 + j, make[j]); put(H, r + 2, 6 + j, order[j]); s += make[j] - order[j]; st.push(s); put(H, r + 3, 6 + j, s); }
    put(H, r + 2, 11, 2); put(H, r + 3, 11, s - 2);
    for (let j = 0; j < 5; j++) put(H, r + 4, 6 + j, Math.min(...st.slice(j), s - 2));
    put(H, r + 4, 11, s - 2);
  };
  blk(4, 'X', 10, [5, 5, 5, 5, 5], [0, 0, 30, 0, 0]);   // 在庫 15,20,-5,0,5 → 4月以降 3
  blk(10, 'Y', null, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]); // 起点在庫が空
  put(O, 4, 0, 'X'); put(O, 4, 1, d0 + 2); put(O, 4, 2, 'MODEL-A'); put(O, 4, 3, '見本商事'); put(O, 4, 4, 1001); put(O, 4, 5, 15); put(O, 4, 6, 2); put(O, 4, 7, 30);
  const fn = S => (r, c) => (S[r] && S[r][c] != null ? S[r][c] : null);
  return name => (name === '引き当て' ? fn(H) : name === '注残・出荷明細' ? fn(O) : null);
}
const FR = C.parseWorkbook(makeSheets());
assert.equal(FR.dates.length, 5);
assert.deepEqual(FR.frameOrder, ['X', 'Y']);
assert.equal(FR.frames.X.stock0, 10);
assert.equal(FR.frames.Y.stock0, null);
assert.equal(FR.frames.X.after.label, '4月以降');
assert.equal(FR.orders.length, 1);
assert.equal(FR.orders[0].no, '1001');
assert.equal(FR.models['MODEL-A'].frame, 'X');
assert.equal(FR.note, '注残：見本');

// 12/1 時点：見込み在庫の最小は -5（12/3）→ あと 0 枚
const t1 = new Date(2026, 11, 1);
assert.equal(C.frameInfo(FR, 'X', t1).avail, -5);
// 12/4 時点：この先の最小は 0 → 12/5 には 5 → 4月以降は 3
const t4 = new Date(2026, 11, 4);
assert.equal(C.frameInfo(FR, 'X', t4).avail, 0);
assert.equal(C.isoDay(C.frameEarliest(FR, 'X', 3, t4).date), '2026-12-05');
assert.equal(C.frameEarliest(FR, 'X', 6, t4), null);
assert.ok(C.frameInfo(FR, 'Y', t1).noStock);

// ---- FUJIN のデータ（ハンドル・キャスター） ----
const PL = {
  dates: ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04'], today: 1,
  items: {
    H1: { name: 'ハンドルH', stock: 4, ev: [[2, 'plan', 10, { done: 0 }], [3, 'req', 6, {}], [0, 'req', 2, { late: true }]] },
    C1: { name: 'キャスターC', stock: 100, ev: [[2, 'ord', 8, { p: 'MODEL-A', c: '見本商事', no: '1001', q: 2, per: 4 }]] }
  },
  models: { 'MODEL-A': { name: '見本', lt: 2, parts: [['F1', 2, 'frame'], ['H1', 1, 'handle'], ['C1', 4, 'caster']] } }
};
PL.items.F1 = { name: 'ﾌﾚｰﾑ X FULL ASSY', stock: 0, ev: [] };
// 遅れの出（2）は本日に出す：4-2=2, +10=12, -6=6, 6 → 最小は本日の 2
const c = C.plCalc(PL, 'H1');
assert.deepEqual(c.bal.slice(1), [2, 12, 6, 6]);
assert.equal(c.atp[1], 2);
assert.equal(C.isoDay(C.plEarliest(PL, 'H1', 5).date), '2026-12-02');
assert.equal(C.plOrders(PL, 'C1')[0].cust, '見本商事');

// ---- 型式の回答 ----
// フレーム F1 は名前に「X」を含むので Excel の X を使う（取数 2）
const a = C.answer(FR, PL, 'model-a', 1, t4);
assert.equal(a.model, 'MODEL-A');
assert.equal(a.parts.length, 3);
const fp = a.parts.find(p => p.kind === 'frame');
assert.equal(fp.frame, 'X'); assert.equal(fp.src, 'Excel'); assert.equal(fp.units, 0);
assert.equal(C.isoDay(fp.when.date), '2026-12-05');           // 2枚 → 12/5
assert.equal(a.neck.kind, 'frame');
assert.equal(C.isoDay(a.ready), '2026-12-05');               // 部品がそろう日（ハンドル 12/1、キャスター 12/1）
assert.equal(C.isoDay(a.ship), '2026-12-08');                // 12/5 は土曜。組立2営業日で 12/7(月)・12/8(火)

// 見本データでも答えが出る
const S = C.sample(new Date(2026, 10, 27));
const b = C.answer(S.FR, S.PL, 'SAMPLE-200', 5, new Date(2026, 10, 27));
assert.ok(b && b.parts.length === 4);
assert.equal(C.modelList(S.FR, S.PL).length, 3);
console.log('ok');
