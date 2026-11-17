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

// 見積アプリの会社の情報の形（SD_設定の「会社」の行）。値はすべて架空
const COMP = { company: 'サンプル商事株式会社', regNo: 'T0000000000000', bank: '見本銀行 見本支店 当座 0000000',
  offices: [{ name: '本社', zip: '000-0000', addr: 'サンプル県サンプル市サンプル町0-0-0', tel: '000-000-0000', fax: '000-000-0001' },
    { name: '第二工場', zip: '111-1111', addr: '別の県別の市別町1-1-1', tel: '111-111-1111', fax: '' }] };
const S = R.mergeSettings(COMP, null);

t('会社の設定を合わせる：見積アプリの情報を読み、設定ファイルは上書きだけ（社印・備考・拠点）。振込先は持たない', () => {
  assert.deepStrictEqual(S, { company: 'サンプル商事株式会社', regNo: 'T0000000000000', offices: COMP.offices.map(o => Object.assign({}, o)), stampFile: '', footerNote: '' });
  assert.ok(!JSON.stringify(S).includes('見本銀行'));
  const m = R.mergeSettings(COMP, { stampFile: 'stamp.png', footerNote: '備考の一文', company: '上書きされない社名', offices: [{ name: '上書き拠点', zip: '', addr: '住所X', tel: '', fax: '' }] });
  assert.strictEqual(m.company, 'サンプル商事株式会社'); assert.strictEqual(m.stampFile, 'stamp.png'); assert.strictEqual(m.footerNote, '備考の一文');
  assert.deepStrictEqual(m.offices.map(o => o.name), ['上書き拠点']);
  assert.strictEqual(R.mergeSettings(COMP, { offices: [] }).offices.length, 2);           // 空の上書きは、見積アプリの拠点のまま
  assert.strictEqual(R.mergeSettings(COMP, 'こわれた').offices.length, 2);
  const x = R.mergeSettings({ company: ' 社 ', offices: [null, 5, { name: '', addr: '' }, { name: 'A', addr: '住所' }] }, null);
  assert.strictEqual(x.company, '社'); assert.deepStrictEqual(x.offices, [{ name: 'A', zip: '', addr: '住所', tel: '', fax: '' }]);
});
t('会社の設定を確かめる：社名と住所は必須。登録番号が空なら、発行はできるが注意する。何もなければ、足りない', () => {
  let c = R.checkSettings(S); assert.ok(c.ok && !c.warnings.length);
  c = R.checkSettings(R.mergeSettings(Object.assign({}, COMP, { regNo: '' }), null)); assert.ok(c.ok && c.warnings.length === 1 && /登録番号が未設定です/.test(c.warnings[0]));
  c = R.checkSettings(R.mergeSettings(null, null)); assert.ok(!c.ok); assert.deepStrictEqual(c.missing, ['社名', '拠点の住所']);
  c = R.checkSettings(R.mergeSettings({ company: 'A', offices: [{ name: '本社' }] }, null)); assert.deepStrictEqual(c.missing, ['拠点の住所']);
  c = R.checkSettings(null); assert.ok(!c.ok);
  assert.ok(/^会社の設定がありません（見積アプリの会社の情報を確認してください）$/.test(R.NO_COMPANY));
  // 設定ファイルの見本は、架空の値（ゼロ）だけ
  assert.ok(/^0{3}-0{4}$/.test(R.SAMPLE_SETTINGS.offices[0].zip) && /^0{3}-0{3}-0{4}$/.test(R.SAMPLE_SETTINGS.offices[0].tel));
});

t('印刷用の HTML（見積書と同じ書式）：見出し・宛名・番号・但し書き・金額の表・会社・登録番号が出る／外から入った文字はエスケープする', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '<b>山田</b> & "太郎" 様', proviso: '商品代として<script>alert(1)</script>', amount: 11000, tax: 1000, issueDate: '2026-11-16', status: '発行済', reissueCount: 0 };
  const html = R.printHtml(rec, S, { staff: '見本 花子' });
  assert.ok(/^<!DOCTYPE html>/.test(html) && /@page\{size:A4;margin:8mm\}/.test(html));
  assert.ok(html.includes('<h2>領収証</h2><div class="en">RECEIPT</div>') && html.includes('<div class="cols">'));
  assert.ok(html.includes('領収証番号<small>RECEIPT #</small>') && html.includes('R-2026-00012') && html.includes('発行日<small>DATE</small>') && html.includes('2026年11月16日') && html.includes('但し書き<small>PROVISO</small>'));
  assert.ok(html.includes('備考<small>REMARKS</small>') && html.includes('ご注文番号　#1801'));
  assert.ok(html.includes('合計（税込）<small>TOTAL AMOUNT') && html.includes('消費税額（10%）<small>TAX') && html.includes('10%対象（税抜）<small>SUBTOTAL'));   // 税率ごとの対象額と消費税額が分かる言葉
  assert.ok(/<td>¥11,000<\/td><td>¥1,000<\/td><td>¥10,000<\/td>/.test(html));          // 合計（税込）・消費税額・10%対象（税抜）
  assert.ok(html.includes('サンプル商事株式会社') && html.includes('登録番号｜T0000000000000') && html.includes('〒000-0000 サンプル県サンプル市サンプル町0-0-0') && html.includes('TEL:000-000-0000　FAX:000-000-0001'));
  assert.ok(html.includes('担当者<small>NAME</small></div><b>見本 花子</b>') && html.includes('src="hanaoka_logo.png"'));
  assert.ok(html.includes('<span>&lt;b&gt;山田&lt;/b&gt; &amp; &quot;太郎&quot;</span><span>様</span>') && !html.includes('<b>山田'));
  assert.ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;'));
  assert.ok(!/再発行/.test(html.replace(/<style>[\s\S]*<\/style>/, '')) && !/class="wm"/.test(html) && !/class="stamp"/.test(html) && !/class="sb"/.test(html) && !/class="fn"/.test(html));   // 最初の発行：再発行・透かし・印・貼付欄・備考の一文は出ない
  assert.ok(!html.includes('見本銀行'));                                                   // 振込先は出さない
});
t('印刷用の HTML：拠点を選べる・担当者なし・登録番号なし・備考の一文・社印', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, tax: 1000, issueDate: '2026-11-16', status: '発行済', reissueCount: 0 };
  let h = R.printHtml(rec, S, { office: S.offices[1] });
  assert.ok(h.includes('〒111-1111 別の県別の市別町1-1-1') && h.includes('TEL:111-111-1111') && !h.includes('FAX:') && !h.includes('サンプル県サンプル市'));
  assert.ok(R.printHtml(rec, S, {}).includes('〒000-0000'));                              // 指定がなければ、先頭の拠点
  assert.ok(!/class="kv2"/.test(h));                                                      // 担当者が分からなければ、行を出さない
  h = R.printHtml(rec, R.mergeSettings(Object.assign({}, COMP, { regNo: '' }), null), {});
  assert.ok(!/登録番号/.test(h));                                                         // 登録番号が空なら、行を出さない
  h = R.printHtml(rec, R.mergeSettings(COMP, { footerNote: '備考の一文<b>' }), {});
  assert.ok(h.includes('<div class="fn">備考の一文&lt;b&gt;</div>'));
  h = R.printHtml(rec, S, { stampSrc: 'data:image/png;base64,AAAA"onerror="x' });
  assert.ok(/<img class="stamp" alt="" src="data:image\/png;base64,AAAA&quot;onerror=&quot;x">/.test(h));
});
t('印刷用の HTML：再発行は備考に入る／取消・見本（未発行）の透かし／自動印刷／外のファイルを読まない／設定が空でも落ちない', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 11000, tax: 1000, issueDate: '2026-11-16', status: '発行済', reissueCount: 2 };
  let h = R.printHtml(rec, S, { reissue: true });
  assert.ok(/<div>再発行（2回目）\nご注文番号　#1801<\/div>/.test(h));
  h = R.printHtml(Object.assign({}, rec, { status: '取消' }), S, {});
  assert.ok(/class="wm">取消</.test(h));
  h = R.printHtml(Object.assign({}, rec, { number: '' }), S, { preview: true });
  assert.ok(/class="wm">見本（未発行）</.test(h) && h.includes('発行すると付きます'));
  assert.ok(!/<script>/.test(R.printHtml(rec, S, {})) && /window\.print\(\)/.test(R.printHtml(rec, S, { auto: true })));
  assert.ok(!/https?:\/\//.test(R.printHtml(rec, S, { reissue: true })));               // 外のサイトのファイルを読まない（ロゴはリポジトリの hanaoka_logo.png）
  assert.strictEqual(R.printHtml(rec, null, {}).includes('領収証'), true);
  assert.strictEqual(R.fileName(rec), '領収証_R-2026-00012');
});

t('但し書きの候補：Shopify の商品名から作る（同じ名前は1つ・60文字まで・最大4つ）。商品が1種類なら初期値にする', () => {
  const o = { no: '1801', financial: 'paid', total: 11000, lines: [{ name: 'FLAT CART 2×4（ブラック）', qty: 1 }] };
  assert.deepStrictEqual(R.provisoCandidates(o), ['FLAT CART 2×4（ブラック） 代として']);
  assert.strictEqual(R.defaults(o).proviso, 'FLAT CART 2×4（ブラック） 代として');
  const multi = Object.assign({}, o, { lines: [{ name: '商品A - オプションは注文しない', qty: 2 }, { name: '商品B', qty: 1 }, { name: '商品A', qty: 1 }] });
  assert.deepStrictEqual(R.provisoCandidates(multi), ['商品A 代として', '商品B 代として']);   // 「オプションは注文しない」は除き、同じ名前は1つ
  assert.strictEqual(R.defaults(multi, { proviso: '設定の但し書き' }).proviso, '設定の但し書き');    // 2種類以上は、設定の但し書き（なければ「商品代として」）
  assert.strictEqual(R.defaults(multi).proviso, '商品代として');
  assert.strictEqual(R.defaults(Object.assign({}, o, { lines: [] })).proviso, '商品代として');
  assert.deepStrictEqual(R.provisoCandidates({ lines: [{ name: 'あ'.repeat(58), qty: 1 }, { name: 'い'.repeat(10), qty: 1 }] }), ['い'.repeat(10) + ' 代として']);   // 長すぎるもの（60文字超）は候補にしない
  assert.strictEqual(R.provisoCandidates({}).length, 0); assert.strictEqual(R.provisoCandidates(null).length, 0);
  assert.strictEqual(R.defaults(o).candidates.length, 0);
  assert.ok(R.validate({ atena: 'A', title: '様', proviso: R.provisoCandidates(o)[0], amount: '11000', issueDate: '2026-11-17' }, { max: 11000 }).ok);
});

t('収入印紙：基準の金額（設定）以上だけ。設定が空なら、判定しない（アプリは基準の値を持たない）', () => {
  assert.strictEqual(R.stampNeeded(100000, 100000), true); assert.strictEqual(R.stampNeeded(99999, 100000), false); assert.strictEqual(R.stampNeeded(150000, 100000), true);
  for (const th of [null, undefined, 0, -1, '', 'abc', NaN]) assert.strictEqual(R.stampNeeded(999999999, th), false, String(th));
  assert.strictEqual(R.stampNeeded('120000', '100000'), true);
});
t('収入印紙の貼付欄：stampBox のときだけ印刷する', () => {
  const rec = { number: 'R-2026-00012', orderNo: '1801', atena: '山田 太郎 様', proviso: '商品代として', amount: 150000, tax: 13636, issueDate: '2026-11-16', status: '発行済', reissueCount: 0 };
  assert.ok(!/class="sb"/.test(R.printHtml(rec, S, {})));
  const h = R.printHtml(rec, S, { stampBox: true });
  assert.ok(/class="sb">収入印紙<br>貼付欄</.test(h));
});

console.log('ok receipt_core: ' + n + ' tests');
