/* 等級・在級期間・概算年収。実データや賃金の決まりは埋め込まない。 */
(function (root) {
  'use strict';
  const GRADES = ['R1-1', 'R1-2', 'R1-3', 'R2', 'R3-1', 'R3-2', 'R4-1', 'R4-2', 'R5'];
  const code = x => String(x == null ? '' : x).trim().replace(/^0+(?=\d)/, '');
  function grade(value) {
    const s = String(value || '').normalize('NFKC').replace(/[‐‑–—－]/g, '-').toUpperCase();
    const matches = [...s.matchAll(/(?:^|[^A-Z0-9-])((?:R|MGR)[1-5](?:-[1-3])?)(?![A-Z0-9-])/g)].map(m => m[1]);
    const unique = [...new Set(matches)]; return unique.length === 1 ? unique[0] : null;
  }
  const monthNumber = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '') ? +s.slice(0, 4) * 12 + +s.slice(5, 7) - 1 : null;
  function monthEnd(s) { if (monthNumber(s) == null) return null; const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)); return d.toISOString().slice(0, 10); }
  function evidence(payroll, empCode, site, month) {
    if (!code(empCode) || monthNumber(month) == null) return null;
    const rows = payroll.filter(r => code(r.従業員コード) === code(empCode) && String(r.拠点 || '') === String(site || ''));
    const at = m => rows.filter(r => r.年月 === m);
    const latest = at(month); if (latest.length !== 1) return null;
    const g = grade(latest[0].所属); if (!g) return null;
    let since = month, n = monthNumber(month), samples = 1;
    while (true) {
      n--; const m = Math.floor(n / 12) + '-' + String(n % 12 + 1).padStart(2, '0');
      const prev = at(m); if (prev.length !== 1 || grade(prev[0].所属) !== g) break;
      since = m; samples++;
    }
    return { grade: g, month, sinceMonth: since, samples, site: String(site || '') };
  }
  function gradeInfo(p, year, baseline) {
    const plans = (p.grades || []).filter(e => e.from <= year).sort((a, b) => a.from - b.from);
    const observed = [...(p.hrGradeHistory || []), ...(p.hrGrade ? [p.hrGrade] : [])].filter(h => monthNumber(h.month) != null && +h.month.slice(0, 4) - (+h.month.slice(5, 7) < 4 ? 1 : 0) <= year).sort((a, b) => a.month.localeCompare(b.month)).pop() || null;
    const sourceYear = observed ? +observed.month.slice(0, 4) - (+observed.month.slice(5, 7) < 4 ? 1 : 0) : null;
    const planned = baseline && observed ? plans.filter(e => e.from > sourceYear).pop() : plans[plans.length - 1];
    if (planned) return { grade: planned.grade, from: planned.from, type: 'plan', evidence: observed && observed.grade === planned.grade ? observed : null };
    return observed ? { ...observed, type: 'source' } : { grade: null, type: 'unknown' };
  }
  function fullMonths(start, end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || start > end) return null;
    return (+end.slice(0, 4) - +start.slice(0, 4)) * 12 + (+end.slice(5, 7) - +start.slice(5, 7)) - (+end.slice(8, 10) < +start.slice(8, 10) ? 1 : 0);
  }
  function tenure(p, info, asOf) {
    if (!info.grade) return { months: null, label: '等級未確認' };
    const confirmed = (p.gradeStarts || []).find(x => x.grade === info.grade && x.from === (info.from ?? null) && (info.type !== 'source' || x.sourceSince === info.sinceMonth));
    if (confirmed && confirmed.date) return { months: fullMonths(confirmed.date, asOf), label: confirmed.date > asOf ? 'この基準日では開始前' : '開始日を確認済み', since: confirmed.date };
    const observed = info.type === 'source' ? info : info.evidence;
    if (observed && (info.type === 'source' || info.from <= +observed.month.slice(0, 4))) {
      const end = [asOf, monthEnd(observed.month)].sort()[0], start = monthEnd(observed.sinceMonth);
      return { months: fullMonths(start, end), label: '少なくとも（記録で確認できる期間）', since: observed.sinceMonth, through: observed.month };
    }
    return { months: null, label: info.type === 'plan' ? '開始日未確認（' + info.from + '年の登録）' : '開始日未確認' };
  }
  function amount(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(String(value).replace(/,/g, '').trim()); return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function salaryRow(row, month, site) {
    const detail = row.内訳 || {};
    // 支給控除の原本は、支給がない項目を省略する。明細全体がない場合とは区別する。
    const complete = amount(detail.支給合計) != null || amount(detail.課税支給合計) != null;
    const item = key => Object.prototype.hasOwnProperty.call(detail, key) ? amount(detail[key]) : complete ? 0 : null;
    return { empCode: String(row.従業員コード || ''), site, month,
      basic: item('基本給'), role: item('役付手当') };
  }
  function forecast(basic, role, bonusBase, bonusMonths, officer = false) {
    if (officer) { bonusBase = 0; bonusMonths = 0; }
    const values = [basic, role, bonusBase, bonusMonths].map(amount);
    if (values.some(x => x == null)) return { annual: null, monthly: null, bonus: null };
    const [b, r, bb, bm] = values;
    const bonus = Math.round(bb * bm), monthly = b + r, annual = Math.round(monthly * 12 + bonus);
    return Number.isSafeInteger(annual) ? { annual, monthly, bonus } : { annual: null, monthly: null, bonus: null };
  }
  function payPlan(p, year) { return (p.payPlans || []).filter(e => e.from <= year).sort((a, b) => a.from - b.from).pop() || null; }
  const api = { GRADES, grade, evidence, gradeInfo, monthEnd, fullMonths, tenure, amount, salaryRow, forecast, payPlan };
  root.OrgGradeCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
