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
    '.sv .rv{display:grid;grid-template-columns:minmax(240px,.7fr) minmax(0,1.8fr);gap:12px;height:72vh;min-height:420px}.sv .rl{overflow:auto;border:1px solid var(--line);border-radius:8px}.sv .rl td{white-space:normal;vertical-align:top;padding:6px 8px}.sv .rl tr{cursor:pointer}' +
    '.sv .rv{position:relative}.sv .rstrip{display:none}.sv .rv.mini{grid-template-columns:30px minmax(0,1fr)}' +
    '.sv .rv.mini .rstrip{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 0;border:1px solid var(--line);border-radius:8px;background:#f7f9fc;color:var(--sub);font-size:12px;cursor:pointer;user-select:none}.sv .rv.mini .rstrip:hover{background:var(--pri-l);color:var(--pri)}.sv .rstrip .vt{writing-mode:vertical-rl;letter-spacing:2px}' +
    '.sv .rv.mini .rl{position:absolute;left:0;top:0;bottom:0;width:min(360px,80%);z-index:6;background:#fff;box-shadow:6px 0 18px rgba(20,30,60,.18);transform:translateX(-104%);opacity:0;pointer-events:none;transition:transform .16s ease,opacity .16s ease}.sv .rv.mini.peek .rl{transform:none;opacity:1;pointer-events:auto}' +
    '.sv-full{position:fixed!important;inset:0;z-index:950;background:#eef1f6;padding:10px 16px;overflow:hidden}.sv-full .sv{height:100%}.sv .tabs{align-items:flex-end}.sv .tabs .fs-t,.sv .tabs .fx{border-radius:6px;border-bottom:1px solid var(--line);margin-bottom:4px;font-weight:600}' +
    '.sv .itabs{display:flex;gap:4px;margin:8px 0 6px;border-bottom:1px solid var(--line)}.sv .itabs button{border:none;border-bottom:2px solid transparent;border-radius:0;background:none;padding:4px 10px;color:var(--sub);font-weight:600}.sv .itabs button.on{color:var(--pri);border-bottom-color:var(--pri)}' +
    '.sv .tsum{margin-top:8px}.sv .tsum .tt{display:flex;align-items:center;margin-bottom:4px;font-size:13px}.sv .tsum .more{font-size:12px;padding:2px 8px}' +
    '.sv .dt.wide .di{display:flex;flex-direction:column;overflow:hidden!important}.sv .dt.wide .di>*{flex:none}.sv .dt.wide .ib{flex:1 1 auto;overflow:auto;min-height:0}' +
    '.sv .di{overflow-x:hidden}.sv .di td,.sv .di th{white-space:normal;overflow-wrap:anywhere}.sv .di td:first-child{white-space:nowrap}.sv .di td.n,.sv .di th.n{white-space:nowrap;word-break:normal}.sv .di .cmp td{white-space:nowrap}' +
    '.sv .parts{display:flex;align-items:stretch;gap:6px;flex-wrap:wrap;margin-bottom:8px;padding:6px 8px;background:#fff;border:1px solid var(--line);border-radius:10px}.sv .parts .pl{align-self:center;font-size:13px;color:var(--sub);margin-right:6px}' +
    '.sv .parts .pt{display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:5px 14px;border-radius:8px;min-width:130px}.sv .parts .pt.cur{border-color:var(--pri);box-shadow:inset 0 -3px 0 var(--pri);background:var(--pri-l)}.sv .parts .pa{font-size:12px;color:var(--sub)}.sv .parts .ps{font-size:11.5px;font-weight:700;color:var(--sub)}.sv .parts .ps.ok{color:var(--down)}.sv .parts .ps.run{color:var(--warn)}.sv .parts .ps.ret{color:var(--up)}' +
    '.sv .pn{margin-top:8px;border:1px solid var(--flag-l);background:#faf6fe;border-radius:8px;padding:6px 9px;font-size:13px}.sv .pnh{font-size:11.5px;font-weight:700;color:var(--flag);margin-bottom:3px}.sv .pni{display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}.sv .pni .pw{font-weight:600;color:var(--sub);font-size:12px}' +
    '.sv .lt{margin-left:auto}.sv table.ln tr:not(.lm) td{border-bottom:none}.sv table.ln tr.lm td{white-space:normal;font-size:12px;color:var(--sub);padding-top:0}' +
    '.sv .dl{display:flex;flex-direction:column;min-height:0;flex:1 1 auto!important}.sv .dl .chips:empty{display:none}.sv .dl .chips{margin-top:8px}.sv .di{min-width:0}' +
    '.sv .dt.wide .db{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,1fr);gap:12px;overflow:hidden;padding:8px}.sv .dt.wide .dl{order:0;min-height:0}.sv .dt.wide .di{order:1;overflow:auto;min-height:0;padding-right:4px}' +
    '.sv .dt.wide .dl .chips{margin-top:0;margin-bottom:6px}.sv .dt.wide .pdf{margin-top:0;min-height:0}.sv .dt.wide .hd{flex-direction:column;align-items:stretch}.sv .dt.wide .cmp{width:100%}.sv .dt.wide .kv{grid-template-columns:84px minmax(0,1fr)}.sv .dt.wide table.ln td,.sv .dt.wide table.ln th{padding:4px 5px}' +
    '.sv .mth{display:inline-block;font-size:11px;font-weight:700;padding:0 7px;border-radius:9px;border:1px solid;margin-right:5px;line-height:17px}.sv .mth.big{font-size:15px;padding:3px 14px;border-radius:999px;line-height:20px;margin-right:0}' +
    '.sv .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.sv .mrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sv .mrow .when{font-size:13px;font-weight:600}' +
    '.sv .cmp{width:auto;border:1px solid var(--line);border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden;font-size:13px;flex:none}.sv .cmp th{padding:2px 10px;font-size:11px}.sv .cmp td{padding:3px 10px;border-bottom:1px solid var(--line)}.sv .cmp tr:last-child td{border-bottom:none}.sv .cmp tr.now td{font-size:20px;font-weight:700;background:#fafbfd}.sv .cmp small{font-size:11px;font-weight:400}' +
    '.sv .rl tr.ok{background:#f6fbf7}.sv .rl tr.hold{background:#fffaf2}.sv .rl tr.sel{background:var(--pri-l);box-shadow:inset 3px 0 0 var(--pri)}.sv .rl .nm{font-weight:600}.sv .rl .s{font-size:11.5px;color:var(--sub)}' +
    '.sv .dt{border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;min-width:0;overflow:hidden}.sv .dn,.sv .da{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fafbfd;border-bottom:1px solid var(--line)}.sv .da{border-top:1px solid var(--line);border-bottom:none}' +
    '.sv .sp{flex:1}.sv .db{flex:1;overflow:auto;padding:8px 12px;display:flex;flex-direction:column;min-height:0}.sv .db>*{flex:none}.sv .kv{display:grid;grid-template-columns:84px minmax(0,1fr) 84px minmax(0,1fr);gap:2px 10px;font-size:13px;margin:6px 0}.sv .kv .k{color:var(--sub)}' +
    '.sv .pdf{flex:1 1 auto!important;min-height:300px;border:1px dashed var(--line);border-radius:8px;margin-top:6px;background:#fafbfd;display:flex;align-items:center;justify-content:center;color:var(--sub);overflow:hidden}.sv .pdf iframe{width:100%;height:100%;min-height:300px;border:0}.sv .pdf .imgv{width:100%;height:100%;overflow:auto;text-align:center}' +
    '.sv button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:4px 11px;cursor:pointer;font:inherit}.sv button.pri{background:var(--pri);border-color:var(--pri);color:#fff}.sv .chip.on{background:var(--pri);color:#fff;border-color:var(--pri)}' +
    // 請求書の明細（AI が読んだもの）：右端の縦のバー → ドロワー（右の列にかぶせる・PDF との境まで）。燃料の単価の表（サマリー）
    '.sv .pdf.tbl table.ln tr:not(.h1):not(.h2) td{border-bottom:1px solid #eef0f4}.sv .pdf.tbl table.ln tr:not(.h1):not(.h2):hover td{box-shadow:inset 0 0 0 999px rgba(35,38,143,.06)}' +
    '.sv .plist{width:100%;border-collapse:collapse;font-size:13px}.sv .plist th{font-size:11.5px;color:var(--sub);text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-weight:600}.sv .plist th.n,.sv .plist td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sv .plist td{padding:5px 8px;border-bottom:1px solid #eef0f5;vertical-align:top}.sv .plist tr[data-k]{cursor:pointer}.sv .plist tr[data-k]:hover td{background:#f5f7ff}.sv .plist tr.pg td{background:#eef2f8;font-size:12px;font-weight:700;color:#3a4252}.sv .plist .s{font-size:11px;color:var(--sub)}' +
    '.sv .kd{display:inline-block;font-size:11px;font-weight:700;padding:0 6px;border-radius:4px;margin-right:4px;vertical-align:1px}.sv .kd.sp{background:#e8f0fe;color:#1d4ed8}.sv .kd.ex{background:#e7f6ec;color:#067647}' +
    '.sv .rl tr.kgrp td{position:sticky;top:0;z-index:1;background:#eef2f8;font-size:12px;font-weight:700;color:#3a4252;padding:5px 8px;cursor:default}.sv .rl tr.kgrp .s2{font-weight:400;color:var(--sub);margin-left:6px}.sv .rl tr[data-k]:not(.sel):hover{background:#f5f7fc}' +
    '.sv .dstrip{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:6px 10px;margin-bottom:6px;border:1px solid var(--line);border-radius:8px;background:#fafbfd;font-size:13px}' +
    '.sv .dstrip .pn{font-size:16px;font-weight:700}.sv .dstrip .am{font-size:18px;font-weight:700}.sv .dstrip .s2{font-size:12px;color:var(--sub)}.sv .dt.wide.tblmode .db{grid-template-columns:minmax(0,1fr)}.sv .dt.wide.tblmode .di{display:none}' +
    '.sv .pdf.tbl table.ln tr.h1 th{position:sticky;top:-10px;z-index:3;background:#fff;box-shadow:0 1px 0 var(--line)}.sv .pdf.tbl table.ln tr.h2 th{position:sticky;top:12px;z-index:3;background:#fff;box-shadow:0 1px 0 var(--line)}' +
    '.sv .ln.smonly .cI,.sv .ln.smonly .cD{display:none}.sv .ln .jd{border-left:2px solid #9aa4b8}.sv .ln th.grp{font-size:11px;color:var(--sub);text-align:left;border-bottom:1px solid var(--line);padding-bottom:2px}' +
    '.sv .pdf.tbl{display:block!important;overflow:auto;padding:10px 12px;background:#fff;color:inherit;text-align:left;border-style:solid}.sv .pdf.tbl .svdr-x{display:none}.sv .cS{background:#eef4ff}.sv .cI{background:#fff4e5}.sv th.cS{color:#1d4ed8}.sv th.cI{color:#b45309}.sv .mleg{display:inline-flex;gap:6px;font-size:11.5px}.sv .mleg i{font-style:normal;padding:0 7px;border-radius:4px}.sv .mleg .cS{color:#1d4ed8}.sv .mleg .cI{color:#b45309}' +
    '.sv .dt{position:relative}.sv .dt.hasit .db{padding-right:34px}.sv .svdr{position:absolute;right:0;top:0;bottom:0;z-index:30;display:flex;flex-direction:row-reverse;align-items:stretch;pointer-events:none}' +
    '.sv .svdr-bar{pointer-events:auto;writing-mode:vertical-rl;width:26px;padding:12px 0;border:0;border-radius:8px 0 0 8px;background:var(--navy,#23268f);color:#fff;font-size:12.5px;font-weight:600;letter-spacing:.12em;cursor:pointer}.sv .svdr-bar.pin{background:#161a6b}' +
    '.sv .svdr-p{pointer-events:auto;box-sizing:border-box;width:480px;background:#fff;box-shadow:-8px 0 28px rgba(20,24,60,.22);border-radius:10px 0 0 10px;overflow:auto;padding:12px 14px;transform:translateX(104%);opacity:0;visibility:hidden;transition:transform .18s,opacity .18s,visibility 0s .18s}' +
    '.sv .svdr.open .svdr-p{transform:none;opacity:1;visibility:visible;transition:transform .18s,opacity .18s}.sv .svdr-p table{width:100%}.sv .svdr-p td,.sv .svdr-p th{font-size:12.5px;padding:4px 6px;vertical-align:top}.sv .svdr-p .s{font-size:11px;color:var(--sub)}' +
    '.sv .svsum{display:grid;grid-template-columns:1.35fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px}.sv .svsum>div{background:#f6f8fb;border-radius:8px;padding:7px 9px;min-width:0}.sv .svsum .l{font-size:12px;color:var(--sub)}.sv .svsum .v{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}.sv .svsum .s{font-size:11.5px;color:var(--sub)}' +
    '.sv .svsum .pay{background:var(--navy,#23268f);color:#fff}.sv .svsum .pay .l,.sv .svsum .pay .s{color:rgba(255,255,255,.85)}.sv .svsum .pay .v{font-size:24px;color:#fff}.sv .svsum .pay .v small{font-size:12px;font-weight:600}.sv .svsum .bad .v{color:var(--up,#c0392b)}.sv .svsum .good .v{color:var(--down,#17703f)}' +
    '.sv table.fuel{width:auto}.sv table.fuel td,.sv table.fuel th{padding:4px 9px;white-space:nowrap}.sv .f-lo{background:#e3f4ea;color:#17703f;font-weight:700}.sv .f-hi{background:#fde6e6;color:#b42318;font-weight:700}.sv .f-sq{font-style:italic}' +
    '.sv input[type=search],.sv select{width:auto;max-width:100%;padding:4px 8px}.sv input[type=search]{width:220px}.sv .tb td,.sv .tb th{font-size:13px}' +
    '@media (max-width:900px){.sv .rv,.sv .rv.mini{grid-template-columns:1fr;height:auto!important}.sv .rv.mini .rstrip,.sv .lt{display:none!important}.sv .rv.mini .rl{position:static;transform:none;opacity:1;pointer-events:auto;width:auto;box-shadow:none}.sv .rl{max-height:40vh}.sv .pdf{min-height:420px}}';
  function css() { if (document.getElementById('sv-css')) return; var s = document.createElement('style'); s.id = 'sv-css'; s.textContent = CSS; document.head.appendChild(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function yen(n) { return Math.round(Number(n) || 0).toLocaleString('ja-JP'); }
  function man(n) { return Math.round((Number(n) || 0) / 10000).toLocaleString('ja-JP') + '万'; }
  function diff(cur, prev) { if (!prev) return '<span style="color:#c3c9d6">—</span>'; var d = cur - prev, p = Math.round(d / prev * 100);
    return '<span class="' + (d > 0 ? 'd-up' : d < 0 ? 'd-down' : '') + '">' + (d > 0 ? '▲' : d < 0 ? '▼' : '±') + man(Math.abs(d)) + '（' + (p > 0 ? '+' : '') + p + '%）</span>'; }
  function keyOf(x, i) { return x.key || (x.no || x.payee) + '#' + i; }   // key：呼ぶ側が決める（ハナオカ：支払の行 ID）
  // 特記＝総務が付けた印・コメント。気づき＝自動（初めて・前月から大きく増えた・振込先が変わった・相殺・先行支払）
  function tags(x) { var t = [];
    if (x.flag) t.push(['特記', 't-flag']);
    if (x.amount >= RULE.newMin && !x.prev1 && !x.prev2) t.push(['初めて', 't-new']);
    else if (x.prev1 && x.amount - x.prev1 >= RULE.upMin && x.amount >= x.prev1 * RULE.upRate) t.push(['前月の' + (Math.round(x.amount / x.prev1 * 10) / 10) + '倍', 't-up']);
    if (x.bankChange) t.push(['振込先が変わった', 't-up']);
    if (/相殺/.test(x.method || '')) t.push(['相殺', 't-new']);
    if (x.prepaid) t.push(['先行支払済', 't-new']);
    if (x.smile && x.smile.held) t.push(['繰越保留', 't-new']);
    (x.tags || []).forEach(function (a) { t.push(a); });   // 呼ぶ側の気づき [[文字, 't-new' など], …]
    return t; }
  var MINI = { on: (function () { try { return localStorage.getItem('settle.listMini') === '1'; } catch (e) { return false; } })(), set: function (v) { this.on = v; try { localStorage.setItem('settle.listMini', v ? '1' : ''); } catch (e) {} } };
  // 全画面は覚えない（開くたびに通常の画面から。ユーザー 2026-11-08）。全画面から承認して次のパートを開くときだけ続ける（carry）
  var FULL = { on: false, carry: false, set: function (v) { this.on = v; } };
  try { localStorage.removeItem('settle.full'); } catch (e) {}
  var MEM = {};   // storeKey → 画面の状態（描き直しても選んだ明細・請求書を保つ）
  // 支払方法：色分けした札（big＝詳細の見出し用）
  var MCOL = { '振込': ['#1a5fa8', '#e3edf9'], '総合振込': ['#1a5fa8', '#e3edf9'], 'でんさい': ['#7a3db8', '#f1e8fb'], '手形': ['#7a3db8', '#f1e8fb'], '口座振替': ['#1e8449', '#e3f4e8'],
    '納税': ['#a0520c', '#fdf0e1'], '現金': ['#5b6478', '#eceff4'], '海外送金': ['#0f7c86', '#e0f4f5'], '相殺': ['#a0520c', '#fdf0e1'] };
  function mth(m, big) { if (!m) return ''; var c = MCOL[m] || MCOL[String(m).split(/[・ ]/)[0]] || ['#5b6478', '#eceff4'];
    return '<span class="mth' + (big ? ' big' : '') + '" style="color:' + c[0] + ';background:' + c[1] + ';border-color:' + c[0] + '33">' + esc(m) + '</span>'; }
  // 前月・前々月との比べ：金額と差（円・%）を並べる
  function whatOf(x) { var seen = {}, out = [];
    (x.lines || []).forEach(function (l) { var t = String(l.memo || '').trim() || String(l.note || '').replace(/^No\.\S+\s*/, '').trim(); if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out; }
  function gross(x) { return Math.round((+x.amount || 0) + (+x.fee || 0)); }
  function cmp(x) {
    var d = function (a, b) { if (!b) return '<td class="n" style="color:#c3c9d6">—</td>'; var v = a - b, p = Math.round(v / b * 100);
      return '<td class="n ' + (v > 0 ? 'd-up' : v < 0 ? 'd-down' : '') + '">' + (v > 0 ? '+' : v < 0 ? '−' : '±') + yen(Math.abs(v)) + '<small>（' + (p > 0 ? '+' : '') + p + '%）</small></td>'; };
    return '<table class="cmp"><tr><th></th><th class="n">金額</th><th class="n">今回との差</th></tr>' +
      (x.fee ? '<tr class="now"><td>支払額</td><td class="n">' + yen(gross(x)) + '</td><td class="n" style="font-size:11px;color:var(--sub)">SMILE・請求書と比べる額</td></tr>' +
        '<tr><td>今回の振込額</td><td class="n">' + yen(x.amount) + '</td><td class="n" style="font-size:11px;color:var(--sub)">手数料 ' + yen(x.fee) + ' 円（先方負担）を引く</td></tr>'
        : '<tr class="now"><td>今回</td><td class="n">' + yen(x.amount) + '</td><td></td></tr>') +
      '<tr><td>前月</td><td class="n">' + (x.prev1 ? yen(x.prev1) : '—') + '</td>' + d(x.amount, x.prev1) + '</tr>' +
      '<tr><td>前々月</td><td class="n">' + (x.prev2 ? yen(x.prev2) : '—') + '</td>' + d(x.amount, x.prev2) + '</tr></table>'; }
  // 補足メモ：承認・差し戻しのコメントの「【明細】」の下の「・支払先 金額円【保留】：メモ」を、支払先＋金額で明細につなぐ
  function nk(x) { return String(x.payee || '').trim() + '|' + Math.round(+x.amount || 0); }
  function prevNotes(hist, nameOf) { var out = {};
    hist.forEach(function (h) { var c = String(h.comment || ''), i = c.indexOf('【明細】'); if (i < 0) return;
      c.slice(i + 4).split(/\r?\n/).forEach(function (ln) { var m = ln.match(/^・(.+) ([\d,]+)円(【保留】)?(?:：([\s\S]*))?$/); if (!m) return;
        var k = m[1].trim() + '|' + Number(m[2].replace(/,/g, '')); (out[k] = out[k] || []).push({ who: h.by && h.by !== 'system' ? nameOf(h.by) : '', step: h.step || '', type: h.type || '', at: h.at || '', hold: !!m[3], memo: m[4] || '' }); }); });
    return out; }
  function notesHtml(ns) { if (!ns || !ns.length) return '';
    return '<div class="pn"><div class="pnh">これまでの補足メモ</div>' + ns.map(function (n) { return '<div class="pni"><span class="pw">' + esc(n.who) + (n.step ? '（' + esc(n.step) + '）' : '') + '</span>' + (n.hold ? '<span class="tag t-new">保留</span>' : '') + '<span>' + esc(n.memo) + '</span></div>'; }).join('') + '</div>'; }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function mount(el, o) {
    css(); if (!FULL.carry) FULL.on = false; FULL.carry = false;
    var snap = o.snap, rows = (snap.rows || []).map(function (x, i) { return Object.assign({ _k: keyOf(x, i) }, x); });
    // o.state を渡すと、確認OK・保留・コメントはそれを使い、変わるたびに o.onChange(state) を呼ぶ（ハナオカ：SharePoint に保存して共有）。無ければ今までどおりブラウザに残す
    var NOTES = prevNotes(o.history || [], o.nameOf || function (x) { return x; });
    var S = o.state ? Object.assign(o.state, { checks: o.state.checks || {}, comments: o.state.comments || {} }) : Object.assign({ checks: {}, comments: {} }, load(o.storeKey)), ui = MEM[o.storeKey] || (MEM[o.storeKey] = { tab: 'rev', sel: null, only: '', sort: snap.sort || 'amount', q: '', pdf: {}, cache: {} }), placed = false;   // placed：この表示で一度だけ明細のカードまでスクロールする
    if (o.select) { ui.sel = o.select; ui.tab = 'rev'; ui.only = ''; }   // 呼ぶ側から「この明細を見せて」（気づきを押したとき）
    function persist() { if (o.onChange) o.onChange(S); else save(o.storeKey, { checks: S.checks, comments: S.comments }); state(); }
    function state() { var ok = rows.filter(function (x) { return S.checks[x._k] === 'ok'; }).length, hold = rows.filter(function (x) { return S.checks[x._k] === 'hold'; }).length;
      if (o.onState) o.onState({ ok: ok, total: rows.length, hold: hold }); }
    function list() { var a = rows.slice();
      if (ui.q) { var nq = function (s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s　]/g, '').replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 96); }); }, q = nq(ui.q); a = a.filter(function (x) { return nq(x.payee + ' ' + (x.note || '')).indexOf(q) >= 0; }); }   // 全角・半角のカナなどを区別しない
      if (ui.only === 'sp' || ui.only === 'ex') a = a.filter(function (x) { return (x.kind === '経費') === (ui.only === 'ex'); });
      if (ui.only === 'flag') a = a.filter(function (x) { return tags(x).length; });
      if (ui.only === 'unck') a = a.filter(function (x) { return S.checks[x._k] !== 'ok'; });
      if (ui.only === 'hold') a = a.filter(function (x) { return S.checks[x._k] === 'hold'; });
      if (ui.sort === 'amount') a.sort(function (x, y) { return y.amount - x.amount; });
      else if (ui.sort === 'diff') a.sort(function (x, y) { return (y.amount - (y.prev1 || 0)) - (x.amount - (x.prev1 || 0)); });
      // 仕入と経費は分けて並べる（一覧に見出しを付ける。中の順は選んだ並び）。Array.sort は安定なので、上の並びを保つ
      var kOrd = function (x) { return x.kind === '経費' ? 1 : 0; }; a.sort(function (x, y) { return kOrd(x) - kOrd(y); });
      return a; }
    function render() {
      var ok = rows.filter(function (x) { return S.checks[x._k] === 'ok'; }).length;
      var full = FULL.on && window.innerWidth > 900, done = o.canAct && ok === rows.length && rows.length;
      el.classList.toggle('sv-full', full); lock(full);
      el.innerHTML = '<div class="sv">' + partsHtml() + '<div class="tabs"><button data-t="sum" class="' + (ui.tab === 'sum' ? 'on' : '') + '">📊 サマリー</button><button data-t="rev" class="' + (ui.tab === 'rev' ? 'on' : '') + '">📄 明細（確認 ' + ok + '／' + rows.length + '）</button>' +
        '<span class="sp"></span>' + (full && done ? '<button class="pri fx" style="margin-bottom:4px">' + (o.onApprove ? '✔ すべて確認しました → このパートを承認する' : '✔ すべて確認しました → 閉じて承認へ') + '</button>' : '') +
        (o.noReport ? '' : '<button class="fs-p" title="支払明細表（経費・仕入の画面と同じ形）を印刷・PDF に" style="margin-bottom:4px">🖨 支払明細表</button>') +
        '<button class="fs-t" title="' + (full ? '元の画面に戻す（Esc）' : 'このカードだけを画面いっぱいに出す') + '" style="margin-bottom:4px">' + (full ? '✕ 全画面を閉じる' : '⛶ 全画面') + '</button></div><div class="pane"></div></div>';
      var pane = el.querySelector('.pane');
      if (ui.tab === 'sum') summary(pane); else review(pane);
      // 全画面のサマリーは中だけスクロール（全画面は外側が動かないので、取引先一覧の下が見えなかった）
      if (ui.tab === 'sum' && full) { pane.style.overflowY = 'auto'; pane.style.maxHeight = Math.max(200, window.innerHeight - pane.getBoundingClientRect().top - 12) + 'px'; }
      el.querySelectorAll('[data-t]').forEach(function (b) { b.onclick = function () { ui.tab = b.dataset.t; render(); }; });
      if (el.querySelector('.fs-p')) el.querySelector('.fs-p').onclick = function () { printReport(snap); };
      el.querySelector('.fs-t').onclick = function () { FULL.set(!FULL.on); render(); };
      el.querySelectorAll('[data-part]').forEach(function (b) { b.onclick = function () { var pt = (o.parts || [])[+b.dataset.part]; if (pt && !pt.cur) pt.open(); }; });
      if (el.querySelector('.fx') && o.onApprove) el.querySelector('.fx').onclick = function () { if (confirm('このパートを' + (o.approveLabel || '承認') + 'します。よろしいですか？（コメント・補足メモも一緒に送ります）')) { FULL.carry = true; o.onApprove(); } };
      else if (el.querySelector('.fx')) el.querySelector('.fx').onclick = function () { FULL.set(false); render(); var bt = document.getElementById('bOk'); if (bt) bt.scrollIntoView({ block: 'center' }); };
    }
    // パートのタブ（本社分＝総務・国内営業・ソリューション）。2つ以上届いているときだけ
    function partsHtml() { var ps = o.parts || []; if (ps.length < 2) return '';
      var tot = ps.reduce(function (s, p) { return s + p.total; }, 0), b = snap.batch || {};
      return '<div class="parts"><span class="pl">' + esc(b.ym || '') + ' ' + esc(b.round || '') + '払い　' + ps.length + 'パート 合計 <b>' + yen(tot) + '</b> 円</span>' + ps.map(function (p, i) {
        return '<button data-part="' + i + '" class="pt' + (p.cur ? ' cur' : '') + '"><b>' + esc(p.dept) + '</b><span class="pa">' + yen(p.total) + '</span><span class="ps ' + esc(p.cls) + '">' + (p.cls === 'ok' ? '✔ ' : p.cls === 'run' ? '⏳ ' : '') + esc(p.label) + '</span></button>'; }).join('') + '</div>'; }
    // 全画面：後ろの画面（wf_app の .detail）はスクロールさせない
    var locked = null;
    function lock(on) { var p = el.parentElement; while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
      if (on && p) { locked = p; p.style.overflow = 'hidden'; } else if (!on && locked) { locked.style.overflow = ''; locked = null; } }
    // Esc：明細のドロワーが開いていれば、まずそれだけ閉じる（全画面の解除より先）
    window.addEventListener('keydown', function (e) { if (e.key !== 'Escape' || !document.body.contains(el)) return; var d = el.querySelector('.svdr.open'); if (!d) return;
      e.stopPropagation(); ui.dPin = false; ui.dOpen = false; d.classList.remove('open'); var bb = d.querySelector('.svdr-bar'); if (bb) bb.classList.remove('pin'); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('sv-full') && document.body.contains(el)) { FULL.set(false); render(); } });
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
      pane.insertAdjacentHTML('beforeend', tokkiListHtml() + payeeListHtml());
      if (snap.fuel && (snap.fuel.rows || []).length) pane.insertAdjacentHTML('beforeend', fuelHtml(snap.fuel));
      pane.querySelectorAll('.flag,.plist tr[data-k],.tklist tr[data-k]').forEach(function (f) { f.onclick = function () { ui.sel = f.dataset.k; ui.tab = 'rev'; ui.only = ''; render(); }; });
    }
    // 特記事項（サマリー・取引先一覧の上）：経費の「いつもと違う支払」（初めて・久しぶりの支払先、総務が付けた特記）。行を押すと明細へ（2026-11-09）
    //   決裁に回すときに支払管理が rows[].tk に入れる（この機能より前に回した申請には無い）
    function tokkiListHtml() {
      var a = rows.filter(function (x) { return x.tk && x.tk.length; }).sort(function (x, y) { return y.amount - x.amount; });
      if (!a.length) return '';
      return '<div class="box" style="margin-top:12px"><h4>特記事項（' + a.length + '件）<span style="font-weight:400;font-size:12px;color:var(--sub);margin-left:8px">いつもと違う支払（初めて・久しぶりの支払先など）。行を押すと明細へ</span></h4><div style="overflow-x:auto"><table class="plist tklist"><tr><th>支払先</th><th>方法</th><th class="n">金額</th><th style="width:55%">特記の文</th></tr>' +
        a.map(function (x) { return '<tr data-k="' + esc(x._k) + '"><td><b>' + esc(x.payee) + '</b></td><td>' + mth(x.method) + '</td><td class="n"><b>' + yen(x.amount) + '</b></td><td style="white-space:normal">' + x.tk.map(esc).join('<br>') + '</td></tr>'; }).join('') +
        '</table></div></div>';
    }
    // 取引先一覧（サマリー）：仕入・経費に分けて、金額の大きい順。行を押すとその明細へ（ユーザー 2026-11-08）
    function payeeListHtml() {
      var grp = [['仕入', rows.filter(function (x) { return x.kind !== '経費'; })], ['経費', rows.filter(function (x) { return x.kind === '経費'; })]].filter(function (g) { return g[1].length; });
      var tr = function (x) { var c = S.checks[x._k];
        return '<tr data-k="' + esc(x._k) + '"><td style="width:22px;text-align:center">' + (c === 'ok' ? '<span style="color:var(--down)">✔</span>' : c === 'hold' ? '<span style="color:var(--warn)">⏸</span>' : '<span style="color:#c3c9d6">□</span>') + '</td>' +
          '<td><b>' + esc(x.payee) + '</b>' + tags(x).map(function (t) { return ' <span class="tag ' + t[1] + '">' + esc(t[0]) + '</span>'; }).join('') + (x.kind === '経費' && whatOf(x).length ? '<div class="s" style="color:#3a4252">' + whatOf(x).map(esc).join('・') + '</div>' : '') + '</td><td>' + mth(x.method) + '</td>' +
          '<td class="n"><b>' + yen(x.amount) + '</b>' + (x.fee ? '<div class="s">手数料 ' + yen(x.fee) + ' を引いた振込額</div>' : '') + '</td><td class="n" style="color:var(--sub)">' + (x.prev1 ? yen(x.prev1) : '—') + '</td><td class="n">' + (x.prev1 ? diff(x.amount, x.prev1) : '') + '</td>' +
          '<td style="font-size:12px;color:var(--sub)">' + esc(x.due ? '期日 ' + x.due : x.payDate || '') + '</td></tr>'; };
      return '<div class="box" style="margin-top:12px"><h4>取引先一覧（' + rows.length + '件）<span style="font-weight:400;font-size:12px;color:var(--sub);margin-left:8px">行を押すと明細へ</span></h4><div style="overflow-x:auto"><table class="plist"><tr><th></th><th>支払先</th><th>方法</th><th class="n">金額</th><th class="n">前月</th><th class="n">前月との差</th><th>期日・支払日</th></tr>' +
        grp.map(function (g) { var a = g[1].slice().sort(function (x, y) { return y.amount - x.amount; });
          return '<tr class="pg"><td colspan="7"><span class="kd ' + (g[0] === '経費' ? 'ex' : 'sp') + '">' + g[0] + '</span>' + (g[0] === '仕入' ? '仕入（SMILE）' : '経費') + '<span style="font-weight:400;color:var(--sub);margin-left:6px">' + a.length + '件・' + yen(a.reduce(function (t, x) { return t + x.amount; }, 0)) + '円</span></td></tr>' + a.map(tr).join(''); }).join('') + '</table></div></div>';
    }
    // 燃料の単価（1Lあたり・拠点ごと・払う月）。fuel：{yms:['2026/09',…], rows:[{loc, fuel, cells:{ym:{lo,hi,sq}}}]}（呼ぶ側が作る）
    function fuelHtml(fu) {
      var yms = fu.yms || [], rs = fu.rows || [], mid = function (c) { return (c.lo + c.hi) / 2; }, fmt = function (v) { return (+v).toLocaleString('ja-JP', { maximumFractionDigits: 1 }); }, mk = {};
      yms.forEach(function (ym) { ['ガソリン', '軽油', 'ハイオク', '灯油'].forEach(function (f) { var cs = rs.filter(function (r) { return r.fuel === f && r.cells[ym]; });
        if (cs.length < 2) return; cs.sort(function (a, b) { return mid(a.cells[ym]) - mid(b.cells[ym]); }); mk[rs.indexOf(cs[0]) + '@' + ym] = 'f-lo'; mk[rs.indexOf(cs[cs.length - 1]) + '@' + ym] = 'f-hi'; }); });
      return '<div class="box" style="margin-top:12px"><h4>燃料の単価（1Lあたり・拠点ごと・払う月）</h4><div style="overflow-x:auto"><table class="fuel"><tr><th>拠点</th><th>燃料</th>' + yms.map(function (y) { return '<th class="n">' + esc(String(y).replace(/^\d{4}\//, '')) + '月払い</th>'; }).join('') + '</tr>' +
        rs.map(function (r, i) { return '<tr><td>' + esc(r.loc) + '</td><td>' + esc(r.fuel) + '</td>' + yms.map(function (y) { var c = r.cells[y]; if (!c) return '<td class="n" style="color:#c3c9d6">—</td>';
          return '<td class="n ' + (mk[i + '@' + y] || '') + (c.sq ? ' f-sq' : '') + '">' + (c.lo === c.hi ? fmt(c.lo) : fmt(c.lo) + '～' + fmt(c.hi)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>' +
        '<div style="font-size:12px;color:var(--sub);margin-top:6px">決裁メモの「@単価」から。<span class="f-lo" style="padding:0 4px">緑</span>＝その月いちばん安い拠点、<span class="f-hi" style="padding:0 4px">赤</span>＝いちばん高い拠点。斜体は請求Quick の決裁メモ（アプリより前の月）</div></div>';
    }
    // 請求書の明細（AI が読んだもの）。items：{amount:'税込'|'税抜', items:[{Date, SlipNo, ItemName, Spec, Note, Qty, Unit, UnitPrice, Amount, TaxRate}]}
    function itemsHtml(x) { var j = x.items, it = (j && j.items) || [], tot = it.reduce(function (s, a) { return s + (+a.Amount || 0); }, 0);
      return '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px"><b style="font-size:15px">請求書の明細</b><span class="s">' + esc(x.payee) + '・' + it.length + '行・' + esc(j.amount || '') + '</span><span style="flex:1"></span><button class="svdr-x">✕</button></div>' +
        sumCards(x, j, tot) +
        '<table class="ln"><tr class="h1"><th>日付</th><th>品名</th><th class="n">数量</th><th class="n">単価</th><th class="n">金額</th><th>税率</th></tr>' + it.map(function (a) {
          return '<tr><td style="white-space:nowrap">' + esc(a.Date || '') + (a.SlipNo ? '<div class="s">' + esc(a.SlipNo) + '</div>' : '') + '</td><td>' + esc(a.ItemName || '') + (a.Spec ? ' <span class="s">' + esc(a.Spec) + '</span>' : '') + (a.Note ? '<div class="s">' + esc(a.Note) + '</div>' : '') + '</td>' +
            '<td class="n">' + (a.Qty != null && a.Qty !== '' ? esc(String(a.Qty)) + esc(a.Unit || '') : '') + '</td><td class="n">' + (a.UnitPrice != null && a.UnitPrice !== '' ? yen(a.UnitPrice) : '') + '</td><td class="n">' + yen(a.Amount) + '</td><td style="font-size:11.5px">' + esc(a.TaxRate || '') + '</td></tr>'; }).join('') +
        '<tr><td colspan="4"><b>合計</b></td><td class="n"><b>' + yen(tot) + '</b></td><td></td></tr></table>'; }
    // 仕入：SMILE の受入明細（支払管理アプリが決裁に回すときに渡す）。rcv：[{d 日付, s 伝票№, i 品名, sp 型番, q 数量, u 単位, p 単価, e 税抜, f 付加価値率%, dp 部門, k 取引区分}]
    //   付加価値率は、率のある行の税抜で重みを付けた平均もカードに出す
    function rcvHtml(x) { var it = x.rcv || [], tot = it.reduce(function (s, a) { return s + (+a.e || 0); }, 0);
      var fw = it.filter(function (a) { return a.f != null && a.f !== ''; }), fe = fw.reduce(function (s, a) { return s + (+a.e || 0); }, 0), favg = fe ? fw.reduce(function (s, a) { return s + (+a.e || 0) * (+a.f || 0); }, 0) / fe : null;
      var dt8 = function (v) { v = String(v || ''); return /^\d{8}$/.test(v) ? v.slice(4, 6).replace(/^0/, '') + '/' + v.slice(6).replace(/^0/, '') : v; };
      return '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px"><b style="font-size:15px">SMILE の受入明細</b><span class="s">' + esc(x.payee) + '・' + it.length + '行・税抜</span><span style="flex:1"></span><button class="svdr-x">✕</button></div>' +
        '<div class="svsum"><div class="pay"><div class="l">支払額（税込）</div><div class="v">' + yen(gross(x)) + '<small> 円</small></div>' + (x.fee ? '<div class="s">振込 ' + yen(x.amount) + '（手数料 ' + yen(x.fee) + ' 先方負担を引く）</div>' : '') + '</div>' +
        '<div><div class="l">受入（税抜）</div><div class="v">' + yen(tot) + '</div><div class="s">' + it.length + '行' + (x.smile && x.smile.incl ? '・税込 ' + yen(x.smile.incl) : '') + '</div></div>' +
        '<div><div class="l">付加価値率（平均）</div><div class="v">' + (favg == null ? '—' : (Math.round(favg * 10) / 10) + '%') + '</div><div class="s">' + (fw.length ? '率のある ' + fw.length + '行・税抜で重み付け' : '率のある行なし') + '</div></div></div>' +
        // 受入伝票（日付・伝票№・品名・数量・単価・税抜）と受注伝票（受注№・売先・付加価値率）を縦の線で分ける
        '<table class="ln"><tr class="h1"><th colspan="5" class="grp">受入伝票（SMILE）</th><th colspan="2" class="grp jd">受注伝票</th></tr>' +
        '<tr class="h2"><th>日付</th><th>品名</th><th class="n">数量</th><th class="n">単価</th><th class="n">税抜</th><th class="jd">受注№・売先</th><th class="n">付加%</th></tr>' + it.map(function (a) {
          return '<tr><td style="white-space:nowrap">' + esc(dt8(a.d)) + (a.s ? '<div class="s">' + esc(a.s) + '</div>' : '') + '</td><td>' + esc(a.i || '') + (a.sp ? ' <span class="s">' + esc(a.sp) + '</span>' : '') + (a.dp || a.k ? '<div class="s">' + esc([a.dp, a.k].filter(Boolean).join('・')) + '</div>' : '') + '</td>' +
            '<td class="n">' + (a.q != null && a.q !== '' ? esc(String(a.q)) + esc(a.u || '') : '') + '</td><td class="n">' + (a.p != null && a.p !== '' ? yen(a.p) : '') + '</td><td class="n">' + yen(a.e) + '</td>' +
            '<td class="jd">' + (a.o ? '<span class="s">' + esc(a.o) + '</span>' : '') + (a.t ? '<div>' + esc(a.t) + '</div>' : '') + (a.n && a.n !== a.t ? '<div class="s">納品先 ' + esc(a.n) + '</div>' : '') + '</td>' +
            '<td class="n">' + (a.f != null && a.f !== '' ? esc(String(a.f)) + '%' : '') + '</td></tr>'; }).join('') +
        '<tr><td colspan="4"><b>合計</b></td><td class="n"><b>' + yen(tot) + '</b></td><td class="jd"></td><td class="n">' + (favg == null ? '' : '<b>' + (Math.round(favg * 10) / 10) + '%</b>') + '</td></tr></table>'; }
    // 照合（SMILE の受入 ⇔ 請求書の明細）。mt：{tin, g:[{st, d, s, is, dp, ra, ia, df, r:[{i,sp,q,u,p,a}], v:[{i,q,u,p,a}]}]}（支払管理アプリが決裁に回すときに計算）
    function mtHtml(x) { var m = x.mt || { g: [] }, g = m.g || [], MS = { '一致': 'ok', '金額が違う': 'ng', '受入だけ': 'warn', '請求書だけ': 'warn' };
      var rT = g.reduce(function (s, o) { return s + (o.ra || 0); }, 0), iT = g.reduce(function (s, o) { return s + (o.ia || 0); }, 0), cnt = function (k) { return g.filter(function (o) { return o.st === k; }).length; };
      var up = function (v) { return v == null || v === '' ? '' : (+v).toLocaleString('ja-JP', { maximumFractionDigits: 2 }); }, col = { ok: '#067647', ng: '#b42318', warn: '#b54708' };
      return '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap"><b style="font-size:15px">照合（SMILE の受入 ⇔ 請求書）</b><span class="s">' + esc(x.payee) + '・' + (m.tin ? '税込' : '税抜') + '</span><span class="mleg"><i class="cS">SMILE の受入</i><i class="cI">請求書</i></span><label class="s" title="請求書の明細がうまく読めていないときなど、SMILE の受入だけを見る"><input type="checkbox" class="smo"' + (ui.smo ? ' checked' : '') + '> SMILE だけ</label><span style="flex:1"></span>' +
        Object.keys(MS).map(function (k) { return '<span class="s" style="color:' + col[MS[k]] + ';font-weight:700">' + k + ' ' + cnt(k) + '</span>'; }).join('　') + '</div>' +
        '<div class="svsum"><div class="cS"><div class="l">SMILE の受入</div><div class="v">' + yen(rT) + '</div></div><div class="cI"><div class="l">請求書の明細</div><div class="v">' + yen(iT) + '</div></div>' +
        '<div class="' + (Math.abs(iT - rT) <= 1 ? 'good' : 'bad') + '"><div class="l">差（請求書 − 受入）</div><div class="v">' + (Math.abs(iT - rT) <= 1 ? '✔ 0' : (iT - rT > 0 ? '+' : '') + yen(iT - rT)) + '</div></div></div>' +
        '<table class="ln mt2' + (ui.smo ? ' smonly' : '') + '"><tr class="h1"><th>日付</th><th>伝票№</th><th class="cS">SMILE の品名</th><th class="n cS">受入</th><th class="n cI">請求書</th><th class="cI">請求書の品名</th><th class="n cD">差</th><th>照合</th></tr>' + g.map(function (o) {
          if (ui.smo && !o.r.length) return '';
          var n = Math.max(o.r.length, o.v.length), c = MS[o.st], h = '<tr style="border-top:1.5px solid var(--line);font-weight:600"><td style="white-space:nowrap">' + esc(o.d || '') + '</td><td>' + esc(o.s || '') + (o.is ? '<div class="s">請求書 ' + esc(o.is) + '</div>' : '') + (o.bl ? '<div class="s">請求書の日付 ' + esc(o.bl) + '</div>' : '') + (o.dp ? '<div class="s">' + esc(o.dp) + '</div>' : '') + '</td><td class="cS"></td>' +
            '<td class="n cS">' + (o.ra == null ? '—' : yen(o.ra)) + '</td><td class="n cI">' + (o.ia == null ? '—' : yen(o.ia)) + '</td><td class="cI"></td><td class="n cD">' + (o.df ? (o.df > 0 ? '+' : '') + yen(o.df) : '') + '</td><td style="white-space:nowrap;color:' + col[c] + ';font-size:11.5px;font-weight:700">' + esc(o.st) + '</td></tr>';
          for (var k = 0; k < n; k++) { var a = o.r[k], b = o.v[k], pd = a && b && a.p != null && b.p != null && Math.abs(a.p - b.p) > 0.5;
            h += '<tr><td></td><td></td><td class="cS">' + (a ? esc(a.i) + (a.sp ? ' <span class="s">' + esc(a.sp) + '</span>' : '') + (a.q ? ' <span class="s">' + esc(String(a.q)) + esc(a.u || '') + '×' + up(a.p) + '</span>' : '') : '') + '</td>' +
              '<td class="n cS">' + (a ? yen(a.a) : '') + '</td><td class="n cI">' + (b ? yen(b.a) : '') + '</td><td class="cI">' + (b ? esc(b.i) + (b.q != null && b.q !== '' ? ' <span class="s"' + (pd ? ' style="color:#b42318;font-weight:700"' : '') + '>' + esc(String(b.q)) + esc(b.u || '') + '×' + up(b.p) + '</span>' : '') + (pd ? ' <span style="color:#b42318;font-size:11px;font-weight:700">単価が違う</span>' : '') : '') + '</td><td class="cD"></td><td></td></tr>'; }
          return h; }).join('') + '</table>'; }
    // 明細の上のカード（支払管理アプリと同じ）：支払金額（税込・税抜）／請求書の明細／仕訳（明細と同じ 税込・税抜 で）／差
    function sumCards(x, j, tot) { var inc = j.amount === '税込', ls = x.lines || [], has = ls.some(function (l) { return l.rate || l.excl; });
      var lIn = ls.reduce(function (s, l) { return s + (+l.amount || 0); }, 0), lEx = ls.reduce(function (s, l) { return s + (+l.excl || 0); }, 0), lTx = ls.reduce(function (s, l) { return s + (+l.tax || 0); }, 0);
      var lsT = Math.round(inc ? lIn : lEx), d = Math.round(tot - lsT), ok = Math.round(lIn) === gross(x);
      return '<div class="svsum"><div class="pay"><div class="l">支払額（税込）</div><div class="v">' + yen(gross(x)) + '<small> 円</small></div><div class="s">' + (has ? '税抜 ' + yen(lEx) + '・消費税 ' + yen(lTx) : '') + (x.fee ? (has ? '<br>' : '') + '振込 ' + yen(x.amount) + '（手数料 ' + yen(x.fee) + ' 先方負担を引く）' : '') + '</div></div>' +
        '<div><div class="l">請求書の明細（' + (inc ? '税込' : '税抜') + '）</div><div class="v">' + yen(tot) + '</div><div class="s">' + (j.items || []).length + '行</div></div>' +
        (ls.length ? '<div><div class="l">仕訳（' + (inc ? '税込' : '税抜') + '）</div><div class="v">' + yen(lsT) + '</div><div class="s">' + ls.length + '行' + (ok ? '・✔ 支払金額と一致' : '') + '</div></div>' +
          '<div class="' + (Math.abs(d) <= 1 ? 'good' : 'bad') + '"><div class="l">差（明細 − 仕訳）</div><div class="v">' + (Math.abs(d) <= 1 ? '✔ 0' : (d > 0 ? '+' : '') + yen(d)) + '</div></div>' : '') + '</div>'; }
    // ドロワー：バーにホバーで開く・クリックで固定・Esc で閉じる。幅は右の列（内容）にそろえ、請求書 PDF との境まで
    function wireDrawer(dt, x) { var d = dt.querySelector('.svdr'); if (!d) return; var bar = d.querySelector('.svdr-bar'), p = d.querySelector('.svdr-p'), t = null;
      var fitW = function () { var wd = dt.classList.contains('wide'), di = wd ? dt.querySelector('.di') : dt, w = Math.round(bar.getBoundingClientRect().left - di.getBoundingClientRect().left - (wd ? 0 : 8)); if (w > 220) p.style.width = w + 'px'; };
      var set = function (on) { clearTimeout(t); ui.dOpen = on; if (on) { fitW(); p.innerHTML = x.items && (x.items.items || []).length ? itemsHtml(x) : rcvHtml(x); var xb = p.querySelector('.svdr-x'); if (xb) xb.onclick = function () { ui.dPin = false; bar.classList.remove('pin'); set(false); }; } d.classList.toggle('open', on); };
      bar.onmouseenter = function () { clearTimeout(t); t = setTimeout(function () { set(true); }, 120); };
      d.onmouseleave = function () { if (ui.dPin) return; clearTimeout(t); t = setTimeout(function () { set(false); }, 300); };
      d.onmouseenter = function () { if (ui.dOpen) clearTimeout(t); };
      bar.onclick = function () { ui.dPin = !ui.dPin; bar.classList.toggle('pin', ui.dPin); set(ui.dPin || ui.dOpen); };
      if (ui.dPin) { bar.classList.add('pin'); set(true); } }
    function review(pane) {
      pane.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><input type="search" class="q" placeholder="支払先・備考で検索" value="' + esc(ui.q) + '" style="border:1px solid var(--line);border-radius:6px;padding:4px 8px">' +
        '<select class="fo">' + [['', 'すべて'], ['sp', '仕入だけ'], ['ex', '経費だけ'], ['flag', '特記・気づきだけ'], ['unck', '未確認だけ'], ['hold', '保留だけ']].map(function (v) { return '<option value="' + v[0] + '"' + (ui.only === v[0] ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') + '</select>' +
        '<select class="fs">' + [['amount', '金額の大きい順'], ['diff', '前月からの増加が大きい順'], ['no', '総務が回した順']].map(function (v) { return '<option value="' + v[0] + '"' + (ui.sort === v[0] ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') + '</select><span class="cnt" style="font-size:12px;color:var(--sub);align-self:center"></span><button class="lt" title="たたむと請求書を広く見られます（左の帯にマウスを乗せると一覧が出ます）">' + (MINI.on ? '› 一覧を出す' : '‹ 一覧をたたむ') + '</button></div>' +
        '<div class="rv' + (MINI.on ? ' mini' : '') + '"><div class="rstrip" title="マウスを乗せると明細の一覧が出ます（クリックで固定して出す）"><span>›</span><span class="vt">明細の一覧</span><span class="pos"></span></div><div class="rl"><table><tbody class="tb"></tbody></table></div><div class="dt"></div></div>';
      pane.querySelector('.q').oninput = function (e) { ui.q = e.target.value.trim(); rowsHtml(); detail(); };
      pane.querySelector('.fo').onchange = function (e) { ui.only = e.target.value; rowsHtml(); detail(); };
      pane.querySelector('.fs').onchange = function (e) { ui.sort = e.target.value; rowsHtml(); detail(); };
      pane.querySelector('.lt').onclick = function () { MINI.set(!MINI.on); review(pane); };
      var rv = pane.querySelector('.rv'), strip = pane.querySelector('.rstrip'), rl = pane.querySelector('.rl'), tmr = null;
      var peek = function (on) { clearTimeout(tmr); if (on) rv.classList.add('peek'); else tmr = setTimeout(function () { rv.classList.remove('peek'); }, 280); };
      strip.onmouseenter = function () { peek(true); }; strip.onmouseleave = function () { peek(false); }; strip.onclick = function () { clearTimeout(tmr); rv.classList.toggle('peek'); };
      rl.onmouseenter = function () { peek(true); }; rl.onmouseleave = function () { peek(false); };
      // 詳細の幅が広ければ 左＝請求書・右＝内容（一覧をたたむ・画面の幅が変わるたびに見直す）
      var dtEl = pane.querySelector('.dt'), wide = function () { dtEl.classList.toggle('wide', dtEl.clientWidth >= 940 && window.innerWidth > 900); };
      if (window.ResizeObserver) new ResizeObserver(wide).observe(dtEl); wide();
      rowsHtml(); detail(); fit();
    }
    // 明細のカードが1画面に収まるように：スクロールする枠（wf_app の .detail）の高さから、一覧と詳細の高さを決める。
    // 初めて開いたときだけ、カードの上端が枠の上に来るまでスクロールする（進み具合などはその上）
    function scroller() { for (var p = el.parentElement; p; p = p.parentElement) { var s = getComputedStyle(p).overflowY; if ((s === 'auto' || s === 'scroll') && p.clientHeight < p.scrollHeight + 1) return p; } return null; }
    function fit() {
      var rv = el.querySelector('.rv'); if (!rv || window.innerWidth <= 900) return;
      if (el.classList.contains('sv-full')) { rv.style.height = Math.max(360, window.innerHeight - (rv.getBoundingClientRect().top - el.getBoundingClientRect().top) - 14) + 'px'; return; }
      var box = scroller(), card = el.closest('.card') || el, viewH = box ? box.clientHeight : window.innerHeight;
      var cr = card.getBoundingClientRect(), rr = rv.getBoundingClientRect();
      var above = rr.top - cr.top, below = cr.bottom - rr.bottom;
      rv.style.height = Math.max(420, viewH - above - below - 24) + 'px';
      // 開いたときは一番上から（申請の見出し・承認のボタンが見えるように。前は明細のカードまで自動でスクロールしていた。ユーザー 2026-11-07）
      if (!placed && box) { placed = true; box.scrollTop = 0; }
    }
    window.addEventListener('resize', function () { if (document.body.contains(el)) fit(); });
    function rowsHtml() {
      var a = list(), tb = el.querySelector('.tb'); if (!tb) return;
      if (!a.some(function (x) { return x._k === ui.sel; })) ui.sel = a.length ? (a.filter(function (x) { return !S.checks[x._k]; })[0] || a[0])._k : null;
      el.querySelector('.cnt').textContent = a.length + '件　' + yen(a.reduce(function (s, x) { return s + x.amount; }, 0)) + '円　確認OK ' + a.filter(function (x) { return S.checks[x._k] === 'ok'; }).length + '／' + a.length;
      var two = a.some(function (x) { return x.kind === '経費'; }) && a.some(function (x) { return x.kind !== '経費'; }), lastK = null;
      var kHead = function (x) { var k = x.kind === '経費' ? '経費' : '仕入', b = a.filter(function (y) { return (y.kind === '経費' ? '経費' : '仕入') === k; });
        return '<tr class="kgrp"><td colspan="3"><span class="kd ' + (k === '経費' ? 'ex' : 'sp') + '">' + k + '</span>' + (k === '仕入' ? '仕入（SMILE）' : '経費') + '<span class="s2">' + b.length + '件・' + yen(b.reduce(function (s, y) { return s + y.amount; }, 0)) + '円</span></td></tr>'; };
      tb.innerHTML = a.map(function (x) { var c = S.checks[x._k], k = x.kind === '経費' ? '経費' : '仕入', hd = two && k !== lastK ? kHead(x) : ''; lastK = k;
        return hd + '<tr class="' + (x._k === ui.sel ? 'sel ' : '') + (c || '') + '" data-k="' + esc(x._k) + '"><td style="width:24px;text-align:center">' + (c === 'ok' ? '<span style="color:var(--down)">✔</span>' : c === 'hold' ? '<span style="color:var(--warn)">⏸</span>' : '<span style="color:#c3c9d6">□</span>') + '</td>' +
          '<td><div class="nm">' + esc(x.payee) + (S.comments[x._k] || NOTES[nk(x)] ? ' 💬' : '') + '</div>' + (x.kind === '経費' && whatOf(x)[0] ? '<div class="s" style="white-space:normal;color:#3a4252">' + esc(whatOf(x)[0].length > 40 ? whatOf(x)[0].slice(0, 40) + '…' : whatOf(x)[0]) + '</div>' : '') + '<div class="s"><span class="kd ' + (x.kind === '経費' ? 'ex' : 'sp') + '">' + (x.kind === '経費' ? '経費' : '仕入') + '</span>' + mth(x.method) + tags(x).map(function (t) { return '<span class="tag ' + t[1] + '">' + esc(t[0]) + '</span>'; }).join('') + '</div></td>' +
          '<td class="n"><b>' + yen(x.amount) + '</b><div class="s">' + (x.prev1 ? diff(x.amount, x.prev1) : '') + '</div></td></tr>'; }).join('') || '<tr><td style="color:var(--sub);padding:12px">該当する明細はありません</td></tr>';
      tb.querySelectorAll('tr[data-k]').forEach(function (tr) { tr.onclick = function () { ui.sel = tr.dataset.k; var rv = el.querySelector('.rv'); if (rv) rv.classList.remove('peek'); rowsHtml(); detail(); }; });
      var s = tb.querySelector('tr.sel'), rl = el.querySelector('.rl'); if (s && rl) { var top = s.offsetTop, bot = top + s.offsetHeight; if (top < rl.scrollTop) rl.scrollTop = top; else if (bot > rl.scrollTop + rl.clientHeight) rl.scrollTop = bot - rl.clientHeight; }
      var ps = el.querySelector('.rstrip .pos'), ai = a.findIndex(function (x) { return x._k === ui.sel; }); if (ps) ps.textContent = (ai + 1) + '/' + a.length;
    }
    function detail() {
      var dt = el.querySelector('.dt'); if (!dt) return;
      var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }), x = a[i];
      if (!x) { dt.innerHTML = '<div style="padding:16px;color:var(--sub)">左の一覧から選んでください</div>'; return; }
      var c = S.checks[x._k], row = function (k, v) { return v == null || v === '' ? '' : '<div class="k">' + k + '</div><div>' + v + '</div>'; };
      var sm = x.smile || {}, txl = (x.lines || []).some(function (l) { return l.rate; });
      var wt = whatOf(x);
      var kvH = '<div class="kv">' + (x.tk && x.tk.length ? '<div class="k">特記事項</div><div style="grid-column:2/-1"><span class="tag t-flag" style="margin-right:6px">特記</span>' + x.tk.map(esc).join('<br>') + '</div>' : '') + (wt.length ? '<div class="k">何の支払か</div><div style="grid-column:2/-1"><b style="font-size:14.5px;line-height:1.6">' + wt.map(esc).join('<br>') + '</b></div>' : '') + row('振込手数料', x.fee ? yen(x.fee) + ' 円（先方負担）' : '') +
          row('SMILE の額', sm.incl != null ? '税込仕入額 ' + yen(sm.incl) + (Math.round(sm.incl) === gross(x) ? ' <b style="color:var(--down)">✔ 支払額と一致</b>' : '') + (sm.carry ? '／繰越 ' + yen(sm.carry) : '') + (sm.held ? '（保留 ' + yen(sm.held) + '・3月末に整理）' : '') : '') +
          row('振込先の変更', x.bankChange ? '<b style="color:var(--up)">' + esc(x.bankChange) + '</b>' : '') + row('備考', esc(x.note)) + '</div>';
      var ibHtml = function () { return txl && ui.itab === 'ln' ? linesHtml(x.lines) : kvH + (txl ? taxSum(x.lines) : linesHtml(x.lines)); };
      dt.innerHTML = '<div class="dn"><button class="p">◀ 前へ</button><span style="color:var(--sub)">' + (i + 1) + ' ／ ' + a.length + '</span><button class="n"' + (i >= a.length - 1 ? ' disabled' : '') + '>次へ ▶</button><span class="sp"></span>' + (c ? '<span class="tag ' + (c === 'ok' ? 't-ok' : 't-new') + '">' + (c === 'ok' ? '✔ 確認OK' : '⏸ 保留') + '</span>' : '') + '</div>' +
        '<div class="db"><div class="di"><div class="hd"><div style="min-width:0"><div style="font-size:12px;color:var(--sub)">' + esc(x.genre || '') + (x.no ? '・' + esc(x.no) : '') + '</div><h3 style="margin:2px 0 6px;font-size:18px">' + esc(x.payee) + '</h3>' +
          '<div class="mrow">' + mth(x.method, true) + '<span class="when">' + esc(x.due ? '期日 ' + x.due : x.payDate ? '支払日 ' + x.payDate : '') + '</span>' + tags(x).map(function (t) { return '<span class="tag ' + t[1] + '">' + esc(t[0]) + '</span>'; }).join('') + '</div></div>' +
          cmp(x) + '</div>' +
        // 仕訳の明細（税区分つき）があるときは「内容」と「仕訳明細」をタブで切り替える（明細が多くても、右の列の中だけで見られる）
        (txl ? '<div class="itabs"><button data-it="sum" class="' + (ui.itab !== 'ln' ? 'on' : '') + '">内容</button><button data-it="ln" class="' + (ui.itab === 'ln' ? 'on' : '') + '">仕訳明細（' + x.lines.length + '行）</button></div>' : '') +
        '<div class="ib">' + ibHtml() + '</div>' +
        notesHtml(NOTES[nk(x)]) + '<textarea class="cm" placeholder="' + (o.onChange ? 'この明細の補足メモ（ほかの人にも見えます）' : 'この明細の補足メモ（承認のときにまとめて送り、次の人・社長にも見えます）') + '" style="' + (S.comments[x._k] ? '' : 'display:none;') + 'width:100%;height:52px;border:1px solid var(--line);border-radius:6px;padding:6px;margin-top:8px">' + esc(S.comments[x._k] || '') + '</textarea></div>' +
        '<div class="dl"><div class="dstrip"><span class="pn">' + esc(x.payee) + '</span>' + mth(x.method, true) + '<span class="s2">' + esc(x.due ? '期日 ' + x.due : x.payDate ? '支払日 ' + x.payDate : '') + '</span>' +
          '<span>' + (x.fee ? '支払額' : '今回') + ' <span class="am">' + yen(gross(x)) + '</span> 円' + (x.fee ? '<span class="s2">（振込 ' + yen(x.amount) + '・手数料 ' + yen(x.fee) + ' 先方負担を引く）</span>' : '') + '</span><span class="s2">前月 ' + (x.prev1 ? yen(x.prev1) : '—') + '・前々月 ' + (x.prev2 ? yen(x.prev2) : '—') + '</span>' +
          (sm.incl != null ? '<span class="s2">SMILE 税込仕入額 ' + yen(sm.incl) + (Math.round(sm.incl) === gross(x) ? ' <b style="color:var(--down)">✔ 一致</b>' : '') + '</span>' : '') + (x.note ? '<span class="s2" style="flex-basis:100%">備考：' + esc(x.note) + '</span>' : '') + '</div>' +
        '<div class="chips">' + (x.invoices || []).map(function (k, j) { return '<button class="chip' + (ui.pdf[x._k] === k ? ' on' : '') + '" data-pdf="' + esc(k) + '" style="margin:0 4px 4px 0">📄 請求書 ' + (j + 1) + '</button>'; }).join('') +
          tabsOf(x).map(function (t) { return '<button class="chip' + (ui.pdf[x._k] === t.k ? ' on' : '') + '" data-pdf="' + t.k + '" style="margin:0 4px 4px 0">' + t.l + '</button>'; }).join('') + '</div>' +
        '<div class="pdf">' + ((x.invoices || []).length || tabsOf(x).length ? '読み込み中...' : '請求書の添付はありません') + '</div></div></div>' +
        '<div class="da">' + (o.canAct ? '<button class="h">⏸ 保留</button><button class="c">💬 補足メモ</button><span class="sp"></span><span style="font-size:11.5px;color:var(--sub)">Enter：OK・次へ　←→：前・次　H：保留</span>' + (function () { var nOk = rows.filter(function (y) { return S.checks[y._k] === 'ok'; }).length, rest = rows.length - nOk;
            return rest ? '<button class="pri ok" style="font-size:15px;padding:5px 20px;line-height:1.25">✔ OK・次へ<small style="display:block;font-size:11px;font-weight:500;opacity:.9">確認 ' + nOk + '／' + rows.length + '・あと ' + rest + ' 件</small></button>'
              : '<button class="pri fin" style="font-size:15px;padding:5px 20px;line-height:1.25;background:var(--down,#1e8449);border-color:var(--down,#1e8449)">✔ 完了 → ' + esc(o.approveLabel || '承認') + 'へ<small style="display:block;font-size:11px;font-weight:500;opacity:.9">確認 ' + nOk + '／' + rows.length + '・すべて確認しました</small></button>'; })()
          : '<span style="font-size:12px;color:var(--sub)">あなたの番になると「確認OK」を付けられます</span>') + '</div>';
      var q = function (s) { return dt.querySelector(s); };
      q('.p').onclick = function () { go(-1); }; q('.n').onclick = function () { go(1); };
      if (q('.fin')) q('.fin').onclick = finish;
      if (q('.ok')) { q('.ok').onclick = function () { mark('ok'); }; q('.h').onclick = function () { mark('hold'); }; q('.c').onclick = function () { dt.classList.remove('tblmode'); q('.cm').style.display = ''; q('.cm').focus(); }; }
      q('.cm').oninput = function (e) { S.comments[x._k] = e.target.value; persist(); };
      dt.querySelectorAll('[data-pdf]').forEach(function (b) { b.onclick = function () { showPdf(x, b.dataset.pdf); }; });
      // 内容／仕訳明細の切り替えは右の列だけ描き直す（請求書は読み直さない）
      var setIt = function (v) { ui.itab = v; dt.querySelectorAll('[data-it]').forEach(function (b) { b.classList.toggle('on', (b.dataset.it === 'ln') === (v === 'ln')); }); var ib = q('.ib'); ib.innerHTML = ibHtml(); ib.scrollTop = 0; wireIb(); };
      var wireIb = function () { var m = q('.tsum .more'); if (m) m.onclick = function () { setIt('ln'); }; };
      dt.querySelectorAll('[data-it]').forEach(function (b) { b.onclick = function () { setIt(b.dataset.it); }; }); wireIb();
      var first = (x.invoices || [])[0] || (tabsOf(x)[0] || {}).k;
      if (first) showPdf(x, ui.pdf[x._k] || first);
    }
    // 請求書 PDF の並びに足すボタン（押すと PDF の場所に表を出す。前は右のドロワー。ユーザー 2026-11-07）
    function tabsOf(x) { var t = [];
      if (x.items && (x.items.items || []).length) t.push({ k: '#it', l: '📋 請求書の明細（' + x.items.items.length + '行）' });
      if (x.rcv && x.rcv.length) t.push({ k: '#rcv', l: '📋 SMILE の受入明細（' + x.rcv.length + '行）' });
      if (x.mt && (x.mt.g || []).length) t.push({ k: '#mt', l: '⇔ 照合（SMILE ⇔ 請求書）' });
      return t; }
    // 税区分ごとの合計（「内容」に出す。行ごとは「仕訳明細」タブ）
    function taxSum(ls) { var g = {}, ord = [];
      ls.forEach(function (l) { var k = (l.rate || '') + '|' + (l.kind || '') + '|' + (l.tm || ''); if (!g[k]) { g[k] = { rate: l.rate, kind: l.kind, tm: l.tm, excl: 0, tax: 0, amount: 0, n: 0 }; ord.push(k); } var s = g[k]; s.excl += +l.excl || 0; s.tax += +l.tax || 0; s.amount += +l.amount || 0; s.n++; });
      return '<div class="tsum"><div class="tt"><b>税区分ごとの合計</b><span class="sp"></span><button class="more">仕訳明細 ' + ls.length + '行を見る ›</button></div><table class="ln"><tr><th>税区分</th><th class="n">税抜</th><th class="n">消費税</th><th class="n">税込</th></tr>' +
        ord.map(function (k) { var s = g[k]; return '<tr><td>' + esc(s.rate || '') + (s.kind ? '<span class="tag ' + (s.kind === '課' ? 't-new' : 't-ok') + '">' + esc(s.kind) + '</span>' : '') + (s.tm ? ' <span style="font-size:11px;color:var(--sub)">' + esc(s.tm) + '</span>' : '') + '<span style="font-size:11px;color:var(--sub)">（' + s.n + '行）</span></td><td class="n">' + yen(s.excl) + '</td><td class="n">' + yen(s.tax) + '</td><td class="n"><b>' + yen(s.amount) + '</b></td></tr>'; }).join('') + '</table></div>'; }
    // 内訳（経費は仕訳の明細）。税区分（税率・税込／税抜・課／共）がある明細は、税抜・消費税も並べる
    function linesHtml(ls) {
      if (!ls || !ls.length) return '';
      var tx = ls.some(function (l) { return l.rate; });
      // memo（決裁メモ：社長・室長向けの説明。任意）があれば主に出し、経理の摘要（note）は小さく
      var memoHtml = function (l) { return l.memo ? '<b>' + esc(l.memo) + '</b>' + (l.note ? '<div class="s" style="font-size:11px;color:var(--sub)">摘要：' + esc(l.note) + '</div>' : '') : esc(l.note || ''); };
      // l.strong：小計・合計の行（ハナオカ：請求額（税込）・今回の支払額）を太字に、上に線
      if (!tx) return '<table><tr><th>内訳</th><th class="n">金額</th><th>備考</th></tr>' + ls.map(function (l) { var st = l.strong ? ' style="font-weight:700;border-top:2px solid var(--line)"' : ''; return '<tr><td' + st + '>' + esc(l.genre || '') + '</td><td class="n"' + st + '>' + yen(l.amount) + '</td><td' + (l.strong ? ' style="border-top:2px solid var(--line)"' : '') + '>' + memoHtml(l) + '</td></tr>'; }).join('') + '</table>';
      var zk = function (l) { return esc(l.rate || '') + (l.kind ? '<span class="tag ' + (l.kind === '課' ? 't-new' : 't-ok') + '" title="' + (l.kind === '課' ? '課税売上のための仕入（個別対応）' : '共通の仕入（個別対応）') + '">' + esc(l.kind) + '</span>' : '') + (l.tm ? '<div class="s" style="font-size:11px;color:var(--sub)">' + esc(l.tm) + '</div>' : ''); };
      return '<div><table class="ln"><tr><th>科目</th><th>税区分</th><th class="n">税抜</th><th class="n">消費税</th><th class="n">税込</th></tr>' + ls.map(function (l) {
        return '<tr><td>' + esc(l.genre || '') + '</td><td>' + zk(l) + '</td><td class="n">' + yen(l.excl) + '</td><td class="n">' + yen(l.tax) + '</td><td class="n"><b>' + yen(l.amount) + '</b></td></tr>' + (l.memo || l.note ? '<tr class="lm"><td colspan="5">' + memoHtml(l) + '</td></tr>' : ''); }).join('') + '</table></div>';
    }
    // 請求書は PDF か画像（スマホの写真など）。画像は幅に合わせる
    function docHtml(u, key) { return /\.(jpe?g|png|webp|heic|heif)$/i.test(String(key || '').split('?')[0]) ? '<div class="imgv"><img src="' + u + '" alt="請求書の画像" style="max-width:100%;height:auto"></div>' : '<iframe src="' + u + '"></iframe>'; }
    // 請求書を差し込む：PDF の表示は読み込みでフォーカスを取り、枠がスクロールすることがあるので、元の位置に戻す
    function put(box, html) { var db = el.querySelector('.db'), sc = scroller(), y1 = db ? db.scrollTop : 0, y2 = sc ? sc.scrollTop : 0; box.innerHTML = html;
      var back = function () { if (db) db.scrollTop = y1; if (sc) sc.scrollTop = y2; }; var f = box.querySelector('iframe'); if (f) f.addEventListener('load', function () { back(); setTimeout(back, 300); }); }
    function showPdf(x, key) {
      ui.pdf[x._k] = key; el.querySelectorAll('[data-pdf]').forEach(function (b) { b.classList.toggle('on', b.dataset.pdf === key); });
      var box = el.querySelector('.pdf'); if (!box) return;
      var tbl = key.charAt(0) === '#'; box.classList.toggle('tbl', tbl); var dt0 = el.querySelector('.dt'); if (dt0) dt0.classList.toggle('tblmode', tbl);   // 明細モード：右の列をたたんで表を全幅に
      if (tbl) { box.innerHTML = key === '#it' ? itemsHtml(x) : key === '#rcv' ? rcvHtml(x) : mtHtml(x); box.scrollTop = 0;
        var sm = box.querySelector('.smo'); if (sm) sm.onchange = function () { ui.smo = sm.checked; showPdf(x, key); };   // SMILE だけ：請求書の列・請求書だけの組を隠す
        return; }
      if (ui.cache[key]) { put(box, docHtml(ui.cache[key], key)); return; }
      box.textContent = '読み込み中...';
      Promise.resolve(o.loadPdf ? o.loadPdf(key) : null).then(function (u) {
        if (u) ui.cache[key] = u; var b2 = el.querySelector('.pdf'); if (!b2 || ui.pdf[x._k] !== key || ui.sel !== x._k) return;
        put(b2, u ? docHtml(u, key) : "請求書を開けませんでした"); });
    }
    function go(d) { var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }), n = a[Math.min(a.length - 1, Math.max(0, i + d))]; if (n) { ui.sel = n._k; rowsHtml(); detail(); } }
    // すべて確認したら：承認へ（全画面の「すべて確認しました → このパートを承認する」と同じ）。承認できない画面では、下の承認のボタンへ
    function finish() {
      if (o.onApprove) { if (confirm('このパートを' + (o.approveLabel || '承認') + 'します。よろしいですか？（コメント・補足メモも一緒に送ります）')) { FULL.carry = true; o.onApprove(); } return; }
      FULL.set(false); render(); var bt = document.getElementById('bOk'); if (bt) bt.scrollIntoView({ block: 'center' });
    }
    function mark(v) { if (!o.canAct) return; var a = list(), i = a.findIndex(function (x) { return x._k === ui.sel; }); if (i < 0) return;
      S.checks[ui.sel] = v; persist();
      var nx = a.slice(i + 1).filter(function (x) { return !S.checks[x._k]; })[0] || a.filter(function (x) { return !S.checks[x._k]; })[0] || a[i + 1]; if (nx) ui.sel = nx._k;   // 最後まで来たら、まだの明細に戻る
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
  // ---------- 支払明細表（印刷・PDF）：申請の明細（snap）から、経費の画面・仕入の画面の「支払明細表」と同じ形で作る（2026-11-09） ----------
  //   経費：No・証憑・特記・会社名・科目・部門・税抜・消費税・税込・請求書計・取引先計・方法・決済日・振込・口座振替・でんさい・備考・前月・前々月・確認、最下部に拠点別の計
  //   仕入：支払明細(買掛)（本社）・支払明細シート(工場)。最後にまとめ（支払方法×拠点・区分・特記事項／仕入の合計・でんさいの期日別）
  //   この機能より前に回した申請は、科目コード・部門・SMILE の数字が無いので空欄になる
  function printReport(snap) {
    var w = window.open('', '_blank'); if (!w) { alert('新しいタブを開けませんでした（ポップアップを許可してください）'); return; }
    var b = snap.batch || {}, rows = snap.rows || [], ym = String(b.ym || ''), y = +ym.slice(0, 4), m = +ym.slice(5, 7), last = new Date(y, m, 0).getDate();
    var rd = b.round || '月末', day = rd === '10日' ? 10 : rd === '20日' ? 20 : last, payDay = y + '/' + m + '/' + day, made = new Date().toLocaleDateString('ja-JP');
    var lbl = y + '年' + m + '月分(' + m + '/' + day + ' 支払)', dept = b.dept || '';
    var cv = function (v) { return v == null || v === '' ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('ja-JP') : String(v)) : esc(String(v)); };
    var stamp = '<div class="st"><div class="t">社長</div><div class="t">総務</div><div class="t">総務</div><div class="t">担当</div><div class="bx"></div><div class="bx"></div><div class="bx"></div><div class="bx"></div></div>';
    var hd = function (t, sub) { return '<div class="hd"><div><h1>' + esc(t) + '</h1><div class="m">' + esc(sub) + '</div></div>' + stamp + '</div>'; };
    var N = function (s) { return String(s || '').normalize('NFKC').replace(/株式会社|有限会社|\(株\)|\(有\)|㈱|㈲|[\s　・.]/g, ''); };
    var LOC = { '002240': '名古屋', '002230': '大阪' }, c6 = function (c) { return String(c || '').trim().padStart(6, '0'); }, sh = function (c) { return String(c || '').replace(/^0+/, ''); };
    var MTH = function (mt) { return /振込/.test(mt) ? '振込' : /口座振替/.test(mt) ? '口振' : /でんさい/.test(mt) ? 'でんさい' : mt || ''; };
    var out = [];
    // ---- 経費 ----
    var ex = rows.filter(function (r) { return r.kind === '経費'; });
    var exSum = {}, exTot = 0;
    if (ex.length) {
      var payeeTot = {}, seen = {}; ex.forEach(function (r) { var k = N(r.payee); payeeTot[k] = (payeeTot[k] || 0) + r.amount; });
      var trs = [], no = 0, tIncl = 0, tBank = 0, tDr = 0, tDen = 0, loc = {};
      ex.forEach(function (r) {
        var ls = r.lines && r.lines.length ? r.lines : [null], mt = MTH(r.method), pk = N(r.payee), first = !seen[pk]; seen[pk] = 1;
        ls.forEach(function (l, i) {
          no++; var incl = l ? +l.amount || 0 : r.amount, lc = LOC[c6(l && l.dc)] || '本社'; tIncl += incl;
          exSum[mt] = exSum[mt] || {}; exSum[mt][lc] = (exSum[mt][lc] || 0) + incl; loc[lc] = loc[lc] || { bank: 0, dr: 0, den: 0, incl: 0 }; loc[lc].incl += incl;
          var pt = i === 0 && first ? payeeTot[pk] : 0;
          if (pt) { if (mt === '振込') { tBank += pt; loc[lc].bank += pt; } else if (mt === '口振') { tDr += pt; loc[lc].dr += pt; } else if (mt === 'でんさい') { tDen += pt; loc[lc].den += pt; } }
          var c = [no, i === 0 && r.invoices && r.invoices.length ? '有' : '', i === 0 && r.tk && r.tk.length ? '特' : '', r.payee, l ? +sh(l.ac) || sh(l.ac) : '', l ? l.genre || '' : '', l ? +sh(l.dc) || sh(l.dc) : '', l ? l.dn || '' : '',
            l ? (l.excl != null ? +l.excl : '') : '', l ? (l.tax != null ? +l.tax : '') : '', incl, i === 0 ? r.amount : '', pt || '', mt, i === 0 ? String(r.payDate || r.due || payDay).replace(/-/g, '/') : '',
            pt && mt === '振込' ? pt : '', pt && mt === '口振' ? pt : '', pt && mt === 'でんさい' ? pt : '', l ? (l.memo || l.note || '') : (r.note || ''),
            i === 0 && r.prev1 ? Math.round(r.prev1 / 100) / 10 : '', i === 0 && r.prev2 ? Math.round(r.prev2 / 100) / 10 : '', i === 0 ? '確定' : ''];
          var NUM = [8, 9, 10, 11, 12, 15, 16, 17, 19, 20];
          trs.push('<tr class="' + (i === 0 ? 'iv' : '') + '">' + c.map(function (v, k) { return '<td class="' + (NUM.indexOf(k) >= 0 ? 'r' : k === 18 ? 'nt' : '') + '">' + cv(v) + '</td>'; }).join('') + '</tr>');
        });
      });
      exTot = ex.reduce(function (t, r) { return t + r.amount; }, 0);
      var foot = function (lab, incl, bk, dr, dn, all) { return '<tr' + (all ? '' : ' class="sub"') + '><td colspan="10" class="r">' + esc(lab) + '</td><td class="r">' + cv(incl) + '</td><td class="r">' + (all ? cv(exTot) : '') + '</td><td class="r">' + (all ? cv(exTot) : '') + '</td><td colspan="2"></td><td class="r">' + cv(bk) + '</td><td class="r">' + cv(dr) + '</td><td class="r">' + cv(dn) + '</td><td colspan="4"></td></tr>'; };
      var head = ['No,', '証憑', '特記', '会社名', '科目CD', '科目', '部門CD', '部門', '税抜', '消費税', '税込', '請求書計', '取引先計', '方法', '決済日', '振込', '口座振替', 'でんさい', '備考', '前月', '前々月', '確認'];
      var side = dept === '工場' ? '工場' : dept === '総務' ? '本社' : dept;
      out.push('<section>' + hd('<経費-' + side + '>' + lbl + ' ' + (dept === '工場' ? '工場' : '本社') + '支払明細表', '支払日：' + payDay + '　作成日：' + made + '（決裁に回した内容から）') +
        '<table><colgroup>' + [3, 2.6, 2.6, 13, 3.2, 6.5, 3.4, 5, 6, 5, 6, 6, 6, 3.4, 5.6, 6, 6, 4, 14, 3.2, 3.2, 4].map(function (x) { return '<col style="width:' + x + '%">'; }).join('') + '</colgroup>' +
        '<thead><tr><th colspan="3"></th><th colspan="10">請求内容</th><th colspan="6">支払方法</th><th colspan="3">確定高実績（千円）</th></tr><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead>' +
        '<tbody>' + trs.join('') + '</tbody><tfoot>' + foot('合計', tIncl, tBank, tDr, tDen, true) +
        ['本社', '名古屋', '大阪'].filter(function (lc) { return loc[lc]; }).map(function (lc) { return foot(lc + ' 計', loc[lc].incl, loc[lc].bank, loc[lc].dr, loc[lc].den, false); }).join('') + '</tfoot></table></section>');
    }
    // ---- 仕入 ----
    var spr = rows.filter(function (r) { return r.kind !== '経費'; }), SUM = { 本社: {}, 工場: {} };
    var add = function (sd, k, v) { SUM[sd][k] = (SUM[sd][k] || 0) + (+v || 0); };
    if (spr.length) {
      var GR = ['国内営業', 'ソリューション', '工場'];
      var build = function (sideName, title) {
        var mine = function (g) { return sideName === '工場' ? g === '工場' : g !== '工場'; }, no = 0, trs = [];
        spr.forEach(function (r) {
          var s0 = r.sp || { pay: r.amount, bank: /振込/.test(r.method) ? r.amount : 0, den: /でんさい/.test(r.method) ? r.amount : 0, parts: {}, main: dept };
          var parts = Object.keys(s0.parts || {}).filter(function (g) { return s0.parts[g]; }).map(function (g) { return [g, s0.parts[g]]; });
          if (!parts.length) parts = [[s0.main || dept || '国内営業', s0.incl || r.amount]];
          if (!parts.some(function (x) { return mine(x[0]); })) return;
          no++; var own = mine(s0.main || dept), ratio = s0.incl ? (s0.excl || 0) / s0.incl : 1 / 1.1;
          parts.sort(function (a, c) { return (mine(c[0]) - mine(a[0])) || (GR.indexOf(a[0]) - GR.indexOf(c[0])); });
          var mth = [s0.bank ? '振' : '', s0.den ? 'で' : '', s0.cash ? '現金' : '', s0.ovs ? '海外' : '', s0.dr ? '口振' : ''].filter(Boolean).join('/');
          if (own) { add(sideName, '支払高', r.amount); add(sideName, '振込', s0.bank); add(sideName, 'でんさい', s0.den); add(sideName, '相殺', s0.off); add(sideName, '調整', s0.adj); add(sideName, '手数料', s0.fee); add(sideName, '社', 1); }
          parts.forEach(function (pv, i) {
            var g = pv[0], v = pv[1], lst = i === parts.length - 1, cross = !mine(g) || !own, exv = Math.round(v * ratio);
            var c = [no, r.invoices && r.invoices.length ? '有' : '', r.payee + (parts.length > 1 ? '/' + g + '分' : ''), +r.no || r.no, g, i === 0 && s0.bal != null ? s0.bal : '', cross ? '' : exv, '', lst && s0.adj && own ? s0.adj : '', cross ? '' : exv, cross ? '' : v - exv,
              lst && own && s0.off ? s0.off : '', lst && own && s0.fee ? s0.fee : '', cross ? (sideName === '工場' ? '本社計上' : '工場計上') : v, lst ? s0.rule || '' : '', lst && s0.site ? s0.site : '', lst ? mth : '',
              lst && own ? s0.bank : '', lst && own ? s0.den : '', lst && s0.due ? s0.due : '', lst ? (s0.by ? '✔ ' + s0.by : '') : '', lst ? (r.note || '') : ''];
            var NUM = [5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18];
            trs.push('<tr class="' + (i === 0 ? 'iv' : '') + '">' + c.map(function (x, k) { return '<td class="' + (NUM.indexOf(k) >= 0 ? 'r' : k === 21 ? 'nt' : '') + '">' + (i > 0 && k < 2 ? '' : cv(x)) + '</td>'; }).join('') + '</tr>');
          });
        });
        if (!trs.length) return '';
        var S0 = SUM[sideName], head = ['No,', '証憑', '会社名', 'コード', '部門', '月末買掛金残高(smile)', '請求書高', '先方', '当方', '確定高', '消費税', '相殺', '手数料', '支払高', '取決', 'でんさいサイト', '方法', '振込', 'でんさい', 'でんさい期日', '確認', '備考'];
        var tot = ['', '', '合計（決裁の部門がこの表の仕入先）', '', '', '', '', '', S0.調整 || '', '', '', S0.相殺 || '', S0.手数料 || '', S0.支払高 || 0, '', '', '', S0.振込 || 0, S0.でんさい || 0, '', '', ''];
        var ws = [2.6, 2.6, 13, 3.6, 5, 6, 6, 3.4, 3.4, 6, 5, 4.6, 4, 6, 8, 3.2, 3.4, 6, 6, 5.4, 4, 10], wt = ws.reduce(function (a, c) { return a + c; }, 0), NUMT = [5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 18];
        return '<section>' + hd(title, '作成：' + made + '（決裁に回した内容から）') + '<table><colgroup>' + ws.map(function (x) { return '<col style="width:' + (x / wt * 100).toFixed(2) + '%">'; }).join('') + '</colgroup>' +
          '<thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + trs.join('') + '</tbody><tfoot><tr>' + tot.map(function (x, k) { return '<td class="' + (NUMT.indexOf(k) >= 0 ? 'r' : '') + '">' + cv(x) + '</td>'; }).join('') + '</tr></tfoot></table></section>';
      };
      var pd = new Date(y, m - 2, 1), pl = pd.getFullYear() + '年' + (pd.getMonth() + 1) + '月分(' + m + '/末日支払)';
      out.push(build('本社', '<買掛>' + pl + ' 本社支払明細表'), build('工場', pd.getFullYear() + '.' + (pd.getMonth() + 1) + '月度(' + m + '/末日)分 工場支払明細表'));
    }
    // ---- まとめ ----
    var mr = [];
    if (ex.length) {
      var LOCS = ['本社', '名古屋', '大阪'], MS = ['振込', '口振', 'でんさい', '納税', '現金', '海外'].filter(function (x) { return exSum[x]; }).concat(Object.keys(exSum).filter(function (x) { return ['振込', '口振', 'でんさい', '納税', '現金', '海外'].indexOf(x) < 0; }));
      mr.push(['<支払方法>'], ['', '', '本社', '名古屋', '大阪', 'TOTAL']);
      MS.forEach(function (mt) { var o = exSum[mt] || {}; mr.push(['', mt].concat(LOCS.map(function (lc) { return o[lc] || 0; })).concat([LOCS.reduce(function (t, lc) { return t + (o[lc] || 0); }, 0)])); });
      mr.push(['', 'TOTAL'].concat(LOCS.map(function (lc) { return MS.reduce(function (t, mt) { return t + ((exSum[mt] || {})[lc] || 0); }, 0); })).concat([exTot]), ['', '前月', '', '', '', snap.prevTotal || ''], []);
      mr.push(['<区分>'], ['', (dept === '工場' ? '工場' : dept === '総務' ? '本社' : dept) + '(経費)', exTot], ['', '合計', exTot], []);
      mr.push(['<特記事項>'], ['支払先名', '', '支払高', '科目', '備考']);
      ex.filter(function (r) { return r.tk && r.tk.length; }).forEach(function (r) { mr.push([r.payee, '', r.amount, (r.lines && r.lines[0] && r.lines[0].genre) || '', r.tk.join(' ／ ')]); });
    }
    if (spr.length) {
      if (mr.length) mr.push([]);
      mr.push(['<仕入>'], ['', '本社(買掛)', '工場', '合計']);
      ['支払高', '振込', 'でんさい', '相殺', '調整', '手数料'].forEach(function (k) { mr.push([k, SUM.本社[k] || 0, SUM.工場[k] || 0, (SUM.本社[k] || 0) + (SUM.工場[k] || 0)]); });
      mr.push(['仕入先（社）', SUM.本社.社 || 0, SUM.工場.社 || 0, (SUM.本社.社 || 0) + (SUM.工場.社 || 0)], []);
      var byDue = {}; spr.forEach(function (r) { var s0 = r.sp; if (s0 && s0.den) { var d = s0.due || '（期日なし）'; byDue[d] = (byDue[d] || 0) + s0.den; } });
      if (Object.keys(byDue).length) { mr.push(['<でんさいの期日別>']); Object.keys(byDue).sort().forEach(function (d) { mr.push([d, byDue[d]]); }); }
    }
    var cell = function (r, i) { return r && r[i] != null ? cv(r[i]) : ''; };
    out.push('<section>' + hd(lbl + ' 支払明細表まとめ（' + (dept || '') + '）', '作成：' + made + '（決裁に回した内容から）') + '<table class="ma">' +
      mr.map(function (r) { return !r.length ? '<tr class="sp"><td colspan="6"></td></tr>' : r.length === 1 ? '<tr><th colspan="6" class="l">' + cell(r, 0) + '</th></tr>' : '<tr>' + [0, 1, 2, 3, 4, 5].map(function (i) { return '<td class="' + (typeof r[i] === 'number' ? 'r' : '') + '">' + cell(r, i) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></section>');
    var css = '@page{size:A4 landscape;margin:7mm}body{font-family:"Yu Gothic","Meiryo",sans-serif;color:#000;margin:0;font-size:8.5px}section{page-break-after:always}section:last-child{page-break-after:auto}' +
      '.hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:5px}.hd h1{font-size:14px;margin:0}.m{font-size:9.5px;color:#333}' +
      '.st{display:grid;grid-template-columns:repeat(4,46px);border:1px solid #000}.st div{border-left:1px solid #000;text-align:center}.st div:nth-child(4n+1){border-left:0}.st .t{font-size:9px;border-bottom:1px solid #000}.st .bx{height:40px}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #777;padding:1.5px 3px;vertical-align:top;overflow-wrap:anywhere}th{background:#e8e8e8;font-weight:600}' +
      'td.r{text-align:right;white-space:nowrap}.nt{font-size:8px}tr.iv td{border-top:1.4px solid #000}tfoot td{font-weight:700;background:#f2f2f2;border-top:2px solid #000}tfoot tr.sub td{font-weight:600;background:#fafafa;border-top:1px solid #777}thead{display:table-header-group}tr{page-break-inside:avoid}' +
      'table.ma{width:auto;min-width:60%;font-size:10px}table.ma td,table.ma th{padding:3px 8px}table.ma th.l{text-align:left;background:#f2f2f2}tr.sp td{border:0;height:6px}.np{margin:8px 0;font-size:12px}@media print{.np{display:none}}';
    var file = '支払明細表（' + (dept || '') + '・' + rd + '） - ' + y + String(m).padStart(2, '0') + day;
    w.document.open(); w.document.write('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>' + esc(file) + '</title><style>' + css + '</style></head><body><div class="np"><button onclick="print()">🖨 印刷する</button> 印刷の画面で「PDF に保存」も選べます（A4 横）</div>' + out.filter(Boolean).join('') + '</body></html>');
    w.document.close(); w.focus(); setTimeout(function () { try { w.print(); } catch (e) { } }, 400);
  }

  root.SettleView = { mount: mount, comment: comment, printReport: printReport };
})(typeof window !== 'undefined' ? window : this);
