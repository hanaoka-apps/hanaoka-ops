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
assert.deepEqual({ ...referenceCosts(100, { rate_status: 'レート未確定', labor_amount_yen: null }) }, {
  without: 100, with: null, status: 'レート未確定',
});
assert.deepEqual({ ...referenceCosts(null, {}) }, {
  without: null, with: null, status: '標準原価未取得',
});
assert.equal(referenceRate(200, 100), 50);
assert.equal(referenceRate(0, 100), null);
assert.equal(referenceRate(200, null), null);
console.log('reference cost helper checks passed');
