const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootPath = path.resolve(__dirname, '..');
const staticHtml = fs.readFileSync(path.join(rootPath, 'static/value_analysis.html'), 'utf8');
const fujinHtml = fs.readFileSync(path.join(rootPath, 'fujin/value_analysis.html'), 'utf8');
assert.equal(staticHtml, fujinHtml);

const start = staticHtml.indexOf('    function purchaseAxisLabel(');
const end = staticHtml.indexOf('    load().catch(showLoadError);', start);
assert.ok(start > 0 && end > start, '日別仕入グラフの描画関数が見つかる');
const rendererSource = staticHtml.slice(start, end);

const hit = {
  dataset: {date: '2026-10-03', daily: '400', cumulative: '700'},
  events: {},
  addEventListener(name, handler) { this.events[name] = handler; },
  getBoundingClientRect() { return {left: 50, top: 50, width: 12}; },
};
const tooltip = {
  hidden: true, innerHTML: '', offsetWidth: 150, offsetHeight: 65, style: {},
};
const chart = {
  clientWidth: 960, clientHeight: 320,
  querySelector(selector) {
    assert.equal(selector, '.purchase-daily-tooltip');
    return tooltip;
  },
  querySelectorAll(selector) {
    assert.equal(selector, '.purchase-day-hit');
    return [hit];
  },
  getBoundingClientRect() { return {left: 0, top: 0}; },
};
const root = {
  innerHTML: '',
  classList: { add() {} },
  querySelector(selector) {
    if (selector === '#purchaseDailyDay') return null;
    if (selector === '.purchase-daily-chart') return chart;
    throw new Error('unexpected selector: ' + selector);
  },
};
const state = {
  month: '202610',
  data: {
    purchase_daily_by_month: {
      202610: {
        '2026-10-01': {total: 100, zones: {'第一工場': 20}, unclassified: 5},
        '2026-10-02': {total: 200, zones: {'第一工場': 30}},
        '2026-10-03': {total: 400, zones: {'第二工場': 40}, unclassified: 7},
      },
    },
    monthly: {202610: {total: {purchase: 700}}},
    meta: {daily_purchase_updated_at: '2026-10-03'},
  },
};
const yen = value => Number(value).toLocaleString('ja-JP') + ' 円';
let mobile = false;
const {purchaseAxisRange, renderPurchaseDaily} = new Function(
  'state', 'el', 'yen', 'esc', 'displayMonth', 'signedYen', 'window',
  rendererSource + '\nreturn {purchaseAxisRange, renderPurchaseDaily};'
)(
  state,
  id => { assert.equal(id, 'purchaseDaily'); return root; },
  yen,
  value => String(value),
  value => value.slice(0, 4) + '年' + Number(value.slice(4)) + '月',
  yen,
  {matchMedia: () => ({matches: mobile})},
);

assert.deepEqual(purchaseAxisRange([100, 200, 400]), {min: 0, max: 400});
assert.deepEqual(purchaseAxisRange([-100, 0, 300]), {min: -100, max: 300});
assert.deepEqual(purchaseAxisRange([0, 0]), {min: 0, max: 1});
renderPurchaseDaily();
assert.match(root.innerHTML, /日別集計・月計<\/span><strong>700 円<\/strong>/);
assert.match(root.innerHTML, /purchase-chart-selection[^>]*>2026-10-03 の仕入 <strong>400 円<\/strong>/);
assert.match(root.innerHTML, /左軸・右軸とも円。尺度は別です。/);
assert.match(root.innerHTML, /purchase-day-hit/);
assert.match(root.innerHTML, /2026年10月 月間 工場別仕入内訳/);
assert.match(root.innerHTML, /第一工場<\/span><b>50 円/);
assert.match(root.innerHTML, /第二工場<\/span><b>40 円/);
assert.match(root.innerHTML, /工場未分類<\/span><b>12 円/);
assert.match(staticHtml, /--graph-purchase:var\(--graph-sales\)/, '仕入棒は営業系グラフと共通の青色を使う');
assert.match(staticHtml, /purchase-daily-chart svg rect\.purchase-bar\{fill:var\(--graph-purchase\)\}/);

const firstBar = root.innerHTML.match(/class="purchase-bar" x="[^"]+" y="[^"]+" width="[^"]+" height="([^"]+)"/);
assert.ok(firstBar);
assert.equal(Number(firstBar[1]), (320 - 42 - 48) * .25, '100円の棒は400円目盛りの25%の高さ');
hit.events.mouseenter({clientX: 55, clientY: 55});
assert.equal(tooltip.hidden, false);
assert.match(tooltip.innerHTML, /日別仕入 400 円/);
assert.match(tooltip.innerHTML, /月内累計 700 円/);
mobile = true;
renderPurchaseDaily();
assert.match(root.innerHTML, /<details class="purchase-daily-table" open>/);
assert.ok(root.innerHTML.includes('<td>2026-10-03</td><td>400 円</td><td>700 円</td>'));

if (process.argv.includes('--preview')) {
  const styles = [...staticHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(match => match[1]).join('\n');
  const theme = fs.readFileSync(path.join(rootPath, 'hanaoka_theme.css'), 'utf8');
  const preview = '<!doctype html><html lang="ja"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>日別仕入グラフ・架空データ確認</title><style>' + theme + '\n' + styles
    + '\nbody{padding:24px;max-width:1200px;margin:auto}#purchaseDaily{display:block}</style>'
    + '<section id="purchaseDaily" class="box">' + root.innerHTML + '</section></html>';
  fs.writeFileSync('/private/tmp/fujin-purchase-preview.html', preview);
}

console.log('purchase chart synthetic fixture OK');
