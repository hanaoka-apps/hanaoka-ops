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

/* ---------- テスト送信（管理者メニュー。SMILE のテスト用得意先に仮データを1件） ---------- */
const TI = CONF.testImport;
const TITEMS = Object.assign({}, ITEMS, { TC: { name: 'ﾃｰﾌﾞﾙｺﾝﾃﾅ', unit: '個', teihai: '1' } });
const tOpt = (over) => Object.assign({ items: TITEMS, today: '2026-10-16', stamp: '2610161230', deliveryCodes: {} }, over);
t('テスト送信：設定は本番ECの得意先と別で、安全弁を通る', () => {
  assert.strictEqual(TI.customerCode, '110101'); assert.strictEqual(TI.deliveryCode, '999998');
  assert.ok(!DEFAULT_CONFIG.customers[TI.customerCode]);
  assert.strictEqual(EC.testSendGuard(TI, DEFAULT_CONFIG), '');
});
t('テスト送信：安全弁（本番ECの得意先・不備のある設定は拒否）', () => {
  assert.ok(/本番ECの得意先/.test(EC.testSendGuard(Object.assign({}, TI, { customerCode: '599801' }), DEFAULT_CONFIG)));
  assert.ok(/本番ECの得意先/.test(EC.testSendGuard(Object.assign({}, TI, { customerCode: '599802' }), DEFAULT_CONFIG)));
  assert.ok(EC.testSendGuard(null, DEFAULT_CONFIG));
  assert.ok(EC.testSendGuard(Object.assign({}, TI, { deliveryCode: '12' }), DEFAULT_CONFIG));
  assert.ok(EC.testSendGuard(Object.assign({}, TI, { lines: [] }), DEFAULT_CONFIG));
  const r = EC.buildTestImport(Object.assign({}, TI, { customerCode: '599801' }), DEFAULT_CONFIG, tOpt());
  assert.ok(r.error && !r.slips);                                          // 拒否されたら取込データは作らない
});
t('テスト送信：仮の注文1件（2行・手配区分1と2・翌営業日・社内メモ・テスト用の得意先）', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), s = r.slips[0];
  assert.strictEqual(r.slips.length, 1);
  assert.strictEqual(r.id, 'TEST2610161230');
  assert.deepStrictEqual(s.lines.map(l => [l.code, l.qty, l.unitNet, l.amountNet, l.teihai]), [['TC', 1, 7000, 7000, '1'], ['FR', 1, 1500, 1500, '2']]);
  assert.strictEqual(s.shipDate, '2026-10-19');                            // 金曜の翌営業日＝月曜
  assert.strictEqual(s.memo, '花岡EC（テスト送信）'); assert.strictEqual(s.cust, '110101');
  assert.strictEqual(r.net, 8500); assert.strictEqual(r.gross, 9350);
  assert.strictEqual(EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ today: '2026-10-15' })).slips[0].shipDate, '2026-10-16');
});
t('テスト送信：客先注番は毎回ユニーク。数字の部分で照合できる', () => {
  const a = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()).id, b = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ stamp: '2610161231' })).id;
  assert.notStrictEqual(a, b); assert.ok(/^TEST\d{10}$/.test(a)); assert.ok(a.replace(/\D/g, '').length === 10);
});
t('テスト送信：納品先 999998 が無ければ新規（納品先ファイルを作る）、あれば作らない', () => {
  const fresh = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt());
  assert.strictEqual(fresh.fresh.length, 1); assert.strictEqual(fresh.slips[0].deliveryNew, true);
  const rows = EC.nouhinRows(fresh.fresh, L.nouhin, DEFAULT_CONFIG)[0];
  assert.deepStrictEqual([rows[0], rows[1], rows[2], rows[6], rows[7], rows[11]], ['110101', '999998', 'テスト納品先（削除予定）', '143-0006', '東京都大田区平和島3-1-7', '03-3765-5626']);
  const had = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ deliveryCodes: { '999998': true } }));
  assert.strictEqual(had.fresh.length, 0); assert.strictEqual(had.slips[0].deliveryNew, false);
});
t('テスト送信：取込ファイル（受注）の中身と、品目マスタにない品目はエラー', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), J = L.juchu;
  const rows = EC.juchuRows(r.slips, J, EC.testCfg(TI, DEFAULT_CONFIG));
  assert.strictEqual(rows.length, 2);
  const col = n => J.indexOf(n);
  assert.deepStrictEqual([rows[0][col('得意先コード')], rows[0][col('担当者コード')], rows[0][col('部門コード')], rows[0][col('倉庫コード')], rows[0][col('納品先コード')], rows[0][col('客先注番')], rows[0][col('社内メモ')]],
    ['110101', '900230', '002220', '000105', '999998', '2610161230', '花岡EC（テスト送信）']);
  assert.deepStrictEqual([rows[0][col('手配区分')], rows[1][col('手配区分')]], ['1', '2']);
  assert.ok(EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt({ items: { FR: TITEMS.FR } })).error);
});
t('テスト送信：突き合わせ（一致・金額違い）。本番ECの注文は対象外', () => {
  const r = EC.buildTestImport(TI, DEFAULT_CONFIG, tOpt()), J = L.juchu, N = L.nouhin;
  const expected = EC.expectedImport(r.slips, r.fresh);
  const jobjs = EC.juchuRows(r.slips, J, EC.testCfg(TI, DEFAULT_CONFIG)).map(x => { const o = {}; J.forEach((h, i) => { o[h] = x[i]; }); o['受注№'] = '70001'; return o; });
  const nobjs = EC.nouhinRows(r.fresh, N, DEFAULT_CONFIG).map(x => { const o = {}; N.forEach((h, i) => { o[h] = x[i]; }); return o; });
  const ok = EC.verifyImport(expected, jobjs, nobjs);
  assert.strictEqual(ok.orders[r.id].status, 'ok'); assert.strictEqual(ok.orders[r.id].juchuNo, '70001'); assert.strictEqual(ok.deliveries['999998'].status, 'ok');
  const bad = JSON.parse(JSON.stringify(jobjs)); bad[1]['金額'] = '1499';
  assert.ok(EC.verifyImport(expected, bad, nobjs).orders[r.id].diffs.some(d => d.field === 'amount' && d.line === 2));
  // 同じ客先注番が本番EC の得意先にあっても、得意先が違えば見つからない扱い
  const other = jobjs.map(o => Object.assign({}, o, { '得意先コード': '599802' }));
  assert.strictEqual(EC.verifyImport(expected, other, nobjs).orders[r.id].status, 'missing');
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
