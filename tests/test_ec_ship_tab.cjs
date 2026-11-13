// 出荷チェック：①出荷待ち → ②結果を確認（送り状№が出た・未報告）→ ③完了（報告済み）の振り分けと、コピー・報告済みの操作
const assert = require('assert');
global.window = global; global.document = { getElementById: () => null };
const EC = require('../ec_sales_core.js'); require('../ec_ship_tab.js');
const today = new Date().toISOString().slice(0, 10);
const idx = { generatedAt: new Date().toISOString(), carriers: { seino: { name: '西濃', newest: new Date().toISOString() } }, ships: [
  { no: 'S1', po: ['1001'], date: today, juchu: ['9001'], slips: [{ c: 'seino', no: '9072283622' }] },   // 報告待ち
  { no: 'S2', po: ['1002'], date: today, juchu: ['9002'], slips: [{ c: 'seino', no: '9072283633' }] },   // 報告済み
  { no: 'S3', po: ['1003'], date: today, juchu: ['9003'], slips: [] }                                     // 送り状待ち
] };
const mk = (id) => ({ id, name: '#' + id, cust: 'C', orderDate: today, order: { createdTime: today, ship: { name: 'お客様' + id } } });
const slips = [mk('1001'), mk('1002'), mk('1003'), mk('1004')];
const recs = { 1001: { status: 'exported', juchuNo: '9001', matchedShip: '2026-11-13' }, 1002: { status: 'exported', shipReportedAt: '2026-11-04T01:00:00Z', shipReportedBy: 'a@x' }, 1003: { status: 'confirm', matchedShip: '2020-01-06' }, 1004: { status: 'new' } };
const handlers = {}; const box = { innerHTML: '', addEventListener: (t, f) => { handlers[t] = f; } };
const cnt = { textContent: '' }; const calls = [];
const ctx = { EC, conf: { files: { shipIndex: 'x' }, shipReport: { todo: '登録する', done: '登録済み', btn: '登録した' } }, box, cnt, visible: true, canReport: true,
  shopifyState: s => ({ 1001: 'fulfilled', 1002: 'unfulfilled' }[s.id] || ''),
  slips: () => slips, stateOf: s => recs[s.id].status, rec: s => recs[s.id], loadJson: async () => idx, rerender: () => EcShipTab.render(ctx), markReported: (ids, on) => calls.push([ids, on]) };
(async () => {
  EcShipTab.render(ctx); await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(String(cnt.textContent), '1');   // 人のボールがある②（結果を確認）だけ。①出荷待ちは数えない
  const tiles = [...box.innerHTML.matchAll(/data-sf="(\w+)"[^>]*>.*?<div class="ft-c">(\d+)/g)].map(m => m[1] + ':' + m[2]);
  assert.deepStrictEqual(tiles, ['wait:1', 'check:1', 'done:1']);
  assert(/ftile[^"]*active" data-sf="check"/.test(box.innerHTML) && !/ftile[^"]*active" data-sf="(wait|done)"/.test(box.innerHTML));   // 開いたときの表示は「②結果を確認」（EC売上・ふるさと納税とも）
  handlers.click({ target: { closest: s => s === '[data-sf]' ? { dataset: { sf: 'check' } } : null } }); await new Promise(r => setTimeout(r, 5));
  assert(box.innerHTML.includes('data-rep="1001"') && box.innerHTML.includes('907-228-3622') && box.innerHTML.includes('data-copy="9072283622"') && box.innerHTML.includes('登録した'));
  assert(!box.innerHTML.includes('data-rep="1002"'));
  // 自動登録のボタン：ctx.fulfill があるときだけ出る。押すと、報告待ち（②）の注文と送り状を渡す
  assert(!box.innerHTML.includes('id="ship-fulfill"'));
  const fcalls = []; ctx.fulfill = { run: async items => { fcalls.push(items); return true; } }; EcShipTab.render(ctx);
  assert(box.innerHTML.includes('id="ship-fulfill"') && box.innerHTML.includes('Shopify に自動で登録する（1件）'));
  handlers.click({ target: { closest: s => s === '#ship-fulfill' ? { disabled: false } : null }, stopPropagation() {} }); await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(fcalls.length, 1); assert.deepStrictEqual(fcalls[0].map(x => x.id), ['1001']); assert.strictEqual(fcalls[0][0].ship.slips[0].no, '9072283622');
  ctx.fulfill = null; EcShipTab.render(ctx);
  handlers.click({ target: { closest: s => s === '[data-rep]' ? { dataset: { rep: '1001' } } : null }, stopPropagation() {} });
  assert.deepStrictEqual(calls[0], [['1001'], true]);
  handlers.click({ target: { closest: s => s === '[data-sf]' ? { dataset: { sf: 'done' } } : null } }); await new Promise(r => setTimeout(r, 5));
  assert(box.innerHTML.includes('登録済み a') && box.innerHTML.includes('data-unrep="1002"'));
  ctx.canReport = false; EcShipTab.render(ctx);
  assert(!box.innerHTML.includes('data-unrep'));
  // 出荷予定日の列：SMILE の出荷予定日を出し、①出荷待ちのまま過ぎていれば知らせる
  handlers.click({ target: { closest: s => s === '[data-sf]' ? { dataset: { sf: 'check' } } : null } }); await new Promise(r => setTimeout(r, 5));
  assert(box.innerHTML.includes('<th>出荷予定日</th>') && box.innerHTML.includes('11/13') && !box.innerHTML.includes('過ぎています'));
  handlers.click({ target: { closest: s => s === '[data-sf]' ? { dataset: { sf: 'wait' } } : null } }); await new Promise(r => setTimeout(r, 5));
  assert(box.innerHTML.includes('01/06') && box.innerHTML.includes('過ぎています'));
  // Shopify の現在の状況：登録済み（発送済み）／未登録を、一覧に出す（Shopify の注文がない画面では出さない）
  handlers.click({ target: { closest: s => s === '[data-sf]' ? { dataset: { sf: 'all' } } : null } }); await new Promise(r => setTimeout(r, 5));
  assert(box.innerHTML.includes('Shopify：登録済み（発送済み）') && box.innerHTML.includes('Shopify：未登録'));
  assert.strictEqual(box.innerHTML.split('Shopify：登録済み（発送済み）').length - 1, 1);   // 1001 だけ
  ctx.shopifyState = null; EcShipTab.render(ctx);
  assert(!box.innerHTML.includes('Shopify：登録済み') && !box.innerHTML.includes('Shopify：未登録'));
  console.log('ok ship tab');
})().catch(e => { console.error(e); process.exit(1); });
