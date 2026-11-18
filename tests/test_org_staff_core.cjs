/* 架空データだけで、年度境界・誤照合・将来案の保持を確認する。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../org_staff_core.js');
const person = { id: 'p', name: '見本 一郎', dept: '旧所属', birth: 2000, titles: [{ from: 2025, title: '担当' }], grades: [{ from: 2028, grade: 'R2' }], moves: [{ from: 2030, dept: '将来所属' }], retire: 2040, events: [{ y: 2040, t: '退職予定' }] };
const row = { staffId: '1', empCode: '0001', name: '見本 一郎', dept: '現在所属', title: '主任', state: '在籍', birthDate: '2000-04-01', startDate: '2020-04-01', endDate: null };
function database() { return { depts: [], staffSync: { baselineId: 'cur' }, scenarios: [{ id: 'cur', people: [{ ...structuredClone(person), staffId: '1' }] }, { id: 'ideal', people: [{ ...structuredClone(person), staffId: '1' }] }] }; }
test('3/31と4/1の誕生日を区別し、過去年・将来年も同じ基準', () => {
  assert.equal(C.ageAt({ birthDate: '2000-03-31' }, 2026), 26);
  assert.equal(C.ageAt({ birthDate: '2000-04-01' }, 2026), 25);
  assert.equal(C.ageAt({ birthDate: '2000-12-31' }, 2030), 29);
  assert.equal(C.ageAt({ birthDate: '2000-02-29' }, 2025), 25);
});
test('生年だけ・不正日付・未来の生年月日は年齢未確認', () => {
  for (const p of [{ birth: 2000 }, { birthDate: '2000-02-30' }, { birthDate: '2027-01-01' }]) assert.equal(C.ageAt(p, 2026), null);
  assert.equal(C.dateKey('2000年4月1日'), '2000-04-01');
  assert.equal(C.dateKey('2000/4/1'), '2000-04-01');
});
test('年度は日本時間の日付に対して4月切替', () => {
  assert.equal(C.fiscalYear('2026-03-31'), 2025);
  assert.equal(C.fiscalYear('2026-04-01'), 2026);
});
test('同姓同名は自動で候補を一人にしない。コード・接続済みIDを優先', () => {
  const rows = [row, { ...row, staffId: '2', empCode: '2' }];
  assert.equal(C.candidate(person, rows), null);
  assert.equal(C.candidate({ ...person, empCode: '1' }, rows).staffId, '1');
  assert.equal(C.candidate({ ...person, staffId: '2', empCode: '1' }, rows).staffId, '2');
  assert.equal(C.candidate({ ...person, staffId: '消えたID' }, rows), null);
  assert.equal(C.candidate({ name: '見本' }, rows), null);
});
test('給与は最新月のコード一件一致のみ。給与の金額は返さない', () => {
  const p = [{ id: 1, Title: '見本', Kind: '社員', EmpCode: '1' }, { id: 2, Kind: '派遣' }, { id: 3, Kind: 'シルバー' }, { id: 4, Kind: 'スポット' }];
  const r = C.roster(p, [{ 年月: '2026-09', 従業員コード: '0001', 生年月日: '2000年1月1日' }, { 年月: '2026-10', 従業員コード: '0001', 生年月日: '2000年4月1日', 基本給: 999999 }]);
  assert.equal(r.rows.length, 1); assert.equal(r.rows[0].birthDate, '2000-04-01'); assert.equal(r.month, '2026-10');
  assert.ok(!JSON.stringify(r).includes('999999'));
});
test('同じコードが複数・給与取得なしでは生年月日を推測しない', () => {
  const persons = [{ id: 1, Kind: '社員', EmpCode: '1' }], e = { 年月: '2026-10', 従業員コード: '1', 生年月日: '2000年4月1日' };
  assert.equal(C.roster(persons, [e, e]).rows[0].birthDate, null);
  assert.equal(C.roster(persons, []).rows[0].birthDate, null);
});
test('現状だけ所属・役職を記録し、将来案の予定と過去の所属を保持する', () => {
  const db = database(), before = structuredClone(db), result = C.sync(db, [row], '2026-11-18').db;
  assert.deepEqual(db, before);
  const cur = result.scenarios[0].people[0], ideal = result.scenarios[1].people[0];
  assert.equal(C.actualAt(cur, 2025), null);
  assert.equal(C.actualAt(cur, 2026).dept, '現在所属');
  assert.equal(ideal.actualHistory, undefined);
  for (const k of ['dept', 'titles', 'grades', 'moves', 'retire', 'events']) assert.deepEqual(ideal[k], before.scenarios[1].people[0][k]);
  assert.equal(ideal.birthDate, '2000-04-01'); assert.equal(ideal.empCode, '0001');
});
test('同じ結果の再取得で変更を増やさない', () => {
  const first = C.sync(database(), [row], '2026-11-18').db;
  assert.deepEqual(C.sync(first, [row], '2026-11-18').db, first);
});
test('未接続の人を勝手に照合しない', () => {
  const db = database(); delete db.scenarios[0].people[0].staffId;
  assert.deepEqual(C.sync(db, [row], '2026-11-18').db.scenarios[0].people[0], db.scenarios[0].people[0]);
});
test('元から消えた人を退職にせず、取得済み生年月日を欠損で消さない', () => {
  const first = C.sync(database(), [row], '2026-11-18').db;
  const missing = C.sync(first, [], '2026-11-18');
  assert.deepEqual(missing.db, first); assert.equal(missing.notices.length, 1);
  const blank = C.sync(first, [{ ...row, birthDate: null }], '2026-11-18').db;
  assert.equal(blank.scenarios[1].people[0].birthDate, '2000-04-01');
});
test('初期状態で自動追加せず、有効時は現状だけに新規人員を追加する', () => {
  const db = database(), newRow = { ...row, staffId: '2', empCode: '2', name: '見本 二郎' };
  assert.equal(C.sync(db, [row, newRow], '2026-11-18').db.scenarios[0].people.length, 1);
  db.staffSync.autoAdd = true;
  const next = C.sync(db, [row, newRow, { ...newRow, staffId: '3', state: '退職' }], '2026-11-18').db;
  assert.equal(next.scenarios[0].people.length, 2); assert.equal(next.scenarios[1].people.length, 1);
  assert.equal(C.sync(next, [row, newRow], '2026-11-18').db.scenarios[0].people.length, 2);
});
test('重複対応・空の取得結果を止める', () => {
  const db = database(); db.scenarios[0].people.push({ ...person, id: 'p2', staffId: '1' });
  assert.throws(() => C.sync(db, [row], '2026-11-18'), /重複/);
  assert.throws(() => C.roster([], []), /空/);
});
test('入社予定の日付未確認・退職・退職予定を区別する', () => {
  assert.equal(C.presentActual({ state: '入社予定' }, 2026), false);
  assert.equal(C.presentActual({ state: '退職' }, 2026), false);
  assert.equal(C.presentActual({ state: '退職予定', endDate: '2026-12-31' }, 2026), true);
  assert.equal(C.presentActual({ state: '退職予定', endDate: '2026-12-31' }, 2027), false);
});
test('現状から案をコピーしても、退職者を復活させず、所属の実績と将来の予定を保持', () => {
  const p = { ...structuredClone(person), actualHistory: [{ year: 2026, dept: '現在所属', title: '主任', state: '退職' }] };
  const planned = C.planPerson(p, 2026);
  assert.equal(planned.retire, 2026); assert.equal(planned.actualHistory, undefined);
  assert.ok(planned.moves.some(x => x.from === 2026 && x.dept === '現在所属'));
  assert.ok(planned.moves.some(x => x.from === 2030 && x.dept === '将来所属'));
  assert.equal(p.retire, 2040);
});
test('自動追加の開始後でも、手入力と同名の新規人員は追加を保留する', () => {
  const db = database(); db.staffSync.autoAdd = true; delete db.scenarios[0].people[0].staffId;
  const result = C.sync(db, [row], '2026-11-18');
  assert.equal(result.db.scenarios[0].people.length, 1); assert.equal(result.notices.length, 1);
});
