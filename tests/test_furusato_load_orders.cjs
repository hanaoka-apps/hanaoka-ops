// node tests/test_furusato_load_orders.cjs
// ふるさと納税の注文CSVの読み込み（furusato_sales_profile.js の loadOrders）：まとめて読んでも、
//   ・新しいフォルダの注文が優先される（同じ発注番号は、新しいほうを使う）
//   ・読めなかったCSV・ダウンロードURLのないCSVは数えて、残りを読む
//   ・同時に読むのは、最大6つまで
// 通信と CSV の読み取り（Shift_JIS）は、差し替える（実データ・個人情報は使わない）
const assert = require('assert');
global.window = global;
const seenParse = [];
global.FurusatoSales = {
  fileStamp: name => { const m = /_(\d{6})/.exec(name); return m ? { date: '2026-11-' + m[1].slice(4, 6), time: '' } : null; },
  decode: buf => new TextDecoder('utf-8').decode(buf),
  parseOrders: (text, stamp) => { seenParse.push(text); return text.split(',').map(id => ({ id, from: text, stamp })); }
};
require('../furusato_sales_profile.js');
const load = window.EC_PROFILE.loadOrders;
let n = 0;
async function t(name, fn) { try { await fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } }

function fixture(files) {   // files＝{ 'フォルダ名/ファイル名': 中身（"1,2" のように、発注番号をコンマで並べる） or null（ダウンロードURLなし） or 'FAIL'（ダウンロード失敗） }
  const dirs = {}; Object.keys(files).forEach(k => { const [d, f] = k.split('/'); (dirs[d] = dirs[d] || []).push(f); });
  let active = 0, peak = 0;
  const graphGet = async url => {
    const path = decodeURIComponent(url.replace(/^.*root:\//, '').replace(/[:?].*$/, ''));
    if (/\/children/.test(url)) {
      if (path.endsWith('/csv')) return { value: Object.keys(dirs).map(d => ({ name: d, folder: {} })) };
      const d = path.split('/').pop(); return { value: (dirs[d] || []).map(f => ({ name: f, file: {} })) };
    }
    const key = path.split('/').slice(-2).join('/'), v = files[key];
    return { lastModifiedDateTime: '2026-11-10T00:00:00Z', '@microsoft.graph.downloadUrl': v === null ? undefined : 'https://dl/' + encodeURIComponent(key) };
  };
  global.fetch = async url => {
    const key = decodeURIComponent(String(url).replace('https://dl/', '')), v = files[key];
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    if (v === 'FAIL') return { ok: false, status: 500 };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(v).buffer };
  };
  return { graphGet, peak: () => peak };
}
async function run(files) {
  const f = fixture(files), out = { list: null, note: '' };
  await load({ conf: { csv: { inboxDir: '_in' } }, resolveDriveId: async () => 'D', graphGet: f.graphGet, stamp: x => x, note: m => { out.note = m; }, setOrders: l => { out.list = l; } });
  out.peak = f.peak(); return out;
}

(async () => {
  await t('新しいフォルダの注文を優先する（同じ発注番号は、新しいほうを使う）', async () => {
    const o = await run({ '20261101000000_M_1/a_261101.csv': '100,101', '20261110000000_M_1/a_261110.csv': '101,102' });
    const by = Object.fromEntries(o.list.map(x => [x.id, x.from]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['100', '101', '102']);
    assert.strictEqual(by['101'], '101,102');   // 新しいフォルダ（11/10）の分
    assert.strictEqual(by['100'], '100,101');
    assert.ok(/フォルダ 2個・CSV 2件を読み、注文 3件/.test(o.note));
  });
  await t('読めなかったCSV・URLのないCSVは数えて、残りを読む。CSV以外は読まない', async () => {
    const o = await run({ '20261110000000_M_1/a.csv': '1', '20261110000000_M_1/b.csv': 'FAIL', '20261110000000_M_1/c.csv': null, '20261109000000_M_1/d.csv': '2', '20261109000000_M_1/note.txt': 'x' });
    assert.deepStrictEqual(o.list.map(x => x.id).sort(), ['1', '2']);
    assert.ok(/CSV 2件/.test(o.note) && /読めなかったCSV 2件/.test(o.note), o.note);
  });
  await t('同時に読むのは、最大6つまで（たくさんあっても）', async () => {
    const files = {}; for (let i = 0; i < 30; i++) files['2026111' + String(i % 10) + '000000_M_1/f' + i + '.csv'] = String(1000 + i);
    const o = await run(files);
    assert.strictEqual(o.list.length, 30);
    assert.ok(o.peak > 1 && o.peak <= 6, '同時の数 ' + o.peak);
  });
  await t('フォルダが読めないときは、注文なしで、理由を出す', async () => {
    const out = { list: null, note: '' };
    await load({ conf: {}, resolveDriveId: async () => 'D', graphGet: async () => { throw new Error('403'); }, stamp: x => x, note: m => { out.note = m; }, setOrders: l => { out.list = l; } });
    assert.deepStrictEqual(out.list, []); assert.ok(/読めませんでした/.test(out.note));
  });
  console.log('furusato_load_orders: ' + n + ' tests passed' + (process.exitCode ? ' (一部NG)' : ''));
})();
