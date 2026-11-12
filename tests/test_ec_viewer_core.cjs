// node tests/test_ec_viewer_core.cjs
// EC受注の状況（ec_viewer_core.js）：状況の決め方・検索。ダミーのお客様・ダミーの住所だけを使う（実データは入れない）
const assert = require('assert');
const EC = require('../ec_sales_core.js');
const V = require('../ec_viewer_core.js');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const CUST = ['599801', '599802'];
const sOrder = (o) => Object.assign({ name: '#1', id: '1', head: true, createdAt: '2026-11-05', createdTime: '00:06', financial: 'paid', fulfillment: 'unfulfilled', cancelledAt: '', total: 15950, refunded: 0, email: 'taro@example.com', phone: '',
  tags: '', notes: '', lines: [{ name: 'FLAT CART 2×4（ブルー）', sku: 'FC-24B', qty: 1 }],
  ship: { name: '見本 太郎', company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: '千代田1-1', addr2: '', phone: '090-1234-5678' }, bill: { name: '見本 太郎', phone: '' } }, o);
const row = (juchu, po, over) => Object.assign({ '受注№': juchu, '行': '1', '受注日付': '20261106', '得意先コード': '599802', '納品先名': '見本 太郎 様', '品目コード': 'FCART2x4', '品目名': 'FCART2x4 Blue', '数量': '1.00', '単価': '13000', '金額': '13000', '納期': '20261110', '出荷予定日': '20261110', '客先注番': po }, over || {});
const lookup = EC.shipLookup({ generatedAt: '2026-11-10T01:00:00Z', carriers: { seino: { name: '西濃運輸' } }, ships: [
  { no: 'S1', po: ['1773'], cust: '599802', date: '2026-11-09', juchu: ['27401'], slips: [{ c: 'seino', no: '9072284252' }] },       // 送り状あり
  { no: 'S2', po: ['1774'], cust: '599802', date: '2026-11-10', juchu: ['27402'], slips: [] },                                      // 出荷伝票だけ
  { no: 'S3', po: ['1775'], cust: '341401', date: '2026-11-10', juchu: ['9'], slips: [{ c: 'seino', no: '9072280000' }] }          // ほかの得意先（無視）
] });
const shopify = [
  sOrder({ id: '1772', name: '#1772', fulfillment: 'fulfilled', tags: '川島' }),                  // 完了
  sOrder({ id: '1773', name: '#1773', tags: '利根川' }),                                          // 出荷済
  sOrder({ id: '1774', name: '#1774' }),                                                          // 出荷伝票だけ
  sOrder({ id: '1775', name: '#1775' }),                                                          // 受注なし・出荷はほかの得意先
  sOrder({ id: '1776', name: '#1776', createdAt: '2026-11-08' }),                                // SMILE に受注（出荷はまだ）
  sOrder({ id: '1777', name: '#1777', cancelledAt: '2026-11-09', financial: 'voided' }),          // キャンセル
  sOrder({ id: '1778', name: '#1778', createdAt: '2026-11-11', ship: { name: '山田 花子', company: '㈱テスト商事', zip: '5300001', province: '大阪府', city: '大阪市北区', addr1: '梅田1-1', addr2: '', phone: '06-1234-5678' }, bill: { name: '山田 花子', phone: '' }, lines: [{ name: 'テーブルコンテナ ブラック', sku: 'TCBK', qty: 2 }] })
];
const smileRows = [row('27300', '1772'), row('27401', '1773'), row('27402', '1774'), row('27403', '1776', { '出荷予定日': '20261109', '納期': '20261109' }), row('9', '1775', { '得意先コード': '341401' }),
  row('27500', '1700', { '受注日付': '20250801' }),             // 古い注文（Shopify のデータにない）
  row('99999', 'TEST1780', { '得意先コード': '599802' })];      // テスト送信は除く
const recs = V.build({ shopifyOrders: shopify, smileRows, shipLookup: lookup, custCodes: CUST, today: '2026-11-11' });
const byId = Object.fromEntries(recs.map(r => [r.id, r]));

t('状況：完了・出荷済・出荷待ち（受注伝票作成済）・Shopify受注・キャンセル', () => {
  assert.strictEqual(byId['1772'].stage, 'done');       // Shopify が発送済み
  assert.strictEqual(byId['1773'].stage, 'shipped');    // 送り状番号あり・Shopify はまだ
  assert.strictEqual(byId['1774'].stage, 'wait');       // 出荷伝票あり・送り状まだ
  assert.strictEqual(byId['1776'].stage, 'wait');       // SMILE に受注伝票あり・出荷伝票なし
  assert.strictEqual(byId['1775'].stage, 'shopify');    // SMILE に受注なし。ほかの得意先の出荷は引かない
  assert.strictEqual(byId['1778'].stage, 'shopify');
  assert.strictEqual(byId['1777'].stage, 'cancelled');
  assert.deepStrictEqual(V.STAGES.map(s => s.k), ['shopify', 'wait', 'shipped', 'done']);
});
t('Shopify の注文にない古い注文：SMILE・出荷から判定し、完了にはしない', () => {
  assert.ok(byId['1700'] && byId['1700'].noShopify && byId['1700'].stage === 'wait');
  const old = V.build({ shopifyOrders: [], smileRows: [row('27300', '1701')], shipLookup: EC.shipLookup({ carriers: { seino: { name: '西濃運輸' } }, ships: [{ no: 'S9', po: ['1701'], cust: '599802', date: '2026-10-01', slips: [{ c: 'seino', no: '9072281111' }] }] }), custCodes: CUST, today: '2026-11-11' });
  assert.strictEqual(old[0].stage, 'shipped'); assert.ok(old[0].noShopify);
});
t('SMILE の受注：テスト送信・ほかの得意先は除く／受注№・日付・出荷予定日', () => {
  assert.ok(!byId['1780']);
  assert.deepStrictEqual(byId['1773'].smile.juchuNos, ['27401']);
  assert.strictEqual(byId['1776'].smile.orderDate, '2026-11-06'); assert.strictEqual(byId['1776'].smile.shipPlan, '2026-11-09');
  const m = V.groupSmile([row('1', '5', { '行': '1', '出荷予定日': '20261110' }), row('1', '5', { '行': '2', '出荷予定日': '20261112', '品目コード': 'OP/X' })], CUST);
  assert.strictEqual(m['5'].shipPlan, '2026-11-12'); assert.strictEqual(m['5'].lines.length, 2);   // 出荷予定日は、行の中でいちばん遅い日
});
t('出荷予定日を過ぎた「遅れ」：②受注伝票作成済（出荷待ち）だけ', () => {
  assert.ok(byId['1776'].late);      // 予定 11/9 < 今日 11/11
  assert.ok(byId['1774'].late === true);   // 予定 11/10 < 11/11（出荷伝票だけで、送り状番号がまだ）
  assert.ok(!byId['1773'].late && !byId['1772'].late);   // 出荷済・完了は遅れにしない
  assert.ok(!byId['1700'].late);   // 古い注文（Shopify のデータなし・SMILE の予定日が90日以上前）は遅れにしない
  assert.strictEqual(V.counts(recs).late, 2);
});
t('件数：状況ごと', () => {
  const c = V.counts(recs);
  assert.strictEqual(c.all, recs.length); assert.strictEqual(c.done, 1); assert.strictEqual(c.shipped, 1); assert.strictEqual(c.cancelled, 1);
  assert.strictEqual(c.shopify + c.wait + c.shipped + c.done + c.cancelled, c.all);
});
t('並び：新しい注文から', () => {
  assert.strictEqual(recs[0].id, '1778');            // 11/11
  assert.strictEqual(recs[recs.length - 1].id, '1700');   // 古い注文（Shopify のデータなし）
});
t('検索：番号（注文番号・受注№・送り状番号・電話）。ハイフン・全角・#を無視', () => {
  const S = q => V.filter(recs, { q }).map(r => r.id).sort();
  assert.deepStrictEqual(S('1772'), ['1772']); assert.deepStrictEqual(S('#1772'), ['1772']); assert.deepStrictEqual(S('＃１７７２').length >= 0, true);
  assert.deepStrictEqual(S('27401'), ['1773']);                           // SMILE の受注№
  assert.deepStrictEqual(S('907-228-4252'), ['1773']); assert.deepStrictEqual(S('9072284252'), ['1773']);   // 送り状番号（ハイフンあり・なし）
  assert.deepStrictEqual(S('０９０-１２３４-５６７８').includes('1773'), true);   // 電話（全角）。ハイフンありなし
  assert.ok(S('09012345678').includes('1772'));
  assert.deepStrictEqual(S('1700'), ['1700']);
});
t('検索：名前・会社・メール・住所・商品・担当タグ・状況（かな・全角半角を区別しない）', () => {
  const S = q => V.filter(recs, { q }).map(r => r.id).sort();
  assert.deepStrictEqual(S('山田'), ['1778']); assert.deepStrictEqual(S('テスト商事'), ['1778']); assert.deepStrictEqual(S('てすと商事'), ['1778']);   // カタカナ→ひらがな
  assert.ok(S('TARO@example.com').length >= 5);                               // メール（大文字小文字を区別しない）
  assert.deepStrictEqual(S('大阪市'), ['1778']); assert.deepStrictEqual(S('530-0001'), ['1778']);   // 住所・郵便番号
  assert.deepStrictEqual(S('テーブルコンテナ'), ['1778']); assert.deepStrictEqual(S('tcbk'), ['1778']);   // 商品名・SKU
  assert.deepStrictEqual(S('利根川'), ['1773']);                              // 担当のタグ
  assert.deepStrictEqual(S('キャンセル'), ['1777']);                          // 状況の名前
  assert.ok(S('ｆｃａｒｔ2x4').includes('1776'));                              // SMILE の品目コード（全角→半角・大文字小文字）
  assert.deepStrictEqual(S('fcart24'), []);                                  // 一部でも違えば出ない
});
t('検索：空白で区切った言葉は、すべてを含むものだけ（全角の空白も）', () => {
  const S = q => V.filter(recs, { q }).map(r => r.id).sort();
  assert.deepStrictEqual(S('見本 川島'), ['1772']); assert.deepStrictEqual(S('見本　利根川'), ['1773']);
  assert.deepStrictEqual(S('山田 見本'), []);
  assert.strictEqual(V.filter(recs, { q: '' }).length, recs.length);
  assert.strictEqual(V.filter(recs, { q: '   ' }).length, recs.length);
});
t('絞り込み：状況・期間・運送会社・担当タグ・遅れ', () => {
  const F = f => V.filter(recs, f).map(r => r.id).sort();
  assert.deepStrictEqual(F({ stages: ['done'] }), ['1772']);
  assert.deepStrictEqual(F({ stages: ['shipped', 'done'] }), ['1772', '1773']);
  assert.deepStrictEqual(F({ carrier: 'seino' }), ['1773']);
  assert.deepStrictEqual(F({ tag: '川島' }), ['1772']); assert.deepStrictEqual(F({ tag: '利根川' }), ['1773']);
  assert.deepStrictEqual(F({ late: true }), ['1774', '1776']);
  assert.deepStrictEqual(F({ from: '2026-11-08' }), ['1776', '1778']);                // 注文日が 11/8 以降
  assert.deepStrictEqual(F({ from: '2026-11-08', to: '2026-11-08' }), ['1776']);
  assert.deepStrictEqual(F({ stages: ['wait'], q: '見本' }), ['1700', '1774', '1776']);   // SMILE の納品先名（見本 太郎 様）にも当たる
});
t('日付の表し方', () => {
  assert.strictEqual(V.ymd('20261107'), '2026-11-07'); assert.strictEqual(V.ymd('2026-11-07 10:00'), '2026-11-07'); assert.strictEqual(V.ymd(''), '');
  assert.strictEqual(V.md('2026-11-07'), '11/7(土)'); assert.strictEqual(V.md('x'), '');
  assert.strictEqual(V.todayJst(new Date('2026-11-10T15:30:00Z')), '2026-11-11');   // 日本時間
});
console.log('ec_viewer_core: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
