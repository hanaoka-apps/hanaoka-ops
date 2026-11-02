// node tests/test_ship_core.cjs
// 架空のデータだけを使う（実データは入れない）
const assert = require('assert');
const fs = require('fs');
const S = require('../ship_core.js');
const CONF = JSON.parse(fs.readFileSync(__dirname + '/../ship_config.json', 'utf8'));
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + e.message); process.exitCode = 1; } }

const jst = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 9, mi || 0);   // 日本時間 → ms

function ship(o) {
  return Object.assign({ no: '1000', date: '2026-10-02', shipNo: '', cust: '100001', custName: '架空得意先', dest: '000010', destName: '架空商事 本社', staff: '山田', kubun: '3', want: '', time: '', ret: false,
    juchu: ['9001'], po: ['PO-1'], lines: [['UDL-250', 'ダンディリフト', '2', '9001']], slips: [] }, o);
}
const IDX = {
  generatedAt: '2026-11-02T01:00:00Z', from: '2026-05-06',
  sources: [{ name: '出荷明細出力.txt', modified: '2026-11-02T00:10:00Z', rows: 100 }],
  carriers: {
    seino: { name: '西濃運輸', kubun: '1', files: 2, rows: 50, from: '2026-10-02', to: '2026-10-30', newest: '2026-11-02T00:00:00Z' },
    daiichi: { name: '第一貨物', kubun: '3', files: 1, rows: 20, from: '2026-10-02', to: '2026-11-02', newest: '2026-11-02T00:00:00Z' },
    tonami: { name: 'トナミ運輸', kubun: '2', files: 1, rows: 7, from: '2026-10-05', to: '2026-10-28', newest: '2026-10-29T00:00:00Z' },
  },
  juchu: { 9001: { date: '2026-09-25', due: '2026-10-02', plan: '2026-10-02', lines: 2, staff: '山田' } },
  ships: [
    ship({ no: '37611', date: '2026-10-31', kubun: '1', juchu: ['9002'], po: ['PO-2'], destName: '東京工業 川崎工場', lines: [['XA', 'ＸＡ本体', '3', '9002']], slips: [{ c: 'seino', no: '9072200002', qty: '1', kg: '73', date: '2026-10-31' }] }),
    ship({ no: '37620', date: '2026-11-01', kubun: '0', juchu: ['9003'], po: [] }),
    ship({ no: '36683', date: '2026-10-02', kubun: '3', slips: [{ c: 'daiichi', no: '40100000001', qty: '3', kg: '60', date: '2026-10-02' }] }),
    ship({ no: '36729', date: '2026-10-05', kubun: '2', juchu: ['9004'], po: ['PO-4'], destName: '大阪ロジス', slips: [{ c: 'tonami', no: '5910000002', qty: '1', kg: '70', date: '2026-10-05' }] }),
    ship({ no: '37630', date: '2026-10-28', kubun: '1', juchu: ['9005'], po: ['PO-5'] }),                   // 取得期間内なのに見つからない
    ship({ no: '37631', date: '2026-11-02', kubun: '1', juchu: ['9005'], po: ['PO-5'] }),                   // まだ届いていない新しい出荷
    ship({ no: '30001', date: '2026-09-01', kubun: '1', juchu: ['9006'], po: [] }),                          // 取得期間より前
    ship({ no: '37640', date: '2026-10-30', kubun: '9', juchu: ['9007'], po: [] }),                          // 設定に無い区分
    ship({ no: '37650', date: '2026-11-02', kubun: '2', juchu: ['9008'], po: [] }),                          // トナミ（まだ送信されていない）
  ],
};
const nos = list => list.map(s => s.no);

t('日付の表示', () => {
  assert.strictEqual(S.fmtDate('2026-11-02', '2026-11-02'), '11/2(月)');
  assert.strictEqual(S.fmtDate('2025-12-31', '2026-11-02'), '2025/12/31(水)');
  assert.strictEqual(S.fmtDate('', '2026-11-02'), '');
});
t('運送会社の区分と名前', () => {
  assert.strictEqual(S.carrierKeyOf(CONF, '1'), 'seino'); assert.strictEqual(S.carrierKeyOf(CONF, 3), 'daiichi'); assert.strictEqual(S.carrierKeyOf(CONF, '0'), '');
  assert.strictEqual(S.kubunName(CONF, '2'), 'トナミ運輸'); assert.strictEqual(S.kubunName(CONF, '0'), '運送会社を使わない（引取・自社便など）'); assert.strictEqual(S.kubunName(CONF, '9'), '区分 9');
});
t('追跡リンク：設定の型の {no} を番号にする。型が空なら出さない', () => {
  assert.strictEqual(S.trackingUrl(CONF, 'tonami', '5910000002'), 'https://trc1.tonami.co.jp/trc/search3/excSearch3?id[0]=5910000002');
  const c2 = { carriers: { x: { tracking: 'https://example.test/?n={no}' } } };
  assert.strictEqual(S.trackingUrl(c2, 'x', ' 12 3 '), 'https://example.test/?n=12%203');
  assert.strictEqual(S.trackingUrl({ carriers: { seino: { tracking: '' } } }, 'seino', '1'), '');
  assert.strictEqual(S.trackingUrl(CONF, 'nothing', '1'), '');
});
t('送り状番号の状態', () => {
  const st = no => S.slipStatus(CONF, IDX, IDX.ships.find(s => s.no === no));
  assert.strictEqual(st('37611').code, 'ok');
  assert.strictEqual(st('37620').code, 'none');
  assert.strictEqual(st('30001').code, 'outside');
  assert.strictEqual(st('37630').code, 'missing');
  assert.strictEqual(st('37631').code, 'pending');
  assert.strictEqual(st('37640').code, 'nodata');
  assert.strictEqual(st('37650').code, 'pending');      // トナミの取得期間は 10/28 まで。これより新しい出荷は、まだ届いていない
  const noFiles = { carriers: { seino: { name: '西濃運輸', files: 0 } } };
  assert.strictEqual(S.slipStatus(CONF, noFiles, ship({ kubun: '1' })).code, 'nodata');
});
t('検索：売上№・受注№・客先注番・送り状番号', () => {
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '37611' })), ['37611']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '３７６１１' })), ['37611']);           // 全角
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '9002' })), ['37611']);                // 受注№
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: 'po-5' })), ['37630', '37631']);       // 客先注番（大文字小文字は問わない）
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '5910000002' })), ['36729']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '591-000-0002' })), ['36729']);        // ハイフン付きの送り状番号
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '40100000001' })), ['36683']);
});
t('検索：得意先・納品先・品目・担当・運送会社名・複数の言葉', () => {
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: '川崎' })), ['37611']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: 'xa本体' })), ['37611']);              // 品目名（半角・全角の違いを吸収）
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: 'ロジス' })), ['36729']);
  assert.ok(S.search(IDX, CONF, { q: '山田' }).length === IDX.ships.length);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: 'トナミ 大阪' })), ['36729']);         // すべての言葉を含む
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { q: 'トナミ 川崎' })), []);
  assert.strictEqual(S.search(IDX, CONF, { q: '' }).length, IDX.ships.length);
});
t('検索：日付・運送会社・状態の絞り込み', () => {
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { from: '2026-10-31', to: '2026-11-01' })), ['37611', '37620']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { carrier: 'seino' })), ['37611', '37630', '37631', '30001']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { carrier: 'none' })), ['37620']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { status: 'missing' })), ['37630']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { status: 'attention' })), ['37630', '37640']);
  assert.deepStrictEqual(nos(S.search(IDX, CONF, { carrier: 'seino', status: 'pending', q: 'po-5' })), ['37631']);
});
t('見つからない出荷の手がかり：同じ運送会社・同じ日の、SMILE に無い送り状', () => {
  const idx = Object.assign({}, IDX, { unmatched: [{ c: 'seino', key: '39999', slip: '9072299999', date: '2026-10-28' }, { c: 'daiichi', key: '1', slip: '4', date: '2026-10-28' }, { c: 'seino', key: '2', slip: '9', date: '2026-10-29' }] });
  assert.deepStrictEqual(S.candidates(CONF, idx, IDX.ships.find(s => s.no === '37630')).map(u => u.slip), ['9072299999']);
  assert.deepStrictEqual(S.candidates(CONF, idx, IDX.ships.find(s => s.no === '37620')), []);      // 運送会社を使わない出荷
  assert.deepStrictEqual(S.candidates(CONF, IDX, IDX.ships.find(s => s.no === '37630')), []);      // unmatched が無い索引でも動く
});
t('同じ受注の別の出荷・受注ごとの品目', () => {
  assert.deepStrictEqual(nos(S.siblings(IDX, IDX.ships.find(s => s.no === '37630'))), ['37631']);
  const s = ship({ juchu: ['A', 'B'], lines: [['X', 'x', '1', 'A'], ['Y', 'y', '2', 'B'], ['Z', 'z', '3', 'A']] });
  assert.deepStrictEqual(S.linesByJuchu(s).map(g => [g.juchu, g.lines.map(l => l.code)]), [['A', ['X', 'Z']], ['B', ['Y']]]);
  assert.deepStrictEqual(S.juchuInfo(IDX, '9001'), IDX.juchu['9001']); assert.strictEqual(S.juchuInfo(IDX, '9999'), null);
});
t('土日を除いた時間数', () => {
  assert.strictEqual(S.weekdayHours(jst(2026, 10, 30, 18), jst(2026, 11, 2, 8)), 14);       // 金 18:00 → 月 8:00（金の6時間＋月の8時間）
  assert.strictEqual(S.weekdayHours(jst(2026, 11, 2, 8), jst(2026, 11, 2, 9, 30)), 1.5);
  assert.strictEqual(S.weekdayHours(jst(2026, 11, 1, 10), jst(2026, 11, 1, 20)), 0);        // 日曜だけ
  assert.strictEqual(S.weekdayHours(jst(2026, 11, 3, 8), jst(2026, 11, 2, 8)), 0);
});
t('警告：新しいうちは出さない・古いと出す・トナミは出さない', () => {
  const now = jst(2026, 11, 2, 9);
  assert.deepStrictEqual(S.warnings(IDX, CONF, now), []);
  const old = JSON.parse(JSON.stringify(IDX));
  old.generatedAt = '2026-10-30T00:00:00Z'; old.sources[0].modified = '2026-10-28T00:00:00Z'; old.carriers.daiichi.newest = '2026-10-29T00:00:00Z';
  const w = S.warnings(old, CONF, now).join('\n');
  assert.ok(/ship_index\.json/.test(w), w); assert.ok(/出荷明細出力\.txt/.test(w), w); assert.ok(/第一貨物のデータ/.test(w), w);
  assert.ok(!/トナミ/.test(w), w);              // 10/29 から届いていなくても、トナミは警告しない
  assert.ok(!/西濃/.test(w), w);
  const none = JSON.parse(JSON.stringify(IDX)); none.carriers.seino.files = 0;
  assert.ok(/西濃運輸のデータがまだありません/.test(S.warnings(none, CONF, now).join('')));
});
t('警告：金曜の夜から月曜の朝は、土日ぶんを数えない', () => {
  const idx = JSON.parse(JSON.stringify(IDX));
  idx.carriers.daiichi.newest = new Date(jst(2026, 10, 30, 18)).toISOString();               // 金 18:00 に最後のファイル
  idx.generatedAt = new Date(jst(2026, 11, 2, 1, 10)).toISOString();
  idx.sources[0].modified = new Date(jst(2026, 11, 2, 0, 10)).toISOString();
  assert.deepStrictEqual(S.warnings(idx, CONF, jst(2026, 11, 2, 8, 30)), []);              // 月 8:30（平日で約14.5時間）
  assert.ok(S.warnings(idx, CONF, jst(2026, 11, 4, 8, 30)).some(m => /第一貨物/.test(m)));  // 水 8:30（平日で約62時間）
});
console.log(n + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
