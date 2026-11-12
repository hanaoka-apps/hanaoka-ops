/* EC売上の分析（ec_dashboard.html）の計算部品。画面とは別にして、node でテストできるようにしてある。
 * 月別・商品別・地域別・曜日別・時間帯別・新規とリピート・出荷までの日数・送料と値引きを集計し、
 * 数字から日本語のコメント（文）を作る。データは読むだけ（書き込みなし）。
 *
 * 「売上」の決め方（受注ベース）
 *   ・SMILE の受注（ec_smile_index.json の orders）の金額（税抜）を、受注日付の月で数える。送料（品目コード FR・運賃）も売上に含める
 *   ・注文＝客先注番（Shopify の注文番号）。客先注番が TEST で始まるもの・EC 以外の得意先は除く
 *   ・Shopify でキャンセルになった注文は、Shopify のデータがある範囲（直近55日）だけ除く
 *   ・SMILE の受注日付は、伝票を作った日です。Shopify に注文が入った日より、1〜数日あとになることがあります
 *     →曜日・時間帯・新規とリピート・値引きは、お客様が注文した日時が分かる Shopify の注文（直近55日分）から数える
 * 日付・曜日・時間帯は日本時間（Shopify の注文書き出しも日本時間）で数える。パソコンの地域には左右されない。 */
(function (root) {
  'use strict';
  var D = {};

  var WEEK = '日月火水木金土';
  D.WEEK = WEEK;
  D.FREIGHT_CODE = 'FR';   // SMILE の品目コード：運賃（お客様にいただく送料）
  D.TAX = 0.1;

  /* ============================================================ 日付・数字の小道具 */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function utc(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
  D.todayJst = function (now) { return new Date((now || new Date()).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); };
  D.ymd = function (s) {   // 20261107 → 2026-11-07（すでに 2026-11-07 ならそのまま）
    var d = String(s == null ? '' : s).trim();
    if (/^\d{8}$/.test(d)) return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6);
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';
  };
  D.addDays = function (s, n) { return iso(utc(s) + n * 86400000); };
  D.diffDays = function (a, b) { return Math.round((utc(b) - utc(a)) / 86400000); };   // b − a
  D.lastDay = function (ym) { return +iso(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).slice(8, 10); };
  D.addMonths = function (ym, n) {   // 2026-11 を n か月ずらす
    var t = (+ym.slice(0, 4)) * 12 + (+ym.slice(5, 7) - 1) + n;
    return Math.floor(t / 12) + '-' + pad(t % 12 + 1);
  };
  D.monthsBetween = function (from, to) { var out = []; for (var m = from; m <= to && out.length < 600; m = D.addMonths(m, 1)) out.push(m); return out; };
  D.weekdayOf = function (s) { return new Date(utc(s)).getUTCDay(); };
  function num(x) { var n = Number(String(x == null ? '' : x).replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function sum(a, f) { var t = 0; a.forEach(function (x) { t += f ? f(x) : x; }); return t; }
  function pct(a, b) { return b ? a / b * 100 : 0; }
  function r0(x) { return Math.round(x); }
  function norm(s) { s = String(s == null ? '' : s); try { s = s.normalize('NFKC'); } catch (e) { /* そのまま */ } return s.replace(/\s+/g, ' ').trim(); }
  D.norm = norm;

  D.yen = function (n) { return r0(n).toLocaleString('ja-JP') + '円'; };
  D.yenShort = function (n) {   // コメント用：1億以上は「1.2億円」、100万以上は「123万円」、1万以上は「5.4万円」
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e8) return s + (Math.round(a / 1e7) / 10) + '億円';
    if (a >= 1e6) return s + Math.round(a / 1e4).toLocaleString('ja-JP') + '万円';
    if (a >= 1e4) return s + (Math.round(a / 1e3) / 10) + '万円';
    return s + r0(a).toLocaleString('ja-JP') + '円';
  };
  D.monthLabel = function (ym) { return +ym.slice(5, 7) + '月'; };
  D.monthLabelY = function (ym) { return ym.slice(0, 4) + '年' + (+ym.slice(5, 7)) + '月'; };

  /* ============================================================ 都道府県・地方 */
  var REGIONS = [
    { k: '北海道', prefs: ['北海道'] },
    { k: '東北', prefs: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'] },
    { k: '関東', prefs: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'] },
    { k: '中部', prefs: ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'] },
    { k: '関西', prefs: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'] },
    { k: '中国', prefs: ['鳥取県', '島根県', '岡山県', '広島県', '山口県'] },
    { k: '四国', prefs: ['徳島県', '香川県', '愛媛県', '高知県'] },
    { k: '九州・沖縄', prefs: ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'] }
  ];
  D.REGIONS = REGIONS;
  var PREF_REGION = {}, PREFS = [];
  REGIONS.forEach(function (g) { g.prefs.forEach(function (p) { PREF_REGION[p] = g.k; PREFS.push(p); }); });
  D.UNKNOWN = '不明';
  // 住所の先頭から都道府県を取る（郵便番号が先頭についていても読める）
  D.prefOf = function (addr) {
    var s = norm(addr).replace(/^〒?\s*\d{3}-?\d{4}\s*/, '');
    for (var i = 0; i < PREFS.length; i++) if (s.indexOf(PREFS[i]) === 0) return PREFS[i];
    return '';
  };
  D.regionOf = function (pref) { return PREF_REGION[pref] || D.UNKNOWN; };

  /* ============================================================ 注文のまとめを作る */
  /* opts＝{ smileRows（ec_smile_index.json の orders を { 列名: 値 } にしたもの）, nouhinRows（同じく nouhin）, shopifyOrders（EcSales.groupShopifyOrders の結果）,
   *         shipLookup（EcSales.shipLookup の結果）, custCodes（EC の得意先コード）, today }
   * 戻り値＝{ orders（SMILE の注文）, shop（Shopify の注文・キャンセルを除く）, info } */
  D.build = function (opts) {
    opts = opts || {};
    var cust = opts.custCodes || [], nouhin = {}, shopById = {}, cancelled = {};
    (opts.nouhinRows || []).forEach(function (r) {
      var k = String(r['得意先コード'] || '').trim() + '|' + String(r['納品先コード'] || '').trim();
      var p = D.prefOf(r['住所１']); if (p && !nouhin[k]) nouhin[k] = p;
    });
    var shopAll = [];
    (opts.shopifyOrders || []).forEach(function (o) {
      var id = digits(o.id); if (!id || shopById[id]) return;
      shopById[id] = o;
      if (o.cancelledAt || o.financial === 'voided') { cancelled[id] = true; return; }
      shopAll.push(o);
    });

    var map = {}, ids = [];
    (opts.smileRows || []).forEach(function (r) {
      var c = String(r['得意先コード'] || '').trim();
      if (cust.length && cust.indexOf(c) < 0) return;
      var po = String(r['客先注番'] || '').trim();
      if (!po || /^test/i.test(po)) return;   // テスト送信は除く
      var id = digits(po); if (!id) return;
      var g = map[id];
      if (!g) { g = map[id] = { id: id, cust: c, dates: [], dest: '', lines: {} }; ids.push(id); }
      var d = D.ymd(r['受注日付']); if (d) g.dates.push(d);
      if (!g.dest) g.dest = String(r['納品先コード'] || '').trim();
      var code = String(r['品目コード'] || '').trim(), key = code || String(r['品目名'] || '').trim();
      var l = g.lines[key] = g.lines[key] || { code: code, names: {}, qty: 0, amt: 0 };
      var nm = norm(r['品目名']); if (nm) l.names[nm] = (l.names[nm] || 0) + 1;
      l.qty += num(r['数量']); l.amt += num(r['金額']);
    });

    var cancelledOut = 0, notInShopify = 0, ships = opts.shipLookup;
    var orders = [];
    ids.forEach(function (id) {
      var g = map[id];
      if (cancelled[id]) { cancelledOut++; return; }
      var ds = g.dates.slice().sort(), date = ds[0] || '';
      if (!date) return;
      var sh = shopById[id], goods = 0, freight = 0, qty = 0, lines = [];
      Object.keys(g.lines).forEach(function (k) {
        var l = g.lines[k];
        if (l.code === D.FREIGHT_CODE) { freight += l.amt; return; }
        goods += l.amt; qty += l.qty;
        var best = '', n = 0; Object.keys(l.names).forEach(function (x) { if (l.names[x] > n) { n = l.names[x]; best = x; } });
        lines.push({ code: l.code || k, name: best || l.code, qty: l.qty, amt: l.amt });
      });
      var pref = nouhin[g.cust + '|' + g.dest] || (sh && sh.ship ? D.prefOf(sh.ship.province) : '');
      // 出荷日：出荷データの、いちばん早い出荷日（同じ得意先のものだけ）
      var shipDate = '';
      if (ships && ships.byPo && ships.byPo[id]) {
        var ds2 = ships.byPo[id].filter(function (s) { return !s.cust || s.cust === g.cust; }).map(function (s) { return String(s.date || '').slice(0, 10); }).filter(Boolean).sort();
        shipDate = ds2[0] || '';
      }
      // 出荷までの日数の起点：お客様が注文した日（Shopify の注文があれば）。なければ SMILE の受注日付
      var from = sh && sh.createdAt ? sh.createdAt : date;
      if (!sh) notInShopify++;
      orders.push({
        id: id, date: date, month: date.slice(0, 7), amount: goods + freight, goods: goods, freight: freight, qty: qty, lines: lines,
        pref: pref, region: pref ? D.regionOf(pref) : D.UNKNOWN, shipDate: shipDate, startDate: from,
        shipDays: shipDate ? Math.max(0, D.diffDays(from, shipDate)) : null
      });
    });
    orders.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); });

    // Shopify の注文（キャンセルを除く）：注文した日時から数える。同じメールが前にも注文していれば「リピート」
    var shop = shopAll.map(function (o) {
      var total = num(o.total), tax = num(o.taxes);
      return {
        id: digits(o.id), date: o.createdAt || '', time: o.createdTime || '', hour: o.createdTime ? +String(o.createdTime).slice(0, 2) : -1,
        email: String(o.email || '').trim().toLowerCase(), amount: Math.max(0, total - tax), shipping: num(o.shipping), discount: num(o.discountAmount),
        code: String(o.discountCode || '').trim(), repeat: false
      };
    }).filter(function (o) { return o.date; });
    shop.sort(function (a, b) { var x = a.date + ' ' + a.time, y = b.date + ' ' + b.time; return x < y ? -1 : x > y ? 1 : 0; });
    var seen = {};
    shop.forEach(function (o) { if (!o.email) { o.unknownMail = true; return; } if (seen[o.email]) o.repeat = true; seen[o.email] = 1; });

    var shopIds = {}; orders.forEach(function (o) { shopIds[o.id] = 1; });
    var waiting = shop.filter(function (o) { return !shopIds[o.id]; }).length;   // Shopify にあって、まだ SMILE に伝票がない注文
    var sd = shop.map(function (o) { return o.date; }).sort();
    return { orders: orders, shop: shop, info: {
      cancelledOut: cancelledOut, shopCancelled: Object.keys(cancelled).length, notInShopify: notInShopify, waiting: waiting,
      shopFrom: sd[0] || '', shopTo: sd[sd.length - 1] || '', firstMonth: orders.length ? orders[0].month : '', lastMonth: orders.length ? orders[orders.length - 1].month : ''
    } };
  };

  /* ============================================================ 範囲 */
  // 範囲の型：{ from: '2026-08', to: '2026-10' }（月）。いまの月まで。
  D.preset = function (key, today, firstMonth) {
    var cur = today.slice(0, 7), y = today.slice(0, 4);
    if (key === 'thisMonth') return { from: cur, to: cur };
    if (key === '3m') return { from: D.addMonths(cur, -2), to: cur };
    if (key === '6m') return { from: D.addMonths(cur, -5), to: cur };
    if (key === 'year') return { from: y + '-01', to: cur };
    if (key === 'lastYear') return { from: (+y - 1) + '-01', to: (+y - 1) + '-12' };
    if (key === 'all') return { from: firstMonth && firstMonth < cur ? firstMonth : cur, to: cur };
    return { from: D.addMonths(cur, -2), to: cur };
  };
  /* 数える期間（日）と、比べる前の期間。いまの月が途中なら、前の期間も同じ日数までにそろえる
   * 戻り値＝{ cur:{start,end}, prev:{start,end}, n（月の数）, partial（途中の月を含む）, labels:{cur,prev} } */
  D.period = function (range, today) {
    var from = range.from, to = range.to; if (from > to) { var t = from; from = to; to = t; }
    var n = D.monthsBetween(from, to).length, start = from + '-01', fullEnd = to + '-' + pad(D.lastDay(to)), end = fullEnd, partial = false;
    if (today >= start && today < fullEnd) { end = today; partial = true; }
    if (today < start) end = start;   // 先の月を選んだ場合
    var pFrom = D.addMonths(from, -n), pStart = pFrom + '-01', pEnd;
    if (partial) { var pm = D.addMonths(to, -n), pd = Math.min(+end.slice(8, 10), D.lastDay(pm)); pEnd = pm + '-' + pad(pd); }
    else pEnd = D.addMonths(to, -n) + '-' + pad(D.lastDay(D.addMonths(to, -n)));
    var curM = today.slice(0, 7), labels;
    if (n === 1) {
      labels = (to === curM) ? { cur: '今月', prev: '先月' } : { cur: D.monthLabel(to), prev: D.monthLabel(D.addMonths(to, -1)) };
    } else labels = { cur: 'この期間', prev: '前の期間' };
    return { cur: { start: start, end: end }, prev: { start: pStart, end: pEnd }, n: n, partial: partial, labels: labels, from: from, to: to };
  };
  function within(p, d) { return d >= p.start && d <= p.end; }
  D.pick = function (orders, p) { return orders.filter(function (o) { return within(p, o.date); }); };
  D.pickShop = function (shop, p) { return shop.filter(function (o) { return within(p, o.date); }); };

  /* ============================================================ 集計 */
  D.summary = function (orders) {
    var n = orders.length, sales = sum(orders, function (o) { return o.amount; }), qty = sum(orders, function (o) { return o.qty; });
    return { count: n, sales: sales, goods: sum(orders, function (o) { return o.goods; }), freight: sum(orders, function (o) { return o.freight; }), qty: qty,
      avg: n ? sales / n : 0, avgQty: n ? qty / n : 0 };
  };
  // 月別（月の数だけ、0 の月も入れる）
  D.byMonth = function (orders, from, to) {
    var m = {}; D.monthsBetween(from, to).forEach(function (k) { m[k] = []; });
    orders.forEach(function (o) { if (m[o.month]) m[o.month].push(o); });
    return Object.keys(m).sort().map(function (k) { var s = D.summary(m[k]); s.month = k; return s; });
  };
  // 商品別（送料を除く）。台数・売上・その商品を含む注文数
  D.byProduct = function (orders) {
    var m = {}, total = 0;
    orders.forEach(function (o) {
      var seen = {};
      o.lines.forEach(function (l) {
        var x = m[l.code] = m[l.code] || { code: l.code, name: l.name, qty: 0, sales: 0, orders: 0, names: {} };
        x.qty += l.qty; x.sales += l.amt; total += l.amt;
        x.names[l.name] = (x.names[l.name] || 0) + 1;
        if (!seen[l.code]) { seen[l.code] = 1; x.orders++; }
      });
    });
    var list = Object.keys(m).map(function (k) {
      var x = m[k], best = x.name, n = 0; Object.keys(x.names).forEach(function (nm) { if (x.names[nm] > n) { n = x.names[nm]; best = nm; } });
      return { code: x.code, name: best, qty: x.qty, sales: x.sales, orders: x.orders, share: pct(x.sales, total) };
    });
    list.sort(function (a, b) { return b.sales - a.sales; });
    return list;
  };
  // 商品ごとの前の期間との差（売上の差の大きい順）
  D.productDelta = function (cur, prev) {
    var a = {}, b = {};
    D.byProduct(cur).forEach(function (x) { a[x.code] = x; });
    D.byProduct(prev).forEach(function (x) { b[x.code] = x; });
    var out = [];
    Object.keys(a).concat(Object.keys(b).filter(function (k) { return !a[k]; })).forEach(function (k) {
      var x = a[k] || { qty: 0, sales: 0 }, y = b[k] || { qty: 0, sales: 0 }, nm = (a[k] || b[k]).name;
      out.push({ code: k, name: nm, qty: x.qty, prevQty: y.qty, sales: x.sales, prevSales: y.sales, dSales: x.sales - y.sales, dQty: x.qty - y.qty });
    });
    out.sort(function (p, q) { return Math.abs(q.dSales) - Math.abs(p.dSales); });
    return out;
  };
  // 地域別・都道府県別（件数・売上）
  D.byRegion = function (orders) {
    var rg = {}, pf = {}, total = orders.length, unknown = 0;
    REGIONS.forEach(function (g) { rg[g.k] = { name: g.k, count: 0, sales: 0 }; });
    orders.forEach(function (o) {
      if (!o.pref) { unknown++; return; }
      var r = rg[o.region]; r.count++; r.sales += o.amount;
      var p = pf[o.pref] = pf[o.pref] || { name: o.pref, region: o.region, count: 0, sales: 0 }; p.count++; p.sales += o.amount;
    });
    var known = total - unknown;
    function fin(m) { return Object.keys(m).map(function (k) { var x = m[k]; x.share = pct(x.count, known); return x; }).filter(function (x) { return x.count > 0; }).sort(function (a, b) { return b.count - a.count || b.sales - a.sales; }); }
    return { regions: fin(rg), prefs: fin(pf), unknown: unknown, known: known };
  };
  // 曜日別（Shopify の注文した日）。日曜=0 … 土曜=6。月曜はじまりの順で返す
  D.byWeekday = function (shop) {
    var a = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return { wd: i, name: WEEK.charAt(i), count: 0, sales: 0 }; });
    shop.forEach(function (o) { var x = a[D.weekdayOf(o.date)]; x.count++; x.sales += o.amount; });
    var total = shop.length; a.forEach(function (x) { x.share = pct(x.count, total); });
    return [1, 2, 3, 4, 5, 6, 0].map(function (i) { return a[i]; });
  };
  // 時間帯別（0〜23時）
  D.byHour = function (shop) {
    var a = []; for (var h = 0; h < 24; h++) a.push({ hour: h, count: 0, sales: 0 });
    var total = 0;
    shop.forEach(function (o) { if (o.hour >= 0 && o.hour < 24) { a[o.hour].count++; a[o.hour].sales += o.amount; total++; } });
    a.forEach(function (x) { x.share = pct(x.count, total); });
    return a;
  };
  D.HOUR_BANDS = [{ k: '深夜', from: 0, to: 4, label: '深夜（0〜4時）' }, { k: '朝', from: 5, to: 11, label: '朝（5〜11時）' }, { k: '昼', from: 12, to: 17, label: '昼（12〜17時）' }, { k: '夜', from: 18, to: 23, label: '夜（18〜23時）' }];
  D.hourBands = function (hours) {
    var total = sum(hours, function (x) { return x.count; });
    return D.HOUR_BANDS.map(function (b) {
      var c = sum(hours.filter(function (x) { return x.hour >= b.from && x.hour <= b.to; }), function (x) { return x.count; });
      return { k: b.k, label: b.label, count: c, share: pct(c, total) };
    });
  };
  // 新規とリピート（メールで見分ける。メールが空の注文は「不明」）
  D.byRepeat = function (shop) {
    var g = { 'new': { count: 0, sales: 0 }, repeat: { count: 0, sales: 0 }, unknown: { count: 0, sales: 0 } };
    shop.forEach(function (o) { var k = o.unknownMail ? 'unknown' : o.repeat ? 'repeat' : 'new'; g[k].count++; g[k].sales += o.amount; });
    var known = g['new'].count + g.repeat.count;
    ['new', 'repeat', 'unknown'].forEach(function (k) { g[k].avg = g[k].count ? g[k].sales / g[k].count : 0; g[k].share = pct(g[k].count, known); });
    g.known = known; return g;
  };
  // 出荷までの日数（0日・1日・2日・3日・4〜7日・8日以上）
  D.SHIP_BUCKETS = [{ k: '0', label: '当日', from: 0, to: 0 }, { k: '1', label: '1日', from: 1, to: 1 }, { k: '2', label: '2日', from: 2, to: 2 }, { k: '3', label: '3日', from: 3, to: 3 }, { k: '4-7', label: '4〜7日', from: 4, to: 7 }, { k: '8+', label: '8日以上', from: 8, to: 9999 }];
  D.byShipDays = function (orders) {
    var shipped = orders.filter(function (o) { return o.shipDays != null; }), days = shipped.map(function (o) { return o.shipDays; }).sort(function (a, b) { return a - b; });
    var total = shipped.length;
    var buckets = D.SHIP_BUCKETS.map(function (b) {
      var c = shipped.filter(function (o) { return o.shipDays >= b.from && o.shipDays <= b.to; }).length;
      return { k: b.k, label: b.label, count: c, share: pct(c, total) };
    });
    var mid = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : 0;
    return { buckets: buckets, shipped: total, notShipped: orders.length - total, avg: total ? sum(days) / total : 0, median: mid, max: days.length ? days[days.length - 1] : 0,
      within: function (n) { return days.filter(function (d) { return d <= n; }).length; } };
  };
  // 送料と値引き
  D.freightInfo = function (orders, shop) {
    var charged = orders.filter(function (o) { return o.freight > 0; }), fr = sum(orders, function (o) { return o.freight; }), sales = sum(orders, function (o) { return o.amount; });
    var codes = {}, disc = shop.filter(function (o) { return o.discount > 0 || o.code; });
    disc.forEach(function (o) { var k = o.code || '（コードなし）'; var c = codes[k] = codes[k] || { code: k, count: 0, amount: 0 }; c.count++; c.amount += o.discount; });
    return { freight: fr, share: pct(fr, sales), charged: charged.length, free: orders.length - charged.length, avgCharged: charged.length ? fr / charged.length : 0,
      discountOrders: disc.length, discountTotal: sum(disc, function (o) { return o.discount; }), shopCount: shop.length, codes: Object.keys(codes).map(function (k) { return codes[k]; }).sort(function (a, b) { return b.count - a.count; }) };
  };

  /* ============================================================ コメント（数字から日本語の文を作る） */
  function chg(cur, prev) {   // 増減の言い方：{ pct（整数）, word（増えて／減って）, flat }
    if (!prev) return null;
    var p = (cur - prev) / prev * 100, a = Math.abs(p);
    return { pct: Math.round(a), up: p > 0, flat: a < 1 };
  }
  D.chg = chg;
  function pc(x) { return (Math.round(x * 10) / 10) + '%'; }   // 小数1けた（1% 未満の割合を見せたいとき）
  function pcInt(x) { return Math.round(x) + '%'; }

  // 売上の前の期間との比べ方。cur・prev＝D.summary の結果、deltas＝D.productDelta の結果、p＝D.period の結果
  D.commentSales = function (cur, prev, deltas, p) {
    var L = p.labels, out = [];
    if (!cur.count && !prev.count) return ['この期間は、注文がありません。'];
    if (!prev.count) return [L.cur + 'の売上は ' + D.yenShort(cur.sales) + '（' + cur.count + '件）です。' + L.prev + 'は注文がないため、比べられません。'];
    var c = chg(cur.sales, prev.sales), up = c.up;
    var tail = p.partial ? '（' + L.prev + 'の同じ日数までと比べています）' : '';
    if (c.flat) out.push(L.cur + 'の売上は、' + L.prev + 'とほぼ同じです（' + D.yenShort(prev.sales) + ' → ' + D.yenShort(cur.sales) + '）。' + tail);
    else out.push(L.cur + 'の売上は' + L.prev + 'より ' + c.pct + '% ' + (up ? '増えています' : '減っています') + '（' + D.yenShort(prev.sales) + ' → ' + D.yenShort(cur.sales) + '）。' + tail);
    // 主な理由：売上の差がいちばん大きい商品（全体の増減と同じ向きのもの）
    var total = cur.goods - prev.goods;
    if (!c.flat && c.pct >= 3 && deltas && deltas.length) {
      var top = deltas.filter(function (d) { return up ? d.dSales > 0 : d.dSales < 0; })[0];
      if (top && Math.abs(top.dSales) >= Math.abs(total) * 0.3 && Math.abs(top.dSales) > 0) {
        var qtyUp = top.dQty > 0, qtyDown = top.dQty < 0;
        if (top.prevQty === 0 && top.qty > 0) out.push('主な理由は、' + top.name + 'が新しく売れたことです（' + top.qty + '台・' + D.yenShort(top.sales) + '）。');
        else if (top.qty === 0 && top.prevQty > 0) out.push('主な理由は、' + top.name + 'が売れなくなったことです（' + top.prevQty + '台 → 0台）。');
        else if ((up && qtyUp) || (!up && qtyDown)) out.push('主な理由は、' + top.name + 'の台数が' + (up ? '増えた' : '減った') + 'ことです（' + top.prevQty + '台 → ' + top.qty + '台）。');
        else out.push('主な理由は、' + top.name + 'の売上が' + (up ? '増えた' : '減った') + 'ことです（' + D.yenShort(top.prevSales) + ' → ' + D.yenShort(top.sales) + '）。');
      }
    }
    // 件数と、1注文あたりの金額
    var cn = chg(cur.count, prev.count), ca = chg(cur.avg, prev.avg);
    var t = '注文は ' + prev.count + '件 → ' + cur.count + '件' + (cn && !cn.flat ? '（' + (cn.up ? '+' : '−') + cn.pct + '%）' : '') +
      '、1注文あたりの金額は ' + D.yenShort(prev.avg) + ' → ' + D.yenShort(cur.avg) + (ca && !ca.flat ? '（' + (ca.up ? '+' : '−') + ca.pct + '%）' : '') + ' です。';
    out.push(t);
    return out;
  };

  D.commentMonthly = function (series, p) {
    var out = [], full = series.filter(function (s) { return !(p.partial && s.month === p.to); });
    var has = series.filter(function (s) { return s.count > 0; });
    if (!has.length) return ['この期間は、注文がありません。'];
    if (has.length === 1 && series.length === 1) return ['この期間の売上は ' + D.yenShort(has[0].sales) + '（' + has[0].count + '件）です。'];
    var pool = full.filter(function (s) { return s.count > 0; }); if (pool.length < 2) pool = has;
    var hi = pool.slice().sort(function (a, b) { return b.sales - a.sales; })[0], lo = pool.slice().sort(function (a, b) { return a.sales - b.sales; })[0];
    out.push('売上がいちばん多かったのは ' + D.monthLabelY(hi.month) + '（' + D.yenShort(hi.sales) + '・' + hi.count + '件）です。' + (lo.month !== hi.month ? 'いちばん少なかったのは ' + D.monthLabelY(lo.month) + '（' + D.yenShort(lo.sales) + '）です。' : ''));
    if (full.length >= 3) {   // 終わった月の、直近3か月の流れ
      var a = full.slice(-3), up = a[2].sales > a[1].sales && a[1].sales > a[0].sales, dn = a[2].sales < a[1].sales && a[1].sales < a[0].sales;
      if (up) out.push('終わった月だけで見ると、直近の3か月は、売上が続けて増えています。');
      else if (dn) out.push('終わった月だけで見ると、直近の3か月は、売上が続けて減っています。');
    }
    if (p.partial) out.push(D.monthLabelY(p.to) + 'は途中（' + (+p.cur.end.slice(8, 10)) + '日まで）なので、まだ少なく見えます。');
    return out;
  };

  D.commentProducts = function (list) {
    if (!list.length) return ['この期間は、商品の売上がありません。'];
    var out = [], a = list[0], b = list[1];
    out.push('売れ筋は ' + a.name + '（売上の ' + pcInt(a.share) + '・' + r0(a.qty) + '台）' + (b ? '、次が ' + b.name + '（' + pcInt(b.share) + '・' + r0(b.qty) + '台）' : '') + ' です。');
    if (list.length >= 4) { var t3 = sum(list.slice(0, 3), function (x) { return x.share; }); out.push('上位3つで、商品の売上の ' + pcInt(t3) + ' を占めています。'); }
    return out;
  };

  D.commentRegion = function (g) {
    if (!g.known) return ['この期間は、届け先が分かる注文がありません。'];
    var out = [], r = g.regions, a = r[0], b = r[1], p = g.prefs[0];
    out.push(a.name + 'の注文が ' + pcInt(a.share) + ' を占め' + (b ? '、次は ' + b.name + ' で ' + pcInt(b.share) + ' です' : 'ています') + '。');
    if (p) out.push('都道府県では ' + p.name + ' がいちばん多く（' + p.count + '件・' + pcInt(p.share) + '）、' + g.prefs.length + '都道府県から注文があります。');
    if (g.unknown) out.push('届け先の住所が分からない注文 ' + g.unknown + '件は、数えていません。');
    return out;
  };

  D.commentWeekday = function (days) {
    var n = sum(days, function (d) { return d.count; });
    if (!n) return ['この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [];
    if (n < 20) out.push('注文が ' + n + '件と少ないので、傾向は参考程度に見てください。');
    var s = days.slice().sort(function (a, b) { return b.count - a.count; }), top = s[0], sec = s[1];
    if (top.count === 0) return out;
    var two = pcInt(top.share + sec.share);
    out.push('注文は' + top.name + '曜と' + sec.name + '曜に多い傾向です（全体の ' + two + '）。');
    var low = s[s.length - 1];
    if (low.count < top.count) out.push(low.name + '曜は少なめです（' + pcInt(low.share) + '）。');
    var we = days.filter(function (d) { return d.wd === 0 || d.wd === 6; }), wp = sum(we, function (d) { return d.share; });
    out.push('土日の注文は、全体の ' + pcInt(wp) + ' です。');
    return out;
  };

  D.commentHour = function (hours, bands) {
    var n = sum(hours, function (x) { return x.count; });
    if (!n) return ['この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [], top = hours.slice().sort(function (a, b) { return b.count - a.count; })[0], tb = bands.slice().sort(function (a, b) { return b.count - a.count; })[0];
    if (n < 20) out.push('注文が ' + n + '件と少ないので、傾向は参考程度に見てください。');
    out.push('注文は ' + top.hour + '時台がいちばん多く（' + top.count + '件・' + pcInt(top.share) + '）、時間の帯では ' + tb.label + ' が ' + pcInt(tb.share) + ' です。');
    return out;
  };

  D.commentRepeat = function (g) {
    if (!g.known) return ['この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [];
    out.push('リピート（同じメールアドレスで、前にも注文がある）のお客様の注文は ' + g.repeat.count + '件、全体の ' + pcInt(g.repeat.share) + ' です。');
    if (g['new'].count >= 3 && g.repeat.count >= 3) {
      var c = chg(g.repeat.avg, g['new'].avg);
      if (c && !c.flat) out.push('1注文あたりの金額は、リピートが ' + D.yenShort(g.repeat.avg) + '、新規が ' + D.yenShort(g['new'].avg) + ' で、リピートのほうが ' + (c.up ? '高め' : '低め') + 'です。');
    }
    out.push('見分けられるのは、Shopify のデータ（直近55日）の中だけです。それより前に注文したお客様は、新規に数えられます。');
    return out;
  };

  D.commentShip = function (s) {
    if (!s.shipped) return ['この期間は、出荷が確認できた注文がありません。'];
    var out = [], w2 = s.within(2);
    out.push('受注から出荷までは、平均 ' + (Math.round(s.avg * 10) / 10) + '日（真ん中の値は ' + s.median + '日）です。' + pcInt(pct(w2, s.shipped)) + ' の注文は、2日以内に出荷されています。');
    var slow = s.shipped - s.within(7);
    if (slow > 0) out.push('出荷まで8日以上かかった注文が ' + slow + '件あります（いちばん長いもので ' + s.max + '日）。');
    if (s.notShipped > 0) out.push('出荷がまだ確認できない注文が ' + s.notShipped + '件あります。');
    return out;
  };

  D.commentFreight = function (f, orders) {
    if (!orders) return [];
    var out = [];
    if (!f.charged && !f.free) return ['この期間は、注文がありません。'];
    out.push('送料は ' + D.yenShort(f.freight) + '（売上の ' + pc(f.share) + '）です。送料をいただいた注文は ' + f.charged + '件、送料のない（無料などの）注文は ' + f.free + '件です。');
    if (f.charged) out.push('送料をいただいた注文の、1件あたりの送料は ' + D.yenShort(f.avgCharged) + ' です。');
    if (f.shopCount) {
      if (f.discountOrders) out.push('値引きコードは、Shopify の注文 ' + f.shopCount + '件のうち ' + f.discountOrders + '件で使われ、値引きは合計 ' + D.yenShort(f.discountTotal) + '（税込）です。');
      else out.push('Shopify の注文 ' + f.shopCount + '件の中に、値引きコードを使った注文はありません。');
    }
    return out;
  };

  /* ============================================================ まとめて作る（画面はこれを呼ぶ） */
  D.analyze = function (model, range, today) {
    var p = D.period(range, today), orders = D.pick(model.orders, p.cur), prevOrders = D.pick(model.orders, p.prev);
    var shop = D.pickShop(model.shop, p.cur);
    var cur = D.summary(orders), prev = D.summary(prevOrders), deltas = D.productDelta(orders, prevOrders);
    var series = D.byMonth(orders, p.from, p.to), products = D.byProduct(orders), region = D.byRegion(orders);
    var wd = D.byWeekday(shop), hours = D.byHour(shop), bands = D.hourBands(hours), rep = D.byRepeat(shop), ship = D.byShipDays(orders), fr = D.freightInfo(orders, shop);
    // 月ごとの送料（グラフ用）
    var frSeries = series.map(function (s) { return { month: s.month, freight: s.freight, share: pct(s.freight, s.sales) }; });
    return {
      period: p, cur: cur, prev: prev, series: series, products: products, region: region, weekday: wd, hours: hours, bands: bands, repeat: rep, ship: ship, freight: fr, frSeries: frSeries,
      shopCount: shop.length,
      comments: {
        sales: D.commentSales(cur, prev, deltas, p), monthly: D.commentMonthly(series, p), products: D.commentProducts(products), region: D.commentRegion(region),
        weekday: D.commentWeekday(wd), hour: D.commentHour(hours, bands), repeat: D.commentRepeat(rep), ship: D.commentShip(ship), freight: D.commentFreight(fr, orders)
      }
    };
  };

  root.EcDashboard = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
