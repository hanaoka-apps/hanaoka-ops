/* 出荷チェック（EC売上・ふるさと納税の「出荷チェック」タブ）。
 * 受注を SMILE に起票した注文について、出荷伝票が切られたか・送り状番号が出たかを、専用機が毎時作る ship_index.json から見せる。
 * 引き当ては EcSales.shipOf（客先注番の数字で引く）。注文の詳細は、行を押すと受注チェックと同じドロワーが開く。
 * 出荷・送り状の細かい検索は、出荷・配送の検索（ship_search.html）へのリンクで見に行く。
 * 使い方：EcShipTab.render(ctx)（ctx は ec_sales_app.js の shipCtx）／EcShipTab.reset()（データを読み直す） */
(function (root) {
  'use strict';
  var S = { idx: null, lookup: null, loading: false, error: '', filter: 'wait', q: '', from: '', wired: false };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var STATES = ['confirm', 'exported', 'smile'];   // SMILE に受注が入っている注文（確認待ち・起票済み・SMILE取込済み）

  function ageText(iso) {
    if (!iso) return '';
    var h = (Date.now() - Date.parse(iso)) / 36e5;
    return h < 1 ? Math.max(1, Math.round(h * 60)) + '分前' : h < 48 ? '約' + Math.round(h) + '時間前' : '約' + Math.round(h / 24) + '日前';
  }
  function stamp(iso) { if (!iso) return ''; var d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  function load(ctx) {
    if (S.idx || S.loading) return;
    S.loading = true; S.error = '';
    ctx.loadJson(ctx.conf.files.shipIndex).then(function (idx) {
      S.idx = idx; S.lookup = ctx.EC.shipLookup(idx);
    }).catch(function (e) {
      console.warn('ship_index', e); S.error = '出荷のデータ（' + ctx.conf.files.shipIndex + '）を読めません：' + (e && e.message || e);
    }).then(function () { S.loading = false; ctx.rerender(); });
  }

  function rowsOf(ctx) {
    var EC = ctx.EC, out = [];
    ctx.slips().forEach(function (s) {
      if (STATES.indexOf(ctx.stateOf(s)) < 0 || s.orderDate < S.from) return;
      var q = S.q.trim().toLowerCase();
      var who = (s.order.ship.company || '') + ' ' + (s.order.ship.name || '');
      if (q && (s.name + ' ' + who).toLowerCase().indexOf(q) < 0) return;
      out.push({ s: s, r: ctx.rec(s), ship: EC.shipOf(S.lookup, s.id, s.cust) });
    });
    return out;
  }

  function render(ctx) {
    var box = ctx.box, cnt = ctx.cnt;
    if (!box) return;
    if (!S.from) { var d0 = new Date(); d0.setDate(d0.getDate() - 30); S.from = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0'); }
    if (ctx.visible) load(ctx);
    if (!S.wired) { wire(ctx); S.wired = true; }
    if (!S.lookup) {
      if (cnt) cnt.textContent = '0';
      if (ctx.visible) box.innerHTML = S.error ? '<div class="alert err">' + esc(S.error) + '</div><div class="muted">専用機が毎時作るファイルです。まだ作られていないか、権限がない可能性があります。</div>' : '<div class="empty">出荷のデータを読み込み中…</div>';
      return;
    }
    var rows = rowsOf(ctx), n = { wait: 0, done: 0 };
    rows.forEach(function (x) { n[x.ship.state === 'done' ? 'done' : 'wait']++; });
    if (cnt) cnt.textContent = n.wait;
    if (!ctx.visible) return;
    var list = rows.filter(function (x) { return S.filter === 'all' || (S.filter === 'done' ? x.ship.state === 'done' : x.ship.state !== 'done'); });
    list.sort(function (a, b) {
      return S.filter === 'done' ? (b.ship.shipDate || '').localeCompare(a.ship.shipDate || '') : (a.s.orderDate + a.s.order.createdTime).localeCompare(b.s.orderDate + b.s.order.createdTime);
    });
    var cr = S.lookup.carriers, newest = Object.keys(cr).map(function (k) { return (cr[k].name || k) + ' ' + stamp(cr[k].newest); }).join('／');
    var staleH = ctx.conf.shipStaleHours || 12, age = (Date.now() - Date.parse(S.lookup.generatedAt)) / 36e5;
    var tile = function (k, label, sub, c, kind) {
      return '<div class="ftile ' + kind + (S.filter === k ? ' active' : '') + '" data-sf="' + k + '" role="button" tabindex="0"><div class="ft-t">' + label + (S.filter === k ? '<span class="ft-on">表示中</span>' : '') + '</div><div class="ft-s">' + sub + '</div><div class="ft-c">' + c + '<small>件</small></div></div>';
    };
    var html = '<div class="muted" style="margin-bottom:8px">出荷のデータ：更新 ' + esc(stamp(S.lookup.generatedAt)) + '（' + esc(ageText(S.lookup.generatedAt)) + '）／運送会社のデータ：' + esc(newest) + '　<span style="font-size:11px">（専用機が日中は毎時作ります。右上の「↻ 更新」で読み直し）</span></div>' +
      (age >= staleH ? '<div class="alert warn" style="margin-bottom:8px">出荷のデータが古くなっています（' + esc(ageText(S.lookup.generatedAt)) + '）。専用機の毎時の出力が止まっていないか確認してください</div>' : '') +
      '<div class="flow" style="margin-bottom:10px">' + tile('wait', '出荷待ち', '出荷伝票なし・送り状番号待ち', n.wait, 'k-robot') + '<div class="farrow">→</div>' + tile('done', '送り状番号あり', '出荷済み', n.done, 'k-none') + '</div>' +
      '<div class="row" style="margin-bottom:8px;gap:10px"><span class="chip' + (S.filter === 'all' ? ' active' : '') + '" data-sf="all">すべて ' + (n.wait + n.done) + '件</span><div class="grow"></div>' +
      '<label class="muted">受注日 <input type="date" id="ship-from" value="' + esc(S.from) + '"> 以降</label><input type="text" id="ship-q" placeholder="注文番号・お客様で検索" size="22" value="' + esc(S.q) + '"></div>';
    var link = function (x) {
      var key = x.ship.slips.length ? x.ship.slips[0].no : String(x.s.id).replace(/\D/g, '');
      return '<a href="' + esc(ctx.conf.shipSearchUrl || 'ship_search.html') + '?q=' + encodeURIComponent(key) + '" target="_blank" rel="noopener">出荷検索で見る</a>';
    };
    html += list.length ? '<div style="overflow:auto"><table class="shiptbl"><thead><tr><th>受注日</th><th>注文</th><th>お客様</th><th>受注№</th><th>状態</th><th>出荷日</th><th>運送会社・送り状番号</th><th></th></tr></thead><tbody>' + list.map(function (x) {
      var sh = x.ship, st = sh.state === 'done' ? '<span class="tag ok">送り状番号あり</span>' : sh.state === 'noslip' ? '<span class="tag warn">出荷伝票あり・送り状待ち</span>' : '<span class="tag info">出荷伝票なし</span>';
      var slips = sh.slips.map(function (sl) { return '<div><span class="muted">' + esc(sl.carrier) + '</span> <b>' + esc(sl.fmt) + '</b></div>'; }).join('');
      var who = x.s.order.ship.company || x.s.order.ship.name || '';
      return '<tr data-row="' + esc(x.s.id) + '"><td>' + esc(x.s.orderDate.slice(5).replace('-', '/')) + '</td><td><b>' + esc(x.s.name) + '</b></td><td>' + esc(who) + '</td><td>' + esc((x.r && x.r.juchuNo) || sh.juchu[0] || '') + '</td><td>' + st + '</td><td>' + esc(sh.shipDate ? sh.shipDate.slice(5).replace('-', '/') : '') + (sh.shipNos.length ? '<div class="muted">出荷№ ' + esc(sh.shipNos.join('・')) + '</div>' : '') + '</td><td>' + (slips || '<span class="muted">—</span>') + '</td><td>' + link(x) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="empty">この条件の注文はありません</div>';
    box.innerHTML = html;
  }

  function wire(ctx) {
    var box = ctx.box;
    box.addEventListener('click', function (e) {
      var t = e.target.closest('[data-sf]'); if (!t) return;
      S.filter = t.dataset.sf; ctx.rerender();
    });
    box.addEventListener('change', function (e) { if (e.target.id === 'ship-from' && e.target.value) { S.from = e.target.value; ctx.rerender(); } });
    box.addEventListener('input', function (e) { if (e.target.id === 'ship-q') { S.q = e.target.value; var pos = e.target.selectionStart; ctx.rerender(); var el = document.getElementById('ship-q'); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (x) { /* 位置は戻せなくてもよい */ } } } });
  }

  root.EcShipTab = { render: render, reset: function () { S.idx = null; S.lookup = null; S.error = ''; } };
})(window);
