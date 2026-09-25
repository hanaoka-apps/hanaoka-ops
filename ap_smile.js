/* ap_smile.js — SMILE の CSV から仕入の支払（振込・でんさい）を計算する部品
   データは持たない（公開リポジトリに置くため）。画面から読み込んだファイルの中身を渡して使う。

   使うファイル
     支払一覧表      … 今回支払残高（支払額のもと）。見出し行を自動で探す
     9055支払明細書  … 前回支払残高（支払一覧表と照合）・部門
     仕入先マスタ    … 支払設定・基準額・支払率・手形サイト・でんさい利用者番号・手数料区分
   分け方は「月末支払処理YYYYMM.xlsx」の「3.集計　支払一覧」の式と同じ（2026-08 分で1円まで一致を確認）。 */
(function (root) {
  'use strict';

  // ---- CSV ----
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  // 見出しの空白（全角も）を除いて比べる。同じ見出しが2つあるときは最初の列
  function key(s) { return String(s == null ? '' : s).replace(/[\s　]/g, ''); }
  function colIndex(header) {
    var m = {};
    header.forEach(function (h, i) { var k = key(h); if (!(k in m)) m[k] = i; });
    return function (name) { var k = key(name); return (k in m) ? m[k] : -1; };
  }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
  function code6(v) { var s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? s.padStart(6, '0') : s; }
  // Excel の ROUND（0.5 は 0 から遠い方へ）
  function round(x) { return x < 0 ? -Math.round(-x) : Math.round(x); }

  // ---- 仕入先マスタ ----
  function readVendorMaster(rows) {
    var ix = colIndex(rows[0]), out = {};
    function g(r, n) { var i = ix(n); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i], code = code6(g(r, '仕入先ｺｰﾄﾞ'));
      if (!code) continue;
      var dn = g(r, 'でんさい利用者番号').replace(/\D/g, '');
      out[code] = {
        code: code, name: g(r, '仕入先名略称') || g(r, '仕入先名１'),
        setting: g(r, '支払設定方法名１'),                         // 設定しない／基準額で設定／支払率で設定
        rateKbn1: g(r, '支払設定１　支払区分名１'), rate1: num(g(r, '支払設定１　支払率１')),
        rateKbn2: g(r, '支払設定１　支払区分名２'), rate2: num(g(r, '支払設定１　支払率２')),
        baseMethod1: g(r, '支払設定１　基準額設定　支払方法名１'),
        base: num(g(r, '支払設定１　基準額設定　基準額')),
        baseJudge: g(r, '支払設定１　基準額設定　基準額判断区分名'),  // 全額を／超過分を
        baseMethod2: g(r, '支払設定１　基準額設定　支払方法名２'),
        site: num(g(r, '手形サイト(日)')),
        torikime: g(r, '取決(C/海/ｻｲﾄ)'),
        feeKbn: g(r, '振込口座　振込手数料区分名'),                 // 自社負担／相手負担／固定
        densaiNo: dn ? dn.padStart(9, '0') : '',
        closeDay: num(g(r, '締日１')), payDay: num(g(r, '支払日１')), cycle: g(r, '支払ｻｲｸﾙ名１'),
        payCond: g(r, '支払条件名１')
      };
    }
    return out;
  }

  // ---- 9055 支払明細書 ----
  function read9055(rows) {
    var ix = colIndex(rows[0]), out = {};
    function g(r, n) { var i = ix(n); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i], code = code6(g(r, '仕入先ｺｰﾄﾞ'));
      if (!code) continue;
      out[code] = { code: code, name: g(r, '仕入先略称'), balance: num(g(r, '前回支払残高')),
        deptCode: g(r, '部門ｺｰﾄﾞ'), deptName: g(r, '部門名称'), staff: g(r, '担当者名称') };
    }
    return out;
  }

  // ---- 9521 受入リスト（仕入先ごとの税込と部門の内訳） ----
  function readReceipts(rows) {
    var ix = colIndex(rows[0]), out = {}, from = '', to = '';
    function g(r, n) { var i = ix(n); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); }
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i], code = code6(g(r, '仕入先ｺｰﾄﾞ'));
      if (!code) continue;
      var d = g(r, '伝票日付'); if (d) { if (!from || d < from) from = d; if (!to || d > to) to = d; }
      var incl = num(g(r, '税抜受入金額')) + num(g(r, '消費税等')), dept = g(r, '部門名称') || '(部門なし)';
      var v = out[code] || (out[code] = { code: code, name: g(r, '仕入先略称'), incl: 0, lines: 0, byDept: {} });
      v.incl += incl; v.lines++; v.byDept[dept] = (v.byDept[dept] || 0) + incl;
    }
    return { from: from, to: to, rows: out };
  }

  // ---- 支払一覧表 ----
  // SMILE の帳票の形（表題・「YYYY年 M月DD日締 今回支払分」・見出し「コード／仕入先名／…／今回支払残高」）
  function readPayList(rows) {
    var h = -1, title = '';
    for (var i = 0; i < Math.min(rows.length, 30); i++) {
      var ks = rows[i].map(key);
      if (!title) { var t = rows[i].join(' '); var m = t.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日締/); if (m) title = m[0]; }
      if (ks.indexOf('コード') >= 0 && ks.indexOf('仕入先名') >= 0 && ks.indexOf('今回支払残高') >= 0) { h = i; break; }
    }
    if (h < 0) throw new Error('支払一覧表の見出し（コード・仕入先名・今回支払残高）が見つかりません');
    var ix = colIndex(rows[h]), out = {}, total = null;
    function g(r, n) { var j = ix(n); return j < 0 ? '' : String(r[j] == null ? '' : r[j]).trim(); }
    for (var k = h + 1; k < rows.length; k++) {
      var r = rows[k], c = g(r, 'コード');
      if (/総合計/.test(r.join(''))) { total = { balance: num(g(r, '今回支払残高')), incl: num(g(r, '税込仕入額')) }; continue; }
      if (!/^\d+$/.test(c)) continue;
      var code = code6(c);
      // 支払予定日は「2026/09/末」の文字か、Excel の日付（シリアル値）で来る
      var pd = g(r, '支払予定日');
      if (/^\d{5}(\.\d+)?$/.test(pd)) { var dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(+pd) * 86400000); pd = dt.getUTCFullYear() + '/' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '/' + String(dt.getUTCDate()).padStart(2, '0'); }
      out[code] = { code: code, name: g(r, '仕入先名'), payDate: pd,
        prevBalance: num(g(r, '前回支払残高')), paid: num(g(r, '今回支払額')), discount: num(g(r, '値引調整額')),
        carry: num(g(r, '繰越残高')), excl: num(g(r, '税抜仕入額')), tax: num(g(r, '消費税額')),
        incl: num(g(r, '税込仕入額')), balance: num(g(r, '今回支払残高')) };
    }
    var ym = null, mm = title.match(/(\d{4})年\s*(\d{1,2})月/);
    if (mm) ym = mm[1] + '-' + String(mm[2]).padStart(2, '0');
    return { title: title, closeYm: ym, rows: out, total: total };
  }

  // ---- 決まり（支払管理サイトの AP_Setting「smile.rules」から setRules で渡す。正本は admin/defs/ap-smile-rules.json） ----
  var RULES = null;
  function setRules(r) {
    if (!r || !r.deptGroups || !r.fee || !r.siteRules || !r.rateThreshold) throw new Error('AP_Setting の smile.rules の形が違います');
    RULES = r;
  }
  function rules() { if (!RULES) throw new Error('決まり（AP_Setting の smile.rules）を読んでいません'); return RULES; }

  // ---- 分け方 ----
  // 仕入先マスタの支払設定で、金額を振込とでんさい（手形）に分ける
  function splitBySetting(amount, v) {
    var s = v ? v.setting : '', th = rules().rateThreshold;
    if (s === '支払率で設定') {
      if (amount > th) { var t = round(amount * v.rate1 / 100); return { transfer: t, densai: amount - t, rule: '率|' + (th / 10000) + '万超 ' + v.rateKbn1 + v.rate1 + '%' + v.rateKbn2 + v.rate2 + '%' }; }
      return { transfer: amount, densai: 0, rule: '率|' + (th / 10000) + '万以下は振込' };
    }
    if (s === '基準額で設定') {
      var lbl = '額|' + (v.base / 10000) + '万超' + v.baseJudge + (v.densaiNo ? 'でんさい' : '手形') + (v.torikime || '');
      return amount > v.base ? { transfer: 0, densai: amount, rule: lbl } : { transfer: amount, densai: 0, rule: lbl };
    }
    return { transfer: amount, densai: 0, rule: '振込' };
  }
  // 振込手数料（決まりの区分〔相手負担〕のときだけ引く）。段は「over より大きく under より小さい」（いまの Excel と同じく、ちょうど境目は 0）
  function transferFee(transfer, v) {
    var f = rules().fee;
    if (!v || v.feeKbn !== f.kbn) return 0;
    for (var i = 0; i < f.tiers.length; i++) { var t = f.tiers[i]; if (transfer > t.over && (t.under == null || transfer < t.under)) return t.fee; }
    return 0;
  }
  // でんさい・手形の期日：支払日の月末から、サイトごとの決まり [何か月後, 日（0＝月末）]
  function dueDate(payYm, site) {
    var r = rules().siteRules[String(site)]; if (!r || !payYm) return '';
    var y = +payYm.slice(0, 4), m = +payYm.slice(5, 7) - 1 + r[0];
    var d = r[1] ? new Date(y, m, r[1]) : new Date(y, m + 1, 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addMonth(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; var d = new Date(y, m, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  /* 計算する
     opt.payList   readPayList の結果（支払額のもと）
     opt.p9055     read9055 の結果。9055 の「前回支払残高」は支払締処理の前の残高なので、
                   支払一覧表の「前回支払残高」と照合する（2026-09 分で 132 社一致を確認）
     opt.receipts  readReceipts の結果（締め月の受入）。税込を支払一覧表の「税込仕入額」と照合する
     opt.master    readVendorMaster の結果
     opt.payYm     支払月（'2026-08'）。省略時は締め月の翌月
     opt.basis     'balance'＝今回支払残高（既定）／'incl'＝税込仕入額（いまの Excel と同じ）
     opt.adjust    { code: { offset:売買相殺(−), other:その他調整, transfer:振込の上書き, densai:でんさいの上書き } }
     戻り値 { rows, totals, checks } */
  function compute(opt) {
    var pl = opt.payList ? opt.payList.rows : {}, p55 = opt.p9055, ms = opt.master || {};
    var rc = opt.receipts ? opt.receipts.rows : null;
    var basis = opt.basis || 'balance', adj = opt.adjust || {};
    var payYm = opt.payYm || (opt.payList && opt.payList.closeYm ? addMonth(opt.payList.closeYm, 1) : '');
    var rows = [], checks = [], nameMap = p55 ? deptNameMap(p55) : {};
    // 支払一覧表にない仕入先（9055 に残高がある・受入がある）は、支払の行にせず気づきだけ出す
    var k;
    if (p55) for (k in p55) if (!pl[k] && p55[k].balance) checks.push({ code: k, name: p55[k].name, note: '支払一覧表にない（9055 の前回支払残高 ' + p55[k].balance.toLocaleString() + '）' });
    if (rc) for (k in rc) if (!pl[k] && rc[k].incl) {
      var mv = ms[k], why = mv && mv.torikime === '海' ? '（海外送金）' : (mv && mv.closeDay === 0 ? '（締日なし）' : '');
      checks.push({ code: k, name: rc[k].name, note: '受入があるが支払一覧表にない' + why + '：' + rc[k].incl.toLocaleString() });
    }
    Object.keys(pl).sort().forEach(function (code) {
      var L = pl[code], P = p55 ? p55[code] : null, R = rc ? rc[code] : null, v = ms[code], a = adj[code] || {};
      var base = basis === 'incl' ? L.incl : L.balance;
      var amount = base + (a.offset || 0) + (a.other || 0);
      // マイナス（端数の繰越だけ残った等）は払わない。SMILE の残高として次回に繰り越る
      var sp = amount > 0 ? splitBySetting(amount, v) : { transfer: 0, densai: 0, rule: '支払なし' };
      var transfer = (a.transfer != null && a.transfer !== '') ? +a.transfer : sp.transfer;
      var densai = (a.densai != null && a.densai !== '') ? +a.densai : sp.densai;
      var fee = transferFee(transfer, v);
      var kind = densai > 0 ? (v && v.densaiNo && v.densaiNo !== '000000000' ? 'でんさい' : '手形') : '';
      var row = { code: code, name: L.name || (P && P.name) || (v && v.name) || '',
        deptCode: P ? P.deptCode : '', deptName: P ? P.deptName : '',
        prevBalance: L.prevBalance, paid: L.paid, carry: L.carry, listIncl: L.incl, listBalance: L.balance,
        balance9055: P ? P.balance : null, receiptIncl: R ? R.incl : null, byDept: R ? R.byDept : {},
        payDate: L.payDate, payRound: payRoundOf(L.payDate), feeKbn: v ? v.feeKbn : '',
        base: base, offset: a.offset || 0, other: a.other || 0, amount: amount,
        rule: sp.rule, transfer: transfer, densai: densai, fee: fee, transferNet: transfer - fee,
        densaiKind: kind, site: v ? v.site : 0, due: densai > 0 && v ? dueDate(payYm, v.site) : '',
        overridden: (a.transfer != null && a.transfer !== '') || (a.densai != null && a.densai !== ''),
        notes: [] };
      var al = allocateDept(row, nameMap); row.deptByGroup = al.byGroup; row.mainDept = al.main;
      // 気づき
      if (!v) row.notes.push('仕入先マスタにない');
      if (p55 && !P) row.notes.push('9055 にない');
      if (P && P.balance !== L.prevBalance) row.notes.push('前回支払残高が 9055 と違う（一覧 ' + L.prevBalance.toLocaleString() + '／9055 ' + P.balance.toLocaleString() + '）');
      if (rc && Math.round((R ? R.incl : 0) - L.incl) !== 0) row.notes.push('税込仕入額が受入リストと違う（一覧 ' + L.incl.toLocaleString() + '／受入 ' + (R ? R.incl : 0).toLocaleString() + '）');
      if (L.carry) row.notes.push('繰越残高 ' + L.carry.toLocaleString() + (Math.abs(L.carry) < (rules().carrySmall || 100) ? '（端数）' : ''));
      if (row.overridden) row.notes.push('分け方を手で変えている');
      if (L.payDate && !/末$/.test(L.payDate)) row.notes.push('支払予定日が ' + L.payDate + '（月末以外）');
      if (amount > 0 && transfer + densai !== amount) row.notes.push('振込＋でんさいが支払額と合わない（差 ' + (amount - transfer - densai).toLocaleString() + '）');
      if (v) {
        if (densai > 0 && !row.due) row.notes.push('サイト ' + v.site + ' 日の期日の決まりがない');
        if (v.feeKbn === '固定') row.notes.push('手数料区分が「固定」');
        if (sp.transfer > 0 && v.setting === '基準額で設定' && v.baseMethod1 && v.baseMethod1 !== '振込') row.notes.push('基準額以下の支払方法が「' + v.baseMethod1 + '」');
        if (v.torikime === '海') row.notes.push('海外送金');
        if (v.payDay && v.payDay !== 30) row.notes.push('支払日が ' + v.payDay + ' 日');
      }
      if (amount < 0) row.notes.push('残高がマイナス（' + amount.toLocaleString() + '）→ 払わずに次回へ');
      rows.push(row);
      row.notes.forEach(function (n) { checks.push({ code: code, name: row.name, note: n }); });
    });
    var t = { count: 0, payable: 0, base: 0, offset: 0, other: 0, amount: 0, transfer: 0, fee: 0, transferNet: 0, densai: 0, tegata: 0 };
    rows.forEach(function (r) {
      if (r.amount > 0) { t.count++; t.payable += r.amount; }
      t.base += r.base; t.offset += r.offset; t.other += r.other; t.amount += r.amount;
      t.transfer += r.transfer; t.fee += r.fee; t.transferNet += r.transferNet;
      if (r.densaiKind === '手形') t.tegata += r.densai; else t.densai += r.densai;
    });
    if (opt.payList && opt.payList.total) {
      var sumBal = 0; for (k in pl) sumBal += pl[k].balance;
      if (sumBal !== opt.payList.total.balance) checks.unshift({ code: '', name: '', note: '支払一覧表の総合計（' + opt.payList.total.balance.toLocaleString() + '）と行の合計（' + sumBal.toLocaleString() + '）が違う' });
    }
    return { payYm: payYm, rows: rows, totals: t, checks: checks };
  }

  // ---- 決裁の部門（決まりの deptGroups：部門コードの先頭 prefix か、コードの一覧 codes。上から順に当てる） ----
  function deptGroupOf(deptCode) {
    var c = String(deptCode || ''), gs = rules().deptGroups;
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      if ((g.prefix && c.indexOf(g.prefix) === 0) || (g.codes && g.codes.indexOf(c) >= 0)) return g.group;
    }
    return rules().deptDefault || '総務';
  }
  // 9055 の「部門ｺｰﾄﾞ・部門名称」から、部門名 → 部門コード の表を作る（9521 は部門名しか持たない）
  function deptNameMap(p9055) {
    var m = {}; for (var k in p9055) { var p = p9055[k]; if (p.deptName && p.deptCode && !m[p.deptName]) m[p.deptName] = p.deptCode; }
    return m;
  }
  /* 案A：支払額を受入の部門内訳で按分する。端数・繰越の分は受入がいちばん多い部門へ。
     受入が無い（繰越だけ）ときは、9055 の仕入先の部門へ全額 */
  function allocateDept(row, nameMap) {
    var g = {}, total = 0, d;
    for (d in row.byDept) { var grp = deptGroupOf(nameMap[d]); g[grp] = (g[grp] || 0) + row.byDept[d]; total += row.byDept[d]; }
    var out = {};
    if (!total) { out[deptGroupOf(row.deptCode)] = row.amount; return { byGroup: out, main: deptGroupOf(row.deptCode) }; }
    var keys = Object.keys(g).sort(function (a, b) { return g[b] - g[a]; }), main = keys[0], sum = 0;
    keys.forEach(function (k) { if (k === main) return; out[k] = Math.floor(row.amount * g[k] / total); sum += out[k]; });
    out[main] = row.amount - sum;
    return { byGroup: out, main: main };
  }
  // 支払回：支払予定日が「…/末」なら月末、日付なら 10日／20日（それ以外は月末）
  function payRoundOf(payDate) {
    var m = String(payDate || '').match(/\/(\d{1,2})$/);
    if (!m) return '月末';
    var d = +m[1]; return d === 10 ? '10日' : d === 20 ? '20日' : '月末';
  }
  // 分け方（上書きがあればそれ、無ければ計算）を「方法・金額・サイト・期日」の行にする
  function splitLines(row, override, payYm) {
    if (override && override.length) return override.map(function (o) {
      var site = +o.site || 0, m = o.method;
      return { method: m, amount: +o.amount || 0, site: site, due: (m === 'でんさい' || m === '手形') ? dueDate(payYm, site) : '' };
    });
    var out = [];
    if (row.transfer) out.push({ method: '振込', amount: row.transfer, site: 0, due: '' });
    if (row.densai) out.push({ method: row.densaiKind || 'でんさい', amount: row.densai, site: row.site, due: row.due });
    return out;
  }

  root.APSmile = { setRules: setRules, deptGroupOf: deptGroupOf, deptNameMap: deptNameMap, allocateDept: allocateDept, payRoundOf: payRoundOf, splitLines: splitLines, transferFeeOf: function (t, feeKbn) { return transferFee(t, { feeKbn: feeKbn }); }, parseCSV: parseCSV, readVendorMaster: readVendorMaster, read9055: read9055, readReceipts: readReceipts, readPayList: readPayList,
    splitBySetting: splitBySetting, transferFee: transferFee, dueDate: dueDate, compute: compute };
})(typeof window !== 'undefined' ? window : this);
