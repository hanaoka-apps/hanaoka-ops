/* EC売上アプリ（ec_sales.html）の計算部分。画面に依存しないので Node でテストできる（tests/test_ec_sales_core.cjs）。
 *
 * 流れ：Shopify の注文CSV → 注文ごとにまとめる → 品目対応表で SMILE の品目に展開 → 出荷予定日（営業日）を決める
 *       → 人がチェックして OK → 納品先（新規のみ）→ 受注伝票 の取込ファイル（UTF-16・タブ・CRLF）を作る。
 *       入金は Shopify の入金の中身（payment_transactions）を 入金日×得意先 でまとめて入金伝票にする。
 * 決まりごとは EC取込_2026-10/引き継ぎメモ.md（ドキュメント\Claude\SMILEマニュアル一式\明細取込）にある。
 */
(function (root) {
  'use strict';
  var EC = {};

  /* ============================================================ 汎用 */
  EC.stripBom = function (t) { return t && t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; };

  // 区切り文字つきテキスト → 二次元配列（"…" で囲まれた改行・区切り文字に対応）
  EC.parseDelimited = function (text, delim) {
    text = EC.stripBom(String(text || ''));
    delim = delim || ',';
    var rows = [], row = [], cell = '', q = false, i = 0, n = text.length, c;
    while (i < n) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === delim) { row.push(cell); cell = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  };
  // 見出し行つき → オブジェクトの配列（同じ見出しが複数あるときは最初のものを使う）
  EC.parseObjects = function (text, delim) {
    var rows = EC.parseDelimited(text, delim);
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { if (!(h in o)) o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
  };
  // SMILE の出力（受注明細出力.csv はタブ区切り）か Shopify（カンマ）かを見出し行で判定
  EC.detectDelim = function (text) {
    var first = EC.stripBom(String(text || '')).split(/\r?\n/, 1)[0] || '';
    return (first.split('\t').length > first.split(',').length) ? '\t' : ',';
  };
  EC.parseAuto = function (text) { return EC.parseObjects(text, EC.detectDelim(text)); };

  function num(v) { var n = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return isFinite(n) ? n : 0; }
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function norm(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim(); }
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }

  /* ============================================================ 日付・営業日 */
  function toUTC(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function fmt(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  EC.addDays = function (s, n) { var d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
  EC.weekday = function (s) { return toUTC(s).getUTCDay(); };
  EC.ymd = function (s) { return s ? s.replace(/-/g, '') : '0'; };
  function nthMonday(y, m, n) {
    var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return y + '-' + pad(m) + '-' + pad(1 + ((8 - first) % 7) + (n - 1) * 7);
  }

  // 日本の祝日（2000〜2099。2020・2021 の東京五輪による移動は扱わない＝2025年以降の運用向け）
  var holidayCache = {};
  EC.japaneseHolidays = function (y) {
    if (holidayCache[y]) return holidayCache[y];
    var k = y - 1980, base = {};
    var spring = Math.floor(20.8431 + 0.242194 * k - Math.floor(k / 4));
    var autumn = Math.floor(23.2488 + 0.242194 * k - Math.floor(k / 4));
    var P = function (m, d) { return y + '-' + pad(m) + '-' + pad(d); };
    base[P(1, 1)] = '元日'; base[nthMonday(y, 1, 2)] = '成人の日'; base[P(2, 11)] = '建国記念の日';
    base[P(2, 23)] = '天皇誕生日'; base[P(3, spring)] = '春分の日'; base[P(4, 29)] = '昭和の日';
    base[P(5, 3)] = '憲法記念日'; base[P(5, 4)] = 'みどりの日'; base[P(5, 5)] = 'こどもの日';
    base[nthMonday(y, 7, 3)] = '海の日'; base[P(8, 11)] = '山の日'; base[nthMonday(y, 9, 3)] = '敬老の日';
    base[P(9, autumn)] = '秋分の日'; base[nthMonday(y, 10, 2)] = 'スポーツの日'; base[P(11, 3)] = '文化の日';
    base[P(11, 23)] = '勤労感謝の日';
    var all = {}, d;
    Object.keys(base).forEach(function (s) { all[s] = base[s]; });
    // 日曜が祝日なら、次の祝日でない日が振替休日
    Object.keys(base).forEach(function (s) {
      if (EC.weekday(s) === 0) { d = EC.addDays(s, 1); while (all[d]) d = EC.addDays(d, 1); all[d] = '振替休日'; }
    });
    // 前後を祝日にはさまれた平日は国民の休日
    Object.keys(base).forEach(function (s) {
      var m = EC.addDays(s, 1);
      if (!all[m] && all[EC.addDays(m, 1)] && EC.weekday(m) !== 0) all[m] = '国民の休日';
    });
    holidayCache[y] = all;
    return all;
  };

  // 営業日カレンダー。closedYearly=[['12-29','01-03']]（毎年の休業期間）、closedDates=['2026-08-13',…]（その年だけの休業日）
  EC.makeCalendar = function (opt) {
    opt = opt || {};
    var yearly = opt.closedYearly || [], dates = {};
    (opt.closedDates || []).forEach(function (s) { dates[s] = 1; });
    function closed(s) {
      if (dates[s]) return true;
      var md = s.slice(5);
      return yearly.some(function (r) { return r[0] <= r[1] ? (md >= r[0] && md <= r[1]) : (md >= r[0] || md <= r[1]); });
    }
    var cal = {
      isBusinessDay: function (s) {
        var w = EC.weekday(s);
        return w !== 0 && w !== 6 && !EC.japaneseHolidays(+s.slice(0, 4))[s] && !closed(s);
      },
      onOrAfter: function (s) { while (!cal.isBusinessDay(s)) s = EC.addDays(s, 1); return s; },
      onOrBefore: function (s) { while (!cal.isBusinessDay(s)) s = EC.addDays(s, -1); return s; },
      add: function (s, n) {          // n 営業日あと（n=0 なら当日か、休みなら次の営業日）
        if (n <= 0) return cal.onOrAfter(s);
        var c = 0;
        while (c < n) { s = EC.addDays(s, 1); if (cal.isBusinessDay(s)) c++; }
        return s;
      },
      prev: function (s) { s = EC.addDays(s, -1); return cal.onOrBefore(s); }
    };
    return cal;
  };

  /* ============================================================ Shopify 注文CSV → 注文 */
  function addr(prefix, o) {
    return {
      name: (o[prefix + ' Name'] || '').trim(), company: (o[prefix + ' Company'] || '').trim(),
      zip: (o[prefix + ' Zip'] || '').replace(/^'/, '').trim(),
      province: (o[prefix + ' Province Name'] || '').trim(), city: (o[prefix + ' City'] || '').trim(),
      addr1: (o[prefix + ' Address1'] || '').trim(), addr2: (o[prefix + ' Address2'] || '').trim(),
      phone: (o[prefix + ' Phone'] || '').replace(/^'/, '').trim()
    };
  }
  // 行は注文ごとに複数行。合計（Total）が入っている行が注文の先頭行
  EC.groupShopifyOrders = function (objs) {
    var map = {}, list = [];
    objs.forEach(function (r) {
      var name = (r['Name'] || '').trim();
      if (!name) return;
      var o = map[name];
      if (!o) {
        o = map[name] = { name: name, id: name.replace(/^#/, ''), lines: [], head: false };
        list.push(o);
      }
      if (r['Total'] !== '' && r['Total'] !== undefined && !o.head) {
        o.head = true;
        var created = (r['Created at'] || '');
        o.createdAt = created.slice(0, 10);
        o.createdTime = created.slice(11, 16);
        o.email = r['Email'] || '';
        o.financial = (r['Financial Status'] || '').toLowerCase();
        o.fulfillment = (r['Fulfillment Status'] || '').toLowerCase();
        o.cancelledAt = (r['Cancelled at'] || '').slice(0, 10);
        o.total = num(r['Total']); o.subtotal = num(r['Subtotal']); o.shipping = num(r['Shipping']);
        o.taxes = num(r['Taxes']); o.discountAmount = num(r['Discount Amount']);
        o.discountCode = r['Discount Code'] || '';
        o.refunded = num(r['Refunded Amount']);
        o.paymentMethod = r['Payment Method'] || '';
        o.shippingMethod = r['Shipping Method'] || '';
        o.notes = r['Notes'] || '';
        o.tags = r['Tags'] || '';
        o.ship = addr('Shipping', r); o.bill = addr('Billing', r);
        o.phone = r['Phone'] || '';
      }
      if (r['Lineitem name']) {
        o.lines.push({
          name: r['Lineitem name'], sku: (r['Lineitem sku'] || '').trim(), qty: num(r['Lineitem quantity']) || 1,
          price: num(r['Lineitem price']), discount: num(r['Lineitem discount']),
          shipped: (r['Lineitem fulfillment status'] || '').toLowerCase()
        });
      }
    });
    return list.filter(function (o) { return o.head; });
  };

  /* ============================================================ 品目対応表・設定
   * 対応表（mapping）と設定（cfg）はコードに持たず、ec_sales_config.json（と SharedMasters 上の同名ファイル）から読む。
   * mapping.rules の scope: single＝商品名ぜんたいで見る（バッグ・キャスター・コンテナ単品）／body＝「 - 」の前（本体）／option＝「 - 」の後（オプション。全部拾う）
   * パターンは NFKC（全角→半角）にそろえた商品名に当てる。qty は数字（固定）か 'g1'（パターンの最初の（ ）の数字）。
   * net は税抜の標準単価（オプション・部品）。本体は net なし＝注文の合計から残りで決める（値引きは本体が吸収）。
   * includes は「セット品」に含まれる別品目。swap はオプションの文言で含まれる品目を差し替える。
   */

  /* ============================================================ 商品行 → SMILE の品目 */
  // 判定の言葉（words）から正規表現を作る。利用者には正規表現を見せない。
  //   match: contains＝含む／starts＝始まる／exact＝ちょうど一致。qtyUnit があれば「言葉の直後の数字＋単位（例：2個）」の数字を数量にする
  //   words が無い古い行は pattern（正規表現）をそのまま使う
  function escRe(t) { return t.replace(/[.*+?^${}()|[\]\\\/]/g, function (m) { return '\\' + m; }); }
  EC.ruleSource = function (rule) {
    if (rule.words && rule.words.length) {
      var ws = rule.words.map(function (w) { return norm(w); }).filter(Boolean).map(escRe);
      if (!ws.length) return '(?!)';
      var alt = '(?:' + ws.join('|') + ')' + (rule.qtyUnit ? '(\\d+)' + escRe(norm(rule.qtyUnit)) : '');
      return rule.match === 'exact' ? '^' + alt + '$' : rule.match === 'starts' ? '^' + alt : alt;
    }
    return rule.pattern || '(?!)';
  };
  function compile(rule) {
    var src = EC.ruleSource(rule), key = rule.scope + '/' + src;
    if (!(rule._re instanceof RegExp) || rule._reKey !== key) { rule._re = new RegExp(src, rule.scope === 'option' ? 'g' : ''); rule._reKey = key; }
    rule._re.lastIndex = 0; return rule._re;
  }
  // 商品名のうち、品切れの案内（※…）を取り除く。案内に「次回発送は8月20日以降」とあれば日付も返す
  function splitName(raw, orderDate) {
    var t = norm(raw), hint = '';
    var m = t.match(/次回発送は(\d+)月(\d+)日以降/);
    if (m && orderDate) {
      var y = +orderDate.slice(0, 4), mo = +m[1];
      if (mo < +orderDate.slice(5, 7) - 1) y++;
      hint = y + '-' + pad(mo) + '-' + pad(+m[2]);
    }
    t = t.replace(/※[^]*?(?= - |$)/, '').replace(/\s+/g, ' ').trim();
    var i = t.indexOf(' - ');
    return { full: t, body: i < 0 ? t : t.slice(0, i), option: i < 0 ? '' : t.slice(i + 3), stockDate: hint };
  }
  EC.splitName = splitName;

  // 戻り値 { items:[{code,qty,net,kind,ruleId,label}], unknown:[文言], warns:[文言], stockDate }
  EC.mapLine = function (line, mapping, orderDate) {
    var rules = mapping.rules, s = splitName(line.name, orderDate), out = { items: [], unknown: [], warns: [], stockDate: s.stockDate };
    var r, i, m, single = null, body = null;
    for (i = 0; i < rules.length && !single; i++) { r = rules[i]; if (r.scope === 'single' && compile(r).test(s.full)) single = r; }
    if (single) {
      out.items.push({ code: single.code, qty: line.qty, net: single.net != null ? single.net : null, kind: 'part', ruleId: single.id, label: single.label, lineNet: Math.round(line.price / 1.1) });
      if (single.warn) out.warns.push(single.warn);
      return out;
    }
    for (i = 0; i < rules.length && !body; i++) { r = rules[i]; if (r.scope === 'body' && compile(r).test(s.body)) body = r; }
    var includes = [];
    if (body) {
      out.items.push({ code: body.code, qty: line.qty, net: null, kind: 'body', ruleId: body.id, label: body.label, lineNet: Math.round(line.price / 1.1) });
      (body.includes || []).forEach(function (inc) { includes.push({ code: inc.code, qty: inc.qty * line.qty, net: inc.net, kind: 'option', ruleId: body.id, label: body.label + '（セット内）' }); });
      if (body.warn) out.warns.push(body.warn);
    } else {
      out.unknown.push(s.body);
    }
    // オプション：当たったところを消して、残った文字があれば「対応表にないオプション」
    var rest = s.option;
    rules.forEach(function (o) {
      if (o.scope !== 'option') return;
      var re = compile(o);
      rest = rest.replace(re, function () {
        var g = Array.prototype.slice.call(arguments);
        if (o.swap) { includes.forEach(function (x) { if (x.code === o.swap.from) x.code = o.swap.to; }); }
        else if (o.code) {
          var q = (o.qtyUnit || o.qty === 'g1') ? (+g[1] || 1) : (o.qty || 1);
          out.items.push({ code: o.code, qty: q * line.qty, net: o.net != null ? o.net : null, kind: 'option', ruleId: o.id, label: o.label });
        }
        if (o.warn) out.warns.push(o.warn);
        return ' ';
      });
    });
    includes.forEach(function (x) { out.items.push(x); });
    rest = rest.replace(/追加|する|しない|注文|[+＋\s・、,]/g, '').trim();
    if (rest) out.unknown.push(rest);
    return out;
  };

  /* ============================================================ 得意先・担当 */
  // 月の頭（earlyDays 日まで）は earlyCustomer（東京）、それ以外は defaultCustomer（大阪）。どちらも設定ファイルで決める
  EC.customerFor = function (orderDate, cfg) {
    if (orderDate.slice(0, 7) >= cfg.tokyoFrom && +orderDate.slice(8, 10) <= cfg.tokyoDays) return cfg.earlyCustomer;
    return cfg.defaultCustomer;
  };

  /* ============================================================ 注文 → 伝票（行・金額・出荷予定日・要確認） */
  // ctx: { mapping, cfg, items:{code:{name,unit,teihai}}, smileOrders:{番号:true} }
  EC.buildSlip = function (o, ctx) {
    var cfg = ctx.cfg, mapping = ctx.mapping;
    var cal = ctx.cal || EC.makeCalendar(cfg);
    var flags = [];
    function flag(level, text) { flags.push({ level: level, text: text }); }
    var cust = EC.customerFor(o.createdAt, cfg), cinfo = cfg.customers[cust];
    var slip = { id: o.id, name: o.name, orderDate: o.createdAt, cust: cust, custName: cinfo.name, staff: cinfo.staff, dept: cinfo.dept, lines: [], flags: flags, order: o };

    // ---- 対象外
    if (o.cancelledAt) { slip.excluded = 'キャンセル済み'; return slip; }
    if (o.financial === 'voided') { slip.excluded = '決済が取り消し（voided）'; return slip; }
    if (ctx.smileOrders && ctx.smileOrders[digits(o.id)]) slip.inSmile = true;

    // ---- 商品行を展開
    var items = [], stockDate = '', anyBody = false;
    o.lines.forEach(function (ln) {
      var m = EC.mapLine(ln, mapping, o.createdAt);
      if (m.stockDate && (!stockDate || m.stockDate > stockDate)) stockDate = m.stockDate;
      m.unknown.forEach(function (u) { flag('error', '対応表にない商品：' + u); });
      m.warns.forEach(function (w) { flag('warn', w); });
      m.items.forEach(function (it) { it.line = ln; items.push(it); if (it.kind === 'body') anyBody = true; });
    });
    if (!items.length) flag('error', '商品行がありません');

    // ---- 金額：税込の合計 ÷ 1.1 を SMILE の税抜合計にそろえる。オプション・部品・送料は標準単価で、残りを本体が吸収（値引きは本体）
    var gift = o.total === 0;
    var totalNet = Math.round(o.total / 1.1);
    var freeShip = /FREE_SHIPPING/i.test(o.discountCode);
    var shipNet = (gift || freeShip || !o.shipping) ? 0 : Math.round(o.shipping / 1.1);
    if (!gift && o.shipping && !freeShip && o.total < o.shipping) shipNet = Math.min(shipNet, totalNet);
    var fixed = shipNet;
    items.forEach(function (it) {
      if (it.kind === 'body') return;
      it.unitNet = gift ? 0 : (it.net != null ? it.net : it.lineNet);
      fixed += it.unitNet * it.qty;
    });
    var bodies = items.filter(function (it) { return it.kind === 'body'; });
    // 本体の定価（税抜）＝ その商品行の税抜金額 − 同じ行のオプション（標準単価）
    bodies.forEach(function (b) {
      var opt = items.filter(function (x) { return x.line === b.line && x.kind !== 'body' && x.net != null; })
        .reduce(function (a, x) { return a + x.net * x.qty; }, 0);
      b.listNet = Math.max(b.lineNet * b.qty - opt, 0);
    });
    if (gift) {
      bodies.forEach(function (b) { b.unitNet = 0; });
      flag('warn', 'ギフティング（合計0円）：本体0円・送料行なし');
    } else if (bodies.length) {
      var bodyTotal = totalNet - fixed;
      var listSum = bodies.reduce(function (a, b) { return a + b.listNet; }, 0) || 1;
      var left = bodyTotal;
      bodies.forEach(function (b, i) {
        var share = i === bodies.length - 1 ? left : Math.round(bodyTotal * b.listNet / listSum);
        left -= share;
        b.unitNet = Math.round(share / b.qty);
        b.amountNet = b.unitNet * b.qty;
        if (b.amountNet !== share) flag('warn', '本体の単価が割り切れません（' + share + '円÷' + b.qty + '台）');
      });
      if (bodyTotal <= 0) flag('warn', '本体が0円以下（全額値引き？）：' + bodyTotal + '円');
      else if (Math.abs(bodyTotal - listSum) > 1) {
        flag('info', '値引きあり：本体の税抜 ' + listSum.toLocaleString() + '円 → ' + bodyTotal.toLocaleString() + '円' + (o.discountCode ? '（' + o.discountCode + '）' : ''));
      }
    } else {
      // 本体なし（部品・オプションだけの注文）→ 標準単価のまま。合計とずれたら知らせる
      var diff = totalNet - fixed;
      if (Math.abs(diff) > 1) flag('warn', '合計と明細が ' + diff + '円ずれています（値引き？）');
    }
    items.forEach(function (it) { if (it.amountNet == null) it.amountNet = it.unitNet * it.qty; });

    // ---- 行を並べる：本体 → オプション・部品 → 送料
    var ordered = items.filter(function (i) { return i.kind === 'body'; })
      .concat(items.filter(function (i) { return i.kind !== 'body'; }));
    // 同じ品目・同じ単価の行は1行にまとめる（セット内のコンテナ＋追加分など）
    var merged = [];
    ordered.forEach(function (it) {
      var hit = merged.filter(function (m) { return m.code === it.code && m.unitNet === it.unitNet && m.kind === it.kind; })[0];
      if (hit) { hit.qty += it.qty; hit.amountNet += it.amountNet; } else merged.push(Object.assign({}, it));
    });
    var master = ctx.items || {};
    merged.forEach(function (it) {
      var mi = master[it.code];
      if (!mi) flag('error', '品目マスタにない品目コード：' + it.code);
      slip.lines.push({ code: it.code, name: mi ? mi.name : '', unit: mi ? mi.unit : '', teihai: mi ? mi.teihai : '1', qty: it.qty, unitNet: it.unitNet, amountNet: it.amountNet, kind: it.kind, ruleId: it.ruleId, label: it.label });
    });
    if (shipNet > 0) {
      var sm = master[cfg.shipItem];
      if (!sm) flag('error', '品目マスタにない品目コード：' + cfg.shipItem);
      slip.lines.push({ code: cfg.shipItem, name: sm ? sm.name : '', unit: sm ? sm.unit : '式', teihai: sm ? sm.teihai : '2', qty: 1, unitNet: shipNet, amountNet: shipNet, kind: 'ship', label: '送料' });
    }
    slip.netTotal = slip.lines.reduce(function (a, l) { return a + l.amountNet; }, 0);
    slip.grossTotal = Math.round(slip.netTotal * 1.1);
    if (Math.abs(slip.grossTotal - o.total) > 2 && !gift) flag('warn', 'Shopify合計 ' + o.total.toLocaleString() + '円 と明細（税込）' + slip.grossTotal.toLocaleString() + '円 が一致しません');
    slip.memo = gift ? cfg.memoGift : cfg.memo;

    // ---- 出荷予定日＝受注日から N 営業日後（品目ごとの日数の最大）。品切れ案内の日付があればその日以降
    var days = 0;
    slip.lines.forEach(function (l) {
      if (l.kind === 'ship') return;
      var d = mapping.leadDays;
      (mapping.leadOverrides || []).forEach(function (ov) {
        if (o.createdAt >= ov.from && o.createdAt <= ov.to && (!ov.codes || !ov.codes.length || ov.codes.indexOf(l.code) >= 0)) d = ov.days;
      });
      var rl = mapping.rules.filter(function (r) { return r.id === l.ruleId; })[0];
      if (rl && rl.leadDays != null) d = rl.leadDays;
      if (d > days) days = d;
    });
    slip.leadDays = days || mapping.leadDays;
    // 受注の締め（cutoffTime）以降は翌日分。休みの日に入った受注は次の営業日に処理する
    var after = (o.createdTime || '') >= (cfg.cutoffTime || '24:00');
    slip.processDate = cal.onOrAfter(after ? EC.addDays(o.createdAt, 1) : o.createdAt);
    slip.shipDate = cal.add(slip.processDate, slip.leadDays);
    if (slip.processDate !== o.createdAt) flag('info', (after ? cfg.cutoffTime + '以降の受注' : '休業日の受注') + '：' + slip.processDate.slice(5).replace('-', '/') + ' 分として処理');
    if (stockDate) {
      var sd = cal.onOrAfter(stockDate);
      if (sd > slip.shipDate) { slip.shipDate = sd; flag('info', '商品名の案内（次回発送 ' + stockDate.slice(5).replace('-', '/') + ' 以降）に合わせました'); }
    }

    // ---- 注文そのものの確認ポイント
    if (o.financial === 'pending') flag('warn', '入金待ち（' + (o.paymentMethod || '支払方法不明') + '）');
    else if (o.financial === 'refunded' || o.financial === 'partially_refunded') flag('warn', '返金あり（' + (o.refunded ? o.refunded.toLocaleString() + '円' : o.financial) + '）');
    if (o.paymentMethod && !/^Shopify Payments$/.test(o.paymentMethod)) flag('info', '支払方法：' + o.paymentMethod);
    if (o.notes) flag('warn', 'お客様メモ：' + o.notes.slice(0, 60));
    if (!o.ship.name) flag('error', '配送先の名前がありません');
    if (!o.ship.zip || !(o.ship.province || o.ship.city || o.ship.addr1)) flag('error', '配送先の住所が足りません');
    // 納品先は機械的にマスタへ追加する。入力が足りない・長すぎるときだけ知らせる
    var dv = EC.deliveryFromOrder(o, cfg), lim = cfg.limits || {};
    if (!dv.tel) flag('warn', '電話番号がありません');
    if (lim.name && EC.sjisLen(dv.name) > lim.name) flag('warn', '納品先名が長いため切れる可能性（' + EC.sjisLen(dv.name) + 'バイト）');
    if (lim.addr1 && EC.sjisLen(dv.addr1) > lim.addr1) flag('warn', '住所１が長いため切れる可能性（' + EC.sjisLen(dv.addr1) + 'バイト）');
    if (lim.addr2 && EC.sjisLen(dv.addr2) > lim.addr2) flag('warn', '住所２が長いため切れる可能性（' + EC.sjisLen(dv.addr2) + 'バイト）');
    if (dv.changed.length) flag('info', '文字を整えました（見えない文字・特殊な空白・機種依存文字）：' + dv.changed.join('／'));
    dv.issues.forEach(function (x) {
      flag('warn', '「' + x.ch + '」は' + (x.kind === 'dep' ? '機種依存文字' : 'Shift-JISにない文字') + 'で、配送会社の取込で化ける可能性があります。納品先を直してください');
    });
    (cfg.carriers || []).forEach(function (cr) {
      var nl = Array.from(dv.name).length, p1 = Array.from(dv.addr1).length, p2 = Array.from(dv.addr2).length;
      if (cr.nameChars && nl > cr.nameChars) flag('warn', cr.name + '：名称が' + cr.nameChars + '字を超えるとエラーになることがあります（' + nl + '字）');
      if (cr.addrCharsTotal && p1 + p2 > cr.addrCharsTotal) flag('warn', cr.name + '：住所が合計' + cr.addrCharsTotal + '字を超えるとエラーになることがあります（' + (p1 + p2) + '字）');
      if (cr.addrChars && (p1 > cr.addrChars || p2 > cr.addrChars)) flag('warn', cr.name + '：住所が' + cr.addrChars + '字を超えるとエラーになることがあります（住所１ ' + p1 + '字／住所２ ' + p2 + '字）');
    });
    if (o.ship.zip && EC.normZip(o.ship.zip).length !== 7) flag('warn', '郵便番号が7桁ではありません：' + o.ship.zip);
    if (o.fulfillment === 'fulfilled') flag('info', 'Shopify では発送済み');
    if (slip.inSmile) flag('info', 'SMILE に同じ注文番号の伝票があります（取込済み）');
    return slip;
  };

  /* ============================================================ 納品先 */
  EC.normName = function (s) { return norm(s).replace(/様$/, '').replace(/[\s　]/g, '').toLowerCase(); };
  EC.normZip = function (s) { return digits(s); };
  // SMILE の項目の長さ（半角1・全角2）。半角カナは1
  EC.sjisLen = function (str) { var n = 0; for (var i = 0; i < String(str || '').length; i++) { var c = str.charCodeAt(i); n += (c < 0x100 || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2; } return n; };
  function fmtPhone(p) {
    var d = digits(p);
    if (/^81/.test(d) && d.length >= 11) d = '0' + d.slice(2);
    if (d.length === 11) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
    if (d.length === 10) return /^0[36]/.test(d) ? d.slice(0, 2) + '-' + d.slice(2, 6) + '-' + d.slice(6) : d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return p || '';
  }
  EC.formatPhone = fmtPhone;

  /* ---------- 配送会社で化けやすい文字の整理 ----------
   * Shopify のコピペには、見えない文字（幅ゼロの空白など）や機種依存文字（①・㈱・髙 など）が混じることがある。
   * 配送会社（西濃運輸・第一貨物）への取込は Shift-JIS なので、次の順に整える：
   *   1) 見えない文字・制御文字・絵文字を除く、特殊な空白を普通の空白に
   *   2) 機種依存文字は、まず互換の文字に直す（①→1、㈱→(株)）。直らないものは設定の charMap（髙→高 など）で置き換える
   *   3) それでも Shift-JIS（JIS第1・第2水準）にない文字は、受注チェックで知らせる
   */
  var jisSet = null, cp932Set = null;
  function buildSets() {
    if (jisSet) return;
    jisSet = {}; cp932Set = {};
    var dec = new TextDecoder('shift_jis');
    for (var lead = 0x81; lead <= 0xFC; lead++) {
      if (lead > 0x9F && lead < 0xE0) continue;
      for (var tr = 0x40; tr <= 0xFC; tr++) {
        if (tr === 0x7F) continue;
        var ch = dec.decode(new Uint8Array([lead, tr]));
        if (ch.length !== 1 || ch === '\uFFFD') continue;
        cp932Set[ch] = 1;
        if ((lead >= 0x81 && lead <= 0x84) || (lead >= 0x88 && lead <= 0x9F) || (lead >= 0xE0 && lead <= 0xEA)) jisSet[ch] = 1;
      }
    }
  }
  // 'ok'＝そのまま使える／'dep'＝機種依存文字（Shift-JIS には入るが JIS 基本の外）／'out'＝Shift-JIS にない
  EC.charKind = function (ch) {
    buildSets();
    var c = ch.charCodeAt(0);
    if (ch.length === 1 && (c <= 0x7E || (c >= 0xFF61 && c <= 0xFF9F))) return 'ok';
    if (jisSet[ch]) return 'ok';
    if (cp932Set[ch]) return 'dep';
    return 'out';
  };
  EC.cleanText = function (str, cfg) {
    var map = (cfg && cfg.charMap) || {};
    // Windows の Shift-JIS（CP932）で別の字に化ける記号（波ダッシュ問題）を、CP932 側の字に直す
    var WIN = { '〜': '～', '‖': '∥', '¢': '￠', '£': '￡', '¬': '￢' };
    var t = String(str == null ? '' : str)
      .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F]/g, ' ')
      .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
      .replace(/ {2,}/g, ' ').trim();
    // ハイフンの揺れ（‐ ‑ – — ― − － ー など）をそろえる：前後が全角の英数なら「－」、それ以外は半角の「-」。
    // 「ー」「ｰ」（長音）は、前後が数字のときだけハイフンとみなす（コーヒー などはそのまま）
    var HY = /[‐-―−﹣－─]/, LV = /[ーｰ]/, DG = /[0-9０-９]/, FW = /[０-９Ａ-Ｚａ-ｚ]/;
    var arr = Array.from(t);
    return arr.map(function (ch, i) {
      var prev = arr[i - 1] || '', next = arr[i + 1] || '';
      if (HY.test(ch) || (LV.test(ch) && DG.test(prev) && DG.test(next))) return (FW.test(prev) || FW.test(next)) ? '－' : '-';
      if (WIN[ch]) return WIN[ch];
      if (EC.charKind(ch) === 'ok') return ch;
      if (map[ch] != null) return map[ch];
      if (EC.charKind(ch) === 'dep') {
        var n = ch.normalize('NFKC');
        if (n !== ch && Array.from(n).every(function (x) { return EC.charKind(x) === 'ok'; })) return n;
      }
      return ch;
    }).join('');
  };
  // Shift-JIS の基本（JIS第1・第2水準）の外にある文字：[{ch, kind}]
  EC.charIssues = function (str) {
    var seen = {}, out = [];
    Array.from(String(str || '')).forEach(function (ch) {
      var k = EC.charKind(ch);
      if (k !== 'ok' && !seen[ch]) { seen[ch] = 1; out.push({ ch: ch, kind: k }); }
    });
    return out;
  };
  function fmtZip(z) { var d = digits(z); return d.length === 7 ? d.slice(0, 3) + '-' + d.slice(3) : (z || ''); }

  // 配送先 → 納品先マスタの項目。個人は「お名前様」、会社は 納品先名＝会社名・荷受け人名１＝担当者様
  EC.deliveryFromOrder = function (o, cfg) {
    var fix = function (v) { return EC.cleanText(v, cfg); }, changed = [];
    var raw = o.ship, s = {};
    ['name', 'company', 'province', 'city', 'addr1', 'addr2'].forEach(function (k) {
      s[k] = fix(raw[k]);
      if (String(raw[k] || '').trim() !== s[k]) changed.push(raw[k] + ' → ' + s[k]);
    });
    s.zip = raw.zip; s.phone = raw.phone;
    var hasCo = !!s.company, nm = s.name;
    var parts = [s.province, s.city, s.addr1, s.addr2].filter(Boolean), built = '';
    parts.forEach(function (p) { if (built.indexOf(p) < 0) built += p; });
    var a1 = (s.province || '') + (s.city && (s.province || '').indexOf(s.city) < 0 ? s.city : '');
    if (a1 && built.indexOf(a1) !== 0) a1 = '';
    var a2 = a1 ? built.slice(a1.length) : '';
    if (!a1) { a1 = built; a2 = ''; }
    var d = {
      name: hasCo ? s.company : nm + '様', person: hasCo ? nm + '様' : '',
      zip: fmtZip(s.zip), addr1: a1, addr2: a2, tel: fmtPhone(s.phone || o.bill.phone || o.phone),
      key: EC.normName(hasCo ? s.company : nm) + '|' + EC.normZip(s.zip) + (hasCo ? '|' + EC.normName(nm) : ''),
      changed: changed
    };
    d.issues = EC.charIssues(d.name + d.person + d.addr1 + d.addr2);
    return d;
  };

  // 社内メモ：基本のメモ（花岡EC など）のあとに、担当者が追記した文を続ける
  EC.joinMemo = function (base, note, cfg) {
    note = String(note == null ? '' : note).replace(/[\r\n\t]+/g, ' ').trim();
    return note ? base + (cfg.memoJoin == null ? ' ' : cfg.memoJoin) + note : base;
  };

  // 納品先マスタ(CSV objects) → { '599802': { keys:{key:code}, max:'000770', used:{code:1} } }
  EC.indexDeliveryMaster = function (objs, cfg) {
    var out = {}, reserved = {};
    cfg.reservedDeliveryCodes.forEach(function (c) { reserved[c] = 1; });
    objs.forEach(function (r) {
      var cc = r['得意先ｺｰﾄﾞ'] || r['得意先コード'];
      if (!cfg.customers[cc]) return;
      var code = r['納品先ｺｰﾄﾞ'] || r['納品先コード'];
      if (!/^\d+$/.test(code)) return;
      var x = out[cc] || (out[cc] = { keys: {}, max: '000000', used: {} });
      x.used[code] = 1;
      if (!reserved[code] && code <= cfg.deliveryCodeLimit && code > x.max) x.max = code;
      var nm = r['納品先名'], per = r['荷受け人名１'] || '';
      var key = EC.normName(nm) + '|' + EC.normZip(r['郵便番号']) + (per ? '|' + EC.normName(per) : '');
      if (!(key in x.keys)) x.keys[key] = code;
    });
    Object.keys(cfg.customers).forEach(function (cc) { if (!out[cc]) out[cc] = { keys: {}, max: '000000', used: {} }; });
    return out;
  };

  // OKにした伝票（受注日順）に納品先コードを割り当てる。既存と同じお客様（名前＋郵便番号）は既存コード、なければ新規。
  EC.planDeliveries = function (slips, master, cfg, opts) {
    opts = opts || {};
    var reuse = opts.reuse !== false, reserved = {}, next = {}, created = {}, fresh = [];
    cfg.reservedDeliveryCodes.forEach(function (c) { reserved[c] = 1; });
    Object.keys(master).forEach(function (cc) { next[cc] = +master[cc].max; created[cc] = {}; });
    slips.slice().sort(function (a, b) { return a.orderDate === b.orderDate ? (+a.id - +b.id) : (a.orderDate < b.orderDate ? -1 : 1); }).forEach(function (s) {
      var d = EC.deliveryFromOrder(s.order, cfg), m = master[s.cust];
      s.delivery = d;
      if (reuse && m.keys[d.key]) { s.deliveryCode = m.keys[d.key]; s.deliveryNew = false; return; }
      if (reuse && created[s.cust][d.key]) { s.deliveryCode = created[s.cust][d.key]; s.deliveryNew = false; return; }
      do { next[s.cust]++; } while (reserved[pad(next[s.cust], 6)] || m.used[pad(next[s.cust], 6)]);
      var code = pad(next[s.cust], 6);
      created[s.cust][d.key] = code; m.used[code] = 1;
      s.deliveryCode = code; s.deliveryNew = true;
      fresh.push({ cust: s.cust, code: code, d: d, orderId: s.id });
    });
    return fresh;
  };

  /* ============================================================ 取込ファイル */
  EC.toSmileText = function (header, rows) {
    return [header].concat(rows).map(function (r) { return r.join('\t'); }).join('\r\n') + '\r\n';
  };
  // UTF-16LE（BOMつき）のバイト列
  EC.encodeUtf16 = function (text) {
    var buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xFF; buf[1] = 0xFE;
    for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); buf[2 + i * 2] = c & 0xFF; buf[3 + i * 2] = c >> 8; }
    return buf;
  };

  EC.nouhinRows = function (fresh, header, cfg) {
    return fresh.map(function (f) {
      var o = new Array(header.length).fill('');
      o[0] = f.cust; o[1] = f.code; o[2] = f.d.name; o[3] = ''; o[4] = f.d.person; o[5] = '';
      o[6] = f.d.zip; o[7] = f.d.addr1; o[8] = f.d.addr2; o[9] = ''; o[10] = ''; o[11] = f.d.tel; o[12] = '';
      o[15] = '0'; o[38] = '0'; o[39] = '1'; o[40] = '1';
      return o;
    });
  };

  function q2(n) { return Number(n).toFixed(2); }
  // 受注伝票（新規）。受注№ は仮番（取込画面で「新規に採番する」）。slips は deliveryCode / shipDate（最終）が入っていること
  EC.juchuRows = function (slips, header, cfg, cal) {
    cal = cal || EC.makeCalendar(cfg);
    var rows = [], seq = 0;
    slips.slice().sort(function (a, b) { return a.orderDate === b.orderDate ? (+a.id - +b.id) : (a.orderDate < b.orderDate ? -1 : 1); }).forEach(function (s) {
      seq++;
      var ship = EC.ymd(s.shipDate), po = digits(s.id);
      var mfg = EC.ymd(cal.prev(s.shipDate));
      s.lines.forEach(function (l, i) {
        var o = new Array(header.length).fill('');
        var made = String(l.teihai) === '1';
        var amt = Math.round(l.amountNet);
        var set = {
          0: EC.ymd(s.orderDate), 1: String(seq), 2: String(i + 1), 3: s.cust, 4: s.custName, 6: s.deliveryCode, 7: s.delivery.name,
          8: s.staff, 9: s.dept, 11: '0', 12: '1', 13: '1', 14: ship, 15: po, 16: cfg.warehouse, 17: l.code, 18: l.name,
          22: q2(l.qty), 23: l.unit, 24: q2(l.unitNet), 25: String(amt), 26: '0.00', 27: '0', 29: String(amt), 30: '0.0',
          31: '0', 33: '10.00', 34: '0', 35: '0', 36: '0', 37: '0', 38: '0', 39: '0', 40: '0', 41: '0', 42: '00000', 44: po,
          45: '00000', 49: '0', 50: '0', 52: '0', 54: s.memo, 56: '1', 58: '0000000', 59: '0', 60: '0', 71: '0', 93: '0',
          94: ship, 95: '0', 96: '1', 101: l.name, 105: ship, 106: made ? mfg : '0', 107: ship, 108: po, 109: made ? mfg : '0',
          110: made ? q2(l.qty) : '0.00', 111: l.teihai || '1', 112: '0'
        };
        Object.keys(set).forEach(function (k) { o[+k] = set[k]; });
        rows.push(o);
      });
    });
    return rows;
  };

  /* ============================================================ 入金（Shopify の入金 → 入金伝票）
   * 入金1回 × 得意先ごとに1伝票。1行目 振込（取引区分2・属性2）＝純額（通帳の額）、2行目 支払手数料（取引区分13・属性6）＝手数料。 */
  // transactions: payment_transactions_export / payouts: payouts_export（どちらも objects）
  // custOf(orderName) → 得意先コード（SMILE に注文があればその得意先。なければ注文日のルール）
  EC.groupPayouts = function (transactions, payouts, custOf) {
    var pay = {}, g = {};
    (payouts || []).forEach(function (p) { if ((p['Status'] || '') !== 'failed') pay[p['Payout Date']] = p; });
    transactions.forEach(function (t) {
      if (t['Type'] === 'transfer_failure') return;
      var d = t['Payout Date']; if (!d) return;
      var c = custOf(t['Order'] || '');
      var x = (g[d] = g[d] || {}); x = (x[c] = x[c] || { amount: 0, fee: 0, net: 0, orders: [] });
      x.amount += num(t['Amount']); x.fee += num(t['Fee']); x.net += num(t['Net']);
      x.orders.push(t['Order']);
    });
    return Object.keys(g).sort().map(function (d) {
      var total = Object.keys(g[d]).reduce(function (a, c) { return a + g[d][c].net; }, 0);
      var p = pay[d];
      return { date: d, bank: p ? num(p['Total']) : null, status: p ? p['Status'] : '', total: total, match: p ? num(p['Total']) === total : false,
        parts: Object.keys(g[d]).sort().map(function (c) { var x = g[d][c]; return { cust: c, amount: x.amount, fee: x.fee, net: x.net, orders: x.orders }; }) };
    });
  };
  EC.nyukinRows = function (groups, header, cfg) {
    var rows = [], seq = 0, idx = function (n) { return header.indexOf(n); };
    groups.forEach(function (gr) {
      gr.parts.forEach(function (p) {
        seq++;
        var ymd = gr.date.replace(/-/g, '');
        [['2', '2', p.net, 'SHOPIFY ' + gr.date.slice(5).replace('-', '/') + '入金 ' + p.orders.length + '件'], ['13', '6', p.fee, 'SHOPIFY 手数料']].forEach(function (x, i) {
          var o = new Array(header.length).fill('');
          var vals = { '伝票日付': ymd, '伝票№': '0', '処理連番': String(seq), '行': String(i + 1), '得意先コード': p.cust, '得意先名１': cfg.customers[p.cust].name, '得意先名２': '',
            '部門コード': cfg.customers[p.cust].dept, '取引区分': x[0], '取引区分属性': x[1], '入金額': String(x[2]), '決済予定日': '0', '備考コード': '00000', '備考': x[3], 'データ発生区分': '0', '相手処理連番': '0' };
          Object.keys(vals).forEach(function (k) { if (idx(k) >= 0) o[idx(k)] = vals[k]; });
          rows.push(o);
        });
      });
    });
    return rows;
  };

  root.EcSales = EC;
  if (typeof module !== 'undefined' && module.exports) module.exports = EC;
})(typeof window !== 'undefined' ? window : globalThis);
