// node tests/test_ec_dashboard_core.cjs
// EC売上の分析（ec_dashboard_core.js）：売上明細（確定した売上）の読み込み・月別・商品別・地域別・曜日別・時間帯・新規とリピート・出荷日数・前の期間との比較・コメントの文。
// 架空のお客様・架空の住所・架空の金額だけを使う（実データは入れない）
const assert = require('assert');
const D = require('../ec_dashboard_core.js');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const CUST = ['599801', '599802'];
const TODAY = '2026-11-12';   // 木曜日
const row = (po, date, dest, code, name, qty, amt, over) => Object.assign({ '受注№': 'J' + po, '行': '1', '受注日付': date, '得意先コード': '599802', '納品先コード': dest, '納品先名': '見本 太郎 様',
  '品目コード': code, '品目名': name, '数量': String(qty), '金額': String(amt), '客先注番': po }, over || {});
const FC = ['FC-BLUE', 'ﾌﾗｯﾄｶｰﾄ ﾌﾞﾙｰ'], TC = ['TC', 'ﾃｰﾌﾞﾙｺﾝﾃﾅ'], FR = ['FR', 'ｳﾝﾁﾝ'];
const smileRows = [].concat(
  // 10月（先月）
  [row('1001', '20261002', 'D1', ...FC, 2, 26000), row('1001', '20261002', 'D1', ...FR, 1, 1500)],          // 27500 東京都（Shopify は 10/1 の注文）
  [row('1002', '20261005', 'D2', ...FC, 1, 13000), row('1002', '20261005', 'D2', ...FR, 1, 1500)],          // 14500 大阪府
  [row('1003', '20261009', 'D1', ...TC, 2, 10000), row('1003', '20261009', 'D1', ...FR, 1, 1500)],          // 11500 東京都（出荷なし）
  [row('1004', '20261020', 'D3', ...FC, 1, 13000)],                                                          // 13000 愛知県・送料なし
  // 11月（今月・12日まで）
  [row('1005', '20261103', 'D1', ...TC, 1, 5000), row('1005', '20261103', 'D1', ...FR, 1, 1500)],            // 6500
  [row('1006', '20261110', 'D2', ...FC, 1, 13000), row('1006', '20261110', 'D2', ...FR, 1, 1500)],          // 14500
  // 除くもの：テスト送信・EC 以外の得意先・Shopify でキャンセル
  [row('TEST1007', '20261104', 'D1', ...FC, 1, 13000)],
  [row('1008', '20261104', 'D1', ...FC, 1, 13000, { '得意先コード': '341401' })],
  [row('1009', '20261105', 'D1', ...FC, 1, 13000)]
);
const srow = (slip, po, date, dest, code, name, qty, amt, over) => Object.assign({ '売上№': slip, '伝票日付': date, '明細区分': '0', '得意先ｺｰﾄﾞ': '599802', '納品先ｺｰﾄﾞ': dest, '品目ｺｰﾄﾞ': code, '品目名': name,
  '数量': String(qty), '金額': String(amt), '客先注番': po, '返品区分': '0' }, over || {});
const taxRow = (slip, po, date, amt) => srow(slip, po, date, 'D1', '', '消費税等（課税対象額 ' + amt * 10 + '）', 0, amt, { '明細区分': '1' });
const salesRows = [].concat(
  [srow('U1', '1001', '20261002', 'D1', ...FC, 2, 26000), srow('U1', '1001', '20261002', 'D1', ...FR, 1, 1500), taxRow('U1', '1001', '20261002', 2750)],     // 27500 東京都
  [srow('U2', '#1002', '20261005', 'D2', ...FC, 1, 13000), srow('U2', '#1002', '20261005', 'D2', ...FR, 1, 1500)],                                         // 14500 大阪府（客先注番に # がつく）
  [srow('U3', '1003', '20261009', 'D1', ...TC, 1, 5000), srow('U3', '1003', '20261009', 'D1', ...FR, 1, 1500)],                                            // 分納：1枚目
  [srow('U3b', '1003', '20261011', 'D1', ...TC, 1, 5000)],                                                                                                // 分納：2枚目（同じ注文）→ 合わせて 11500
  [srow('U4', '1004', '20261020', 'D3', ...FC, 1, 13000)],                                                                                                // 13000 愛知県・送料なし
  [srow('U5', '1005', '20261103', 'D1', ...TC, 1, 5000), srow('U5', '1005', '20261103', 'D1', ...FR, 1, 1500)],                                            // 6500
  [srow('U6', '1006', '20261110', 'D2', ...FC, 1, 13000), srow('U6', '1006', '20261110', 'D2', ...FR, 1, 1500)],                                          // 14500
  [srow('UT', 'TEST1007', '20261104', 'D1', ...FC, 1, 13000)],                                                                                            // テスト送信は除く
  [srow('UX', '1008', '20261104', 'D1', ...FC, 1, 13000, { '得意先ｺｰﾄﾞ': '341401' })]                                                                      // EC 以外の得意先は除く
);
const nouhinRows = [
  { '得意先コード': '599802', '納品先コード': 'D1', '住所１': '〒100-0001 東京都千代田区千代田1-1' }, { '得意先コード': '599802', '納品先コード': 'D2', '住所１': '大阪府大阪市北区梅田1-1' },
  { '得意先コード': '599802', '納品先コード': 'D3', '住所１': '愛知県名古屋市中区栄1-1' }, { '得意先コード': '599802', '納品先コード': 'D4', '住所１': '' }
];
const sh = (id, date, time, email, total, taxes, over) => Object.assign({ id, name: '#' + id, head: true, createdAt: date, createdTime: time, email, financial: 'paid', fulfillment: 'unfulfilled', cancelledAt: '',
  total, taxes, shipping: 1650, discountAmount: 0, discountCode: '', ship: { province: '' } }, over || {});
const shopifyOrders = [
  sh('1001', '2026-10-01', '09:00', 'c@example.com', 30250, 2750),
  sh('1005', '2026-11-02', '21:30', 'a@example.com', 7150, 650),
  sh('1006', '2026-11-09', '10:15', 'b@example.com', 15950, 1450, { discountCode: 'SAMPLE10', discountAmount: 1000 }),
  sh('1010', '2026-11-04', '23:50', 'a@example.com', 7150, 650),                                 // SMILE にまだ伝票がない注文・同じメールが前にも注文
  sh('1009', '2026-11-05', '12:00', 'd@example.com', 15950, 1450, { cancelledAt: '2026-11-06', financial: 'voided' })
];
const shipLookup = { byPo: {
  '1001': [{ no: 'S1', date: '2026-10-03', cust: '599802' }], '1002': [{ no: 'S2', date: '2026-10-06', cust: '599802' }],
  '1004': [{ no: 'S4', date: '2026-10-21', cust: '341401' }],   // ほかの得意先の出荷は引かない
  '1005': [{ no: 'S5', date: '2026-11-04', cust: '599802' }], '1006': [{ no: 'S6', date: '2026-11-10', cust: '599802' }] } };
const model = D.build({ salesRows, smileRows, nouhinRows, shopifyOrders, shipLookup, custCodes: CUST, today: TODAY });
const byId = Object.fromEntries(model.orders.map(o => [o.id, o]));            // SMILE の受注
const sold = Object.fromEntries(D.orderize(model.sales).map(o => [o.id, o]));   // 売上（注文ごと）

t('日付の小道具：日本時間の今日・月のずらし・月末', () => {
  assert.strictEqual(D.todayJst(new Date('2026-11-11T16:00:00Z')), '2026-11-12');   // UTC の夕方は、日本では翌日
  assert.strictEqual(D.todayJst(new Date('2026-11-11T14:59:00Z')), '2026-11-11');
  assert.strictEqual(D.addMonths('2026-11', -2), '2026-09'); assert.strictEqual(D.addMonths('2026-01', -1), '2025-12'); assert.strictEqual(D.addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(D.lastDay('2026-02'), 28); assert.strictEqual(D.lastDay('2028-02'), 29); assert.strictEqual(D.lastDay('2026-11'), 30);
  assert.strictEqual(D.weekdayOf('2026-11-12'), 4); assert.strictEqual(D.diffDays('2026-10-30', '2026-11-02'), 3);
  assert.deepStrictEqual(D.monthsBetween('2026-10', '2027-01'), ['2026-10', '2026-11', '2026-12', '2027-01']);
});
t('金額の言い方：円・万円・億円', () => {
  assert.strictEqual(D.yen(1234567), '1,234,567円');
  assert.strictEqual(D.yenShort(980), '980円'); assert.strictEqual(D.yenShort(53500), '5.4万円'); assert.strictEqual(D.yenShort(50000), '5万円');
  assert.strictEqual(D.yenShort(1234567), '123万円'); assert.strictEqual(D.yenShort(123456789), '1.2億円'); assert.strictEqual(D.yenShort(-21000), '−2.1万円');
});
t('都道府県：郵便番号が先頭でも読める／地方', () => {
  assert.strictEqual(D.prefOf('〒100-0001 東京都千代田区'), '東京都'); assert.strictEqual(D.prefOf('１００－０００１ 北海道札幌市'), '北海道');
  assert.strictEqual(D.prefOf('神奈川県横浜市'), '神奈川県'); assert.strictEqual(D.prefOf(''), ''); assert.strictEqual(D.prefOf('住所なし'), '');
  assert.strictEqual(D.regionOf('大阪府'), '関西'); assert.strictEqual(D.regionOf('沖縄県'), '九州・沖縄'); assert.strictEqual(D.regionOf('東京都'), '関東'); assert.strictEqual(D.regionOf(''), '不明');
  assert.strictEqual(D.REGIONS.reduce((a, g) => a + g.prefs.length, 0), 47);   // 47都道府県がもれなく入っている
});
t('売上（売上明細）：消費税の行・テスト・ほかの得意先を除く／分納は1注文／送料は別に数える', () => {
  assert.strictEqual(model.sales.length, 7);   // 伝票 U1・U2・U3・U3b・U4・U5・U6
  assert.deepStrictEqual(Object.keys(sold).sort(), ['1001', '1002', '1003', '1004', '1005', '1006']);
  assert.ok(!sold['1007'] && !sold['1008'] && !sold['1009']);
  assert.strictEqual(sold['1001'].amount, 27500); assert.strictEqual(sold['1001'].goods, 26000); assert.strictEqual(sold['1001'].freight, 1500); assert.strictEqual(sold['1001'].qty, 2);   // 消費税の行（2750円）は入らない
  assert.strictEqual(sold['1004'].freight, 0); assert.strictEqual(sold['1004'].amount, 13000);
  assert.strictEqual(sold['1002'].id, '1002');   // 客先注番の # は取る
  assert.strictEqual(sold['1003'].amount, 11500); assert.strictEqual(sold['1003'].date, '2026-10-09'); assert.strictEqual(sold['1003'].qty, 2);   // 分納の2枚をまとめる
  assert.strictEqual(model.sales[0].month, '2026-10'); assert.strictEqual(model.sales[0].date, '2026-10-02');
});
t('SMILE の受注：キャンセルを除く／まだ売上になっていない受注', () => {
  assert.deepStrictEqual(model.orders.map(o => o.id), ['1001', '1002', '1003', '1004', '1005', '1006']);
  assert.ok(!byId['1009'] && !byId['TEST1007'] && !byId['1008']);
  assert.strictEqual(model.info.cancelledOut, 1);
  assert.strictEqual(model.info.notSold, 0);
  const m = D.build({ salesRows, smileRows: smileRows.concat([row('3001', '20261111', 'D1', ...FC, 1, 13000, { '客先注番': '1011' })]), nouhinRows, shopifyOrders, custCodes: CUST });
  assert.strictEqual(m.info.notSold, 1); assert.strictEqual(m.info.notSoldAmount, 13000);   // 受注はあるが、まだ売上伝票がない（出荷前）
});
t('売上明細の見出しの書き方の違い・訂正（マイナス）の行・月またぎの分納', () => {
  const zen = [{ '売上No': 'Z1', '伝票日付': '2026/10/03', '明細区分': '0', '得意先コード': '599801', '納品先コード': 'D1', '品目コード': 'AAA', '品目名': 'ｻﾝﾌﾟﾙ', '数量': '2.00', '金額': '3,000', '客先注番': '#9001' },
    { '売上No': 'Z2', '伝票日付': '2026/10/04', '明細区分': '0', '得意先コード': '599801', '納品先コード': 'D1', '品目コード': 'AAA', '品目名': 'ｻﾝﾌﾟﾙ', '数量': '-1.00', '金額': '-1,500', '客先注番': '#9001' }];
  const m = D.build({ salesRows: zen, nouhinRows, custCodes: CUST });   // 全角の「売上No」「コード」でも読める・金額のカンマも読める
  assert.strictEqual(m.sales.length, 2); assert.strictEqual(m.sales[0].amount, 3000); assert.strictEqual(m.sales[1].amount, -1500);
  assert.strictEqual(m.sales[0].lines[0].name, 'サンプル');
  assert.strictEqual(D.summary(m.sales).sales, 1500); assert.strictEqual(D.summary(m.sales).count, 1); assert.strictEqual(D.summary(m.sales).qty, 1);   // 訂正は差し引いて、1注文
  const two = D.build({ salesRows: [srow('M1', '5001', '20261028', 'D1', ...FC, 1, 13000), srow('M2', '5001', '20261102', 'D1', ...FC, 1, 13000)], nouhinRows, custCodes: CUST });
  const bm = D.byMonth(two.sales, '2026-10', '2026-11'); assert.deepStrictEqual(bm.map(x => x.sales), [13000, 13000]); assert.deepStrictEqual(bm.map(x => x.count), [1, 1]);   // 売上の月は、伝票日付の月（確定した月）
  assert.strictEqual(D.summary(two.sales).count, 1);   // 月をまたぐ範囲では、同じ注文は1件
});
t('売上明細の絞り込み：EC の得意先の行だけを取り出す（4MBずつ・区切りをまたいでも欠けない・文字コードの見分け）', () => {
  const head = ['売上№', '伝票日付', '得意先ｺｰﾄﾞ', '品目名'].map(h => '"' + h + '"').join(',');
  const lines = []; for (let i = 0; i < 200; i++) lines.push(['"U' + i + '"', '"20261001"', '"' + (i % 5 === 0 ? '599802' : '341401') + '"', '"品目' + i + '"'].join(','));
  const text = '\ufeff' + head + '\r\n' + lines.join('\r\n') + '\r\n';
  const buf = new TextEncoder().encode(text);
  const a = D.extractSalesLines(buf, ['599801', '599802'], { chunk: 37 });   // 小さな区切りで何度もまたがせる
  const rows = a.split('\n'); assert.strictEqual(rows[0], head); assert.strictEqual(rows.length, 1 + 40);   // 見出し＋40行
  assert.ok(rows.slice(1).every(r => r.indexOf('599802') >= 0)); assert.strictEqual(rows[1], lines[0]);
  assert.strictEqual(D.extractSalesLines(buf, ['599802']), D.extractSalesLines(buf, ['599802'], { chunk: 1 << 20 }));   // 区切りの大きさに依らない
  assert.strictEqual(D.extractSalesLines(buf.buffer, ['000000']), head + '\n');   // ArrayBuffer でも読める・該当なしなら見出しだけ
  assert.ok(D.extractSalesLines(new TextEncoder().encode('"伝票日付","得意先ｺｰﾄﾞ"\n"1","599802"'), ['599802']).endsWith('"1","599802"'));   // 最後の行に改行がなくても取れる
});
t('商品名：半角カナを全角にして見せる／送料は商品に入れない', () => {
  assert.strictEqual(sold['1001'].lines.length, 1); assert.strictEqual(sold['1001'].lines[0].name, 'フラットカート ブルー');
  assert.strictEqual(sold['1003'].lines[0].name, 'テーブルコンテナ');
});
t('地域：納品先から都道府県（住所なしは不明）', () => {
  assert.strictEqual(sold['1001'].pref, '東京都'); assert.strictEqual(sold['1001'].region, '関東'); assert.strictEqual(sold['1002'].region, '関西'); assert.strictEqual(sold['1004'].pref, '愛知県');
  const m = D.build({ salesRows: [srow('N1', '2001', '20261101', 'D4', ...FC, 1, 13000)], nouhinRows, custCodes: CUST });
  assert.strictEqual(m.sales[0].pref, ''); assert.strictEqual(m.sales[0].region, '不明');
  const m2 = D.build({ salesRows: [srow('N2', '2002', '20261101', 'D4', ...FC, 1, 13000)], nouhinRows, shopifyOrders: [sh('2002', '2026-11-01', '10:00', 'z@example.com', 1, 0, { ship: { province: '福岡県' } })], custCodes: CUST });
  assert.strictEqual(m2.sales[0].pref, '福岡県');   // 納品先で分からないときは、Shopify の届け先の県
});
t('出荷までの日数：Shopify の注文日（なければ受注日）から、いちばん早い出荷日まで。ほかの得意先の出荷は引かない', () => {
  assert.strictEqual(byId['1001'].shipDays, 2);   // 10/1 の注文 → 10/3 出荷（SMILE の受注日 10/2 ではなく Shopify の注文日から）
  assert.strictEqual(byId['1002'].shipDays, 1);   // Shopify なし：受注日 10/5 → 10/6
  assert.strictEqual(byId['1003'].shipDays, null); assert.strictEqual(byId['1004'].shipDays, null);
  assert.strictEqual(byId['1005'].shipDays, 2); assert.strictEqual(byId['1006'].shipDays, 1);
});
t('Shopify の注文：キャンセルを除く／リピート（前にも同じメール）／SMILE にまだない注文', () => {
  assert.deepStrictEqual(model.shop.map(o => o.id), ['1001', '1005', '1010', '1006']);   // 注文した日時の順
  const rp = Object.fromEntries(model.shop.map(o => [o.id, o.repeat]));
  assert.deepStrictEqual(rp, { 1001: false, 1005: false, 1010: true, 1006: false });
  assert.strictEqual(model.info.waiting, 1); assert.strictEqual(model.info.shopCancelled, 1);
  assert.strictEqual(model.info.shopFrom, '2026-10-01'); assert.strictEqual(model.info.shopTo, '2026-11-09');
  assert.strictEqual(model.shop.find(o => o.id === '1005').amount, 6500);   // 税抜（合計 − 消費税）
  assert.strictEqual(model.shop.find(o => o.id === '1006').hour, 10);
});
t('期間：今月（途中）は、先月の同じ日数までと比べる', () => {
  const p = D.period({ from: '2026-11', to: '2026-11' }, TODAY);
  assert.deepStrictEqual(p.cur, { start: '2026-11-01', end: '2026-11-12' }); assert.deepStrictEqual(p.prev, { start: '2026-10-01', end: '2026-10-12' });
  assert.ok(p.partial); assert.strictEqual(p.labels.cur, '今月'); assert.strictEqual(p.labels.prev, '先月');
});
t('期間：終わった月は丸ごと／3か月は前の3か月と比べる／年またぎ・月末', () => {
  const p = D.period({ from: '2026-10', to: '2026-10' }, TODAY);
  assert.deepStrictEqual(p.cur, { start: '2026-10-01', end: '2026-10-31' }); assert.deepStrictEqual(p.prev, { start: '2026-09-01', end: '2026-09-30' }); assert.ok(!p.partial); assert.strictEqual(p.labels.cur, '10月');
  const q = D.period({ from: '2026-09', to: '2026-11' }, TODAY);
  assert.deepStrictEqual(q.cur, { start: '2026-09-01', end: '2026-11-12' }); assert.deepStrictEqual(q.prev, { start: '2026-06-01', end: '2026-08-12' }); assert.strictEqual(q.labels.cur, 'この期間');
  const y = D.period({ from: '2026-01', to: '2026-01' }, '2026-01-31');
  assert.deepStrictEqual(y.prev, { start: '2025-12-01', end: '2025-12-31' });   // 月末の日は、前の月の月末まで
  const m = D.period({ from: '2026-03', to: '2026-03' }, '2026-03-30');
  assert.deepStrictEqual(m.prev, { start: '2026-02-01', end: '2026-02-28' });   // 3/30 → 2月は28日まで
  const sw = D.period({ from: '2026-11', to: '2026-10' }, TODAY); assert.strictEqual(sw.from, '2026-10');   // 開始と終了が逆でも読める
});
t('範囲のあらかじめの選び方', () => {
  assert.deepStrictEqual(D.preset('3m', TODAY), { from: '2026-09', to: '2026-11' }); assert.deepStrictEqual(D.preset('year', TODAY), { from: '2026-01', to: '2026-11' });
  assert.deepStrictEqual(D.preset('lastYear', TODAY), { from: '2025-01', to: '2025-12' }); assert.deepStrictEqual(D.preset('thisMonth', TODAY), { from: '2026-11', to: '2026-11' });
  assert.deepStrictEqual(D.preset('all', TODAY, '2025-04'), { from: '2025-04', to: '2026-11' }); assert.deepStrictEqual(D.preset('6m', TODAY), { from: '2026-06', to: '2026-11' });
});
t('数字のカード：売上・件数・客単価・1注文あたりの点数', () => {
  const s = D.summary(model.sales.filter(o => o.month === '2026-10'));
  assert.strictEqual(s.count, 4); assert.strictEqual(s.sales, 27500 + 14500 + 11500 + 13000); assert.strictEqual(s.freight, 4500); assert.strictEqual(s.goods, 62000);
  assert.strictEqual(s.qty, 2 + 1 + 2 + 1); assert.strictEqual(s.avg, 66500 / 4); assert.strictEqual(s.avgQty, 6 / 4);
  const z = D.summary([]); assert.strictEqual(z.avg, 0); assert.strictEqual(z.avgQty, 0);
});
t('月別：月の数だけ並ぶ（注文のない月は 0）', () => {
  const a = D.byMonth(model.sales, '2026-09', '2026-11');
  assert.deepStrictEqual(a.map(x => x.month), ['2026-09', '2026-10', '2026-11']);
  assert.deepStrictEqual(a.map(x => x.count), [0, 4, 2]); assert.deepStrictEqual(a.map(x => x.sales), [0, 66500, 21000]);
});
t('商品別：売上順・台数・注文数・構成比（送料は入れない）', () => {
  const list = D.byProduct(model.sales);
  assert.strictEqual(list[0].code, 'FC-BLUE'); assert.strictEqual(list[0].qty, 5); assert.strictEqual(list[0].sales, 26000 + 13000 + 13000 + 13000); assert.strictEqual(list[0].orders, 4);
  assert.strictEqual(list[1].code, 'TC'); assert.strictEqual(list[1].qty, 3); assert.strictEqual(list[1].sales, 15000);
  assert.ok(!list.some(x => x.code === 'FR'));
  assert.ok(Math.abs(list.reduce((a, x) => a + x.share, 0) - 100) < 1e-9);
});
t('地域別：件数・構成比・都道府県／住所不明は分けて数える', () => {
  const g = D.byRegion(model.sales);   // 10月と11月の全注文：東京3（1001・1003・1005）・大阪2・愛知1
  assert.strictEqual(g.regions[0].name, '関東'); assert.strictEqual(g.regions[0].count, 3); assert.strictEqual(g.regions[0].share, 50);
  assert.strictEqual(g.regions[1].name, '関西'); assert.strictEqual(g.regions[1].count, 2); assert.strictEqual(g.regions[2].name, '中部');
  assert.strictEqual(g.prefs[0].name, '東京都'); assert.strictEqual(g.prefs[0].sales, 27500 + 11500 + 6500); assert.strictEqual(g.prefs.length, 3); assert.strictEqual(g.unknown, 0);
  const u = D.byRegion([{ pref: '', region: '不明', amount: 1 }, { pref: '東京都', region: '関東', amount: 10 }]);
  assert.strictEqual(u.unknown, 1); assert.strictEqual(u.known, 1); assert.strictEqual(u.regions[0].share, 100);
});
t('曜日別：月曜はじまり・Shopify の注文した日（日本時間）', () => {
  const shop = D.pickShop(model.shop, { start: '2026-11-01', end: '2026-11-12' });   // 1005(月)・1010(水)・1006(月)
  const w = D.byWeekday(shop);
  assert.deepStrictEqual(w.map(x => x.name), ['月', '火', '水', '木', '金', '土', '日']);
  assert.deepStrictEqual(w.map(x => x.count), [2, 0, 1, 0, 0, 0, 0]); assert.ok(Math.abs(w[0].share - 200 / 3) < 1e-9);
  assert.strictEqual(w[0].sales, 6500 + 14500);
});
t('時間帯別：時ごと・帯ごと', () => {
  const shop = D.pickShop(model.shop, { start: '2026-11-01', end: '2026-11-12' });
  const h = D.byHour(shop); assert.strictEqual(h.length, 24); assert.strictEqual(h[21].count, 1); assert.strictEqual(h[23].count, 1); assert.strictEqual(h[10].count, 1);
  const b = D.hourBands(h); assert.deepStrictEqual(b.map(x => x.count), [0, 1, 0, 2]); assert.strictEqual(b[3].k, '夜');
});
t('新規とリピート：メールで見分ける（メールなしは不明）', () => {
  const g = D.byRepeat(D.pickShop(model.shop, { start: '2026-11-01', end: '2026-11-12' }));
  assert.strictEqual(g.repeat.count, 1); assert.strictEqual(g['new'].count, 2); assert.strictEqual(g.known, 3); assert.ok(Math.abs(g.repeat.share - 100 / 3) < 1e-9); assert.strictEqual(g.repeat.avg, 6500);
  const u = D.byRepeat([{ unknownMail: true, amount: 100 }, { repeat: false, amount: 100 }]); assert.strictEqual(u.unknown.count, 1); assert.strictEqual(u.known, 1);
});
t('出荷までの日数：区切り・平均・真ん中・未出荷', () => {
  const s = D.byShipDays(model.orders.filter(o => o.month === '2026-10'));   // 1001=2日・1002=1日・1003/1004=出荷なし
  assert.strictEqual(s.shipped, 2); assert.strictEqual(s.notShipped, 2); assert.strictEqual(s.avg, 1.5); assert.strictEqual(s.median, 1.5); assert.strictEqual(s.max, 2);
  assert.deepStrictEqual(s.buckets.map(x => x.count), [0, 1, 1, 0, 0, 0]); assert.strictEqual(s.within(1), 1);
  const e = D.byShipDays([]); assert.strictEqual(e.shipped, 0); assert.strictEqual(e.avg, 0);
  const k = D.byShipDays([{ shipDays: 0 }, { shipDays: 5 }, { shipDays: 12 }]); assert.deepStrictEqual(k.buckets.map(x => x.count), [1, 0, 0, 0, 1, 1]); assert.strictEqual(k.median, 5);
});
t('送料と値引き', () => {
  const f = D.freightInfo(model.sales, model.shop);
  assert.strictEqual(f.freight, 1500 * 5); assert.strictEqual(f.charged, 5); assert.strictEqual(f.free, 1); assert.strictEqual(f.avgCharged, 1500);
  assert.strictEqual(f.discountOrders, 1); assert.strictEqual(f.discountTotal, 1000); assert.strictEqual(f.codes[0].code, 'SAMPLE10'); assert.strictEqual(f.shopCount, 4);
});
t('前の期間との差：商品ごと', () => {
  const cur = model.sales.filter(o => o.month === '2026-11'), prev = model.sales.filter(o => o.date <= '2026-10-12');
  const d = D.productDelta(cur, prev);
  assert.strictEqual(d[0].code, 'FC-BLUE'); assert.strictEqual(d[0].dSales, 13000 - 39000); assert.strictEqual(d[0].dQty, -2); assert.strictEqual(d[0].prevQty, 3);
  assert.strictEqual(D.productDelta([], prev).length, 2);   // 今は何も売れていない商品も、差に出る
});
t('コメント（売上）：先月より減った・主な理由・件数と1注文あたり', () => {
  const a = D.analyze(model, { from: '2026-11', to: '2026-11' }, TODAY), c = a.comments.sales;
  assert.strictEqual(a.cur.count, 2); assert.strictEqual(a.cur.sales, 21000); assert.strictEqual(a.prev.count, 3); assert.strictEqual(a.prev.sales, 53500);
  assert.ok(c[0].startsWith('今月の売上は先月より 61% 減っています（5.4万円 → 2.1万円）。'), c[0]);
  assert.ok(c[0].includes('先月の同じ日数までと比べています'));
  assert.strictEqual(c[1], '主な理由は、フラットカート ブルーの台数が減ったことです（3台 → 1台）。');
  assert.ok(c[2].includes('注文は 3件 → 2件（−33%）') && c[2].includes('1注文あたりの金額は 1.8万円 → 1.1万円（−41%）'), c[2]);
});
t('コメント（売上）：増えた・ほぼ同じ・前が0件・今も0件', () => {
  const cur = { count: 5, sales: 200000, goods: 180000, avg: 40000 }, prev = { count: 4, sales: 100000, goods: 90000, avg: 25000 };
  const p = D.period({ from: '2026-10', to: '2026-10' }, TODAY);
  const up = D.commentSales(cur, prev, [{ name: '見本商品', dSales: 90000, dQty: 6, qty: 6, prevQty: 0, sales: 90000, prevSales: 0 }], p);
  assert.ok(up[0].includes('10月の売上は9月より 100% 増えています')); assert.strictEqual(up[1], '主な理由は、見本商品が新しく売れたことです（6台・9万円）。');
  const up2 = D.commentSales(cur, prev, [{ name: '見本商品', dSales: 90000, dQty: 2, qty: 5, prevQty: 3, sales: 90000, prevSales: 0 }], p);
  assert.strictEqual(up2[1], '主な理由は、見本商品の台数が増えたことです（3台 → 5台）。');
  const price = D.commentSales(cur, prev, [{ name: '見本商品', dSales: 90000, dQty: 0, qty: 3, prevQty: 3, sales: 190000, prevSales: 100000 }], p);
  assert.ok(price[1].includes('見本商品の売上が増えた'));   // 台数は同じで金額が変わったとき
  const flat = D.commentSales({ count: 4, sales: 100200, goods: 1, avg: 25050 }, prev, [], p); assert.ok(flat[0].includes('10月の売上は、9月とほぼ同じです'));
  const nop = D.commentSales(cur, { count: 0, sales: 0, goods: 0, avg: 0 }, [], p); assert.ok(nop[0].includes('9月は注文がないため、比べられません'));
  assert.deepStrictEqual(D.commentSales({ count: 0, sales: 0, goods: 0, avg: 0 }, { count: 0, sales: 0, goods: 0, avg: 0 }, [], p), ['この期間は、注文がありません。']);
  const small = D.commentSales({ count: 5, sales: 105000, goods: 99000, avg: 21000 }, prev, [{ name: '見本商品', dSales: 1000, dQty: 1, qty: 1, prevQty: 0, sales: 1000, prevSales: 0 }], p);
  assert.strictEqual(small.length, 2);   // 差が小さいときは、無理に理由を書かない
});
t('コメント（月別）：いちばん多い月・途中の月の注意', () => {
  const a = D.analyze(model, { from: '2026-09', to: '2026-11' }, TODAY), c = a.comments.monthly;
  assert.ok(c[0].includes('売上がいちばん多かったのは 2026年10月（6.7万円・4件）'), c[0]);
  assert.ok(c.some(x => x.includes('2026年11月は途中（12日まで）')));
  const one = D.analyze(model, { from: '2026-10', to: '2026-10' }, TODAY).comments.monthly; assert.ok(one[0].includes('この期間の売上は 6.7万円（4件）'));
  const rise = D.commentMonthly([{ month: '2026-07', sales: 10, count: 1 }, { month: '2026-08', sales: 20, count: 1 }, { month: '2026-09', sales: 30, count: 1 }], { partial: false, to: '2026-09', cur: { end: '2026-09-30' } });
  assert.ok(rise.some(x => x.includes('続けて増えています')));
});
t('コメント（商品・地域）', () => {
  const a = D.analyze(model, { from: '2026-09', to: '2026-11' }, TODAY);
  assert.ok(a.comments.products[0].startsWith('売れ筋は フラットカート ブルー（売上の 81%・5台）、次が テーブルコンテナ（19%・3台） です。'), a.comments.products[0]);
  assert.strictEqual(a.comments.region[0], '関東の注文が 50% を占め、次は 関西 で 33% です。');
  assert.ok(a.comments.region[1].includes('東京都 がいちばん多く（3件・50%）、3都道府県から注文があります'));
  assert.deepStrictEqual(D.commentRegion({ known: 0 }), ['この期間は、届け先が分かる注文がありません。']);
});
t('コメント（曜日・時間帯・リピート・出荷・送料）', () => {
  const a = D.analyze(model, { from: '2026-11', to: '2026-11' }, TODAY), c = a.comments;
  assert.strictEqual(c.weekdayShop[0], '注文が 3件と少ないので、傾向は参考程度に見てください。');   // Shopify：注文した日の曜日
  assert.ok(c.weekdayShop[1].startsWith('注文は月曜と水曜に多い傾向です（全体の 100%）')); assert.ok(c.weekdayShop.some(x => x.startsWith('土日の注文は、全体の 0%')));
  assert.strictEqual(c.weekday[0], '注文が 2件と少ないので、傾向は参考程度に見てください。');   // 売上明細：売上の日（出荷した日）の曜日（11/3 と 11/10 はどちらも火曜）
  assert.ok(c.weekday[1].startsWith('売上の日（出荷した日）は火曜と')); assert.ok(c.weekday.some(x => x.startsWith('土日の売上は、全体の 0%')));
  assert.ok(c.hour.some(x => x.includes('夜（18〜23時） が 67%')), c.hour.join('|'));
  assert.ok(c.repeat[0].includes('リピート') && c.repeat[0].includes('1件、全体の 33%')); assert.ok(c.repeat.some(x => x.includes('直近55日')));
  assert.ok(c.ship[0].includes('平均 1.5日') && c.ship[0].includes('100% の注文は、2日以内'), c.ship[0]);
  assert.ok(c.freight[0].includes('送料は 3,000円（売上の 14.3%）'), c.freight[0]); assert.ok(c.freight.some(x => x.includes('3件のうち 1件で使われ')));
  // 少ないデータ・何もないとき
  const none = D.analyze(model, { from: '2026-05', to: '2026-05' }, TODAY).comments;
  assert.ok(none.weekdayShop[0].includes('Shopify の注文がありません')); assert.strictEqual(none.weekday[0], 'この期間は、売上がありません。'); assert.ok(none.hour[0].includes('Shopify の注文がありません')); assert.ok(none.repeat[0].includes('Shopify の注文がありません'));
  assert.strictEqual(none.sales[0], 'この期間は、注文がありません。'); assert.strictEqual(none.ship[0], 'この期間は、出荷が確認できた注文がありません。');
});
t('曜日：十分な件数があれば注意書きは出ず、少ない曜日にも触れる', () => {
  const shop = []; for (let i = 0; i < 30; i++) shop.push({ date: i < 12 ? '2026-11-03' : i < 22 ? '2026-11-04' : i < 28 ? '2026-11-05' : '2026-11-08', amount: 100 });   // 火12・水10・木6・日2
  const c = D.commentWeekday(D.byWeekday(shop));
  assert.strictEqual(c[0], '注文は火曜と水曜に多い傾向です（全体の 73%）。'); assert.ok(c[1].startsWith('土曜は少なめです（0%）')); assert.ok(c[2].includes('土日の注文は、全体の 7%'));
});
t('分析まとめ：画面が使う形（月ごとの送料も）', () => {
  const a = D.analyze(model, { from: '2026-09', to: '2026-11' }, TODAY);
  assert.deepStrictEqual(Object.keys(a.comments).sort(), ['freight', 'hour', 'monthly', 'products', 'region', 'repeat', 'sales', 'ship', 'weekday', 'weekdayShop']);
  assert.strictEqual(a.series.length, 3); assert.deepStrictEqual(a.frSeries.map(x => x.freight), [0, 4500, 3000]); assert.strictEqual(a.shopCount, 4);
  assert.strictEqual(a.period.cur.end, TODAY);
  const e = D.analyze({ sales: [], orders: [], shop: [] }, { from: '2026-11', to: '2026-11' }, TODAY);   // データが何もなくても止まらない
  assert.strictEqual(e.cur.count, 0); assert.strictEqual(e.series.length, 1);
});

console.log(n + ' 件のテストが通りました');
