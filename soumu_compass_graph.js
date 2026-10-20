/* 総務コンパス 共通：MSAL認証 + Microsoft Graph(SharePointリスト) + データ層
   花岡車輌 業務アプリ（既存SPA登録）をそのまま使う。新規Azure AD登録・新規API権限は不要。
   サインインは全アプリ共通の hanaoka_auth.js（画面で先に読み込む）。
   保存先は executive-workspace（役員＋総務幹部の限定サイト。会計データ・給与データ・書類管理と同じ）。
   誰が見られるかは SharePoint のサイト権限がそのまま効く。画面のコード側で「誰か」を判定しない。
   ★このファイルにデータ（氏名・目標の中身・日報）は一切入れない。リポジトリは公開されている。 */

const SC_MSAL_CONFIG = HanaokaAuth.msalConfig();
const SC_SCOPES = ['User.Read', 'Sites.ReadWrite.All'];
const SC_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SC_SITE_PATH = 'hanaokacorp.sharepoint.com:/sites/executive-workspace';

/* リスト定義。列は「絞り込み・並べ替えに使うもの」だけ。ほかは全部 Data(JSON) に入れる
   （月次の取込形式が増えても列を足さなくて済む）。 */
const SC_DATA_COL = { name: 'Data', text: { allowMultipleLines: true, textType: 'plain' } };
const SC_LISTS = {
  items:   { name: 'SC_Items',   cols: [{ name: 'Pillar', number: {} }] },
  reports: { name: 'SC_Reports', cols: [{ name: 'ReportDate', text: {} }, { name: 'Member', text: {} }] },
  links:   { name: 'SC_Links',   cols: [{ name: 'ItemId', text: {} }, { name: 'ReportDate', text: {} }, { name: 'Member', text: {} }] },
  manual:  { name: 'SC_Manual',  cols: [{ name: 'ItemId', text: {} }, { name: 'Kind', text: {} }, { name: 'Month', text: {} }, { name: 'Status', text: {} }] },
  state:   { name: 'SC_State',   cols: [{ name: 'Kind', text: {} }, { name: 'StateKey', text: {} }] }
};

let _scMsal = null, _scAccount = null, _scSiteId = null;
const _scListIds = {};

/* ---------- 認証 ---------- */
async function scInitAuth() {
  _scMsal = new msal.PublicClientApplication(SC_MSAL_CONFIG);
  await _scMsal.initialize();
  await _scMsal.handleRedirectPromise();                 // iPhone/iPad のページ移動から戻ったときの受け取り（必須）
  _scAccount = await HanaokaAuth.restore(_scMsal, SC_SCOPES);
  return _scAccount;
}
async function scSignIn() { _scAccount = await HanaokaAuth.login(_scMsal, SC_SCOPES); return _scAccount; }
function scAccount() { return _scAccount; }
async function scToken() {
  try { return (await _scMsal.acquireTokenSilent({ scopes: SC_SCOPES, account: _scAccount })).accessToken; }
  catch (e) { const r = await _scMsal.acquireTokenPopup({ scopes: SC_SCOPES }); _scAccount = r.account; return r.accessToken; }
}

/* ---------- Graph ---------- */
const scSleep = ms => new Promise(r => setTimeout(r, ms));
async function scGraph(path, opt = {}, tries = 0) {
  const token = await scToken();
  const res = await fetch(path.startsWith('http') ? path : SC_GRAPH_BASE + path, Object.assign({}, opt, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {}) }));
  if ((res.status === 429 || res.status === 503) && tries < 6) {
    await scSleep((+res.headers.get('Retry-After') || 2) * 1000); return scGraph(path, opt, tries + 1);
  }
  if (!res.ok) {
    let m = ''; try { m = (await res.json()).error.message } catch (e) {}
    const err = new Error(res.status === 403 ? 'このデータを見る権限がありません（総務コンパスは、閲覧を許可された人だけが開けます）。' : '[' + res.status + '] ' + (m || path));
    err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json();
}
async function scSite() {
  if (_scSiteId) return _scSiteId;
  _scSiteId = (await scGraph('/sites/' + SC_SITE_PATH)).id;
  const ls = await scGraph('/sites/' + _scSiteId + '/lists?$select=id,displayName&$top=200');
  (ls.value || []).forEach(l => { _scListIds[l.displayName] = l.id; });
  return _scSiteId;
}
async function scListBase(key) {
  const s = await scSite(), id = _scListIds[SC_LISTS[key].name];
  if (!id) { const e = new Error('リスト ' + SC_LISTS[key].name + ' がありません。「データ・運用」の初期設定で作成してください。'); e.code = 'nolist'; throw e; }
  return '/sites/' + s + '/lists/' + id;
}
async function scMissingLists() { await scSite(); return Object.keys(SC_LISTS).filter(k => !_scListIds[SC_LISTS[k].name]); }
async function scCreateLists() {
  const s = await scSite(), made = [];
  for (const k of await scMissingLists()) {
    const d = SC_LISTS[k];
    const r = await scGraph('/sites/' + s + '/lists', { method: 'POST', body: JSON.stringify({ displayName: d.name, list: { template: 'genericList' }, columns: d.cols.concat([SC_DATA_COL]) }) });
    _scListIds[d.name] = r.id; made.push(d.name);
  }
  return made;
}

/* ---------- 行の読み書き ---------- */
async function scList(key) {
  let url = (await scListBase(key)) + '/items?$expand=fields&$top=999', out = [];
  while (url) { const r = await scGraph(url); (r.value || []).forEach(x => out.push({ id: x.id, fields: x.fields })); url = r['@odata.nextLink'] || null; }
  return out;
}
const scCreate = async (key, fields) => (await scGraph((await scListBase(key)) + '/items', { method: 'POST', body: JSON.stringify({ fields }) })).id;
const scUpdate = async (key, id, fields) => { await scGraph((await scListBase(key)) + '/items/' + id + '/fields', { method: 'PATCH', body: JSON.stringify(fields) }); };
const scRemove = async (key, id) => { await scGraph((await scListBase(key)) + '/items/' + id, { method: 'DELETE' }); };
async function scBulk(ops, onProgress) {              // $batch は 1回20件まで
  const base = {}; for (const k of new Set(ops.map(o => o.key))) base[k] = await scListBase(k);
  for (let i = 0; i < ops.length; i += 20) {
    const chunk = ops.slice(i, i + 20);
    const requests = chunk.map((o, j) => o.op === 'create'
      ? { id: String(j), method: 'POST', url: base[o.key] + '/items', headers: { 'Content-Type': 'application/json' }, body: { fields: o.fields } }
      : { id: String(j), method: 'PATCH', url: base[o.key] + '/items/' + o.id + '/fields', headers: { 'Content-Type': 'application/json' }, body: o.fields });
    const res = await scGraph('/$batch', { method: 'POST', body: JSON.stringify({ requests }) });
    let bad = res.responses.filter(r => r.status >= 300);
    if (bad.length && bad.every(r => r.status === 429 || r.status === 503)) {      // 一度だけ再送
      await scSleep(3000);
      const again = await scGraph('/$batch', { method: 'POST', body: JSON.stringify({ requests: bad.map(b => requests[+b.id]) }) });
      bad = again.responses.filter(r => r.status >= 300);
    }
    if (bad.length) throw new Error('書き込みに失敗しました（' + bad[0].status + '）: ' + ((bad[0].body && bad[0].body.error && bad[0].body.error.message) || ''));
    onProgress && onProgress(Math.min(i + 20, ops.length), ops.length);
  }
}

/* ---------- 画面用データ ⇔ リスト行 ---------- */
const scJ = s => { try { return JSON.parse(s || '{}') } catch (e) { return {} } };
const scNat = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const SC_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const scSurname = m => String(m || '').split(/[ 　]/)[0];
function scHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

const scManualFields = x => ({ Title: x.id, ItemId: x.item, Kind: x.type, Month: x.month, Status: x.status || 'confirmed',
  Data: JSON.stringify({ who: x.who, text: x.text, group: x.group || '', source: x.source || 'manual' }) });

// 日報の分類結果（classified 形式）→ リスト行
function scToRows(classified) {
  const reports = [], links = [];
  classified.forEach(r => {
    reports.push({ Title: String(r.usage_id), ReportDate: r.date, Member: r.member, Data: JSON.stringify({ r: (r.routine || []).join(','), o: r.off_sheet || '', g: r.off_group || '' }) });
    (r.links || []).forEach(l => links.push({ Title: r.usage_id + '|' + l.item_id, ItemId: l.item_id, ReportDate: r.date, Member: r.member,
      Data: JSON.stringify({ rid: String(r.usage_id), c: l.conf, s: l.stage, e: l.evidence || '' }) }));
  });
  return { reports, links };
}
// additions（日報にない進捗）/ plans（今月の予定の下書き）→ SC_Manual の行。同じ内容は同じTitleになり、再取込しても増えない。
// 決めた項目だけを読む（評価コメントなど想定外の項目は読み捨てる）。
function scToManualRows(p) {
  const manual = [], errors = [], seen = new Set();
  const one = (kind, tag, x, i) => {
    const text = String(x.text || '').trim();
    if (!x.item_id || !SC_MONTH_RE.test(x.month || '') || !text) { errors.push(tag + ' ' + (i + 1) + '件目: item_id / month(YYYY-MM) / text が必要です'); return; }
    const who = scSurname(x.member);
    const title = 'imp|' + kind + '|' + x.item_id + '|' + x.month + '|' + who + '|' + scHash(text);
    if (seen.has(title)) return; seen.add(title);
    manual.push(scManualFields({ id: title, item: x.item_id, type: kind, month: x.month, who, text, group: x.group || '',
      status: kind === '予定' ? 'draft' : 'confirmed', source: kind === '予定' ? 'import_plan' : (x.source || 'import') }));
  };
  (p.additions || []).forEach((x, i) => one('実績', '追記', x, i));
  (p.plans || []).forEach((x, i) => one('予定', '予定', x, i));
  return { manual, errors };
}

const scByTitle = arr => new Map(arr.map(x => [x.fields.Title, x]));
/* 画面で直した行（Data の ed=1）と、画面で消した行（x=1）は、取込で上書き・復活させない */
const scLocked = e => { const d = scJ(e.fields.Data); return !!(d.ed || d.x); };
function scUpsertOps(key, rows, existing) {
  const ops = []; let same = 0, kept = 0;
  rows.forEach(f => {
    const e = existing.get(f.Title);
    if (!e) ops.push({ op: 'create', key, fields: f });
    else if (scLocked(e)) kept++;
    else if (Object.keys(f).some(k => k !== 'Title' && String(e.fields[k] ?? '') !== String(f[k]))) ops.push({ op: 'update', key, id: e.id, fields: f });
    else same++;
  });
  return { ops, same, kept };
}
const scCount = (ops, o) => ops.filter(p => p.op === o).length;

async function scLoad() {
  const [it, rp, lk, mn, st] = await Promise.all(['items', 'reports', 'links', 'manual', 'state'].map(scList));
  /* 目標マスタは年度ごと。Title は「年度|目標ID」（同じ目標IDでも年度が違えば別の目標） */
  const items = it.map(x => { const f = x.fields, d = scJ(f.Data); return { id: f.Title.split('|').pop(), fy: +d.fy, p: (+f.Pillar || 1) - 1, pillarName: d.pillarName || '', t: d.t || '', full: d.full || '', done: d.done || '', note: d.note || '' }; })
    .filter(i => i.fy).sort((a, b) => a.fy - b.fy || scNat(a.id, b.id));
  const reps = rp.map(x => { const f = x.fields, d = scJ(f.Data); return { rid: f.Title, _sp: x.id, d: f.ReportDate, mem: f.Member, r: d.r || '', o: d.o || '', g: d.g || '', ed: d.ed, x: d.x }; }).filter(r => !r.x);
  const links = lk.map(x => { const f = x.fields, d = scJ(f.Data); return { key: f.Title, _sp: x.id, rid: d.rid || '', i: f.ItemId, d: f.ReportDate, mem: f.Member, c: d.c, s: d.s, e: d.e || '', ed: d.ed, x: d.x }; }).filter(l => !l.x);
  const manual = mn.map(x => { const f = x.fields, d = scJ(f.Data); return { id: f.Title, _sp: x.id, item: f.ItemId, type: f.Kind, month: f.Month, status: f.Status || 'confirmed', who: d.who || '', text: d.text || '', group: d.group || '', source: d.source || 'manual' }; });
  const verdict = {}, summary = {};
  st.forEach(x => {
    const f = x.fields, d = scJ(f.Data);
    if (f.Kind === 'verdict') verdict[f.StateKey] = { label: d.label, note: d.note || '', _sp: x.id };
    else if (f.Kind === 'summary') summary[f.StateKey] = { text: d.text || '', _sp: x.id };
  });
  return { items, reps, links, manual, verdict, summary };
}
async function scAddManual(x) { x._sp = await scCreate('manual', scManualFields(x)); }
async function scSaveManual(x) { await scUpdate('manual', x._sp, scManualFields(x)); }
async function scDelManual(x) { if (x._sp) await scRemove('manual', x._sp); }
/* 日報明細・紐づけ明細の編集。直した行には ed=1、消した行には x=1 を付ける（消すのは印だけで、行は残す）。
   これで、月次の取込が同じ日報IDを上書きしても、手で直した内容は戻らない。 */
const scFlags = o => Object.assign({}, o.ed ? { ed: 1 } : {}, o.x ? { x: 1 } : {});
const scReportFields = r => ({ Title: r.rid, ReportDate: r.d, Member: r.mem, Data: JSON.stringify(Object.assign({ r: r.r || '', o: r.o || '', g: r.g || '' }, scFlags(r))) });
const scLinkFields = l => ({ Title: l.key, ItemId: l.i, ReportDate: l.d, Member: l.mem, Data: JSON.stringify(Object.assign({ rid: l.rid || '', c: l.c, s: l.s, e: l.e || '' }, scFlags(l))) });
async function scSaveReport(r) { const f = scReportFields(r); if (r._sp) await scUpdate('reports', r._sp, f); else r._sp = await scCreate('reports', f); }
async function scSaveLink(l) { const f = scLinkFields(l); if (l._sp) await scUpdate('links', l._sp, f); else l._sp = await scCreate('links', f); }
async function scSaveVerdict(id, v) {                // v: {label,note,_sp?}
  const f = { Title: 'verdict|' + id, Kind: 'verdict', StateKey: id, Data: JSON.stringify({ label: v.label, note: v.note || '' }) };
  if (v._sp) await scUpdate('state', v._sp, f); else v._sp = await scCreate('state', f);
}
async function scSaveSummary(key, s) {               // s: {text,_sp?}
  const f = { Title: 'summary|' + key, Kind: 'summary', StateKey: key, Data: JSON.stringify({ text: s.text }) };
  if (s._sp) await scUpdate('state', s._sp, f); else s._sp = await scCreate('state', f);
}
async function scRemoveState(sp) { if (sp) await scRemove('state', sp); }

/* 目標マスタ（goals_master JSON）を取り込む。同じIDは上書き */
async function scImportMaster(master, onProgress) {
  if (!master || !Array.isArray(master.items) || !master.items.length || !master.items[0].id) throw new Error('目標マスタの形式ではありません');
  const fy = +((String(master.fiscal_year || '').match(/\d{4}/) || [])[0]);   // "2026 (2026/4-2027/3)" → 2026
  if (!fy) throw new Error('目標マスタの fiscal_year（年度）が読めません');
  const rows = master.items.map(i => ({ Title: fy + '|' + i.id, Pillar: i.pillar_no,
    Data: JSON.stringify({ fy, pillarName: i.pillar, t: i.short_title, full: i.sheet_text || '', done: i.completion_criteria_draft || '', note: i.sheet_note || '' }) }));
  const { ops, same } = scUpsertOps('items', rows, scByTitle(await scList('items')));
  await scBulk(ops, onProgress);
  return { fy, added: scCount(ops, 'create'), updated: scCount(ops, 'update'), same };
}
/* 取込用JSON を取り込む。
   受け付ける形: 配列（日報だけ）／ {reports:[…], additions:[…], plans:[…]}
   同じ usage_id は上書き。手入力・判定・要約・確定済みの予定は触らない。 */
async function scImportPackage(pkg, onProgress) {
  const p = Array.isArray(pkg) ? { reports: pkg } : (pkg || {});
  const { reports, links } = scToRows(p.reports || []);
  const { manual, errors } = scToManualRows(p);
  const [er, el, em] = await Promise.all([scList('reports'), scList('links'), scList('manual')]);
  const a = scUpsertOps('reports', reports, scByTitle(er)), b = scUpsertOps('links', links, scByTitle(el));
  const have = scByTitle(em), mops = manual.filter(f => !have.has(f.Title)).map(f => ({ op: 'create', key: 'manual', fields: f }));
  await scBulk(a.ops.concat(b.ops, mops), onProgress);
  const n = k => mops.filter(o => o.fields.Kind === k).length, tot = k => manual.filter(f => f.Kind === k).length;
  return {
    reports: { added: scCount(a.ops, 'create'), updated: scCount(a.ops, 'update'), same: a.same, kept: a.kept },
    links: { added: scCount(b.ops, 'create'), updated: scCount(b.ops, 'update'), same: b.same, kept: b.kept },
    additions: { added: n('実績'), same: tot('実績') - n('実績') },
    plans: { added: n('予定'), same: tot('予定') - n('予定') },
    errors
  };
}
