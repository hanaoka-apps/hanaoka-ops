// node tests/test_receipt_core.cjs
// 領収証の計算部品（receipt_core.js）。値はすべて架空のもの。
const assert = require('assert');
const R = require('../receipt_core.js');
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error('NG: ' + name + '\n  ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } }

const paid = { no: '#1801', financial: 'paid', total: 11000, refunded: 0, shipCompany: 'サンプル工業株式会社', shipName: '山田 太郎', billName: '山田 花子' };

t('消費税の内訳：税込 ÷ 1.1 を四捨五入して税抜、残りが税額（アプリの既存の税の扱いと同じ）', () => {
  assert.deepStrictEqual(R.splitTax(11000), { gross: 11000, net: 10000, tax: 1000 });
  assert.deepStrictEqual(R.splitTax(1000), { gross: 1000, net: 909, tax: 91 });
  assert.deepStrictEqual(R.splitTax(999), { gross: 999, net: 908, tax: 91 });
  assert.deepStrictEqual(R.splitTax(1), { gross: 1, net: 1, tax: 0 });
  assert.deepStrictEqual(R.splitTax(54780), { gross: 54780, net: 49800, tax: 4980 });
  for (const g of [1, 2, 55, 109, 110, 111, 12345, 99999999]) { const x = R.splitTax(g); assert.strictEqual(x.net + x.tax, g); }
  assert.strictEqual(R.splitTax(10).net, Math.round(10 / 1.1));   // ec_sales_core.js の totalNet（Math.round(total / 1.1)）と同じ式
});

t('発行できる注文：入金済み（paid）と一部返金だけ', () => {
  let e = R.eligibility(paid);
  assert.ok(e.ok); assert.strictEqual(e.max, 11000); assert.strictEqual(e.refundNote, '');
  e = R.eligibility({ no: '1', financial: 'partially_refunded', total: 11000, refunded: 3000 });
  assert.ok(e.ok); assert.strictEqual(e.max, 8000); assert.ok(/返金があります/.test(e.refundNote) && /¥8,000/.test(e.refundNote));
  const no = (o, re) => { const x = R.eligibility(Object.assign({}, paid, o)); assert.ok(!x.ok && x.max === 0, JSON.stringify(o)); assert.ok(re.test(x.reason), x.reason); };
  no({ financial: 'pending' }, /入金が済んでいない/);
  no({ financial: 'authorized' }, /入金が済んでいない/);
  no({ financial: 'partially_paid' }, /入金が済んでいない/);
  no({ financial: 'voided' }, /キャンセル/);
  no({ financial: 'paid', cancelledAt: '2026-11-10' }, /キャンセル/);
  no({ financial: 'refunded', refunded: 11000 }, /全額が返金/);
  no({ financial: 'something_else' }, /入金済みの注文だけ/);
  no({ has: false }, /データがない/);
  no({ no: '' }, /データがない/);
  no({ financial: 'partially_refunded', refunded: 11000 }, /発行できる金額がありません/);
  assert.strictEqual(R.eligibility({ no: '1', financial: 'PAID', total: 500 }).ok, true);   // 大文字小文字は見ない
});

t('宛名の候補と初期値：お届け先の会社名→名前→請求先。重複は除く。会社は御中・個人は様', () => {
  const c = R.candidates(paid);
  assert.deepStrictEqual(c.map(x => x.text + '|' + x.title), ['サンプル工業株式会社|御中', '山田 太郎|様', '山田 花子|様']);
  assert.strictEqual(R.candidates({ no: '1', financial: 'paid', shipName: '山田 太郎', billName: '山田 太郎' }).length, 1);
  const d = R.defaults(paid, { now: new Date('2026-11-16T10:00:00Z') });
  assert.strictEqual(d.atena, 'サンプル工業株式会社'); assert.strictEqual(d.title, '御中'); assert.strictEqual(d.proviso, '商品代として');
  assert.strictEqual(d.amount, 11000); assert.strictEqual(d.issueDate, '2026-11-16');
  const p = R.defaults({ no: '2', financial: 'partially_refunded', total: 5000, refunded: 1000, shipName: '佐藤 一郎' });
  assert.strictEqual(p.atena, '佐藤 一郎'); assert.strictEqual(p.title, '様'); assert.strictEqual(p.amount, 4000);
  assert.strictEqual(R.defaults({ no: '3', financial: 'paid', total: 100 }).atena, '');
});

t('発行日の初期値は日本時間：UTC の夕方は、日本では翌日', () => {
  assert.strictEqual(R.todayJst(new Date('2026-11-16T14:59:59Z')), '2026-11-16');
  assert.strictEqual(R.todayJst(new Date('2026-11-16T15:00:00Z')), '2026-11-17');
  assert.strictEqual(R.yearJst(new Date('2026-12-31T15:00:00Z')), 2027);
});

t('宛名と敬称：分ける・つなぐ', () => {
  assert.deepStrictEqual(R.splitTitle('株式会社サンプル 御中'), { name: '株式会社サンプル', title: '御中' });
  assert.deepStrictEqual(R.splitTitle('山田 太郎 様'), { name: '山田 太郎', title: '様' });
  assert.deepStrictEqual(R.splitTitle('山田太郎'), { name: '山田太郎', title: '' });
  assert.deepStrictEqual(R.splitTitle('様'), { name: '様', title: '' });   // 名前が空になるときは、分けない
  assert.strictEqual(R.joinAtena('山田 太郎', '様'), '山田 太郎 様');
  assert.strictEqual(R.joinAtena('山田 太郎', ''), '山田 太郎');
  assert.strictEqual(R.joinAtena('', '様'), '');
});

t('入力の検査：正常（全角の数字・カンマ・円も受ける）', () => {
  const v = R.validate({ atena: ' 山田 太郎 ', title: '様', proviso: '商品代として', amount: '１１，０００円', issueDate: '2026-11-16', note: '' }, { max: 11000, now: new Date('2026-11-16T01:00:00Z') });
  assert.ok(v.ok, v.errors.join()); assert.deepStrictEqual(v.warnings, []);
  assert.deepStrictEqual(v.value, { atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, net: 10000, tax: 1000, issueDate: '2026-11-16', note: '' });
});
t('入力の検査：上限を超えたら止める・0円・小数・文字・空・長すぎ・日付', () => {
  const base = { atena: '山田 太郎', title: '様', proviso: '商品代として', amount: 1000, issueDate: '2026-11-16' };
  const bad = (o, re, opts) => { const v = R.validate(Object.assign({}, base, o), Object.assign({ max: 5000 }, opts)); assert.ok(!v.ok, JSON.stringify(o)); assert.ok(v.errors.some(e => re.test(e)), v.errors.join()); };
  bad({ amount: 5001 }, /上限（¥5,000）を超えて/);
  bad({ amount: 0 }, /1円以上/);
  bad({ amount: '' }, /金額を入れて/);
  bad({ amount: '12.5' }, /数字/);
  bad({ amount: '-100' }, /数字/);
  bad({ amount: 'abc' }, /数字/);
  bad({ amount: 100000000 }, /大きすぎ/, { max: undefined });
  bad({ atena: '   ' }, /宛名を入れて/);
  bad({ atena: 'あ'.repeat(60) }, /宛名が長すぎ/);
  bad({ proviso: '' }, /但し書きを入れて/);
  bad({ proviso: 'あ'.repeat(61) }, /但し書きが長すぎ/);
  bad({ issueDate: '2026-02-30' }, /発行日/);
  bad({ issueDate: '' }, /発行日/);
  bad({ note: 'あ'.repeat(201) }, /メモが長すぎ/);
  assert.ok(R.validate(Object.assign({}, base, { amount: 5000 }), { max: 5000 }).ok);                                   // ちょうど上限は通る
  const w = R.validate(Object.assign({}, base, { issueDate: '2026-11-20' }), { max: 5000, now: new Date('2026-11-16T01:00:00Z') });
  assert.ok(w.ok && w.warnings.length === 1 && /今日より先/.test(w.warnings[0]));                                       // 先の日付は、止めず注意だけ
  assert.strictEqual(R.validate(Object.assign({}, base, { atena: '山田\n太郎' }), {}).value.atena, '山田 太郎 様');     // 改行は空白に
});

t('領収証番号：ID から作る連番。取消した番号は使い回さない（ID は増えるだけ）', () => {
  assert.strictEqual(R.numberOf(12, 2026), 'R-2026-00012');
  assert.strictEqual(R.numberOf('7', 2026), 'R-2026-00007');
  assert.strictEqual(R.numberOf(123456, 2027), 'R-2027-123456');
  assert.ok(R.isNumber('R-2026-00012') && !R.isNumber('(番号つけ中)') && !R.isNumber('R-26-1') && !R.isNumber(''));
});

t('リストの行との変換：項目名・日付は正午(UTC)・番号がまだ付いていない行も、ID から同じ番号を出す', () => {
  const rec = { number: 'R-2026-00012', orderNo: '#1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, tax: 1000, issueDate: '2026-11-16', issuedBy: 'a@example.com', status: '発行済', reissueCount: 0, note: '', source: 'ec_viewer' };
  const f = R.toFields(rec);
  assert.deepStrictEqual(Object.keys(f).sort(), ['Amount', 'Atena', 'IssueDate', 'IssuedBy', 'Note', 'OrderNo', 'Proviso', 'ReissueCount', 'Source', 'Status', 'Tax', 'Title']);
  assert.strictEqual(f.OrderNo, '1801'); assert.strictEqual(f.IssueDate, '2026-11-16T12:00:00Z'); assert.strictEqual(f.Status, '発行済');
  assert.strictEqual(R.toFields(Object.assign({}, rec, { number: '' })).Title, R.PENDING_TITLE);
  const back = R.fromItem({ id: '12', createdDateTime: '2026-11-16T01:00:00Z', fields: Object.assign({}, f, { Amount: 11000 }) });
  assert.strictEqual(back.number, 'R-2026-00012'); assert.strictEqual(back.numberPending, false); assert.strictEqual(back.issueDate, '2026-11-16'); assert.strictEqual(back.status, '発行済');
  const pend = R.fromItem({ id: '13', createdDateTime: '2026-12-31T16:00:00Z', fields: { Title: R.PENDING_TITLE, OrderNo: '1802', Amount: 5, Status: '発行済' } });
  assert.strictEqual(pend.number, 'R-2027-00013'); assert.ok(pend.numberPending);       // 日本時間では2027年
  assert.strictEqual(R.fromItem({ id: '1', fields: { Status: '取消' } }).status, '取消');
  assert.strictEqual(R.fromItem({ id: '1', fields: { Status: '知らない値' } }).status, '発行済');
});

t('注文ごとのまとめ：新しい順・有効な最新の1枚・取消は有効に数えない', () => {
  const mk = (id, order, status) => ({ id: String(id), orderNo: order, status });
  const g = R.groupByOrder([mk(3, '1801', '取消'), mk(10, '1801', '発行済'), mk(5, '1802', '取消'), mk(1, '', '発行済')]);
  assert.deepStrictEqual(Object.keys(g).sort(), ['1801', '1802']);
  assert.deepStrictEqual(g['1801'].map(r => r.id), ['10', '3']);
  assert.strictEqual(R.activeOf(g['1801']).id, '10'); assert.strictEqual(R.activeOf(g['1802']), null); assert.strictEqual(R.activeOf(undefined), null);
});

t('利用ログ・履歴には番号だけ：宛名・金額・注文番号は入らない', () => {
  const d = R.logDetail({ number: 'R-2026-00012', atena: '山田 太郎 様', amount: 11000, orderNo: '1801' }, '発行');
  assert.strictEqual(d, 'R-2026-00012 発行');
});

t('設定ファイルの検査：足りない項目を知らせる（社印と備考はなくてよい）', () => {
  assert.ok(R.checkSettings(R.SAMPLE_SETTINGS).ok);
  assert.ok(R.checkSettings({ company: R.SAMPLE_SETTINGS.company }).ok);
  let c = R.checkSettings(null); assert.ok(!c.ok && c.missing.length);
  c = R.checkSettings({ company: { name: 'サンプル商事株式会社', address: '', tel: ' ' } });
  assert.ok(!c.ok); assert.deepStrictEqual(c.missing.map(s => s.split('（')[0]), ['company.address', 'company.tel', 'company.registrationNo']);
  assert.ok(/^T0+$/.test(R.SAMPLE_SETTINGS.company.registrationNo) && /^0{3}-0{4}$/.test(R.SAMPLE_SETTINGS.company.zip));   // 見本は、架空の値（ゼロ）だけ
});

t('印刷用の HTML：宛名・金額・内訳・発行元・注文番号が出る／外から入った文字はエスケープする', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '<b>山田</b> & "太郎" 様', proviso: '商品代として<script>alert(1)</script>', amount: 11000, tax: 1000, issueDate: '2026-11-16', status: '発行済', reissueCount: 0 };
  const html = R.printHtml(rec, R.SAMPLE_SETTINGS, {});
  assert.ok(/^<!DOCTYPE html>/.test(html) && /size:A4 portrait/.test(html));
  assert.ok(html.includes('領収証番号') && html.includes('R-2026-00012') && html.includes('2026年11月16日'));
  assert.ok(html.includes('¥11,000') && html.includes('¥10,000') && html.includes('¥1,000') && html.includes('#1801'));
  assert.ok(html.includes('サンプル商事株式会社') && html.includes('T0000000000000') && html.includes('〒000-0000'));
  assert.ok(!html.includes('<b>山田') && html.includes('&lt;b&gt;山田&lt;/b&gt; &amp; &quot;太郎&quot;') && html.includes('<span class="tt">様</span>'));
  assert.ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;'));
  assert.ok(!/再発行/.test(html) && !/class="wm"/.test(html) && !/<img/.test(html));        // 最初の発行では、再発行・透かし・印なし
});
t('印刷用の HTML：再発行・取消・見本（未発行）・社印・自動印刷・外の文字', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, tax: 1000, issueDate: '2026-11-16', status: '発行済', reissueCount: 2 };
  let h = R.printHtml(rec, R.SAMPLE_SETTINGS, { reissue: true });
  assert.ok(h.includes('再発行（2回目）'));
  h = R.printHtml(Object.assign({}, rec, { status: '取消' }), R.SAMPLE_SETTINGS, {});
  assert.ok(/class="wm">取消</.test(h));
  h = R.printHtml(Object.assign({}, rec, { number: '' }), R.SAMPLE_SETTINGS, { preview: true });
  assert.ok(/class="wm">見本（未発行）</.test(h) && h.includes('発行すると付きます'));
  h = R.printHtml(rec, R.SAMPLE_SETTINGS, { stampSrc: 'data:image/png;base64,AAAA"onerror="x' });
  assert.ok(/<img class="stamp" alt="" src="data:image\/png;base64,AAAA&quot;onerror=&quot;x">/.test(h));
  assert.ok(!/<script>/.test(R.printHtml(rec, R.SAMPLE_SETTINGS, {})) && /window\.print\(\)/.test(R.printHtml(rec, R.SAMPLE_SETTINGS, { auto: true })));
  assert.ok(!/https?:\/\//.test(R.printHtml(rec, R.SAMPLE_SETTINGS, { reissue: true })));      // 外のファイルを読まない
  assert.strictEqual(R.printHtml(rec, null, {}).includes('領収証'), true);                     // 設定が空でも落ちない
  assert.strictEqual(R.fileName(rec), '領収証_R-2026-00012');
});

console.log('ok receipt_core: ' + n + ' tests');
