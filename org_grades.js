/* 組織計画の「等級・年収」。給与原本は保存せず、手入力した試算条件だけを限定サイトへ保存する。 */
const OrgGrades = (() => {
  const G = OrgGradeCore, C = OrgStaffCore;
  const state = { grade: '', search: '', sort: 'grade', dir: 1, asOf: '', pay: [], payMonth: '', attemptedKey: '', busy: false, message: '人員情報の確認後、給与を自動で読み込みます。', generation: 0 };
  const yen = n => n == null ? '未確認' : Math.round(n).toLocaleString('ja-JP') + '円';
  const period = m => m == null ? '未確認' : Math.floor(m / 12) + '年' + (m % 12) + 'か月';
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const baseline = () => sc().id === (DB.staffSync || {}).baselineId;
  const sourceKey = () => OrgStaff.source.revision + ':' + OrgStaff.source.month + ':' + [...new Set(OrgStaff.source.rows.map(p => p.payrollSite).filter(Boolean))].sort().join(',');
  function payFor(p) {
    if (state.payMonth !== OrgStaff.source.month || !p.empCode || !p.payrollSite) return null;
    const rows = state.pay.filter(r => r.month === state.payMonth && C.codeKey(r.empCode) === C.codeKey(p.empCode) && r.site === p.payrollSite);
    if (rows.length !== 1 || C.fiscalYear(G.monthEnd(rows[0].month)) > year) return null;
    return rows[0];
  }
  function values(p) {
    const source = payFor(p), plan = G.payPlan(p, year), g = G.gradeInfo(p, year, baseline());
    const basic = plan && plan.basic != null ? G.amount(plan.basic) : source ? source.basic : null;
    const role = plan && plan.role != null ? G.amount(plan.role) : source ? source.role : null;
    const bonusBase = plan && plan.bonusBase != null ? G.amount(plan.bonusBase) : basic;
    const officer = p.employeeKind === '役員' || !!(plan && plan.isOfficer);
    const months = plan && plan.bonusMonths != null ? G.amount(plan.bonusMonths) : G.amount((sc().payAssumptions || {}).bonusMonths);
    const annualizable = !!(plan && plan.basic != null) || p.payType === '月給者' || officer;
    const sales = plan && plan.sales != null ? G.amount(plan.sales) : source ? source.sales : null;
    const history = state.pay.filter(r => C.codeKey(r.empCode) === C.codeKey(p.empCode) && r.site === p.payrollSite);
    const average = G.overtimeAverage(history, G.recentMonths(state.payMonth));
    const hours = plan && plan.overtimeHours != null ? G.amount(plan.overtimeHours) : G.amount((sc().payAssumptions || {}).overtimeHours);
    // 普通残業の実績単価は参考値。営業手当のある人は明細時間の意味が未確認なので自動採用しない。
    const rateRow = history.filter(r => r.overtimeHours > 0 && r.overtimePay > 0 && r.sales === 0).sort((a,b) => b.month.localeCompare(a.month))[0];
    const rate = plan && plan.overtimeRate != null ? G.amount(plan.overtimeRate) : sales === 0 && rateRow ? rateRow.overtimePay / rateRow.overtimeHours : null;
    const overtime = G.overtimeCost(hours, rate, sales);
    const forecast = annualizable ? G.forecast(basic, role, bonusBase, months, officer, sales, overtime) : { annual:null, monthly:null, bonus:null };
    return { officer, annualizable, p, grade: g.grade || '', info: g, tenure: G.tenure(p, g, state.asOf || today()), source, plan, basic, role, sales, average, hours, rate, overtime, bonusBase, months, ...forecast };
  }
  function ensurePay() {
    if (!state.busy && OrgStaff.source.loaded && G.monthEnd(OrgStaff.source.month) && state.attemptedKey !== sourceKey()) return loadPay();
  }
  async function loadPay() {
    if (state.busy) return;
    if (!G.monthEnd(OrgStaff.source.month) || !OrgStaff.source.loaded) { state.message = '先に「人員表との連携」で給与人事と人員の対応を確認してください。'; renderMain(); return; }
    const key = sourceKey(), month = OrgStaff.source.month, generation = ++state.generation;
    state.attemptedKey = key; state.failedSites = []; state.busy = true; state.message = '給与を読み込み中…'; if (mode === 'grades') renderMain();
    try {
      let selected;
      if (demo) selected = OrgStaff.source.rows.map((p, i) => G.salaryRow({ 従業員コード: p.empCode, 内訳: { 基本給: 230000 + i * 10000, 役付手当: i % 3 * 10000, 営業手当: i === 1 ? 40000 : 0, 勤怠_普通残業: 10 + i * 5, 普通残業: (10 + i * 5) * 2000, 支給合計: 300000 } }, month, p.payrollSite));
      else {
        const sites = [...new Set(OrgStaff.source.rows.map(p => p.payrollSite).filter(Boolean))];
        if (!sites.length || sites.some(s => !['本社', '工場'].includes(s))) throw new Error();
        const requests = G.recentMonths(month).flatMap(m => sites.map(site => ({m,site})));
        const parts = await Promise.allSettled(requests.map(async ({m,site}) => {
          const raw = await payrollGetFile(`history/payroll_detail/${m}_${site}.json`, { allow404: true });
          if (!Array.isArray(raw)) throw new Error();
          return raw.map(r => G.salaryRow(r, m, site));
        }));
        selected = parts.filter(p => p.status === 'fulfilled').flatMap(p => p.value);
        if (!parts.some(p => p.status === 'fulfilled')) throw new Error();
        state.failedSites = requests.filter((r, i) => parts[i].status === 'rejected').map(r => r.m + ' ' + r.site);
      }
      if (key !== sourceKey() || generation !== state.generation) { state.message = '人事情報が更新されたため、給与を再確認します。'; return; }
      state.pay = selected; state.payMonth = month;
      state.message = (demo ? '架空の給与です：' : '給与の基準月：') + month + '。支給明細の実績額（満額の契約給与とは限りません）。' + ((state.failedSites || []).length ? ' 一部の拠点を取得できませんでした。給与を読み直してください。' : '');
    } catch { state.pay = []; state.payMonth = ''; state.message = '給与を読めませんでした。閲覧権限・対象月のファイルを確認してください。手入力の試算条件は保持しています。'; }
    finally { state.busy = false; if (mode === 'grades') renderMain(); }
  }
  function render(depts) {
    const allowed = new Set(depts.map(d => d.name));
    const all = sc().people.filter(p => allowed.has(deptAt(p, year)) && present(p, year)).map(values);
    const gradeNames = [...new Set([...G.GRADES, ...all.map(r => r.grade).filter(Boolean)])];
    let rows = all.filter(r => (!state.grade || (state.grade === '?' ? !r.grade : r.grade === state.grade)) && (!state.search || [r.p.name, deptAt(r.p, year)].join(' ').includes(state.search)));
    const val = r => state.sort === 'grade' ? (gradeNames.indexOf(r.grade) < 0 ? gradeNames.length : gradeNames.indexOf(r.grade)) : state.sort === 'name' ? r.p.name : state.sort === 'tenure' ? r.tenure.months : r.annual;
    rows.sort((a, b) => { const x = val(a), y = val(b); if (x == null || y == null) return (x == null) - (y == null); return (typeof x === 'number' ? x - y : x.localeCompare(y, 'ja')) * state.dir; });
    const calculated = rows.filter(r => r.annual != null), total = calculated.reduce((n, r) => n + r.annual, 0);
    const bonus = G.amount((sc().payAssumptions || {}).bonusMonths), assumedHours = G.amount((sc().payAssumptions || {}).overtimeHours);
    const th = (label, key) => `<th><button class="btn sm" data-gsort="${key}">${label}${state.sort === key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    return `<div id="gradeView">
      <h2>等級別管理・概算年収</h2>
      <p class="muted">案「${esc(sc().name)}」・${year}年度。年齢は${year}/3/31時点。在級期間は下の基準日で確認します。現状の等級は給与人事、将来の等級は「予定を開く」で登録します。R表記とMGR表記は元のまま扱います。</p>
      <div class="grade-controls"><label>等級 <select id="gradeFilter"><option value="">すべて</option>${gradeNames.map(g => `<option value="${esc(g)}"${g === state.grade ? ' selected' : ''}>${esc(g)}</option>`).join('')}<option value="?"${state.grade === '?' ? ' selected' : ''}>未確認</option></select></label>
      <label>氏名・所属 <input id="gradeSearch" value="${esc(state.search)}" placeholder="絞り込み"></label>
      <label>在級期間の基準日 <input id="gradeAsOf" type="date" value="${esc(state.asOf || today())}"></label>
      <label>年間の賞与月数 <input id="gradeBonus" type="number" min="0" step="0.1" value="${bonus == null ? '' : bonus}" placeholder="例：4.0"></label>
      <button class="btn" id="gradeApplyBonus">賞与月数を反映</button><label>想定残業時間（月）<input id="gradeOvertime" type="number" min="0" step="0.1" value="${assumedHours ?? ''}" placeholder="例：20"></label><button class="btn" id="gradeApplyOvertime">残業時間を反映</button><button class="btn" id="gradeLoadPay"${state.busy ? ' disabled' : ''}>${demo ? 'サンプル給与を読み直す' : '給与を読み直す'}</button></div>
      <p class="muted">${esc(state.message)}</p>
      <p>概算年収＝（基本給＋役職手当＋営業手当＋追加残業代）×12＋賞与基準額×年間の賞与月数。営業手当がある人は月20時間分を含み、超過時間だけ追加します。普通残業の試算で、深夜・休日・月60時間超の割増は含みません。賞与基準額の初期値は基本給。役員は賞与なしです。税・社会保険料・年度途中の在籍月数は含みません。</p>
      <div class="sum"><div class="sc"><b>${rows.length}人</b><span>表示中</span></div><div class="sc"><b>${yen(calculated.length ? total : null)}</b><span>概算年収合計（計算できた${calculated.length}/${rows.length}人分）</span></div><div class="sc"><b>${rows.length - calculated.length}人</b><span>試算条件が未確認</span></div></div>
      <div class="grade-summary">${[...gradeNames, ''].filter(g => all.some(r => r.grade === g)).map(g => { const list = all.filter(r => r.grade === g), counted = list.filter(r => r.annual != null); return `<button class="btn" data-gfilter="${esc(g || '?')}">${esc(g || '未確認')}：${list.length}人／年収${yen(counted.length ? counted.reduce((a, r) => a + r.annual, 0) : null)}（${counted.length}人分）</button>`; }).join(' ')}</div>
      <p class="muted">給与はこの画面を開くと自動取得します。基本給は契約上の満額ではなく支給実績です。入社月や欠勤等の影響は自動補正しません。日給・時給者も実績額を表示しますが、年収は月額の想定を入力するまで計算しません。残業平均は直近3か月の普通残業時間です（深夜・休日は別）。取得月数を併記し、明細のない月は平均から除きます。給与明細で省略された手当・普通残業は0と扱います。営業手当のある人の残業単価は個別に入力してください。賞与月数はご自身で設定してください。将来年度の給与は昇給を含めない据え置きの仮定です。</p>
      <div class="tw"><table><thead><tr><th class="l">氏名</th>${th('等級', 'grade')}<th>所属</th><th>年齢</th>${th('在級期間', 'tenure')}<th>基本給（支給実績／想定月額）</th><th>役職手当（月額）</th><th>営業手当（月額）</th><th>直近の平均普通残業</th><th>想定残業時間（月）</th><th>残業単価・追加額</th><th>賞与基準額</th><th>賞与月数（年間）</th>${th('概算年収', 'annual')}<th>根拠・編集</th></tr></thead><tbody>
      ${rows.map((r, i) => {
        const fields = [['basic', '基本給（月額・空欄は原本）', r.plan?.basic], ['role', '役職手当（月額・空欄は原本）', r.plan?.role], ['sales', '営業手当（月額・20時間分を含む・空欄は原本）', r.plan?.sales], ['overtimeHours', '想定残業時間（月・空欄は案の共通値）', r.plan?.overtimeHours], ['overtimeRate', '普通残業の試算単価（円／時間・割増込み）', r.plan?.overtimeRate], ['bonusBase', '賞与基準額（空欄は基本給）', r.plan?.bonusBase], ['bonusMonths', '年間賞与月数（空欄は案の共通値）', r.plan ? r.plan.bonusMonths : null]];
        const start = (r.p.gradeStarts || []).find(x => x.grade === r.grade && x.from === (r.info.from ?? null) && (r.info.type !== 'source' || x.sourceSince === r.info.sinceMonth));
        return `<tr data-grade-row="${i}"><td class="l"><b>${esc(r.p.name)}</b><br><button class="btn sm" data-pid="${esc(r.p.id)}">予定を開く</button></td><td>${esc(r.grade || '未確認')}<small>${r.info.type === 'source' ? '給与人事 ' + esc(r.info.month) : r.info.type === 'plan' ? esc(r.info.from) + '年の登録' : '人員の対応を確認'}</small></td><td>${esc(deptAt(r.p, year))}</td><td>${ageAt(r.p, year) ?? '未確認'}</td>
          <td>${period(r.tenure.months)}<small>${esc(r.tenure.label)}${r.tenure.since ? '<br>' + esc(r.tenure.since) + (r.tenure.through ? '〜' + esc(r.tenure.through) : 'から') : ''}</small></td>
          <td>${yen(r.basic)}<small>${esc(r.p.payType || '給与区分未確認')}${r.plan?.basic != null ? '・想定' : '・支給実績'}</small></td><td>${yen(r.role)}</td><td>${yen(r.sales)}${r.sales > 0 ? '<small>20時間分を含む</small>' : ''}</td><td>${r.average.hours == null ? '未確認' : r.average.hours.toFixed(1) + '時間'}<small>${G.recentMonths(state.payMonth).join('〜').replace(/〜[^〜]+〜/, '〜')}・${r.average.samples}/3か月</small></td><td>${r.hours == null ? '未設定' : r.hours + '時間'}</td><td>${yen(r.rate)}／時間<small>追加：${yen(r.overtime)}／月${r.plan?.overtimeRate != null ? '（入力単価）' : r.rate != null ? '（明細の実績単価・参考）' : '（単価未確認）'}</small></td><td>${r.officer ? '対象外' : yen(r.bonusBase)}</td><td>${r.officer ? '役員・賞与なし' : r.months == null ? '未設定' : r.months + 'か月'}</td><td><b>${yen(r.annual)}</b><small>${r.annual != null ? '税・控除前の試算' : !r.annualizable ? '月額の想定を入力' : !r.officer && r.months == null ? '賞与月数を設定' : r.hours == null ? '想定残業時間を設定' : r.overtime == null ? '残業単価を確認' : '金額・賞与月数・残業条件を確認'}</small></td>
          <td><small>${r.plan ? esc(r.plan.from) + '年度からの手入力想定' : r.source ? esc(r.source.month) + '支給実績を据え置き' : '給与未接続・未確認'}</small>
          <details class="grade-edit"><summary>在級開始日・試算条件を編集</summary><div class="frm">
          <label>この等級の確認済み開始日<input data-grade-start type="date" value="${esc(start ? start.date : '')}"></label><button class="btn sm" data-grade-start-save>開始日を保存</button>
          <label><input data-grade-officer type="checkbox"${r.officer ? ' checked' : ''}${r.p.employeeKind === '役員' ? ' disabled' : ''} style="width:auto"> 役員の想定（賞与なし）${r.p.employeeKind === '役員' ? '・人員表の区分が役員' : ''}</label><p>試算条件は${year}年度から有効です。翌年度以降にも引き継ぎ、別の年度に入力すれば変更できます。空欄の金額は原本の自動取得に従います。</p>
          ${fields.map(([k, label, v]) => `<label>${label}<input type="number" min="0" step="${['bonusMonths','overtimeHours','overtimeRate'].includes(k) ? '0.1' : '1'}" data-grade-pay="${k}"${r.officer && k.startsWith('bonus') ? ' disabled' : ''} value="${v == null ? '' : v}"></label>`).join('')}
          <button class="btn sm pri" data-grade-pay-save>この試算条件を保存</button> <button class="btn sm" data-grade-pay-reset>この年度の手入力を取り消す</button>
          </div></details></td></tr>`;
      }).join('') || '<tr><td colspan="15">対象の人がいません。</td></tr>'}</tbody></table></div>
      <p class="muted">在級開始日が分からない場合、月ごとの記録が連続している期間だけを「少なくとも」と表示します。最初の記録を昇格日とは扱いません。給与の値を元の給与システムへ書き戻すことはありません。</p></div>`;
  }
  function bind(depts) {
    const root = document.getElementById('gradeView'); if (!root) return;
    const allowed = new Set(depts.map(d => d.name));
    // 編集対象は画面のIDで指定し、氏名では照合しない。
    const candidates = sc().people.filter(p => allowed.has(deptAt(p, year)) && present(p, year));
    const visibleRows = root.querySelectorAll('tr[data-grade-row]');
    visibleRows.forEach(tr => {
      const id = tr.querySelector('[data-pid]').getAttribute('data-pid'), p = candidates.find(p => p.id === id);
      if (!p) return;
      tr.querySelector('[data-grade-start-save]').onclick = () => {
        const info = G.gradeInfo(p, year, baseline()), value = tr.querySelector('[data-grade-start]').value;
        if (!info.grade || (value && !C.dateKey(value))) { alert('等級と開始日を確認してください。'); return; }
        p.gradeStarts = (p.gradeStarts || []).filter(x => !(x.grade === info.grade && x.from === (info.from ?? null) && (info.type !== 'source' || x.sourceSince === info.sinceMonth)));
        if (value) p.gradeStarts.push({ grade: info.grade, from: info.from ?? null, sourceSince: info.type === 'source' ? info.sinceMonth : null, date: value });
        touch(); renderMain();
      };
      tr.querySelector('[data-grade-officer]').onchange = e => { tr.querySelectorAll('[data-grade-pay^=bonus]').forEach(el => el.disabled = e.target.checked); };
      tr.querySelector('[data-grade-pay-save]').onclick = () => {
        const input = { from: year, isOfficer: p.employeeKind === '役員' || tr.querySelector('[data-grade-officer]').checked };
        for (const el of tr.querySelectorAll('[data-grade-pay]')) { const raw = el.value; if (raw !== '' && G.amount(raw) == null) { alert('金額・月数は0以上の数字で入力してください。'); return; } input[el.dataset.gradePay] = G.amount(raw); }
        p.payPlans = (p.payPlans || []).filter(x => x.from !== year); p.payPlans.push(input); touch(); renderMain();
      };
      tr.querySelector('[data-grade-pay-reset]').onclick = () => { p.payPlans = (p.payPlans || []).filter(x => x.from !== year); touch(); renderMain(); };
    });
    root.querySelector('#gradeFilter').onchange = e => { state.grade = e.target.value; renderMain(); };
    root.querySelector('#gradeSearch').onchange = e => { state.search = e.target.value; renderMain(); };
    root.querySelector('#gradeAsOf').onchange = e => { if (C.dateKey(e.target.value)) { state.asOf = e.target.value; renderMain(); } };
    root.querySelector('#gradeApplyBonus').onclick = () => { const value = root.querySelector('#gradeBonus').value; if (value !== '' && G.amount(value) == null) { alert('賞与月数は0以上の数字で入力してください。'); return; } sc().payAssumptions = { ...sc().payAssumptions, bonusMonths: G.amount(value) }; touch(); renderMain(); };
    root.querySelector('#gradeApplyOvertime').onclick = () => { const v = root.querySelector('#gradeOvertime').value; if (v !== '' && G.amount(v) == null) { alert('残業時間は0以上で入力してください。'); return; } sc().payAssumptions = { ...sc().payAssumptions, overtimeHours: G.amount(v) }; touch(); renderMain(); };
    root.querySelector('#gradeLoadPay').onclick = loadPay;
    root.querySelectorAll('[data-gfilter]').forEach(b => b.onclick = () => { state.grade = b.dataset.gfilter; renderMain(); });
    root.querySelectorAll('[data-gsort]').forEach(b => b.onclick = () => { state.dir = state.sort === b.dataset.gsort ? -state.dir : 1; state.sort = b.dataset.gsort; renderMain(); });
    ensurePay();
  }
  function scenarioChanged() { state.grade = ''; state.search = ''; }
  return { render, bind, loadPay, ensurePay, scenarioChanged };
})();
