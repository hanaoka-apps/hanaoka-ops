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
t('受注の締め：15時以降は翌日分・休みの日は次の営業日から数える', () => {
  const at = (date, time) => EC.buildSlip(order({ createdAt: date, createdTime: time }), ctx);
  assert.strictEqual(DEFAULT_CONFIG.cutoffTime, '15:00');
  assert.strictEqual(at('2026-10-15', '14:59').shipDate, '2026-10-19');   // 木 → 当日処理 → +2営業日＝月
  assert.strictEqual(at('2026-10-15', '15:00').shipDate, '2026-10-20');   // 木15時 → 金処理 → 火
  assert.strictEqual(at('2026-10-16', '17:30').processDate, '2026-10-19'); // 金15時以降 → 月処理
  assert.strictEqual(at('2026-10-17', '10:00').processDate, '2026-10-19'); // 土 → 月処理
  assert.strictEqual(at('2026-10-17', '10:00').shipDate, '2026-10-21');
});
t('商品ごとの納期：品目の日数のうち最大', () => {
  const m = JSON.parse(JSON.stringify(DEFAULT_MAPPING)); m.rules.find(r => r.id === 'body-din').leadDays = 5;
  const o = order({ lines: [{ name: 'FLATCART DINING - オプションは注文しない', sku: '', qty: 1, price: 27500 }] });
  assert.strictEqual(EC.buildSlip(o, Object.assign({}, ctx, { mapping: m })).shipDate, '2026-10-22');
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
  assert.strictEqual(d.name, '中村達生様'); assert.strictEqual(d.addr1, '山口県周南市'); assert.strictEqual(d.addr2, '大島５－２８');   // 「−」(U+2212) は CP932 の「－」に直る assert.strictEqual(d.tel, '090-4694-1826');
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
t('納品先の入力不足は受注チェックの要確認に出る', () => {
  const none = EC.buildSlip(order({ ship: { name: '中村達生', company: '', zip: '745-0803', province: '山口県', city: '周南市', addr1: '大島５−２８', addr2: '', phone: '' } }), ctx);
  assert.ok(none.flags.some(f => f.level === 'warn' && /電話番号/.test(f.text)));
  const noName = EC.buildSlip(order({ ship: { name: '', company: '', zip: '745-0803', province: '山口県', city: '周南市', addr1: 'x', addr2: '', phone: '09012345678' } }), ctx);
  assert.ok(noName.flags.some(f => f.level === 'error'));
  const long = EC.buildSlip(order({ ship: { name: '山田', company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: 'あ'.repeat(30), addr2: '', phone: '09012345678' } }), ctx);
  assert.ok(long.flags.some(f => /住所２が長い/.test(f.text)));
  assert.strictEqual(EC.buildSlip(order(), ctx).flags.filter(f => f.level !== 'info').length, 0);
});
t('対応表の「言葉」判定：含む・始まる・ちょうど・単位つき数量・記号は文字として扱う', () => {
  const m = { leadDays: 2, rules: [
    { id: 'a', scope: 'single', words: ['テーブルコンテナ', 'TC'], match: 'exact', code: 'TC', net: 7000 },
    { id: 'b', scope: 'body', words: ['UXA-LSCグレー'], match: 'starts', code: 'UXALSCG' },
    { id: 'c', scope: 'body', words: ['F-CART 2×4(ブルー)', 'ブルー'], match: 'contains', code: 'FCART2x4' },
    { id: 'd', scope: 'option', words: ['ケース'], qtyUnit: '個', match: 'contains', code: 'OP/CUP', net: 1200 }
  ] };
  const code = name => EC.mapLine({ name, qty: 1, price: 11000 }, m, '2026-10-01').items.map(i => i.code + '×' + i.qty).join(',');
  assert.strictEqual(code('テーブルコンテナ'), 'TC×1');
  assert.strictEqual(code('TC'), 'TC×1');
  assert.strictEqual(code('テーブルコンテナ グレー'), '');                 // ちょうど同じ → 当たらない
  assert.strictEqual(code('UXA-LSCグレー_廃盤モデル'), 'UXALSCG×1');
  assert.strictEqual(code('廃盤 UXA-LSCグレー'), '');                      // 始まる → 当たらない
  assert.strictEqual(code('F-CART 2×4（ブルー） - ケース3個追加'), 'FCART2x4×1,OP/CUP×3');   // 全角カッコも同じ扱い・3個→数量3
});
t('社内メモ：基本のメモのあとに追記を全角スペースでつなぐ', () => {
  assert.strictEqual(EC.joinMemo('花岡EC', '', DEFAULT_CONFIG), '花岡EC');
  assert.strictEqual(EC.joinMemo('花岡EC', ' ブルー入荷待ち\n', DEFAULT_CONFIG), '花岡EC\u3000ブルー入荷待ち');
  assert.strictEqual(EC.joinMemo('花岡EC（ギフティング）', '指定着', DEFAULT_CONFIG), '花岡EC（ギフティング）\u3000指定着');
});
t('配送会社で化けやすい文字：見えない文字・機種依存文字・絵文字を整える', () => {
  const C = DEFAULT_CONFIG;
  assert.strictEqual(EC.cleanText('野口\u200b 秀樹', C), '野口 秀樹');
  assert.strictEqual(EC.cleanText('東京\u00a0都', C), '東京 都');
  assert.strictEqual(EC.cleanText('髙橋', C), '高橋');
  assert.strictEqual(EC.cleanText('㈱テスト①', C), '(株)テスト1');
  assert.strictEqual(EC.cleanText('山田😀太郎', C), '山田太郎');
  // ハイフンの揺れ：前後が全角英数なら「－」、それ以外は「-」。長音は前後が数字のときだけ
  assert.strictEqual(EC.cleanText('1‐2−3–4', C), '1-2-3-4');
  assert.strictEqual(EC.cleanText('１ー２ー３', C), '１－２－３');
  assert.strictEqual(EC.cleanText('3ｰ4', C), '3-4');
  assert.strictEqual(EC.cleanText('コーヒーハウス', C), 'コーヒーハウス');
  assert.strictEqual(EC.cleanText('ｺﾋｰ', C), 'ｺﾋｰ');
  assert.strictEqual(EC.cleanText('A―B', C), 'A-B');
  assert.strictEqual(EC.cleanText('大島５−２８〜', C), '大島５－２８～');   // 波ダッシュ問題の記号はCP932側へ
  assert.strictEqual(EC.cleanText('山田\u3000太郎', C), '山田\u3000太郎');     // 全角空白はそのまま
  assert.strictEqual(EC.charKind('あ'), 'ok'); assert.strictEqual(EC.charKind('ﾃ'), 'ok'); assert.strictEqual(EC.charKind('①'), 'dep'); assert.strictEqual(EC.charKind('\u{2A6B2}'), 'out');
  const s = EC.buildSlip(order({ ship: { name: '山田\u200b太郎', company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: '1-1', addr2: '', phone: '09012345678' } }), ctx);
  assert.ok(s.flags.some(f => f.level === 'info' && /文字を整えました/.test(f.text)));
  assert.strictEqual(EC.deliveryFromOrder(s.order, DEFAULT_CONFIG).name, '山田太郎様');
  const bad = EC.buildSlip(order({ ship: { name: '\u{2A6B2}田', company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: '1-1', addr2: '', phone: '09012345678' } }), ctx);
  assert.ok(bad.flags.some(f => f.level === 'warn' && /Shift-JISにない文字/.test(f.text)));
});
t('第一貨物の文字数：名称30字・住所は合計45字', () => {
  const ship = (name, a2) => ({ name, company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: '1-1', addr2: a2, phone: '09012345678' });
  const ok = EC.buildSlip(order({ ship: ship('あ'.repeat(10), 'い'.repeat(20)) }), ctx);
  assert.ok(!ok.flags.some(f => /第一貨物/.test(f.text)));
  const bad = EC.buildSlip(order({ ship: ship('あ'.repeat(30), 'い'.repeat(40)) }), ctx);   // 名称31字（様込み）・住所 7+3+40字
  assert.ok(bad.flags.some(f => /第一貨物.*名称/.test(f.text)) && bad.flags.some(f => /第一貨物.*合計45字/.test(f.text)));
});
t('西濃運輸（宅配）の文字数：名称16字・住所24字を超えたら知らせる', () => {
  const long = EC.buildSlip(order({ ship: { name: 'あ'.repeat(16), company: '', zip: '1000001', province: '東京都', city: '千代田区', addr1: '1-1', addr2: 'い'.repeat(25), phone: '09012345678' } }), ctx);
  assert.ok(long.flags.some(f => /西濃運輸.*名称/.test(f.text)));        // 16字＋「様」＝17字
  assert.ok(long.flags.some(f => /西濃運輸.*住所/.test(f.text)));
  assert.strictEqual(EC.buildSlip(order(), ctx).flags.filter(f => f.level !== 'info').length, 0);
});
t('取込ファイル：受注の行・UTF-16', () => {
  assert.strictEqual(EC.buildSlip(order(), ctx).memo, '花岡EC');
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

/* ---------- SMILE への取込・取込後の突き合わせ ---------- */
t('SHA-256：Node の crypto と同じ（空・短い・64バイト境界・日本語）', () => {
  const crypto = require('crypto');
  [new Uint8Array(0), Buffer.from('abc'), Buffer.alloc(55, 1), Buffer.alloc(56, 2), Buffer.alloc(64, 3), Buffer.alloc(1000, 4), EC.encodeUtf16('納品先\tテスト\r\n')].forEach(b => {
    assert.strictEqual(EC.sha256(b), crypto.createHash('sha256').update(b).digest('hex'));
  });
});
t('取込バッチ：中身が同じなら同じ番号、違えば別の番号。manifest に行数と sha256', () => {
  const a = { name: 'juchu.txt', rows: 3, bytes: EC.encodeUtf16('a\r\n') }, b = { name: 'nouhin.txt', rows: 1, bytes: EC.encodeUtf16('b\r\n') };
  const x = EC.buildImportBatch([b, a], 'u@example.com', '2026-10-20T01:00:00Z'), y = EC.buildImportBatch([b, a], 'v@example.com', '2026-10-21T01:00:00Z');
  assert.strictEqual(x.batchId, y.batchId); assert.ok(/^ec-[0-9a-f]{16}$/.test(x.batchId));
  assert.notStrictEqual(x.batchId, EC.buildImportBatch([b, { name: 'juchu.txt', rows: 3, bytes: EC.encodeUtf16('c\r\n') }], '', '').batchId);
  assert.deepStrictEqual(x.manifest.files.map(f => [f.name, f.rows, f.sha256.length]), [['nouhin.txt', 1, 64], ['juchu.txt', 3, 64]]);
  assert.strictEqual(x.manifest.requestedBy, 'u@example.com');
});

// 取込ファイルと同じ流れで「取り込むはずだった内容」と、SMILE が出力するはずの CSV を作る
function importFixture() {
  const o1 = order({ name: '#1801', id: '1801', total: 17050 + 15400, lines: [{ name: 'FLATCART 2x4（ブラック） - テーブルコンテナ(ブラック)2個追加', sku: '', qty: 1, price: 30800 }] });
  const o2 = order({ name: '#1802', id: '1802', ship: { name: '山田花子', company: '', zip: '100-0001', province: '東京都', city: '千代田区', addr1: '千代田１−１', addr2: '', phone: '0312345678' } });
  const slips = [o1, o2].map(o => EC.buildSlip(o, ctx));
  const master = EC.indexDeliveryMaster([], DEFAULT_CONFIG);
  const fresh = EC.planDeliveries(slips, master, DEFAULT_CONFIG, { reuse: true });
  const expected = EC.expectedImport(slips, fresh);
  const jh = L.juchu, nh = L.nouhin;
  const jrows = EC.juchuRows(slips, jh, DEFAULT_CONFIG);
  // SMILE の出力（見出しは半角カナ。受注№は SMILE が付ける）
  const jobjs = jrows.map(r => { const o = {}; jh.forEach((h, i) => { o[h.replace('コード', 'ｺｰﾄﾞ')] = r[i]; }); o['受注№'] = o['受注№'] === '1' ? '90001' : '90002'; return o; });
  const nobjs = EC.nouhinRows(fresh, nh, DEFAULT_CONFIG).map(r => { const o = {}; nh.forEach((h, i) => { o[h.replace('コード', 'ｺｰﾄﾞ')] = r[i]; }); return o; });
  return { expected, jobjs, nobjs, slips, fresh };
}
const clone2 = x => JSON.parse(JSON.stringify(x));
const res = (f, j, n) => EC.verifyImport(f.expected, j || f.jobjs, n || f.nobjs);

t('突き合わせ：すべて一致 → ok と SMILE の受注№', () => {
  const f = importFixture(), r = res(f);
  assert.strictEqual(r.orders['1801'].status, 'ok'); assert.strictEqual(r.orders['1801'].juchuNo, '90001');
  assert.strictEqual(r.orders['1802'].status, 'ok'); assert.strictEqual(r.orders['1802'].juchuNo, '90002');
  assert.deepStrictEqual(r.orders['1801'].diffs, []);
  assert.ok(f.expected.deliveries.length === 2 && Object.values(r.deliveries).every(d => d.status === 'ok'));
});
t('突き合わせ：金額が1円違う → ng（行・期待値・SMILEの値つき）', () => {
  const f = importFixture(), j = clone2(f.jobjs);
  const row = j.filter(x => x['客先注番'] === '1801')[0]; row['金額'] = String(+row['金額'] + 1);
  const r = res(f, j).orders['1801'];
  assert.strictEqual(r.status, 'ng');
  const d = r.diffs.find(x => x.field === 'amount'); assert.strictEqual(d.line, 1); assert.strictEqual(d.expected, '14000'); assert.strictEqual(d.actual, '14001');
  assert.strictEqual(res(f, j).orders['1802'].status, 'ok');   // ほかの注文には響かない
});
t('突き合わせ：品目違い・数量・単価・納期・出荷予定日・納品先コード・社内メモ', () => {
  const f = importFixture(), j = clone2(f.jobjs), r1 = j.filter(x => x['客先注番'] === '1801');
  r1[0]['品目ｺｰﾄﾞ'] = 'FCART2x4'; r1[1]['数量'] = '3.00'; r1[1]['単価'] = '7001.00'; r1[0]['納期'] = '20261030'; r1[0]['出荷予定日'] = '20261030'; r1[1]['納品先ｺｰﾄﾞ'] = '000999'; r1[1]['社内メモ'] = '別のメモ';
  const fields = res(f, j).orders['1801'].diffs.map(d => d.field);
  ['code', 'qty', 'unit', 'due', 'shipDate', 'deliveryCode', 'memo'].forEach(k => assert.ok(fields.includes(k), k));
});
t('突き合わせ：納期の書式（26/10/19・2026/10/19・20261019）の違いは同じ日として扱う', () => {
  const f = importFixture(), j = clone2(f.jobjs);
  const ship = f.expected.orders['1802'].shipDate;   // 2026-10-19
  j.filter(x => x['客先注番'] === '1802').forEach(x => { x['納期'] = ship.replace(/-/g, '/'); x['出荷予定日'] = ship.slice(2).replace(/-/g, '/'); });
  assert.strictEqual(res(f, j).orders['1802'].status, 'ok');
});
t('突き合わせ：納品先が未登録・住所や電話が違う → 注文も ng', () => {
  const f = importFixture();
  const r0 = res(f, f.jobjs, []);
  assert.strictEqual(r0.orders['1801'].status, 'ng'); assert.ok(r0.orders['1801'].diffs.some(d => d.field === 'delivery'));
  assert.ok(Object.values(r0.deliveries).every(d => d.status === 'ng'));
  const n = clone2(f.nobjs); n[0]['電話番号'] = '000-0000-0000'; n[1]['住所１'] = '別の住所';
  const r1 = res(f, f.jobjs, n);
  assert.strictEqual(r1.deliveries[f.expected.deliveries[0].code].diffs[0].field, 'delivery.tel');
  assert.strictEqual(r1.orders['1801'].status, 'ng'); assert.strictEqual(r1.orders['1802'].status, 'ng');
});
t('突き合わせ：電話・郵便番号のハイフンの有無は同じ。名前の空白の揺れも同じ', () => {
  const f = importFixture(), n = clone2(f.nobjs);
  n.forEach(x => { x['電話番号'] = x['電話番号'].replace(/-/g, ''); x['郵便番号'] = x['郵便番号'].replace('-', ''); x['納品先名'] = x['納品先名'].replace('様', ' 様'); });
  assert.ok(Object.values(res(f, f.jobjs, n).orders).every(o => o.status === 'ok'));
});
t('突き合わせ：行数違い（1行足りない・1行多い）', () => {
  const f = importFixture(), j = clone2(f.jobjs);
  const short = j.filter(x => !(x['客先注番'] === '1801' && x['行'] === '3'));
  const a = res(f, short).orders['1801']; assert.strictEqual(a.status, 'ng'); const d = a.diffs.find(x => x.field === 'rows'); assert.deepStrictEqual([d.expected, d.actual], ['3', '2']);
  const extra = j.concat([Object.assign({}, j.find(x => x['客先注番'] === '1801'), { '行': '4' })]);
  assert.strictEqual(res(f, extra).orders['1801'].diffs.find(x => x.field === 'rows').actual, '4');
});
t('突き合わせ：SMILE に見つからない（注文番号違い・得意先違い）→ missing', () => {
  const f = importFixture();
  const none = res(f, f.jobjs.filter(x => x['客先注番'] !== '1802'));
  assert.strictEqual(none.orders['1802'].status, 'missing'); assert.strictEqual(none.orders['1801'].status, 'ok');
  const other = clone2(f.jobjs); other.forEach(x => { x['得意先ｺｰﾄﾞ'] = '000000'; });
  assert.strictEqual(res(f, other).orders['1801'].status, 'missing');
  assert.strictEqual(res(f, []).orders['1801'].status, 'missing');
});
t('突き合わせ：1つの注文が複数の受注№に分かれていたら ng', () => {
  const f = importFixture(), j = clone2(f.jobjs); j.filter(x => x['客先注番'] === '1801')[2]['受注№'] = '90099';
  const r = res(f, j).orders['1801']; assert.strictEqual(r.status, 'ng'); assert.ok(r.diffs.some(d => d.field === 'juchuNo')); assert.strictEqual(r.juchuNo, '');
});
t('突き合わせ：SMILE が自動で付ける製番・処理連番などは比べない', () => {
  const f = importFixture(), j = clone2(f.jobjs); j.forEach(x => { x['製番'] = 'SB' + x['行']; x['処理連番'] = '777'; x['BS受注№'] = '55'; });
  assert.ok(Object.values(res(f, j).orders).every(o => o.status === 'ok'));
});
t('取込結果の見方：再実行OKは「failed かつ executed:false」だけ。実行済み・不明は要確認で止める', () => {
  const J = EC.judgeImportResult;
  assert.strictEqual(J({ state: 'done', executed: true, files: [{ imported: 3, errors: 0 }, { imported: 20, errors: 0 }] }).kind, 'done');
  // 押す前に止まった（権限なし・ファイル不整合・SMILEのログイン切れなど）→ 再実行OK
  assert.strictEqual(J({ state: 'failed', executed: false, message: '権限なし', files: [] }).kind, 'retry');
  assert.strictEqual(J({ state: 'failed', executed: false, message: 'SMILEの画面が想定外', files: [{ imported: 0, errors: 0 }] }).kind, 'retry');
  // 押したあとに止まった → 取込0件でも再実行させない
  assert.strictEqual(J({ state: 'failed', executed: true, message: 'SMILEのエラー', files: [{ imported: 0, errors: 2 }] }).kind, 'partial');
  assert.strictEqual(J({ state: 'failed', executed: true, files: [] }).kind, 'partial');
  // 旧形式（executed なし）・値が不明 → 要確認
  assert.strictEqual(J({ state: 'failed', message: '権限なし', files: [] }).kind, 'partial');
  assert.strictEqual(J({ state: 'failed', executed: null, files: [{ imported: 0, errors: 0 }] }).kind, 'partial');
  assert.strictEqual(J({ state: 'failed', executed: 'false', files: [] }).kind, 'partial');
  // 取込済み（二重取込）は executed:false でも再実行させない
  assert.notStrictEqual(J({ state: 'failed', executed: false, message: '取込済み', files: [] }).kind, 'retry');
  // 一部だけ入った
  assert.strictEqual(J({ state: 'partial', executed: true, files: [{ imported: 3, errors: 0 }, { imported: 5, errors: 1 }] }).kind, 'partial');
  assert.strictEqual(J({ state: 'partial', executed: false, files: [] }).kind, 'partial');
  assert.strictEqual(J({ state: 'failed', executed: false, files: [{ imported: 3, errors: 0 }] }).kind, 'partial');   // 件数が入っているのに「押していない」は矛盾 → 要確認
  assert.strictEqual(J({ state: 'done', files: [{ imported: 3, errors: 1 }] }).kind, 'partial');
  assert.strictEqual(J(null).kind, 'check');
});

t('軽量ファイル（ec_smile_index.json）の表 → オブジェクト。見出しの揺れ（ｺｰﾄﾞ／コード）を無視して引ける。突き合わせにそのまま使える', () => {
  assert.deepStrictEqual(EC.indexObjects({ cols: ['a', 'b'], rows: [['1', '2'], ['3']] }), [{ a: '1', b: '2' }, { a: '3', b: '' }]);
  assert.deepStrictEqual(EC.indexObjects(null), []);
  assert.strictEqual(EC.pick({ '品目ｺｰﾄﾞ': 'X' }, ['品目コード']), 'X');
  assert.strictEqual(EC.pick({ '品目コード': 'Y' }, ['品目ｺｰﾄﾞ']), 'Y');
  // 全角の見出し（JSON）に変えても突き合わせの結果は同じ
  const f = importFixture();
  const toIdx = objs => ({ cols: Object.keys(objs[0]).map(k => k.normalize('NFKC') === k ? k : k.replace('ｺｰﾄﾞ', 'コード')), rows: objs.map(o => Object.values(o)) });
  const r = EC.verifyImport(f.expected, EC.indexObjects(toIdx(f.jobjs)), EC.indexObjects(toIdx(f.nobjs)));
  assert.ok(Object.values(r.orders).every(o => o.status === 'ok') && r.orders['1801'].juchuNo === '90001');
});

/* ---------- テスト送信（管理者メニュー。EC売上の東京 599801 に TEST… の仮注文1件と納品先 999998） ---------- */
const TI_CONF = CONF.testImport;
const TI = Object.assign({}, TI_CONF, { codeMode: 'fixed' });   // 固定のコード（999998）の形。仮の番号の形は下の「仮の番号」のテスト
// 品目マスタ（手配区分・在庫管理）。FR（運賃）＝手配区分2・在庫管理なし＝製番・製造手配が作られない。TC＝手配区分1・在庫管理あり（製番が付く）
const TITEMS = { FR: { name: 'ｳﾝﾁﾝ', unit: '式', teihai: '2', stock: '行わない' }, TC: { name: 'ﾃｰﾌﾞﾙｺﾝﾃﾅ', unit: '個', teihai: '1', stock: '行う' } };
const tOpt = (over) => Object.assign({ items: TITEMS, today: '2026-10-16', stamp: '2610161230', deliveryCodes: {} }, over);
t('テスト送信：送り先はEC売上の東京（599801）。名前・担当者・部門は config.customers から引き、testImport に重ねて書かない', () => {
  assert.strictEqual(TI.customerCode, '599801'); assert.strictEqual(TI.deliveryCode, '999998');
  ['customerName', 'staff', 'dept', 'warehouse'].forEach(k => assert.ok(!(k in TI), k + ' は testImport に書かない'));
  assert.strictEqual(EC.testSendGuard(TI, DEFAULT_CONFIG), '');
  const s = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()).slips[0], c = DEFAULT_CONFIG.customers['599801'];
  assert.deepStrictEqual([s.cust, s.custName, s.staff, s.dept], ['599801', c.name, c.staff, c.dept]);
  assert.deepStrictEqual([c.name, c.staff, c.dept], ['直販EC 東京', '000157', '002220']);
  // 設定の customers を変えれば、仮注文の名前・担当者もそれに従う（埋め込みではない）
  const cfg2 = Object.assign({}, DEFAULT_CONFIG, { customers: Object.assign({}, DEFAULT_CONFIG.customers, { '599801': { name: '別名', staff: '000001', dept: '009999', short: '東' } }) });
  const s2 = EC.buildTestImport(TI, cfg2, tOpt()).slips[0];
  assert.deepStrictEqual([s2.custName, s2.staff, s2.dept], ['別名', '000001', '009999']);
});
t('テスト送信：安全弁（得意先が設定にない・納品先コードが連番の範囲内・印なし・明細なしは拒否）', () => {
  assert.ok(/config\.customers/.test(EC.testSendGuard(Object.assign({}, TI, { customerCode: '110101' }), DEFAULT_CONFIG)));
  assert.ok(/連番の範囲/.test(EC.testSendGuard(Object.assign({}, TI, { deliveryCode: '000770' }), DEFAULT_CONFIG)));
  assert.ok(/連番の範囲/.test(EC.testSendGuard(Object.assign({}, TI, { deliveryCode: '099999' }), DEFAULT_CONFIG)));
  assert.strictEqual(EC.testSendGuard(Object.assign({}, TI, { deliveryCode: '100000' }), DEFAULT_CONFIG), '');
  assert.ok(EC.testSendGuard(Object.assign({}, TI, { deliveryCode: '12' }), DEFAULT_CONFIG));
  assert.ok(/poPrefix/.test(EC.testSendGuard(Object.assign({}, TI, { poPrefix: '' }), DEFAULT_CONFIG)));
  assert.ok(EC.testSendGuard(null, DEFAULT_CONFIG));
  assert.ok(EC.testSendGuard(Object.assign({}, TI, { lines: [] }), DEFAULT_CONFIG));
  const r = EC.buildTestImport(Object.assign({}, TI, { deliveryCode: '000770' }), DEFAULT_CONFIG, tOpt());
  assert.ok(r.error && !r.slips);                                          // 拒否されたら取込データは作らない
});
t('テスト送信：仮の注文だと一目で分かる（客先注番 TEST…・社内メモ・納品先名）。2行・手配区分はすべて2・翌営業日', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), s = r.slips[0];
  assert.strictEqual(r.slips.length, 1);
  assert.strictEqual(r.id, 'TEST2610161230'); assert.strictEqual(s.po, 'TEST2610161230');
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.qty, l.unitNet, l.amountNet, l.teihai]), [['FR', 1, 1500, 1500, '2'], ['FR', 1, 500, 500, '2']]);   // 単価を変えて2行（同じ品目・同じ単価だと取込側で1行にまとまることがある）
  assert.strictEqual(s.shipDate, '2026-10-19');                            // 金曜の翌営業日＝月曜
  assert.strictEqual(s.memo, '花岡EC（テスト送信）'); assert.strictEqual(s.delivery.name, 'テスト納品先（削除予定）');
  assert.strictEqual(r.net, 2000); assert.strictEqual(r.gross, 2200);
  assert.strictEqual(EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ today: '2026-10-15' })).slips[0].shipDate, '2026-10-16');
});
t('テスト送信：客先注番は毎回ユニークで、数字部分（10桁）は本番の注文番号と衝突しない。TEST で本番の注文と見分けられる', () => {
  const a = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()).id, b = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ stamp: '2610161231' })).id;
  assert.notStrictEqual(a, b); assert.ok(/^TEST\d{10}$/.test(a));
  assert.strictEqual(a.replace(/\D/g, '').length, 10);                      // 本番の注文番号（4桁など）とは桁が違う
  assert.ok(EC.isTestPo(a, 'TEST') && EC.isTestPo('test2610161230', 'TEST'));
  assert.ok(!EC.isTestPo('1801', 'TEST') && !EC.isTestPo('', 'TEST') && !EC.isTestPo('TEST1', ''));
});
t('テスト送信：取込ファイル（受注）は東京の得意先・担当・部門・倉庫で、客先注番は TEST…、社内メモ・納品先 999998', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), J = L.juchu;
  const rows = EC.juchuRows(r.slips, J, DEFAULT_CONFIG);
  assert.strictEqual(rows.length, 2);
  const col = n => J.indexOf(n);
  assert.deepStrictEqual([rows[0][col('得意先コード')], rows[0][col('得意先名１')], rows[0][col('担当者コード')], rows[0][col('部門コード')], rows[0][col('倉庫コード')], rows[0][col('納品先コード')], rows[0][col('客先注番')], rows[0][col('社内メモ')]],
    ['599801', '直販EC 東京', '000157', '002220', DEFAULT_CONFIG.warehouse, '999998', 'TEST2610161230', '花岡EC（テスト送信）']);
  // 製番・製造手配が作られない形（FR と同じ）：手配区分 2・製造数量 0.00・製造納期 0・当初製造納期 0。品目は FR だけ
  rows.forEach(x => assert.deepStrictEqual([x[col('品目コード')], x[col('手配区分')], x[col('製造数量')], x[col('製造納期')], x[col('当初製造納期')]], ['FR', '2', '0.00', '0', '0']));
  assert.deepStrictEqual(rows.map(x => x[col('単価')]), ['1500.00', '500.00']);
  // 本番の注文（客先注番は数字だけ）は今までどおり
  const real = EC.buildSlip(order(), ctx); real.deliveryCode = '000001'; real.delivery = { name: 'x' }; real.shipDate = '2026-10-19';
  assert.strictEqual(EC.juchuRows([real], J, DEFAULT_CONFIG)[0][col('客先注番')], '1800');
  assert.ok(EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ items: {} })).error);   // 品目マスタにない品目はエラー
});
t('テスト送信：テスト行の品目は「手配区分2・在庫管理なし」だけ。マスタの品目がそれに当たらなければ拒否（製番・製造手配を作らない）', () => {
  assert.deepStrictEqual([TI.safeTeihai, TI.safeStock], ['2', '行わない']);
  assert.ok(TI.lines.every(l => l.code === 'FR'));                          // 設定の明細は FR（運賃）だけ。TC など製番が付く品目は使わない
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt());
  assert.ok(!r.error && r.slips[0].lines.every(l => String(l.teihai) === TI.safeTeihai && TITEMS[l.code].stock === TI.safeStock));
  const refuse = (items, re) => { const x = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ items })); assert.ok(x.error && re.test(x.error), x.error); assert.ok(!x.slips); };
  refuse({ FR: Object.assign({}, TITEMS.FR, { teihai: '1' }) }, /製番・製造手配が作られる可能性/);                // 手配区分が 1 に変わった
  refuse({ FR: Object.assign({}, TITEMS.FR, { stock: '行う' }) }, /製番・製造手配が作られる可能性/);            // 在庫管理が「行う」に変わった
  refuse({ FR: Object.assign({}, TITEMS.FR, { teihai: '1', stock: '行う' }) }, /製番・製造手配が作られる可能性/);
  refuse({ FR: { name: 'ｳﾝﾁﾝ', unit: '式', teihai: '2' } }, /在庫管理区分をマスタで確認できません/);            // 在庫管理の列が読めない（索引が古い）
  refuse({ FR: Object.assign({}, TITEMS.FR, { stock: '' }) }, /在庫管理区分をマスタで確認できません/);
  // テーブルコンテナ（手配区分1・在庫管理あり）をテストに入れようとしても送らない
  const tc = EC.buildTestImport(Object.assign({}, TI, { lines: [{ code: 'TC', qty: 1, unitNet: 7000 }] }), DEFAULT_CONFIG, tOpt());
  assert.ok(tc.error && /TC/.test(tc.error) && !tc.slips);
  // 条件の設定が無ければ拒否
  assert.ok(/safeTeihai/.test(EC.testSendGuard(Object.assign({}, TI, { safeTeihai: '' }), DEFAULT_CONFIG)));
  assert.ok(/safeStock/.test(EC.testSendGuard(Object.assign({}, TI, { safeStock: undefined }), DEFAULT_CONFIG)));
  // 本番の注文（手配区分1の本体）は従来どおり製番が付く形のまま（テスト送信のための変更を入れていない）
  const real = EC.buildSlip(order(), ctx); real.deliveryCode = '000001'; real.delivery = { name: 'x' }; real.shipDate = '2026-10-19';
  const jr = EC.juchuRows([real], L.juchu, DEFAULT_CONFIG), jc = n => L.juchu.indexOf(n);
  assert.deepStrictEqual([jr[0][jc('手配区分')], jr[0][jc('製造数量')]], ['1', '1.00']);
  assert.notStrictEqual(jr[0][jc('製造納期')], '0');
});
t('テスト送信：納品先 999998 が無ければ新規（納品先ファイルを作る）、あれば作らない', () => {
  const fresh = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt());
  assert.strictEqual(fresh.fresh.length, 1); assert.strictEqual(fresh.slips[0].deliveryNew, true);
  const rows = EC.nouhinRows(fresh.fresh, L.nouhin, DEFAULT_CONFIG)[0];
  assert.deepStrictEqual([rows[0], rows[1], rows[2]], ['599801', '999998', 'テスト納品先（削除予定）']);
  const had = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ deliveryCodes: { '999998': true } }));
  assert.strictEqual(had.fresh.length, 0); assert.strictEqual(had.slips[0].deliveryNew, false);
});
t('テスト送信：納品先 999998 は納品先コードの連番の計算に混ざらない（deliveryCodeLimit で除外）', () => {
  assert.strictEqual(DEFAULT_CONFIG.deliveryCodeLimit, '099999');
  const row = (code) => ({ '得意先ｺｰﾄﾞ': '599801', '納品先ｺｰﾄﾞ': code, '納品先名': 'x' + code, '郵便番号': '100-0001' });
  const m = EC.indexDeliveryMaster([row('000001'), row('000770'), row('999998')], DEFAULT_CONFIG);
  assert.strictEqual(m['599801'].max, '000770');                           // 999998 は最大コードにならない
  assert.ok(m['599801'].used['999998']);                                    // 使用済みのコードとしては数える（再利用しない）
  const mk = (id) => { const s = EC.buildSlip(order({ id, name: '#' + id, ship: { name: '新規' + id, company: '', zip: '100-0003', province: '東京都', city: '千代田区', addr1: 'x', addr2: '', phone: '0312345678' } }), Object.assign({}, ctx, { items: ITEMS })); s.cust = '599801'; return s; };
  const slips = [mk('1901'), mk('1902')];
  EC.planDeliveries(slips, m, DEFAULT_CONFIG, { reuse: true });
  assert.deepStrictEqual(slips.map(s => s.deliveryCode), ['000771', '000772']);   // 連番は 000770 の次から。999998・999999 にはならない
  // 連番が 999998 に届く前に、上限（099999）を超えるときは範囲内のコードが尽きる＝テスト用コードとは別の範囲
  assert.ok('999998' > DEFAULT_CONFIG.deliveryCodeLimit);
});
t('テスト送信：TEST の注文は本番の件数・二重取込の確認に出ない（索引・CSVのどちらから読んでも除外）', () => {
  const rows = [
    { '得意先コード': '599801', '客先注番': '1802' }, { '得意先コード': '599801', '客先注番': 'TEST2610161230' }, { '得意先ｺｰﾄﾞ': '599802', '客先注番': 'test2610161231' }];
  const real = rows.filter(r => !EC.isTestPo(EC.pick(r, ['客先注番']), TI.poPrefix));
  assert.deepStrictEqual(real.map(r => EC.pick(r, ['客先注番'])), ['1802']);
  // 数字だけで照合する二重取込の確認（smileOrders）に、テスト送信の注文番号（数字10桁）が入っても、本番の注文番号（4桁）とは一致しない
  const o = EC.buildSlip(order({ id: '2610161230', name: '#2610161230' }), Object.assign({}, ctx, { smileOrders: {} }));
  assert.ok(!o.inSmile);
});
t('テスト送信：突き合わせ（一致・金額違い）。TEST の客先注番でも数字で照合でき、別の得意先の同じ注文番号は見つからない扱い', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), J = L.juchu, N = L.nouhin;
  const expected = EC.expectedImport(r.slips, r.fresh);
  const jobjs = EC.juchuRows(r.slips, J, DEFAULT_CONFIG).map(x => { const o = {}; J.forEach((h, i) => { o[h] = x[i]; }); o['受注№'] = '70001'; return o; });
  const nobjs = EC.nouhinRows(r.fresh, N, DEFAULT_CONFIG).map(x => { const o = {}; N.forEach((h, i) => { o[h] = x[i]; }); return o; });
  const ok = EC.verifyImport(expected, jobjs, nobjs);
  assert.strictEqual(ok.orders[r.id].status, 'ok'); assert.strictEqual(ok.orders[r.id].juchuNo, '70001'); assert.strictEqual(ok.deliveries['999998'].status, 'ok');
  const bad = JSON.parse(JSON.stringify(jobjs)); bad[1]['金額'] = '1499';
  assert.ok(EC.verifyImport(expected, bad, nobjs).orders[r.id].diffs.some(d => d.field === 'amount' && d.line === 2));
  const other = jobjs.map(o => Object.assign({}, o, { '得意先コード': '599802' }));
  assert.strictEqual(EC.verifyImport(expected, other, nobjs).orders[r.id].status, 'missing');
});

/* ---------- 取込後の流れ（確認待ち → 確認OK）と、担当者への報告 ---------- */
t('状態の遷移：突合が一致 → 確認待ち（自動で起票済みにしない）／一致しない・見つからない → 要確認', () => {
  assert.strictEqual(EC.matchToStatus({ status: 'ok' }), 'confirm');
  assert.strictEqual(EC.matchToStatus({ status: 'ng' }), 'check');
  assert.strictEqual(EC.matchToStatus({ status: 'missing' }), 'check');
  assert.strictEqual(EC.matchToStatus(null), 'check');
});
t('確認OK：管理者だけ・確認待ちの注文だけ。押した人と日時を記録する', () => {
  const rec = { status: 'confirm', juchuNo: '90001' };
  assert.deepStrictEqual(EC.confirmOk(rec, 'user@example.com', '2026-10-21T01:00:00Z', false), { ok: false, error: '確認OKは管理者だけが行えます' });
  assert.strictEqual(rec.status, 'confirm');                               // 管理者でなければ何も変わらない
  for (const st of ['ok', 'importing', 'check', 'exported', undefined]) {
    const r2 = { status: st }; assert.strictEqual(EC.confirmOk(r2, 'a@example.com', 'x', true).ok, false); assert.strictEqual(r2.status, st);
  }
  assert.strictEqual(EC.confirmOk(null, 'a@example.com', 'x', true).ok, false);
  assert.deepStrictEqual(EC.confirmOk(rec, 'admin@example.com', '2026-10-21T01:00:00Z', true), { ok: true });
  assert.deepStrictEqual([rec.status, rec.confirmedBy, rec.confirmedAt, rec.exportedBy, rec.exportedAt, rec.juchuNo], ['exported', 'admin@example.com', '2026-10-21T01:00:00Z', 'admin@example.com', '2026-10-21T01:00:00Z', '90001']);
  assert.strictEqual(EC.confirmOk(rec, 'admin@example.com', 'y', true).ok, false);   // 二度は押せない（起票済み）
});
t('まとめて確認OK：確認待ちだけが対象。管理者でなければ何も変えない。取込の段階は 確認待ち → 要確認 → 起票済み の順', () => {
  const map = { 1: { status: 'confirm' }, 2: { status: 'confirm' }, 3: { status: 'check' }, 4: { status: 'importing' } };
  const imp = { orderIds: ['1', '2', '3'] };
  assert.strictEqual(EC.importPhase(imp, map), 'confirm');
  const no = EC.confirmAll(map, ['1', '2', '3', '4'], 'u', 'now', false);
  assert.deepStrictEqual(no.done, []); assert.ok(no.error); assert.strictEqual(map[1].status, 'confirm');
  const yes = EC.confirmAll(map, ['1', '2', '3', '4'], 'admin', 'now', true);
  assert.deepStrictEqual(yes.done, ['1', '2']);                            // 要確認・取込中は対象外
  assert.deepStrictEqual([map[3].status, map[4].status], ['check', 'importing']);
  assert.strictEqual(EC.importPhase(imp, map), 'check');                   // 確認待ちが無くなり、要確認が残る
  map[3].status = 'exported';
  assert.strictEqual(EC.importPhase(imp, map), 'done');
});
const rOrders = [
  { name: '#1801', juchuNo: '90001', shipDate: '2026-10-19', status: 'confirm' },
  { name: '#1802', juchuNo: '90002', shipDate: '2026-10-20', status: 'confirm' },
  { name: '#1803', juchuNo: '90003', shipDate: '2026-10-20', status: 'check', diffs: [
    { field: 'amount', line: 1, label: '1行目 金額', expected: '14000', actual: '14001' },
    { field: 'delivery', label: '納品先 000771', expected: '登録内容が一致', actual: '住所１：東京都千代田区千代田1-1／電話：03-1234-5678' },
    { field: 'delivery.addr1', label: '住所１', expected: '東京都千代田区千代田1-1', actual: '別の住所' },
    { field: 'memo', line: 1, label: '1行目 社内メモ', expected: '花岡EC 山田様', actual: 'x' }] },
  { name: '#1804', status: 'check', message: 'SMILE の確認用ファイルに見つかりません' }];
t('報告本文：件数サマリ・一致した注文の「注文番号・受注№・出荷予定日」・要確認とその理由・アプリのURL', () => {
  const parts = EC.buildReport({ batchId: 'ec-0123456789abcdef', counts: { slips: 4, fresh: 2 }, orders: rOrders, url: 'https://example.test/ec_sales.html' });
  assert.strictEqual(parts.length, 1);
  const p = parts[0];
  assert.ok(p.includes('ec-0123456789abcdef'));
  assert.ok(p.includes('取込 4件／一致 2件／要確認 2件／納品先の新規 2件'));
  assert.ok(p.includes('・#1801　受注№ 90001　出荷予定日 10/19(月)'));
  assert.ok(p.includes('・#1802　受注№ 90002　出荷予定日 10/20(火)'));
  assert.ok(p.includes('#1803　受注№ 90003：1行目 金額（期待 14000／SMILE 14001）'));
  assert.ok(p.includes('#1804：SMILE の確認用ファイルに見つかりません'));
  assert.ok(p.includes('アプリ：https://example.test/ec_sales.html'));
});
t('報告本文：お客様の名前・住所・電話・社内メモの値は入れない（項目名だけ）', () => {
  const p = EC.buildReport({ batchId: 'ec-0123456789abcdef', counts: { slips: 4, fresh: 2 }, orders: rOrders, url: 'u' }).join('\n');
  ['千代田', '03-1234-5678', '別の住所', '山田', '登録内容が一致'].forEach(w => assert.ok(!p.includes(w), w));
  assert.ok(p.includes('納品先 000771が違います') && p.includes('住所１が違います') && p.includes('1行目 社内メモが違います'));   // 項目名は出す
  // 注文に配送先などの個人情報を持たせていても、本文には使われない（受け取るのは名前・受注№・出荷予定日・差分だけ）
  const o = Object.assign({}, rOrders[0], { ship: { name: '山田花子', phone: '09012345678', addr1: '千代田1-1' }, email: 'a@example.com' });
  const q = EC.buildReport({ batchId: 'b', counts: { slips: 1, fresh: 0 }, orders: [o], url: 'u' }).join('\n');
  ['山田花子', '09012345678', '千代田', 'a@example.com'].forEach(w => assert.ok(!q.includes(w), w));
});
t('報告本文：長いときは分割する（各パートが上限以内・番号つき・全件が漏れず入る）', () => {
  const many = []; for (let i = 0; i < 200; i++) many.push({ name: '#' + (2000 + i), juchuNo: String(91000 + i), shipDate: '2026-10-19', status: 'confirm' });
  const parts = EC.buildReport({ batchId: 'ec-0123456789abcdef', counts: { slips: 200, fresh: 0 }, orders: many, url: 'u', maxChars: 1200 });
  assert.ok(parts.length > 1);
  parts.forEach((p, i) => { assert.ok(p.length <= 1200 + 20, 'パート' + i + ' が長い'); assert.ok(p.endsWith('（' + (i + 1) + '/' + parts.length + '）')); });
  const all = parts.join('\n');
  for (let i = 0; i < 200; i += 37) assert.ok(all.includes('#' + (2000 + i) + '　受注№ ' + (91000 + i)));
  assert.strictEqual((all.match(/　受注№ /g) || []).length, 200);
  // 1行が上限を超える場合は、行の途中で切って、落とさない
  const long = EC.buildReport({ batchId: 'b', counts: { slips: 1, fresh: 0 }, orders: [{ name: '#1', status: 'check', message: 'あ'.repeat(5000) }], url: 'u', maxChars: 1000 });
  assert.ok(long.length >= 5); assert.ok(long.join('').split('あ').length - 1 === 5000);
});

/* ---------- 共有の履歴（SharePoint のリスト）：状態の対応表・行への変換・差分・復元・移行 ---------- */
t('状態の対応表：アプリの状態 ↔ リストの Status（scripts/create_ec_lists.ps1 の選択肢と同じ言葉・往復できる）', () => {
  const LIST = ['未確認', 'OK済', '取込中', '突合待ち', '確認待ち', '起票済み', '要確認', '対象外'];   // create_ec_lists.ps1 の $StatusChoices
  assert.deepStrictEqual(EC.STATUS_PAIRS.map(p => p[1]), LIST);
  const APP = ['new', 'ok', 'importing', 'waiting', 'confirm', 'exported', 'check', 'excluded'];
  APP.forEach((a, i) => { assert.strictEqual(EC.listStatus(a), LIST[i]); assert.strictEqual(EC.appStatus(LIST[i]), a); });
  assert.strictEqual(EC.listStatus(undefined), '未確認');                   // 状態なし＝未確認
  assert.strictEqual(EC.listStatus('nonsense'), ''); assert.strictEqual(EC.appStatus('変な状態'), '');
  // ログの操作の選択肢も同じ（create_ec_lists.ps1 の $ActionChoices）
  assert.deepStrictEqual(EC.LOG_ACTIONS, ['OK', 'OK取消', '出荷予定日変更', '社内メモ追記', '取込依頼', '取込結果', '突合結果', '確認OK', '報告送信', '報告失敗', 'テスト送信', 'その他']);
});
const fullRec = { status: 'exported', by: 'ok@example.com', at: '2026-10-21T01:00:00.000Z', cust: '599801', orderDate: '2026-10-20', net: 14000, batchId: 'ec-0123456789abcdef', juchuNo: '90001',
  shipDate: '2026-10-23', memoNote: 'ブルー入荷待ち', importBy: 'imp@example.com', importAt: '2026-10-21T02:00:00.000Z', confirmedBy: 'cf@example.com', confirmedAt: '2026-10-21T03:00:00.000Z', reportedAt: '2026-10-21T02:30:00.000Z' };
t('注文の記録 ↔ リストの行：往復できる（OK・取込・確認OK・受注№・出荷予定日の手動変更・社内メモ・報告）', () => {
  const f = EC.orderFields('#1801', fullRec);
  assert.deepStrictEqual([f.Title, f.Status, f.OkBy, f.ImportBy, f.ConfirmBy, f.SmileOrderNo, f.ShipDateManual, f.MemoNote, f.NetTotal, f.CustomerCode, f.BatchId], ['1801', '起票済み', 'ok@example.com', 'imp@example.com', 'cf@example.com', '90001', true, 'ブルー入荷待ち', 14000, '599801', 'ec-0123456789abcdef']);
  assert.strictEqual(f.ShipDate, '2026-10-23T12:00:00Z'); assert.strictEqual(f.OrderDate, '2026-10-20T12:00:00Z');
  const back = EC.fieldsToRec(f);
  ['status', 'by', 'at', 'cust', 'orderDate', 'net', 'batchId', 'juchuNo', 'shipDate', 'memoNote', 'importBy', 'importAt', 'confirmedBy', 'confirmedAt', 'reportedAt'].forEach(k => assert.strictEqual(back[k], fullRec[k], k));
  assert.strictEqual(back.exportedBy, 'cf@example.com'); assert.strictEqual(back.orderName, '#1801');
  // 手動で変えていない出荷予定日（突合のとき決まった日）は matchedShip に戻る（shipDate にはならない＝手動変更ではない）
  const auto = EC.fieldsToRec(EC.orderFields('1802', { status: 'confirm', matchedShip: '2026-10-19', juchuNo: '9' }));
  assert.deepStrictEqual([auto.matchedShip, auto.shipDate], ['2026-10-19', undefined]);
  // 状態ごとに往復
  ['ok', 'importing', 'waiting', 'confirm', 'exported', 'check'].forEach(s => assert.strictEqual(EC.fieldsToRec(EC.orderFields('1', { status: s })).status, s));
  assert.strictEqual(EC.fieldsToRec(EC.orderFields('1', {})).status, undefined);   // 未確認＝状態なし
});
t('差分：変わった項目だけ（空・null・日時の秒未満・日付の時刻部分の違いは同じ）。Title と不明な状態は書かない', () => {
  const cur = EC.orderFields('1801', fullRec);
  assert.deepStrictEqual(EC.diffFields(cur, EC.orderFields('1801', fullRec)), {});
  const sp = Object.assign({}, cur, { OkAt: '2026-10-21T01:00:00Z', ShipDate: '2026-10-23T00:00:00Z', NetTotal: '14000', ShipDateManual: 'true' });   // SharePoint が返す形
  assert.deepStrictEqual(EC.diffFields(sp, cur), {});
  assert.deepStrictEqual(EC.diffFields(cur, EC.orderFields('1801', Object.assign({}, fullRec, { status: 'check', juchuNo: '' }))), { Status: '要確認', SmileOrderNo: null });
  assert.deepStrictEqual(EC.diffFields({ Title: '1', Status: 'OK済' }, { Title: '2', Status: '' }), {});
  assert.deepStrictEqual(EC.diffFields(null, { Title: '1', Status: 'OK済', MemoNote: '' }), { Status: 'OK済' });
});
t('リストを正として復元：リストの内容で上書き。まだ書けていない注文（pending）は上書きしない。リストに無い端末だけの注文は残る', () => {
  const local = { 1801: { status: 'ok', by: 'me@example.com', diffs: [{ x: 1 }] }, 1802: { status: 'ok' }, 1803: { status: 'ok', memoNote: '端末だけ' }, 1804: { status: 'confirm', checkMessage: 'x', diffs: [{ a: 1 }], matchedAt: 'm' } };
  const rows = { 1801: { Title: '1801', Status: '確認待ち', SmileOrderNo: '9' }, 1802: { Title: '1802', Status: '未確認' }, 1804: { Title: '1804', Status: '確認待ち', SmileOrderNo: '10' }, 1805: { Title: '1805', Status: '起票済み', ConfirmBy: 'x@example.com' } };
  const m = EC.mergeFromList(local, rows, { 1802: true });
  assert.strictEqual(m.orders[1801].status, 'confirm');                       // 他の人が進めた状態がリストから入る
  assert.strictEqual(m.orders[1801].diffs, undefined);                         // 状態が変わったので補足は捨てる
  assert.strictEqual(m.orders[1802].status, 'ok');                             // pending：この端末の内容を守る
  assert.strictEqual(m.orders[1803].memoNote, '端末だけ');                     // リストに無い＝残す
  assert.deepStrictEqual(m.localOnly, ['1803', '1802'].filter(id => id === '1803'));
  assert.deepStrictEqual(m.orders[1804].diffs, [{ a: 1 }]);                    // 状態が同じなら補足を残す
  assert.strictEqual(m.orders[1805].status, 'exported'); assert.strictEqual(m.orders[1805].confirmedBy, 'x@example.com');   // 他の人が作った注文
  assert.deepStrictEqual(m.kept, ['1802']);
  // 「未確認」に戻された注文は状態なしに
  assert.strictEqual(EC.mergeFromList({ 1802: { status: 'ok' } }, { 1802: { Title: '1802', Status: '未確認' } }, {}).orders[1802].status, undefined);
});
t('移行：リストに無い注文（状態があるもの）だけが対象。何度やっても同じ（移したあとは対象にならない）', () => {
  const local = { 1801: { status: 'ok' }, 1802: { status: 'exported' }, 1803: {}, 1804: { shipDate: '2026-10-20' }, 1805: { status: 'check' } };
  assert.deepStrictEqual(EC.migrationPlan(local, { 1805: {} }), ['1801', '1802']);
  assert.deepStrictEqual(EC.migrationPlan(local, { 1801: {}, 1802: {}, 1805: {} }), []);
  assert.deepStrictEqual(EC.migrationPlan({}, {}), []);
});
t('ログの1行：選択肢にない操作は「その他」。Title は操作＋注文番号。電話・メール・郵便番号は伏せる', () => {
  const r = EC.logRow({ action: '確認OK', orderNo: '#1801', actor: 'a@example.com', batchId: 'ec-1', detail: '受注№ 90001', now: '2026-10-21T00:00:00.000Z' });
  assert.deepStrictEqual(r, { Title: '確認OK #1801', LogTime: '2026-10-21T00:00:00.000Z', Actor: 'a@example.com', OrderNo: '1801', Action: '確認OK', BatchId: 'ec-1', Detail: '受注№ 90001' });
  assert.strictEqual(EC.logRow({ action: '謎', orderNo: '' }).Action, 'その他');
  assert.strictEqual(EC.logRow({ action: 'OK' }).Title, 'OK');
  assert.ok(!/03-1234|a@b\.jp/.test(EC.logRow({ action: 'OK', detail: '電話 03-1234-5678 / a@b.jp' }).Detail));
  assert.strictEqual(EC.scrubText('注文2610161230・受注№ 90001・14,000円・2026-10-21'), '注文2610161230・受注№ 90001・14,000円・2026-10-21');   // 注文番号・日付・金額はそのまま
  assert.strictEqual(EC.shortUser('taro@example.com'), 'taro');
});

t('報告の依頼者へのメンション：メールと表示名の形が正しいときだけ。params にメンション情報が入る（無い・不正なら入れない）', () => {
  assert.deepStrictEqual(EC.reportMention('taro@example.com', '福田 太郎'), { id: 'taro@example.com', name: '福田 太郎' });
  assert.deepStrictEqual(EC.reportMention('  taro@example.com ', '福田</at><at>他人\n'), { id: 'taro@example.com', name: '福田/atat他人' });   // < > & と制御文字は取り除く
  [['メールではない', '福田'], ['a@b', '福田'], ['', '福田'], [null, '福田'], ['a b@example.com', '福田'], ['taro@example.com', ''], ['taro@example.com', '<>'], ['taro@example.com', null]].forEach(([e, n]) => assert.strictEqual(EC.reportMention(e, n), null, String(e) + '/' + n));
  const parts = ['本文1', '本文2'];
  const p = EC.reportParams({ batchId: 'ec-0123456789abcdef', parts, requestedBy: 'taro@example.com', requestedByName: '福田 太郎' });
  assert.deepStrictEqual(p, { batchId: 'ec-0123456789abcdef', parts, mention: { id: 'taro@example.com', name: '福田 太郎' } });
  const none = EC.reportParams({ batchId: 'b', parts, requestedBy: 'taro@example.com', requestedByName: '' });   // 表示名なし → メンションなし（報告は出る）
  assert.deepStrictEqual(none, { batchId: 'b', parts }); assert.ok(!('mention' in none));
  assert.ok(!('mention' in EC.reportParams({ batchId: 'b', parts })));
  // 依頼者の情報は社員のもの。お客様の名前・住所・電話は params にも本文にも入らない
  const body = EC.buildReport({ batchId: 'b', counts: { slips: 1, fresh: 0 }, orders: [{ name: '#1801', juchuNo: '9', shipDate: '2026-10-19', status: 'confirm', ship: { name: '山田花子', phone: '0312345678' } }], url: 'u' }).join('\n');
  assert.ok(!/山田|0312345678/.test(body));
  assert.ok(body.includes('確認OKは、アプリの画面で行ってください'));
});

t('manifest：受注には slips（伝票の数）を付ける（1伝票2行→1／2伝票5行→2）。納品先には付けない。バッチ番号は slips を含めず、同じ内容は同じ番号のまま', () => {
  const f = importFixture(), J = L.juchu;
  const mkBatch = (slips, user) => {
    const jr = EC.juchuRows(slips, J, DEFAULT_CONFIG), nr = EC.nouhinRows(f.fresh.filter(x => slips.some(s => s.id === x.orderId)), L.nouhin, DEFAULT_CONFIG);
    const files = [{ name: 'nouhin.txt', rows: nr.length, bytes: EC.encodeUtf16(EC.toSmileText(L.nouhin, nr)) }, { name: 'juchu.txt', rows: jr.length, slips: EC.slipCount(jr, J), bytes: EC.encodeUtf16(EC.toSmileText(J, jr)) }];
    return { jr, b: EC.buildImportBatch(files, user, '2026-10-23T00:00:00Z') };
  };
  const two = mkBatch(f.slips, 'a@example.com'), one = mkBatch([f.slips[1]], 'a@example.com');
  assert.strictEqual(two.jr.length, 5); assert.strictEqual(EC.slipCount(two.jr, J), 2);
  const mj = m => m.manifest.files.find(x => x.name === 'juchu.txt'), mn = m => m.manifest.files.find(x => x.name === 'nouhin.txt');
  assert.deepStrictEqual([mj(two.b).rows, mj(two.b).slips], [5, 2]);
  assert.strictEqual(one.jr.length, 2); assert.deepStrictEqual([mj(one.b).rows, mj(one.b).slips], [2, 1]);
  assert.ok(!('slips' in mn(two.b)));                                       // 納品先は 1行＝1件。slips は付けない
  // バッチ番号：同じ内容なら（依頼者・時刻が違っても）同じ番号。slips の有無で変わらない（従来のバッチ番号の作り方のまま）
  assert.strictEqual(mkBatch(f.slips, 'b@example.com').b.batchId, two.b.batchId);
  const old = EC.buildImportBatch([{ name: 'juchu.txt', rows: 5, bytes: two.b.files[1].bytes }, { name: 'nouhin.txt', rows: 2, bytes: two.b.files[0].bytes }].reverse(), 'a', 'b');
  assert.ok(!('slips' in mj(old)));                                          // slips を渡さなければ manifest にも付かない（旧形式）
  assert.strictEqual(old.batchId, two.b.batchId);
  assert.notStrictEqual(one.b.batchId, two.b.batchId);
  assert.strictEqual(EC.slipCount([], J), 0);
});

/* ---------- 新しい納品先のコードは専用機が決める（仮の番号 N00001… ＋ manifest.tempCodes ＋ result.json の assigned） ---------- */
const TEMP = DEFAULT_CONFIG && CONF.rpaImport.tempCodes;
const mkTempSlip = (id, date, name, zip) => EC.buildSlip(order({ name: '#' + id, id, createdAt: date, ship: { name, company: '', zip, province: '東京都', city: '千代田区', addr1: '千代田' + id, addr2: '', phone: '0312345678' } }), ctx);
const tempMaster = () => EC.indexDeliveryMaster([{ '得意先ｺｰﾄﾞ': '599801', '納品先ｺｰﾄﾞ': '000770', '納品先名': '田中様', '郵便番号': '100-0009' }], DEFAULT_CONFIG);
const tempSlips = () => [
  mkTempSlip('1901', '2026-10-05', '山田', '100-0001'),     // 東京・新規
  mkTempSlip('1902', '2026-10-06', '鈴木', '100-0002'),     // 東京・新規
  mkTempSlip('1903', '2026-10-15', '山田', '100-0001'),     // 大阪・新規（東京の山田と同じ名前・郵便番号だが、得意先が違うので別のお客様）
  mkTempSlip('1904', '2026-10-16', '山田', '100-0001'),     // 大阪・1903 と同じお客様
  mkTempSlip('1905', '2026-10-05', '田中', '100-0009')];    // 東京・既存（マスタにある）
t('仮の番号モード：新規の納品先にだけ N00001… を割り当てる（得意先をまたいで重複しない・同じお客様は同じ番号・既存は本当のコード）', () => {
  assert.deepStrictEqual([TEMP.mode, TEMP.prefix, TEMP.digits, TEMP.requiredFeature], ['auto', 'N', 5, 'tempDeliveryCodes']);       // 形は設定から。既定は auto（専用機が対応しているときだけ仮の番号）
  const slips = tempSlips(), master = tempMaster();
  const fresh = EC.planDeliveries(slips, master, DEFAULT_CONFIG, { reuse: true, temp: TEMP });
  const by = Object.fromEntries(slips.map(s => [s.id, s]));
  assert.deepStrictEqual(slips.map(s => [s.id, s.cust, s.deliveryCode, s.deliveryNew, s.deliveryTemp]), [
    ['1901', '599801', 'N00001', true, true], ['1902', '599801', 'N00002', true, true], ['1903', '599802', 'N00003', true, true],
    ['1904', '599802', 'N00003', false, true], ['1905', '599801', '000770', false, false]]);
  assert.deepStrictEqual(fresh.map(f => [f.cust, f.code, f.temp, f.orderId]), [['599801', 'N00001', true, '1901'], ['599801', 'N00002', true, '1902'], ['599802', 'N00003', true, '1903']]);
  assert.ok(new Set(fresh.map(f => f.code)).size === fresh.length);                      // 得意先をまたいでも重複しない
  assert.strictEqual(master['599801'].max, '000770'); assert.ok(!Object.keys(master['599801'].used).some(c => /^N/.test(c)));   // 納品先マスタの索引は変えない
  // 同じ入力なら（注文の並びが違っても）同じ番号
  const again = tempSlips().reverse(); EC.planDeliveries(again, tempMaster(), DEFAULT_CONFIG, { reuse: true, temp: TEMP });
  assert.deepStrictEqual(again.map(s => [s.id, s.deliveryCode]).sort(), slips.map(s => [s.id, s.deliveryCode]).sort());
  // 本当の番号モード（temp を渡さない）は今までどおり
  const real = tempSlips(); EC.planDeliveries(real, tempMaster(), DEFAULT_CONFIG, { reuse: true });
  assert.deepStrictEqual(real.map(s => s.deliveryCode), ['000001', '000002', '000001', '000001', '000770'].map((c, i) => real[i].deliveryCode));
  assert.ok(real.every(s => /^\d{6}$/.test(s.deliveryCode)) && real.every(s => !s.deliveryTemp));
  assert.strictEqual(by['1905'].deliveryCode, '000770');
});
t('仮の番号：nouhin.txt・juchu.txt の納品先コードの列に同じ仮の番号。manifest.tempCodes。バッチ番号は同じ内容なら変わらない', () => {
  const mk = (slips) => {
    const fresh = EC.planDeliveries(slips, tempMaster(), DEFAULT_CONFIG, { reuse: true, temp: TEMP });
    const nr = EC.nouhinRows(fresh, L.nouhin, DEFAULT_CONFIG), jr = EC.juchuRows(slips, L.juchu, DEFAULT_CONFIG);
    const files = [{ name: 'nouhin.txt', rows: nr.length, bytes: EC.encodeUtf16(EC.toSmileText(L.nouhin, nr)) }, { name: 'juchu.txt', rows: jr.length, slips: EC.slipCount(jr, L.juchu), bytes: EC.encodeUtf16(EC.toSmileText(L.juchu, jr)) }];
    return { fresh, nr, jr, b: EC.buildImportBatch(files, 'a@example.com', '2026-10-23T00:00:00Z', { tempCodes: EC.tempCodes(fresh) }) };
  };
  const x = mk(tempSlips());
  assert.deepStrictEqual(x.nr.map(r => [r[0], r[1]]), [['599801', 'N00001'], ['599801', 'N00002'], ['599802', 'N00003']]);   // 納品先コード＝1列目（得意先コード＝0列目）
  const col6 = x.jr.map(r => [r[3], r[6]]);                                                  // 受注：得意先コード＝3列目・納品先コード＝6列目
  assert.deepStrictEqual(col6, [['599801', 'N00001'], ['599801', 'N00001'], ['599801', '000770'], ['599801', '000770'], ['599801', 'N00002'], ['599801', 'N00002'], ['599802', 'N00003'], ['599802', 'N00003'], ['599802', 'N00003'], ['599802', 'N00003']].slice(0, x.jr.length).map((c, i) => [x.jr[i][3], x.jr[i][6]]));
  const codes = new Set(x.jr.map(r => r[6])); ['N00001', 'N00002', 'N00003', '000770'].forEach(c => assert.ok(codes.has(c), c));
  assert.ok(x.jr.every(r => !/^0000(0[1-9]|[1-9]\d)$/.test(r[6]) || r[6] === '000770'));      // 新規に本当のコードは入っていない
  assert.deepStrictEqual(x.b.manifest.tempCodes, [{ customer: '599801', temp: 'N00001' }, { customer: '599801', temp: 'N00002' }, { customer: '599802', temp: 'N00003' }]);
  assert.strictEqual(L.nouhin[0], '得意先コード'); assert.strictEqual(L.nouhin[1], '納品先コード'); assert.strictEqual(L.juchu[3], '得意先コード'); assert.strictEqual(L.juchu[6], '納品先コード');
  // バッチ番号：同じ内容なら同じ番号（依頼者・時刻が違っても）。tempCodes はバッチ番号に含めない
  const y = mk(tempSlips().reverse());
  assert.strictEqual(y.b.batchId, x.b.batchId);
  const noTemp = EC.buildImportBatch(x.b.files.map(f => ({ name: f.name, rows: f.rows, slips: f.slips, bytes: f.bytes })), 'b', 'c');
  assert.strictEqual(noTemp.batchId, x.b.batchId); assert.ok(!('tempCodes' in noTemp.manifest));   // 仮の番号を使っていなければ tempCodes は付かない
  assert.deepStrictEqual(EC.tempCodes([{ cust: '1', code: '000001', d: {}, orderId: 'x' }]), []);
});
// SMILE が仮の番号を本当のコードに置き換えて取り込んだあとの出力（受注明細・納品先マスタ）を作る
function assignedFixture(assigned) {
  const slips = tempSlips(), fresh = EC.planDeliveries(slips, tempMaster(), DEFAULT_CONFIG, { reuse: true, temp: TEMP });
  const expected = EC.expectedImport(slips, fresh), map = {}; assigned.forEach(a => { map[a.temp] = a.code; });
  const fix = c => map[c] || c;
  const jobjs = EC.juchuRows(slips, L.juchu, DEFAULT_CONFIG).map(r => { const o = {}; L.juchu.forEach((h, i) => { o[h] = r[i]; }); o['納品先コード'] = fix(o['納品先コード']); o['受注№'] = '7' + o['受注№']; return o; });
  const nobjs = EC.nouhinRows(fresh, L.nouhin, DEFAULT_CONFIG).map(r => { const o = {}; L.nouhin.forEach((h, i) => { o[h] = r[i]; }); o['納品先コード'] = fix(o['納品先コード']); return o; });
  nobjs.push({ '得意先コード': '599801', '納品先コード': '000770', '納品先名': '田中様', '郵便番号': '100-0009' });
  return { expected, jobjs, nobjs };
}
const ASSIGNED = [{ customer: '599801', temp: 'N00001', code: '000771' }, { customer: '599801', temp: 'N00002', code: '000772' }, { customer: '599802', temp: 'N00003', code: '000501' }];
t('assigned を使った突合：新規は専用機が決めた本当のコードで一致、既存はそのまま。仮の番号は残らない', () => {
  const f = assignedFixture(ASSIGNED), r = EC.resolveAssigned(f.expected, ASSIGNED);
  assert.deepStrictEqual(r.unresolved, []); assert.deepStrictEqual(r.codes, { N00001: '000771', N00002: '000772', N00003: '000501' });
  assert.deepStrictEqual(Object.values(r.expected.orders).map(o => [o.id, o.deliveryCode, o.deliveryTemp]), [['1901', '000771', false], ['1902', '000772', false], ['1903', '000501', false], ['1904', '000501', false], ['1905', '000770', false]]);
  assert.ok(r.expected.deliveries.every(d => !d.temp && /^\d{6}$/.test(d.code)));
  assert.ok(!JSON.stringify(r.expected.orders['1901']).includes('"deliveryCode":"N0'));         // 期待値の納品先コードに仮の番号が残らない
  const v = EC.verifyImport(r.expected, f.jobjs, f.nobjs);
  assert.ok(Object.values(v.orders).every(o => o.status === 'ok'), JSON.stringify(Object.values(v.orders).map(o => o.diffs)));
  assert.deepStrictEqual(Object.keys(v.deliveries).sort(), ['000501', '000771', '000772']);
  assert.ok(Object.values(v.deliveries).every(d => d.status === 'ok'));
  // 元の期待値は変わらない（仮の番号のまま保存できる）
  assert.strictEqual(f.expected.orders['1901'].deliveryCode, 'N00001');
});
t('assigned に番号がない／code が空 → その注文は要確認（番号を確認できません）。ほかの注文は一致', () => {
  const miss = ASSIGNED.filter(a => a.temp !== 'N00002'), f = assignedFixture(miss);
  const r = EC.resolveAssigned(f.expected, miss);
  assert.deepStrictEqual(r.unresolved, ['1902']);
  const v = EC.verifyImport(r.expected, f.jobjs, f.nobjs);
  assert.strictEqual(v.orders['1902'].status, 'ng');
  assert.deepStrictEqual([v.orders['1902'].diffs[0].label, v.orders['1902'].diffs[0].actual], ['納品先コード', '番号を確認できません']);
  ['1901', '1903', '1904', '1905'].forEach(id => assert.strictEqual(v.orders[id].status, 'ok', id));
  const empty = ASSIGNED.map(a => a.temp === 'N00003' ? Object.assign({}, a, { code: '' }) : a), f2 = assignedFixture(ASSIGNED);
  const r2 = EC.resolveAssigned(f2.expected, empty);
  assert.deepStrictEqual(r2.unresolved.sort(), ['1903', '1904']);
  const v2 = EC.verifyImport(r2.expected, f2.jobjs, f2.nobjs);
  assert.deepStrictEqual(['1903', '1904'].map(id => v2.orders[id].status), ['ng', 'ng']);
  // 得意先が違う assigned は使わない（temp が同じでも得意先ごと）
  const wrongCust = [{ customer: '599802', temp: 'N00001', code: '000771' }];
  assert.ok(EC.resolveAssigned(f.expected, wrongCust).unresolved.includes('1901'));
  // assigned が無い（undefined・空）：仮の番号を使った注文は要確認
  assert.strictEqual(EC.resolveAssigned(f.expected, undefined).unresolved.length, 4);
  // SMILE に本当のコードが入っていなければ（納品先マスタに無い・受注の納品先コードが違う）不一致
  const bad = assignedFixture(ASSIGNED); bad.jobjs.filter(o => o['客先注番'] === '1901').forEach(o => { o['納品先コード'] = '000999'; });
  const vb = EC.verifyImport(EC.resolveAssigned(bad.expected, ASSIGNED).expected, bad.jobjs, bad.nobjs);
  assert.ok(vb.orders['1901'].diffs.some(d => d.field === 'deliveryCode' && d.expected === '000771' && d.actual === '000999'));
});
t('旧形式の互換：assigned の無い result.json でも、仮の番号を使っていないバッチ（本当のコード）は今までどおり', () => {
  const f = importFixture();                                                                 // 本当の番号モードのバッチ
  assert.ok(Object.values(f.expected.orders).every(o => !o.deliveryTemp));
  const r = EC.resolveAssigned(f.expected, undefined);
  assert.deepStrictEqual(r.unresolved, []); assert.deepStrictEqual(r.expected, JSON.parse(JSON.stringify(f.expected)));
  assert.ok(Object.values(EC.verifyImport(r.expected, f.jobjs, f.nobjs).orders).every(o => o.status === 'ok'));
  assert.ok(Object.values(EC.verifyImport(f.expected, f.jobjs, f.nobjs).orders).every(o => o.status === 'ok'));   // resolve を通さなくても同じ
});
t('報告：一致した注文に最終の納品先コードを出す（仮の番号は出さない）', () => {
  const p = EC.buildReport({ batchId: 'b', counts: { slips: 2, fresh: 1 }, orders: [{ name: '#1901', juchuNo: '70001', shipDate: '2026-10-19', status: 'confirm', deliveryCode: '000771' }, { name: '#1902', juchuNo: '70002', shipDate: '2026-10-19', status: 'confirm' }], url: 'u' }).join('\\n');
  assert.ok(p.includes('・#1901　受注№ 70001　出荷予定日 10/19(月)　納品先 000771')); assert.ok(!/N00\d\d\d/.test(p));
});
t('テスト送信（temp モード）：納品先の新規は仮の番号。同じ名前・郵便番号のものがあればそれを使う。assigned で最終のコードに', () => {
  assert.strictEqual(TI_CONF.codeMode, 'auto');                                              // 既定は auto（専用機が対応していれば temp、なければ fixed）
  assert.strictEqual(EC.testSendGuard(TI_CONF, DEFAULT_CONFIG), '');
  assert.strictEqual(EC.testSendGuard(Object.assign({}, TI_CONF, { deliveryCode: '000770' }), DEFAULT_CONFIG), '');   // temp では固定のコードの範囲を見ない
  assert.ok(/連番の範囲/.test(EC.testSendGuard(Object.assign({}, TI_CONF, { codeMode: 'fixed', deliveryCode: '000770' }), DEFAULT_CONFIG)));   // fixed では見る
  const r = EC.buildTestImport(TI_CONF, DEFAULT_CONFIG, tOpt({ temp: TEMP })), s = r.slips[0];
  assert.deepStrictEqual([s.deliveryCode, s.deliveryNew, s.deliveryTemp], ['N00001', true, true]);
  assert.deepStrictEqual(r.fresh.map(x => [x.cust, x.code, x.temp]), [['599801', 'N00001', true]]);
  assert.deepStrictEqual(EC.tempCodes(r.fresh), [{ customer: '599801', temp: 'N00001' }]);
  assert.strictEqual(EC.nouhinRows(r.fresh, L.nouhin, DEFAULT_CONFIG)[0][1], 'N00001');
  assert.strictEqual(EC.juchuRows(r.slips, L.juchu, DEFAULT_CONFIG)[0][6], 'N00001');
  // 製番が付かない品目だけ（安全弁は変えない）
  assert.ok(r.slips[0].lines.every(l => String(l.teihai) === '2'));
  assert.ok(EC.buildTestImport(Object.assign({}, TI_CONF, { lines: [{ code: 'TC', qty: 1, unitNet: 7000 }] }), DEFAULT_CONFIG, tOpt({ temp: TEMP })).error);
  // マスタに同じ名前・郵便番号がある（前回のテスト送信で SMILE が付けたコード）→ それを使う。納品先ファイルは作らない
  const key = EC.testDeliveryKey(TI_CONF), m = EC.indexDeliveryMaster([{ '得意先ｺｰﾄﾞ': '599801', '納品先ｺｰﾄﾞ': '000805', '納品先名': TI_CONF.deliveryName, '郵便番号': TI_CONF.zip }], DEFAULT_CONFIG);
  assert.strictEqual(m['599801'].keys[key], '000805');
  const again = EC.buildTestImport(TI_CONF, DEFAULT_CONFIG, tOpt({ temp: TEMP, existingCode: m['599801'].keys[key] }));
  assert.deepStrictEqual([again.slips[0].deliveryCode, again.slips[0].deliveryNew, again.slips[0].deliveryTemp, again.fresh.length], ['000805', false, false, 0]);
  // assigned → 最終のコードで突合
  const exp = EC.expectedImport(r.slips, r.fresh), jobjs = EC.juchuRows(r.slips, L.juchu, DEFAULT_CONFIG).map(x => { const o = {}; L.juchu.forEach((h, i) => { o[h] = x[i]; }); o['受注№'] = '70001'; o['納品先コード'] = '000805'; return o; });
  const nobjs = EC.nouhinRows(r.fresh, L.nouhin, DEFAULT_CONFIG).map(x => { const o = {}; L.nouhin.forEach((h, i) => { o[h] = x[i]; }); o['納品先コード'] = '000805'; return o; });
  const ok = EC.resolveAssigned(exp, [{ customer: '599801', temp: 'N00001', code: '000805' }]);
  const v = EC.verifyImport(ok.expected, jobjs, nobjs);
  assert.strictEqual(v.orders[r.id].status, 'ok'); assert.strictEqual(v.deliveries['000805'].status, 'ok'); assert.strictEqual(ok.codes.N00001, '000805');
  assert.strictEqual(EC.verifyImport(EC.resolveAssigned(exp, []).expected, jobjs, nobjs).orders[r.id].status, 'ng');
});

/* ---------- 仮の番号は、専用機が対応しているときだけ（稼働の印 heartbeat.json の features で自動判定） ---------- */
t('仮の番号の判定（auto）：印に tempDeliveryCodes があり、印が新しいときだけ temp。それ以外は real（今までどおり）', () => {
  const D = EC.deliveryCodeMode, cfgAuto = { mode: 'auto', requiredFeature: 'tempDeliveryCodes' };
  const hb = (o) => Object.assign({ ok: true, seenAt: Date.now(), features: ['tempDeliveryCodes'] }, o);
  assert.strictEqual(CONF.rpaImport.tempCodes.mode, 'auto');                                     // 既定は auto
  assert.deepStrictEqual([D(cfgAuto, hb()).mode, D(cfgAuto, hb()).blocked], ['temp', '']);          // feature あり・印が新しい → temp
  assert.deepStrictEqual([D(cfgAuto, hb({ features: [] })).mode, D(cfgAuto, hb({ features: [] })).blocked], ['real', '']);   // feature なし → real（止めない）
  assert.strictEqual(D(cfgAuto, hb({ features: undefined })).mode, 'real');                          // features の項目なし（古い常駐スクリプト）
  assert.strictEqual(D(cfgAuto, hb({ features: ['別の機能'] })).mode, 'real');
  assert.strictEqual(D(cfgAuto, hb({ ok: false })).mode, 'real');                                   // 印が古い（応答なし）→ feature があっても real
  assert.strictEqual(D(cfgAuto, null).mode, 'real');                                                // 印なし・確認できない → real
  assert.strictEqual(D(undefined, hb()).mode, 'temp');                                              // 設定の mode を省けば auto
  assert.ok(/応答していません/.test(D(cfgAuto, hb({ ok: false })).reason) && /対応していません/.test(D(cfgAuto, hb({ features: [] })).reason) && /確認できません/.test(D(cfgAuto, null).reason));
  assert.strictEqual(D(cfgAuto, hb()).reason, '取込時に専用機が番号を決めます'); assert.ok(D(cfgAuto, hb({ features: [] })).reason.startsWith('アプリが番号を決めます'));
  // requiredFeature は設定から
  assert.strictEqual(D({ mode: 'auto', requiredFeature: 'x' }, hb({ features: ['x'] })).mode, 'temp');
  assert.strictEqual(D({ mode: 'auto', requiredFeature: 'x' }, hb()).mode, 'real');
});
t('仮の番号の判定（temp を明示）：印に feature が無ければ blocked（送信を止める）。real は常に real', () => {
  const D = EC.deliveryCodeMode, hb = (o) => Object.assign({ ok: true, features: ['tempDeliveryCodes'] }, o), tmp = { mode: 'temp' }, real = { mode: 'real' };
  assert.deepStrictEqual([D(tmp, hb()).mode, D(tmp, hb()).blocked], ['temp', '']);
  [hb({ features: [] }), hb({ ok: false }), null, hb({ features: undefined })].forEach(h => {
    const d = D(tmp, h); assert.strictEqual(d.mode, 'temp'); assert.ok(d.blocked && /送信を止めました/.test(d.blocked), JSON.stringify(h));   // 誤って仮の番号が SMILE に入らない
  });
  [hb(), hb({ features: [] }), null].forEach(h => assert.deepStrictEqual([D(real, h).mode, D(real, h).blocked], ['real', '']));
});
t('real のときは今までどおりのファイル：新規の納品先に本当のコード・manifest に tempCodes なし（仮の番号が入らない）', () => {
  const slips = tempSlips(), fresh = EC.planDeliveries(slips, tempMaster(), DEFAULT_CONFIG, { reuse: true, temp: null });   // real（auto で専用機が未対応・real 指定）
  assert.ok(slips.every(s => /^\d{6}$/.test(s.deliveryCode) && !s.deliveryTemp));
  assert.ok(fresh.every(f => !f.temp && /^\d{6}$/.test(f.code)));
  assert.deepStrictEqual(EC.tempCodes(fresh), []);
  const nr = EC.nouhinRows(fresh, L.nouhin, DEFAULT_CONFIG), jr = EC.juchuRows(slips, L.juchu, DEFAULT_CONFIG);
  assert.ok(nr.every(r => /^\d{6}$/.test(r[1])) && jr.every(r => /^\d{6}$/.test(r[6])));
  const b = EC.buildImportBatch([{ name: 'nouhin.txt', rows: nr.length, bytes: EC.encodeUtf16(EC.toSmileText(L.nouhin, nr)) }], 'a', 'b', { tempCodes: EC.tempCodes(fresh) });
  assert.ok(!('tempCodes' in b.manifest));
  // モードが違えば別のバッチ（同じ注文でも取込ファイルの中身が違う）
  const t2 = tempSlips(), f2 = EC.planDeliveries(t2, tempMaster(), DEFAULT_CONFIG, { reuse: true, temp: TEMP });
  const nr2 = EC.nouhinRows(f2, L.nouhin, DEFAULT_CONFIG);
  assert.notStrictEqual(EC.buildImportBatch([{ name: 'nouhin.txt', rows: nr2.length, bytes: EC.encodeUtf16(EC.toSmileText(L.nouhin, nr2)) }], 'a', 'b').batchId, b.batchId);
});
t('テスト送信も同じ判定：auto＝対応していなければ固定の 999998、temp 明示で対応なし→止める、fixed は常に固定', () => {
  const D = EC.deliveryCodeMode, hbOk = { ok: true, features: ['tempDeliveryCodes'] }, hbNo = { ok: true, features: [] };
  const mode = (codeMode) => ({ mode: codeMode === 'temp' ? 'temp' : (codeMode === 'fixed' ? 'real' : 'auto'), requiredFeature: 'tempDeliveryCodes' });
  assert.strictEqual(TI_CONF.codeMode, 'auto');
  assert.strictEqual(D(mode(TI_CONF.codeMode), hbOk).mode, 'temp'); assert.strictEqual(D(mode(TI_CONF.codeMode), hbNo).mode, 'real'); assert.strictEqual(D(mode(TI_CONF.codeMode), null).mode, 'real');
  assert.ok(D(mode('temp'), hbNo).blocked); assert.strictEqual(D(mode('fixed'), hbOk).mode, 'real');
  // real に倒れたとき（codeMode: fixed）は、これまでと同じファイル（999998）
  const r = EC.buildTestImport(Object.assign({}, TI_CONF, { codeMode: 'fixed' }), DEFAULT_CONFIG, tOpt());
  assert.deepStrictEqual([r.slips[0].deliveryCode, r.slips[0].deliveryTemp, r.fresh[0].temp], ['999998', false, false]);
  assert.deepStrictEqual(EC.tempCodes(r.fresh), []);
});
t('稼働の印（RpaQueue.health）：features を返す。印が古いと ok:false・無ければ空', async () => {
  const src = fs.readFileSync(__dirname + '/../rpa_queue.js', 'utf8');
  const make = (hb) => { globalThis.fetch = async () => (hb === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, json: async () => hb, text: async () => '' }); const Q = new Function(src + '; return RpaQueue;')(); Q.init({ getToken: async () => 't', driveId: 'D' }); return Q; };
  const now = new Date().toISOString(), old = new Date(Date.now() - 3 * 3600e3).toISOString();
  let h = await make({ updatedAt: now, job: '', features: ['tempDeliveryCodes'] }).health();
  assert.deepStrictEqual([h.ok, h.features], [true, ['tempDeliveryCodes']]); assert.strictEqual(EC.deliveryCodeMode({ mode: 'auto' }, h).mode, 'temp');
  h = await make({ updatedAt: now }).health(); assert.deepStrictEqual([h.ok, h.features], [true, []]); assert.strictEqual(EC.deliveryCodeMode({ mode: 'auto' }, h).mode, 'real');
  h = await make({ updatedAt: old, features: ['tempDeliveryCodes'] }).health(); assert.strictEqual(h.ok, false); assert.strictEqual(EC.deliveryCodeMode({ mode: 'auto' }, h).mode, 'real');
  assert.strictEqual(await make(undefined).health().then(x => x && x.ok), false);                // 印なし（ファイルが無い）→ ok:false → real
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
// 実際の品目マスタで、テスト送信の品目が「手配区分2・在庫管理なし」に当たること（手元にあるPCだけ）
if (fs.existsSync(SM + '品目マスタ.csv')) {
  t('実データ：品目マスタで、テスト送信の品目（FR）は 手配区分2・在庫管理なし。TC は当たらない（製番が付く）', () => {
    const real = {}; EC.parseObjects(fs.readFileSync(SM + '品目マスタ.csv', 'utf8')).forEach(r => { real[r['品目ｺｰﾄﾞ']] = { name: r['品目名'], unit: r['単位'], teihai: r['初期表示用手配区分'], stock: r['在庫管理区分名'] }; });
    assert.ok(!EC.buildTestImport(TI, DEFAULT_CONFIG, { items: real, today: '2026-10-16', stamp: '2610161230' }).error);
    assert.ok(EC.buildTestImport(Object.assign({}, TI, { lines: [{ code: 'TC', qty: 1, unitNet: 7000 }] }), DEFAULT_CONFIG, { items: real, today: '2026-10-16', stamp: '2610161230' }).error);
  });
}
console.log('ec_sales_core: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
