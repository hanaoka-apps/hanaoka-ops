/* 架空の給与で、自動取得・部分的な取得失敗・月替わりを確認する。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function app(fetcher) {
  const person = { id:'p', name:'見本', dept:'本社/営業部', empCode:'1', payrollSite:'本社', payType:'月給者', employeeKind:'社員' };
  const sn = { id:'cur', name:'現状', people:[person], payAssumptions:{bonusMonths:4} };
  const ctx = vm.createContext({ OrgGradeCore:require('../org_grade_core.js'), OrgStaffCore:require('../org_staff_core.js'),
    OrgStaff:{source:{loaded:true,month:'2026-10',revision:1,rows:[{payrollSite:'本社'},{payrollSite:'工場'}]}},
    DB:{staffSync:{baselineId:'cur'}}, sc:()=>sn, year:2026, mode:'grades', demo:false, renderMain:()=>{},
    deptAt:p=>p.dept, present:()=>true, ageAt:()=>30, esc:x=>String(x??''), payrollGetFile:fetcher });
  vm.runInContext(fs.readFileSync(require.resolve('../org_grades.js'),'utf8')+'\nglobalThis.app = OrgGrades;',ctx);
  return {ctx,sn,ui:ctx.app};
}
const salary = [{従業員コード:'1',内訳:{基本給:300000,支給合計:300000}}];
test('画面用の自動取得は一度だけ行い、再描画で繰り返さず、月替わりに取り直す', async () => {
  const calls=[];const {ctx,ui}=app(async path=>(calls.push(path),salary));
  await ui.ensurePay(); assert.equal(calls.length,2);
  await ui.ensurePay(); assert.equal(calls.length,2);
  const html=ui.render([{name:'本社/営業部'}]); assert.match(html,/4,800,000円/); assert.doesNotMatch(html,/給与未接続・未確認/);
  ctx.OrgStaff.source.month='2026-11';ctx.OrgStaff.source.revision++;
  await ui.ensurePay();assert.equal(calls.length,4);assert.match(calls[2],/2026-11/);
});
test('一方の拠点が失敗しても、取得できた拠点の金額を表示する', async () => {
  const {ui}=app(async path=>{if(path.includes('工場'))throw Error('取得不可');return salary;});
  await ui.ensurePay();const html=ui.render([{name:'本社/営業部'}]);
  assert.match(html,/4,800,000円/);assert.match(html,/一部の拠点を取得できませんでした/);
});
test('取得失敗を再描画ごとに繰り返さず、明示的な読み直しでは再取得する', async () => {
  let calls=0;const {ui}=app(async()=>{calls++;throw Error('取得不可');});
  await ui.ensurePay();await ui.ensurePay();assert.equal(calls,2);
  await ui.loadPay();assert.equal(calls,4);
});
test('時給者は明細の金額を表示し、月給とみなして年収を作らない', async () => {
  const {ui,sn}=app(async()=>salary);sn.people[0].payType='時給者';
  await ui.ensurePay();const html=ui.render([{name:'本社/営業部'}]);
  assert.match(html,/300,000円/);assert.match(html,/月額の想定を入力/);assert.doesNotMatch(html,/4,800,000円/);
});
