/* 組織計画専用。人員表と給与は読むだけ。取得した原本は保存しない。 */
const OrgStaff = (() => {
  const C = OrgStaffCore;
  const source = { revision: 0, rows: [], month: '', loaded: false, busy: false, message: '未接続', notices: [], timer: null, key: 0 };
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const groups = ['営業', 'ソリューション', '業務センター', '工場・技術・品質', '経営・総務', '人員表'];
  function demoSource() {
    const rows = demoDB().scenarios[0].people.map((p, i) => ({ id: i + 1, Title: p.name, EmpCode: '900' + i,
      UnitPath: p.dept, JobLabel: (p.titles[0] || {}).title || '', Kind: i === 0 ? '役員' : '社員', State: '在籍' }));
    const payroll = ['2026-07', '2026-08', '2026-09', '2026-10'].flatMap(month => demoDB().scenarios[0].people.map((p, i) => ({ 年月: month, 従業員コード: '900' + i, 拠点: '本社', 給与種別名称: '月給者',
      所属: ['R3-2', 'R1-3', 'R3-2', 'R2', 'R1-3', 'R3-1', 'R1-2'][i], 生年月日: `${p.birth}年${i % 2 ? 4 : 3}月${i % 2 ? 1 : 31}日` })));
    rows.push({ id: 99, Title: '見本 派遣', EmpCode: '', UnitPath: '営業｜本社', Kind: '派遣', State: '在籍' });
    return { persons: rows, payroll };
  }
  async function readList(site, list) {
    let path = `/sites/${site}/lists/${list}/items?expand=fields&$top=999`, out = [];
    while (path) {
      const r = await graphGet(path);
      if (!Array.isArray(r.value)) throw new Error('人員表の形式を確認できません。');
      out.push(...r.value.map(i => ({ ...i.fields, id: i.id })));
      const next = r['@odata.nextLink'];
      if (next && !next.startsWith('https://graph.microsoft.com/v1.0/sites/')) throw new Error('続きの取得先を確認できません。');
      path = next ? next.slice('https://graph.microsoft.com/v1.0'.length) : null;
    }
    return out;
  }
  async function refresh() {
    if (source.busy || !DB) return;
    source.busy = true; source.message = '読み込み中…'; render();
    try {
      let persons, payroll = [], warning = '';
      if (demo) ({ persons, payroll } = demoSource());
      else {
        const site = await graphGet('/sites/hanaokacorp.sharepoint.com:/sites/msteams_7aab51');
        persons = await readList(site.id, 'STF_Person');
        try { payroll = await payrollGetFile('history/employee_master.json'); if (!Array.isArray(payroll) || !payroll.length) throw new Error(); }
        catch { payroll = []; warning = '給与の人事情報を取得できません。年齢は前回の情報を保持し、未取得の人は未確認のままです。'; }
      }
      const result = C.roster(persons, payroll);
      source.revision++; source.rows = result.rows; source.month = result.month; source.loaded = true;
      source.message = (demo ? 'サンプル人員で確認：' : '人員表を確認：') + new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date());
      source.notices = warning ? [warning] : [];
      if (result.rows.some(r => r.payrollAmbiguous)) source.notices.push('給与に同じ従業員コードが複数あります。その人の生年月日は補完していません。');
      apply();
      if (mode === 'grades') renderMain();
    } catch { source.message = '取得できませんでした。権限・接続先を確認してください。前回の人員情報を保持しています。'; }
    finally { source.busy = false; render(); }
  }
  function apply() {
    if (!source.loaded) return;
    const result = C.sync(DB, source.rows, today());
    source.notices = [...new Set([...source.notices, ...result.notices])];
    if (JSON.stringify(result.db) !== JSON.stringify(DB)) { DB = result.db; touch(); E.rerender(); }
  }
  function refs() {
    return DB.scenarios.flatMap(sn => sn.people.map(p => ({ sn, p })));
  }
  function link(snId, pid, staffId) {
    const sn = DB.scenarios.find(s => s.id === snId), p = sn && sn.people.find(p => p.id === pid);
    if (!p) return;
    if (!staffId) { delete p.staffId; delete p.empCode; delete p.actualHistory; touch(); E.rerender(); render(); return; }
    const r = source.rows.find(r => r.staffId === staffId);
    if (!r || sn.people.some(q => q !== p && String(q.staffId || '') === staffId)) { alert('同じ案の別の人と結び付いています。対応を確認してください。'); return; }
    if (p.staffId && String(p.staffId) !== r.staffId) { delete p.birthDate; delete p.birth; delete p.actualHistory; delete p.hrGrade; delete p.hrGradeHistory; delete p.payrollSite; delete p.payType; delete p.gradeStarts; delete p.employeeKind; }
    p.staffId = r.staffId; p.empCode = r.empCode; touch(); apply(); render();
  }
  function render() {
    const box = document.getElementById('staffSync'); if (!box || !DB) return;
    const expanded = !!box.querySelector('details[open]');
    const cfg = DB.staffSync || {}, baseline = DB.scenarios.find(s => s.id === cfg.baselineId);
    const options = '<option value="">（現状の案を選ぶ）</option>' + DB.scenarios.map(s => `<option value="${esc(s.id)}"${s.id === cfg.baselineId ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    box.innerHTML = `<details${expanded ? ' open' : ''}><summary>人員表との連携：${esc(source.message)}</summary><div class="frm">
      <p>年齢は表示年度の開始直前（例：2026年度は2026/3/31）の満年齢です。生年月日がない人は未確認。人員は年度中の現状です。</p>
      <p>現状の案は所属・役職・等級・在籍状況も更新します。他の案は氏名・生年月日・入社年を更新し、所属・昇格・退職の計画を保持します。募集と派遣・シルバー・スポットは取り込みません。</p>
      <label>現状として更新する案 <select id="staffBaseline"${baseline ? ' disabled' : ''}>${options}</select></label><button class="btn sm" id="staffSetBaseline"${baseline ? ' disabled' : ''}>この案を現状として更新する</button>
      <p><button class="btn sm" id="staffReload"${source.busy ? ' disabled' : ''}>人員を読み直す</button> <span class="muted">${source.month ? '生年月日の取得元：給与人事 ' + esc(source.month) : '給与人事：未取得'}。画面を開いたときと、編集中以外は5分ごとに確認。</span></p>
      ${source.notices.map(n => `<p class="muted">${esc(n)}</p>`).join('')}
      <p><button class="btn sm" id="staffLinkSelected">チェックした一致候補を結び付ける</button> <span class="muted">案・氏名・所属を見比べてから押してください。同姓同名など、一人に決まらない候補は選びません。</span></p>
      <div id="staffMatches"></div>
      ${source.loaded && baseline ? `<p><button class="btn sm" id="staffEnable">${cfg.autoAdd ? '新しい人の自動追加を止める' : '対応確認を終え、新しい人の自動追加を始める'}</button><span class="muted"> 押すと未登録の在籍・退職予定・入社予定の人が現状の案に追加されます。将来案への追加は案ごとに選べます。</span></p>` : ''}
      <details><summary>部署の表示グループ</summary>${DB.depts.map((d, i) => `<label>${esc(d.name)} <select data-staff-group="${i}">${groups.map(g => `<option${g === d.group ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>`).join('')}</details>
      <p class="muted">「等級・年収」で等級別の一覧、在級期間、給与と賞与月数による概算年収を確認できます。</p>
    </div></details>`;
    box.querySelector('#staffReload').onclick = refresh;
    box.querySelector('#staffSetBaseline').onclick = () => {
      const value = box.querySelector('#staffBaseline').value; if (!value) return;
      DB.staffSync = { ...cfg, baselineId: value, autoAdd: false }; touch(); apply(); render();
    };
    if (box.querySelector('#staffEnable')) box.querySelector('#staffEnable').onclick = () => {
      if (!cfg.autoAdd && baseline.people.some(p => !p.staffId)) { alert('現状の案に、まだ人員表と結び付いていない人がいます。先に対応を確認してください。'); return; }
      DB.staffSync.autoAdd = !cfg.autoAdd; touch(); apply(); render();
    };
    box.querySelectorAll('[data-staff-group]').forEach(el => el.onchange = () => { DB.depts[Number(el.dataset.staffGroup)].group = el.value; touch(); E.rerender(); });
    if (!source.loaded) return;
    const target = box.querySelector('#staffMatches');
    const chosen = [];
    box.querySelector('#staffLinkSelected').onclick = () => {
      const selection = chosen.filter(x => x.check.checked);
      const keys = new Set();
      for (const x of selection) { const key = JSON.stringify([x.sn.id, x.r.staffId]);
        if (keys.has(key) || x.sn.people.some(p => p !== x.p && String(p.staffId || '') === x.r.staffId)) { alert('同じ案で同じ人に結び付く候補が重複しています。チェックを見直してください。'); return; } keys.add(key); }
      for (const x of selection) { x.p.staffId = x.r.staffId; x.p.empCode = x.r.empCode; }
      if (selection.length) { touch(); apply(); render(); }
    };
    const table = document.createElement('table'), head = document.createElement('tr');
    for (const label of ['案', '組織計画の人', '人員表の対応（氏名・所属・従業員コード）']) { const th = document.createElement('th'); th.textContent = label; head.appendChild(th); }
    table.appendChild(head);
    refs().forEach(({ sn, p }) => {
      const tr = document.createElement('tr'); tr.className = 'staff-match-row';
      for (const text of [sn.name, p.name]) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); }
      const td = document.createElement('td'), select = document.createElement('select');
      select.add(new Option('（未接続・候補を選ぶ）', ''));
      for (const r of source.rows) select.add(new Option(`${r.name} / ${r.dept} / ${r.empCode || 'コードなし'}${r.state === '退職' ? ' / 退職' : ''}`, r.staffId));
      const suggestion = C.candidate(p, source.rows);
      select.value = p.staffId || (suggestion ? suggestion.staffId : '');
      const button = document.createElement('button'); button.className = 'btn sm'; button.textContent = p.staffId ? '対応を変更' : '確認して結び付ける';
      select.onchange = () => { const item = chosen.find(x => x.p === p); if (item) item.check.checked = false; };
      button.onclick = () => link(sn.id, p.id, select.value);
      const status = document.createElement('span'); status.className = 'muted';
      button.style.margin = '2px 6px';
      status.textContent = p.staffId ? (suggestion ? ' 接続済み' : ' 元データに見つかりません') : suggestion ? ' 氏名・コードの一致候補（未確定）' : ' 対応を確認';
      select.setAttribute('aria-label', sn.name + '：' + p.name + 'の対応');
      if (!p.staffId && suggestion) { const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.style.width = 'auto'; check.setAttribute('aria-label', sn.name + '：' + p.name + 'の一致候補を選ぶ'); chosen.push({ check, sn, p, r: suggestion }); td.appendChild(check); }
      td.append(select, button, status); tr.appendChild(td); table.appendChild(tr);
    });
    target.style.overflowX = 'auto'; target.appendChild(table);
    if (baseline) {
      const add = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '人員表からこの案へ人を追加'; add.appendChild(summary);
      source.rows.filter(r => ['在籍', '退職予定', '入社予定'].includes(r.state) && !sc().people.some(p => String(p.staffId || '') === r.staffId)).forEach(r => {
        const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = `${r.name}（${r.dept}）を追加`;
        b.onclick = () => { if (!confirm(`${r.name}を「${sc().name}」に追加します。既存の人の対応漏れがないか確認しましたか？`)) return;
          sc().people.push({ id: 'staff_' + r.staffId + '_' + (++source.key), staffId: r.staffId, name: r.name, dept: r.dept, birthDate: r.birthDate,
            birth: C.yearOf(r.birthDate), join: C.yearOf(r.startDate), retire: null, titles: [{ from: C.fiscalYear(today()), title: r.title }], grades: [], moves: [], events: [], roleKeys: [], note: '' });
          if (r.dept && !DB.depts.some(d => d.name === r.dept)) DB.depts.push({ name: r.dept, group: '人員表' });
          touch(); apply(); E.rerender(); render(); };
        add.appendChild(b);
      }); target.appendChild(add);
    }
  }
  function start() {
    clearInterval(source.timer);
    refresh();
    source.timer = setInterval(() => { if (!document.hidden && !dirty && !saving && !panel && !document.querySelector('#staffSync details[open]') && !document.querySelector('#gradeView details[open]') && !document.querySelector('#gradeView input:focus')) refresh(); }, 300000);
  }
  return { start, refresh, render, source };
})();
