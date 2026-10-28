/* =============================================================
 * ap_dept.js — 経費の「決裁の部門」（支払決済でだれが説明するか）を決める
 *   経費の画面（支払明細表）と 支払（決裁・出力）（支払決済に回す部門）で同じ決め方にする
 *   仕訳の部門（会計）とは別：大阪の家賃は仕訳は 002230（大阪）だが、説明は総務
 *
 *   順番：
 *    1. 工場の経費 → 工場
 *    2. 10日・20日払い → 総務（月末だけ営業が自分の分を説明する）
 *    3. その請求書で人が選んだ部門（確認の記録 CheckLog の {act:'決裁の部門', dept}）
 *    4. 同じ支払先で前に人が選んだ部門（覚える）
 *    5. 総務が説明する科目（expense.rules.settleDept.soumuAccounts。既定：賃借料・保険料・顧問料・リース料・車両消耗油脂・事務消耗品）→ 総務
 *    6. 部門コード：国内営業（002220・002230・002240）／ソリューション（002410）。ほかは総務
 *   科目・部門は、請求書の仕訳でいちばん金額の大きい行で見る
 * ============================================================= */
(function (root) {
  'use strict';
  // 総務が説明する科目（2026-10-28 決定）。科目名の頭で合わせる（「車両消耗油脂費」も「車両消耗油脂」に当たる）
  var DEF = { soumuAccounts: ['賃借料', '保険料', '顧問料', 'リース料', '車両消耗油脂', '事務消耗品'], kokunai: ['002220', '002230', '002240'], solution: ['002410'] };
  var DEPTS = ['総務', '国内営業', 'ソリューション'];
  function c6(s) { return String(s == null ? '' : s).trim().padStart(6, '0'); }
  function norm(s) { return String(s || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲|[\s　・.,、。]/g, ''); }
  // 人が選んだ部門（いちばん新しい記録。auto:true は「自動に戻す」）
  function manual(log) {
    var m = (log || []).filter(function (e) { return e && e.act === '決裁の部門'; }).pop();
    return m && !m.auto && DEPTS.indexOf(m.dept) >= 0 ? m.dept : '';
  }
  // 覚えたもの：支払先ごとに、人が選んだ部門のうち払う月がいちばん新しいもの。list：[{payee, ym, log}]
  function learn(list) {
    var o = {}, at = {};
    (list || []).forEach(function (x) {
      var m = manual(x.log), k = norm(x.payee); if (!m || !k) return;
      if (at[k] == null || String(x.ym || '') >= at[k]) { at[k] = String(x.ym || ''); o[k] = m; }
    });
    return o;
  }
  // inv：{payee, round, loc, lines:[{acct（科目名）, dept（部門コード）, incl（税込）}], log}、rules：expense.rules、learned：learn() の結果
  function decide(inv, rules, learned) {
    if (inv.loc === '工場') return { dept: '工場', why: '工場の経費' };
    if (inv.round && inv.round !== '月末') return { dept: '総務', why: inv.round + '払いは総務が説明' };
    var m = manual(inv.log); if (m) return { dept: m, why: '人が選んだ', manual: true };
    var l = learned && learned[norm(inv.payee)]; if (l) return { dept: l, why: '前に同じ支払先で選んだ部門', learned: true };
    var R = Object.assign({}, DEF, (rules && rules.settleDept) || {});
    var big = (inv.lines || []).slice().sort(function (a, b) { return Math.abs(+b.incl || 0) - Math.abs(+a.incl || 0); })[0];
    if (big && big.acct && R.soumuAccounts.some(function (a) { return String(big.acct).indexOf(a) === 0; })) return { dept: '総務', why: '科目「' + big.acct + '」は総務が説明' };
    var d = big ? c6(big.dept) : '';
    if (R.kokunai.indexOf(d) >= 0) return { dept: '国内営業', why: '部門 ' + d };
    if (R.solution.indexOf(d) >= 0) return { dept: 'ソリューション', why: '部門 ' + d };
    return { dept: '総務', why: '部門が営業でない' };
  }
  root.APDept = { decide: decide, learn: learn, manual: manual, DEPTS: DEPTS };
})(typeof window !== 'undefined' ? window : this);
