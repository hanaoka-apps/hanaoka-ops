/* 架空データで等級の確認期間と年収試算を検証する。 */
const test = require('node:test'), assert = require('node:assert/strict');
const G = require('../org_grade_core.js'), C = require('../org_staff_core.js');
const hr = (month, grade, extra = {}) => ({ 年月: month, 所属: grade, 従業員コード: '0001', 拠点: '本社', ...extra });
test('R1-3・R3-2と全角表記を認識し、MGRをRに勝手に変えない', () => {
  assert.equal(G.grade('Ｒ１－３'), 'R1-3'); assert.equal(G.grade('一般職 R3-2'), 'R3-2'); assert.equal(G.grade('MGR1-3'), 'MGR1-3');
  for (const s of ['R1-30', 'R3-2a', 'AR3-2', 'R3-2 R1-3', '']) assert.equal(G.grade(s), null);
});
test('同じ等級の連続月だけを確認期間として返す', () => {
  const r = G.evidence([hr('2026-07', 'R1-3'), hr('2026-08', 'R3-2'), hr('2026-09', 'R3-2'), hr('2026-10', 'R3-2')], '1', '本社', '2026-10');
  assert.equal(r.sinceMonth, '2026-08'); assert.equal(r.samples, 3);
  assert.equal(G.evidence([hr('2026-07', 'R3-2'), hr('2026-10', 'R3-2')], '1', '本社', '2026-10').sinceMonth, '2026-10');
});
test('同一月のコード重複と拠点違いを混ぜない', () => {
  const rows = [hr('2026-10', 'R1-3'), hr('2026-10', 'R3-2', { 拠点: '工場' })];
  assert.equal(G.evidence(rows, '1', '本社', '2026-10').grade, 'R1-3');
  assert.equal(G.evidence([...rows, rows[0]], '1', '本社', '2026-10'), null);
});
test('初めて記録した月を昇格日とせず、確認期間の下限を返す', () => {
  const p = { hrGrade: { grade: 'R3-2', month: '2026-10', sinceMonth: '2026-07' } }, info = G.gradeInfo(p, 2026, true);
  const t = G.tenure(p, info, '2026-11-18');
  assert.equal(t.months, 3); assert.match(t.label, /少なくとも/); assert.equal(t.through, '2026-10');
  assert.equal(G.tenure(p, info, '2026-03-31').months, null);
});
test('確認済み開始日と、別の等級期間の開始日を区別', () => {
  const p = { hrGrade: { grade: 'R3-2', month: '2026-10', sinceMonth: '2026-07' }, gradeStarts: [{ grade: 'R3-2', from: null, sourceSince: '2026-07', date: '2020-04-01' }] };
  assert.equal(G.tenure(p, G.gradeInfo(p, 2026, true), '2026-11-18').months, 79);
  p.gradeStarts[0].sourceSince = '2019-01';
  assert.equal(G.tenure(p, G.gradeInfo(p, 2026, true), '2026-11-18').months, 3);
});
test('現状の等級を更新し、将来案の等級予定は残す', () => {
  const p = { grades: [{ from: 2025, grade: 'R1-3' }, { from: 2028, grade: 'R4-1' }], hrGrade: { grade: 'R3-2', month: '2026-10', sinceMonth: '2026-07' } };
  assert.equal(G.gradeInfo(p, 2026, true).grade, 'R3-2');
  assert.equal(G.gradeInfo(p, 2026, false).grade, 'R1-3');
  assert.equal(G.gradeInfo(p, 2028, true).grade, 'R4-1');
  assert.equal(G.gradeInfo(p, 2025, true).grade, 'R1-3');
});
test('現状からコピーすると現状の等級になり、将来の変更も残る', () => {
  const p = { grades: [{ from: 2025, grade: 'R1-3' }, { from: 2028, grade: 'R4-1' }], hrGrade: { grade: 'R3-2', month: '2026-10', sinceMonth: '2026-07' } };
  const planned = C.planPerson(p, 2026);
  assert.equal(G.gradeInfo(planned, 2026, false).grade, 'R3-2'); assert.equal(G.gradeInfo(planned, 2028, false).grade, 'R4-1');
});
test('基本給＋役職手当の12か月と基本給基準の賞与を分けて計算', () => {
  assert.deepEqual(G.forecast(300000, 20000, 300000, 4), { monthly: 320000, bonus: 1200000, annual: 5040000 });
  assert.equal(G.forecast(300000, 20000, 350000, 4).annual, 5240000);
});
test('役員は共通賞与や個別設定があっても賞与なし', () => {
  assert.deepEqual(G.forecast(300000, 20000, 300000, 4, true), { monthly: 320000, bonus: 0, annual: 3840000 });
  assert.equal(G.forecast(300000, 20000, null, null, true).annual, 3840000);
});
test('賞与0月と不明を区別し、マイナスや非数値を計算しない', () => {
  assert.equal(G.forecast('300,000', 0, 300000, 0).annual, 3600000);
  for (const missing of [null, undefined, '', -1, NaN, Infinity, 'abc']) assert.equal(G.forecast(300000, 0, 300000, missing).annual, null);
  assert.equal(G.forecast(null, 0, 0, 0, true).annual, null);
});
test('給与原本から基本給と役付手当だけを抜き、欠損を0にしない', () => {
  const r = G.salaryRow({ 従業員コード: '0001', 氏名: '見本', 内訳: { 基本給: '300,000', 役付手当: 20000, 普通残業: 99999 } }, '2026-10', '本社');
  assert.equal(r.basic, 300000); assert.equal(r.role, 20000); assert.equal(r.overtimePay, 99999); assert.ok(!('氏名' in r));
  assert.equal(G.salaryRow({ 内訳: { 基本給: 300000 } }, '2026-10', '本社').role, null);
});
test('給与の想定は開始年度で切り替え、後の年度にも引き継ぐ', () => {
  const p = { payPlans: [{ from: 2026, basic: 300000 }, { from: 2030, basic: 350000 }] };
  assert.equal(G.payPlan(p, 2025), null); assert.equal(G.payPlan(p, 2028).basic, 300000); assert.equal(G.payPlan(p, 2031).basic, 350000);
});
test('人員更新で等級・役員区分を反映しても、給与想定・昇格予定・確認開始日は消さない', () => {
  const p = { id: 'p', staffId: '1', grades: [{ from: 2028, grade: 'R4-1' }], payPlans: [{ from: 2027, basic: 300000 }], gradeStarts: [{ grade: 'R3-2', date: '2020-04-01' }] };
  const db = { depts: [], staffSync: { baselineId: 'cur' }, scenarios: [{ id: 'cur', people: [p] }] };
  const result = C.sync(db, [{ staffId: '1', name: '見本', kind: '役員', state: '在籍', dept: '経営', gradeEvidence: { grade: 'R3-2', month: '2026-10', sinceMonth: '2026-07' } }], '2026-11-18').db.scenarios[0].people[0];
  assert.equal(result.hrGrade.grade, 'R3-2'); assert.equal(result.employeeKind, '役員');
  for (const field of ['grades', 'payPlans', 'gradeStarts']) assert.deepEqual(result[field], p[field]);
});
test('翌年度の等級が更新されても、前年度に確認した等級と期間を保持', () => {
  const old = { grade: 'R1-3', month: '2026-10', sinceMonth: '2026-07' }, fresh = { grade: 'R3-2', month: '2027-10', sinceMonth: '2027-04' };
  const db = { depts: [], staffSync: { baselineId: 'cur' }, scenarios: [{ id: 'cur', people: [{ id: 'p', staffId: '1', hrGrade: old }] }] };
  const next = C.sync(db, [{ staffId: '1', name: '見本', dept: '営業', state: '在籍', gradeEvidence: fresh }], '2027-11-18').db.scenarios[0].people[0];
  const prior = G.gradeInfo(next, 2026, true), current = G.gradeInfo(next, 2027, true);
  assert.equal(prior.grade, 'R1-3'); assert.equal(current.grade, 'R3-2');
  assert.equal(G.tenure(next, prior, '2026-11-18').months, 3);
  assert.equal(G.tenure(next, current, '2027-11-18').months, 6);
});
test('完全な給与明細で省略された支給項目は0、明細欠損や不正値は未確認', () => {
  const r = G.salaryRow({ 従業員コード: '1', 内訳: { 基本給: 300000, 支給合計: 300000 } }, '2026-10', '本社');
  assert.equal(r.role, 0); assert.equal(r.basic, 300000);
  assert.equal(G.salaryRow({ 内訳: {} }, '2026-10', '本社').role, null);
  assert.equal(G.salaryRow({ 内訳: { 支給合計: 300000, 役付手当: '不明' } }, '2026-10', '本社').role, null);
  assert.equal(G.salaryRow({ 内訳: { 支給合計: 0 } }, '2026-10', '本社').basic, 0);
});

test('営業手当と20時間超の追加分を重複なく年収に含める', () => {
  assert.equal(G.overtimeCost(15, null, 40000), 0);
  assert.equal(G.overtimeCost(20, 2000, 40000), 0);
  assert.equal(G.overtimeCost(30, 2000, 40000), 20000);
  assert.equal(G.overtimeCost(30, 2000, 0), 60000);
  assert.equal(G.overtimeCost(30, null, 40000), null);
  assert.equal(G.overtimeCost(null, 2000, 40000), null);
  assert.equal(G.forecast(300000, 20000, 300000, 4, false, 40000, 20000).annual, 5760000);
});
test('残業平均は実績0を含み、欠損月・重複を除く', () => {
  assert.deepEqual(G.recentMonths('2026-01'), ['2025-11','2025-12','2026-01']);
  const avg = G.overtimeAverage([{month:'2026-08',overtimeHours:0},{month:'2026-10',overtimeHours:30}], G.recentMonths('2026-10'));
  assert.equal(avg.hours,15); assert.equal(avg.samples,2);
  assert.equal(G.overtimeAverage([], G.recentMonths('2026-10')).hours,null);
});
