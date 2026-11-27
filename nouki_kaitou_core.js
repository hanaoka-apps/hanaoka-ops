/* ============================================================
   納期回答（試作）の計算部分（nouki_kaitou_core.js）
   ------------------------------------------------------------
   画面（nouki_kaitou.html）から使う。テストは tests/test_nouki_kaitou_core.cjs。

   ★数字の出どころ★
     フレーム         ：Teams の Excel「販売計画_管理表」の「引き当て」「注残・出荷明細」タブ
                        （工場が入れた計画・実績と、12/1 などの起点在庫から Excel が計算した見込み在庫）
     ハンドル・キャスター：FUJIN の納期確認のデータ（plan_ledger.json。SMILE の計画・手配・在庫から毎日作る）
     型式 → 部品と取数 ：FUJIN の納期確認のデータ（型式ごとの部品）と、Excel の注残（型式・フレーム・取数）

   ★「あと何台分」★
     部品ごとに「今日から先で、見込み在庫がいちばん少なくなるところ」÷ 取数（切り捨て）。
     型式としては、部品の中でいちばん少ないもの（ボトルネック）。

   ★「この台数がそろう日」★
     部品ごとに「その日から先、ずっと必要な数が残る」最初の日。
     型式としては、部品の中でいちばん遅い日。組立の日数（FUJIN の型式の LT・営業日）を足して出荷の目安にする。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NoukiCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FRAME_SHEET = '引き当て';
  var ORDER_SHEET = '注残・出荷明細';
  /* フレームの品目コード → Excel のフレーム名（Excel の「引き当て」の A 列の名前） */
  var FRAME_CODES = {
    '21061401000': 'DA', '21081901000': 'DG8', '21082001000': 'DG6', '21091801000': 'DH',
    '21062001000': 'DL', '21124001000': 'SA', '21125001000': 'SL'
  };
  var KLAB = { frame: 'フレーム', handle: 'ハンドル', caster: 'キャスター', product: '完成品' };

  /* ---------- 小さな道具 ---------- */
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').toUpperCase().replace(/[\s　]/g, '');
  }
  function num(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  function day0(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  /* Excel の日付の数字（シリアル値）→ 日付。文字の日付（2026/12/1）も受ける */
  function xlDate(v) {
    if (v instanceof Date) return day0(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(1899, 11, 30 + Math.floor(v));
    if (typeof v === 'string') {
      var m = v.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    return null;
  }
  function isoDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fromIso(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addBizDays(d, n) {
    var k = new Date(d), left = Math.ceil(n || 0);
    while (left > 0) { k.setDate(k.getDate() + 1); var w = k.getDay(); if (w !== 0 && w !== 6) left--; }
    return k;
  }

  /* ============================================================
     Excel（販売計画_管理表）を読む
     ws(name) は、シート名を渡すと「cell(行, 列) → 値」を返す関数を返すもの（0 始まり）。
     画面では SheetJS のブックから作る（下の fromSheetJS）。テストでは配列から作る。
     ============================================================ */
  function fromSheetJS(XLSX, wb) {
    return function (name) {
      var ws = wb.Sheets[name];
      if (!ws) return null;
      return function (r, c) { var x = ws[XLSX.utils.encode_cell({ r: r, c: c })]; return x ? x.v : null; };
    };
  }

  function parseWorkbook(sheet) {
    var H = sheet(FRAME_SHEET);
    if (!H) throw new Error('Excel に「' + FRAME_SHEET + '」のタブがありません');
    /* 3行目（r=2）の G 列（c=6）から右へ日付。日付でなくなったところが「4月以降」などの最後の列 */
    var dates = [], c = 6;
    while (c < 400) { var d = xlDate(H(2, c)); if (!d) break; dates.push(d); c++; }
    if (!dates.length) throw new Error('「' + FRAME_SHEET + '」の3行目に日付がありません');
    var afterCol = 6 + dates.length;
    var afterLabel = String(H(2, afterCol) || '').trim();
    var frames = {}, order = [];
    for (var r = 3; r < 300; r++) {
      var b = String(H(r, 1) || '');
      if (b.indexOf('完成') < 0 || b.indexOf('+') !== 0 && b.indexOf('＋') !== 0) continue;
      var name = String(H(r, 0) || '').trim();
      if (!name || frames[name]) continue;
      var row = function (rr) { var a = []; for (var j = 0; j < dates.length; j++) a.push(num(H(rr, 6 + j))); return a; };
      frames[name] = {
        name: name,
        start: xlDate(H(r, 2)),              // 起点日（C 列）
        stock0: num(H(r, 3)),                // 起点在庫（D 列。空なら未入力）
        make: row(r), used: row(r + 1), order: row(r + 2), stock: row(r + 3), atp: row(r + 4),
        after: afterLabel ? { label: afterLabel, order: num(H(r + 2, afterCol)), stock: num(H(r + 3, afterCol)), atp: num(H(r + 4, afterCol)) } : null
      };
      order.push(name);
    }
    if (!order.length) throw new Error('「' + FRAME_SHEET + '」にフレームのまとまりが見つかりません');
    var note = String(H(1, 3) || '').trim();
    var orders = [], O = sheet(ORDER_SHEET);
    if (O) {
      for (var i = 4; i < 3000; i++) {
        var fr = String(O(i, 0) || '').trim();
        if (!fr) { if (!String(O(i + 1, 0) || '').trim()) break; continue; }
        orders.push({
          frame: fr, ship: xlDate(O(i, 1)), model: String(O(i, 2) || '').trim(), cust: String(O(i, 3) || '').trim(),
          no: String(O(i, 4) == null ? '' : O(i, 4)).trim(), qty: num(O(i, 5)) || 0, per: num(O(i, 6)) || 1,
          need: num(O(i, 7)), note: String(O(i, 8) || '').trim()
        });
      }
    }
    /* 型式 → フレーム・取数（注残に出てきた組み合わせ） */
    var models = {};
    orders.forEach(function (o) {
    if (!o.model) return;
    var k = norm(o.model), m = models[k];
    if (!m) m = models[k] = { model: o.model, frame: o.frame, per: o.per, frames: [] };
    /* 同じ型式が複数のフレームを使う（例：DMBT2DX は DX のフレームと DMトレー）。フレームごとに取数を覚える */
    if (!m.frames.some(function (x) { return x.frame === o.frame; })) m.frames.push({ frame: o.frame, per: o.per });
  });
    return { dates: dates, frames: frames, frameOrder: order, orders: orders, models: models, note: note };
  }

  /* ---------- フレームの計算（Excel の値をそのまま使う） ---------- */
  function todayIndex(dates, today) {
    var t = day0(today).getTime();
    for (var i = 0; i < dates.length; i++) if (dates[i].getTime() >= t) return i;
    return dates.length;               // 表の期間を過ぎた
  }
  function frameInfo(FR, name, today) {
    var f = FR.frames[name];
    if (!f) return null;
    var T = todayIndex(FR.dates, today);
    /* 起点日（例 12/1）より前は Excel が空欄にするので、起点日からの数字を使う */
    var a = null;
    for (var i = T; i < FR.dates.length && a == null; i++) a = f.atp[i];
    if (a == null && f.after) a = f.after.atp;
    return { f: f, T: T, avail: a, noStock: f.stock0 == null };
  }
  /* need 枚がそろう最初の日。{ date, after:true（期間の外）}。そろわなければ null */
  function frameEarliest(FR, name, need, today) {
    var x = frameInfo(FR, name, today);
    if (!x) return null;
    for (var i = x.T; i < FR.dates.length; i++) {
      var v = x.f.atp[i];
      if (v != null && v >= need) return { date: FR.dates[i], i: i };
    }
    if (x.f.after && x.f.after.atp != null && x.f.after.atp >= need) return { date: null, after: true, label: x.f.after.label };
    return null;
  }

  /* ============================================================
     FUJIN の納期確認のデータ（plan_ledger.json）の計算
     FUJIN の画面（fujin/plan_ledger.html の calc）と同じ考え方。「計画・所要量込み」で見る。
     ============================================================ */
  function plCalc(PL, code, cache) {
    cache = cache || {};
    if (cache[code]) return cache[code];
    var r = PL.items[code];
    if (!r) return null;
    var N = PL.dates.length, T = PL.today;
    var inF = new Array(N).fill(0), outF = new Array(N).fill(0);
    r.ev.forEach(function (e) {
      var i = e[0], t = e[1], q = e[2], x = e[3];
      if ((t === 'conf' || t === 'req') && x && x.late && i < T) { if (t === 'req') outF[T] += q; else inF[T] += q; return; }
      if (i < T) return;
      if (t === 'req') outF[i] += q;
      else if (t === 'conf' || t === 'unc') inF[i] += q;
      else if (t === 'plan') inF[i] += Math.max(0, q - ((x && x.done) || 0));
    });
    var bal = new Array(N).fill(null), s = r.stock || 0;
    for (var i = T; i < N; i++) { s += inF[i] - outF[i]; bal[i] = s; }
    var atp = new Array(N).fill(null), mn = Infinity;
    for (var j = N - 1; j >= T; j--) { mn = Math.min(mn, bal[j]); atp[j] = Math.max(0, mn); }
    return (cache[code] = { inF: inF, outF: outF, bal: bal, atp: atp });
  }
  function plEarliest(PL, code, need, cache) {
    var c = plCalc(PL, code, cache);
    if (!c) return null;
    for (var i = PL.today; i < PL.dates.length; i++) if (c.atp[i] >= need) return { date: fromIso(PL.dates[i]), i: i };
    return null;
  }
  /* 部品の注残（その部品を使う型式の受注残。FUJIN の「ord」） */
  function plOrders(PL, code) {
    var r = PL.items[code];
    if (!r) return [];
    return r.ev.filter(function (e) { return e[1] === 'ord'; }).map(function (e) {
      var x = e[3] || {};
      return { ship: e[0] >= 0 ? fromIso(PL.dates[e[0]]) : null, model: x.p || '', cust: x.c || '', no: x.no || '',
               qty: x.q || 0, per: x.per || 1, need: e[2], due: x.due || '' };
    }).sort(function (a, b) { return (a.ship ? a.ship.getTime() : 0) - (b.ship ? b.ship.getTime() : 0); });
  }

  /* ---------- 型式の一覧（候補） ---------- */
  function modelList(FR, PL) {
    var m = {};
    if (PL) Object.keys(PL.models).forEach(function (k) {
      var x = PL.models[k];
      if (x.self) return;                 // 完成品（リフトなど）はここでは扱わない
      m[norm(k)] = { code: k, name: x.name || '' };
    });
    if (FR) Object.keys(FR.models).forEach(function (k) { if (!m[k]) m[k] = { code: FR.models[k].model, name: '' }; });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return a.code < b.code ? -1 : 1; });
  }
  function frameNameOf(PL, code, FR) {
    if (FRAME_CODES[code]) return FRAME_CODES[code];
    var nm = PL && PL.items[code] ? norm(PL.items[code].name) : '';
    var names = FR ? FR.frameOrder.slice().sort(function (a, b) { return b.length - a.length; }) : [];
    for (var i = 0; i < names.length; i++) if (nm.indexOf(norm(names[i])) >= 0) return names[i];
    return null;
  }

  /* ============================================================
     型式と台数から、回答を作る
     ============================================================ */
  function answer(FR, PL, input, qty, today) {
    qty = Math.max(1, Math.floor(qty || 1));
    var key = norm(input), plKey = null;
    if (PL) Object.keys(PL.models).some(function (k) { if (norm(k) === key) { plKey = k; return true; } return false; });
    var M = plKey ? PL.models[plKey] : null, frM = FR ? FR.models[key] : null;
    if (!M && !frM) return null;
    var cache = {}, parts = [], notes = [];
    var frameDone = false;
    if (M) M.parts.forEach(function (p) {
      var code = p[0], per = p[1], kind = p[2];
      if (kind === 'frame') {
        var fn = frameNameOf(PL, code, FR);
        if (fn && FR && FR.frames[fn]) { parts.push(framePart(FR, fn, per, qty, today, code)); frameDone = true; return; }
        notes.push('フレーム ' + code + ' は Excel の表にないため、FUJIN の数字で出しています');
      }
      parts.push(plPart(PL, code, per, kind, qty, cache));
    });
    /* Excel の注残に出てくるフレームのうち、まだ部品に入っていないものを足す（トレー付きの型式は 2 つ以上になる） */
  var covered = {};
  parts.forEach(function (p) { if (p.frame) covered[p.frame] = true; });
  if (frM && FR) (frM.frames || [{ frame: frM.frame, per: frM.per }]).slice().reverse().forEach(function (x) {
    if (!covered[x.frame] && FR.frames[x.frame]) { parts.unshift(framePart(FR, x.frame, x.per, qty, today, null)); covered[x.frame] = true; }
  });
    if (!parts.some(function (p) { return p.kind === 'frame'; })) notes.push('この型式のフレームが分かりません（Excel の注残にも FUJIN の型式の部品にも出てきません）');
    if (!M) notes.push('FUJIN の型式の部品に無いので、ハンドル・キャスターは出せません（フレームだけで判断しています）');

    /* まとめ */
    var units = null, neck = null, ready = null, ng = false, after = false;
    parts.forEach(function (p) {
      if (p.units != null && (units == null || p.units < units)) { units = p.units; neck = p; }
      if (!p.when) ng = true;
      else if (p.when.after) after = true;
      else if (!ready || p.when.date > ready) ready = p.when.date;
    });
    var lt = M ? (M.lt || 0) : 0;
    var ship = !ng && !after && ready ? addBizDays(ready, lt) : null;
    return { model: plKey || (frM && frM.model) || input, name: M ? M.name : '', qty: qty, parts: parts, units: units, neck: neck,
             ready: ready, ship: ship, lt: lt, ng: ng, after: after, notes: notes };
  }
  function framePart(FR, fn, per, qty, today, code) {
    var x = frameInfo(FR, fn, today), need = qty * per;
    return { kind: 'frame', label: 'フレーム ' + fn, frame: fn, code: code, per: per, need: need,
             avail: x.avail, units: x.avail == null ? null : Math.floor(Math.max(0, x.avail) / per),
             when: frameEarliest(FR, fn, need, today), noStock: x.noStock, src: 'Excel',
             orders: FR.orders.filter(function (o) { return o.frame === fn; }) };
  }
  function plPart(PL, code, per, kind, qty, cache) {
    var c = plCalc(PL, code, cache), need = qty * per, it = PL.items[code] || {};
    var avail = c ? c.atp[PL.today] : null;
    return { kind: kind, label: (KLAB[kind] || kind) + ' ' + (it.name || code), code: code, per: per, need: need,
             avail: avail, units: avail == null ? null : Math.floor(Math.max(0, avail) / per),
             when: plEarliest(PL, code, need, cache), src: 'FUJIN', orders: plOrders(PL, code) };
  }

  /* ============================================================
     見本データ（架空）。サインインせずに画面の動きを見るため。実在の型式・客先は使わない
     ============================================================ */
  function sample(today) {
    var t = day0(today), dates = [], i;
    var start = new Date(t.getFullYear(), t.getMonth(), 1);
    for (i = 0; i < 120; i++) dates.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    var T = todayIndex(dates, t);
    function frame(name, stock0, perDay, orderEvery, orderQty, shortAt) {
      var make = [], used = [], order = [], stock = [], atp = [], s = stock0;
      for (var j = 0; j < dates.length; j++) {
        var w = dates[j].getDay(), work = w !== 0 && w !== 6;
        var mk = work ? (shortAt && j > T + shortAt && j < T + shortAt + 10 ? 0 : perDay) : 0;
        var od = j >= T && work && (j % orderEvery === 0) ? orderQty : 0;
        var us = j < T && work ? Math.round(perDay * 0.8) : 0;
        make.push(mk); used.push(us); order.push(od);
        s = s + mk - (j < T ? us : od); stock.push(s);
      }
      var mn = Infinity;
      for (j = dates.length - 1; j >= 0; j--) { mn = Math.min(mn, stock[j]); atp[j] = j < T ? null : mn; }
      return { name: name, start: dates[0], stock0: stock0, make: make, used: used, order: order, stock: stock, atp: atp,
               after: { label: 'それ以降', order: 0, stock: stock[stock.length - 1], atp: stock[stock.length - 1] } };
    }
    var FR = {
      dates: dates, frameOrder: ['フレームA', 'フレームB'],
      frames: { 'フレームA': frame('フレームA', 40, 12, 3, 30, 0), 'フレームB': frame('フレームB', 5, 4, 4, 14, 6) },
      orders: [], models: {}, note: '見本データ（架空）'
    };
    var custs = ['見本商事', '例示物流', '架空運輸', 'サンプル空港サービス'];
    var mods = [['SAMPLE-100', 'フレームA', 1], ['SAMPLE-200', 'フレームA', 1], ['SAMPLE-300', 'フレームB', 2]];
    for (i = 0; i < 14; i++) {
      var m = mods[i % 3], q = 3 + (i * 7) % 12;
      FR.orders.push({ frame: m[1], ship: dates[Math.min(dates.length - 1, T + 2 + i * 3)], model: m[0], cust: custs[i % 4],
                       no: String(900100 + i), qty: q, per: m[2], need: q * m[2], note: '' });
    }
    mods.forEach(function (m) { FR.models[norm(m[0])] = { model: m[0], frame: m[1], per: m[2] }; });

    var PLd = [];
    for (i = -14; i < 100; i++) PLd.push(isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() + i)));
    var PT = 14;
    function item(code, name, kind, stock, plans, reqs) {
      var ev = [];
      plans.forEach(function (p) { ev.push([PT + p[0], 'plan', p[1], { firm: true, done: 0 }]); });
      reqs.forEach(function (p) { ev.push([PT + p[0], 'req', p[1], { p: p[2] }]); });
      FR.orders.forEach(function (o) {
        var useH = { 'SAMPLE-100': 1, 'SAMPLE-200': 1 };
        if (o.model && (kind !== 'handle' || useH[o.model])) {
          var per = kind === 'caster' ? 4 : 1, k = Math.round((o.ship - t) / 864e5);
          if (k >= 0 && k < 100) ev.push([PT + k, 'ord', o.qty * per, { p: o.model, c: o.cust, no: o.no, q: o.qty, per: per }]);
        }
      });
      return { code: code, name: name, kind: kind, stock: stock, ev: ev };
    }
    var PL = {
      asOf: isoDay(t), stockAsOf: isoDay(t), dates: PLd, today: PT,
      items: {
        'S-H01': item('S-H01', '見本ハンドル H1', 'handle', 25, [[5, 20], [20, 20], [40, 20]], [[3, 15], [12, 15], [30, 15], [50, 15]]),
        'S-C01': item('S-C01', '見本キャスター 自在', 'caster', 120, [[10, 200]], [[2, 60], [15, 80], [35, 80]]),
        'S-C02': item('S-C02', '見本キャスター 固定', 'caster', 30, [[25, 100]], [[4, 20], [18, 30]])
      },
      models: {
        'SAMPLE-100': { name: '見本台車 100', lt: 2, parts: [['S-H01', 1, 'handle'], ['S-C01', 4, 'caster']] },
        'SAMPLE-200': { name: '見本台車 200', lt: 3, parts: [['S-H01', 1, 'handle'], ['S-C01', 2, 'caster'], ['S-C02', 2, 'caster']] },
        'SAMPLE-300': { name: '見本台車 300', lt: 3, parts: [['S-C02', 4, 'caster']] }
      }
    };
    return { FR: FR, PL: PL };
  }

  /* ============================================================
     受注入力日・納期（Excel の注残には無いので、SMILE の 受注明細出力.csv から受注№で引く）
     ファイルは大きい（約90MB）ので全部は読まない。新しい受注ほど後ろにあるので、後ろから 8MB ずつ読み、
     要る受注№が全部見つかったらやめる（最大 48MB）。支払管理（ap_smile.js の juchuLookup）と同じ読み方。
     bytes(a, b)：ファイルの a〜b バイト目を Uint8Array で返す関数。size：ファイルの大きさ
     ============================================================ */
  function jno(s) { return String(s == null ? '' : s).replace(/"/g, '').trim().replace(/^0+/, ''); }
  function ymd(s) {
    s = String(s || '').replace(/"/g, '').trim();
    var m = s.match(/^(\d{4})[\/\-]?(\d{1,2})[\/\-]?(\d{1,2})$/);
    if (!m || s === '00000000' || s === '99999999') return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  async function juchuDates(bytes, size, nos, cache) {
    var need = new Set(Array.from(nos).map(jno).filter(function (n) { return n && !(n in cache); }));
    if (!need.size || !size) return cache;
    var h0 = await bytes(0, Math.min(size - 1, 65535)), bom = h0[0] === 0xEF && h0[1] === 0xBB && h0[2] === 0xBF;
    var enc = bom || new TextDecoder('utf-8').decode(h0.slice(0, 60000)).indexOf('\uFFFD') < 0 ? 'utf-8' : 'shift_jis';
    var cell = function (x) { return String(x || '').replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim(); };
    var hd = new TextDecoder(enc).decode(h0).split(/\r?\n/)[0].split('\t').map(cell);
    var pick = function (names) { for (var i = 0; i < names.length; i++) { var k = hd.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    var iNo = pick(['受注№', '受注No', '受注NO']), iD = pick(['受注日付', '受注日']), iDue = pick(['納期', '受注納期']);
    if (iNo < 0) return cache;
    var CH = 8 * 1024 * 1024, OV = 65536, end = size - 1;
    for (var k = 0; k < 6 && end > 0 && need.size; k++) {
      var start = Math.max(0, end - CH + 1);
      var ls = new TextDecoder(enc).decode(await bytes(start, Math.min(size - 1, end + OV))).split(/\r?\n/);
      if (start > 0) ls.shift();
      ls.forEach(function (l) {
        var c = l.split('\t'), n = jno(c[iNo]);
        if (n && need.has(n)) { cache[n] = { od: iD >= 0 ? ymd(c[iD]) : null, due: iDue >= 0 ? ymd(c[iDue]) : null }; need.delete(n); }
      });
      end = start - 1;
    }
    need.forEach(function (n) { cache[n] = null; });
    return cache;
  }

  return { norm: norm, jno: jno, ymd: ymd, juchuDates: juchuDates, xlDate: xlDate, isoDay: isoDay, fromIso: fromIso, addBizDays: addBizDays, fromSheetJS: fromSheetJS,
           parseWorkbook: parseWorkbook, todayIndex: todayIndex, frameInfo: frameInfo, frameEarliest: frameEarliest,
           plCalc: plCalc, plEarliest: plEarliest, plOrders: plOrders, modelList: modelList, answer: answer, sample: sample,
           FRAME_CODES: FRAME_CODES, KLAB: KLAB };
});
