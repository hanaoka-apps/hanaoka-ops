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
  assert.strictEqual(S.trackingUrl(CONF, 'seino', '9072284189'), 'https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=9072284189');   // 番号が入った形で開く
  assert.strictEqual(S.trackingUrl(CONF, 'daiichi', '40151856673'), 'https://www.daiichi-kamotsu.co.jp/cgi/W3X05IM.php?KEY1=40151856673');
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
t('分納：受注№が違っても、得意先と客先注番が同じなら同じ注文（日数で区切る・空の注番は対象外）', () => {
  const mk = (no, date, o) => ship(Object.assign({ no, date, juchu: ['J' + no], po: ['注-A'], cust: '100001' }, o || {}));
  const idx = { ships: [
    mk('1', '2026-10-01'), mk('2', '2026-10-10'), mk('3', '2026-10-25'),
    mk('4', '2026-12-30'),                                   // 同じ注番でも、30日より離れている
    mk('5', '2026-10-10', { cust: '200002' }),               // 注番が同じでも、得意先が違う
    mk('6', '2026-10-10', { po: [] }), mk('7', '2026-10-11', { po: [] }),   // 注番が空どうしは、つなげない
    mk('8', '2026-10-12', { juchu: ['J2'], po: ['注-B'] }),  // 注番は違うが、受注№が2と同じ
  ] };
  const by = no => idx.ships.find(s => s.no === no);
  assert.deepStrictEqual(nos(S.siblings(idx, by('2'), CONF)), ['1', '8', '3']);             // 日付順。8 は受注№が同じ
  assert.deepStrictEqual(nos(S.siblings(idx, by('1'), CONF)), ['2', '3']);                  // 10/1 から10/25 は24日差で入る
  assert.deepStrictEqual(nos(S.siblings(idx, by('3'), CONF)), ['1', '2']);
  assert.deepStrictEqual(S.siblings(idx, by('4'), CONF), []);                               // 30日より離れている
  assert.deepStrictEqual(S.siblings(idx, by('5'), CONF), []);                               // 得意先が違う
  assert.deepStrictEqual(S.siblings(idx, by('6'), CONF), []);                               // 注番が空
});
t('分納：日数の設定・表に出す数・分納でないとき', () => {
  const mk = (no, date) => ship({ no, date, juchu: ['J' + no], po: ['注-A'] });
  const idx = { ships: ['1', '2', '3', '4', '5', '6', '7', '8'].map((n, i) => mk(n, '2026-10-' + String(1 + i * 2).padStart(2, '0'))) };
  const by = no => idx.ships.find(s => s.no === no);
  assert.deepStrictEqual(nos(S.siblings(idx, by('4'), { bunno: { windowDays: 3 } })), ['3', '5']);   // 7日の前後3日
  const b = S.bunno(idx, by('4'), CONF);                                                    // 全部で8回 → 6件まで・この出荷に近い順
  assert.strictEqual(b.total, 8); assert.strictEqual(b.hidden, 2); assert.strictEqual(b.ships.length, 6);
  assert.ok(b.ships.includes(by('4')));
  assert.deepStrictEqual(nos(b.ships), nos(b.ships.slice().sort((x, y) => x.date < y.date ? -1 : 1)));   // 日付順
  assert.strictEqual(S.bunno(idx, mkAlone(), CONF), null);
  function mkAlone() { return ship({ no: '99', juchu: ['Z'], po: ['注-Z'] }); }
});
t('送り先：住所・直送・名前', () => {
  const idx = { ships: [], addr: { '100001|000010': { z: '123-0001', a: '架空県架空市1-2-3' }, '100001|000000': { a: '架空県本社市4-5-6' } } };
  const s = ship({});
  assert.deepStrictEqual(S.addrOf(idx, s), { zip: '123-0001', addr: '架空県架空市1-2-3', recv: '' });
  assert.deepStrictEqual(S.addrOf(idx, ship({ dest: '000000' })), { zip: '', addr: '架空県本社市4-5-6', recv: '' });
  assert.strictEqual(S.addrOf(idx, ship({ dest: '000099' })), null);
  assert.strictEqual(S.addrOf({}, s), null);                                               // addr の無い索引でも動く
  assert.strictEqual(S.zipAddr({ zip: '123-0001', addr: '架空県' }), '〒123-0001　架空県');
  assert.strictEqual(S.zipAddr({ zip: '', addr: '架空県' }), '架空県'); assert.strictEqual(S.zipAddr(null), '');
  assert.strictEqual(S.destLabel(ship({ dest: '000000', destName: '' })), '架空得意先');   // 納品先なしは、得意先の名前
  assert.strictEqual(S.isDirect(CONF, ship({ custName: '代理店', destName: 'エンドユーザー' })), true);
  assert.strictEqual(S.isDirect(CONF, ship({ custName: '代理店', destName: '代理店' })), false);       // 同じ名前
  assert.strictEqual(S.isDirect(CONF, ship({ custName: '代理店', destName: '', dest: '000000' })), false);   // 納品先なし
});
t('出荷連絡の文面：行の繰り返し・空の行は出さない・住所なし', () => {
  const idx = { ships: [], addr: { '100001|000010': { z: '123-0001', a: '架空県架空市1-2-3' } } };
  const s = ship({ date: '2026-11-02', po: ['NYF-1'], destName: '架空商事 本社', lines: [['A', '商品A', '1', '9001'], ['B', '商品B', '2', '9001']],
    slips: [{ c: 'seino', no: '9072200002' }, { c: 'tonami', no: '5910000002' }] });
  const r = S.noticeText(CONF, idx, s);
  assert.strictEqual(r.subject, '出荷のご連絡 NYF-1');
  assert.ok(r.hasSlip && r.hasAddr);
  const L = r.body.split('\n');
  assert.ok(L.includes('客先注番：NYF-1') && L.includes('商品名：商品A × 1') && L.includes('商品名：商品B × 2'));
  assert.ok(L.includes('納品先：架空商事 本社') && L.includes('　　　　〒123-0001 架空県架空市1-2-3') && L.includes('出荷日：2026年11月2日'));
  const i = L.indexOf('運送会社：西濃運輸');                                                    // 運送会社と送り状番号は、組で繰り返す
  assert.deepStrictEqual(L.slice(i, i + 4), ['運送会社：西濃運輸', '送り状番号：9072200002', '運送会社：トナミ運輸', '送り状番号：5910000002']);
  assert.ok(!/\n\n\n/.test(r.body) && !/^\n|\n$/.test(r.body));
  // 住所なし・注番なし・送り状なし
  const r2 = S.noticeText(CONF, { ships: [] }, ship({ po: [], slips: [] }));
  assert.strictEqual(r2.subject, '出荷のご連絡'); assert.ok(!r2.hasSlip && !r2.hasAddr);
  assert.ok(!r2.body.includes('客先注番') && !r2.body.includes('〒') && !r2.body.includes('送り状番号') && !r2.body.includes('運送会社'));
  assert.ok(r2.body.includes('納品先：架空商事 本社'));
  // 半角カナは全角にそろえる・返品の印・数量の3桁区切り
  const rk = S.noticeText(CONF, idx, ship({ ret: true, lines: [['A', 'ｼﾞｻﾞｲ100WJ ﾍﾝﾋﾟﾝ', '-20', '9001'], ['B', '部品', '1500', '9001']] }));
  assert.ok(rk.isReturn && rk.body.includes('商品名：ジザイ100WJ ヘンピン × -20') && rk.body.includes('商品名：部品 × 1,500'));
  assert.strictEqual(S.noticeText(CONF, idx, s).isReturn, false);
});
t('伝票の詳細：合計・数の表示・表示用の文字', () => {
  const d = { tax: 420, lines: [['1', 'A', 'ｷｬｽﾀｰ', '2', '個', '1000', '2000', '税抜き', '', '', ''], ['2', 'B', 'ＢＢ', '1.5', '式', '1100', '2200', '税抜き', '', '', '']] };
  assert.deepStrictEqual(S.detailTotals(d), { qty: 3.5, sub: 4200, tax: 420, total: 4620 });
  assert.deepStrictEqual(S.detailTotals(null), { qty: 0, sub: 0, tax: 0, total: 0 });
  assert.strictEqual(S.fmtNum('1234567'), '1,234,567'); assert.strictEqual(S.fmtNum('-1000'), '-1,000');
  assert.strictEqual(S.fmtNum(''), ''); assert.strictEqual(S.fmtNum('abc'), 'abc');
  assert.strictEqual(S.zen('ｷｬｽﾀｰ ＢＢ１'), 'キャスター BB1');
});
t('伝票と送り状の見比べ：同じ・違うかも・比べない', () => {
  const idx = { ships: [], addr: { '100001|000010': { z: '123-0001', a: '架空県架空市新田町1-2-3' } } };
  const conf = JSON.parse(JSON.stringify(CONF));
  const sh = ship({ date: '2026-11-02', destName: '架空商事 本社', want: '2026-11-05', time: '午前', lines: [['A', 'ｷｬｽﾀｰ', '2', '9001']] });
  const by = (rows, k) => rows.find(r => r.k === k);
  // 全部同じ（表記ゆれ：㈱・様・全角ハイフン・丁目）
  const ok = S.compareSlip(conf, idx, sh, { c: 'seino', no: '1', qty: '2', kg: '30', date: '2026-11-02', n: '架空商事 本社 山田様', z: '1230001', a: '架空県架空市新田町１－２－３', w: '配達指定【11月05日午前】', m: 'キャスター' });
  assert.deepStrictEqual(ok.filter(r => r.st === 'diff'), []);
  assert.strictEqual(by(ok, 'お届け先').st, 'ok'); assert.strictEqual(by(ok, '郵便番号').st, 'ok'); assert.strictEqual(by(ok, '住所').st, 'ok'); assert.strictEqual(by(ok, '配達指定').st, 'ok');
  assert.strictEqual(by(ok, '個数').st, 'info'); assert.strictEqual(by(ok, '個数').b, '2個'); assert.strictEqual(by(ok, '品名（記事）').a, 'キャスター');
  // 違う：名前・郵便番号・住所・配達指定（日付・午前午後）・出荷日
  const ng = S.compareSlip(conf, idx, sh, { c: 'seino', no: '1', date: '2026-11-03', n: '別の会社', z: '9990001', a: '別県別市9-9-9', w: '配達指定【11月06日午後】' });
  ['出荷日', 'お届け先', '郵便番号', '住所', '配達指定'].forEach(k => assert.strictEqual(by(ng, k).st, 'diff', k));
  assert.strictEqual(by(S.compareSlip(conf, idx, sh, { c: 'seino', no: '1', w: '配達指定【11月05日午後】' }), '配達指定').st, 'diff');   // 午前と午後
  // 宛名：名称１＝納品先名、名称２＝荷受け人名。送り状の欄の長さで切れているものは「切れています」、荷受け人名が無いものは「入っていません」
  const idxR = { ships: [], addr: { '100001|000010': { z: '123-0001', a: '架空県架空市新田町1-2-3', r: '小久保所長様' } } };
  const sr = ship({ destName: '架空商事 群馬営業所本館', date: '2026-11-02' });
  const sl = o => Object.assign({ c: 'seino', no: '1', date: '2026-11-02' }, o);
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '架空商事 群馬営業所本館 小久保所長様', n1: '架空商事 群馬営業所本館', n2: '小久保所長様' })), 'お届け先').st, 'ok');
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '架空商事 群馬営業所 小久保所長様', n1: '架空商事 群馬営業所', n2: '小久保所長様' })), 'お届け先').st, 'cut');   // 名称１が途中まで
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '架空商事 群馬営業所本館', n1: '架空商事 群馬営業所本館', n2: '' })), 'お届け先').st, 'missing');   // 荷受け人名が無い
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '別の会社 小久保所長様', n1: '別の会社', n2: '小久保所長様' })), 'お届け先').st, 'diff');
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '架空商事 群馬営業所本館 小久保所長様', n1: '架空商事 群馬営業所本館', n2: '小久保所長様', a: '架空県架空市新田町1-2' })), '住所').st, 'cut');   // 住所が途中まで
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, sl({ n: '架空商事 群馬営業所本館', n1: '架空商事 群馬営業所本館', a: '架空県架空市新田町１－２－３ 別館' })), '住所').st, 'ok');   // 送り状のほうが長いのは可
  // 第一貨物（名称２の列が無い）は、荷受け人名の有無を比べない。名称１が切れていれば「切れています」
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, { c: 'daiichi', no: '1', n: '架空商事 群馬', n1: '架空商事 群馬' }), 'お届け先').st, 'cut');
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, { c: 'daiichi', no: '1', n: '架空商事 群馬営業所本館', n1: '架空商事 群馬営業所本館' }), 'お届け先').st, 'ok');
  // 古い送り状（名称１・２を別々に持たない）は、つなげた名前で比べる
  assert.strictEqual(by(S.compareSlip(conf, idxR, sr, { c: 'seino', no: '1', n: '架空商事 群馬営業所本館 小久保所長様' }), 'お届け先').st, 'ok');
  // 値が無い側は「比べない」。配達指定の列を設定していない会社（第一貨物）は、配達指定を比べない
  const none = S.compareSlip(conf, { ships: [] }, sh, { c: 'tonami', no: '1' });
  assert.strictEqual(by(none, 'お届け先').st, 'none'); assert.strictEqual(by(none, '住所').st, 'none');
  assert.strictEqual(by(S.compareSlip(conf, idx, sh, { c: 'daiichi', no: '1', n: '架空商事 本社', a: '架空県架空市新田町1-2-3' }), '配達指定'), undefined);
  // カードの印
  const withDiff = Object.assign({}, sh, { slips: [{ c: 'seino', no: '1', n: '別の会社', date: '2026-11-02' }] });
  assert.strictEqual(S.diffCount(conf, idx, withDiff), 2);   // お届け先と配達指定（送り状に配達指定が無い）
  assert.strictEqual(S.diffCount(conf, idx, Object.assign({}, sh, { slips: [{ c: 'seino', no: '1', qty: '1' }] })), 0);   // お届け先などの控えが無い送り状は数えない
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
