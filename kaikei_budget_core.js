/* 会計ダッシュボード 共通：予算の版（バージョン）の読み込みと月別の予算値の計算
   保存場所（SharePoint executive-workspace / 会計データ）:
     budget/index.json … 版の一覧と「採用中の版」（年度ごと）。ここだけは更新される
     budget/vN.json    … 1つの版の中身。一度保存したら上書きしない（直すときは新しい版を作る）
   ページ側の定数と名前がぶつからないよう、すべて KaikeiBudget の中に入れている。 */
const KaikeiBudget = (() => {
  const INDEX_PATH = 'budget/index.json';
  const OFFICES = ['本社', '大阪', '名古屋'];
  /* 営業部の部門別目標（targets_editor.html と同じ SharedMasters のリスト） */
  const TARGETS_SITE_ID = 'hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23';
  const TARGETS_LIST_ID = '9cb1ee3e-8af9-4f6a-a910-78b12385437e';
  const TARGET_SCOPES = {
    '国内営業部': 'domestic', 'ソリューション営業部': 'solution',
    '本社': '本社', '大阪支店': '大阪', '名古屋営業所': '名古屋',
  };

  function fyMonths(fy) {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const y = fy + Math.floor((3 + i) / 12);
      const m = ((3 + i) % 12) + 1;
      out.push(String(y) + String(m).padStart(2, '0'));
    }
    return out;
  }

  function sumMap(map) { return Object.values(map || {}).reduce((a, b) => a + (b || 0), 0); }

  /** 年額を月の重み(shape)で配分する。重みが全部0なら均等。端数は最終月に寄せて合計を年額ぴったりにする */
  function distribute(annual, months, shape) {
    const w = months.map(m => Math.max(0, (shape && shape[m]) || 0));
    const tw = w.reduce((a, b) => a + b, 0);
    const vals = months.map((m, i) => Math.round(tw ? annual * w[i] / tw : annual / months.length));
    vals[vals.length - 1] += Math.round(annual) - vals.reduce((a, b) => a + b, 0);
    const out = {};
    months.forEach((m, i) => { out[m] = vals[i]; });
    return out;
  }

  /* ---------- 版の読み書き ---------- */
  async function loadIndex() {
    return (await kaikeiGetFile(INDEX_PATH, { allow404: true })) || { versions: [], active: {} };
  }
  async function loadVersion(id) {
    return kaikeiGetFile('budget/' + id + '.json', { allow404: true });
  }
  /** 採用中の版を返す（無ければnull） */
  async function loadActive(fy) {
    const idx = await loadIndex();
    const id = idx.active && idx.active[String(fy)];
    return id ? loadVersion(id) : null;
  }
  function nextId(idx) {
    const n = (idx.versions || []).reduce((mx, v) => Math.max(mx, parseInt(String(v.id).slice(1), 10) || 0), 0);
    return 'v' + (n + 1);
  }
  function indexEntry(ver) {
    return {
      id: ver.id, name: ver.name, fy: ver.fy, createdAt: ver.createdAt, createdBy: ver.createdBy || '',
      basedOn: ver.basedOn || null, planDate: ver.planDate || '', memo: ver.memo || '',
    };
  }
  /** 新しい版を保存する。同じIDのファイルが既にあれば中止（過去の版は上書きしない） */
  async function saveNewVersion(ver, opts) {
    opts = opts || {};
    const exists = await loadVersion(ver.id);
    if (exists) throw new Error(ver.id + ' は既に保存されています。過去の版は変更できません。');
    await kaikeiPutFile('budget/' + ver.id + '.json', ver);
    // index は保存直前に読み直してから追記する（別の人の保存を消さないため）
    const idx = await loadIndex();
    idx.versions = (idx.versions || []).filter(v => v.id !== ver.id);
    idx.versions.push(indexEntry(ver));
    if (!idx.active) idx.active = {};
    if (opts.activate || !idx.active[String(ver.fy)]) {
      idx.active[String(ver.fy)] = ver.id;
      (idx.activations = idx.activations || []).push({ fy: ver.fy, id: ver.id, at: new Date().toISOString(), by: ver.createdBy || '' });
    }
    await kaikeiPutFile(INDEX_PATH, idx);
    return idx;
  }
  async function activate(fy, id, by) {
    const idx = await loadIndex();
    if (!(idx.versions || []).some(v => v.id === id)) throw new Error(id + ' が見つかりません');
    idx.active = idx.active || {};
    idx.active[String(fy)] = id;
    (idx.activations = idx.activations || []).push({ fy, id, at: new Date().toISOString(), by: by || '' });
    await kaikeiPutFile(INDEX_PATH, idx);
    return idx;
  }

  /* ---------- 営業部の部門別目標（売上の月別の形） ---------- */
  async function fetchTargetItems() {
    const token = await kaikeiGetToken();
    let url = `${KAIKEI_GRAPH_BASE}/sites/${TARGETS_SITE_ID}/lists/${TARGETS_LIST_ID}/items?$expand=fields&$top=2000`;
    const items = [];
    while (url) {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('営業部の目標リストを読めませんでした [' + res.status + ']');
      const j = await res.json();
      items.push(...(j.value || []));
      url = j['@odata.nextLink'] || null;
    }
    return items.map(i => i.fields || {});
  }
  /** 目標リストの行から、年度fyの「部門月次」最新値を スコープ→{YYYYMM:金額} にまとめる */
  function targetsByScope(fields, fy) {
    const out = {};
    for (const f of fields) {
      if (f.TargetType !== '部門月次' || f.IsLatest !== true || f.SubScope) continue;
      if (parseInt(f.FY, 10) !== fy) continue;
      const scope = TARGET_SCOPES[f.ScopeKey];
      if (!scope) continue;
      const ym = String(f.YearMonth || '').padStart(6, '0');
      (out[scope] = out[scope] || {})[ym] = (out[scope][ym] || 0) + (Number(f.Amount) || 0);
    }
    return out;
  }
  /** 売上の月別の形（国内・ソリューション）と、国内を拠点に割る比率を作る */
  function salesShapeFromTargets(byScope, months) {
    const domestic = {}, solution = {}, officeShare = {};
    const hasOffices = OFFICES.some(o => sumMap(byScope[o]) > 0);
    for (const m of months) {
      const offSum = OFFICES.reduce((s, o) => s + ((byScope[o] || {})[m] || 0), 0);
      domestic[m] = sumMap(byScope.domestic) > 0 ? ((byScope.domestic || {})[m] || 0) : offSum;
      solution[m] = (byScope.solution || {})[m] || 0;
      if (hasOffices) {
        for (const o of OFFICES) {
          (officeShare[o] = officeShare[o] || {})[m] = offSum ? ((byScope[o] || {})[m] || 0) / offSum : 0;
        }
      }
    }
    return {
      domestic, solution, officeShare: hasOffices ? officeShare : null,
      totals: { domestic: sumMap(domestic), solution: sumMap(solution) },
    };
  }
  /** 目標リストから年度fyの売上の形を取る。目標が無ければ null */
  async function fetchSalesShape(fy) {
    const months = fyMonths(fy);
    const byScope = targetsByScope(await fetchTargetItems(), fy);
    const shape = salesShapeFromTargets(byScope, months);
    if (!shape.totals.domestic && !shape.totals.solution) return null;
    shape.source = `営業部 部門別目標（${fy}年度・部門月次の最新版）`;
    shape.fetchedAt = new Date().toISOString();
    return shape;
  }
  /** 営業部の目標が無いときの代わり：前年度の売上実績の月別の形（元帳の集計から） */
  async function priorYearShape(fy) {
    const SALES = ['600', '601', '602', '603', '604', '605'];
    const SOLUTION = ['ｿﾘｭｰｼｮﾝ営業'];
    const months = fyMonths(fy);
    const domestic = {}, solution = {};
    let found = 0;
    await Promise.all(months.map(async m => {
      const prev = String(parseInt(m.slice(0, 4), 10) - 1) + m.slice(4);
      const sum = await kaikeiGetFile('summary/' + prev + '.json', { allow404: true });
      if (!sum) return;
      found++;
      let all = 0, sol = 0;
      for (const c of SALES) {
        const a = (sum.byAccount || {})[c];
        if (a) all += a.credit - a.debit;
        const d = (sum.byDept || {})[c] || {};
        for (const s of SOLUTION) if (d[s]) sol += d[s].credit - d[s].debit;
      }
      domestic[m] = all - sol;
      solution[m] = sol;
    }));
    if (found < 12) return null;
    return { domestic, solution, officeShare: null, totals: { domestic: sumMap(domestic), solution: sumMap(solution) },
             source: `前年度（${fy - 1}年度）の売上実績の月別の形（営業部の目標が見つからなかったため）`,
             fetchedAt: new Date().toISOString() };
  }

  /** 版の年額（国内・ソリューション）を、形に合わせて月に配分する */
  function applySalesShape(ver, shape) {
    const months = ver.months || fyMonths(ver.fy);
    ver.sales = {
      domestic: distribute(ver.annual.domestic, months, shape && shape.domestic),
      solution: distribute(ver.annual.solution, months, shape && shape.solution),
      officeShare: shape ? shape.officeShare : null,
    };
    ver.salesShape = shape
      ? { source: shape.source, fetchedAt: shape.fetchedAt, targetTotals: shape.totals }
      : { source: '均等配分（営業部の目標が見つからなかったため）', fetchedAt: new Date().toISOString() };
  }
  /** 営業外の年額を12等分 */
  function applyNonOp(ver) {
    const months = ver.months || fyMonths(ver.fy);
    ver.nonOp = {
      inc: distribute(ver.annual.nonOpInc || 0, months, null),
      exp: distribute(ver.annual.nonOpExp || 0, months, null),
    };
  }

  /* ---------- 集計 ---------- */
  function lineSum(ver, month, labor) {
    let s = 0;
    for (const l of ver.lines || []) {
      if (labor !== undefined && !!l.labor !== labor) continue;
      s += ((ver.expense[l.key] || {})[month]) || 0;
    }
    return s;
  }
  /** 月次資料の calcMonth と同じ形で、その月の予算値を返す（予算に無い項目は null） */
  function budgetMonth(ver, month) {
    if (!ver || !(ver.months || []).includes(month)) return null;
    const domestic = (ver.sales.domestic || {})[month] || 0;
    const solution = (ver.sales.solution || {})[month] || 0;
    const officeSales = {};
    for (const o of OFFICES) {
      const sh = ver.sales.officeShare && ver.sales.officeShare[o];
      officeSales[o] = sh ? Math.round(domestic * (sh[month] || 0)) : null;
    }
    const sales = domestic + solution;
    const vaRate = ver.annual.vaRate;
    const valueAdded = sales * vaRate;
    const labor = lineSum(ver, month, true);
    const expense = lineSum(ver, month, false);
    const opInc = valueAdded - labor - expense;
    const nonOpInc = (ver.nonOp && ver.nonOp.inc[month]) || 0;
    const nonOpExp = (ver.nonOp && ver.nonOp.exp[month]) || 0;
    return {
      isBudget: true,
      officeSales, solution, domestic, unmapped: null, sales,
      purchase: null, merch: null, purchaseTotal: sales - valueAdded, valueAdded, vaRate,
      // 予算は在庫の増減を見込まない（在庫あり付加価値 = 付加価値）
      invChange: null, costOfSales: sales - valueAdded, valueAddedInv: valueAdded, vaInvRate: vaRate,
      labor, laborFactory: null, laborCompany: null, laborPer: {},
      expense, expFactory: null, expCompany: null, expPer: {},
      cost: labor + expense,
      opInc, nonOpInc, nonOpExp, ordInc: opInc + nonOpInc - nonOpExp,
      extraInc: null, extraExp: null, preTax: null, tax: null, netInc: null,
      factorySales: null, factoryPurchase: null, factoryVaRate: ver.factoryVaRate || null,
    };
  }
  /** 版の年間の主要数値（比較表用） */
  function totals(ver) {
    const months = ver.months || fyMonths(ver.fy);
    const domestic = months.reduce((s, m) => s + ((ver.sales.domestic || {})[m] || 0), 0);
    const solution = months.reduce((s, m) => s + ((ver.sales.solution || {})[m] || 0), 0);
    const sales = domestic + solution;
    const valueAdded = sales * ver.annual.vaRate;
    const labor = months.reduce((s, m) => s + lineSum(ver, m, true), 0);
    const expense = months.reduce((s, m) => s + lineSum(ver, m, false), 0);
    const nonOpInc = sumMap(ver.nonOp && ver.nonOp.inc);
    const nonOpExp = sumMap(ver.nonOp && ver.nonOp.exp);
    const opInc = valueAdded - labor - expense;
    return { domestic, solution, sales, vaRate: ver.annual.vaRate, valueAdded, labor, expense,
             cost: labor + expense, opInc, nonOpInc, nonOpExp, ordInc: opInc + nonOpInc - nonOpExp,
             laborShare: valueAdded ? labor / valueAdded : null };
  }

  /** 初期データ(budget_seed.json)の1版から、保存する版の形を作る */
  function versionFromSeed(seed, sv, shape, who) {
    const ver = {
      id: sv.id, name: sv.name, fy: seed.fy, months: seed.months,
      createdAt: new Date().toISOString(), createdBy: who || '',
      basedOn: sv.basedOn || null, planDate: sv.planDate || '', source: sv.source || '', memo: sv.memo || '',
      annual: { ...sv.annual }, factoryVaRate: sv.factoryVaRate || null,
      lines: seed.lines, expense: sv.expense, special: sv.special || {},
    };
    applySalesShape(ver, shape);
    applyNonOp(ver);
    return ver;
  }

  return {
    OFFICES, fyMonths, distribute, sumMap,
    loadIndex, loadVersion, loadActive, nextId, saveNewVersion, activate,
    fetchSalesShape, priorYearShape, targetsByScope, salesShapeFromTargets, applySalesShape, applyNonOp,
    budgetMonth, totals, lineSum, versionFromSeed,
  };
})();
