const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../static/value_analysis.html'), 'utf8');
const expression = (name, next) => {
  const match = html.match(new RegExp(`${name}=(.*?),${next}=`));
  assert.ok(match, `${name} formatter exists`);
  return vm.runInNewContext(`(${match[1]})`);
};

const laborMinutes = expression('laborMinutes', 'signedLaborMinutes');
const signedLaborMinutes = expression('signedLaborMinutes', 'records');
assert.equal(laborMinutes(90), '90分');
assert.equal(laborMinutes(1.25), '1.25分');
assert.equal(laborMinutes(0), '0分');
assert.equal(laborMinutes(null), '未取得');
assert.equal(signedLaborMinutes(90), '+90分');
assert.equal(signedLaborMinutes(-12.5), '-12.5分');
assert.equal(signedLaborMinutes(null), '前月未取得');
assert.match(html, /Number\(p1\.cum_std_per_unit\)\.toLocaleString\('ja-JP',\{maximumFractionDigits:2\}\)\+'分／個'/);
assert.doesNotMatch(html, /Number\((?:value|p1\.cum_std_per_unit)\)\/60/);
assert.match(html, /class="item-page-heading"/);
assert.match(html, /\.item-desktop-list #itemTable th\{padding:12px 10px/);
const cellHelpers = html.split('function laborStandardCell(labor)')[1]?.split('const renderItemsWithDesktopTable=')[0];
assert.ok(cellHelpers, 'item-list labor helpers exist');
const { laborStandardCell, laborAmountCell } = vm.runInNewContext(
  `function laborStandardCell(labor)${cellHelpers}; ({ laborStandardCell, laborAmountCell })`,
  { minutes: value => `${value}分`, laborAmount: value => `${value}円` },
);
assert.match(laborStandardCell({ labor_status: '子部品工数未取得', cum_std_per_unit: null, own_std_per_unit: 7 }), /子部品待ち.*自工程 7分／個/);
assert.match(laborStandardCell({ labor_status: '社内工程あり・期間内実績なし', cum_std_per_unit: null }), /期間内実績なし/);
assert.match(laborStandardCell({ labor_status: '社内工程なし（対象外）', cum_std_per_unit: 0 }), /対象外/);
assert.equal(laborStandardCell({ labor_status: '集計済み', cum_std_per_unit: 9 }), '9分');
assert.equal(laborAmountCell({ labor_status: '子部品工数未取得', cum_std_per_unit: null }), '未算定');
assert.equal(laborAmountCell({ labor_status: '集計済み', cum_std_per_unit: 9, rate_status: 'レート未確定' }), 'レート未確定');
console.log('labor minute display and item-view design checks passed');
