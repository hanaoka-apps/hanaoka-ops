// 請求・入金・違算（ar_billing_core.js）の計算ルールの確認。
// 実データ（SMILE の明細）はリポジトリに置けないので、ルールごとに小さなデータを作って確かめる。
//   node tests/test_ar_billing_core.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '../ar_billing_core.js'));

// ---- データを作る道具 ----
const cust = (code, o = {}) => Object.assign({
  '得意先ｺｰﾄﾞ': code, '得意先名１': '得意先' + code, '担当者ｺｰﾄﾞ': 'S1', '担当者名': '担当一郎',
  '締日１': '15', '入金ｻｲｸﾙ名１': '翌月', '入金日１': '10', '入金条件名１': '振込', '回収管理区分名': '行う', '得意先社名ｺｰﾄﾞ': '000001'
}, o);
const staff = [{ '担当者ｺｰﾄﾞ': 'S1', '部門名': '東京本社', '売上部門別名': '本社' }];
let slip = 1000;
// 売上の行（税抜）
const sale = (code, date, net, no) => ({ '請求先ｺｰﾄﾞ': code, '得意先ｺｰﾄﾞ': code, '伝票日付': date, '伝票№': String(slip++), '行': '1',
  '取引区分名': '掛売上', '品目名': '品物', '税抜売上金額': String(net), '消費税等': '0', '課税区分名': '税抜き', '請求書番号': String(no) });
// 消費税の行（請求書ごとに1行。日付が締日）
const tax = (code, date, t, no) => ({ '請求先ｺｰﾄﾞ': code, '得意先ｺｰﾄﾞ': code, '伝票日付': date, '伝票№': String(slip++), '行': '1',
  '取引区分名': '掛売上', '品目名': '消費税等', '税抜売上金額': '0', '消費税等': String(t), '課税区分名': '消費税', '請求書番号': String(no) });
const pay = (code, date, amt, kind = '振　込', attr = '振込') => ({ '得意先ｺｰﾄﾞ': code, '伝票日付': date, '伝票№': '1', '行': '1',
  '取引区分名': kind, '取引区分属性名': attr, '入金額': String(amt), '決済予定日': '0', '備考': '' });

// ---- 日付 ----
assert.equal(A.addMonths('2026-08-15', 1, 10), '2026-09-10');
assert.equal(A.addMonths('2026-08-31', 1, 30), '2026-09-30', '入金日 30 は月末');
assert.equal(A.addMonths('2026-01-31', 1, 30), '2026-02-28');
assert.equal(A.nextBusinessDay('2026-10-10'), '2026-10-13', '土曜→（日曜・10/12 スポーツの日）→火曜');
assert.equal(A.nextBusinessDay('2026-09-10'), '2026-09-10');
assert.equal(A.cycleMonths('翌月'), 1);
assert.equal(A.cycleMonths('2ヶ月後'), 2);
assert.equal(A.cycleMonths(''), null);
assert.equal(A.baseOf({ '部門名': '第一工場', '売上部門別名': '本社' }), '工場');
assert.equal(A.baseOf({ '部門名': 'ｿﾘｭｰｼｮﾝ営業部', '売上部門別名': 'ｿﾘｭｰｼｮﾝ営業部' }), 'ソリューション');

// ---- 請求額＝税抜＋消費税の行、締日＝消費税の行の日付、回収予定日＝マスタの条件 ----
{
  const m = A.build({
    customers: [cust('100001')], staff,
    detail: [sale('100001', '20260701', 10000, 0), // 未請求（データの最初の日を 7/1 にするため）
      sale('100001', '20260720', 100000, 50), sale('100001', '20260805', 50000, 50), tax('100001', '20260815', 15000, 50)],
    payments: [pay('100001', '20260401', 0)]
  }, { today: '2026-10-06' });
  const c = m.customers['100001'];
  const inv = c.invoices['50'];
  assert.equal(inv.amount, 165000);
  assert.equal(inv.close, '2026-08-15');
  assert.equal(inv.due, '2026-09-10');
  assert.equal(inv.partial, false, '7/16〜8/15 はデータ（7/1〜）の中に収まっている');
  assert.equal(c.unbilledAmount, 10000);
  assert.equal(c.base, '本社');
  assert.equal(c.termsLabel, '翌月10日');
}

// ---- 違算 Excel の例：山善東京 8/15締 17,137,296 に 17,140,046 入金 → 過入金 2,750 ----
{
  const m = A.build({
    customers: [cust('110201')], staff,
    detail: [sale('110201', '20260701', 1, 0), sale('110201', '20260801', 15579360, 193), tax('110201', '20260815', 1557936, 193)],
    payments: [pay('110201', '20260910', 16745475), pay('110201', '20260910', 394571, '売上割引料', '調整'), pay('110201', '20260401', 0)]
  }, { today: '2026-10-06' });
  const c = m.customers['110201'];
  assert.equal(c.invoices['193'].amount, 17137296);
  assert.equal(c.diff, -2750, '売上割引料（調整）も入金に数える');
  assert.equal(c.status, '過入金');
  assert.equal(c.oldestDue, '2026-09-10');
}

// ---- 遅れて入った入金：その回は未入金、次の回で過入金、累計が 0 に戻れば解消 ----
{
  const detail = [sale('200001', '20260701', 1, 0),
    sale('200001', '20260720', 100000, 1), tax('200001', '20260815', 10000, 1),   // 9/10 回収予定 110,000
    sale('200001', '20260820', 200000, 2), tax('200001', '20260915', 20000, 2)];  // 10/13 回収予定（10/10 が土曜） 220,000
  const base = { customers: [cust('200001')], staff, detail };
  // 9/10 には 100,000 しか入らず、9/30 に残り 10,000（9/10 と 10/13 の中間 9/26 より後）
  const late = A.build(Object.assign({}, base, { payments: [pay('200001', '20260401', 0), pay('200001', '20260910', 100000), pay('200001', '20260930', 10000)] }), { today: '2026-10-06' });
  const c = late.customers['200001'];
  assert.equal(c.periods[0].diff, 10000);
  assert.equal(c.periods[0].judged, true);
  assert.equal(c.periods[1].bound, '2026-10-13');
  assert.equal(c.periods[1].judged, false, '10/13 はまだ来ていない');
  assert.equal(c.diff, 10000, '9/30 の入金は次の回に入るので、判定済みの累計は 10,000 のまま');
  // 10/13 を過ぎて 220,000 が入れば、累計 0 で解消
  const after = A.build(Object.assign({}, base, { payments: [pay('200001', '20260401', 0), pay('200001', '20260910', 100000), pay('200001', '20260930', 10000), pay('200001', '20261013', 220000)] }), { today: '2026-10-20' });
  const c2 = after.customers['200001'];
  assert.equal(c2.periods[1].diff, -10000);
  assert.equal(c2.diff, 0);
  assert.equal(c2.openPeriods.length, 0);
  assert.equal(c2.resolved.length, 1, '解消した違算として残る');
}

// ---- 数日遅れの入金（連休明けなど）は、中間までならその回の入金として解消 ----
{
  const m = A.build({
    customers: [cust('210001')], staff,
    detail: [sale('210001', '20260401', 1, 0), sale('210001', '20260420', 100000, 1), tax('210001', '20260415', 10000, 1),
      sale('210001', '20260520', 200000, 2), tax('210001', '20260515', 20000, 2)],
    payments: [pay('210001', '20260401', 0), pay('210001', '20260515', 110000), pay('210001', '20260610', 220000)]
  }, { asof: '2026-06-30' });
  const c = m.customers['210001'];
  assert.equal(c.periods[0].bound, '2026-05-11', '5/10 は日曜');
  assert.equal(c.periods[0].diff, 0, '5/15 着は 5/11 と 6/10 の中間（5/26）より前なので 5/10 の回');
  assert.equal(c.diff, 0);
}

// ---- 次の請求がない得意先の遅れた入金も、最後の回に入る（国際空港上屋：6/30 期限が 7/30 着） ----
{
  const m = A.build({
    customers: [cust('220001', { '締日１': '30', '入金日１': '30' })], staff,
    detail: [sale('220001', '20260401', 1, 0), sale('220001', '20260529', 65900000, 173), tax('220001', '20260531', 6590000, 173)],
    payments: [pay('220001', '20260401', 0), pay('220001', '20260730', 72490000)]
  }, { asof: '2026-10-05' });
  assert.equal(m.customers['220001'].periods[0].paid, 72490000);
  assert.equal(m.customers['220001'].diff, 0);
}

// ---- 判定日：省略すると入金明細の最後の日（まだ登録していない入金を未入金と見誤らないため） ----
{
  const src = {
    customers: [cust('300001')], staff,
    detail: [sale('300001', '20260701', 1, 0), sale('300001', '20260801', 1000, 7), tax('300001', '20260815', 100, 7)],
    payments: [pay('999999', '20260401', 5), pay('999999', '20260909', 5)]
  };
  const m = A.build(src, { today: '2026-10-06' });
  assert.equal(m.asof, '2026-09-09');
  assert.equal(m.customers['300001'].diff, 0, '9/10 回収予定は、入金明細が 9/9 までなので判定しない');
  const m2 = A.build(src, { asof: '2026-09-30' });
  assert.equal(m2.customers['300001'].diff, 1100, '判定日を手で進めれば判定する');
}

// ---- データの最初の日より前の売上を含む請求書は判定しない ----
{
  const m = A.build({
    customers: [cust('400001')], staff,
    detail: [sale('400001', '20260701', 5000, 9), tax('400001', '20260715', 500, 9)],   // 6/16〜7/15 の請求なのに 7/1 からしかない
    payments: [pay('400001', '20260401', 0)]
  }, { today: '2026-10-06' });
  const c = m.customers['400001'];
  assert.equal(c.invoices['9'].partial, true);
  assert.equal(c.periods[0].judged, false);
  assert.equal(c.diff, 0);
}

// ---- 対象外：回収管理しない・EC・回収条件なし ----
{
  const mk = o => A.build({
    customers: [cust('500001', o)], staff,
    detail: [sale('500001', '20260701', 1, 0), sale('500001', '20260801', 1000, 3), tax('500001', '20260815', 100, 3)],
    payments: [pay('500001', '20260401', 0)]
  }, { asof: '2026-10-05' }).customers['500001'];
  assert.equal(mk({}).diff, 1100);
  assert.equal(mk({ '回収管理区分名': '行わない' }).excludeReason, '回収管理しない得意先');
  assert.equal(mk({ '回収管理区分名': '行わない' }).diff, 0);
  assert.match(mk({ '得意先社名ｺｰﾄﾞ': '005998' }).excludeReason, /EC/);
  assert.equal(mk({ '入金ｻｲｸﾙ名１': '', '入金日１': '0' }).excludeReason, '回収条件の登録なし');
}

// ---- 支払条件追記：基準額以上は N 日後振込（でんさいの条件は期限をずらさない） ----
{
  const r = A.parseTermsNote('11万以上150日後振込→26.03より11万位以上でんさい60日');
  assert.deepEqual(r, [{ threshold: 110000, taxEx: false, days: 150, from: '', until: '2026-03' }]);
  assert.deepEqual(A.parseTermsNote('31.5万以上期日指定払 120日'), [], '期日指定はいつもの期日に受け取る');
  assert.deepEqual(A.parseTermsNote('10万以上　157日後期日指定現金振込'), []);
  assert.equal(A.parseTermsNote('50万以上翌月15日起算90日後振込み')[0].days, 90);
  assert.equal(A.parseTermsNote('税別30万以上の場合、支払日(末締　翌月末支払い)起算　120日後振込')[0].taxEx, true);
  assert.deepEqual(A.parseTermsNote('30万以上120日手形'), [], 'でんさい（旧手形）は期限が変わらない');
  assert.deepEqual(A.parseTermsNote('入金後出荷'), []);
  const m = A.build({
    customers: [cust('600001', { '締日１': '30', '入金日１': '30', '支払条件追記': '30万以上150日後振込' })], staff,
    detail: [sale('600001', '20260401', 1, 0),
      sale('600001', '20260415', 100000, 1), tax('600001', '20260430', 10000, 1),     // 5/31 期限（基準未満）
      sale('600001', '20260515', 400000, 2), tax('600001', '20260531', 40000, 2)],    // 6/30 + 150日 = 11/27
    payments: [pay('600001', '20260401', 0), pay('600001', '20260529', 110000)]
  }, { asof: '2026-10-05' });
  const c = m.customers['600001'];
  assert.equal(c.invoices['2'].due, '2026-11-27');
  assert.match(c.invoices['2'].rule, /30万円以上は回収予定日の150日後/);
  assert.equal(c.diff, 0, '440,000 はまだ期限前');
}

// ---- 手形はでんさいと表示する ----
{
  const m = A.build({ customers: [cust('700001', { '入金条件名１': '手形' })], staff, detail: [sale('700001', '20260401', 1, 0)],
    payments: [pay('700001', '20260410', 5, '手　形', '手形')] }, { asof: '2026-10-05' });
  assert.equal(m.customers['700001'].payMethod, 'でんさい');
  assert.equal(m.customers['700001'].payments[0].kind, 'でんさい');
}

// ---- 入金後出荷：請求より前の前払いも数える ----
{
  const m = A.build({
    customers: [cust('800001', { '締日１': '30', '入金日１': '30', '支払条件追記': '入金後出荷' })], staff,
    detail: [sale('800001', '20260401', 1, 0), sale('800001', '20260610', 50000, 3), tax('800001', '20260630', 5000, 3)],
    payments: [pay('800001', '20260401', 0), pay('800001', '20260603', 55000)]
  }, { asof: '2026-10-05' });
  assert.equal(m.customers['800001'].diff, 0);
}

// ---- 特別請求：選んだ伝票を SMILE の請求書から外し、登録した回収予定日で判定 ----
{
  const s1 = sale('900001', '20260310', 1000000, 141), s2 = sale('900001', '20260320', 50000, 141);
  const detail = [sale('900001', '20260101', 1, 0), s1, s2, tax('900001', '20260331', 105000, 141), sale('900001', '20260405', 30000, 0)];
  const key = r => A.lineKey({ date: A.fromSmile(r['伝票日付']), slip: r['伝票№'], row: r['行'] });
  const sp = { id: 7, cust: '900001', no: '468212', issue: '2026-03-10', due: '2026-06-30', net: 1000000, tax: 100000, status: '登録',
    lines: [{ key: key(s1) }] };
  const m = A.build({
    customers: [cust('900001', { '締日１': '30', '入金日１': '30' })], staff, detail, specials: [sp],
    payments: [pay('900001', '20260101', 0), pay('900001', '20260430', 55000), pay('900001', '20260630', 1100000)]
  }, { asof: '2026-10-05' });
  const c = m.customers['900001'];
  assert.equal(c.invoices['141'].amount, 55000, 'SMILE の請求書は特別請求の伝票と、その消費税を除いた額');
  assert.equal(c.invoices['S7'].amount, 1100000);
  assert.equal(c.invoices['S7'].due, '2026-06-30');
  assert.equal(c.invoices['S7'].lines.length, 1);
  assert.equal(c.diff, 0, '4/30 に 55,000、6/30 に 1,100,000 でどちらも入金済');
  assert.equal(c.unbilled.length, 2, '1/1 の穴埋めと 4/5 の未請求');
  // 取り消した特別請求は無視して、元の SMILE の請求書に戻る
  const m2 = A.build({ customers: [cust('900001', { '締日１': '30', '入金日１': '30' })], staff, detail, specials: [Object.assign({}, sp, { status: '取消' })], payments: [] }, { asof: '2026-10-05' });
  assert.equal(m2.customers['900001'].invoices['141'].amount, 1155000);
  // 未請求の伝票を特別請求にしたら、まだ締めていない売上から消える
  const u = detail[4];
  const m3 = A.build({ customers: [cust('900001')], staff, detail, payments: [],
    specials: [{ id: 8, cust: '900001', issue: '2026-04-06', due: '2026-05-31', net: 30000, tax: 3000, lines: [{ key: key(u) }] }] }, { asof: '2026-10-05' });
  assert.equal(m3.customers['900001'].unbilled.length, 1, '4/5 の伝票は特別請求へ。残るのは 1/1 の穴埋めだけ');
  assert.equal(m3.customers['900001'].invoices['S8'].amount, 33000);
}

// ---- CSV：引用符の中のカンマ・改行、BOM ----
{
  const rows = A.toObjects('﻿"a","b"\r\n"1,2","x""y"\r\n"3","改\n行"\r\n');
  assert.deepEqual(rows, [{ a: '1,2', b: 'x"y' }, { a: '3', b: '改\n行' }]);
}

console.log('ok test_ar_billing_core');
