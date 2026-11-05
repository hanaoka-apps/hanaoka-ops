/* ふるさと納税：サイネックスへの出荷報告（Excel と、メールの下書き）の中身を作る（画面や通信には依存しない。node でも試験できる）。
 * Excel は、サイネックスから届いた注文 CSV の行を、そのまま並べ、D 列（送り状番号）と E 列（出荷日）を埋めたもの。
 * 1 行目は見出し：D1 と E1 だけ（ほかは空）。2 行目からが、注文 CSV の行（各ファイルの No. 順）。
 * 使い方：FurusatoShipReport.build({ items: [{ order, ship }], conf }) → { aoa, widths, fileName, subject, bodyHtml, to, cc, dateLabel, count } */
(function (root) {
  'use strict';
  var NUM_COLS = { 0: 1, 1: 1, 2: 1, 5: 1, 6: 1, 20: 1 };   // 数値で持つ列（No.・受注番号・発注番号・2つの 0・数量）。それ以外は文字
  var SLIP_COL = 3, DATE_COL = 4;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var p2 = function (n) { return String(n).padStart(2, '0'); };

  // yyyy-mm-dd → 26.11.04（サイネックスの出荷日の書き方）
  function shortDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? m[1].slice(2) + '.' + m[2] + '.' + m[3] : ''; }
  // 2026-10-29 と 2026-11-04 → 「2026.10.29-11.04」、1日だけなら「2026.11.04」
  function dateLabel(dates) {
    var d = dates.filter(Boolean).sort();
    if (!d.length) return '';
    var a = d[0], b = d[d.length - 1], f = function (x) { return x.slice(0, 4) + '.' + x.slice(5, 7) + '.' + x.slice(8, 10); };
    if (a === b) return f(a);
    return a.slice(0, 4) === b.slice(0, 4) ? f(a) + '-' + b.slice(5, 7) + '.' + b.slice(8, 10) : f(a) + '-' + f(b);
  }

  function build(o) {
    var conf = (o.conf && o.conf.shipReport && o.conf.shipReport.mail) || {};
    var hd = conf.header || {}, items = o.items || [], rows = [], dates = [], width = 0;
    items.forEach(function (it) {
      var od = it.order || {}, sh = it.ship || {}, slip = (sh.slips || []).map(function (x) { return x.fmt; }).join('・'), when = shortDate(sh.shipDate);
      if (sh.shipDate) dates.push(sh.shipDate);
      (od.csvRows || []).forEach(function (r) {
        var cells = r.cells.map(function (v, i) {
          if (v === '' || v == null) return null;
          return NUM_COLS[i] && /^-?\d+$/.test(String(v)) ? Number(v) : String(v);
        });
        cells[SLIP_COL] = slip || null; cells[DATE_COL] = when || null;
        if (cells.length > width) width = cells.length;
        rows.push({ stamp: (od.createdAt || '') + ' ' + (od.createdTime || ''), no: Number(r.no) || 0, cells: cells });
      });
    });
    rows.sort(function (a, b) { return a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.no - b.no; });
    width = Math.max(width, 27);
    var head = []; for (var i = 0; i < width; i++) head.push(null);
    head[SLIP_COL] = hd.slip || '西濃運輸問合せ番号'; head[DATE_COL] = hd.date || '出荷日';
    var aoa = [head].concat(rows.map(function (r) { var c = r.cells.slice(); while (c.length < width) c.push(null); return c; }));
    var dl = dateLabel(dates), sub = function (t) { return String(t || '').replace(/\{date\}/g, dl); };
    var lines = [conf.greeting || '', ''].concat(conf.body || [], [''], conf.signature || []);
    return {
      aoa: aoa, widths: { 3: 42.3, 4: 52.1 }, count: rows.length, orders: items.length, dateLabel: dl,
      fileName: sub(conf.fileName || 'サイネックス出荷報告{date}分.xlsx'),
      subject: sub(conf.subject || '出荷報告　花岡車輛（株）　{date}分'),
      bodyHtml: '<div style="font-family:Yu Gothic,Meiryo,sans-serif;font-size:11pt">' + lines.map(function (l) { return l ? esc(l) : '&nbsp;'; }).join('<br>') + '</div>',
      to: conf.to || [], cc: conf.cc || []
    };
  }

  root.FurusatoShipReport = { build: build, shortDate: shortDate, dateLabel: dateLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.FurusatoShipReport;
})(typeof window !== 'undefined' ? window : globalThis);
