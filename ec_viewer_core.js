/* EC受注の状況（営業向けの閲覧画面 ec_viewer.html）の計算部品。画面とは別にして、node でテストできるようにしてある。
 * 注文ごとに、Shopify の注文・SMILE の受注・出荷（送り状）のデータをひとつにまとめ、
 *   ① Shopify受注 → ② 受注伝票作成済（＝出荷待ち） → ③ 出荷済 → ④ Shopify登録済（＝完了）
 * のどこまで進んだかを決める。キャンセルは別枠。検索の言葉の分け方・一致の見方もここ。
 * データは読むだけ（書き込みなし）。EC売上アプリの計算部品（ec_sales_core.js の EcSales）と同じデータの読み方を使う。 */
(function (root) {
  'use strict';
  var V = {};

  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  // 検索・突き合わせ用の言葉にそろえる：全角→半角、大文字→小文字、カタカナ→ひらがな、空白をひとつに
  V.norm = function (s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKC'); } catch (e) { /* 古いブラウザは、そのまま */ }
    return s.toLowerCase().replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }).replace(/\s+/g, ' ').trim();
  };

  V.STAGES = [
    { k: 'shopify', n: '①', label: 'Shopify受注' },
    { k: 'wait', n: '②', label: '受注伝票作成済（出荷待ち）' },
    { k: 'shipped', n: '③', label: '出荷済' },
    { k: 'done', n: '④', label: 'Shopify登録済（完了）' }
  ];
  V.CANCELLED = { k: 'cancelled', n: '', label: 'キャンセル' };
  // 元の注文のデータの範囲（Shopify は直近55日）より前で、元の注文がない注文：SMILE・出荷の一部しか結べないので、流れの状況には数えない
  V.PAST = { k: 'past', n: '', label: '過去の注文' };
  // labels＝画面ごとの言い換え（{ shopify, wait, shipped, done, cancelled }。ふるさと納税は「サイネックス…」）。なければ、既定の名前
  V.stageLabel = function (k, labels) {
    if (labels && labels[k]) return labels[k];
    var s = V.STAGES.filter(function (x) { return x.k === k; })[0]; return s ? s.label : (k === 'cancelled' ? V.CANCELLED.label : k === 'past' ? V.PAST.label : '');
  };

  V.todayJst = function (now) { return new Date((now || new Date()).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); };
  V.ymd = function (s) {   // 20261107 → 2026-11-07（すでに 2026-11-07 ならそのまま）
    var d = String(s == null ? '' : s).trim();
    if (/^\d{8}$/.test(d)) return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6);
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';
  };
  V.md = function (s) {   // 2026-11-07 → 11/7(土)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return '';
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) + '(' + '日月火水木金土'.charAt(d.getUTCDay()) + ')';
  };

  /* 注文ごとの状況。r＝{ shopify:{has,fulfillment,cancelledAt,financial}, smile:{has}, ship:{ships,slips} }
   * キャンセル（Shopify でキャンセル・無効）→ cancelled、Shopify が発送済み → done（完了）、送り状番号あり → shipped、
   * SMILE に受注伝票あり、または出荷伝票あり（送り状番号はまだ）→ wait（受注伝票作成済＝出荷待ち）、それ以外（Shopify の注文だけ）→ shopify。
   * 元の注文がなく、注文日が pastDays（Shopify は55日）より前の注文は past（過去の注文）。出荷伝票があっても送り状番号が残っていない（運送会社のデータは最近の分だけ）ので、
   * 「出荷待ち」に数えると、済んだ注文が大量に混ざってしまう。元の注文がなく、日付が新しいものは、これまでどおり出荷済までで止まる（done にはならない） */
  V.stageOf = function (r) {
    var sh = r.shopify;
    if (sh && sh.has && (sh.cancelledAt || sh.financial === 'voided')) return 'cancelled';
    if (r.past) return 'past';
    if (sh && sh.has && sh.fulfillment === 'fulfilled') return 'done';
    if (r.ship && r.ship.slips && r.ship.slips.length) return 'shipped';
    if ((r.ship && r.ship.ships && r.ship.ships.length) || (r.smile && r.smile.has)) return 'wait';
    return 'shopify';
  };
  // 出荷予定日を過ぎたのに、まだ出荷されていない（②受注伝票作成済（出荷待ち））
  // Shopify の注文がない古い注文は、出荷のデータも残っていないことがあるので、90日より前のものは遅れにしない
  V.isLate = function (r, today) {
    if (r.stage !== 'wait' || !r.smile.shipPlan || r.smile.shipPlan >= today) return false;
    if (r.noShopify) { var d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - 90 * 86400000).toISOString().slice(0, 10); if (!r.smile.orderDate || r.smile.orderDate < d) return false; }
    return true;
  };

  function uniq(a) { var o = {}, out = []; a.forEach(function (x) { if (x !== '' && x != null && !o[x]) { o[x] = 1; out.push(x); } }); return out; }

  // SMILE の受注（客先注番＝Shopify の注文番号）。rows＝ec_smile_index.json の orders を { 列名: 値 } にしたもの
  V.groupSmile = function (rows, custCodes) {
    var map = {};
    (rows || []).forEach(function (r) {
      var cust = String(r['得意先コード'] || '').trim();
      if (custCodes && custCodes.length && custCodes.indexOf(cust) < 0) return;
      var po = String(r['客先注番'] || '').trim();
      if (!po || /^test/i.test(po)) return;   // テスト送信の伝票は除く
      var id = digits(po); if (!id) return;
      var g = map[id] = map[id] || { has: true, cust: cust, juchuNos: [], dates: [], noukis: [], plans: [], dests: [], lines: [] };
      g.juchuNos.push(String(r['受注№'] || '').trim());
      g.dates.push(V.ymd(r['受注日付'])); g.noukis.push(V.ymd(r['納期'])); g.plans.push(V.ymd(r['出荷予定日']));
      g.dests.push(String(r['納品先名'] || '').trim());
      g.lines.push({ code: String(r['品目コード'] || '').trim(), name: String(r['品目名'] || '').trim(), qty: Number(r['数量']) || 0 });
    });
    Object.keys(map).forEach(function (id) {
      var g = map[id], ds = g.dates.filter(Boolean).sort(), ns = g.noukis.filter(Boolean).sort(), ps = g.plans.filter(Boolean).sort();
      map[id] = { has: true, cust: g.cust, juchuNos: uniq(g.juchuNos), orderDate: ds[0] || '', nouki: ns[ns.length - 1] || '', shipPlan: ps[ps.length - 1] || '', dest: uniq(g.dests)[0] || '', lines: g.lines };
    });
    return map;
  };

  // 出荷（送り状）。lookup＝EcSales.shipLookup の結果。注文番号で引き、同じ得意先のものだけにする
  V.shipFor = function (lookup, id, custCodes) {
    var ships = ((lookup && lookup.byPo && lookup.byPo[id]) || []).filter(function (sh) { return !sh.cust || !custCodes || !custCodes.length || custCodes.indexOf(sh.cust) >= 0; });
    var slips = [], seen = {};
    ships.forEach(function (sh) {
      (sh.slips || []).forEach(function (sl) {
        var key = sl.c + '|' + sl.no; if (seen[key]) return; seen[key] = 1;
        var car = (lookup.carriers && lookup.carriers[sl.c]) || {};
        var fmt = sl.c === 'seino' && digits(sl.no).length === 10 ? digits(sl.no).slice(0, 3) + '-' + digits(sl.no).slice(3, 6) + '-' + digits(sl.no).slice(6) : String(sl.no == null ? '' : sl.no);
        slips.push({ c: sl.c, carrier: car.name || sl.c, no: sl.no, fmt: fmt, date: sl.date || '' });
      });
    });
    var dates = ships.map(function (sh) { return sh.date; }).filter(Boolean).sort();
    return { ships: ships, slips: slips, shipDate: dates[0] || '', shipNos: uniq(ships.map(function (sh) { return sh.no; })), juchu: uniq(ships.reduce(function (a, sh) { return a.concat(sh.juchu || []); }, [])) };
  };

  function shopifyInfo(o) {
    var a = o.ship || {}, b = o.bill || {};
    return {
      has: true, createdAt: o.createdAt || '', createdTime: o.createdTime || '', financial: o.financial || '', fulfillment: o.fulfillment || '', cancelledAt: o.cancelledAt || '',
      total: o.total || 0, refunded: o.refunded || 0, email: o.email || '', phone: a.phone || o.phone || '', shipName: a.name || '', shipCompany: a.company || '',
      zip: a.zip || '', address: [a.province, a.city, a.addr1, a.addr2].filter(Boolean).join(' '), billName: b.name || '', tags: String(o.tags || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
      lines: (o.lines || []).map(function (l) { return { name: l.name, sku: l.sku, qty: l.qty }; }), notes: o.notes || '',
      extra: o.detailExtra || [],     // 画面ごとの追加の項目 [[見出し, 値], …]（詳細に出す・検索の対象）
      search: o.searchExtra || []     // 検索だけに使う言葉（番号など）
    };
  }

  /* 注文のひとまとめを作る。opts＝{ shopifyOrders（EcSales.groupShopifyOrders の結果。なければ null）, smileRows, shipLookup, custCodes, today }
   * 戻り値：新しい順の配列。1件＝{ id, name, stage, shopify, smile, ship, late, noShopify, sortKey, text, flat, nums } */
  V.build = function (opts) {
    opts = opts || {};
    var today = opts.today || V.todayJst(), custCodes = opts.custCodes || [];
    var smile = V.groupSmile(opts.smileRows, custCodes), byId = {}, ids = [];
    var pastDays = opts.pastDays == null ? 55 : opts.pastDays;
    var pastFrom = pastDays > 0 ? new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - pastDays * 86400000).toISOString().slice(0, 10) : '';
    (opts.shopifyOrders || []).forEach(function (o) { var id = digits(o.id); if (!id || byId[id]) return; byId[id] = shopifyInfo(o); ids.push(id); });
    Object.keys(smile).forEach(function (id) { if (!byId[id]) ids.push(id); });
    var out = ids.map(function (id) {
      var sh = byId[id] || { has: false, lines: [], tags: [], extra: [], search: [], fulfillment: '' }, sm = smile[id] || { has: false, juchuNos: [], lines: [], shipPlan: '', orderDate: '', nouki: '', dest: '' };
      var r = { id: id, name: '#' + id, shopify: sh, smile: sm, ship: V.shipFor(opts.shipLookup, id, custCodes), noShopify: !sh.has };
      r.past = !!pastFrom && r.noShopify && (sm.orderDate || '') < pastFrom;
      r.stage = V.stageOf(r);
      r.late = V.isLate(r, today);
      r.sortKey = (sh.createdAt ? sh.createdAt + ' ' + (sh.createdTime || '') : (sm.orderDate || '')) + ' ' + ('000000' + id).slice(-6);
      var T = [r.name, id, sh.email, sh.phone, sh.shipName, sh.shipCompany, sh.billName, sh.address, sh.zip, sh.tags.join(' '), sh.notes, V.stageLabel(r.stage, opts.labels), r.late ? '遅れ 予定日を過ぎ' : '',
        sm.juchuNos.join(' '), sm.dest, r.ship.shipNos.join(' ')];
      sh.lines.forEach(function (l) { T.push(l.name, l.sku); });
      sh.extra.forEach(function (e) { T.push(e[1]); });
      sh.search.forEach(function (x) { T.push(x); });
      sm.lines.forEach(function (l) { T.push(l.code, l.name); });
      r.ship.slips.forEach(function (s) { T.push(s.carrier, s.no, s.fmt); });
      r.text = V.norm(T.join(' '));
      r.flat = r.text.replace(/[-\s・]/g, '');
      r.nums = [id, digits(sh.phone), digits(sh.zip)].concat(sh.search.map(digits), sh.extra.map(function (e) { return digits(e[1]); }), sm.juchuNos.map(digits), r.ship.shipNos.map(digits), r.ship.slips.map(function (s) { return digits(s.no); })).filter(Boolean).join(' ');
      return r;
    });
    out.sort(function (a, b) { return a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0; });
    return out;
  };

  // 報告済みの印（共有の履歴リストの ShipReportedAt）がある注文を、「完了」にする。rows＝{ 注文番号: 項目 }。ふるさと納税用（Shopify の発送状況の代わり）
  V.applyReported = function (orders, rows) {
    var n = 0;
    (orders || []).forEach(function (o) { var r = rows && rows[digits(o.id)]; if (r && r.ShipReportedAt) { o.fulfillment = 'fulfilled'; n++; } });
    return n;
  };

  // 検索の言葉：空白（全角も）で区切る。すべてを含むものだけ。番号（数字とハイフンだけ）は、桁区切りのハイフンを無視して番号どうしで見る
  V.parseQuery = function (q) {
    return String(q == null ? '' : q).split(/[\s　]+/).map(function (w) { return w.replace(/^#/, ''); }).filter(Boolean).map(function (w) {
      var t = V.norm(w);
      return { t: t, d: /^[0-9][0-9\-]*$/.test(t) ? digits(t) : '' };
    });
  };
  V.matchQuery = function (r, tokens) {
    return (tokens || []).every(function (k) {
      if (k.d && r.nums.indexOf(k.d) >= 0) return true;
      return r.text.indexOf(k.t) >= 0 || r.flat.indexOf(k.t.replace(/[-\s・]/g, '')) >= 0;
    });
  };

  /* 絞り込み。f＝{ q（検索の言葉）, stages（状況のキーの配列。空ならすべて）, from, to（注文日・受注日 yyyy-mm-dd）, carrier（運送会社のキー）, tag（担当のタグ）, late（true で予定日超過だけ）, noShopify（true でShopify以外） } */
  V.filter = function (records, f) {
    f = f || {};
    var tokens = V.parseQuery(f.q), st = f.stages && f.stages.length ? f.stages : null;
    return records.filter(function (r) {
      if (st && st.indexOf(r.stage) < 0) return false;
      var d = r.shopify.createdAt || r.smile.orderDate || '';
      if (f.from && (!d || d < f.from)) return false;
      if (f.to && (!d || d > f.to)) return false;
      if (f.carrier && !r.ship.slips.some(function (s) { return s.c === f.carrier; })) return false;
      if (f.tag && r.shopify.tags.indexOf(f.tag) < 0) return false;
      if (f.late && !r.late) return false;
      return V.matchQuery(r, tokens);
    });
  };
  V.counts = function (records) {
    var c = { all: records.length, late: 0 };
    V.STAGES.concat([V.CANCELLED, V.PAST]).forEach(function (s) { c[s.k] = 0; });
    records.forEach(function (r) { c[r.stage]++; if (r.late) c.late++; });
    return c;
  };

  root.EcViewer = V;
  if (typeof module !== 'undefined' && module.exports) module.exports = V;
})(typeof window !== 'undefined' ? window : globalThis);
