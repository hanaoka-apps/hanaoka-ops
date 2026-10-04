const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('../static/value_analysis.html', `file://${__dirname}/`), 'utf8');
const costs = html.match(/^    function referenceCosts\(total,labor\)\{.*\}$/m)?.[0];
const rate = html.match(/^    function referenceRate\(price,cost\)\{.*\}$/m)?.[0];
assert.ok(costs && rate, 'reference calculation helpers must exist in the UI source');
const sandbox = {};
vm.runInNewContext(`${costs}\n${rate}\nglobalThis.result={referenceCosts,referenceRate};`, sandbox);
const { referenceCosts, referenceRate } = sandbox.result;

assert.deepEqual({ ...referenceCosts(100, { labor_amount_yen: 12.5 }) }, {
  without: 100, with: 112.5, status: '算定済み',
});
assert.deepEqual({ ...referenceCosts(100, { labor_status: '社内工程なし（対象外）', labor_amount_yen: null }) }, {
  without: 100, with: 100, status: '対象外',
});
assert.deepEqual({ ...referenceCosts(100, { labor_status: '社内工程なし（対象外）', labor_amount_yen: 30 }) }, {
  without: 100, with: 100, status: '対象外',
}, '対象外のP1レコードに金額が混在しても工数込み参考額へ加算しない');
assert.deepEqual({ ...referenceCosts(100, { rate_status: 'レート未確定', labor_amount_yen: null }) }, {
  without: 100, with: null, status: 'レート未確定',
});
assert.deepEqual({ ...referenceCosts(null, {}) }, {
  without: null, with: null, status: '標準原価未取得',
});
assert.equal(referenceRate(200, 100), 50);
assert.equal(referenceRate(0, 100), null);
assert.equal(referenceRate(200, null), null);
const rowWrapper = html.match(/^    const itemRowsBeforeLabor=itemRowsForMonth;itemRowsForMonth=function\(\).*$/m)?.[0];
assert.ok(rowWrapper, 'item rows must include previous-month cost comparison');
const history = {
  '202607': { ITEM: { total: 90 }, ONLY_NOW: { total: 40 } },
  '202608': { ITEM: { total: 100 }, ONLY_NOW: { total: 45 } },
};
const laborHistory = {
  '202607': { ITEM: { labor_amount_yen: 8 } },
  '202608': { ITEM: { labor_amount_yen: 12 }, ONLY_NOW: { labor_amount_yen: 5 } },
};
const rowContext = {
  state: { month: '202608' },
  itemRowsForMonth: () => [{ i: 'ITEM', st: 100, std_delta: 10 }, { i: 'ONLY_NOW', st: 45, std_delta: 5 }],
  laborForCode: (code, month = '202608') => laborHistory[month]?.[code] || null,
  previousMonth: () => '202607',
  hasStandardCostSnapshot: month => !!history[month],
  monthlyCost: (code, month) => history[month]?.[code] || null,
  referenceCosts,
};
vm.runInNewContext(`${rowWrapper}\nglobalThis.rows=itemRowsForMonth();`, rowContext);
assert.equal(rowContext.rows[0].previous_standard_cost, 90);
assert.equal(rowContext.rows[0].reference_cost, 112);
assert.equal(rowContext.rows[0].reference_previous_cost, 98);
assert.equal(rowContext.rows[0].reference_delta, 14);
assert.equal(rowContext.rows[1].reference_previous_cost, null, 'missing prior labor is not treated as zero');
assert.equal(rowContext.rows[1].reference_delta, null);
delete history['202607'];
const missingContext = { ...rowContext, itemRowsForMonth: () => [{ i: 'ITEM', st: 100, std_delta: null }] };
vm.runInNewContext(`${rowWrapper}\nglobalThis.rows=itemRowsForMonth();`, missingContext);
assert.equal(missingContext.rows[0].previous_standard_cost, null, 'missing prior cost snapshot is not replaced by current cost');
assert.equal(missingContext.rows[0].reference_delta, null);
assert.match(html, /function configureItemCostHeaders\(\)/);
assert.match(html, /function renderBomCostComparisons\(rows,table,mobile\)/);
assert.match(html, /const order=\['classification','i','n','k','vr','av','a','q','va','st','previous_standard_cost','std_delta','reference_cost','reference_previous_cost','reference_delta','labor_standard_minutes','labor_amount_yen','labor_input_rate','lt_standard','lt_actual','lt_difference','lt_count'\]/, 'cost columns precede labor context and LT columns remain last');
assert.match(html, /P1構成品の工数積上げ/);
assert.match(html, /当月の品目単体実績は対象外ですが、参考工数金額は直近期間のP1基準内標準工数/);
console.log('reference cost helper checks passed');
