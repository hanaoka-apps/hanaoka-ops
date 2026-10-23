// 使い方: node mkbatch.cjs <リポジトリ> <出力先の _rpa_import フォルダ>  → バッチ番号を表示（模擬の取込ファイル。実データなし）
const fs = require('fs'), path = require('path');
const repo = process.argv[2], root = process.argv[3];
const EC = require(path.join(repo, 'ec_sales_core.js')), L = require(path.join(repo, 'ec_sales_layouts.js'));
const CONF = JSON.parse(fs.readFileSync(path.join(repo, 'ec_sales_config.json'), 'utf8'));
const ITEMS = { FCART2x4BK: { name: 'FCART2x4 Black', unit: '台', teihai: '1' }, TCBK: { name: 'ﾃｰﾌﾞﾙｺﾝﾃﾅ', unit: '個', teihai: '1' }, FR: { name: 'ｳﾝﾁﾝ', unit: '式', teihai: '2' } };
const ctx = { mapping: CONF.mapping, cfg: CONF.config, items: ITEMS };
const o = { name: '#1801', id: '1801', createdAt: '2026-10-15', createdTime: '12:00', financial: 'paid', fulfillment: 'unfulfilled', cancelledAt: '', total: 17050, subtotal: 15400, shipping: 1650, discountAmount: 0, discountCode: '', refunded: 0, paymentMethod: 'Shopify Payments', notes: '',
  lines: [{ name: 'FLATCART 2x4（ブラック） - オプションは注文しない', sku: '', qty: 1, price: 15400 }],
  ship: { name: 'テスト太郎', company: '', zip: '100-0001', province: '東京都', city: '千代田区', addr1: 'テスト１−１', addr2: '', phone: '0312345678' }, bill: { phone: '' }, phone: '' };
const vm = /^v(\d+)/.exec(process.argv[4] || ''); if (vm) { o.id = vm[1]; o.name = '#' + vm[1]; }
const s = EC.buildSlip(o, ctx); const fresh = EC.planDeliveries([s], EC.indexDeliveryMaster([], CONF.config), CONF.config, { reuse: true });
const mode = process.argv[4] || 'ok';
const nb = EC.encodeUtf16(EC.toSmileText(L.nouhin, EC.nouhinRows(fresh, L.nouhin, CONF.config)));
let jrows = EC.juchuRows([s], L.juchu, CONF.config);
if (mode === 'emptyqty') jrows[0][22] = '';
const jb = EC.encodeUtf16(EC.toSmileText(L.juchu, jrows));
const b = EC.buildImportBatch([{ name: 'nouhin.txt', rows: fresh.length, bytes: nb }, { name: 'juchu.txt', rows: jrows.length, slips: EC.slipCount(jrows, L.juchu), bytes: jb }], 'admin@example.com', new Date().toISOString());
const dir = path.join(root, b.batchId); fs.mkdirSync(dir, { recursive: true });
b.files.forEach(f => fs.writeFileSync(path.join(dir, f.name), f.bytes));
if (mode === 'badhash') fs.appendFileSync(path.join(dir, 'juchu.txt'), 'x');
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(b.manifest));
console.log(b.batchId);
