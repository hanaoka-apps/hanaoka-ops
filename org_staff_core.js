/* 組織計画：人員の照合と年度開始直前の年齢。実データは置かない。 */
(function (root) {
  'use strict';
  const G = root.OrgGradeCore || (typeof require === 'function' ? require('./org_grade_core.js') : null);
  const copy = x => JSON.parse(JSON.stringify(x));
  const nameKey = x => String(x || '').normalize('NFKC').replace(/[\s　・]/g, '').replace(/髙/g, '高');
  const codeKey = x => String(x == null ? '' : x).trim().replace(/^0+(?=\d)/, '');
  function dateKey(value) {
    const m = String(value || '').trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:T.*)?$/);
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number), dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }
  function ageAt(p, year) {
    const dob = dateKey(p.birthDate);
    if (!dob || !Number.isInteger(Number(year))) return null;
    const [y, m, d] = dob.split('-').map(Number);
    const age = Number(year) - y - (m > 3 || (m === 3 && d > 31) ? 1 : 0);
    return age < 0 ? null : age;
  }
  const yearOf = x => { const d = dateKey(x); return d ? Number(d.slice(0, 4)) : null; };
  const fiscalYear = date => { const s = dateKey(date); return s ? Number(s.slice(0, 4)) - (Number(s.slice(5, 7)) < 4 ? 1 : 0) : null; };
  const eligible = p => ['社員', '契約', 'パート', '特定技能', '役員'].includes(p.Kind);
  function roster(persons, payroll) {
    if (!Array.isArray(persons) || !persons.length) throw new Error('人員表が空です。元データを確認してください。');
    const month = (payroll || []).map(e => String(e.年月 || '')).filter(Boolean).sort().pop() || '';
    const latest = (payroll || []).filter(e => String(e.年月 || '') === month);
    const rows = persons.filter(eligible).map(p => {
      const matches = p.EmpCode ? latest.filter(e => codeKey(e.従業員コード) === codeKey(p.EmpCode)) : [];
      // 拠点間でコードが重なる場合だけ、氏名の完全一致も確かめる。
      const named = matches.length > 1 && nameKey(p.Title) ? matches.filter(e => nameKey(e.従業員名) === nameKey(p.Title)) : [];
      const e = matches.length === 1 ? matches[0] : named.length === 1 ? named[0] : null;
      return { staffId: String(p.id), empCode: String(p.EmpCode || ''), name: String(p.Title || ''),
        dept: String(p.UnitPath || ''), title: String(p.JobLabel || ''), kind: p.Kind, state: p.State || '在籍',
        birthDate: e ? dateKey(e.生年月日) : null, startDate: dateKey(p.StartDate) || (e ? dateKey(e.入社年月日) : null),
        endDate: dateKey(p.EndDate), payrollSite: e ? String(e.拠点 || '') : '', payType: e ? String(e.給与種別名称 || '') : '',
        gradeEvidence: e ? G.evidence(payroll, p.EmpCode, e.拠点, month) : null, payrollAmbiguous: matches.length > 1 && !e };
    });
    if (!rows.length) throw new Error('対象となる人員がありません。更新を止めました。');
    if (new Set(rows.map(p => p.staffId)).size !== rows.length) throw new Error('人員表のIDが重複しています。更新を止めました。');
    return { rows, month };
  }
  function candidate(p, rows) {
    if (p.staffId) return rows.find(r => r.staffId === String(p.staffId)) || null;
    const code = codeKey(p.empCode);
    const matches = code ? rows.filter(r => codeKey(r.empCode) === code) : rows.filter(r => nameKey(r.name) && nameKey(r.name) === nameKey(p.name));
    return matches.length === 1 ? matches[0] : null;
  }
  function actualAt(p, year) {
    return (p.actualHistory || []).filter(h => h.year <= year).sort((a, b) => b.year - a.year)[0] || null;
  }
  function departmentGroup(name) {
    const d = String(name || '');
    if (/^工場(?:\/|$)/.test(d)) return '工場・技術・品質';
    if (d.includes('ソリューション')) return 'ソリューション';
    if (d.includes('業務センター')) return '業務センター';
    if (/^本社\/営業部(?:\/|$)/.test(d)) return '営業';
    if (/^(役員|本社)(?:\/|$)/.test(d)) return '経営・総務';
    return null;
  }
  const officialDepartment = name => /^(本社|工場|役員)(?:\/|$)/.test(String(name || ''));
  function departmentAliases(db, rows) {
    const pairs = new Map();
    for (const sn of db.scenarios) for (const p of sn.people) {
      const r = rows.find(r => r.staffId === String(p.staffId || ''));
      if (!r || !p.dept || !r.dept || officialDepartment(p.dept)) continue;
      if (!pairs.has(p.dept)) pairs.set(p.dept, []);
      pairs.get(p.dept).push(r.dept.split('/'));
    }
    const aliases = { ...((db.staffSync || {}).deptAliases || {}) };
    for (const [old, paths] of pairs) {
      const common = paths[0].filter((part, i) => paths.every(path => path.slice(0, i + 1).join('/') === paths[0].slice(0, i + 1).join('/')));
      if (common.length) aliases[old] = common.join('/');
    }
    return aliases;
  }
  function departmentAt(p, year, aliases = {}) {
    const h = actualAt(p, year), source = p.sourceDept && p.sourceYear <= year;
    let d = h ? h.dept : source ? p.sourceDept : p.dept;
    const floor = h ? h.year : source ? p.sourceYear : null;
    for (const move of (p.moves || []).slice().sort((a, b) => a.from - b.from)) {
      if (move.from <= year && (floor == null || move.from > floor)) d = move.dept;
    }
    return aliases[d] || d;
  }
  function sync(db, rows, today, departments = []) {
    const next = copy(db), y = fiscalYear(today), notices = [];
    if (y == null) throw new Error('更新日を確認できません。');
    const baseline = next.scenarios.find(s => s.id === (next.staffSync || {}).baselineId);
    next.staffSync = { ...next.staffSync, deptAliases: departmentAliases(next, rows) };
    for (const sn of next.scenarios) {
      const seen = new Set();
      for (const p of sn.people) {
        if (!p.staffId) continue;
        if (seen.has(String(p.staffId))) throw new Error('同じ案で人員の対応が重複しています。確認してください。');
        seen.add(String(p.staffId));
        const r = rows.find(r => r.staffId === String(p.staffId));
        if (!r) { notices.push('対応する人が元データに見つかりません。退職にはせず、前回の情報を残しています。'); continue; }
        p.name = r.name; p.empCode = r.empCode;
        if (r.birthDate) { p.birthDate = r.birthDate; p.birth = yearOf(r.birthDate); }
        if (r.startDate) p.join = yearOf(r.startDate);
        p.sourceState = r.state;
        p.sourceDept = r.dept; p.sourceYear = y;
        if (r.kind) p.employeeKind = r.kind;
        if (r.gradeEvidence) {
          const history = [...(p.hrGradeHistory || []), ...(p.hrGrade ? [p.hrGrade] : [])].filter(h => h.month !== r.gradeEvidence.month);
          p.hrGradeHistory = [...new Map(history.map(h => [h.month, h])).values(), copy(r.gradeEvidence)].sort((a, b) => a.month.localeCompare(b.month));
          p.hrGrade = copy(r.gradeEvidence);
        }
        if (r.payrollSite) p.payrollSite = r.payrollSite;
        if (r.payType) p.payType = r.payType;
        if (baseline === sn) {
          p.actualHistory = (p.actualHistory || []).filter(h => h.year !== y);
          p.actualHistory.push({ year: y, dept: r.dept, title: r.title, state: r.state, startDate: r.startDate, endDate: r.endDate });
        }
      }
    }
    if (baseline && next.staffSync.autoAdd) {
      for (const r of rows.filter(r => ['在籍', '退職予定', '入社予定'].includes(r.state))) {
        if (baseline.people.some(p => String(p.staffId || '') === r.staffId)) continue;
        if (baseline.people.some(p => !p.staffId && nameKey(p.name) === nameKey(r.name))) { notices.push('新しい人に一致する手入力の人がいるため、自動追加を保留しています。対応を確認してください。'); continue; }
        baseline.people.push({ id: 'staff_' + r.staffId, staffId: r.staffId, empCode: r.empCode, name: r.name,
          dept: r.dept, birth: yearOf(r.birthDate), birthDate: r.birthDate, join: yearOf(r.startDate), retire: null,
          sourceDept: r.dept, sourceYear: y, employeeKind: r.kind, hrGradeHistory: r.gradeEvidence ? [copy(r.gradeEvidence)] : [], hrGrade: r.gradeEvidence || null, payrollSite: r.payrollSite || '', payType: r.payType || '',
          titles: [], grades: [], moves: [], events: [], roleKeys: [], note: '', flag: false,
          actualHistory: [{ year: y, dept: r.dept, title: r.title, state: r.state, startDate: r.startDate, endDate: r.endDate }] });
      }
    }
    for (const name of new Set([...rows.map(r => r.dept), ...departments].filter(Boolean))) {
      let d = next.depts.find(d => d.name === name);
      if (!d) { d = { name }; next.depts.push(d); }
      d.group = departmentGroup(name) || d.group || '人員表';
    }
    if (baseline) {
      for (const p of baseline.people) for (const h of p.actualHistory || []) {
        if (h.dept && !next.depts.some(d => d.name === h.dept)) next.depts.push({ name: h.dept, group: '人員表' });
      }
    }
    return { db: next, notices: [...new Set(notices)] };
  }
  function presentActual(h, year) {
    // 人員は年度中の現状。年齢だけを年度開始直前の3/31で統一する。
    if (h.state === '退職') return false;
    if (h.state === '入社予定' && !h.startDate) return false;
    if (h.startDate && yearOf(h.startDate) > year) return false;
    if (h.endDate && yearOf(h.endDate) < year) return false;
    return true;
  }
  function planPerson(person, year) {
    const p = copy(person), history = p.actualHistory || [], h = actualAt(p, year);
    const years = new Set(history.map(x => x.year));
    p.moves = [...(p.moves || []).filter(x => !years.has(x.from)), ...history.map(x => ({ from: x.year, dept: x.dept }))].sort((a, b) => a.from - b.from);
    p.titles = [...(p.titles || []).filter(x => !years.has(x.from)), ...history.map(x => ({ from: x.year, title: x.title }))].sort((a, b) => a.from - b.from);
    if (h && h.state === '退職') p.retire = Math.min(p.retire == null ? Infinity : p.retire, h.year);
    else if (h && presentActual(h, year) && p.retire != null && p.retire <= year) p.retire = null;
    if (h && h.endDate && h.state === '退職予定') p.retire = yearOf(h.endDate) + 1;
    if (p.hrGrade) {
      const info = G.gradeInfo(p, year, true);
      if (info.grade) {
        p.grades = [...(p.grades || []).filter(x => x.from !== year), { from: year, grade: info.grade }];
        const confirmed = (p.gradeStarts || []).find(x => x.grade === info.grade && x.from === (info.from ?? null) && (info.type !== 'source' || x.sourceSince === info.sinceMonth));
        if (confirmed) p.gradeStarts.push({ ...confirmed, from: year, sourceSince: null });
      }
    }
    delete p.actualHistory;
    return p;
  }
  const api = { officialDepartment, departmentGroup, departmentAliases, departmentAt, planPerson, nameKey, codeKey, dateKey, ageAt, yearOf, fiscalYear, eligible, roster, candidate, actualAt, presentActual, sync };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OrgStaffCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
