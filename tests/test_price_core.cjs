// 価格・送料の早見（price_core.js）の確かめ
//   node tests/test_price_core.cjs
// 実データ（価格・得意先）はリポジトリに置けないので、形だけ同じ見本データで確かめる。
// 数字の決まり（100円単位・÷0.93・400kg超など）は、2026-11 に受注明細で確かめた決まりと同じ。
const path = require('path');
const assert = require('node:assert/strict');
const P = require(path.join(__dirname, '../price_core.js'));

const data = {
  prices: [
    { 型式: 'T1', 品名: '見本台車', 定価: 28400, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: 40 },
    { 型式: 'T1', 品名: '見本台車', 定価: 31300, 適用開始日: '2026-11-01', 商品の種類: '台車', 運賃の重量kg: 40 },
    { 型式: 'L1', 品名: '見本リフト', 定価: 101400, 適用開始日: '2026-01-01', 商品の種類: '台車以外', 運賃の重量kg: 125 },
    { 型式: 'BIG', 品名: '大きいもの', 定価: 500000, 適用開始日: '2026-01-01', 商品の種類: '台車以外', 運賃の重量kg: 240 },
    { 型式: 'PB', 品名: '見本部品', 定価: 17300, 適用開始日: '2026-01-01', 商品の種類: '部品', 運賃の重量kg: 10 },
    { 型式: 'FC', 品名: '見本輸入品', 定価: 12000, 適用開始日: '2026-01-01', 商品の種類: '輸入品', 運賃の重量kg: 10 },
    { 型式: 'NOW', 品名: '重さ不明', 定価: 10000, 適用開始日: '2026-01-01', 商品の種類: '台車', 運賃の重量kg: null },
  ],
  classes: [
    { 対象の種類: '得意先', 対象コード: 'S01', 対象名: '甲商事 在庫', 在庫口: true, 適用開始日: '2026-01-01' },
    { 対象の種類: '社名', 対象コード: 'G1', 対象名: '甲商事', 商品の種類: '全部', 在庫口の掛率: 0.4, 適用開始日: '2026-01-01' },
    { 対象の種類: '社名', 対象コード: 'G2', 対象名: '乙商会', 商品の種類: '台車', 掛率: 0.525, 在庫口の掛率: 0.45, 適用開始日: '2026-01-01' },
    { 対象の種類: '社名', 対象コード: 'G2', 対象名: '乙商会', 商品の種類: '台車以外', 掛率: 0.575, 在庫口の掛率: 0.5, 適用開始日: '2026-01-01' },
    { 対象の種類: '社名', 対象コード: 'G3', 対象名: '丙フォーク', 計算方式: '本部経由', 適用開始日: '2026-01-01' },
    { 対象の種類: '社名', 対象コード: 'G4', 対象名: '丁商会', 掛率: 0.525, 計算方式: '運賃込み', 運賃込みの地域: '近畿', 適用開始日: '2026-01-01' },
    { 対象の種類: '得意先', 対象コード: 'EC1', 対象名: '直販EC', 掛率: 1.0, 適用開始日: '2026-01-01' },
  ],
  exceptions: [
    { 型式: 'FC', 対象の種類: 'ランク', 対象コード: "A'・A・B'・B", 対象名: '商社・販売店', 掛率: 0.75, 適用開始日: '2026-01-01' },
    { 型式: 'FC', 対象の種類: '社名', 対象コード: 'G1', 対象名: '甲商事', 掛率: 0.6, 適用開始日: '2026-01-01', 要確認: true, メモ: '確認中' },
    { 型式: 'T1', 対象の種類: '全部', 対象コード: '', 対象名: '', 台数以上: 50, 掛率: 0.45, 適用開始日: '2026-01-01' },
    { 型式: 'T1', 対象の種類: '全部', 対象コード: '', 対象名: '', 台数以上: 100, 掛率: 0.4, 適用開始日: '2026-01-01' },
    { 型式: 'PB', 対象の種類: '社名', 対象コード: 'G4', 対象名: '丁商会', 金額: 1500, 適用開始日: '2026-01-01' },
    { 型式: 'T1', 対象の種類: '未整理', 対象名: 'SW新価格', 掛率: 0.47, メモ: '要確認', 要確認: true },
    { 型式: 'T1', 対象の種類: '社名', 対象コード: 'G1', 対象名: '甲商事', 掛率: 0.3, 適用開始日: '2027-01-01' }, // まだ効いていない
  ],
  fares: [
    { 種類: '地域', 地域: '南関東', 県: '埼玉 千葉 東京 神奈川', 運送会社: '西濃運輸' },
    { 種類: '地域', 地域: '近畿', 県: '滋賀 京都 大阪 兵庫 奈良 和歌山', 運送会社: '第一貨物' },
    { 種類: '地域', 地域: '北陸', 県: '石川 福井 富山', 運送会社: 'トナミ運輸' },
    ...[[10, 1700, 1700, 1700], [20, 1800, 2000, 2000], [40, 2300, 2900, 2600], [125, 3900, 6300, 5200], [250, 5800, 9800, 7800], [400, 9000, 17000, 13600]]
      .flatMap(([kg, kanto, kinki, hokuriku]) => [
        { 種類: '路線便', 地域: '南関東', 上限: kg, 金額: kanto, 適用開始日: '2025-11-12' },
        { 種類: '路線便', 地域: '近畿', 上限: kg, 金額: kinki, 適用開始日: '2025-11-12' },
        { 種類: '路線便', 地域: '北陸', 上限: kg, 金額: hokuriku, 適用開始日: '2025-11-12' },
      ]),
    { 種類: '路線便', 地域: '南関東', 上限: 40, 金額: 2500, 適用開始日: '2027-04-01' }, // 将来の改定（まだ効いていない）
    { 種類: 'ミニ便', 地域: '南関東', 上限: 1, 金額: 600, 適用開始日: '2025-12-05' },
    { 種類: 'ミニ便', 地域: '南関東', 上限: 2, 金額: 1100, 適用開始日: '2025-12-05' },
  ],
};
const cust = (code, shaCode, kakeName) => ({ code, shaCode, kakeName, name: code });

// --- ランクの読み方 ---
assert.deepEqual(P.rankOf("5掛(A')"), { rank: "A'", k: 0.5 });
assert.deepEqual(P.rankOf('5.75掛(B)'), { rank: 'B', k: 0.575 });
assert.equal(P.rankOf('7掛(ﾕｰｻﾞｰ)').rank, 'ユーザー');
assert.equal(P.rankOf('その他'), null);
assert.ok(P.rankMatches("A'・A・B'・B", 'B'));
assert.ok(!P.rankMatches("A'・A", 'B'));

// --- 定価は日付で切り替わる ---
assert.equal(P.listPriceRow(data.prices, 'T1', '2026-10-31').定価, 28400);
assert.equal(P.listPriceRow(data.prices, 'T1', '2026/11/01').定価, 31300);
assert.equal(P.listPriceRow(data.prices, 'T1', '2025-12-31'), null);

// --- 標準のランク：定価×掛率を100円単位で四捨五入 ---
let r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.price, 15650); // 31300×0.5=15650（10円単位）
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-10-01', customer: cust('C1', 'G9', '5.25掛(A)') });
assert.equal(r.price, 14910); // 28400×0.525=14910（10円単位。各社価格表の100円単位なら14900）

// --- 改定から半年は、改定前の定価での金額も並べる ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.oldPrice, 14200); // 28400×0.5
assert.equal(r.revisedOn, '2026-11-01');
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2027-06-01', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.oldPrice, undefined);

// --- 在庫口の得意先コード → 社名の在庫口の掛率 ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('S01', 'G1', "5掛(A')") });
assert.equal(r.isStock, true);
assert.equal(r.price, 12520); // 31300×0.4=12520
assert.ok(r.notes.some(n => /御社在庫品/.test(n)));
// 同じ社名でも通常の支店は仕切り。営業の指示なら在庫価格
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C2', 'G1', "5掛(A')") });
assert.equal(r.price, 15650);
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C2', 'G1', "5掛(A')"), forceStock: true });
assert.equal(r.price, 12520);

// --- 商品の種類で掛率が変わる社名（台車はA、台車以外はB） ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C3', 'G2', 'その他') });
assert.equal(r.k, 0.525);
r = P.unitPrice(data, { code: 'L1', qty: 1, date: '2026-11-11', customer: cust('C3', 'G2', 'その他') });
assert.equal(r.k, 0.575);
assert.equal(r.price, 58310); // 101400×0.575=58305 → 58310

// --- 例外：台数の条件は大きいほうから。まだ効いていない行は使わない ---
r = P.unitPrice(data, { code: 'T1', qty: 60, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.k, 0.45);
r = P.unitPrice(data, { code: 'T1', qty: 120, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.k, 0.4);
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C2', 'G1', "5掛(A')") });
assert.notEqual(r.k, 0.3);
assert.ok(r.notes.some(n => /SW新価格/.test(n))); // 未整理の行は参考に出すだけ

// --- 例外：社名はランクより優先。要確認なら知らせる ---
r = P.unitPrice(data, { code: 'FC', qty: 1, date: '2026-11-11', customer: cust('C2', 'G1', "5掛(A')") });
assert.equal(r.price, 7200);
assert.ok(r.warnings.some(w => /要確認/.test(w)));
r = P.unitPrice(data, { code: 'FC', qty: 1, date: '2026-11-11', customer: cust('C1', 'G9', '5.75掛(B)') });
assert.equal(r.price, 9000);
r = P.unitPrice(data, { code: 'FC', qty: 1, date: '2026-11-11', customer: cust('C1', 'G9', '8掛(ﾕｰｻﾞｰ)') });
assert.equal(r.price, 9600); // ユーザーはランクの例外に入らない

// --- 本部経由（台車本体）：販社見積 ÷0.93 10円切り上げ、本部受注 ×0.93 1円 ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-10-28', customer: cust('H01', 'G3', '5.25掛(A)') });
assert.equal(r.quotePrice, 16040); // 14910÷0.93=16032.3 → 16040
assert.equal(r.orderPrice, 14917); // 16040×0.93=14917.2 → 14917
// 部品だけなら販社と直接・Bランク
r = P.unitPrice(data, { code: 'PB', qty: 1, date: '2026-11-11', customer: cust('H01', 'G3', '5.25掛(A)') });
// 部品だけでも本部あてなら本部経由。販社から直接来たときの Bランクも並べる
assert.equal(r.quotePrice, 9770);
assert.equal(r.directPrice, 9950); // 17300×0.575=9947.5 → 9950
assert.ok(r.warnings.some(w => /販社から直接/.test(w)));
// 台車と一緒なら部品も本部経由（Aランク÷0.93）
r = P.unitPrice(data, { code: 'PB', qty: 1, date: '2026-11-11', customer: cust('H01', 'G3', '5.25掛(A)'), withBody: true });
assert.equal(r.quotePrice, 9770); // 17300×0.525=9082.5 → 9080、÷0.93=9763.4 → 9770
assert.equal(r.orderPrice, 9086);

// --- 運賃込み（近畿あて1台分を足す）・金額の例外 ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-10-29', customer: cust('C4', 'G4', 'その他') });
assert.equal(r.fareIncluded, 2900);
assert.equal(r.price, 14910 + 2900);
r = P.unitPrice(data, { code: 'PB', qty: 2, date: '2026-10-29', customer: cust('C4', 'G4', 'その他') });
assert.equal(r.price, 1500 + 1700); // 金額の例外＋1個分の運賃（10kg帯の近畿）

// --- 定価で売る得意先・掛率が決まらないとき ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('EC1', 'G8', 'その他') });
assert.equal(r.price, 31300);
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('C9', 'G9', 'その他') });
assert.equal(r.price, null);
assert.ok(r.warnings.some(w => /掛率が決まりません/.test(w)));
r = P.unitPrice(data, { code: 'XX', qty: 1, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.ok(r.warnings.some(w => /定価リストに定価がない/.test(w)));

// --- 送料 ---
assert.deepEqual(P.regionOfPref(data.fares, '大阪府'), { region: '近畿', carrier: '第一貨物' });
let f = P.freight(data, [{ code: 'T1', qty: 2 }, { code: 'PB', qty: 1 }], { pref: '東京都', date: '2026-11-11' });
assert.equal(f.kg, 90);
assert.equal(f.amount, 3900); // 90kg → 125kg帯
f = P.freight(data, [{ code: 'BIG', qty: 2 }], { pref: '東京都', date: '2026-11-11' });
assert.equal(f.amount, 9000 + 3900); // 480kg ＝ 400kg ＋ 80kg（125kg帯）
f = P.freight(data, [{ code: 'T1', qty: 1 }], { pref: '東京都', date: '2026-11-11', personal: true });
assert.equal(f.amount, 4600);
assert.equal(f.carrier, '西濃運輸');
f = P.freight(data, [{ code: 'PB', qty: 2 }], { pref: '神奈川県', date: '2026-11-11' });
assert.equal(f.amount, 1100); // 部品だけ → ミニ便
f = P.freight(data, [{ code: 'T1', qty: 1 }], { pref: '富山県', date: '2026-11-11' });
assert.ok(f.warnings.some(w => /トナミ/.test(w)));
f = P.freight(data, [{ code: 'T1', qty: 1 }], { pref: '大阪府', date: '2026-11-11', logis: true });
assert.equal(f.quoteAmount, 3120); // 2900÷0.93=3118.3 → 3120
f = P.freight(data, [{ code: 'T1', qty: 1 }], { pref: '沖縄県', date: '2026-11-11' });
assert.equal(f.amount, null);
// オプションは本体と一緒なら本体の運賃に含める。部品のまとめコードは知らせる
f = P.freight(data, [{ code: 'T1', qty: 1 }, { code: 'OP/X', qty: 1 }], { pref: '東京都', date: '2026-11-11' });
assert.equal(f.amount, 2300);
f = P.freight(data, [{ code: 'DANDY/P', qty: 3 }], { pref: '東京都', date: '2026-11-11' });
assert.equal(f.amount, 600); // 小さな荷物1個としてミニ便
assert.ok(f.warnings.some(w => /まとめコード/.test(w)));
f = P.freight(data, [{ code: 'NOW', qty: 1 }, { code: 'T1', qty: 1 }], { pref: '東京都', date: '2026-11-11' });
assert.ok(f.warnings.some(w => /重さがわからない/.test(w)));
assert.equal(f.amount, 2300); // わかる分だけで出す

// --- 説明の文章・判定の表・詳細ログ・前回の受注との見比べ ---
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('S01', 'G1', "5掛(A')") });
const ck = Object.fromEntries(r.checks.map(c => [c.item, c]));
assert.equal(ck['在庫価格'].state, 'on');
assert.equal(ck['例外'].state, 'warn'); // 未整理の参考行がある
assert.equal(ck['特別な計算'].state, 'off');
assert.ok(/在庫口なので、在庫価格（4掛）を使いました/.test(r.summary));
assert.ok(/旧定価のままの得意先なら 11,360円/.test(r.summary));
assert.deepEqual(r.steps.map(s => s.amount), [31300, 15650, 12520]); // 定価 → ランク → 在庫価格
assert.equal(P.compareOrder(r, { date: '20261109', price: 11360 }), 'old');
assert.equal(P.compareOrder(r, { date: '20261109', price: 12520 }), 'same');
assert.equal(P.compareOrder(r, { date: '20261020', price: 11360 }), 'before');
assert.equal(P.compareOrder(r, { date: '20261109', price: 9999 }), 'diff');
assert.ok(/旧定価の 11,360円/.test(P.compareSentence(r, [{ date: '20261109', price: 11360 }])));
r = P.unitPrice(data, { code: 'T1', qty: 60, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.ok(/「全員・50台以上」の例外（4.5掛）が登録されているため、ランクより例外を優先しました/.test(r.summary));
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-10-28', customer: cust('H01', 'G3', '5.25掛(A)') });
assert.ok(/本部経由の得意先なので、販社への見積は 16,040円/.test(r.summary));
assert.equal(r.checks.find(c => c.item === '特別な計算').text, '本部経由');
r = P.unitPrice(data, { code: 'PB', qty: 1, date: '2026-10-29', customer: cust('C4', 'G4', 'その他') });
assert.ok(/決まった金額が登録されているため/.test(r.summary) && /運賃込みの得意先なので/.test(r.summary));
f = P.freight(data, [{ code: 'T1', qty: 1 }, { code: 'OP/X', qty: 1 }], { pref: '東京都', date: '2026-11-11', personal: true });
assert.ok(/送料は 東京都あて（南関東・西濃運輸）、路線便（合計40kg）で 2,300円 です。オプションは本体と一緒なので/.test(f.summary), f.summary);
assert.ok(/個人宅あてなので2倍の 4,600円/.test(f.summary));
assert.equal(f.checks.find(c => c.item === '個人宅').state, 'on');

// --- 設定の行を人の言葉に・詳細ログの出どころ ---
assert.equal(P.excSentence({ 型式: 'UDGLS', 対象の種類: '社名', 対象コード: 'G1', 対象名: '甲商事', 在庫口のみ: true, 掛率: 0.45, 適用開始日: '2026-01-01' }),
  'UDGLS は、得意先社名「甲商事」あての在庫口の受注なら 定価の4.5掛。ランク・得意先の区分より優先します（例外の中では2番目（得意先社名））。（2026-01-01 から）');
assert.ok(/すべての得意先あての50台以上なら 定価の4.5掛/.test(P.excSentence(data.exceptions[2])));
assert.ok(/1,500円（決まった金額）/.test(P.excSentence(data.exceptions[4])));
assert.ok(/自動では使いません/.test(P.excSentence(data.exceptions[5])));
assert.ok(/台車はランクにかかわらず5.25掛。台車の在庫口あてなら4.5掛/.test(P.clsSentence(data.classes[2])));
assert.ok(/在庫口です/.test(P.clsSentence(data.classes[0])));
assert.ok(/本部経由で計算します/.test(P.clsSentence(data.classes[4])));
assert.ok(/定価で売ります/.test(P.clsSentence(data.classes[6])));
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-11-11', customer: cust('S01', 'G1', "5掛(A')") });
assert.equal(r.steps[0].refKind, 'price'); assert.equal(r.steps[0].ref, data.prices[1]);
assert.equal(r.steps[2].refKind, 'cls'); assert.equal(r.steps[2].ref, data.classes[1]);
r = P.unitPrice(data, { code: 'T1', qty: 60, date: '2026-11-11', customer: cust('C1', 'G9', "5掛(A')") });
assert.equal(r.steps.find(s => s.label === '例外').ref, data.exceptions[2]);
r = P.unitPrice(data, { code: 'T1', qty: 1, date: '2026-10-28', customer: cust('H01', 'G3', '5.25掛(A)') });
assert.equal(r.steps.find(s => s.label === '本部経由').ref, data.classes[4]);

// --- 運賃表の点検 ---
let fc = P.fareChecks(data.fares, '2026-11-11');
assert.equal(fc[0].level, 'ng'); // 見本は3地域しかないので、入っていない県がある
assert.ok(fc.some(c => c.level === 'warn' && /予定/.test(c.text)));
assert.ok(fc.some(c => c.level === 'ok' && /路線便：同じ帯の重なりなし/.test(c.text)));
fc = P.fareChecks(data.fares.concat([{ 種類: '路線便', 地域: '近畿', 上限: 40, 金額: 1000, 適用開始日: '2025-11-12' }, { 種類: '地域', 地域: '近畿2', 県: '大阪' }]), '2026-11-11');
assert.ok(fc.some(c => c.level === 'ng' && /近畿の40kg（2025-11-12 から）が2行/.test(c.text)));
assert.ok(fc.some(c => c.level === 'ng' && /大阪（近畿・近畿2）/.test(c.text)));

// --- 運賃テスト ---
let q = P.fareQuote(data, { pref: '大阪府', kg: 35, date: '2026-11-11' });
assert.equal(q.amount, 2900); assert.ok(/40kg以下の帯/.test(q.explain.join()));
q = P.fareQuote(data, { pref: '東京都', kg: 480, date: '2026-11-11' });
assert.equal(q.amount, 9000 + 3900); assert.ok(/400kgを超えるので/.test(q.explain.join()));
q = P.fareQuote(data, { pref: '東京都', kg: 40, date: '2027-05-01' });
assert.equal(q.amount, 2500); // 将来の改定が効く日付
q = P.fareQuote(data, { pref: '東京都', mode: 'ミニ便', count: 2, date: '2026-11-11', personal: true });
assert.equal(q.amount, 2200);
q = P.fareQuote(data, { pref: '大阪府', kg: 35, date: '2026-11-11', logis: true });
assert.equal(q.quoteAmount, 3120);
q = P.fareQuote(data, { pref: '北海道', kg: 10, date: '2026-11-11' });
assert.ok(/どの地域にも入っていません/.test(q.warnings.join()));

// --- CSV・県 ---
assert.deepEqual(P.parseCSV('﻿a,b\r\n"x,1","y""z"\r\n'), [['a', 'b'], ['x,1', 'y"z']]);
assert.deepEqual(P.toObjects('受注№\t品目ｺｰﾄﾞ\n1\tT1\n', '\t'), [{ '受注№': '1', '品目ｺｰﾄﾞ': 'T1' }]);
assert.equal(P.prefOf('東京都江東区白河2-17-10'), '東京都');
assert.equal(P.prefOf('大阪市北区'), '大阪府'); // 県名を省いた住所も読む
assert.equal(P.prefOf('札幌市中央区'), '');
assert.equal(P.prefOf('北海道札幌市'), '北海道');
const cm = P.customerFromMaster({ '得意先ｺｰﾄﾞ': '1', '得意先名略称': '甲', '得意先社名ｺｰﾄﾞ': 'G1', '掛率名': "5掛(A')" });
assert.equal(cm.shaCode, 'G1'); assert.equal(cm.kakeName, "5掛(A')");

console.log('ok test_price_core');
