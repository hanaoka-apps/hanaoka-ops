// node tests/test_ec_sales_core.cjs
// 末尾の「実データ」は、手元に SMILE 出力・Shopify CSV がある PC だけ動く（なければ飛ばす）
const assert = require('assert');
const fs = require('fs');
const EC = require('../ec_sales_core.js');
const L = require('../ec_sales_layouts.js');
const CONF = JSON.parse(fs.readFileSync(__dirname + '/../ec_sales_config.json', 'utf8'));
const DEFAULT_MAPPING = CONF.mapping, DEFAULT_CONFIG = CONF.config;
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const ITEMS = {
  FCART2x4BK: { name: 'FCART2x4 Black', unit: '台', teihai: '1' }, FCART2x4: { name: 'FCART2x4 Blue', unit: '台', teihai: '1' },
  FCARTDIN: { name: 'FCART DINING', unit: '台', teihai: '1' }, TC: { name: 'ﾃｰﾌﾞﾙｺﾝﾃﾅ', unit: '個', teihai: '1' }, TCBK: { name: 'ﾃｰﾌﾞﾙｺﾝﾃﾅ ﾌﾞﾗｯｸ', unit: '個', teihai: '1' },
  FR: { name: 'ｳﾝﾁﾝ', unit: '式', teihai: '2' }, 'OP/CUP': { name: 'ｶｯﾌﾟﾎﾙﾀﾞｰ', unit: '式', teihai: '1' }, 'OP/2x4-BAG': { name: 'ﾊﾞｯｸﾞ', unit: '枚', teihai: '1' }
};
const ctx = { mapping: DEFAULT_MAPPING, cfg: DEFAULT_CONFIG, items: ITEMS };
function order(over) {
  return Object.assign({ name: '#1800', id: '1800', createdAt: '2026-10-15', createdTime: '12:00', financial: 'paid', fulfillment: 'unfulfilled', cancelledAt: '',
    total: 17050, subtotal: 15400, shipping: 1650, discountAmount: 0, discountCode: '', refunded: 0, paymentMethod: 'Shopify Payments', notes: '',
    lines: [{ name: 'FLATCART 2x4（ブラック） - オプションは注文しない', sku: '', qty: 1, price: 15400 }],
    ship: { name: '中村達生', company: '', zip: '745-0803', province: '山口県', city: '周南市', addr1: '大島５−２８', addr2: '', phone: '09046941826' }, bill: { phone: '' }, phone: '' }, over);
}

t('CSV：引用符・改行・BOM', () => {
  const r = EC.parseDelimited('\uFEFFa,b\r\n"x,1","y\n2"\r\n', ',');
  assert.deepStrictEqual(r, [['a', 'b'], ['x,1', 'y\n2']]);
  assert.strictEqual(EC.detectDelim('"a"\t"b"\t"c"\n'), '\t');
});
t('祝日：2026', () => {
  const h = EC.japaneseHolidays(2026);
  assert.strictEqual(h['2026-09-21'], '敬老の日'); assert.strictEqual(h['2026-09-22'], '国民の休日'); assert.strictEqual(h['2026-09-23'], '秋分の日');
  assert.strictEqual(h['2026-10-12'], 'スポーツの日'); assert.strictEqual(h['2026-05-06'], '振替休日');
});
t('営業日：2営業日後・週末・年末年始', () => {
  const c = EC.makeCalendar({ closedYearly: [['12-29', '01-03']] });
  assert.strictEqual(c.add('2026-10-15', 2), '2026-10-19');   // 木 → 月
  assert.strictEqual(c.add('2026-10-17', 2), '2026-10-20');   // 土 → 火（月が1日目）
  assert.strictEqual(c.add('2026-12-28', 2), '2027-01-05');
  assert.strictEqual(c.prev('2026-10-19'), '2026-10-16');
});
t('得意先：1〜7日は東京（2026/9以降）', () => {
  assert.strictEqual(EC.customerFor('2026-10-07', DEFAULT_CONFIG), '599801'); assert.strictEqual(EC.customerFor('2026-10-08', DEFAULT_CONFIG), '599802');
  assert.strictEqual(EC.customerFor('2026-08-03', DEFAULT_CONFIG), '599802');
});
t('本体のみ：税込合計÷1.1、送料1,500', () => {
  const s = EC.buildSlip(order(), ctx);
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.qty, l.unitNet, l.amountNet]), [['FCART2x4BK', 1, 14000, 14000], ['FR', 1, 1500, 1500]]);
  assert.strictEqual(s.shipDate, '2026-10-19'); assert.strictEqual(s.grossTotal, 17050); assert.strictEqual(s.flags.filter(f => f.level === 'error').length, 0);
});
t('本体＋オプション：コンテナ2個追加', () => {
  const o = order({ total: 17050 + 15400, lines: [{ name: 'FLATCART 2x4（ブラック） - テーブルコンテナ(ブラック)2個追加', sku: '', qty: 1, price: 30800 }] });
  const s = EC.buildSlip(o, ctx);
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.qty, l.unitNet]), [['FCART2x4BK', 1, 14000], ['TCBK', 2, 7000], ['FR', 1, 1500]]);
});
t('値引き：本体が吸収。ギフティングは0円・送料なし', () => {
  const d = EC.buildSlip(order({ total: 11000, discountCode: 'X', discountAmount: 6050 }), ctx);
  assert.deepStrictEqual(d.lines.map(l => l.unitNet), [8500, 1500]);
  const g = EC.buildSlip(order({ total: 0, discountCode: 'FREE, FREE_SHIPPING' }), ctx);
  assert.deepStrictEqual(g.lines.map(l => [l.code, l.amountNet]), [['FCART2x4BK', 0]]); assert.strictEqual(g.memo, '花岡EC（ギフティング）');
});
t('送料無料コード：送料行なし・本体は定価', () => {
  const s = EC.buildSlip(order({ total: 15400, discountCode: 'FREE_SHIPPING' }), ctx);
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.amountNet]), [['FCART2x4BK', 14000]]);
});
t('DINING＋コンテナ2個セット＋追加2個 → 同じ品目は1行にまとめる', () => {
  const o = order({ total: 58300 + 1650, lines: [{ name: 'FLATCART DINING テーブルコンテナ/ブラック(2個)セット - テーブルコンテナ(ブラック)2個追加', sku: '', qty: 1, price: 58300 }] });
  const s = EC.buildSlip(o, ctx);
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.qty, l.unitNet]), [['FCARTDIN', 1, 25000], ['TCBK', 4, 7000], ['FR', 1, 1500]]);
});
t('未対応の商品はエラー、品切れ案内の日付は出荷予定日に反映', () => {
  const u = EC.buildSlip(order({ lines: [{ name: 'XA-Pグレー_廃盤モデル - ペダルブレーキ追加', sku: '', qty: 1, price: 61831 }] }), ctx);
  assert.ok(u.flags.some(f => f.level === 'error'));
  const s = EC.buildSlip(order({ createdAt: '2026-08-14', lines: [{ name: 'FLATCART 2x4（ブルー）　　　※次回発送は8月20日以降になります。 - オプションは注文しない', sku: '', qty: 1, price: 14300 }] }), ctx);
  assert.strictEqual(s.shipDate, '2026-08-20');
});
t('キャンセル・二重取込の印', () => {
  assert.ok(EC.buildSlip(order({ cancelledAt: '2026-10-16' }), ctx).excluded);
  assert.ok(EC.buildSlip(order(), Object.assign({}, ctx, { smileOrders: { '1800': true } })).inSmile);
});
t('納品先：個人は「様」、会社は会社名＋荷受け人、住所の重複除去、電話整形', () => {
  const d = EC.deliveryFromOrder(order());
  assert.strictEqual(d.name, '中村達生様'); assert.strictEqual(d.addr1, '山口県周南市'); assert.strictEqual(d.addr2, '大島５−２８'); assert.strictEqual(d.tel, '090-4694-1826');
  const c = EC.deliveryFromOrder(order({ ship: { name: '山田', company: '(株)テスト', zip: '5670085', province: '大阪府', city: '茨木市彩都あさぎ2-1-6', addr1: '大阪府', addr2: '', phone: '+818030392250' } }));
  assert.strictEqual(c.name, '(株)テスト'); assert.strictEqual(c.person, '山田様'); assert.strictEqual(c.zip, '567-0085'); assert.strictEqual(c.tel, '080-3039-2250');
});
t('納品先コード：既存を再利用・新規は最大＋1・飛び番を避ける・同じ人は1つ', () => {
  const master = EC.indexDeliveryMaster([
    { '得意先ｺｰﾄﾞ': '599802', '納品先ｺｰﾄﾞ': '000999', '納品先名': '浅井 豊様', '郵便番号': '478-0001', '荷受け人名１': '' },
    { '得意先ｺｰﾄﾞ': '599802', '納品先ｺｰﾄﾞ': '001000', '納品先名': 'x', '郵便番号': '', '荷受け人名１': '' },
    { '得意先ｺｰﾄﾞ': '599802', '納品先ｺｰﾄﾞ': '599802', '納品先名': 'y', '郵便番号': '', '荷受け人名１': '' }], DEFAULT_CONFIG);
  assert.strictEqual(master['599802'].max, '000999');
  const mk = (id, name, zip) => EC.buildSlip(order({ id, name: '#' + id, ship: { name, company: '', zip, province: '東京都', city: '千代田区', addr1: '1-1', addr2: '', phone: '' } }), ctx);
  const a = mk('1', '浅井豊', '478-0001'), b = mk('2', '新規 太郎', '100-0001'), c = mk('3', '新規太郎', '100-0001'), d = mk('4', '別人', '100-0002');
  const fresh = EC.planDeliveries([a, b, c, d], master, DEFAULT_CONFIG);
  assert.strictEqual(a.deliveryCode, '000999'); assert.strictEqual(b.deliveryCode, '001001'); assert.strictEqual(c.deliveryCode, '001001'); assert.strictEqual(d.deliveryCode, '001002');
  assert.strictEqual(fresh.length, 2);
});
t('取込ファイル：受注の行・UTF-16', () => {
  const s = EC.buildSlip(order(), ctx); s.deliveryCode = '000771'; s.delivery = EC.deliveryFromOrder(s.order);
  const rows = EC.juchuRows([s], L.juchu, DEFAULT_CONFIG);
  assert.strictEqual(rows.length, 2); assert.strictEqual(rows[0].length, L.juchu.length);
  const H = k => rows[0][L.juchu.indexOf(k)];
  assert.strictEqual(H('客先注番'), '1800'); assert.strictEqual(H('納期'), '20261019'); assert.strictEqual(H('品目コード'), 'FCART2x4BK'); assert.strictEqual(H('単価'), '14000.00');
  assert.strictEqual(rows[0][109], '20261016'); assert.strictEqual(rows[0][111], '1'); assert.strictEqual(rows[1][109], '0'); assert.strictEqual(rows[1][111], '2');
  const bytes = EC.encodeUtf16(EC.toSmileText(L.juchu, rows));
  assert.strictEqual(bytes[0], 0xFF); assert.strictEqual(bytes[1], 0xFE); assert.strictEqual(bytes.length % 2, 0);
  assert.strictEqual(L.nouhin.length, 42); assert.strictEqual(EC.nouhinRows([{ cust: '599802', code: '000771', d: s.delivery }], L.nouhin, DEFAULT_CONFIG)[0].length, 42);
});
t('入金：入金日×得意先で振込＝純額・手数料の2行', () => {
  const T = [{ Order: '#1', Type: 'charge', 'Payout Date': '2026-10-09', Amount: '17050', Fee: '600', Net: '16450' }, { Order: '#2', Type: 'charge', 'Payout Date': '2026-10-09', Amount: '17050', Fee: '600', Net: '16450' }];
  const g = EC.groupPayouts(T, [{ 'Payout Date': '2026-10-09', Status: 'paid', Total: '32900' }], () => '599802');
  assert.strictEqual(g[0].match, true);
  const r = EC.nyukinRows(g, L.nyukin, DEFAULT_CONFIG);
  assert.strictEqual(r.length, 2); assert.strictEqual(r[0][L.nyukin.indexOf('入金額')], '32900'); assert.strictEqual(r[1][L.nyukin.indexOf('入金額')], '1200');
  assert.strictEqual(r[0][L.nyukin.indexOf('備考')], 'SHOPIFY 10/09入金 2件');
});

/* ---------- 実データ（手元にあるときだけ） ---------- */
const SM = 'C:/Users/tfuku/OneDrive - 花岡車輌 株式会社/花岡車輌 - SharedMasters/';
const SH = 'C:/Users/tfuku/Downloads/FireShot/';
if (fs.existsSync(SM + '請求明細出力.txt') && fs.existsSync(SH + 'orders_export_1.csv')) {
  const O = EC.groupShopifyOrders(EC.parseObjects(fs.readFileSync(SH + 'orders_export_1.csv', 'utf8')));
  const bill = EC.parseObjects(fs.readFileSync(SM + '請求明細出力.txt', 'utf8')).filter(d => ['599801', '599802'].includes(d['請求先ｺｰﾄﾞ']));
  const book = {}; bill.forEach(d => { const k = (d['客先注番'] || '').replace(/\D/g, ''); if (k) (book[k] = book[k] || []).push(d); });
  const items = {}; EC.parseObjects(fs.readFileSync(SM + '品目マスタ.csv', 'utf8')).forEach(r => { items[r['品目ｺｰﾄﾞ']] = { name: r['品目名'], unit: r['単位'], teihai: r['初期表示用手配区分'] }; });
  t('実データ：7〜9月のEC伝票と税抜合計が95%以上一致', () => {
    let cmp = 0, okA = 0;
    O.filter(o => o.createdAt >= '2026-07-01' && book[o.id]).forEach(o => {
      const s = EC.buildSlip(o, { mapping: DEFAULT_MAPPING, cfg: DEFAULT_CONFIG, items }); if (s.excluded) return;
      cmp++;
      const net = book[o.id].filter(d => d['課税区分名'] !== '消費税').reduce((a, d) => a + (+d['税抜売上金額'] || 0), 0);
      if (net === s.netTotal) okA++;
    });
    assert.ok(cmp > 200, '比較件数 ' + cmp); assert.ok(okA / cmp > 0.95, '金額一致 ' + okA + '/' + cmp);
  });
}
console.log('ec_sales_core: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
