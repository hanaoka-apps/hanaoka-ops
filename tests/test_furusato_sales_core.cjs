// node tests/test_furusato_sales_core.cjs
// ダミーのお客様・ダミーの住所だけを使う（実データは入れない）
const assert = require('assert');
const fs = require('fs');
const EC = require('../ec_sales_core.js');
const L = require('../ec_sales_layouts.js');
const FS = require('../furusato_sales_core.js');
const CONF = JSON.parse(fs.readFileSync(__dirname + '/../furusato_config.json', 'utf8'));
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const ITEMS = {};
['FCART02', 'FCART2x4', 'FCART2x4BK', 'UDLDX', 'UPLLSC', 'UXLLS', 'UXLLSC', 'UDALSC', 'DAP', 'DABW', 'FCARTDIN', 'TCBK', 'DAT2', 'DALSC-GB', 'OP/XL-HS', 'OP/XLPB'].forEach(c => { ITEMS[c] = { name: c + '名', unit: '台', teihai: '1' }; });
ITEMS.FR = { name: '運賃', unit: '式', teihai: '2' };
const ctx = { mapping: CONF.mapping, cfg: CONF.config, items: ITEMS };

const HEAD = 'No.,受注番号,発注番号,送り状番号,出荷予定日,送り状種類,代引金額,お届け先電話番号,お届け先名,お届け先郵便番号,お届け先住所,お届け先建物名,お届け先会社名・部門,ご依頼主電話番号,ご依頼主名,ご依頼主郵便番号,ご依頼主住所,ご依頼主建物名,商品番号,品名,数量,配達希望日,配達時間帯,のし表書き,のし名前,のしに関する備考,備考';
function row(o) {
  const d = Object.assign({ no: 1, juchu: '3172779', po: '2630248', slip: '', ship: '', tel: '090-0000-0001', name: '山田 太郎', zip: '441-0001', addr: '愛知県豊橋市大手町1-2-3', bld: '', code: 'A112170384', item: '【鴻巣市ふるさと納税】花岡車輌 2輪・4輪で使えるフラットカート 2×4ブラック F-CART2×4BK', qty: 1, wantDate: '', wantTime: '希望無', biko: '鴻巣市ふるさと納税　　　133285685　　名前カナ「ヤマダ タロウ」' }, o);
  return [d.no, d.juchu, d.po, d.slip, d.ship, 0, 0, d.tel, d.name, d.zip, d.addr, d.bld, '', '08001708077', '鴻巣市ふるさと寄附金', '365-8601', '埼玉県鴻巣市中央1-1', '', '="' + d.code + '"', d.item, d.qty, d.wantDate, '="' + d.wantTime + '"', '', '', '', '="' + d.biko + '"'].join(',');
}
const csv = (...rows) => HEAD + '\r\n' + rows.join('\r\n') + '\r\n';
const STAMP = { date: '2026-10-30', time: '15:03' };

t('ファイル名から注文日時', () => {
  assert.deepStrictEqual(FS.fileStamp('sendorder_data_A11217043_261030150342.csv'), STAMP);
  assert.strictEqual(FS.fileStamp('abc.csv'), null);
});
t('="…" を外す', () => { assert.strictEqual(FS.unwrap('="A112170384"'), 'A112170384'); assert.strictEqual(FS.unwrap(' x '), 'x'); assert.strictEqual(FS.unwrap('="希望無"'), '希望無'); });
t('住所を分ける', () => {
  const f = FS.splitAddress;
  assert.deepStrictEqual(f('愛知県豊橋市大手町1-2-3'), { province: '愛知県', city: '豊橋市', rest: '大手町1-2-3' });
  assert.deepStrictEqual(f('静岡県静岡市駿河区大谷3708-17'), { province: '静岡県', city: '静岡市駿河区', rest: '大谷3708-17' });
  assert.strictEqual(f('三重県四日市市朝明町1').city, '四日市市');
  assert.strictEqual(f('千葉県市原市五井1').city, '市原市');
  assert.strictEqual(f('東京都町田市原町田1').city, '町田市');
  assert.deepStrictEqual(f('埼玉県北足立郡伊奈町小室1'), { province: '埼玉県', city: '北足立郡伊奈町', rest: '小室1' });
  assert.deepStrictEqual(f('東京都千代田区千代田1-1'), { province: '東京都', city: '千代田区', rest: '千代田1-1' });
  assert.deepStrictEqual(f('住所不明'), { province: '', city: '', rest: '住所不明' });
});
t('備考：定型を除き、依頼だけ取り出す', () => {
  assert.strictEqual(FS.requestText('鴻巣市ふるさと納税　　　133285685　　名前カナ「ヤマダ タロウ」'), '');
  assert.strictEqual(FS.requestText('鴻巣市ふるさと納税　　　133285685　　名前カナ「ヤマダ タロウ」 土日午前希望'), '土日午前希望');
  assert.strictEqual(FS.donorNo('鴻巣市ふるさと納税　　　133285685　　名前カナ「x」'), '133285685');
});
t('注文：1行・金額は契約単価の税込', () => {
  const os = FS.parseOrders(csv(row({})), STAMP, CONF);
  assert.strictEqual(os.length, 1);
  const o = os[0];
  assert.strictEqual(o.id, '2630248'); assert.strictEqual(o.createdAt, '2026-10-30'); assert.strictEqual(o.createdTime, '15:03');
  assert.strictEqual(o.lines[0].sku, 'A112170384'); assert.strictEqual(o.total, 15400);
  assert.strictEqual(o.ship.name, '山田 太郎'); assert.strictEqual(o.ship.province, '愛知県'); assert.strictEqual(o.ship.city, '豊橋市');
  assert.strictEqual(o.wantTime, '希望無'); assert.strictEqual(o.donorNo, '133285685');
});
t('伝票：FCART2x4BK 14,000・得意先 341401・受注日から2営業日', () => {
  const s = FS.buildSlip(FS.parseOrders(csv(row({})), STAMP, CONF)[0], ctx);
  assert.strictEqual(s.cust, '341401'); assert.strictEqual(s.staff, '000125'); assert.strictEqual(s.dept, '002110');
  assert.strictEqual(s.lines.length, 1); assert.strictEqual(s.lines[0].code, 'FCART2x4BK'); assert.strictEqual(s.lines[0].unitNet, 14000); assert.strictEqual(s.netTotal, 14000);
  assert.strictEqual(s.processDate, '2026-10-30'); assert.strictEqual(s.shipDate, '2026-11-04');   // 締めの時刻なし（当日分）。土日と 11/03（文化の日）は数えない
  assert.ok(!s.flags.some(f => f.level === 'error'), JSON.stringify(s.flags));
  assert.ok(!s.flags.some(f => f.text.indexOf('ギフティング') === 0));
});
t('セット品：付属品が別行・本体は合計から付属品を引いた額', () => {
  const o = FS.parseOrders(csv(row({ code: 'A112170390', item: '花岡車輌ダンディ軽量小型台車 折りたたみ式（ブレーキ・ゴム紐付き）UXL-LSC-PB-HS' })), STAMP, CONF)[0];
  const s = FS.buildSlip(o, ctx);
  const by = {}; s.lines.forEach(l => { by[l.code] = l; });
  assert.strictEqual(by.UXLLSC.unitNet, 14630); assert.strictEqual(by['OP/XLPB'].unitNet, 8120); assert.strictEqual(by['OP/XL-HS'].unitNet, 1330);
  assert.strictEqual(s.netTotal, 24080);
});
t('対応表にない商品番号は要確認（OKにできない）', () => {
  const s = FS.buildSlip(FS.parseOrders(csv(row({ code: 'A999999999', item: '新商品' })), STAMP, CONF)[0], ctx);
  assert.ok(s.flags.some(f => f.level === 'error' && /対応表にない商品/.test(f.text)));
});
t('初回確認の行は warn が付く', () => {
  const s = FS.buildSlip(FS.parseOrders(csv(row({ code: 'A112170394', item: 'DA-T2' })), STAMP, CONF)[0], ctx);
  assert.ok(s.flags.some(f => f.level === 'warn' && /初回は担当者が確認/.test(f.text)));
  assert.strictEqual(s.lines[0].unitNet, 34650);
});
t('配達日・時間・依頼の指定は注意になる', () => {
  const o = FS.parseOrders(csv(row({ wantDate: '2026/11/10', wantTime: '午後', biko: '鴻巣市ふるさと納税　　　133285685　　名前カナ「ヤマダ タロウ」 17時以降希望' })), STAMP, CONF)[0];
  const f = FS.buildSlip(o, ctx).flags.map(x => x.text).join('\n');
  assert.ok(/指定日配達シール/.test(f)); assert.ok(/時間指定シール/.test(f)); assert.ok(/17時以降希望/.test(f));
  const g = FS.buildSlip(FS.parseOrders(csv(row({})), STAMP, CONF)[0], ctx).flags.map(x => x.text).join('\n');
  assert.ok(!/シール/.test(g) && !/お客様の依頼/.test(g));
});
t('同じ発注番号の行は1注文', () => {
  const os = FS.parseOrders(csv(row({}), row({ no: 2, code: 'A112170379', item: 'F-CART2' })), STAMP, CONF);
  assert.strictEqual(os.length, 1); assert.strictEqual(os[0].lines.length, 2); assert.strictEqual(os[0].total, 15400 + 9240);
});
t('空・見出しだけ・発注番号なしの行は無視', () => {
  assert.strictEqual(FS.parseOrders(HEAD + '\r\n', STAMP, CONF).length, 0);
  assert.strictEqual(FS.parseOrders('', STAMP, CONF).length, 0);
});
t('SMILE に同じ客先注番があれば取込済み', () => {
  const s = FS.buildSlip(FS.parseOrders(csv(row({})), STAMP, CONF)[0], Object.assign({}, ctx, { smileOrders: { '2630248': true } }));
  assert.strictEqual(s.inSmile, true);
});
t('取込ファイル：客先注番＝発注番号・備考にふるさと納税返礼品・社内メモは空', () => {
  const o = FS.parseOrders(csv(row({})), STAMP, CONF)[0];
  const s = FS.buildSlip(o, ctx); s.deliveryCode = '000854'; s.deliveryNew = false;
  s.delivery = EC.deliveryFromOrder(o, CONF.config);
  const rows = FS.juchuRows([s], L.juchu, CONF.config, undefined, CONF.biko);
  const h = L.juchu, r = rows[0], at = k => r[h.indexOf(k)];
  assert.strictEqual(at('得意先コード'), '341401'); assert.strictEqual(at('客先注番'), '2630248'); assert.strictEqual(at('品目コード'), 'FCART2x4BK');
  assert.strictEqual(at('備考'), 'ふるさと納税返礼品'); assert.strictEqual(at('社内メモ'), '');
  assert.strictEqual(at('納品先名'), '山田 太郎様'); assert.strictEqual(at('担当者コード'), '000125'); assert.strictEqual(at('部門コード'), '002110');
  assert.strictEqual(at('単価'), '14000.00');
});
t('納品先：氏名＋様・住所１＝都道府県＋市区町村', () => {
  const d = EC.deliveryFromOrder(FS.parseOrders(csv(row({})), STAMP, CONF)[0], CONF.config);
  assert.strictEqual(d.name, '山田 太郎様'); assert.strictEqual(d.addr1, '愛知県豊橋市'); assert.strictEqual(d.addr2, '大手町1-2-3'); assert.strictEqual(d.zip, '441-0001');
});
t('対応表の単価を直すと、伝票の金額もすぐ変わる', () => {
  const o = FS.parseOrders(csv(row({})), STAMP, CONF)[0];
  const m = JSON.parse(JSON.stringify(CONF.mapping)); FS.findRule(m, 'A112170384').net = 15000;
  const s = FS.buildSlip(o, Object.assign({}, ctx, { mapping: m }));
  assert.strictEqual(s.lines[0].unitNet, 15000);
});
t('設定：対応表の商品番号が重複していない・品目コードと単価がある', () => {
  const ids = CONF.mapping.rules.map(r => r.words[0]); assert.strictEqual(new Set(ids).size, ids.length);
  CONF.mapping.rules.forEach(r => { assert.ok(r.code && r.net > 0, r.id); });
});
console.log('furusato_sales_core: ' + n + ' tests passed');
