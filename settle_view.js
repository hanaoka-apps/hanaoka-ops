/* settle_view.js — 支払決済（フォーム SETTLE）の表示：サマリー＋確認モード（支払決済アプリの試作 settle-proto を本番化）
   wf_app が「支払決済」の申請を開いたときに呼ぶ。データは持たない（申請に付けた明細 JSON を受け取って描く）。
     SettleView.mount(el, { snap, canAct, storeKey, loadPdf(key)→Promise<url|null>, onState({ok,total,hold}) })
     SettleView.comment(storeKey, snap) → 承認・差し戻しのコメントに足す「保留・明細へのコメント」の文
   「確認OK」「保留」「コメント」は見ている人のブラウザに残す（順番に回るので、ほかの人とは共有しない。08 ③） */
(function (root) {
  'use strict';
  var RULE = { newMin: 100000, upMin: 3000000, upRate: 2 };   // 気づきのしきい値（08：初めて 10万円以上、前月の2倍以上かつ300万円以上の増加）
  var CSS = '.sv{--pri:#1a5fa8;--pri-l:#e3edf9;--line:#dde2ec;--sub:#6b7a99;--up:#c0392b;--up-l:#fbe7e5;--down:#1e8449;--down-l:#e3f4e8;--warn:#a0520c;--warn-l:#fdf0e1;--flag:#7a3db8;--flag-l:#f1e8fb;font-size:14px}' +
    '.sv .tabs{display:flex;gap:4px;border-bottom:2px solid var(--line);margin-bottom:10px}.sv .tabs button{border:1px solid var(--line);border-bottom:none;border-radius:8px 8px 0 0;background:#f4f6f9;padding:6px 16px;margin-bottom:-2px;font-weight:600;color:var(--sub);cursor:pointer}.sv .tabs button.on{background:#fff;color:var(--pri);border-color:var(--pri);border-bottom:2px solid #fff}' +
    '.sv .top{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.sv .box{border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}.sv .box h4{margin:0 0 8px;font-size:13px;color:var(--sub)}' +
    '.sv .big{font-size:28px;font-weight:700}.sv .big small{font-size:14px;color:var(--sub);font-weight:500}.sv .d-up{color:var(--up);font-weight:600}.sv .d-down{color:var(--down);font-weight:600}' +
    '.sv table{border-collapse:collapse;width:100%}.sv th,.sv td{padding:4px 7px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.sv th{font-size:12px;color:var(--sub);background:#fafbfd}.sv td.n,.sv th.n{text-align:right;font-variant-numeric:tabular-nums}' +
    '.sv .flags{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto}.sv .flag{display:flex;gap:8px;align-items:baseline;padding:4px 8px;border-radius:6px;background:var(--flag-l);cursor:pointer}.sv .flag .why{font-size:11px;font-weight:700;color:var(--flag);white-space:nowrap}.sv .flag .who{flex:1}' +
    '.sv .tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:8px;margin-left:4px;font-weight:600}.sv .t-flag{background:var(--flag-l);color:var(--flag)}.sv .t-new{background:var(--warn-l);color:var(--warn)}.sv .t-up{background:var(--up-l);color:var(--up)}.sv .t-ok{background:var(--down-l);color:var(--down)}' +
    '.sv .rv{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(0,1.7fr);gap:12px;height:72vh;min-height:480px}.sv .rl{overflow:auto;border:1px solid var(--line);border-radius:8px}.sv .rl td{white-space:normal;vertical-align:top;padding:6px 8px}.sv .rl tr{cursor:pointer}' +
    '.sv .rl tr.ok{background:#f6fbf7}.sv .rl tr.hold{background:#fffaf2}.sv .rl tr.sel{background:var(--pri-l);box-shadow:inset 3px 0 0 var(--pri)}.sv .rl .nm{font-weight:600}.sv .rl .s{font-size:11.5px;color:var(--sub)}' +
    '.sv .dt{border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;min-width:0;overflow:hidden}.sv .dn,.sv .da{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fafbfd;border-bottom:1px solid var(--line)}.sv .da{border-top:1px solid var(--line);border-bottom:none}' +
    '.sv .sp{flex:1}.sv .db{flex:1;overflow:auto;padding:10px 14px}.sv .kv{display:grid;grid-template-columns:120px 1fr;gap:3px 10px;font-size:13px;margin:8px 0}.sv .kv .k{color:var(--sub)}' +
    '.sv .pdf{min-height:380px;border:1px dashed var(--line);border-radius:8px;margin-top:8px;background:#fafbfd;display:flex;align-items:center;justify-content:center;color:var(--sub)}.sv .pdf iframe{width:100%;height:520px;border:0}' +
    '.sv button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 11px;cursor:pointer;font:inherit}.sv button.pri{background:var(--pri);border-color:var(--pri);color:#fff}.sv .chip.on{background:var(--pri);color:#fff;border-color:var(--pri)}' +
    '.sv input[type=search],.sv select{width:auto;max-width:100%;padding:4px 8px}.sv input[type=search]{width:220px}.sv .tb td,.sv .tb th{font-size:13px}' +
    '@media (max-width:900px){.sv .rv{grid-template-columns:1fr;height:auto}.sv .rl{max-height:40vh}}';
  function css() { if (document.getElementById('sv-css')) return; var s = document.createElement('style'); s.id = 'sv-css'; s.textContent = CSS; document.head.appendChild(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function yen(n) { return Math.round(Number(n) || 0).toLocaleString('ja-JP'); }
  function man(n) { return Math.round((Number(n) || 0) / 10000).toLocaleString('ja-JP') + '万'; }
  function diff(cur, prev) { if (!prev) return '<span style="color:#c3c9d6">—</span>'; var d = cur - prev, p = Math.round(d / prev * 100);
    return '<span class="' + (d > 0 ? 'd-up' : d < 0 ? 'd-down' : '') + '">' + (d > 0 ? '▲' : d < 0 ? '▼' : '±') + man(Math.abs(d)) + '（' + (p > 0 ? '+' : '') + p + '%）</span>'; }
  function keyOf(x, i) { return (x.no || x.payee) + '#' + i; }
  // 特記＝総務が付けた印・コメント。気づき＝自動（初めて・前月から大きく増えた・振込先が変わった・相殺・先行支払）
  function tags(x) { var t = [];
    if (x.flag) t.push(['特記', 't-flag']);
    if (x.amount >= RULE.newMin && !x.prev1 && !x.prev2) t.push(['初めて', 't-new']);
    else if (x.prev1 && x.amount - x.prev1 >= RULE.upMin && x.amount >= x.prev1 * RULE.upRate) t.push(['前月の' + (Math.round(x.amount / x.prev1 * 10) / 10) + '倍', 't-up']);
    if (x.bankChange) t.push(['振込先が変わった', 't-up']);
    if (/相殺/.test(x.method || '')) t.push(['相殺', 't-new']);
    if (x.prepaid) t.push(['先行支払済', 't-new']);
    if (x.smile && x.smile.held) t.push(['繰越保留', 't-new']);
    return t; }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function mount(el, o) {
    css();
    var snap = o.snap, rows = (snap.rows || []).map(function (x, i) { return Object.assign({ _k: keyOf(x, i) }, x); });
    var S = Object.assign({ checks: {}, comments: {} }, load(o.storeKey)), ui = { tab: 'rev', sel: null, only: '', sort: 'amount', q: '', pdf: {}, cache: {} };
    function persist() { save(o.storeKey, { checks: S.checks, comments: S.comments }); state(); }
    function state() { var ok = rows.filter(function (x) { return S.checks[x._k] === 'ok'; }).length, hold = rows.filter(function (x) { return S.checks[x._k] === 'hold'; }).length;
      if (o.onState) o.onState({ ok: ok, total: rows.length, hold: hold }); }
    function list() { var a = rows.slice();
      if (ui.q) a = a.filter(function (x) { return (x.payee + ' ' + (x.note || '')).indexOf(ui.q) >= 0; });
      if (ui.only === 'flag') a = a.filter(function (x) { return tags(x).length; });
      if (ui.only === 'unck') a = a.filter(function (x) { return S.checks[x._k] !== 'ok'; });
      if (ui.only === 'hold') a = a.filter(function (x) { return S.checks[x._k] === 'hold'; });
      if (ui.sort === 'amount') a.sort(function (x, y) { return y.amount - x.amount; });
      else if (ui.sort === 'diff') a.sort(function (x, y) { return (y.amount - (y.prev1 || 0)) - (x.amount - (x.prev1 || 0)); });
      return a; }
    function render() {
      var ok = rows.filter(function (x) { return S.checks[x._k] === 'ok'; }).length;
      el.innerHTML = '<div class="sv"><div class="tabs"><button data-t="sum" class="' + (ui.tab === 'sum' ? 'on' : '') + '">📊 サマリー</button><button data-t="rev" class="' + (ui.tab === 'rev' ? 'on' : '') + '">📄 明細（確認 ' + ok + '／' + rows.length + '）</button></div><div class="pane"></div></div>';
      var pane = el.querySelector('.pane');
      if (ui.tab === 'sum') summary(pane); else review(pane);
      el.querySelectorAll('[data-t]').forEach(function (b) { b.onclick = function () { ui.tab = b.dataset.t; render(); }; });
    }
    function summary(pane) {
      var b = snap.batch || {}, flagged = rows.filter(function (x) { return tags(x).length; }).sort(function (x, y) { return y.amount - x.amount; });
      var bm = snap.byMethod || {};
      var due = {}; rows.forEach(function (x) { if (/でんさい/.test(x.method || '') && x.due) due[x.due] = (due[x.due] || 0) + x.amount; });
      pane.innerHTML = '<div class="top">' +
        '<div class="box"><h4>支払総額（' + esc(b.ym) + ' ' + esc(b.round) + '払い・' + esc(b.dept) + '）</h4><div class="big">' + yen(snap.total) + '<small> 円・' + rows.length + '件</small></div>' +
          '<div style="font-size:13px;color:var(--sub);margin-top:4px">前月の同じ回 ' + (snap.prevTotal ? yen(snap.prevTotal) : '—') + '　' + diff(snap.total, snap.prevTotal) + '</div>' +
          '<div style="font-size:12px;color:var(--sub);margin-top:4px">総務が ' + esc(b.by || '') + ' に回した内容（' + esc(String(b.at || '').slice(0, 10)) + '）</div></div>' +
        '<div class="box"><h4>支払方法の内訳</h4><table>' + Object.keys(bm).map(function (m) { return '<tr><td>' + esc(m) + '</td><td class="n">' + yen(bm[m]) + '</td></tr>'; }).join('') + '</table>' +
          (Object.keys(due).length ? '<h4 style="margin-top:10px">でんさいの期日</h4><table>' + Object.keys(due).sort().map(function (d) { return '<tr><td>' + esc(d) + '</td><td class="n">' + yen(due[d]) + '</td></tr>'; }).join('') + '</table>' : '') + '</div>' +
        '<div class="box"><h4>特記・気づき（' + flagged.length + '件）</h4><div class="flags">' + (flagged.length ? flagged.map(function (x) { return '<div class="flag" data-k="' + esc(x._k) + '"><span class="why">' + tags(x).map(function (t) { return esc(t[0]); }).join('・') + '</span><span class="who">' + esc(x.payee) + '</span><b>' + yen(x.amount) + '</b></div>'; }).join('') : '<div style="color:var(--sub)">ありません</div>') + '</div></div></div>';
      pane.querySelectorAll('.flag').forEach(function (f) { f.onclick = function () { ui.sel = f.dataset.k; ui.tab = 'rev'; ui.only = ''; render(); }; });
    }
    function review(pane) {
      pane.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><input type="search" class="q" placeholder="支払先・備考で検索" value="' + esc(ui.q) + '" style="border:1px solid var(--line);border-radius:6px;padding:4px 8px">' +
        '<select class="fo">' + [['', 'すべて'], ['flag', '特記・気づきだけ'], ['unck', '未確認だけ'], ['hold', '保留だけ']].map(function (v) { return '<option value="' + v[0] + '"' + (ui.only === v[0] ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') + '</select>' +
        '<select class="fs">' + [['amount', '金額の大きい順'], ['diff', '前月からの増加が大きい順'], ['no', '総務が回した順']].map(function (v) { return '<option value="' + v[0] + '"' + (ui.sort === v[0] ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') + '</select><span class="cnt" style="font-size:12px;color:var(--sub);align-self:center"></span></div>' +
        '<div class="rv"><div class="rl"><table><tbody class="tb"></tbody></table></div><div class="dt"></div></div>';
      pane.querySelector('.q').oninput = function (e) { ui.q = e.target.value.trim(); rowsHtml(); detail(); };
      pane.querySelector('.fo').onchange = function (e) { ui.only = e.target.value; rowsHtml(); detail(); };
      pane.querySelector('.fs').onchange = function (e) { ui.sort = e.target.value; rowsHtml(); detail(); };
      rowsHtml(); detail();
    }
    function rowsHtml() {
      var a = list(), tb = el.querySelector('.tb'); if (!tb) return;
      if (!a.some(function (x) { return x._k === ui.sel; })) ui.sel = a.length ? (a.filter(function (x) { return !S.checks[x._k]; })[0] || a[0])._k : null;
      el.querySelector('.cnt').textContent = a.length + '件　' + yen(a.reduce(function (s, x) { return s + x.amount; }, 0)) + '円　確認OK ' + a.filter(function (x) { return S.checks[x._k] === 'ok'; }).length + '／' + a.length;
      tb.innerHTML = a.map(function (x) { var c = S.checks[x._k];
        return '<tr class="' + (x._k === ui.sel ? 'sel ' : '') + (c || '') + '" data-k="' + esc(x._k) + '"><td style="width:24px;text-align:center">' + (c === 'ok' ? '<span style="color:var(--down)">✔</span>' : c === 'hold' ? '<span style="color:var(--warn)">⏸</span>' : '<span style="color:#c3c9d6">□</span>') + '</td>' +
          '<td><div class="nm">' + esc(x.payee) + (S.comments[x._k] ? ' 💬' : '') + '</div><div class="s">' + esc(x.genre || '') + '・' + esc(x.method || '') + tags(x).map(function (t) { return '<span class="tag ' + t[1] + '">' + esc(t[0]) + '</span>'; }).join('') + '</div></td>' +
          '<td class="n"><b>' + yen(x.amount) + '</b><div class="s">' + (x.prev1 ? diff(x.amount, x.prev1) : '') + '</div></td></tr>'; }).join('') || '<tr><td style="color:var(--sub);padding:12px">該当する明細はありません</td></tr>';
      tb.querySelectorAll('tr[data-k]').forEach(function (tr) { tr.onclick = function () { ui.sel = tr.dataset.k; rowsHtml(); detail(); }; });
      var s = tb.querySelector('tr.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
    }
    function detail() {
      var dt = el.querySelector('.dt'); if (!dt) return;
      var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }), x = a[i];
      if (!x) { dt.innerHTML = '<div style="padding:16px;color:var(--sub)">左の一覧から選んでください</div>'; return; }
      var c = S.checks[x._k], row = function (k, v) { return v == null || v === '' ? '' : '<div class="k">' + k + '</div><div>' + v + '</div>'; };
      var sm = x.smile || {};
      dt.innerHTML = '<div class="dn"><button class="p">◀ 前へ</button><span style="color:var(--sub)">' + (i + 1) + ' ／ ' + a.length + '</span><button class="n">次へ ▶</button><span class="sp"></span>' + (c ? '<span class="tag ' + (c === 'ok' ? 't-ok' : 't-new') + '">' + (c === 'ok' ? '✔ 確認OK' : '⏸ 保留') + '</span>' : '') + '</div>' +
        '<div class="db"><div style="display:flex;justify-content:space-between;gap:10px"><div><div style="font-size:12px;color:var(--sub)">' + esc(x.genre || '') + (x.no ? '・' + esc(x.no) : '') + '</div><h3 style="margin:2px 0 4px;font-size:18px">' + esc(x.payee) + '</h3><div>' + tags(x).map(function (t) { return '<span class="tag ' + t[1] + '" style="margin:0 4px 0 0">' + esc(t[0]) + '</span>'; }).join('') + '</div></div>' +
          '<div style="text-align:right"><div class="big" style="font-size:24px">' + yen(x.amount) + '<small> 円</small></div><div style="font-size:13px;color:var(--sub)">前月 ' + (x.prev1 ? yen(x.prev1) : '—') + '　' + (x.prev1 ? diff(x.amount, x.prev1) : '') + '</div></div></div>' +
        '<div class="kv">' + row('支払方法', esc(x.method)) + row('期日・支払日', esc(x.due || x.payDate)) + row('前々月', x.prev2 ? yen(x.prev2) + ' 円' : '') + row('振込手数料', x.fee ? yen(x.fee) + ' 円（先方負担）' : '') +
          row('SMILE の額', sm.incl != null ? '税込仕入額 ' + yen(sm.incl) + (sm.carry ? '／繰越 ' + yen(sm.carry) : '') + (sm.held ? '（保留 ' + yen(sm.held) + '・3月末に整理）' : '') : '') +
          row('振込先の変更', x.bankChange ? '<b style="color:var(--up)">' + esc(x.bankChange) + '</b>' : '') + row('備考', esc(x.note)) + '</div>' +
        (x.lines ? '<table><tr><th>内訳</th><th class="n">金額</th><th>備考</th></tr>' + x.lines.map(function (l) { return '<tr><td>' + esc(l.genre || '') + '</td><td class="n">' + yen(l.amount) + '</td><td>' + esc(l.note || '') + '</td></tr>'; }).join('') + '</table>' : '') +
        '<div style="margin-top:8px">' + (x.invoices || []).map(function (k, j) { return '<button class="chip' + (ui.pdf[x._k] === k ? ' on' : '') + '" data-pdf="' + esc(k) + '" style="margin:0 4px 4px 0">📄 請求書 ' + (j + 1) + '</button>'; }).join('') + '</div>' +
        '<div class="pdf">' + ((x.invoices || []).length ? '読み込み中...' : '請求書の添付はありません') + '</div>' +
        '<textarea class="cm" placeholder="この明細へのコメント（承認・差し戻しのコメントにまとめて送ります）" style="' + (S.comments[x._k] ? '' : 'display:none;') + 'width:100%;height:52px;border:1px solid var(--line);border-radius:6px;padding:6px;margin-top:8px">' + esc(S.comments[x._k] || '') + '</textarea></div>' +
        '<div class="da">' + (o.canAct ? '<button class="h">⏸ 保留</button><button class="c">💬 コメント</button><span class="sp"></span><span style="font-size:11.5px;color:var(--sub)">Enter：OK・次へ　←→：前・次　H：保留</span><button class="pri ok" style="font-size:15px;padding:7px 20px">✔ OK・次へ</button>'
          : '<span style="font-size:12px;color:var(--sub)">あなたの番になると「確認OK」を付けられます</span>') + '</div>';
      var q = function (s) { return dt.querySelector(s); };
      q('.p').onclick = function () { go(-1); }; q('.n').onclick = function () { go(1); };
      if (q('.ok')) { q('.ok').onclick = function () { mark('ok'); }; q('.h').onclick = function () { mark('hold'); }; q('.c').onclick = function () { q('.cm').style.display = ''; q('.cm').focus(); }; }
      q('.cm').oninput = function (e) { S.comments[x._k] = e.target.value; persist(); };
      dt.querySelectorAll('[data-pdf]').forEach(function (b) { b.onclick = function () { showPdf(x, b.dataset.pdf); }; });
      if ((x.invoices || []).length) showPdf(x, ui.pdf[x._k] || x.invoices[0]);
    }
    // 請求書は PDF か画像（スマホの写真など）。画像は幅に合わせる
    function docHtml(u, key) { return /\.(jpe?g|png|webp|heic|heif)$/i.test(String(key || '').split('?')[0]) ? '<div style="width:100%;max-height:520px;overflow:auto;text-align:center"><img src="' + u + '" alt="請求書の画像" style="max-width:100%;height:auto"></div>' : '<iframe src="' + u + '"></iframe>'; }
    function showPdf(x, key) {
      ui.pdf[x._k] = key; el.querySelectorAll('[data-pdf]').forEach(function (b) { b.classList.toggle('on', b.dataset.pdf === key); });
      var box = el.querySelector('.pdf'); if (!box) return;
      if (ui.cache[key]) { box.innerHTML = docHtml(ui.cache[key], key); return; }
      box.textContent = '読み込み中...';
      Promise.resolve(o.loadPdf ? o.loadPdf(key) : null).then(function (u) {
        if (u) ui.cache[key] = u; var b2 = el.querySelector('.pdf'); if (!b2 || ui.pdf[x._k] !== key || ui.sel !== x._k) return;
        b2.innerHTML = u ? docHtml(u, key) : '請求書を開けませんでした'; });
    }
    function go(d) { var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }), n = a[Math.min(a.length - 1, Math.max(0, i + d))]; if (n) { ui.sel = n._k; rowsHtml(); detail(); } }
    function mark(v) { if (!o.canAct) return; var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }); if (i < 0) return;
      S.checks[ui.sel] = v; persist();
      var nx = a.slice(i + 1).filter(function (x) { return !S.checks[x._k]; })[0] || a[i + 1]; if (nx) ui.sel = nx._k;
      render(); }
    el.addEventListener('keydown', function (e) {
      if (ui.tab !== 'rev' || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); mark('ok'); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); go(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
      else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); mark('hold'); } });
    el.tabIndex = 0;
    render(); state();
  }
  // 承認・差し戻しのコメントに足す文（保留と明細へのコメント）
  function comment(storeKey, snap) {
    var S = load(storeKey), out = [], rows = (snap && snap.rows) || [];
    rows.forEach(function (x, i) { var k = keyOf(x, i), c = (S.checks || {})[k], m = (S.comments || {})[k];
      if (c === 'hold' || m) out.push('・' + x.payee + ' ' + yen(x.amount) + '円' + (c === 'hold' ? '【保留】' : '') + (m ? '：' + m : '')); });
    return out.length ? '【明細】\n' + out.join('\n') : '';
  }
  root.SettleView = { mount: mount, comment: comment };
})(typeof window !== 'undefined' ? window : this);
