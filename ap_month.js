/* ap_month.js — 支払管理の画面の「月を選ぶ」に ‹ › を付ける（前の月・次の月へ）
 *   APMonth.arrows('month')：選択の左右にボタンを置く。押すと月を1つ動かし、change を起こす（各画面の読み直しはそのまま動く）
 *   選択肢に無い月は、同じ書き方（「2026年10月払い」または「2026/10」）で足す。選択肢は新しい月が上
 */
(function (root) {
  'use strict';
  function ymAdd(v, n) { var m = String(v || '').match(/^(\d{4})\/(\d{2})$/); if (!m) return ''; var d = new Date(+m[1], +m[2] - 1 + n, 1); return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0'); }
  function labelOf(sel, v) { var long = [].some.call(sel.options, function (o) { return /年/.test(o.textContent); }); return long ? v.replace('/', '年') + '月払い' : v; }
  function step(sel, n) {
    var v = ymAdd(sel.value, n); if (!v) return;
    if (![].some.call(sel.options, function (o) { return o.value === v; })) {
      var o = document.createElement('option'); o.value = v; o.textContent = labelOf(sel, v);
      var after = [].find.call(sel.options, function (x) { return x.value < v; }); sel.insertBefore(o, after || null);
    }
    sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function arrows(id) {
    var sel = document.getElementById(id); if (!sel || sel.dataset.arrows) return; sel.dataset.arrows = '1';
    var mk = function (t, n, title) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = title; b.className = 'ap-mstep';
      b.style.cssText = 'min-width:30px;padding:2px 8px;margin:0 4px;font-size:16px;line-height:1.2;border:1px solid #c9d1e3;border-radius:6px;background:#fff;color:#1a2a5c;cursor:pointer';
      b.onclick = function () { step(sel, n); }; return b; };
    sel.parentNode.insertBefore(mk('‹', -1, '前の月'), sel);
    sel.parentNode.insertBefore(mk('›', 1, '次の月'), sel.nextSibling);
  }
  root.APMonth = { arrows: arrows, step: step };
})(window);
