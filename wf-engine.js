/* =============================================================
 * wf-engine.js — 承認経路の計算エンジン（画面・通信に依存しない）
 *
 * 入力: フォーム定義、ワークフロー定義、申請者、入力内容、組織マスタ、役割マスタ
 * 出力: 経路スナップショット（ステップごとの担当者・スキップ理由）、回覧先、後処理
 *
 * ワークフロー定義（WF_Workflow.StepsJson）の形:
 * {
 *   "steps": [ { "no":1, "type":"承認|決裁|作業", "name":"…", "assignee":{…}, "condition":{…}, "editable":[…] } ],
 *   "post":      [ { "name":"…", "assignee":{…}, "condition":{…} } ],   // 決裁後のTODO
 *   "circulate": [ { "kind":"dept|role|user|field", …, "condition":{…} } ] // 決裁後の回覧
 * }
 * assignee の種類:
 *   {"kind":"chain", "until":"部門長|役員", "max":3}   上長を順に辿る
 *   {"kind":"role",  "role":"総務部長", "by":"拠点|部署"}  役割マスタから
 *   {"kind":"user",  "upns":["…"]}                    固定（非推奨。役割を使う）
 *   {"kind":"field", "field":"技術部担当者"}            フォームの社員選択項目（"mode":"all" で選んだ全員の承認）
 *   {"kind":"managersOf", "field":"同行者"}             選んだ人それぞれの直属の上長（既定は全員の承認）
 *   {"kind":"applicant"}                              申請者本人
 * ============================================================= */
(function (root) {
  'use strict';

  const TIER_RANK = { '一般': 0, '管理職': 1, '部門長': 2, '役員': 3, '社長': 4, '相談役': -1 };
  const UNTIL_RANK = { '部門長': 2, '役員': 3, '社長': 4 };

  const splitUpns = s => (s || '').split(';').map(x => x.trim().toLowerCase()).filter(Boolean);
  const rankOf = p => (p && p.Tier in TIER_RANK) ? TIER_RANK[p.Tier] : 0;

  /* ---------- 条件式 ----------
   * {"field":"金額","op":">=","value":100000}
   * {"all":[…]} / {"any":[…]} / {"not":{…}}
   * field に "@applicant.Dept" などと書くと申請者の属性を参照する */
  function getValue(field, ctx) {
    if (field.startsWith('@applicant.')) return (ctx.applicant || {})[field.slice(11)];
    const v = (ctx.data || {})[field];
    return v;
  }
  function evalCond(c, ctx) {
    if (!c) return true;
    if (c.all) return c.all.every(x => evalCond(x, ctx));
    if (c.any) return c.any.some(x => evalCond(x, ctx));
    if (c.not) return !evalCond(c.not, ctx);
    const v = getValue(c.field, ctx);
    const num = x => (typeof x === 'number' ? x : Number(String(x).replace(/[,¥円\s]/g, '')));
    switch (c.op) {
      case '==': return String(v ?? '') === String(c.value);
      case '!=': return String(v ?? '') !== String(c.value);
      case '>':  return num(v) >  num(c.value);
      case '>=': return num(v) >= num(c.value);
      case '<':  return num(v) <  num(c.value);
      case '<=': return num(v) <= num(c.value);
      case 'in': return (c.value || []).map(String).includes(String(v ?? ''));
      case 'contains': return Array.isArray(v) ? v.map(String).includes(String(c.value)) : String(v ?? '').includes(String(c.value));
      case 'empty': return v == null || v === '' || (Array.isArray(v) && v.length === 0);
      case 'notEmpty': return !(v == null || v === '' || (Array.isArray(v) && v.length === 0));
      default: throw new Error('未対応の条件演算子: ' + c.op);
    }
  }

  /* ---------- 担当者の解決 ----------
   * 戻り値: グループの配列。1グループ = 1段。{upns:[…], mode:'any|all|n', need:n, label:'…'} */
  function resolveChain(a, ctx) {
    const groups = [];
    const stopRank = a.until ? UNTIL_RANK[a.until] : 99;
    const max = a.max || 10;
    let base = ctx.applicant;
    const seen = new Set([base.UPN.toLowerCase()]);
    for (let i = 0; i < max; i++) {
      const mgrs = splitUpns(base.ManagerUPNs).map(u => ctx.orgByUpn[u]).filter(p => p && p.Active !== false);
      if (!mgrs.length) break;
      const fresh = mgrs.filter(p => !seen.has(p.UPN.toLowerCase()));
      if (!fresh.length) break;                       // 循環防止
      fresh.forEach(p => seen.add(p.UPN.toLowerCase()));
      groups.push({ upns: fresh.map(p => p.UPN.toLowerCase()), mode: 'any', need: 1,
                    label: fresh.length > 1 ? '上長（いずれか1名）' : '上長' });
      // 複数上長のときは、上位者の上長から続ける。
      // 上位者＝他の候補の上長にあたる人。いなければ階層区分が高い人
      const isBossOfOther = p => fresh.some(q => q !== p && splitUpns(q.ManagerUPNs).includes(p.UPN.toLowerCase()));
      const top = fresh.find(isBossOfOther) || fresh.slice().sort((x, y) => rankOf(y) - rankOf(x))[0];
      if (rankOf(top) >= stopRank) break;
      base = top;
    }
    return groups;
  }

  function resolveRole(a, ctx) {
    const rows = ctx.roles.filter(r => r.Kind !== '閲覧権限' && r.Active !== false && r.Title === a.role);
    if (!rows.length) return { groups: [], error: `役割「${a.role}」が役割マスタにありません` };
    let row = null;
    if (a.by) {
      const key = a.by === '拠点' ? ctx.applicant.Site : ctx.applicant.Dept;
      row = rows.find(r => (r.Scope || '').split(';').map(s => s.trim()).includes(key));
    }
    row = row || rows.find(r => !r.Scope) || null;
    if (!row) return { groups: [], error: `役割「${a.role}」に、申請者の${a.by || ''}に合う担当者がいません` };
    const upns = splitUpns(row.MemberUPNs);
    const mode = row.ApproveMode === '全員' ? 'all' : row.ApproveMode === 'n人' ? 'n' : 'any';
    const need = mode === 'all' ? upns.length : mode === 'n' ? (row.RequiredCount || 1) : 1;
    return { groups: [{ upns, mode, need, label: a.role }] };
  }

  // 社員選択の項目の値（1人 or 複数）→ UPN の配列（表の中の列 "表.列" も可）
  function fieldUpns(field, ctx) {
    const parts = String(field).split('.');
    const v = parts.length > 1 ? ((ctx.data || {})[parts[0]] || []).map(r => r && r[parts[1]]) : (ctx.data || {})[field];
    const out = [];
    (Array.isArray(v) ? v : splitUpns(v)).forEach(u => { const x = String(u || '').trim().toLowerCase(); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  function resolveAssignee(a, ctx) {
    switch (a.kind) {
      case 'chain':     return { groups: resolveChain(a, ctx) };
      case 'role':      return resolveRole(a, ctx);
      case 'user':      return { groups: [{ upns: (a.upns || []).map(u => u.toLowerCase()), mode: 'any', need: 1 }] };
      case 'field': {
        const upns = fieldUpns(a.field, ctx);
        if (!upns.length) return { groups: [] };
        return { groups: [{ upns, mode: a.mode === 'all' ? 'all' : 'any', need: a.mode === 'all' ? upns.length : 1 }] };
      }
      case 'managersOf': {   // 社員選択の項目で選んだ人それぞれの直属の上長（例: 同行者の上長）
        const upns = [];
        fieldUpns(a.field, ctx).forEach(u => {
          const m = splitUpns((ctx.orgByUpn[u] || {}).ManagerUPNs)[0];
          if (m && ctx.orgByUpn[m] && ctx.orgByUpn[m].Active !== false && upns.indexOf(m) < 0) upns.push(m);
        });
        if (!upns.length) return { groups: [] };
        return { groups: [{ upns, mode: a.mode === 'any' ? 'any' : 'all', need: a.mode === 'any' ? 1 : upns.length }] };
      }
      case 'applicant': return { groups: [{ upns: [ctx.applicant.UPN.toLowerCase()], mode: 'any', need: 1 }] };
      default: return { groups: [], error: '未対応の担当者指定: ' + a.kind };
    }
  }

  /* 代理設定: 期間中なら代理人も処理できる（★表示用。実際に代理人へ回すかはフローが組織マスタを見て決める） */
  // 日付だけの列は「日本の0時」が UTC で返る（前日15時）ので、この端末の日付に直してから比べる
  function ymd(v) {
    if (!v) return '';
    const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 10);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function delegateOf(upn, ctx, hop) {
    const p = ctx.orgByUpn[upn];
    if (!p || !p.DelegateUPN) return null;
    const t = ctx.today || ymd(new Date());
    const from = ymd(p.DelegateFrom), to = ymd(p.DelegateTo);
    if ((from && t < from) || (to && t > to)) return null;
    const d = p.DelegateUPN.toLowerCase();
    if (hop) return d;
    // 代理人も不在なら、その人の代理人へ1段だけたどる（例：社長→室長（出張中）→福田）。元の本人に戻るときはたどらない
    // ★代理人が申請者本人になるときは回さない（自分の申請を自分で承認しない）。2段目が本人なら1段目へ、1段目も本人なら代理なし（フローBと同じ）
    const me = ctx.applicant && ctx.applicant.UPN ? ctx.applicant.UPN.toLowerCase() : '';
    const d2 = delegateOf(d, ctx, 1);
    if (d2 && d2 !== upn && d2 !== me) return d2;
    return d === me ? null : d;
  }

  /* ---------- 経路の計算 ---------- */
  function resolveRoute(ctx) {
    const def = typeof ctx.workflow.StepsJson === 'string' ? JSON.parse(ctx.workflow.StepsJson) : ctx.workflow.StepsJson;
    ctx.orgByUpn = ctx.orgByUpn || Object.fromEntries(ctx.org.map(p => [p.UPN.toLowerCase(), p]));
    const me = ctx.applicant.UPN.toLowerCase();
    const errors = [];
    const route = [];

    for (const s of def.steps || []) {
      if (!evalCond(s.condition, ctx)) {
        route.push({ stepNo: s.no, name: s.name, type: s.type, upns: [], skipped: true, reason: '条件に当たらない' });
        continue;
      }
      const r = resolveAssignee(s.assignee || {}, ctx);
      if (r.error) errors.push(`ステップ${s.no}「${s.name}」: ${r.error}`);
      if (!r.groups.length) {
        route.push({ stepNo: s.no, name: s.name, type: s.type, upns: [], skipped: true, reason: '担当者なし' });
        continue;
      }
      r.groups.forEach((g, i) => route.push({
        stepNo: s.no, sub: r.groups.length > 1 ? i + 1 : undefined,
        name: r.groups.length > 1 || s.assignee.kind === 'chain' ? `${s.name}${r.groups.length > 1 ? '（' + (i + 1) + '段目）' : ''}` : s.name,
        type: s.type, upns: g.upns.slice(), mode: g.mode, need: g.need, editable: s.editable || [], skipped: false,
        role: s.assignee.kind === 'role' ? s.assignee.role : undefined     // フロー側の改ざんチェックに使う
      }));
    }

    // 自動スキップ: ①申請者本人 ②後ろの段にも出てくる人は、後ろで1回だけ承認する
    for (let i = 0; i < route.length; i++) {
      const st = route[i];
      if (st.skipped) continue;
      if (st.type === '作業') continue;                           // 作業は本人でも行う
      const before = st.upns.length;
      st.upns = st.upns.filter(u => u !== me);
      if (before && !st.upns.length) { st.skipped = true; st.reason = '申請者本人'; continue; }
      const later = new Set(route.slice(i + 1).filter(x => !x.skipped && x.type !== '作業').flatMap(x => x.upns));
      const kept = st.upns.filter(u => !later.has(u));
      if (kept.length < st.upns.length) {   // 全員の承認の段でも、後ろで承認する人はここでは外す（同じ人が2回承認しない）
        if (!kept.length) { st.skipped = true; st.reason = '後の段で承認するため'; continue; }
        st.upns = kept;
      }
      if (st.mode === 'all') st.need = st.upns.length;
      st.need = Math.min(st.need || 1, st.upns.length);
    }
    // 代理人を付ける
    route.forEach(st => { st.delegates = {}; st.upns.forEach(u => { const d = delegateOf(u, ctx); if (d) st.delegates[u] = d; }); });

    // 経路の最後が決裁で、担当者がいなければエラー
    if (!route.some(s => !s.skipped)) errors.push('承認者が1人もいません');

    return {
      route,
      post: resolveExtra(def.post, ctx, errors, '後処理'),
      circulate: resolveCirculate(def.circulate, ctx, errors),
      errors
    };
  }

  function resolveExtra(list, ctx, errors, label) {
    return (list || []).filter(p => evalCond(p.condition, ctx)).map(p => {
      const r = resolveAssignee(p.assignee || {}, ctx);
      if (r.error) errors.push(`${label}「${p.name}」: ${r.error}`);
      return { name: p.name, upns: [...new Set(r.groups.flatMap(g => g.upns))] };
    });
  }

  function resolveCirculate(list, ctx, errors) {
    const out = new Set();
    for (const c of list || []) {
      if (!evalCond(c.condition, ctx)) continue;
      if (c.kind === 'dept') {
        const dept = c.dept || ctx.applicant.Dept;
        ctx.org.filter(p => p.Active !== false && p.Dept === dept && (c.members !== 'managers' || rankOf(p) >= 1))
          .forEach(p => out.add(p.UPN.toLowerCase()));
      } else {
        const r = resolveAssignee(c.kind === 'role' ? { kind: 'role', role: c.role, by: c.by } : c, ctx);
        if (r.error) errors.push('回覧: ' + r.error);
        r.groups.forEach(g => g.upns.forEach(u => out.add(u)));
      }
    }
    out.delete(ctx.applicant.UPN.toLowerCase());
    return [...out];
  }

  /* 差し戻しのとき、通知すべき人（差し戻し先〜差し戻し元の間で承認済みだった人） */
  function affectedByReturn(tasks, fromStepIndex, toStepIndex) {
    return [...new Set(tasks.filter(t => t.index >= toStepIndex && t.index < fromStepIndex && t.Status === '承認')
      .map(t => (t.ActedByUPN || t.AssigneeUPN).toLowerCase()))];
  }

  const api = { resolveRoute, evalCond, affectedByReturn, TIER_RANK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WFEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
