// 画面（HTML）の入れ子が崩れていないか：各タブの section が正しく閉じ、兄弟として並んでいること
const fs = require('fs'), assert = require('assert');
for (const f of ['ec_sales.html', 'furusato_sales.html']) {
  const html = fs.readFileSync(f, 'utf8');
  const body = html.slice(html.indexOf('<div class="wrap">'));
  let depth = 0, ok = true; const stack = [];
  const re = /<(\/?)(div|section)\b[^>]*>/g; let m;
  while ((m = re.exec(body))) {
    if (m[1]) { const t = stack.pop(); if (t !== m[2]) { ok = false; break; } } else stack.push(m[2]);
  }
  assert(ok, f + ': div/section の閉じ忘れ・閉じすぎ');
  for (const id of ['p-orders', 'p-ship', 'p-map']) {
    const i = body.indexOf('<section id="' + id + '"'); if (i < 0) continue;
    // その section までの深さ：wrap 内の直下（深さ1）にあること
    let d = 0; const r2 = /<(\/?)(div|section)\b[^>]*>/g; let x;
    while ((x = r2.exec(body.slice(0, i)))) d += x[1] ? -1 : 1;
    assert.strictEqual(d, 1, f + ': ' + id + ' が wrap 直下にない（手前で閉じすぎ）');
  }
  const p = body.indexOf('<section id="p-orders"'), q = body.indexOf('<section id="p-ship"');
  assert(body.indexOf('id="flowBar"') > p && body.indexOf('id="flowBar"') < q || f === 'furusato_sales.html' && !body.includes('id="flowBar"') ? true : body.indexOf('id="flowBar"') > p && body.indexOf('id="flowBar"') < q, f + ': flowBar が p-orders の外');
  assert(body.indexOf('id="list"') > p && body.indexOf('id="list"') < q, f + ': 注文一覧が p-orders の外');
}
console.log('ok page structure');
