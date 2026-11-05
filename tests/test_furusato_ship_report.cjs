// サイネックスへの出荷報告：注文 CSV の行に、送り状番号（D）と出荷日（E）を入れた Excel の中身と、メールの件名・本文
const assert = require('assert'), fs = require('fs');
const FS = require('../furusato_sales_core.js'), R = require('../furusato_ship_report.js');
const CONF = JSON.parse(fs.readFileSync(__dirname + '/../furusato_config.json', 'utf8'));
const HEAD = ['No.', '受注番号', '発注番号', '送り状番号', '出荷予定日', '代引区分', '代引金額', 'お届け先電話番号', 'お届け先名', 'お届け先郵便番号', 'お届け先住所', 'お届け先建物名', 'お届け先会社名・部門', 'ご依頼主電話番号', 'ご依頼主名', 'ご依頼主郵便番号', 'ご依頼主住所', 'ご依頼主建物名', '商品番号', '品名', '数量', '配達希望日', '配達時間帯', 'のし表書き', 'のし名前', 'のしに関する備考', '備考'];
const row = (no, juchu, po) => [no, juchu, po, '', '', 0, 0, '09051025951', '北村 幸恵', '4560053', '愛知県名古屋市熱田区一番一丁目7-17', '', '', '08001708077', '鴻巣市ふるさと寄附金', '3658601', '埼玉県鴻巣市中央1-1', '', '="A112170384"', '【鴻巣市ふるさと納税】フラットカート', 1, '', '="希望無"', '', '', '', '="鴻巣市ふるさと納税　　　133053156　　名前カナ「キタムラ サチエ」"'].join(',');
const csv = (...r) => HEAD.join(',') + '\r\n' + r.join('\r\n') + '\r\n';
const o1 = FS.parseOrders(csv(row(1, '3172340', '2629702'), row(2, '3172501', '2629888')), { date: '2026-11-04', time: '10:00' }, CONF);
const o2 = FS.parseOrders(csv(row(1, '3172779', '2630248')), { date: '2026-11-04', time: '15:03' }, CONF);
const ship = (no, d) => ({ shipDate: d, slips: [{ c: 'seino', no: no.replace(/-/g, ''), fmt: no }] });
const items = [{ order: o2[0], ship: ship('907-228-4211', '2026-11-04') }, { order: o1[1], ship: ship('907-228-4202', '2026-11-04') }, { order: o1[0], ship: ship('907-228-4201', '2026-11-04') }];

let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } };
const rep = R.build({ items, conf: CONF });
t('見出し行は D1・E1 だけ', () => {
  assert.strictEqual(rep.aoa[0].length, 27);
  assert.deepStrictEqual(rep.aoa[0].map((v, i) => v == null ? null : i + ':' + v), [null, null, null, '3:西濃運輸問合せ番号', '4:出荷日'].concat(Array(22).fill(null)).map((v, i, a) => v));
});
t('行は、ファイルの時刻順・No. 順。D に送り状番号、E に出荷日', () => {
  assert.strictEqual(rep.count, 3);
  assert.deepStrictEqual(rep.aoa.slice(1).map(r => [r[0], r[1], r[2], r[3], r[4]]), [[1, 3172340, 2629702, '907-228-4201', '26.11.04'], [2, 3172501, 2629888, '907-228-4202', '26.11.04'], [1, 3172779, 2630248, '907-228-4211', '26.11.04']]);
});
t('数値と文字の持ち方（サンプルの Excel と同じ）', () => {
  const r = rep.aoa[1];
  assert.strictEqual(r[5], 0); assert.strictEqual(r[6], 0); assert.strictEqual(r[7], '09051025951'); assert.strictEqual(r[9], '4560053'); assert.strictEqual(r[18], 'A112170384'); assert.strictEqual(r[20], 1); assert.strictEqual(r[22], '希望無');
  assert.strictEqual(r[11], null); assert.strictEqual(r[17], null);   // 空は空のまま
  assert(r[26].indexOf('133053156') >= 0 && r[26].indexOf('=') < 0);
});
t('件名・ファイル名・宛先・本文', () => {
  assert.strictEqual(rep.subject, '出荷報告　花岡車輛（株）　2026.11.04分');
  assert.strictEqual(rep.fileName, 'サイネックス出荷報告2026.11.04分.xlsx');
  assert.deepStrictEqual(rep.to, ['info-wagamachifurusato@scinex.co.jp']); assert.deepStrictEqual(rep.cc, ['gyoumu@hanaoka-corp.co.jp']);
  assert(rep.bodyHtml.indexOf('(株)サイネックス　船曳様') >= 0 && rep.bodyHtml.indexOf('出荷報告になります。添付ファイルご確認ください。') >= 0 && rep.bodyHtml.indexOf('03-3643-5271') >= 0);
});
t('複数日は「2026.10.29-11.04」の形', () => {
  assert.strictEqual(R.dateLabel(['2026-11-04', '2026-10-29']), '2026.10.29-11.04');
  assert.strictEqual(R.dateLabel(['2026-11-04']), '2026.11.04');
  assert.strictEqual(R.dateLabel(['2025-12-30', '2026-01-05']), '2025.12.30-2026.01.05');
});
console.log('furusato_ship_report: ' + n + ' tests passed');
