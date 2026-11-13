/* 売上の分析（ec_dashboard.html・EC とふるさと納税）の計算部品。画面とは別にして、node でテストできるようにしてある。
 * 月別・商品別・地域別・曜日別・時間帯別・新規とリピート・出荷までの日数・送料と値引きを集計し、
 * 数字から日本語のコメント（文）を作る。データは読むだけ（書き込みなし）。
 *
 * 「対象」：EC（得意先 599801・599802＝Shopify の注文）・ふるさと納税（341401）・合計。得意先コードで分ける。
 *   Shopify から作る切り口（時間帯・新規とリピート・値引き・曜日の注文した日）は EC だけ（ふるさと納税には作れない・合計は EC の分だけ）
 *   注文の単位：EC は客先注番（Shopify の注文番号）、ふるさと納税は売上の伝票（客先注番が空だったり、同じ番号が複数の伝票に付くため）
 * 「売上」の決め方（SMILE の確定した売上）
 *   ・売上明細出力.csv（SMILE が毎日書き出す）の、EC の得意先（599801・599802）の行。明細区分 0（商品の明細）の金額（税抜）を、伝票日付（売上日＝出荷して売上になった日）の月で数える
 *   ・送料（品目コード FR・運賃）も売上に含める（商品別の表には入れない）。消費税の行（明細区分 1）は入れない。訂正（マイナス）の行は差し引く
 *   ・注文＝客先注番（Shopify の注文番号）。分納で伝票が2枚になった注文は1件と数える。テスト送信（TEST…）は除く
 *   ・曜日別の「売上の日」は売上明細の伝票日付、「注文した日」は Shopify の注文。時間帯・新規とリピート・値引きは、注文日時が分かる Shopify の直近55日分
 *   ・出荷までの日数は、SMILE の受注（ec_smile_index.json）と出荷のデータから（受注日で数える。売上日ではない）
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
    var d = String(s == null ? '' : s).trim().replace(/\//g, '-');   // 2026/11/07 も読める
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

  /* ---------- 売上明細出力.csv（SMILE の確定した売上）を読む
   * 65MB ほどある大きなファイルなので、EC の得意先の行だけを先に絞る（全部を文字にして持たない）。
   * ・文字コードは UTF-8（古い出力は Shift_JIS）。見出し行に「伝票日付」が読めなければ Shift_JIS で読み直す
   * ・1行＝売上伝票の明細1行（金額は税抜）。明細区分 0＝商品の明細、1＝消費税の行。全部の項目が「"」で囲まれ、1行に改行は入らない
   * buf＝ArrayBuffer か Uint8Array、codes＝得意先コードの配列。戻り値＝見出し行＋その得意先を含む行（CSV の文字） */
  D.extractSalesLines = function (buf, codes, opt) {
    opt = opt || {};
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), step = opt.chunk || 4 * 1024 * 1024;
    var enc = 'utf-8';
    var head = new TextDecoder('utf-8').decode(u8.subarray(0, Math.min(u8.length, 65536)));
    if (head.indexOf('伝票日付') < 0) { try { var h2 = new TextDecoder('shift_jis').decode(u8.subarray(0, Math.min(u8.length, 65536))); if (h2.indexOf('伝票日付') >= 0) enc = 'shift_jis'; } catch (e) { /* utf-8 のまま */ } }
    var dec = new TextDecoder(enc), keep = [], header = '', carry = '', first = true;
    function take(line) {
      if (first) { header = line.replace(/^﻿/, ''); first = false; return; }
      for (var i = 0; i < codes.length; i++) if (line.indexOf(codes[i]) >= 0) { keep.push(line); return; }
    }
    for (var p = 0; p < u8.length; p += step) {
      var text = carry + dec.decode(u8.subarray(p, Math.min(u8.length, p + step)), { stream: p + step < u8.length });
      var lines = text.split('\n'); carry = lines.pop();
      for (var j = 0; j < lines.length; j++) take(lines[j].replace(/\r$/, ''));
    }
    if (carry) take(carry.replace(/\r$/, ''));
    return header + '\n' + keep.join('\n');
  };

  function normHead(h) { return String(h == null ? '' : h).normalize('NFKC').replace(/\s+/g, ''); }

  /* ---------- 対象（EC・ふるさと納税・合計）
   * 売上明細・SMILE の受注・出荷は、得意先コードで分ける。EC＝Shopify の注文（客先注番に Shopify の注文番号が入る）。
   * ふるさと納税は客先注番が空だったり、同じ番号がたくさんの伝票に付いたりするので、伝票（売上№）・受注№を注文の単位にする。 */
  D.TARGETS = [{ k: 'ec', label: 'EC' }, { k: 'furusato', label: 'ふるさと納税' }, { k: 'all', label: '合計' }];
  D.targetLabel = function (k) { var t = D.TARGETS.filter(function (x) { return x.k === k; })[0]; return t ? t.label : ''; };
  D.ofTarget = function (list, target) { return !target || target === 'all' ? list : list.filter(function (o) { return o.kind === target; }); };
  // 得意先コードの組：[{ k: 'ec', codes: [...] }, { k: 'furusato', codes: [...] }]。custCodes（EC のコード）だけ渡されたときは、EC だけ
  function groupsOf(opts) {
    var g = opts.custGroups && opts.custGroups.length ? opts.custGroups : [{ k: 'ec', codes: opts.custCodes || [] }], kind = {}, all = [];
    g.forEach(function (x) { (x.codes || []).forEach(function (c) { kind[c] = x.k; all.push(c); }); });
    return { kind: kind, all: all, empty: !all.length };
  }

  /* 売上明細の行 → 売上伝票ごとのまとめ（売上№ごと）。rows＝{ 見出し: 値 } の配列（見出しの半角・全角の違いは無視する）
   * 1件＝{ slipNo, kind, id（EC は客先注番の数字）, juchu（受注№の数字）, date（伝票日付）, month, amount（税抜・送料込み）, goods, freight, qty, lines, pref, region } */
  function buildSales(rows, grp, nouhin, shopById) {
    var map = {}, keys = [];
    (rows || []).forEach(function (row) {
      var m = {}; Object.keys(row).forEach(function (k) { var n = normHead(k); if (!(n in m)) m[n] = row[k]; });
      var f = function (name) { var v = m[normHead(name)]; return v == null ? '' : String(v).trim(); };
      var c = f('得意先コード'); if (!grp.empty && !grp.kind[c]) return;
      var kind = grp.kind[c] || 'ec';
      var kubun = f('明細区分'); if (kubun !== '' && kubun !== '0') return;   // 消費税の行は除く
      var code = f('品目コード'), name = norm(f('品目名'));
      if (!code && /^消費税/.test(name)) return;
      var po = f('客先注番'); if (/^#?test/i.test(po)) return;   // テスト送信は除く
      var d = D.ymd(f('伝票日付')); if (!d) return;
      var id = kind === 'ec' ? digits(po) : '', no = f('売上№'), key = no || (d + '|' + id + '|' + digits(f('受注№')));
      var g = map[key];
      if (!g) { g = map[key] = { slipNo: no, kind: kind, id: id, juchu: digits(f('受注№')), cust: c, date: d, dest: f('納品先コード'), lines: {} }; keys.push(key); }
      var lk = code || name, l = g.lines[lk] = g.lines[lk] || { code: code, names: {}, qty: 0, amt: 0 };
      if (name) l.names[name] = (l.names[name] || 0) + 1;
      l.qty += num(f('数量')); l.amt += num(f('金額'));
    });
    var out = keys.map(function (k) {
      var g = map[k], goods = 0, freight = 0, qty = 0, lines = [];
      Object.keys(g.lines).forEach(function (lk) {
        var l = g.lines[lk];
        if (l.code === D.FREIGHT_CODE) { freight += l.amt; return; }
        goods += l.amt; qty += l.qty;
        var best = '', n = 0; Object.keys(l.names).forEach(function (x) { if (l.names[x] > n) { n = l.names[x]; best = x; } });
        lines.push({ code: l.code || lk, name: best || l.code, qty: l.qty, amt: l.amt });
      });
      var sh = g.kind === 'ec' ? shopById[g.id] : null, pref = nouhin[g.cust + '|' + g.dest] || (sh && sh.ship ? D.prefOf(sh.ship.province) : '');
      return { slipNo: g.slipNo, kind: g.kind, id: g.id, juchu: g.juchu, date: g.date, month: g.date.slice(0, 7), amount: goods + freight, goods: goods, freight: freight, qty: qty, lines: lines, pref: pref, region: pref ? D.regionOf(pref) : D.UNKNOWN };
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.slipNo < b.slipNo ? -1 : a.slipNo > b.slipNo ? 1 : 0); });
    return out;
  }

  // 同じ注文の売上伝票をひとつにまとめる（EC は客先注番が同じ＝同じ注文。分納で伝票が2枚になった注文を1件と数える。ふるさと納税は伝票ごと）。日付は、いちばん早い伝票の日
  D.orderize = function (recs) {
    var map = {}, out = [];
    recs.forEach(function (o, i) {
      var k = o.kind === 'furusato' ? 'f' + (o.slipNo || 'i' + i) : o.id ? 'o' + o.id : o.slipNo ? 's' + o.slipNo : 'i' + i, g = map[k];
      if (!g) {
        g = map[k] = { id: o.id, kind: o.kind, slipNo: o.slipNo, date: o.date, month: o.month, amount: 0, goods: 0, freight: 0, qty: 0, lines: [], pref: o.pref, region: o.region, shipDays: o.shipDays == null ? null : o.shipDays };
        out.push(g);
      } else {
        if (o.date < g.date) { g.date = o.date; g.month = o.month; }
        if (!g.pref && o.pref) { g.pref = o.pref; g.region = o.region; }
      }
      g.amount += o.amount; g.goods += o.goods; g.freight += o.freight; g.qty += o.qty; g.lines = g.lines.concat(o.lines);
    });
    return out;
  };

  /* ============================================================ データをまとめる */
  /* opts＝{ salesRows（売上明細出力.csv を { 見出し: 値 } にしたもの。EC・ふるさと納税の得意先の行だけでよい）, smileRows（ec_smile_index.json の orders を { 列名: 値 } にしたもの）,
   *         nouhinRows（同じく nouhin）, shopifyOrders（EcSales.groupShopifyOrders の結果）, shipLookup（EcSales.shipLookup の結果）, shipIndex（ship_index.json そのもの）,
   *         custGroups（[{ k:'ec', codes }, { k:'furusato', codes }]）または custCodes（EC のコード）, today }
   * 戻り値＝{ sales（売上伝票・確定した売上）, orders（SMILE の受注。出荷までの日数に使う）, shop（Shopify の注文・EC だけ・キャンセルを除く）, info } */
  D.build = function (opts) {
    opts = opts || {};
    var grp = groupsOf(opts), nouhin = {}, shopById = {}, cancelled = {};
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

    // 売上（売上明細）
    var sales = buildSales(opts.salesRows, grp, nouhin, shopById), soldKeys = {};
    function soldKey(kind, id, juchu) { return kind === 'ec' ? 'ec:' + id : 'f:' + juchu; }
    sales.forEach(function (s) { var k = soldKey(s.kind, s.id, s.juchu); if (k !== 'ec:' && k !== 'f:') soldKeys[k] = 1; });

    // 出荷：EC は客先注番（注文番号）、ふるさと納税は受注№で引く。出荷のデータは、ある日（from）より前の分が残っていない
    var ships = opts.shipLookup, shipFrom = (opts.shipIndex && opts.shipIndex.from) || '', byJuchu = {};
    ((opts.shipIndex && opts.shipIndex.ships) || []).forEach(function (s) { (s.juchu || []).forEach(function (j) { var k = digits(j); if (k) (byJuchu[k] = byJuchu[k] || []).push(s); }); });
    function earliest(list, cust) {
      var ds = (list || []).filter(function (s) { return !s.cust || s.cust === cust; }).map(function (s) { return String(s.date || '').slice(0, 10); }).filter(Boolean).sort();
      return ds[0] || '';
    }

    // SMILE の受注（出荷までの日数・まだ売上になっていない受注に使う）
    var map = {}, ids = [];
    (opts.smileRows || []).forEach(function (r) {
      var c = String(r['得意先コード'] || '').trim();
      if (!grp.empty && !grp.kind[c]) return;
      var kind = grp.kind[c] || 'ec', po = String(r['客先注番'] || '').trim();
      if (/^test/i.test(po)) return;
      var id = kind === 'ec' ? digits(po) : digits(r['受注№']); if (!id) return;
      var key = kind + ':' + id, g = map[key];
      if (!g) { g = map[key] = { id: id, kind: kind, cust: c, dates: [], amt: 0 }; ids.push(key); }
      var d = D.ymd(r['受注日付']); if (d) g.dates.push(d);
      g.amt += num(r['金額']);
    });
    var orders = [], cancelledOut = 0;
    ids.forEach(function (key) {
      var g = map[key], id = g.id;
      if (g.kind === 'ec' && cancelled[id]) { cancelledOut++; return; }
      var ds = g.dates.slice().sort(), date = ds[0] || ''; if (!date) return;
      var sh = g.kind === 'ec' ? shopById[id] : null;
      var shipDate = g.kind === 'ec' ? earliest(ships && ships.byPo && ships.byPo[id], g.cust) : earliest(byJuchu[id], g.cust);
      // 出荷までの日数の起点：お客様が注文した日（Shopify の注文があれば）。なければ SMILE の受注日付
      var from = sh && sh.createdAt ? sh.createdAt : date;
      orders.push({ id: id, kind: g.kind, date: date, month: date.slice(0, 7), amount: g.amt, shipDate: shipDate, startDate: from, shipDays: shipDate ? Math.max(0, D.diffDays(from, shipDate)) : null,
        noShipData: !shipDate && !!shipFrom && from < shipFrom });   // 出荷のデータが残っていない古い注文は、出荷が分からない
    });
    orders.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); });

    // Shopify の注文（EC だけ・キャンセルを除く）：注文した日時から数える。同じメールが前にも注文していれば「リピート」
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

    var inSmile = {}; orders.forEach(function (o) { if (o.kind === 'ec') inSmile[o.id] = 1; });
    var waiting = shop.filter(function (o) { return !inSmile[o.id]; }).length;   // Shopify にあって、まだ SMILE に受注伝票がない注文
    var salesFrom = sales.length ? sales[0].date : '';
    // 受注はあるが、まだ売上になっていない（出荷前）注文。売上明細が始まる前の古い受注は、数えない
    var notSold = orders.filter(function (o) { return !soldKeys[soldKey(o.kind, o.id, o.id)] && (!salesFrom || o.date >= salesFrom); });
    var sd = shop.map(function (o) { return o.date; }).sort();
    function notSoldOf(kind) { var a = notSold.filter(function (o) { return !kind || o.kind === kind; }); return { count: a.length, amount: sum(a, function (o) { return o.amount; }) }; }
    return { sales: sales, orders: orders, shop: shop, info: {
      cancelledOut: cancelledOut, shopCancelled: Object.keys(cancelled).length, waiting: waiting, notSold: notSold.length, notSoldAmount: sum(notSold, function (o) { return o.amount; }), notSoldBy: { ec: notSoldOf('ec'), furusato: notSoldOf('furusato') },
      shopFrom: sd[0] || '', shopTo: sd[sd.length - 1] || '', firstMonth: sales.length ? sales[0].month : '', lastMonth: sales.length ? sales[sales.length - 1].month : '',
      salesTo: sales.length ? sales[sales.length - 1].date : '', salesFrom: salesFrom, shipFrom: shipFrom
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
  D.summary = function (recs) {
    var orders = D.orderize(recs), n = orders.length, sales = sum(orders, function (o) { return o.amount; }), qty = sum(orders, function (o) { return o.qty; });
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
  D.byProduct = function (recs) {
    var orders = D.orderize(recs), m = {}, total = 0;
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
  D.byRegion = function (recs) {
    var orders = D.orderize(recs), rg = {}, pf = {}, total = orders.length, unknown = 0;
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
  // 曜日別。recs＝日付（date）と金額（amount）を持つ配列（売上の注文ごと、または Shopify の注文）。日曜=0 … 土曜=6。月曜はじまりの順で返す
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
    var outOfRange = orders.filter(function (o) { return o.noShipData; }).length;
    orders = orders.filter(function (o) { return !o.noShipData; });
    var shipped = orders.filter(function (o) { return o.shipDays != null; }), days = shipped.map(function (o) { return o.shipDays; }).sort(function (a, b) { return a - b; });
    var total = shipped.length;
    var buckets = D.SHIP_BUCKETS.map(function (b) {
      var c = shipped.filter(function (o) { return o.shipDays >= b.from && o.shipDays <= b.to; }).length;
      return { k: b.k, label: b.label, count: c, share: pct(c, total) };
    });
    var mid = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : 0;
    return { buckets: buckets, shipped: total, notShipped: orders.length - total, outOfRange: outOfRange, avg: total ? sum(days) / total : 0, median: mid, max: days.length ? days[days.length - 1] : 0,
      within: function (n) { return days.filter(function (d) { return d <= n; }).length; } };
  };
  // 送料と値引き
  D.freightInfo = function (recs, shop) {
    var orders = D.orderize(recs);
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
  D.commentSales = function (cur, prev, deltas, p, who) {
    var L = p.labels, out = [], T = who ? who + 'の' : '';
    if (!cur.count && !prev.count) return ['この期間は、注文がありません。'];
    if (!prev.count) return [T + L.cur + 'の売上は ' + D.yenShort(cur.sales) + '（' + cur.count + '件）です。' + L.prev + 'は注文がないため、比べられません。'];
    var c = chg(cur.sales, prev.sales), up = c.up;
    var tail = p.partial ? '（' + L.prev + 'の同じ日数までと比べています）' : '';
    if (c.flat) out.push(T + L.cur + 'の売上は、' + L.prev + 'とほぼ同じです（' + D.yenShort(prev.sales) + ' → ' + D.yenShort(cur.sales) + '）。' + tail);
    else out.push(T + L.cur + 'の売上は' + L.prev + 'より ' + c.pct + '% ' + (up ? '増えています' : '減っています') + '（' + D.yenShort(prev.sales) + ' → ' + D.yenShort(cur.sales) + '）。' + tail);
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

  D.commentMonthly = function (series, p, who) {
    var T = who ? who + 'の' : '', out = [], full = series.filter(function (s) { return !(p.partial && s.month === p.to); });
    var has = series.filter(function (s) { return s.count > 0; });
    if (!has.length) return ['この期間は、注文がありません。'];
    if (has.length === 1 && series.length === 1) return [T + 'この期間の売上は ' + D.yenShort(has[0].sales) + '（' + has[0].count + '件）です。'];
    var pool = full.filter(function (s) { return s.count > 0; }); if (pool.length < 2) pool = has;
    var hi = pool.slice().sort(function (a, b) { return b.sales - a.sales; })[0], lo = pool.slice().sort(function (a, b) { return a.sales - b.sales; })[0];
    out.push(T + '売上がいちばん多かったのは ' + D.monthLabelY(hi.month) + '（' + D.yenShort(hi.sales) + '・' + hi.count + '件）です。' + (lo.month !== hi.month ? 'いちばん少なかったのは ' + D.monthLabelY(lo.month) + '（' + D.yenShort(lo.sales) + '）です。' : ''));
    if (full.length >= 3) {   // 終わった月の、直近3か月の流れ
      var a = full.slice(-3), up = a[2].sales > a[1].sales && a[1].sales > a[0].sales, dn = a[2].sales < a[1].sales && a[1].sales < a[0].sales;
      if (up) out.push('終わった月だけで見ると、直近の3か月は、売上が続けて増えています。');
      else if (dn) out.push('終わった月だけで見ると、直近の3か月は、売上が続けて減っています。');
    }
    if (p.partial) out.push(D.monthLabelY(p.to) + 'は途中（' + (+p.cur.end.slice(8, 10)) + '日まで）なので、まだ少なく見えます。');
    return out;
  };

  D.commentProducts = function (list, who) {
    var T = who ? who + 'の' : '';
    if (!list.length) return ['この期間は、商品の売上がありません。'];
    var out = [], a = list[0], b = list[1];
    out.push(T + '売れ筋は ' + a.name + '（売上の ' + pcInt(a.share) + '・' + r0(a.qty) + '台）' + (b ? '、次が ' + b.name + '（' + pcInt(b.share) + '・' + r0(b.qty) + '台）' : '') + ' です。');
    if (list.length >= 4) { var t3 = sum(list.slice(0, 3), function (x) { return x.share; }); out.push('上位3つで、商品の売上の ' + pcInt(t3) + ' を占めています。'); }
    return out;
  };

  D.commentRegion = function (g, who) {
    if (!g.known) return ['この期間は、届け先が分かる注文がありません。'];
    var out = [], r = g.regions, a = r[0], b = r[1], p = g.prefs[0];
    out.push((who ? who + 'は、' : '') + a.name + 'の注文が ' + pcInt(a.share) + ' を占め' + (b ? '、次は ' + b.name + ' で ' + pcInt(b.share) + ' です' : 'ています') + '。');
    if (p) out.push('都道府県では ' + p.name + ' がいちばん多く（' + p.count + '件・' + pcInt(p.share) + '）、' + g.prefs.length + '都道府県から注文があります。');
    if (g.unknown) out.push('届け先の住所が分からない注文 ' + g.unknown + '件は、数えていません。');
    return out;
  };

  // kind＝'sales'（売上明細の売上の日＝出荷した日）か 'shop'（Shopify の注文した日。直近55日分だけ）
  D.commentWeekday = function (days, kind, who) {
    var T = who ? who + 'の' : '', isSales = kind === 'sales', n = sum(days, function (d) { return d.count; });
    if (!n) return [isSales ? 'この期間は、売上がありません。' : 'この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [], subj = T + (isSales ? '売上の日（出荷した日）は' : '注文は');
    if (n < 20) out.push('注文が ' + n + '件と少ないので、傾向は参考程度に見てください。');
    var s = days.slice().sort(function (a, b) { return b.count - a.count; }), top = s[0], sec = s[1];
    if (top.count === 0) return out;
    var two = pcInt(top.share + sec.share);
    out.push(subj + top.name + '曜と' + sec.name + '曜に多い傾向です（全体の ' + two + '）。');
    var low = s[s.length - 1];
    if (low.count < top.count) out.push(low.name + '曜は少なめです（' + pcInt(low.share) + '）。');
    var we = days.filter(function (d) { return d.wd === 0 || d.wd === 6; }), wp = sum(we, function (d) { return d.share; });
    out.push((isSales ? '土日の売上' : '土日の注文') + 'は、全体の ' + pcInt(wp) + ' です。');
    return out;
  };

  D.commentHour = function (hours, bands, who) {
    var T = who ? who + 'の' : '';
    var n = sum(hours, function (x) { return x.count; });
    if (!n) return ['この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [], top = hours.slice().sort(function (a, b) { return b.count - a.count; })[0], tb = bands.slice().sort(function (a, b) { return b.count - a.count; })[0];
    if (n < 20) out.push('注文が ' + n + '件と少ないので、傾向は参考程度に見てください。');
    out.push(T + '注文は ' + top.hour + '時台がいちばん多く（' + top.count + '件・' + pcInt(top.share) + '）、時間の帯では ' + tb.label + ' が ' + pcInt(tb.share) + ' です。');
    return out;
  };

  D.commentRepeat = function (g, who) {
    var T = who ? who + 'の' : '';
    if (!g.known) return ['この期間は、Shopify の注文がありません（Shopify の注文は直近55日分だけです）。'];
    var out = [];
    out.push(T + 'リピート（同じメールアドレスで、前にも注文がある）のお客様の注文は ' + g.repeat.count + '件、全体の ' + pcInt(g.repeat.share) + ' です。');
    if (g['new'].count >= 3 && g.repeat.count >= 3) {
      var c = chg(g.repeat.avg, g['new'].avg);
      if (c && !c.flat) out.push('1注文あたりの金額は、リピートが ' + D.yenShort(g.repeat.avg) + '、新規が ' + D.yenShort(g['new'].avg) + ' で、リピートのほうが ' + (c.up ? '高め' : '低め') + 'です。');
    }
    out.push('見分けられるのは、Shopify のデータ（直近55日）の中だけです。それより前に注文したお客様は、新規に数えられます。');
    return out;
  };

  D.commentShip = function (s, who) {
    var T = who ? who + 'の' : '';
    if (!s.shipped) return ['この期間は、出荷が確認できた注文がありません。'];
    var out = [], w2 = s.within(2);
    out.push(T + '受注から出荷までは、平均 ' + (Math.round(s.avg * 10) / 10) + '日（真ん中の値は ' + s.median + '日）です。' + pcInt(pct(w2, s.shipped)) + ' の注文は、2日以内に出荷されています。');
    var slow = s.shipped - s.within(7);
    if (slow > 0) out.push('出荷まで8日以上かかった注文が ' + slow + '件あります（いちばん長いもので ' + s.max + '日）。');
    if (s.notShipped > 0) out.push('出荷がまだ確認できない注文が ' + s.notShipped + '件あります。');
    if (s.outOfRange > 0) out.push('出荷のデータが残っていない古い注文 ' + s.outOfRange + '件は、数えていません。');
    return out;
  };

  D.commentFreight = function (f, orders, who, shopNote) {
    if (!orders) return [];
    var T = who ? who + 'の' : '';
    var out = [];
    if (!f.charged && !f.free) return ['この期間は、注文がありません。'];
    out.push(T + '送料は ' + D.yenShort(f.freight) + '（売上の ' + pc(f.share) + '）です。送料をいただいた注文は ' + f.charged + '件、送料のない（無料などの）注文は ' + f.free + '件です。');
    if (!f.charged) out.push('送料をいただいた注文は、この期間にありません。');
    if (f.charged) out.push('送料をいただいた注文の、1件あたりの送料は ' + D.yenShort(f.avgCharged) + ' です。');
    if (shopNote) out.push(shopNote);
    if (f.shopCount) {
      if (f.discountOrders) out.push('値引きコードは、Shopify の注文 ' + f.shopCount + '件のうち ' + f.discountOrders + '件で使われ、値引きは合計 ' + D.yenShort(f.discountTotal) + '（税込）です。');
      else out.push('Shopify の注文 ' + f.shopCount + '件の中に、値引きコードを使った注文はありません。');
    }
    return out;
  };

  /* ============================================================ まとめて作る（画面はこれを呼ぶ） */
  /* target＝'ec'（EC）・'furusato'（ふるさと納税）・'all'（合計）。Shopify から作る切り口（時間帯・新規とリピート・値引き・曜日の注文した日）は EC だけ：
   *   ふるさと納税→作れない（shopAvailable=false）、合計→EC の分だけ（shopScope='ecOnly'）。 */
  D.analyze = function (model, range, today, target) {
    target = target || 'ec';
    var who = D.targetLabel(target), shopAvailable = target !== 'furusato', shopScope = target === 'furusato' ? 'none' : target === 'all' ? 'ecOnly' : 'ec';
    var p = D.period(range, today), sales = D.ofTarget(model.sales, target), orders = D.pick(sales, p.cur), prevOrders = D.pick(sales, p.prev);   // 売上（売上明細・売上日で数える）
    var shop = shopAvailable ? D.pickShop(model.shop, p.cur) : [], shipOrders = D.pick(D.ofTarget(model.orders, target), p.cur);                        // Shopify は注文日、出荷までの日数は受注日で数える
    var cur = D.summary(orders), prev = D.summary(prevOrders), deltas = D.productDelta(orders, prevOrders);
    var series = D.byMonth(orders, p.from, p.to), products = D.byProduct(orders), region = D.byRegion(orders);
    var wd = D.byWeekday(D.orderize(orders)), wdShop = D.byWeekday(shop), hours = D.byHour(shop), bands = D.hourBands(hours), rep = D.byRepeat(shop), ship = D.byShipDays(shipOrders), fr = D.freightInfo(orders, shop);
    // 月ごとの送料（グラフ用）
    var frSeries = series.map(function (s) { return { month: s.month, freight: s.freight, share: pct(s.freight, s.sales) }; });
    var ecWho = target === 'all' ? 'EC' : who, shopNote = shopScope === 'ecOnly' ? '値引きは EC の分だけです（ふるさと納税は含みません）。' : '';
    return {
      target: target, who: who, shopAvailable: shopAvailable, shopScope: shopScope,
      period: p, cur: cur, prev: prev, series: series, products: products, region: region, weekday: wd, weekdayShop: wdShop, hours: hours, bands: bands, repeat: rep, ship: ship, freight: fr, frSeries: frSeries,
      shopCount: shop.length, shipCount: shipOrders.length,
      comments: {
        sales: D.commentSales(cur, prev, deltas, p, who), monthly: D.commentMonthly(series, p, who), products: D.commentProducts(products, who), region: D.commentRegion(region, who),
        weekday: D.commentWeekday(wd, 'sales', who), weekdayShop: shopAvailable ? D.commentWeekday(wdShop, 'shop', 'EC') : [], hour: shopAvailable ? D.commentHour(hours, bands, 'EC') : [],
        repeat: shopAvailable ? D.commentRepeat(rep, 'EC') : [], ship: D.commentShip(ship, who), freight: D.commentFreight(fr, orders, who, shopNote)
      }
    };
  };

  root.EcDashboard = D;
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
