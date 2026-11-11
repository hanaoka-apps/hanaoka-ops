'use strict';
const EC = window.EcSales, LAY = window.EC_LAYOUTS;
/* 画面の「プロフィール」：EC売上（Shopify）が標準。ふるさと納税（furusato_sales.html）は、window.EC_PROFILE で次を差し替える：
   storeKey・configUrl／loadOrders(api)＝注文の読み込み（Shopify の自動取得ファイルの代わり）／buildSlip・juchuRows＝伝票・取込行の作り方／
   noPay＝入金タブを出さない／words＝画面の言葉の置き換え（Shopify → サイネックス など）／emptyOrders＝注文がないときの文 */
const PROFILE = window.EC_PROFILE || {};
const BUILD_SLIP = (o, ctx) => (PROFILE.buildSlip || EC.buildSlip)(o, ctx);
const JUCHU_ROWS = (slips, header, cfg, cal) => (PROFILE.juchuRows || EC.juchuRows)(slips, header, cfg, cal, CONF);
if (PROFILE.words) {   // 画面に書く文字の置き換え（静的な文面は、ふるさと納税のHTML側で直している。ここは動的に作る文面用）
  const W = Object.keys(PROFILE.words), tr = v => W.reduce((a, k) => a.split(k).join(PROFILE.words[k]), String(v));
  [[Element.prototype, 'innerHTML'], [Node.prototype, 'textContent']].forEach(([proto, name]) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { get: d.get, set(v) { d.set.call(this, v == null ? v : tr(v)); }, configurable: true });
  });
}
const SCOPES = ['User.Read', 'Sites.Read.All', 'Sites.ReadWrite.All', 'Files.Read.All', 'Calendars.Read'];   // Sites.ReadWrite.All＝共有の履歴（SharePoint のリスト）の書き込み（ワークフローの wf_app.html と同じ）
const WRITE_SCOPES = ['Files.ReadWrite.All'];   // 取込ファイルと依頼を置くときだけ使う（tovas_checker.html と同じ）
const STORE_KEY = PROFILE.storeKey || 'ec_sales_v1';
const CONFIG_URL = PROFILE.configUrl || 'ec_sales_config.json';   // 業務の決まりごと（得意先・担当・品目・単価・納期など）はコードに書かず、ここから読む
let CONF = null;                              // 読み込んだ設定（sharepoint / files / shopifyFiles / config / mapping）

let msalInstance = null, account = null, driveId = null, isSoumu = false, isAdmin = false, isOperator = false;
const canImport = () => isAdmin || isOperator;   // 取込を依頼できる人＝管理者＋取込担当者（専用機側も同じ一覧で照合する）。確認OKは管理者だけ（isAdmin）
const FLOW_UI = () => !!document.getElementById('flowBar');   // 5工程の画面（EC売上）。ふるさと納税など #flowBar が無い画面は、これまでの絞り込みのまま
const M = { items: null, nouhin: null, smileCust: null, nyukin: null, stamps: {} };   // SMILE のマスタ・出力
let orders = [], orderIndex = {}, slips = [], payTx = null, payouts = null;
let store = null;
const SORT_KEY = STORE_KEY + '_sort';   // 一覧の注文日の並び順（asc＝昇順・古い順／desc＝降順・新しい順）。この端末の表示の好みだけを覚える
function loadSort() { try { return localStorage.getItem(SORT_KEY) === 'desc' ? 'desc' : 'asc'; } catch (e) { return 'asc'; } }
let curTab = 'orders', curView = 'list', curFilter = document.getElementById('flowBar') ? 'p1' : 'new', curSort = loadSort();
const sel = new Set();

/* ------------------------------------------------------------ 保存（この端末のブラウザ） */
function clone(x) { return JSON.parse(JSON.stringify(x, (k, v) => k[0] === '_' ? undefined : v)); }
function loadStore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) {}
  s = s || {};
  // 取込の記録は30日で消す（お客様の名前・住所が入るため。専用機側の取込ファイルと同じ期限）
  const imports = s.imports || {}, limit = Date.now() - 30 * 864e5;
  Object.keys(imports).forEach(k => { if (Date.parse(imports[k].requestedAt) < limit) delete imports[k]; });
  return { orders: s.orders || {}, imports, pending: s.pending || {}, pendingLogs: s.pendingLogs || [], legacy: s.legacy || ((s.mapping || s.cfg) ? { mapping: s.mapping, cfg: s.cfg } : null), mapping: clone(CONF.mapping), cfg: clone(CONF.config) };   // 対応表・設定は SharedMasters の共有ファイルから読む（loadSettings）。この端末の旧データは移行の確認用にだけ残す
}
function save() { try { const o = Object.assign({}, store); delete o.mapping; delete o.cfg; localStorage.setItem(STORE_KEY, JSON.stringify(clone(o))); } catch (e) { console.warn('保存できません', e); } }

/* ------------------------------------------------------------ 画面の小道具 */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yen = n => '¥' + Math.round(n).toLocaleString();
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const md = s => s ? s.slice(5).replace('-', '/') + '(' + WD[EC.weekday(s)] + ')' : '';
let cal = null;
function setStatus(type, msg) { $('statusBar').className = type || ''; $('sp-status').textContent = msg; }
function showLoginError(m) { HanaokaAuth.done(); const e = $('loginError'); e.textContent = m; e.style.display = 'block'; }
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function download(name, bytes, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function sjisLen(s) { let n = 0; for (const ch of String(s || '')) { const c = ch.charCodeAt(0); n += (c < 0x100 || (c >= 0xFF61 && c <= 0xFF9F)) ? 1 : 2; } return n; }

/* ------------------------------------------------------------ SharePoint（SharedMasters・読み取りのみ） */
async function getToken() {
  try { return (await msalInstance.acquireTokenSilent({ scopes: SCOPES, account })).accessToken; }
  catch { return (await msalInstance.acquireTokenPopup({ scopes: SCOPES })).accessToken; }
}
async function getWriteToken() {
  try { return (await msalInstance.acquireTokenSilent({ scopes: WRITE_SCOPES, account })).accessToken; }
  catch { return (await msalInstance.acquireTokenPopup({ scopes: WRITE_SCOPES })).accessToken; }
}
async function graphGet(url) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + url, { headers: { Authorization: 'Bearer ' + await getToken() } });
  if (!r.ok) throw new Error('Graph ' + r.status + ': ' + url);
  return r.json();
}
// 同時に何か所から呼ばれても、ドライブの検索は1回だけ（最初の読み込みを並べて進めるため）
let driveP = null;
function resolveDriveId() {
  if (driveId) return Promise.resolve(driveId);
  if (!driveP) driveP = resolveDriveId0().catch(e => { driveP = null; throw e; });
  return driveP;
}
async function resolveDriveId0() {
  if (driveId) return driveId;
  try {
    const nm = CONF.sharepoint.driveName, re = new RegExp(nm, 'i');
    const drives = (await graphGet('/sites/' + CONF.sharepoint.siteId + '/drives?$select=id,name,webUrl&$top=100')).value || [];
    const hit = drives.find(d => d.name === nm) || drives.find(d => re.test(d.name || '') || re.test(d.webUrl || ''));
    if (hit) { driveId = hit.id; return driveId; }
  } catch (e) { console.warn('ドライブを解決できません', e); }
  throw new Error('SharePoint のライブラリ（' + CONF.sharepoint.driveName + '）が見つかりません');
}
function decodeCsv(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if ((text.match(/�/g) || []).length > 5) { try { return new TextDecoder('shift_jis').decode(buf).replace(/^﻿/, ''); } catch (e) {} }
  return text;
}
async function fetchCsv(name) {
  const did = await resolveDriveId();
  const meta = await graphGet('/drives/' + did + '/root:/' + encodeURIComponent(name));
  const dl = meta['@microsoft.graph.downloadUrl'];
  if (!dl) throw new Error('downloadUrl がありません: ' + name);
  const r = await fetch(dl);
  if (!r.ok) throw new Error('取得失敗 ' + r.status + ': ' + name);
  return { text: decodeCsv(await r.arrayBuffer()), modified: meta.lastModifiedDateTime || '' };
}
// 画面を開いたとき、設定の読み込みを待たずに、あとで使うファイルを先に読み始める（順番に読むと、待ち時間が足し算になるため）。
// 読んだ結果は、あとで loadMasters／syncFromList が受け取る（読めなかったときも、そこで今までどおり扱う）
const PRE = {};
function prefetchCsv(name) { const p = fetchCsv(name); p.catch(() => {}); PRE[name] = p; }
function fetchCsvPre(name) { const p = PRE[name]; if (p) { delete PRE[name]; return p; } return fetchCsv(name); }
let EARLY = null, EARLY_ROWS = null;
function startEarly() {
  sharedInit();
  prefetchCsv(CONF.files.index);
  EARLY = { edits: loadEdits(), cal: loadCalendar(), orders: loadOrdersStep() };
  if (shared) { EARLY_ROWS = (async () => { if (!shared.siteId) await shared.connect(); return shared.loadAll(); })(); EARLY_ROWS.catch(() => {}); }
}
// SharedMasters に同名の設定ファイルがあれば、リポジトリのものより優先（コードを変えずに決まりごとを直せる）
async function loadSharedConfig() {
  try {
    const r = await fetchCsv(CONF.sharepoint.configFile), o = JSON.parse(r.text);
    ['sharepoint', 'files', 'shopifyFiles'].forEach(k => { if (o[k]) CONF[k] = Object.assign(CONF[k] || {}, o[k]); });
    if (o.config) CONF.config = Object.assign(CONF.config, o.config);
    if (o.mapping) CONF.mapping = o.mapping;
  } catch (e) { /* 共有の設定ファイルはなくてよい */ }
}
// 会社カレンダー：Outlook の会社共通予定表（HUBのお知らせと同じ共有メールボックス）から休業日を読む。
// 終日の予定で、件名に「休日・休業・祝」などを含むものを休業日とする（言葉は設定ファイル）。読み取りだけで書き込みはしない。
let outlookClosed = [], calInfo = '';
async function loadCalendar() {
  outlookClosed = []; calInfo = '';
  const cc = CONF.calendar;
  if (!cc || !cc.mailbox) { calInfo = '会社カレンダーの設定がありません'; return; }
  try {
    const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - (cc.monthsBack || 1));
    const d1 = new Date(); d1.setDate(1); d1.setMonth(d1.getMonth() + (cc.monthsAhead || 13));
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T00:00:00+09:00';
    let url = '/users/' + encodeURIComponent(cc.mailbox) + '/calendarView?startDateTime=' + encodeURIComponent(iso(d0)) + '&endDateTime=' + encodeURIComponent(iso(d1)) + '&$top=100&$select=subject,start,end,isAllDay,isCancelled';
    const re = new RegExp((cc.closedWords || []).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)');
    const days = {}, matched = {}; let n = 0, total = 0, allDay = 0;
    while (url && n++ < 20) {
      const token = await getToken();
      const r = await fetch(url.startsWith('http') ? url : 'https://graph.microsoft.com/v1.0' + url, { headers: { Authorization: 'Bearer ' + token, Prefer: 'outlook.timezone="Tokyo Standard Time"' } });
      if (!r.ok) throw new Error('Graph ' + r.status);
      const data = await r.json();
      (data.value || []).forEach(ev => {
        if (ev.isCancelled) return;
        total++; if (ev.isAllDay) allDay++;
        if (!ev.isAllDay || !re.test(ev.subject || '')) return;
        matched[ev.subject] = 1;
        let d = (ev.start.dateTime || '').slice(0, 10); const end = (ev.end.dateTime || '').slice(0, 10);
        for (let i = 0; d && d < end && i < 40; i++) { days[d] = ev.subject; d = EC.addDays(d, 1); }
      });
      url = data['@odata.nextLink'] || '';
    }
    outlookClosed = Object.keys(days).sort(); window.__closedNames = days;
    calInfo = 'Outlook の会社共通予定表から ' + outlookClosed.length + '日分の休業日を読み込みました（予定 ' + total + '件・うち終日 ' + allDay + '件）' +
      (Object.keys(matched).length ? '。休業として読んだ予定：' + Object.keys(matched).join('、') : '。休業として読める予定はまだありません（件名に「' + (cc.closedWords || []).join('」「') + '」のどれかを含む終日の予定）');
  } catch (e) {
    console.warn('会社カレンダーを読めません', e);
    calInfo = '会社カレンダーを読めませんでした（' + e.message + '）。下の「個別に追加する休み」で補えます';
  }
}
function buildCal() { return EC.makeCalendar(Object.assign({}, store.cfg, { closedDates: (store.cfg.closedDates || []).concat(outlookClosed) })); }
async function soumuHasAccess() {
  if (sessionStorage.getItem('soumuAccess') === '1') return true;
  try { await graphGet(CONF.sharepoint.soumuSite + '?$select=id'); sessionStorage.setItem('soumuAccess', '1'); return true; }
  catch (e) { return false; }
}
function stamp(iso) { if (!iso) return ''; const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

// SMILE の品目・納品先・受注・入金。軽量ファイル（ec_smile_index.json。専用機が全件出力のあとに作る）を優先して読み、
// 無い・読めないときだけ全件CSVを読む（重いので、画面にそのことを出す）
async function loadMasters() {
  const failed = [];
  const early = EARLY; EARLY = null;   // 画面を開いたときに先に読み始めたもの（あれば）
  await (early ? early.edits : loadEdits());
  const F = (r, names) => EC.pick(r, names);
  const applyItems = objs => {
    M.items = {};
    objs.forEach(r => { M.items[F(r, ['品目コード'])] = { name: F(r, ['品目名']), unit: F(r, ['単位']), cost: F(r, ['標準原価']), teihai: F(r, ['初期表示用手配区分']) || '1', stock: F(r, ['在庫管理区分名']) }; });   // stock＝在庫管理（行う／行わない）。テスト送信の安全確認に使う
  };
  const applyNouhin = objs => { M.nouhin = EC.indexDeliveryMaster(objs, store.cfg); };
  const applyJuchu = objs => {
    M.smileCust = {};
    objs.forEach(r => {
      const c = F(r, ['得意先コード']);
      if (!store.cfg.customers[c]) return;
      if (EC.isTestPo(F(r, ['客先注番']), (CONF.testImport || {}).poPrefix)) return;   // テスト送信の注文は本番の取込済みとして数えない
      const k = String(F(r, ['客先注番'])).replace(/\D/g, '');
      if (k) M.smileCust[k] = c;
    });
  };
  const applyNyukin = objs => {
    M.nyukin = {};
    objs.forEach(r => {
      const c = F(r, ['得意先コード']);
      if (!store.cfg.customers[c]) return;
      const d = String(F(r, ['伝票日付'])).replace(/\D/g, '');
      if (d.length !== 8) return;
      const key = c + '|' + d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6);
      (M.nyukin[key] = M.nyukin[key] || []).push(+F(r, ['入金額']) || 0);
    });
  };
  const job = async (key, name, fn) => {
    try { const r = await fetchCsv(name); fn(r.text); M.stamps[key] = r.modified; }
    catch (e) { console.warn(name, e); failed.push(name); }
  };

  let idx = null;
  M.indexMissing = false; M.indexInfo = null; M.smileIdx = null;
  try {
    const r = await fetchCsvPre(CONF.files.index);
    idx = JSON.parse(r.text);
    if (!idx || !idx.generatedAt || !idx.items || !idx.nouhin || !idx.orders) idx = null;
  } catch (e) { console.warn(CONF.files.index, e); }

  M.testDeliveryCodes = null;   // テスト送信の送り先（東京）の納品先コード（分からなければ null）
  const tcode = (CONF.testImport || {}).customerCode;
  const testCodes = objs => { const o = {}; objs.forEach(r => { if (F(r, ['得意先コード']) === tcode) o[F(r, ['納品先コード'])] = true; }); return o; };
  if (idx) {
    M.testDeliveryCodes = testCodes(EC.indexObjects(idx.nouhin));   // 索引には EC の得意先の納品先がすべて入っている（999998 もここに出る）
    applyItems(EC.indexObjects(idx.items)); applyNouhin(EC.indexObjects(idx.nouhin)); applyJuchu(EC.indexObjects(idx.orders));
    M.stamps.items = M.stamps.nouhin = M.stamps.juchu = idx.generatedAt;
    M.indexInfo = { generatedAt: idx.generatedAt };
    M.smileIdx = { juchu: EC.indexObjects(idx.orders), nouhin: EC.indexObjects(idx.nouhin), byPo: null, byNouhin: null };   // 注文を開いたとき、SMILE の実際の値を左右に並べるため
    const hasNyukin = (idx.sources || []).some(s => s.name === CONF.files.nyukin);
    if (isSoumu) {
      if (hasNyukin && idx.nyukin) { applyNyukin(EC.indexObjects(idx.nyukin)); M.stamps.nyukin = idx.generatedAt; }
      else await job('nyukin', CONF.files.nyukin, t => applyNyukin(EC.parseAuto(t)));
    }
  } else {
    M.indexMissing = true;
    await Promise.all([
      job('items', CONF.files.items, t => applyItems(EC.parseObjects(t))),
      job('nouhin', CONF.files.nouhin, t => { const objs = EC.parseObjects(t); applyNouhin(objs); M.testDeliveryCodes = testCodes(objs); }),
      job('juchu', CONF.files.juchu, t => applyJuchu(EC.parseAuto(t)))
    ]);
    if (isSoumu) await job('nyukin', CONF.files.nyukin, t => applyNyukin(EC.parseAuto(t)));
  }
  await (early ? early.cal : loadCalendar());
  failed.push(...await (early ? early.orders : loadOrdersStep()));
  return failed;
}
// 注文の自動取得（あれば）。読めなかったものの名前の一覧を返す
async function loadOrdersStep() {
  const failed = [];
  // ふるさと納税は、専用機が解凍した注文CSVを PROFILE.loadOrders で読む
  if (PROFILE.loadOrders) {
    try {
      await PROFILE.loadOrders({
        conf: CONF, graphGet, resolveDriveId, stamp,
        note(msg) {   // 読み込みの結果（読めなかった理由など）を、注文欄の上に出す
          const e = $('st-source'); if (!e) return;
          let n = $('st-load'); if (!n) { n = document.createElement('div'); n.id = 'st-load'; n.className = 'muted'; n.style.marginTop = '4px'; e.parentNode.appendChild(n); }
          n.textContent = msg;
        },
        setOrders(list) {
          orders = list; orderIndex = {}; orders.forEach(o => { orderIndex[o.id.replace(/\D/g, '')] = o; });
          const latest = orders.reduce((a, o) => o.createdAt > a ? o.createdAt : a, '');
          if (!$('f-from').value) $('f-from').value = EC.addDays(latest || today(), -30);
        }
      });
    } catch (e) { console.warn('注文を読めません', e); failed.push('注文CSV'); try { const n = $('st-source'); if (n) { let m = $('st-load'); if (!m) { m = document.createElement('div'); m.id = 'st-load'; m.className = 'muted'; n.parentNode.appendChild(m); } m.textContent = '注文CSVを読めませんでした：' + (e && e.message || e); } } catch (x) { /* 表示だけ */ } }
  }
  for (const k of PROFILE.loadOrders ? [] : Object.keys(CONF.shopifyFiles || {})) {
    try { const r = await fetchCsv(CONF.shopifyFiles[k]); M.stamps['shopify_' + k] = r.modified; ingestShopify(k, r.text, CONF.shopifyFiles[k] + '（SharePoint ' + stamp(r.modified) + '）'); } catch (e) { /* まだ無い */ }
  }
  return failed;
}

/* ------------------------------------------------------------ Shopify データ */
function ingestShopify(kind, text, label) {
  const objs = EC.parseObjects(text);
  if (kind === 'orders') {
    if (!objs.length || !('Lineitem name' in objs[0])) { alert('注文CSVの形式ではありません（Lineitem name 列がありません）'); return false; }
    orders = EC.groupShopifyOrders(objs); orderIndex = {}; orders.forEach(o => { orderIndex[o.id.replace(/\D/g, '')] = o; });
    markDrop('orders', label + '：' + orders.length + '件');
    const latest = orders.reduce((a, o) => o.createdAt > a ? o.createdAt : a, '');
    if (!$('f-from').value) $('f-from').value = EC.addDays(latest || today(), -30);
  } else if (kind === 'payouts') {
    if (!objs.length || !('Payout Date' in objs[0])) { alert('入金CSVの形式ではありません'); return false; }
    payouts = objs; markDrop('payouts', label + '：' + objs.length + '回');
  } else {
    if (!objs.length || !('Payout Date' in objs[0]) || !('Net' in objs[0])) { alert('入金の中身CSVの形式ではありません'); return false; }
    payTx = objs; markDrop('tx', label + '：' + objs.length + '行');
  }
  return true;
}
function markDrop(key, msg) {
  const id = { orders: 'orders', payouts: 'payouts', tx: 'tx' }[key];
  $('drop-' + id).classList.add('loaded'); $('st-' + id).textContent = '✅ ' + msg;
}
function wireDrop(key, kind) {
  const zone = $('drop-' + key), input = $('file-' + key);
  const read = f => { if (!f) return; const fr = new FileReader(); fr.onload = () => { if (ingestShopify(kind, decodeCsv(fr.result), f.name)) { recompute(); render(); } }; fr.readAsArrayBuffer(f); };
  input.onchange = () => read(input.files[0]);
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); read(e.dataTransfer.files[0]); };
}

/* ------------------------------------------------------------ 伝票を作る */
/* ------------------------------------------------------------ 納品先の手動編集（SharedMasters の _ec_edits/<注文番号>.json）
   お客様の名前・住所・電話は共有のリスト（EC_Order・EC_Log）に書かない決まりなので、直した値は SharedMasters のファイルに置く（Shopify の注文 CSV と同じ置き場）。
   リスト（EC_Log）には「誰がいつどの項目を直した」だけを残す（値は書かない）。取込後の「何が違うか」は、Shopify と SMILE の見比べで分かる。
   保存の前に、必ず確認の画面を出す。直した項目は個別にも、まとめても元（Shopify の値）に戻せる。 */
const EDIT_DIR = '_ec_edits';
let EDITS = {};            // { 注文番号: { fields, orig, updatedAt, updatedBy } }
let editId = null, editDraft = null;
// 納品先の直しを、書き換えたまま保存していないか（直し始めの値＝いまの納品先の値と比べる）。閉じる・別の注文を開く・ページを離れるときに、確かめる
function editDirty() {
  if (!editId || !editDraft) return false;
  const s = slips.find(x => x.id === editId); if (!s) return false;
  const dv = EC.deliveryFromOrder(s.order, store.cfg), v = x => String(x == null ? '' : x);
  return EC.EDIT_FIELDS.some(f => v(editDraft[f.k]) !== v(dv[f.k]));
}
function confirmDiscardEdit() { return !editDirty() || confirm('保存していない直しがあります。閉じますか？\n\n［OK］直しを捨てて閉じる\n［キャンセル］戻って、直しを続ける（「内容を確認する」→「この内容で保存する」で保存できます）'); }
window.addEventListener('beforeunload', e => { if (editDirty()) { e.preventDefault(); e.returnValue = ''; } });
const orderNo = id => String(id).replace(/\D/g, '');
async function loadEdits() {
  EDITS = {};
  try {
    await rpaReady();
    const names = await RpaQueue.listDir(EDIT_DIR);
    await Promise.all(names.map(async n => {
      try { const b = await RpaQueue.readJson(EDIT_DIR + '/' + n); if (b && b.orderNo && b.fields && Object.keys(b.fields).length) EDITS[b.orderNo] = b; }
      catch (e) { console.warn('編集ファイルを読めません', n, e); }
    }));
  } catch (e) { console.warn('納品先の編集内容を読めません', e); }
}
// 直した内容を保存する（fields＝元と違う項目だけ。空なら元に戻す）。他の人が先に直していたら保存しない
async function saveDeliveryEdit(s, fields, auto, what) {
  const no = orderNo(s.id), path = EDIT_DIR + '/' + no + '.json';
  try {
    await rpaReady();
    const cur = await RpaQueue.readJson(path), base = EDITS[no];
    if (((cur && cur.updatedAt) || '') !== ((base && base.updatedAt) || '')) {
      alert('他の人が先にこの注文の納品先を直しました。最新の内容を読み直します。内容を確認して、もう一度直してください。');
      await loadEdits(); editId = null; editDraft = null; recompute(); render(); return false;
    }
    const keys = Object.keys(fields), body = { orderNo: no, updatedAt: new Date().toISOString(), updatedBy: account && account.username, fields, orig: {} };
    keys.forEach(k => { body.orig[k] = auto[k]; });
    await RpaQueue.writeFile(path, JSON.stringify(body), 'application/json');
    if (keys.length) EDITS[no] = body; else delete EDITS[no];
    const labels = keys.map(k => EC.EDIT_FIELDS.find(f => f.k === k).label);
    logOnly('その他', s.id, '', what + (labels.length ? '：' + labels.join('・') : ''));   // 値は書かない（項目名だけ）
    editId = null; editDraft = null; recompute(); render();
    return true;
  } catch (e) {
    console.warn(e);
    alert('保存できませんでした（SharedMasters に書く権限がないか、通信の問題です）。内容は変わっていません。\n' + (e && e.message ? e.message.slice(0, 120) : ''));
    return false;
  }
}

function recompute() {
  cal = buildCal();
  const smileOrders = M.smileCust || {};
  const ctx = { mapping: store.mapping, cfg: store.cfg, items: M.items || {}, smileOrders, cal };
  orders.forEach(o => { const e = EDITS[orderNo(o.id)]; o.deliveryEdit = e && e.fields && Object.keys(e.fields).length ? e.fields : null; });
  slips = orders.map(o => {
    const s = BUILD_SLIP(o, ctx);
    Object.defineProperty(s, 'autoShip', { get() { return EC.shipDateAuto(s, slipOf(s), cal); }, configurable: true });   // 受注日付（取込を押した日）から数える
    s.flags = s.flags.filter(f => !/分として処理$/.test(f.text));   // 「締め以降の受注は○/○分」は、Shopify の注文時刻の話。出荷予定日は受注日付から数えるので出さない
    s.baseMemo = s.memo; return s;
  });
  slips.forEach(s => { const e = EDITS[orderNo(s.id)]; if (s.order.deliveryEdit && e) s.flags.push({ level: 'info', text: '納品先を手動で直しています（' + Object.keys(e.fields).map(k => EC.EDIT_FIELDS.find(f => f.k === k).label).join('・') + '）' }); });
  slips.forEach(s => { s.hasErr = s.flags.some(f => f.level === 'error'); s.hasWarn = s.flags.some(f => f.level === 'warn'); });
}
function rec(s) { return store.orders[s.id] || null; }
function stateOf(s) {
  if (s.excluded) return 'excluded';
  const r = rec(s);
  if (r && r.status === 'excluded') return 'excluded';   // 人が手で対象外にした
  if (r && r.status === 'exported') return 'exported';
  if (r && r.status === 'waiting') return 'importing';   // 突合待ち（取込中の仲間）
  if (r && (r.status === 'importing' || r.status === 'confirm' || r.status === 'check')) return r.status;   // 取込の途中・要確認は、SMILEに伝票があっても取込済み扱いにしない
  if (s.inSmile) return 'smile';
  return r && r.status === 'ok' ? 'ok' : 'new';
}
// 対象外の理由（キャンセル等の自動のもの、または人が手で外したもの）。対象外でなければ ''
function excludedText(s) {
  if (s.excluded) return s.excluded;
  const r = rec(s);
  return r && r.status === 'excluded' ? '手動で対象外' + (r.excludeReason ? '：' + r.excludeReason : '（理由は履歴）') : '';
}
function isManualExcluded(s) { const r = rec(s); return !!(r && r.status === 'excluded' && !s.excluded); }
function memoOf(s) { const r = rec(s); return EC.joinMemo(s.baseMemo || s.memo, r && r.memoNote, store.cfg); }
function shipOf(s) { const r = rec(s); return (r && r.shipDate) || s.autoShip; }
// 受注伝票の日付（SMILE の受注日付）：取込ボタンを押した日。取込済みなら、取り込んだ日。手動で変えていれば、その日（この端末に保存）。
// 締め（設定の「締め時刻」・既定16:00）以降は翌営業日、休みの日は次の営業日。出荷予定日（受注日付から○営業日）も、この日付から数える
function slipAuto() { return EC.slipDateAuto(new Date(), store.cfg, cal); }
function slipOf(s) {
  const r = rec(s);
  if (r && r.slipUsed) return r.slipUsed;
  if (r && r.importAt && !(stateOf(s) === 'new' || stateOf(s) === 'ok')) return EC.slipDateAuto(new Date(r.importAt), store.cfg, cal);   // 他の人が取り込んだ注文：取込を押した時刻から求める
  return (r && r.slipDate) || slipAuto();
}
function slipCutText() { return (store.cfg && store.cfg.cutoffTime) || '16:00'; }
function fromDate() { return $('f-from').value || '0000-00-00'; }
function visible() {
  const q = $('f-q').value.trim().toLowerCase(), from = fromDate();
  return slips.filter(s => {
    if (s.orderDate < from) return false;
    if (q && !(s.name + ' ' + s.order.ship.name + ' ' + s.order.ship.company).toLowerCase().includes(q)) return false;
    return true;
  });
}

/* ------------------------------------------------------------ 描画：受注チェック */
// ---- 業務フロー（EC売上）：状態を4工程に読み替えて見せる（EcSales.flowOf）。絞り込みの値は p1〜p4・check（要対応）・excluded・all
const flowRole = () => ({ canImport: canImport(), canConfirm: isAdmin });
function flowOfSlip(s) { return EC.flowOf(stateOf(s), rec(s), flowRole()); }
function matchFilter(s) {
  if (curFilter === 'all') return true;
  if (!FLOW_UI()) return stateOf(s) === curFilter;
  if (curFilter === 'excluded') return stateOf(s) === 'excluded';
  const k = flowOfSlip(s).key; return curFilter === 'check' ? k === 'attn' : k === curFilter;
}
function renderFlowBar(vis) {
  const n = {}; vis.forEach(s => { const x = flowOfSlip(s), k = x.key === 'attn' ? 'check' : stateOf(s) === 'excluded' ? 'excluded' : x.key; n[k] = (n[k] || 0) + 1; });
  const sub = x => x.kind === 'human' ? (x.key === 'p3' && !isAdmin ? '管理者の作業' : 'あなたの作業') : x.kind === 'robot' ? '専用機が処理' : '処理済み';
  const tile = x => '<div class="ftile k-' + x.kind + (curFilter === x.key ? ' active' : '') + '" data-f="' + x.key + '" role="button" tabindex="0"><div class="ft-t"><span class="ft-n">' + x.num + '</span>' + esc(x.label) + (curFilter === x.key ? '<span class="ft-on">表示中</span>' : '') + '</div><div class="ft-s">' + sub(x) + '</div><div class="ft-c">' + (n[x.key] || 0) + '<small>件</small></div></div>';
  const attn = n.check || 0;
  $('flowBar').innerHTML = EC.FLOW.map(tile).join('<div class="farrow">→</div>') +
    '<div class="ftile k-attn' + (attn ? ' hot' : '') + (curFilter === 'check' ? ' active' : '') + '" data-f="check" role="button" tabindex="0"><div class="ft-t">⚠ 要対応' + (curFilter === 'check' ? '<span class="ft-on">表示中</span>' : '') + '</div><div class="ft-s">' + (attn ? '確認が必要です' : '通常のフローの外') + '</div><div class="ft-c">' + attn + '<small>件</small></div></div>' +
    '<details class="fmore"><summary>その他 ▾</summary><div class="fpop"><button class="btn sec sm' + (curFilter === 'excluded' ? ' on' : '') + '" data-f="excluded">対象外 ' + (n.excluded || 0) + '件</button><button class="btn sec sm' + (curFilter === 'all' ? ' on' : '') + '" data-f="all">すべて ' + vis.length + '件</button></div></details>';
}
// 一覧の「現在地」の欄／詳細の最上部
function flowCell(s) {
  const x = flowOfSlip(s), r = rec(s);
  if (x.key === 'other') return '<span class="ph k-none">' + (stateOf(s) === 'excluded' ? '対象外' : '') + '</span>';
  const who = x.kind === 'robot' ? '専用機が処理中' : x.kind === 'attn' ? (x.who === 'あなた' ? 'あなたの作業' : x.who + 'の作業') : x.kind === 'human' ? (x.who === 'あなた' || x.who.indexOf('あなた') === 0 ? 'あなたの作業' : x.who + 'の作業') : '';
  return '<span class="ph k-' + x.kind + '">' + (x.num ? x.num + ' ' : '') + esc(x.label) + '</span>' + (who ? '<div class="muted">' + esc(who) + '</div>' : '') + (x.sub && x.key !== 'attn' ? '<div class="muted">' + esc(x.sub) + '</div>' : '');
}
function flowBoxHtml(s) {
  const x = flowOfSlip(s);
  if (x.key === 'other') return '';
  const head = x.key === 'attn' ? '要対応' : x.num + ' ' + x.label;
  return '<div class="flowbox k-' + x.kind + '"><div class="fb-h"><b>現在地：' + esc(head) + '</b>' + (x.sub ? '<span class="tag info">' + esc(x.sub) + '</span>' : '') + (x.who ? '<span class="fb-w">担当：' + esc(x.who) + '</span>' : '') + '</div>' + (x.next ? '<div class="fb-n">' + esc(x.next) + '</div>' : '<div class="fb-n">SMILEへの起票と結果確認が完了しています。</div>') + '</div>';
}
const FILTERS = [['new', '未確認'], ['ok', 'OK済（取込待ち）'], ['importing', '取込中・突合待ち'], ['confirm', '確認待ち'], ['check', '要確認'], ['exported', '起票済'], ['smile', 'SMILE取込済'], ['excluded', '対象外'], ['all', 'すべて']];
const STATE_LABEL = { new: '未確認', ok: 'OK済', importing: '取込中', confirm: '確認待ち', check: '要確認', exported: '起票済', smile: 'SMILE取込済', excluded: '対象外' };
// SMILE の納品先マスタに、同じ納品先（名前・郵便番号）があれば、そのコード。設定 deliveryReuse が false のとき（ふるさと納税）は、過去の納品先があっても使わない（毎回すべて新規に登録する）
const reuseCode = (s, d) => { if (store.cfg.deliveryReuse === false) return ''; const m = M.nouhin && M.nouhin[s.cust]; return (m && m.keys[d.key]) || ''; };
function destTag(s) {
  const d = EC.deliveryFromOrder(s.order, store.cfg), m = M.nouhin && M.nouhin[s.cust];
  if (!m) return '';
  const code = reuseCode(s, d);
  return code ? '<span class="tag info">既存 ' + code + '</span>' : '<span class="tag new">新規</span>';
}
let openId = null;
function rowHtml(s) {
  const st = stateOf(s), r = rec(s), manual = !!(r && r.shipDate && r.shipDate !== s.autoShip);
  const cls = [st, s.hasErr ? 'err' : (s.hasWarn ? 'warn' : '')].join(' ');
  const ship = shipOf(s), closed = ship && !cal.isBusinessDay(ship);
  const items = s.lines.length ? s.lines.map(l => '<div class="k-' + l.kind + '">' + esc(l.code) + ' ×' + l.qty + ' <span class="muted">' + yen(l.amountNet) + '</span></div>').join('') : '<span class="muted">（商品なし）</span>';
  const flags = s.flags.map(f => '<span class="tag ' + f.level + '">' + esc(f.text) + '</span>').join('') + (r && r.memoNote ? '<span class="tag ok">社内メモ追記：' + esc(r.memoNote) + '</span>' : '');
  const who = esc(s.order.ship.company || s.order.ship.name) + (s.order.ship.company ? '<div class="muted">' + esc(s.order.ship.name) + '</div>' : '');
  const canSel = st === 'new' || st === 'ok';
  let act = '';
  if (st === 'new') act = '<button class="btn sm" data-act="ok" data-id="' + s.id + '"' + (s.hasErr ? ' disabled title="赤い確認事項を先に直してください"' : '') + '>OK</button>';
  else if (st === 'ok') act = '<button class="btn sec sm" data-act="undo" data-id="' + s.id + '">戻す</button>';
  else if (st === 'exported') act = '<button class="btn sec sm" data-act="undo" data-id="' + s.id + '">未確認に戻す</button>';
  else if (st === 'importing') act = '<span class="tag warn">' + (r && r.status === 'waiting' ? '突合待ち' : '取込中') + '</span>';
  else if (st === 'confirm') act = '<div class="muted">受注№ ' + esc((r && r.juchuNo) || '') + '</div>' + (isAdmin ? '<button class="btn sm" data-act="confirmok" data-id="' + s.id + '">確認OK</button>' : '<span class="tag warn">確認待ち</span>');
  else if (st === 'check') act = '<span class="tag err">要確認</span>';
  else if (st === 'excluded' && isManualExcluded(s)) act = '<button class="btn sec sm" data-act="undo" data-id="' + s.id + '">未確認に戻す</button>';
  if (st === 'new' || st === 'check') act += ' <button class="btn sec sm" data-act="exclude" data-id="' + s.id + '" title="SMILEに取り込まない注文を一覧から外す（理由を記録。あとで戻せます）">対象外</button>';
  if (r && r.juchuNo && st === 'exported') act = '<div class="muted">受注№ ' + esc(r.juchuNo) + '</div>' + act;
  act += whoHtml(r);   // OKした人・確認OKした人
  return '<tr class="' + cls + '" data-row="' + s.id + '"><td>' + (canSel ? '<input type="checkbox" data-sel="' + s.id + '"' + (sel.has(s.id) ? ' checked' : '') + '>' : '') + '</td>' +
    (FLOW_UI() ? '<td class="flowcell">' + flowCell(s) + '</td>' : '') +
    '<td><b>' + esc(s.name) + '</b><div class="muted">' + s.orderDate.slice(5).replace('-', '/') + ' ' + esc(s.order.createdTime) + '</div>' + (s.order.juchuNo ? '<div class="muted" title="サイネックスの CSV の「受注番号」（並びは、この順）">受注 ' + esc(s.order.juchuNo) + '</div>' : '') + '</td>' +
    '<td>' + who + '<div>' + (st === 'new' || st === 'ok' ? destTag(s) : '') + '</div></td>' +
    '<td class="items">' + items + '</td><td class="num">' + yen(s.order.total) + '</td>' +
    '<td><span class="tag ' + (s.cust === store.cfg.earlyCustomer ? 'tokyo' : 'info') + '">' + esc(store.cfg.customers[s.cust].short) + '</span></td>' +
    '<td>' + (st === 'excluded' ? '' : '<input type="date" class="dateinp' + (manual ? ' manual' : '') + '" data-ship="' + s.id + '" value="' + ship + '"> ' + (closed ? '<div class="closed">休業日です</div>' : '<div class="muted">' + md(ship) + (manual ? ' 手動' : '') + '</div>')) + '</td>' +
    '<td><div class="flags">' + (st === 'excluded' ? '<span class="tag info">' + esc(excludedText(s)) + '</span>' : flags) + '</div></td><td>' + act + '</td></tr>';
}
const THEAD0 = '<thead><tr><th><input type="checkbox" data-selall></th><th>注文</th><th>お客様・納品先</th><th>SMILEの明細（税抜）</th><th class="num">税込合計</th><th>得意先</th><th>出荷予定日</th><th>確認</th><th></th></tr></thead>';
const THEAD = () => FLOW_UI() ? THEAD0.replace('</th><th>注文</th>', '</th><th>現在地</th><th>注文</th>') : THEAD0;
function renderOrders() {
  const vis = visible(), count = k => vis.filter(s => k === 'all' || stateOf(s) === k).length;
  // タブの数字：自分にボールがある件数。①＝確認前（取込担当者は OK済・起票依頼待ちも）、③＝確認待ち（確認OKを押せる管理者だけ）。業務フローの絵を使わない画面では、従来どおり未確認の件数
  if (FLOW_UI()) {
    const role = flowRole(), p1 = vis.filter(s => { const k = stateOf(s); return k === 'new' || (k === 'ok' && role.canImport); }).length, p3 = role.canConfirm ? vis.filter(s => stateOf(s) === 'confirm').length : null;
    const c = $('cnt-orders');
    c.textContent = '① ' + p1 + (p3 === null ? '' : '　③ ' + p3);
    c.title = 'あなたの作業の件数です。① 注文を確認（OK・取込）' + (p3 === null ? '' : '／③ 結果を確認（確認OK）');
    c.classList.toggle('hot', p1 + (p3 || 0) > 0);
  } else $('cnt-orders').textContent = vis.filter(s => stateOf(s) === 'new').length;
  if (curTab !== 'orders') return;   // 見えていないタブの一覧は作らない（タブを切り替えたときに、見えるタブだけ作る）
  if (FLOW_UI()) { $('chips').innerHTML = ''; renderFlowBar(vis); } else
  $('chips').innerHTML = FILTERS.map(([k, l]) => '<span class="chip' + (curFilter === k ? ' active' : '') + '" data-f="' + k + '">' + l + '<b>' + count(k) + '</b></span>').join('');
  const dir = curSort === 'desc' ? -1 : 1;   // 注文日（同じ日は注文の時刻）の昇順・降順
  // 並び：注文日 → 注文の時刻 → 受注番号（ふるさと納税。サイネックスの CSV の受注番号。受け取った Excel と同じ並びになる）。受注番号が無いもの（EC売上）は、そのまま
  const juchuNum = s => { const v = s.order.juchuNo; return /^\d+$/.test(v || '') ? Number(v) : null; };
  const cmpOrder = (a, b) => {
    if (a.orderDate !== b.orderDate) return a.orderDate < b.orderDate ? -1 : 1;
    if (a.order.createdTime !== b.order.createdTime) return a.order.createdTime < b.order.createdTime ? -1 : 1;
    const x = juchuNum(a), y = juchuNum(b);
    return x != null && y != null && x !== y ? (x < y ? -1 : 1) : 0;
  };
  const list = vis.filter(matchFilter).sort((a, b) => dir * cmpOrder(a, b));
  const el = $('list');
  if (!orders.length) { el.innerHTML = '<div class="empty">' + (PROFILE.emptyOrders || 'Shopify の注文 CSV を上のボックスに入れると、ここに注文が並びます') + '</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="empty">この条件の注文はありません</div>'; return; }
  const warnNoSmile = (M.smileCust ? '' : '<div class="tag warn" style="margin-bottom:8px">SMILE の受注明細を読めていないため、取込済みの注文を見分けられません</div>') + confirmBulkHtml();
  if (curView === 'list') { el.innerHTML = warnNoSmile + '<div style="overflow:auto"><table>' + THEAD() + '<tbody>' + list.map(rowHtml).join('') + '</tbody></table></div>'; return; }
  const groups = {};
  list.forEach(s => { const l = s.lines.find(x => x.kind === 'body') || s.lines[0]; const k = l ? l.code : '（商品なし）'; (groups[k] = groups[k] || { code: k, name: l ? l.name : '', list: [] }).list.push(s); });
  el.innerHTML = warnNoSmile + '<div style="overflow:auto"><table>' + THEAD() + '<tbody>' + Object.keys(groups).sort().map(k => {
    const g = groups[k], newCount = g.list.filter(s => stateOf(s) === 'new' && !s.hasErr).length, dates = [...new Set(g.list.map(shipOf))].sort();
    return '<tr class="gh"><td colspan="' + (FLOW_UI() ? 10 : 9) + '"><div class="row"><span>' + esc(g.code) + ' <span class="muted">' + esc(g.name) + '</span></span><span class="tag info">' + g.list.length + '件</span><div class="grow"></div>' +
      '<span class="muted">出荷予定日をまとめて</span><input type="date" data-gdate="' + esc(k) + '" value="' + (dates.length === 1 ? dates[0] : '') + '"><button class="btn sec sm" data-gset="' + esc(k) + '">変更</button>' +
      '<button class="btn sm" data-gok="' + esc(k) + '"' + (newCount ? '' : ' disabled') + '>問題のない ' + newCount + '件をOK</button></div></td></tr>' + g.list.map(rowHtml).join('');
  }).join('') + '</tbody></table></div>';
  window.__groups = groups;
}

/* ------------------------------------------------------------ 詳細ドロワー（行をクリック） */
// 注文の確認事項・社内メモ・出荷予定日（EC売上の5工程画面では、確認の一覧は「確認サマリー」に、メモと出荷予定日は「担当者が編集できる項目」にまとめる）
function flagsHtml(s) {
  return (s.flags.length ? '<h3>確認すること</h3>' + s.flags.map(f => '<div class="alert ' + f.level + '">' + esc(f.text) + '</div>').join('') : '');
}
// 受注日付の入力（出荷予定日と同じ作り）。取込を押した日が自動で入る。ギリギリのときは、ここで変える
function slipDateBlockHtml(s, st, r, ship) {
  const v = slipOf(s), manual = !!(r && r.slipDate && !r.slipUsed), editable = st === 'new' || st === 'ok';
  const ctl = editable ? '<input type="date" class="dateinp' + (manual ? ' manual' : '') + '" data-slip="' + s.id + '" value="' + v + '"> ' +
    (manual ? '<button class="btn sec sm" data-act="slipauto" data-id="' + s.id + '">自動の日付（' + md(slipAuto()) + '）に戻す</button> <span class="tag warn">手動で変更</span>' : '') : esc(md(v));
  return '<h3>受注日付（SMILE の受注伝票）</h3><div>' + ctl + '</div>' +
    (editable ? '<div class="muted">取込ボタンを押した日です（' + esc(slipCutText()) + ' 以降は翌営業日）。ギリギリのときは、日付を変えられます。変えた日付で取り込まれます（この端末に保存）</div>' : '<div class="muted">取込ボタンを押した日です</div>') +
    (editable && ship && ship < v ? '<div class="alert warn">出荷予定日が受注日付より前です。出荷予定日も見直してください</div>' : '');
}
// 伝票ふうの見出しの「受注日」：取込前は、ここで変えられる
function slipCtl(s, st, r, text, note) {
  if (!(st === 'new' || st === 'ok')) return esc(text);
  const manual = !!(r && r.slipDate);
  return '<div class="ship-out' + (manual ? ' manual' : '') + '"><input type="date" class="dateinp' + (manual ? ' manual' : '') + '" data-slip="' + s.id + '" value="' + slipOf(s) + '"> ' +
    (manual ? '<button class="btn sec sm" data-act="slipauto" data-id="' + s.id + '">自動の日付（' + md(slipAuto()) + '）に戻す</button> <span class="tag warn">手動で変更</span>' : '') +
    (note ? '<div class="sub">取込ボタンを押した日（' + esc(slipCutText()) + ' 以降は翌営業日）。滑り込みで当日にしたいときは、ここで変えます。変えた日付で取り込まれます</div>' : '') + '</div>';
}
// 取込の確認に出す、受注日付のまとめ
function slipDateNote(ok) {
  const by = {}; ok.forEach(s => { by[s.slipDate] = (by[s.slipDate] || 0) + 1; });
  const ships = ok.map(s => s.shipDate).filter(Boolean).sort();
  const ds = Object.keys(by).sort(), early = ok.filter(s => s.shipDate && s.slipDate && s.shipDate < s.slipDate).length;
  const man = ok.some(s => { const r = rec(s); return r && r.slipDate; });
  return '受注日付：' + (ds.length === 1 ? md(ds[0]) : ds.map(d => md(d) + ' ' + by[d] + '件').join('、')) + (man ? '（手動で変えたものを含む）' : '（取込を押した日。' + slipCutText() + ' 以降は翌営業日）') + '\n' +
    (ships.length ? '出荷予定日：' + (ships[0] === ships[ships.length - 1] ? md(ships[0]) : md(ships[0]) + '〜' + md(ships[ships.length - 1])) + '（受注日付から数えます）\n' : '') +
    (early ? '⚠ 出荷予定日が受注日付より前の注文が ' + early + '件あります（出荷予定日を見直してください）\n' : '');
}
function editBlockHtml(s, st, r, ship) {
  return '<h3>社内メモ（SMILE の受注伝票）</h3><div class="muted" style="margin-bottom:4px">' + ((s.baseMemo || s.memo) ? '基本は「' + esc(s.baseMemo || s.memo) + '」。続けて書き足したいことがあれば入力します。' : '基本は空です。書き足したいことがあれば入力します。') + '</div>' +
    '<input type="text" data-memo="' + s.id + '" value="' + esc((r && r.memoNote) || '') + '" placeholder="例：ブルー入荷待ち／入金確認済" style="width:100%"' + (st === 'exported' || st === 'smile' || st === 'excluded' || st === 'importing' || st === 'check' ? ' disabled' : '') + '>' +
    '<div class="muted" style="margin-top:4px">取り込まれるメモ：<b>' + esc(memoOf(s)) + '</b></div>' +
    slipDateBlockHtml(s, st, r, ship) +
    '<h3>出荷予定日</h3><div>' + (st === 'new' || st === 'ok' ? '<input type="date" class="dateinp' + (r && r.shipDate ? ' manual' : '') + '" data-ship="' + s.id + '" value="' + ship + '"> ' + (r && r.shipDate ? '<button class="btn sec sm" data-act="shipauto" data-id="' + s.id + '">自動の日付（' + md(s.autoShip) + '）に戻す</button> <span class="tag warn">手動で変更</span>' : '') : md(ship)) + '</div>' +
    '<div class="muted">受注日付から ' + s.leadDays + ' 営業日。日付を変えると、SMILE の納期・出荷予定日として取り込まれます。</div>' +
    '';
}
// SMILE に起票したあと（③結果を確認・④完了）の注文か
const isImported = st => st === 'confirm' || st === 'exported' || st === 'smile';
// 起票済みの帯：「この内容で起票した」ことと、受注№を大きく見せる
function importedBannerHtml(s) {
  const st = stateOf(s), r = rec(s) || {}, act = smileActual(s), no = r.juchuNo || (act && act.juchuNo) || '';
  const who = u => (u ? EC.shortUser(u) : '');
  let sub = '';
  if (st === 'smile') sub = 'このアプリを使う前から、SMILE に入っていた注文です';
  else if (st === 'confirm') sub = '取込と照合が終わりました。' + (isAdmin ? 'SMILE の内容を確認して、「確認OK」を押してください' : '管理者が「確認OK」を押すのを待っています');
  else sub = [r.importBy ? '起票を依頼 ' + who(r.importBy) : '', r.confirmedBy ? '確認OK ' + who(r.confirmedBy) + (r.confirmedAt ? ' ' + stamp(r.confirmedAt) : '') : ''].filter(Boolean).join('　／　');
  return '<div class="donebox' + (st === 'confirm' ? ' pending' : '') + '"><div class="db-l"><div class="db-h">' + (st === 'confirm' ? '✓ SMILE に起票しました（確認待ち）' : '✓ SMILE に起票しました') + '</div>' + (sub ? '<div class="db-sub">' + esc(sub) + '</div>' : '') + '</div>' +
    (no ? '<div class="db-no"><span>受注№</span><b>' + esc(no) + '</b></div>' : '') + '</div>';
}
function renderDrawer() {
  const dr = $('drawer'), sc = $('scrim');
  if (mapDrawer) { if (!(mapDrawer.mode === 'edit' && mapDrawer.rendered)) renderMapDrawer(); return; }   // 対応表のドロワー（編集中は、入力を消さないよう描き直さない）
  const s = openId && slips.find(x => x.id === openId);
  if (!s) { dr.hidden = sc.hidden = true; return; }
  dr.hidden = sc.hidden = false; dr.classList.add('wide');
  const o = s.order, st = stateOf(s), d = EC.deliveryFromOrder(o, store.cfg), m = M.nouhin && M.nouhin[s.cust], code = m && reuseCode(s, d);
  const ship = shipOf(s), r = rec(s);
  const row = (k, v) => v ? '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>' : '';
  dr.innerHTML = '<div class="row"><h2>' + esc(s.name) + '</h2><span class="tag ' + (st === 'ok' || st === 'exported' ? 'ok' : st === 'check' ? 'err' : st === 'importing' || st === 'confirm' ? 'warn' : 'info') + '">' + STATE_LABEL[st] + '</span><div class="grow"></div><button class="btn sec sm" data-close>閉じる ✕</button></div>' +
    '<div class="muted">' + s.orderDate + ' ' + esc(o.createdTime) + ' 受注／' + esc(store.cfg.customers[s.cust].name) + '</div>' +
    (FLOW_UI() ? (isImported(st) ? importedBannerHtml(s) : flowBoxHtml(s)) : '') +
    (r && r.juchuNo && !(FLOW_UI() && isImported(st)) ? '<h3>SMILE の受注</h3><dl>' + row('受注№', r.juchuNo) + '</dl>' : '') + checkHtml(r, st) +
    (FLOW_UI() ? (isImported(st) ? '' : judgeHtml(s)) : flagsHtml(s)) + detailViewHtml(s, editBlockHtml(s, st, r, ship)) + (FLOW_UI() ? '' : editBlockHtml(s, st, r, ship)) +
    '';
  const FL = FLOW_UI();
  const okBtn = '<button class="btn" data-act="ok" data-id="' + s.id + '"' + (s.hasErr ? ' disabled' : '') + '>' + (FL ? '確認OK（起票依頼待ちへ）' : 'OK にする') + '</button>';
  const undoBtn = '<button class="btn sec" data-act="undo" data-id="' + s.id + '">未確認に戻す</button>';
  const exclBtn = '<button class="btn sec" data-act="exclude" data-id="' + s.id + '">対象外にする</button>';
  let primary = '', more = [];
  if (st === 'new') { primary = okBtn; more.push(exclBtn); }
  else if (st === 'ok') { primary = '<span class="muted">' + (canImport() ? 'OK済です。画面下の「SMILEに取り込む」で、OK済の注文をまとめて起票を依頼します' : '取込担当者が起票を依頼します') + '</span>'; more.push(undoBtn); }
  else if (st === 'exported') more.push(undoBtn);
  else if (st === 'confirm') primary = isAdmin ? '<button class="btn" data-act="confirmok" data-id="' + s.id + '">確認OK（起票済みにする）</button>' : '<span class="muted">確認OKは管理者が行います</span>';
  else if (st === 'check') { if (isAdmin) primary = '<button class="btn" data-act="confirmed" data-id="' + s.id + '">SMILEを見て問題なし（起票済みにする）</button>'; if (isAdmin) more.push(undoBtn); more.push(exclBtn); }
  else if (st === 'excluded' && isManualExcluded(s)) { more.push(undoBtn); primary = '<span class="muted">' + esc(excludedText(s)) + '</span>'; }
  const actions = '<div class="dr-actions"><div class="row" style="gap:8px">' + primary + '<div class="grow"></div>' + (more.length ? '<details class="more-dd"><summary class="btn sec">その他 ▾</summary><div class="more-pop">' + more.join('') + '</div></details>' : '') + '</div>' +
    (st === 'check' ? '<div class="muted" style="margin-top:6px">取込の途中で止まっている可能性があります。SMILE で伝票を確認してから選んでください（この画面からの再取込はできません）。</div>' : '') + '</div>';
  const who = (r && (r.by || r.importBy || r.confirmedBy || r.reportedAt)) ? '<h3>操作した人</h3><dl>' + row('OK', EC.shortUser(r.by)) + row('取込を依頼', EC.shortUser(r.importBy)) + row('確認OK', EC.shortUser(r.confirmedBy)) + row('Teams報告', r.reportedAt ? stamp(r.reportedAt) : '') + '</dl>' : '';
  dr.insertAdjacentHTML('beforeend', who + '<h3>履歴（誰がいつ何をしたか）</h3><div id="histBox" class="muted">読み込み中…</div>' + actions);
  loadHistory(s.id);
  refreshEditErr();
}
// 要確認：SMILE の値とアプリの期待値を並べる
// ---- 注文の詳細：Shopify（左・青）と SMILE（右・緑）を並べる。違う項目は黄色で強調する
// SMILE に伝票があれば SMILE の実際の値（確認用ファイル ec_smile_index.json）。まだなければ「SMILE に入る予定の内容」
function smileActual(s) {
  const I = M.smileIdx; if (!I) return null;
  if (!I.byPo) {
    I.byPo = {}; I.byNouhin = {};
    I.juchu.forEach(x => { const po = String(EC.pick(x, ['客先注番'])).replace(/\D/g, ''); if (po) (I.byPo[po] = I.byPo[po] || []).push(x); });
    I.nouhin.forEach(x => { I.byNouhin[EC.pick(x, ['得意先コード']) + '|' + EC.pick(x, ['納品先コード'])] = x; });
  }
  const rows = (I.byPo[String(s.id).replace(/\D/g, '')] || []).filter(x => EC.pick(x, ['得意先コード']) === s.cust);
  if (!rows.length) return null;
  rows.sort((a, b) => (+EC.pick(a, ['行']) || 0) - (+EC.pick(b, ['行']) || 0));
  const dc = EC.pick(rows[0], ['納品先コード']);
  return { rows, nouhin: I.byNouhin[s.cust + '|' + dc] || null, deliveryCode: dc, juchuNo: EC.pick(rows[0], ['受注№', '受注No']) };
}
function ymdText(v) { const d = String(v || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 4) + '/' + d.slice(4, 6) + '/' + d.slice(6) : d.length === 6 ? '20' + d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4) : '（なし）'; }
// 注文の詳細：「見比べ」と「伝票イメージ」の切り替え（選んだほうは覚えておく。選んだことがなければ見比べ。納品先を直している間も見比べ）
let slipView = 'cmp'; // 開くたびに最初の画面へ（EC売上の5工程画面は確認サマリー、そのほかは見比べ。切り替えは開いている間だけ）
// ---- 直接編集：比較でも伝票イメージでも、値が出ている場所で直す。青の枠＝入力するとすぐ保存（社内メモ・出荷予定日）／黄色の枠＝「内容を確認する」で確認してから保存（納品先）。必須項目（納品先名・郵便番号・住所１）は空にできない
const ED_REQUIRED = ['name', 'zip', 'addr1'];
function memoCtl(s, st, r) {
  const can = !(st === 'exported' || st === 'smile' || st === 'excluded' || st === 'importing' || st === 'check');
  return '<div class="memo-out" title="SMILE の社内メモに、この内容で入ります"><b id="memoOut-' + s.id + '">' + esc(memoOf(s)) + '</b></div>' +
    '<input type="text" class="ed-live" data-memo="' + s.id + '" value="' + esc((r && r.memoNote) || '') + '" placeholder="書き足すメモ（例：ブルー入荷待ち／入金確認済）"' + (can ? '' : ' disabled') + ' style="width:100%">' +
    (can ? '<div class="sub">基本は「花岡EC」。続けて書き足せます。入力すると、すぐ保存されます</div>' : '');
}
function shipCtl(s, st, r, ship, brief) {
  if (!(st === 'new' || st === 'ok')) return esc(md(ship));
  return '<div class="ship-out' + (r && r.shipDate ? ' manual' : '') + '"><input type="date" class="dateinp ed-live' + (r && r.shipDate ? ' manual' : '') + '" data-ship="' + s.id + '" value="' + ship + '"> ' + (r && r.shipDate ? '<button class="btn sec sm" data-act="shipauto" data-id="' + s.id + '">自動の日付（' + md(s.autoShip) + '）に戻す</button> <span class="tag warn">手動で変更</span>' : '') +
    (brief ? '' : '<div class="sub">受注日付から ' + s.leadDays + ' 営業日。空にすると自動の日付に戻ります。変えると、すぐ保存され、SMILE の納期・出荷予定日として取り込まれます</div>') + '</div>';
}
function edInput(s, d, k) {
  const v = editDraft[k] == null ? '' : editDraft[k], changed = String(v) !== String(d.auto[k] == null ? '' : d.auto[k]);
  return '<input type="text" class="ed-draft' + (changed ? ' changed' : '') + '" data-ed="' + k + '" data-last="' + esc(v) + '" value="' + esc(v) + '" style="width:100%"' + (ED_REQUIRED.indexOf(k) >= 0 ? ' required placeholder="必須"' : '') + '>' +
    (changed ? '<div class="sub">元：' + esc(d.auto[k] || '（空）') + ' <button class="btn sec sm" data-act="edrev" data-id="' + s.id + '" data-k="' + k + '">この項目を元に戻す</button></div>' : '');
}
// 入力のたびに、必須の確認（赤い枠・メッセージ・「内容を確認する」を押せるか）
function refreshEditErr() {
  if (!editId || !editDraft) return;
  const s = slips.find(x => x.id === editId); if (!s) return;
  const d = EC.deliveryFromOrder(s.order, store.cfg), fe = EC.editFieldErrors(Object.assign({}, d.auto, editDraft));
  document.querySelectorAll('[data-ed]').forEach(el => el.classList.toggle('ed-bad', !!fe[el.dataset.ed]));
  const msg = document.getElementById('edMsg'); if (msg) msg.innerHTML = Object.keys(fe).map(k => '<div>' + esc(fe[k]) + '</div>').join('');
  document.querySelectorAll('[data-act="edreview"]').forEach(b => { b.disabled = Object.keys(fe).length > 0; });
}
function detailViewHtml(s, editBlock) {
  const FL = FLOW_UI(), view = slipView;
  const chip = (k, l) => '<span class="chip' + (view === k ? ' active' : '') + '" data-dview="' + k + '">' + l + '</span>';
  const tabs = '<div class="row" style="gap:0;margin:16px 0 8px">' + chip('cmp', FL ? 'Shopifyとの比較' : 'Shopify と SMILE の見比べ') + chip('image', FL ? 'SMILE伝票イメージ' : 'SMILE の伝票イメージ') + '</div>';
  // 直せる項目は、比較でも伝票イメージでも、値が出ている場所で直す（別の枠は出さない）。FLOW_UI でない画面だけ、従来の枠
  const grp = () => FL ? '' : '<div class="editgrp">' + editBlock + '</div>';
  return tabs + (view === 'image' ? slipImageHtml(s) + grp() : compareHtml(s) + grp());
}
// システムの判定結果（タブの上に小さく出す）：確認が必要なもの（△・✗）は常に、問題なしの項目は「✓ 問題なし n項目」にまとめる（開くと意味つきで見られる）
function judgeHtml(s) {
  const d = EC.deliveryFromOrder(s.order, store.cfg), m = M.nouhin && M.nouhin[s.cust], code = m && reuseCode(s, d);
  const j = EC.judgeSlip(s, { cfg: store.cfg, delivery: { code: code || '', name: d.name, isNew: !code }, shipLabel: md(shipOf(s)), state: stateOf(s) });
  const ico = { ok: '✓', warn: '△', err: '✗', info: '・' };
  const row = x => '<div class="jr jr-' + x.level + '"><span class="ji">' + ico[x.level] + '</span><div><b>' + esc(x.text) + '</b>' + (x.detail ? '<div class="jd">' + esc(x.detail) + '</div>' : '') + '</div></div>';
  const oks = j.items.filter(x => x.level === 'ok'), rest = j.items.filter(x => x.level !== 'ok');
  return '<div class="judge"><div class="jh">システムの判定結果' + (j.risky ? '<button class="btn sec sm" data-dview="image" style="margin-left:10px">SMILE伝票イメージを見る</button>' : '') + '</div>' + rest.map(row).join('') +
    (oks.length ? '<details class="jok"><summary><span class="ji" style="color:var(--green)">✓</span><b>問題なし ' + oks.length + '項目</b></summary>' + oks.map(row).join('') + '</details>' : '') + '</div>';
}
// 納品先マスタ（取込用）の枠：新規ならこの注文から作る登録内容、既存なら SMILE にすでにある登録内容（取込では変えない）、取込後は SMILE の実際の値
function nouhinBlockHtml(s, d, code, act, it, pend) {
  const P = EC.pick, E = esc, lim = (store.cfg.limits || {}), stNow = stateOf(s), editing = editId === s.id && stNow === 'new' && !act;
  if (editing) {   // 直接編集：この枠の項目が黄色の入力欄になる
    const iv = k => edInput(s, d, k);
    return '<div class="sl-box editing"><div class="sl-bt">納品先マスタ（この内容で取り込みます' + (code ? '。既存の納品先です' : '') + '）</div><div class="sl-hd c3">' + it('納品先コード', code ? E(code) : pend('取込時に決定')) + it('納品先名 *', iv('name')) + it('荷受け人名１', iv('person')) +
      it('配達員向けメモ', iv('memo')) + it('郵便番号 *', iv('zip')) + it('電話番号', iv('tel')) + '</div><div class="sl-hd c2">' + it('住所１ *', iv('addr1')) + it('住所２', iv('addr2')) + '</div>' + deliveryBarHtml(s, d, act, 'new', true) + '</div>';
  }
  let title, v, hint = '';
  if (act && act.nouhin) {
    const n = act.nouhin; title = '納品先マスタ（SMILEの実際の値）';
    v = { code: act.deliveryCode, name: P(n, ['納品先名']), p1: P(n, ['荷受け人名１']), p2: P(n, ['荷受け人名２']), zip: P(n, ['郵便番号']), a1: P(n, ['住所１']), a2: P(n, ['住所２']), tel: P(n, ['電話番号']) };
  } else if (code) {
    const I = M.smileIdx, n = I && I.byNouhin && I.byNouhin[s.cust + '|' + code];
    title = '納品先マスタ（既存の納品先。SMILEの登録内容は、取込では変わりません）';
    v = n ? { code, name: P(n, ['納品先名']), p1: P(n, ['荷受け人名１']), p2: P(n, ['荷受け人名２']), zip: P(n, ['郵便番号']), a1: P(n, ['住所１']), a2: P(n, ['住所２']), tel: P(n, ['電話番号']) } : { code, name: d.name, p1: '', p2: '', zip: d.zip, a1: d.addr1, a2: d.addr2, tel: d.tel };
    if (d.memo) hint = '<div class="alert warn" style="margin-top:4px">配達員向けメモは、既存の納品先には入りません（納品先マスタの取込は新規だけ）。SMILE の荷受け人名１に直接入れてください</div>';
  } else {
    title = '納品先マスタ（新規。取込で SMILE に登録します）';
    v = { code: '', name: EC.cutBytes(d.name, lim.name), p1: EC.cutBytes([d.person, d.memo].filter(Boolean).join(' '), lim.name), p2: '', zip: d.zip, a1: EC.cutBytes(d.addr1, lim.addr1), a2: EC.cutBytes(d.addr2, lim.addr2), tel: d.tel };
  }
  const val = x => x ? E(x) : '<span class="muted">なし</span>';
  return '<div class="sl-box"><div class="sl-bt">' + title + '</div><div class="sl-hd c3">' +
    it('納品先コード', v.code ? E(v.code) : pend('取込時に決定'), v.code ? '' : ' ') + it('納品先名', val(v.name)) + it('荷受け人名１', val(v.p1)) +
    it('荷受け人名２', val(v.p2)) + it('郵便番号', val(v.zip)) + it('電話番号', val(v.tel)) + '</div><div class="sl-hd c2">' + it('住所１', val(v.a1)) + it('住所２', val(v.a2)) + '</div>' + hint + (stNow === 'new' && !act ? deliveryBarHtml(s, d, act, stNow, false) : '') + '</div>';
}
function slipImageHtml(s) {
  const d = EC.deliveryFromOrder(s.order, store.cfg), m = M.nouhin && M.nouhin[s.cust], code = m && reuseCode(s, d), act = smileActual(s);
  const sl = Object.assign({}, s, { memo: memoOf(s), slipDate: slipOf(s) });
  const opt = { cfg: store.cfg, items: M.items, cal, biko: PROFILE.biko ? PROFILE.biko(CONF) : '', shipDate: shipOf(s), delivery: { code: code || '', name: d.name, isNew: !code } };
  const img = EC.slipImage(sl, Object.assign({ act }, opt));
  const plan = act ? EC.slipImage(sl, opt) : null;   // 取込後は、アプリが作るはずだった内容と違う項目を黄色にする
  const E = esc, H = img.head, PH = plan && plan.head, st0 = stateOf(s), r0 = rec(s), ship0 = shipOf(s);
  const df = (a, b) => plan && String(a) !== String(b) ? ' diff' : '';
  const pend = t => '<span class="sl-p">' + E(t) + '</span>';
  const cn = x => (x.code ? E(x.code) : '') + (x.name ? ' ' + E(x.name) : '');
  const it = (k, v, cls) => '<div class="sl-i"><span class="sl-k">' + k + '</span><span class="sl-vv' + (cls || '') + '">' + v + '</span></div>';
  const IMPD = isImported(st0);   // 起票後（③④）
  if (IMPD && !act && r0 && r0.juchuNo) H.juchuNo = { value: r0.juchuNo };   // 確認用データに無くても、記録の受注№を出す
  const banner = act ? '<div class="sl-banner actual">SMILE　受注№ ' + E(H.juchuNo.value || '') + ' の伝票' + (M.indexInfo ? '（' + stamp(M.indexInfo.generatedAt) + ' 時点）' : '') + (IMPD ? '' : '　<span style="font-weight:400">黄色＝取込前にアプリが作る予定だった内容と違う項目</span>') + '</div>'
    : IMPD ? '<div class="sl-banner actual">SMILE に起票した内容' + (r0 && r0.juchuNo ? '　受注№ ' + E(r0.juchuNo) : '') + '</div>'
    : '<div class="sl-banner">取込後はこうなります（予定）　<span style="font-weight:400">いまアプリが作る取込内容のとおりです</span></div>';
  let h = '<div class="sl">' + banner +
    '<div class="sl-hd c4">' + it('受注No', H.juchuNo.pending ? pend(H.juchuNo.text) : E(H.juchuNo.value || '（不明）')) + it('受注日', act ? E(H.orderDate) : slipCtl(s, st0, r0, H.orderDate), df(H.orderDate, PH && PH.orderDate)) + it('税率', E(H.taxRate)) + it('受注区分', E(H.juchuKubun)) + '</div>' +
    '<div class="sl-hd c3">' + it('得意先', cn(H.customer), df(H.customer.code, PH && PH.customer.code)) + it('取引', E(H.torihiki)) + it('担当者', cn(H.staff)) + '</div>' +
    '<div class="sl-hd c3">' + it('部門', cn(H.dept)) + it('倉庫', cn(H.warehouse)) + '<div></div></div>' +
    '<div class="sl-hd c2">' + it('納品先', H.delivery.pending ? pend(H.delivery.text) + (H.delivery.name ? '　' + E(H.delivery.name) : '') : cn(H.delivery)) + it('客先注番', E(H.po), df(H.po, PH && PH.po)) + '</div>' +
    '<div class="sl-hd c3">' + it('受注納期', E(H.nouki), df(H.nouki, PH && PH.nouki)) + it('出荷予定日', act ? E(H.shipDate) : shipCtl(s, st0, r0, ship0, true), df(H.shipDate, PH && PH.shipDate)) + it('製造納期', E(H.mfgDate || '')) + '</div>';
  const col = [30, 96, 0, 98, 150, 52, 34, 78, 74, 86];
  h += '<div class="sl-tw"><table class="sl-t"><colgroup>' + col.map(w => '<col' + (w ? ' style="width:' + w + 'px"' : '') + '>').join('') + '</colgroup><thead><tr><th class="n">行</th><th>品目コード</th><th>品目名</th><th>手配区分</th><th>製番</th><th class="n">数量</th><th>単位</th><th class="n">単価(税抜)</th><th class="n">金額(税抜)</th><th>出荷予定日</th></tr></thead><tbody>';
  img.lines.forEach((l, i) => {
    const pl = plan && plan.lines[i], c = (a, b) => (pl ? df(a, b) : plan ? ' diff' : '');
    const sb = l.seiban.pending ? pend(IMPD ? '確認用データの更新待ち' : l.seiban.text) : l.seiban.missing ? pend('（データなし）') : E(l.seiban.value);
    const sub = [
      '倉庫 ' + E(l.warehouse), l.nouki ? '受注納期 ' + E(l.nouki) : '', '製造数量 ' + E(l.mfgQty), l.mfgDate ? '製造納期 ' + E(l.mfgDate) : '', '客先注番 ' + E(l.po), l.memo ? '摘要 ' + E(l.memo) : '',
      act ? '' : '完納・出荷済数量 ' + pend('0.00'), l.genUnit ? (l.genUnit.master ? '原単価（マスタ） ' + pend(l.genUnit.value) : '原単価 ' + E(l.genUnit.value)) + (l.genAmount ? '・原価金額 ' + (l.genUnit.master ? pend(l.genAmount) : E(l.genAmount)) : '') : ''
    ].filter(Boolean).join('・');
    h += '<tr><td class="n">' + l.no + '</td><td class="' + c(l.code, pl && pl.code).trim() + '">' + E(l.code) + '</td><td>' + E(l.name) + '</td><td>' + E(l.teihai.code) + (l.teihai.label ? ':' + E(l.teihai.label) : '') + '</td><td>' + sb + '</td>' +
      '<td class="n' + c(l.qty, pl && pl.qty) + '">' + E(l.qty) + '</td><td>' + E(l.unit) + '</td><td class="n' + c(l.price, pl && pl.price) + '">' + E(l.price) + '</td><td class="n' + c(l.amount, pl && pl.amount) + '">' + E(l.amount) + '</td><td class="' + c(l.shipDate, pl && pl.shipDate).trim() + '">' + E(l.shipDate) + '</td></tr>' +
      '<tr class="sub"><td></td><td colspan="9">' + sub + '</td></tr>';
  });
  h += '</tbody></table></div>';
  if (plan && plan.lines.length !== img.lines.length) h += '<div class="alert warn" style="margin-top:6px">明細の行数が違います（アプリの予定 ' + plan.lines.length + '行／SMILE ' + img.lines.length + '行）</div>';
  h += '<div class="sl-sum">受注数量合計 <b' + (plan && plan.total.qty !== img.total.qty ? ' class="sl-vv diff"' : '') + '>' + E(img.total.qty) + '</b>合計金額（税抜） <b' + (plan && plan.total.amount !== img.total.amount ? ' class="sl-vv diff"' : '') + '>' + E(img.total.amount) + '</b></div>' +
    '<div class="sl-hd c1" style="margin-top:4px">' + it('備考', E(img.biko || '')) + (act ? (img.memo ? it('社内メモ', E(img.memo)) : '') : it('社内メモ', memoCtl(s, st0, r0))) + '</div>' +
    // 拡張項目（SMILE の「受注伝票拡張項目」の画面）：運送業者・配送指定日など。取込後に、お客様の希望日が入っている注文などが分かる
    '<div class="sl-boxes">' + nouhinBlockHtml(s, d, code, act, it, pend) +
    '<div class="sl-box"><div class="sl-bt">拡張項目（受注伝票）</div><div class="sl-hd c3">' +
    it('運送業者', img.ext.carrier.missing ? pend('（この確認用データにはありません）') : E(img.ext.carrier.label || '（不明）'), df(img.ext.carrier.code, plan && plan.ext.carrier.code)) +
    it('配送指定日', img.ext.deliveryDate ? E(img.ext.deliveryDate) : '<span class="muted">指定なし</span>', df(img.ext.deliveryDate, plan && plan.ext.deliveryDate)) +
    it('配達指定', img.ext.deliveryKubun.label ? E(img.ext.deliveryKubun.label) : '<span class="muted">なし</span>', df(img.ext.deliveryKubun.code, plan && plan.ext.deliveryKubun.code)) + it('営業所止め', img.ext.officeName ? E(img.ext.officeName) : '<span class="muted">なし</span>') + (img.ext.tonami.code ? it('トナミ指定', E(img.ext.tonami.label)) : '') + (img.ext.daiichiMust ? it('必着指定（第一貨物）', E(img.ext.daiichiMust)) : '') + (img.ext.daiichiTime ? it('時間区分（第一貨物）', E(img.ext.daiichiTime)) : '') + (img.ext.tonamiShipper.code ? it('トナミ荷送人', E(img.ext.tonamiShipper.code + (img.ext.tonamiShipper.name ? ' ' + img.ext.tonamiShipper.name : ''))) : '') + '</div></div></div>' +
    (act || IMPD ? '' : '<div class="muted" style="margin-top:8px;font-size:12px">薄い斜体の項目は、取込時に SMILE が付けます。手配区分が 1:繰返(製作) の行には製番が付きます</div>') + '</div>';
  return h;
}
function compareHtml(s) {
  const o = s.order, d = EC.deliveryFromOrder(o, store.cfg), act = smileActual(s), P = EC.pick, E = esc, stNow = stateOf(s), editing = editId === s.id && stNow === 'new' && !act;
  const nz = v => String(v == null ? '' : v).normalize('NFKC').replace(/[\s　]/g, ''), dg = v => String(v == null ? '' : v).replace(/\D/g, '');
  const nm = v => nz(v).replace(/(様|殿|御中)$/, '');   // 取込では末尾に「様」などが付くので、同じ名前なら違いとしない
  const tel = v => { const t = String(v || '').trim(), x = dg(t); return t.startsWith('+81') ? '0' + x.slice(2) : x; };   // Shopify の電話は +81… の形で来ることがある
  const sh = o.ship, shopAddr = [sh.province, sh.city, sh.addr1, sh.addr2].filter(Boolean).join('');
  let A;   // SMILE 側の値
  if (act && act.nouhin) {
    const n = act.nouhin;
    A = { name: P(n, ['納品先名']), person: P(n, ['荷受け人名１']), zip: P(n, ['郵便番号']), addr: P(n, ['住所１']) + P(n, ['住所２']), addr1: P(n, ['住所１']), addr2: P(n, ['住所２']), tel: P(n, ['電話番号']), code: act.deliveryCode };
  } else {
    A = { name: d.name, person: d.person, memo: d.memo, zip: d.zip, addr: (d.addr1 || '') + (d.addr2 || ''), addr1: d.addr1, addr2: d.addr2, tel: d.tel, code: '' };
  }
  const FLc = FLOW_UI(), convs = [];   // convs＝正常な自動変換（違う項目とは言わない）
  const IMP = FLc && isImported(stNow);   // 起票後（③④）：予定・凡例・自動変換のメモは出さない
  const showConv = FLc && !IMP;
  const row = (label, a, b, diff, sub, conv) => { const isConv = !!conv && !diff; if (isConv) convs.push(conv); const dc = diff ? (FLc ? ' bad' : ' diff') : ''; return '<tr><th>' + label + '</th><td class="shop' + dc + '">' + a + '</td><td class="smile' + dc + (isConv && showConv ? ' conv' : '') + '">' + b + (sub ? '<div class="sub">' + sub + '</div>' : '') + (isConv && showConv ? '<div class="sub conv-t">自動変換：' + conv + '</div>' : '') + '</td></tr>'; };
  const smileHd = act ? (IMP ? 'SMILE　受注№ ' + E(act.juchuNo) + ' の伝票' : 'SMILE') : IMP ? 'SMILE（起票した内容）' : 'SMILE（予定）';
  let h = (IMP ? '' : '<h3>Shopify と SMILE の見比べ</h3><div class="legend"><b style="background:#3b6fd4;color:#fff">Shopify の注文</b> ／ <b style="background:#2e8b57;color:#fff">' +
    (act ? 'SMILE の実際の値' + (M.indexInfo ? '（' + stamp(M.indexInfo.generatedAt) + ' 時点）' : '') : 'SMILE に入る予定の内容') + '</b> ／ ' + (FLc ? '<b class="lg-conv">自動変換（正常）</b> ／ <b class="lg-bad">確認が必要な不一致</b>' : '<b style="background:#fff1c2;outline:2px solid #e0a800">違う項目</b>') + '</div>') + '<!--CMPSUM-->' +
    '<table class="cmp"><thead><tr><th></th><th class="hd shop">Shopify</th><th class="hd smile">' + smileHd + '</th></tr></thead><tbody>';
  const edTag = k => d.edited.indexOf(k) >= 0 && !act ? '<div class="sub" style="color:#a8620a">手動で直した値（元：' + E(d.auto[k] || '（空）') + '）</div>' : '';
  if (editing) {
    const inp = k => edInput(s, d, k);
    h += row('納品先名', E(sh.company || sh.name), inp('name'), false);
    h += row('荷受け人', E(sh.company ? sh.name : ''), inp('person'), false);
    h += row('配達員向けメモ', '', inp('memo') + '<div class="sub">SMILE の荷受け人名１に入ります（例：午前中配達希望／14-16時配達希望）。配達員の目に留まるためのメモで、納品先の同じ・違うの判定には使いません。<b>新規の納品先にだけ入ります</b></div>', false);
    h += row('郵便番号', E(sh.zip), inp('zip') + '<div class="sub"><button class="btn sec sm" data-act="edzip" data-id="' + s.id + '">郵便番号から住所を確認</button> <span id="zipHint"></span></div>', false);
    h += row('住所１', E(shopAddr), inp('addr1'), false);
    h += row('住所２', '', inp('addr2'), false);
    h += row('電話', E(sh.phone), inp('tel'), false);
  } else {
  const rawNm = sh.company || sh.name;
  h += row('納品先名', E(rawNm), E(A.name) + edTag('name'), nm(rawNm) !== nm(A.name), '', String(rawNm) !== String(A.name) ? '納品先名に「様」などを付加' : '');
  h += row('荷受け人', E(sh.company ? sh.name : ''), E(A.person) + edTag('person'), !!(sh.company && nm(sh.name) !== nm(A.person)), '', sh.company && String(sh.name) !== String(A.person) ? '荷受け人に「様」を付加' : '');
  if (A.memo) h += row('配達員向けメモ', '', E(A.memo) + edTag('memo'), false, '荷受け人名１に入ります');
  h += row('郵便番号', E(sh.zip), E(A.zip) + edTag('zip'), dg(sh.zip) !== dg(A.zip), '', String(sh.zip) !== String(A.zip) ? '郵便番号の形を整える' : '');
  h += row('住所', E(shopAddr), E(A.addr1) + (A.addr2 ? '<br>' + E(A.addr2) : '') + edTag('addr1') + edTag('addr2'), nz(shopAddr) !== nz(A.addr), '', String(shopAddr) !== String(A.addr) ? '住所を整える（全角・半角・文字の置き換え）' : '');
  h += row('電話', E(sh.phone), E(A.tel) + edTag('tel'), tel(sh.phone) !== tel(A.tel), '', String(sh.phone) !== String(A.tel) ? '電話番号を国内形式に変換' : '');
  }
  if (A.code) h += row('納品先コード', '', E(A.code), false);
  {   // 受注伝票のほうの項目（Shopify には無いものは、SMILE 側だけ）
    const po = String(s.id).replace(/\D/g, '');   // 得意先・担当・部門・倉庫は Shopify に対応する値が無いので、比較には出さない（伝票イメージにある）
    const ext = EC.slipImage(Object.assign({}, s, { memo: memoOf(s) }), { cfg: store.cfg, items: M.items, cal, shipDate: shipOf(s), act, delivery: { code: A.code || '', name: A.name } }).ext;
    h += row('客先注番', E(s.name), E(act ? P(act.rows[0], ['客先注番']) : po), false, '', String(s.name) !== po ? '注文番号の数字だけを入れる' : '');
    h += row('運送・配送指定', E([o.shippingMethod ? '配送方法：' + o.shippingMethod : '', o.notes ? 'お客様メモ：' + o.notes : ''].filter(Boolean).join('／')), E([ext.carrier.missing ? '運送業者：（この確認用データにはありません）' : '運送業者：' + (ext.carrier.label || '—'), '配送指定日：' + (ext.deliveryDate || '指定なし'), '配達指定：' + (ext.deliveryKubun.label || 'なし'), ext.officeName ? '営業所止め：' + ext.officeName : ''].filter(Boolean).join('／')), false, act ? '' : '運送業者は、設定の値で取り込みます。お客様の希望日は入れません');
  }
  // 商品：Shopify の行 ↔ SMILE の行（同じ順に並べる。商品名は対応表で品目に変わるので、違いは強調しない）
  const sl = o.lines, ml = act ? act.rows.map(x => ({ code: P(x, ['品目コード']), name: P(x, ['品目名', '品名']), qty: +P(x, ['数量']) || 0, amt: Math.round(+P(x, ['金額']) || 0) })) : s.lines.map(l => ({ code: l.code, name: l.name, qty: l.qty, amt: Math.round(l.amountNet) }));
  for (let i = 0; i < Math.max(sl.length, ml.length); i++) {
    const a = sl[i], b = ml[i];
    const isShip = b && CONF.config && b.code === CONF.config.shipItem && !sl[i];
    h += row(i ? '' : '商品', a ? E(a.name) + '<div class="sub">×' + a.qty + '（' + yen(a.price) + '）</div>' : '', b ? E(b.code) + (b.name ? ' ' + E(b.name) : '') + '<div class="sub">×' + b.qty + '（税抜 ' + yen(b.amt) + '）</div>' : '', false, '', b ? (isShip ? '送料を' + b.code + 'として明細化' : '商品名をSMILE品目コードへ変換') : '');
  }
  const smileNet = ml.reduce((a, x) => a + x.amt, 0), smileGross = Math.round(smileNet * 1.1);
  h += row('金額（税込）', yen(o.total) + '<div class="sub">送料 ' + yen(o.shipping || 0) + (o.discountCode ? '／割引 ' + E(o.discountCode) : '') + '</div>', yen(smileGross) + '<div class="sub">税抜合計 ' + yen(smileNet) + ' の1.1倍</div>', Math.abs(smileGross - o.total) > 2);
  h += row('日付', E(s.orderDate + ' ' + o.createdTime + ' 受注'), act ? E(ymdText(P(act.rows[0], ['受注日付'])) + ' 受注日／' + ymdText(P(act.rows[0], ['納期'])) + ' 納期／' + ymdText(P(act.rows[0], ['出荷予定日'])) + ' 出荷予定') : (stNow === 'new' || stNow === 'ok' ? '受注日（SMILE） ' + slipCtl(s, stNow, rec(s), md(slipOf(s)), true) + '出荷予定日 ' + shipCtl(s, stNow, rec(s), shipOf(s)) : E(md(slipOf(s)) + ' 受注日／' + md(shipOf(s)) + ' 出荷予定（受注日付から ' + s.leadDays + ' 営業日）')), false);
  h += row('メモ', E(o.notes || ''), act ? E(P(act.rows[0], ['社内メモ'])) : '社内メモ（取込予定）' + memoCtl(s, stNow, rec(s)), false);
  h += row('支払', E(o.paymentMethod + '／' + o.financial), act ? '受注№ ' + E(act.juchuNo) : '', false);
  h += '</tbody></table>';
  const badN = (h.match(/td class="shop bad"/g) || []).length;
  if (FLc && !(IMP && !badN)) {   // 起票後は、本当の不一致があるときだけ、先頭に出す
    const bad = badN, uniq = [...new Set(convs)];
    h = h.replace('<!--CMPSUM-->', '<div class="cmpsum ' + (bad ? 'bad' : 'ok') + '">' + (bad ? '<b>✗ 確認が必要な不一致：' + bad + '件</b>（赤い項目）' : '<b>✓ 問題は見つかりませんでした</b>') +
      '<span class="muted">　自動変換された項目：' + uniq.length + '件</span>' + (uniq.length ? '<details style="margin-top:4px"><summary>変換の内容を見る</summary><ul style="margin:4px 0 0 18px;padding:0">' + uniq.map(x => '<li>' + E(x) + '</li>').join('') + '</ul></details>' : '') + '</div>');
  } else h = h.replace('<!--CMPSUM-->', '');
  h += deliveryBarHtml(s, d, act, stNow, editing);
  return h;
}
// 納品先を直す操作（比較の下と、伝票イメージの納品先の枠で共通）
function deliveryBarHtml(s, d, act, stNow, editing) {
  const E = esc; let h = '';
  if (editing) h += '<div id="edMsg" class="ed-msg"></div><div class="muted" style="font-size:11px">黄色の枠＝「内容を確認する」で確認してから保存します（* は必須）。青の枠（社内メモ・出荷予定日）は、入力するとすぐ保存されます</div>';
  if (stNow === 'new' && !act) {
    if (editing) h += '<div class="row" style="margin:8px 0"><button class="btn" data-act="edreview" data-id="' + s.id + '">内容を確認する</button><button class="btn sec" data-act="edcancel" data-id="' + s.id + '">やめる（保存しない）</button><span class="muted">まだ保存されません。次の画面で確認してから保存します</span></div>';
    else h += '<div class="row" style="margin:8px 0"><button class="btn sec" data-act="edstart" data-id="' + s.id + '">納品先を直す</button>' +
      (d.edited.length ? '<button class="btn sec" data-act="edrevall" data-id="' + s.id + '">すべて Shopify の値に戻す</button><span class="muted">' + d.edited.length + '項目を手動で直しています（' + E(EDITS[orderNo(s.id)] ? EC.shortUser(EDITS[orderNo(s.id)].updatedBy) : '') + '）</span>' : '') + '</div>';
  } else if (stNow === 'ok' && (d.edited.length || true)) h += '<div class="muted" style="margin:6px 0">納品先を直すには、先に「戻す」で未確認に戻してください（OK した内容と食い違わないように）。' + (d.edited.length ? '手動で直した項目があります。' : '') + '</div>';
  return h;
}
function checkHtml(r, st) {
  if (!r || st !== 'check') return '';
  const d = r.diffs || [];
  return '<h3>要確認（SMILE と期待値が違います）</h3>' + (r.checkMessage ? '<div class="alert err">' + esc(r.checkMessage) + '</div>' : '') +
    (d.length ? '<table><thead><tr><th>項目</th><th>アプリの期待値</th><th>SMILE の値</th></tr></thead><tbody>' + d.map(x => '<tr><td>' + esc(x.label) + '</td><td>' + esc(x.expected) + '</td><td class="bad">' + esc(x.actual) + '</td></tr>').join('') + '</tbody></table>' : '');
}

/* ------------------------------------------------------------ 出力（納品先 → 受注伝票） */
function okSlips() { return slips.filter(s => stateOf(s) === 'ok'); }
// 新しい納品先のコードは、アプリではなく専用機が取込の直前に決める。取込ファイルの中では、新規の納品先にだけ仮の番号（N00001…）を使う（mode: real なら本当のコード）
// 仮の番号を使うかは、専用機の稼働の印（heartbeat.json の features に tempDeliveryCodes）で決める（mode: auto。EC.deliveryCodeMode）。
// 専用機が対応していないうちは、今までどおりアプリが本当のコードを決める（仮の番号が SMILE にそのまま入らないように）
let codeDecision = { mode: 'real', blocked: '', reason: 'アプリが番号を決めます' }, lastHealth = null;
function tempCfg() { const t = (CONF.rpaImport || {}).tempCodes; return t && codeDecision.mode === 'temp' && !codeDecision.blocked ? t : null; }
async function refreshCodeMode() {
  const t = (CONF.rpaImport || {}).tempCodes;
  try { await rpaReady(); lastHealth = await RpaQueue.health(); } catch (e) { lastHealth = null; }
  codeDecision = EC.deliveryCodeMode(t, lastHealth);
  if (typeof renderOutbarIfOrders === 'function' && store) renderOutbarIfOrders();
  return codeDecision;
}
// forceReal＝専用機を使わない手動の取込ファイル（「⋯」メニュー）。仮の番号は専用機が置き換えるものなので、手動の取込には使わず本当のコードを決める
function planOut(forceReal) {
  const ok = okSlips(); ok.forEach(s => { s.shipDate = shipOf(s); s.slipDate = slipOf(s); s.memo = memoOf(s); });
  if (!ok.length) return { ok, fresh: [], master: M.nouhin || null };   // OK済が無いときは、納品先マスタ全体の複製（重い）は要らない
  const master = M.nouhin ? JSON.parse(JSON.stringify(M.nouhin)) : null;
  if (!master) return { ok, fresh: [], master: null };
  const fresh = EC.planDeliveries(ok, master, store.cfg, { reuse: store.cfg.deliveryReuse !== false, temp: forceReal ? null : tempCfg() });
  return { ok, fresh, master };
}
function renderOutbar() {
  const bar = $('outbar');
  if (curTab === 'pay') { bar.hidden = true; return; }
  const ok = okSlips();
  if (!ok.length && !(isAdmin && CONF && CONF.testImport)) { bar.hidden = true; return; }
  bar.hidden = false;
  // 取込は管理者と取込担当者だけ（見た目の制限。専用機側でも同じ一覧で照合する）
  if (!canImport()) { bar.innerHTML = '<div><b>OK済 ' + ok.length + '件</b> <span class="muted">（取込は取込担当者が行います）</span></div>'; return; }
  const staleBlock = isIndexStale() && !isAdmin;   // SMILEのデータが古いと二重取込の確認が当てにならない。管理者だけは、確認のうえ続けられる
  const p = planOut(), lines = ok.reduce((a, s) => a + s.lines.length, 0), bad = ok.filter(s => s.hasErr).length;
  bar.innerHTML = '<div><b>OK済 ' + ok.length + '件</b> <span class="muted">納品先の新規 ' + p.fresh.length + '件・受注 ' + lines + '行</span><div class="muted" style="font-size:11px' + (codeDecision.blocked ? ';color:var(--red)' : '') + '">新規の納品先：' + esc(codeDecision.blocked || codeDecision.reason) + '</div></div><div class="grow"></div>' +
    (!M.nouhin || !M.items ? '<span class="tag err">品目マスタ・納品先マスタを読めていません</span>' : '') + (bad ? '<span class="tag err">赤い確認事項のある注文が ' + bad + '件</span>' : '') +
    (isIndexStale() ? '<span class="tag err">SMILEのデータが古いため、先に「SMILEの最新を取り込む」を押してください' + (isAdmin ? '（管理者は、確認のうえ続けられます）' : '') + '</span>' : '') +
    '<button class="btn" id="o-import"' + (!ok.length || bad || !M.nouhin || !M.items || importBusy || staleBlock ? ' disabled' : '') + '>SMILEに取り込む</button>' +
    (isAdmin ? '<span class="morewrap"><button class="hbtn" id="o-more" title="予備の操作（専用機が使えないとき）" aria-label="予備の操作">⋯</button>' +
    '<div id="moreMenu"' + (moreOpen ? '' : ' hidden') + '><div class="muted">専用機が使えないときだけ。ファイルを保存して、手で SMILE に取り込みます。</div>' +
    '<button class="btn sec sm" id="o-dest"' + (bad || !M.nouhin || !p.fresh.length ? ' disabled' : '') + '>納品先ファイルを保存（新規 ' + p.fresh.length + '件）</button>' +
    '<button class="btn sec sm" id="o-juchu"' + (bad || !M.nouhin || !M.items ? ' disabled' : '') + '>受注伝票ファイルを保存（' + ok.length + '伝票）</button>' +
    '<button class="btn sec sm" id="o-done"' + (ok.length ? '' : ' disabled') + ' title="手で SMILE に取り込んだら押してください">手で取り込んだので「起票済み」にする</button>' +
    (shared ? '<button class="btn sec sm" id="o-migrate" title="この端末のブラウザにだけある記録のうち、共有の履歴（リスト）に無い注文を、リストに追加します（何度押しても安全）">この端末の記録をリストに移す</button>' : '') +
    (CONF.testImport ? '<hr style="border:none;border-top:1px solid var(--line);width:100%;margin:2px 0"><div class="muted">専用機の試運転用。EC売上の東京（' + esc(CONF.testImport.customerCode) + '）に、テスト用の注文1件（客先注番 ' + esc(CONF.testImport.poPrefix) + '…）と新しい納品先（' + (CONF.testImport.codeMode === 'fixed' || !tempCfg() ? esc(CONF.testImport.deliveryCode) : '取込の直前に専用機が番号を決めます') + '）を登録します。終わったら SMILE で削除してください（入っている間は東京の売上・日報に載ります）。</div>' +
      '<button class="btn sec sm" id="o-test"' + (importBusy ? ' disabled' : '') + '>テスト送信（仮データ1件）</button>' : '') + '</div></span>' : '');
}
let moreOpen = false, importBusy = false;
function stampName() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); }
function outDest() {
  const p = planOut(true); if (!p.fresh.length) return;
  const rows = EC.nouhinRows(p.fresh, LAY.nouhin, store.cfg);
  download('納品先マスタ_取込_EC_' + stampName() + '.txt', EC.encodeUtf16(EC.toSmileText(LAY.nouhin, rows)));
}
function outJuchu() {
  const p = planOut(true);
  const rows = JUCHU_ROWS(p.ok, LAY.juchu, store.cfg, cal);
  download('受注明細_取込_EC_' + stampName() + '.txt', EC.encodeUtf16(EC.toSmileText(LAY.juchu, rows)));
}
async function markExported() {
  const ok = okSlips(); if (!ok.length) return;
  if (!confirm(ok.length + '件を「起票済み」にします。SMILE への取り込みは終わっていますか？')) return;
  const at = new Date().toISOString(), who = account && account.username;
  await commit({ ids: ok.map(s => s.id), expect: () => ['OK済'], action: '確認OK', detail: () => '手で SMILE に取り込んだので起票済みにした',
    mutate: id => { const r = store.orders[id]; if (!r) return false; r.status = 'exported'; r.exportedAt = at; r.exportedBy = who; r.confirmedBy = who; r.confirmedAt = at; return true; } });
}

/* ------------------------------------------------------------ 共有の履歴（SharePoint のリスト EC_Order・EC_Log）
   注文の状態・OK・取込・確認OK・受注№・出荷予定日の手動変更・社内メモ追記・報告の印を、各自のブラウザではなくリストに持つ。リストが正で、
   localStorage（store）は、リストが読めないときのキャッシュ。読み書きは ec_sales_shared.js、変換・差分・復元は ec_sales_core.js。
   リストに接続できない（権限なし・403・ネットワーク）ときは、今までどおり localStorage だけで動き続け、画面上部に出す。
   復旧したら、この端末にだけある更新をリストに反映するか尋ねる（勝手に上書きしない）。
   お客様の名前・住所・電話はリストに書かない。 */
let shared = null, sharedState = 'off', sharedRows = {}, syncingShared = false, pushChain = Promise.resolve();
const histCache = {};
function sharedPending() { return (store.pending = store.pending || {}); }
function sharedPendingLogs() { return (store.pendingLogs = store.pendingLogs || []); }
function sharedInit() {
  const L = CONF.sharepoint && CONF.sharepoint.lists;
  if (!L || !L.sitePath || !window.EcShared) { shared = null; sharedState = 'off'; return; }
  shared = EcShared.create({ getToken: () => getToken(), sitePath: L.sitePath, orderList: L.order, logList: L.log });
  sharedState = 'init';
}
function renderSharedBanner() {
  const el = $('sharedBanner'); if (!el) return;
  const n = Object.keys(sharedPending()).length;
  el.hidden = sharedState !== 'offline';
  el.textContent = sharedState === 'offline' ? '共有の履歴に接続できません（この端末にだけ保存しています）' + (n ? '。リストに未反映の注文が ' + n + '件あります' : '') : '';
}
function sharedOffline(e) {
  console.warn('共有の履歴に接続できません', e);
  if (shared && shared.isUnavailable(e)) { sharedState = 'offline'; renderSharedBanner(); }
}
const sharedOnline = () => !!shared && sharedState === 'ok';

// リストの内容で、この端末の記録を置き換える（リストが正）。まだ書けていない注文（pending）は上書きしない
async function syncFromList(o) {
  o = o || {};
  if (!shared || syncingShared) return false;
  syncingShared = true;
  try {
    let rows;
    if (o.first && EARLY_ROWS) { const p = EARLY_ROWS; EARLY_ROWS = null; rows = await p; }   // 画面を開いたときに先に読み始めたもの
    else { if (!shared.siteId) await shared.connect(); rows = await shared.loadAll(); }
    const wasOffline = sharedState === 'offline';
    const m = EC.mergeFromList(store.orders, rows, sharedPending());
    store.orders = m.orders; sharedRows = rows; sharedState = 'ok'; save();
    renderSharedBanner();
    if (Object.keys(sharedPending()).length && (wasOffline || o.first)) await offerPushLocal();
    if (!o.noRender) { recompute(); render(); }
    return true;
  } catch (e) {
    sharedOffline(e);
    if (!o.quiet && !(shared && shared.isUnavailable(e))) console.warn('共有の履歴の読み込みに失敗', e);
    return false;
  } finally { syncingShared = false; }
}
// 復旧したとき：この端末にだけある更新を、リストに反映するか尋ねる
async function offerPushLocal() {
  const ids = Object.keys(sharedPending()), logs = sharedPendingLogs().length;
  if (!ids.length && !logs) return;
  if (confirm('この端末にだけある更新が ' + ids.length + '件の注文にあります（共有の履歴にまだ反映されていません）。\n共有の履歴に反映しますか？\n\n［OK］反映する（この端末の内容でリストを更新します）\n［キャンセル］反映しない（共有の履歴の内容で、この端末の記録を置き換えます）')) {
    for (const id of ids) await pushOrder(id, null, null, true);
    await flushLogs();
  } else {
    store.pending = {}; store.pendingLogs = [];
    const m = EC.mergeFromList(store.orders, sharedRows, {}); store.orders = m.orders;
  }
  save(); renderSharedBanner();
}
async function flushLogs() {
  const logs = sharedPendingLogs().splice(0);
  for (let i = 0; i < logs.length; i++) {
    try { await shared.appendLog(logs[i]); } catch (e) { sharedPendingLogs().push(...logs.slice(i)); sharedOffline(e); break; }
  }
}
function queueLog(row) {
  if (sharedOnline()) { pushChain = pushChain.then(() => shared.appendLog(row)).catch(e => { sharedPendingLogs().push(row); sharedOffline(e); save(); }); }
  else { sharedPendingLogs().push(row); save(); }
}
// 記録のない注文の補足（得意先・受注日・税抜金額）を、画面の注文から入れる（リストの行に必要）
function fillMeta(id) {
  const r = store.orders[id], s = slips.find(x => x.id === id);
  if (r && s) { if (!r.cust) r.cust = s.cust; if (!r.orderDate) r.orderDate = s.orderDate; if (r.net == null) r.net = s.netTotal; }
}
// 1注文をリストに書く（変わった項目だけ）＋ログを1行。状態のない注文（未確認のまま）は書かない（リストに行を作らない）
let lastPushErr = null;
async function pushOrder(id, action, detail, noLog) {
  const r = store.orders[id]; if (!r) return;
  fillMeta(id);
  const log = action && !noLog ? EC.logRow({ action, orderNo: id, actor: account && account.username, batchId: r.batchId, detail }) : null;
  const worth = !!(r.status || r.shipReportedAt || sharedRows[EC.orderNo(id)]);   // 状態が無くても、出荷報告済みの印があれば、リストに書く（共有する）
  if (!sharedOnline()) { if (worth) sharedPending()[id] = true; if (log) sharedPendingLogs().push(log); save(); renderSharedBanner(); return; }
  try {
    if (worth) {
      await shared.upsert(id, EC.orderFields(id, r));
      sharedRows[EC.orderNo(id)] = Object.assign({}, sharedRows[EC.orderNo(id)], EC.orderFields(id, r));
      delete sharedPending()[id];
    }
    if (log) await shared.appendLog(log);
    delete histCache[id];
  } catch (e) {
    lastPushErr = e;
    if (log) sharedPendingLogs().push(log);
    if (r.status || r.shipReportedAt) sharedPending()[id] = true;
    sharedOffline(e);
  }
  save(); renderSharedBanner();
}
function queuePush(id, action, detail) { pushChain = pushChain.then(() => pushOrder(id, action, detail)); return pushChain; }

// 状態が変わる操作の共通の入口。リストに接続できているときは、書く直前に Status を読み直して、想定外に変わっていたら
// 上書きせず「他の人が更新しました」と出して読み直す（確認OKの二重押しなど）。expect(id)＝いまの状態として想定するリストの Status の配列
async function commit(o) {
  const done = [], conflicts = [];
  for (const id of o.ids) {
    if (o.expect && sharedOnline() && !sharedPending()[id]) {
      try {
        const row = await shared.getRow(id), cur = row ? (row.fields.Status || '未確認') : '未確認', exp = o.expect(id);
        if (exp && exp.indexOf(cur) < 0) { conflicts.push({ id, cur }); continue; }
      } catch (e) { sharedOffline(e); }
    }
    if (o.mutate(id) !== false) done.push(id);
  }
  save(); render();
  done.forEach(id => queuePush(id, o.action, o.detail ? o.detail(id) : ''));
  if (conflicts.length) {
    alert('他の人が更新しました（' + conflicts.map(c => '#' + c.id + '：いまの状態は「' + c.cur + '」').join('、') + '）。この操作は行わず、最新の内容を読み直します。');
    await syncFromList({ quiet: true });
  }
  return { done, conflicts };
}
// 書く前の確認だけ（取込の依頼の前など）。想定外なら true を返し、読み直す
async function guardConflict(ids, expectList) {
  if (!sharedOnline()) return false;
  const bad = [];
  for (const id of ids) {
    if (sharedPending()[id]) continue;
    try { const row = await shared.getRow(id); const cur = row ? (row.fields.Status || '未確認') : '未確認'; if (expectList.indexOf(cur) < 0) bad.push('#' + id + '：「' + cur + '」'); }
    catch (e) { sharedOffline(e); return false; }
  }
  if (bad.length) { alert('他の人が更新しました（' + bad.join('、') + '）。取込は行わず、最新の内容を読み直します。'); await syncFromList({ quiet: true }); return true; }
  return false;
}
function setOk(s) {
  store.orders[s.id] = Object.assign(store.orders[s.id] || {}, { status: 'ok', by: account && account.username, at: new Date().toISOString(), cust: s.cust, orderDate: s.orderDate, net: s.netTotal });
  return true;
}
const UNDO_KEYS = ['excludeReason', 'excludedBy', 'excludedAt', 'status', 'exportedAt', 'exportedBy', 'batchId', 'juchuNo', 'diffs', 'checkMessage', 'manualConfirmed', 'confirmedBy', 'confirmedAt', 'matchedAt', 'matchedShip', 'orderName', 'by', 'at', 'importBy', 'importAt', 'reportedAt', 'shipReportedAt', 'shipReportedBy', 'slipUsed'];

// 1つのログだけを書く（注文の行は書かない）：テスト送信・報告の失敗など
function logOnly(action, orderNo, batchId, detail) {
  queueLog(EC.logRow({ action, orderNo, actor: account && account.username, batchId, detail }));
}
// 取込・突合・報告などで、まとめて状態を書く（各注文に1行ずつログ）
function pushMany(ids, action, detailFn) {
  ids.forEach(id => queuePush(id, action, detailFn ? detailFn(id) : ''));
}

// その注文の履歴（EC_Log。新しい順）
async function loadHistory(id) {
  const box = $('histBox'); if (!box) return;
  if (!sharedOnline()) { box.textContent = '共有の履歴に接続できないため、履歴は表示できません'; return; }
  const c = histCache[id];
  const draw = rows => {
    const b = $('histBox'); if (!b || openId !== id) return;
    b.innerHTML = rows.length ? '<table><tbody>' + rows.map(x => '<tr><td class="muted" style="white-space:nowrap">' + esc(stamp(x.LogTime)) + '</td><td>' + esc(EC.shortUser(x.Actor)) + '</td><td><b>' + esc(x.Action) + '</b>' + (x.Detail ? '<div class="muted">' + esc(x.Detail) + '</div>' : '') + '</td></tr>').join('') + '</tbody></table>' : '履歴はまだありません';
  };
  if (c && Date.now() - c.at < 30000) { draw(c.rows); return; }
  try { const rows = await shared.loadLog(id); histCache[id] = { at: Date.now(), rows }; draw(rows); }
  catch (e) { sharedOffline(e); const b = $('histBox'); if (b) b.textContent = '履歴を読み込めませんでした'; }
}
// 操作した人（OKした人・取込を依頼した人・確認OKした人）
function whoHtml(r) {
  if (!r) return '';
  const p = [r.by ? 'OK ' + EC.shortUser(r.by) : '', r.confirmedBy ? '確認OK ' + EC.shortUser(r.confirmedBy) : ''].filter(Boolean);
  return p.length ? '<div class="muted">' + esc(p.join('／')) + '</div>' : '';
}

// 管理者：この端末の記録のうち、リストに無い注文だけをリストに移す（何度押しても安全）
// 今までの不具合で、リストに書けず、この端末にだけ残っている「出荷報告済み」の印を、共有のリストに書く（画面を開いたとき1回。何度やっても同じ結果）
function healShipReports() {
  if (!sharedOnline()) return;
  const ids = Object.keys(store.orders).filter(id => { const r = store.orders[id]; return r && r.shipReportedAt && !sharedRows[EC.orderNo(id)] && !sharedPending()[id]; });
  ids.forEach(id => { queuePush(id, null, null); });
}
async function migrateLocal() {
  if (!isAdmin) return;
  if (!sharedOnline()) { alert('共有の履歴に接続できないため、移せません'); return; }
  await syncFromList({ quiet: true, noRender: true });
  const ids = EC.migrationPlan(store.orders, sharedRows);
  if (!ids.length) { alert('リストに移すものはありません（この端末の記録は、すべてリストにあります）'); return; }
  if (!confirm('この端末の記録のうち、共有の履歴（リスト）にまだ無い注文 ' + ids.length + '件を、リストに追加します。リストにある注文は変えません。よろしいですか？')) return;
  for (const id of ids) await queuePush(id, 'その他', 'この端末の記録から移行');
  await pushChain;
  await syncFromList({ quiet: true });
  alert(ids.length + '件をリストに追加しました');
}

/* ------------------------------------------------------------ SMILE に取り込む（RPA専用機に頼む）
   アプリ → _rpa_import/<バッチ番号>/ にファイルを置いて ec_smile_import を依頼 → 専用機が取込 → result.json
   → 続けて専用機が ec_smile_verify_export を依頼（SMILE から受注明細・納品先マスタを全件出力 → ec_smile_index.json）→ 客先注番で突き合わせ。
   約束事：scripts/rpa_setup/EC売上_RPA専用機への依頼内容.md */
const importTimers = {};   // バッチ番号 → 待機を止める関数
const RI = () => CONF.rpaImport;
async function rpaReady() {
  const did = await resolveDriveId();
  RpaQueue.init({ getToken: () => getToken(), getWriteToken: () => getWriteToken(), driveId: did });
}
async function loadAdmins() {
  isAdmin = false; isOperator = false;
  try {
    const did = await resolveDriveId();
    const r = await fetch('https://graph.microsoft.com/v1.0/drives/' + did + '/root:/' + RI().adminsFile.split('/').map(encodeURIComponent).join('/') + ':/content', { headers: { Authorization: 'Bearer ' + await getToken() } });
    if (!r.ok) return;
    const o = await r.json(); adminsRaw = o; const list = Array.isArray(o) ? o : (o.admins || []), me = String(account && account.username || '').toLowerCase();
    isAdmin = !!me && list.some(m => String(m).toLowerCase() === me);
    isOperator = !isAdmin && !!me && !Array.isArray(o) && (o.operators || []).some(m => String(m).toLowerCase() === me);
  } catch (e) { console.warn('管理者の一覧を読めません', e); }
}
function saveImp(imp) { save(); renderImportPanel(); renderOutbarIfOrders(); }
function renderOutbarIfOrders() { if (curTab !== 'pay') renderOutbar(); }

// 取込ファイルを置いて ec_smile_import を依頼する（本番の取込もテスト送信も同じ道）。
// o = { files, expected, orderIds, counts:{fresh,slips,rows,net,gross}, confirmMsg, test }
async function submitImport(o) {
  const batch = EC.buildImportBatch(o.files, account.username, new Date().toISOString(), { tempCodes: o.tempCodes }), id = batch.batchId, c = o.counts;
  importBusy = true; renderOutbar();
  try {
    await rpaReady();
    const old = store.imports[id];
    if (old && !old.dismissed && ['queued', 'importing', 'verify'].includes(old.phase)) { alert('この内容はすでに取込を依頼しています（' + id + '）。状況は画面上の取込のところで確認できます。'); return; }
    if (!o.test && await guardConflict(o.orderIds, ['OK済'])) return;   // 他の人がすでに進めた注文があれば、取込まない
    if (await RpaQueue.exists(RI().importDir + '/done/' + id)) { alert('この内容は取込済みです（二重取込を防ぐため止めました）。\nバッチ番号：' + id + '\nSMILE で確認し、必要なら「要確認」の扱いにしてください。'); return; }
    if (!confirm(o.confirmMsg)) return;
    setStatus('loading', '取込ファイルを置いています…');
    const dir = RI().importDir + '/' + id + '/';
    for (const f of batch.files) await RpaQueue.writeFile(dir + f.name, f.bytes, 'text/plain');
    await RpaQueue.writeFile(dir + 'manifest.json', JSON.stringify(batch.manifest, null, 2), 'application/json');   // 最後に置く（これがそろえば全部そろっている）
    const req = await RpaQueue.request(RI().jobImport, { app: o.test ? 'EC売上（テスト送信）' : 'EC売上', requestedBy: account.username, batchId: id });
    store.imports[id] = { batchId: id, orderIds: o.orderIds, phase: 'queued', queueName: req.name, requestedBy: account.username, requestedAt: batch.manifest.requestedAt,
      counts: c, expected: o.expected, message: '', test: !!o.test, needsReport: !o.test, requestedByName: account.name || '' };
    const nowIso = new Date().toISOString(), po = Object.keys(o.expected.orders)[0];
    if (!o.test) o.orderIds.forEach(oid => Object.assign(store.orders[oid], { status: 'importing', batchId: id, importBy: account.username, importAt: nowIso, slipUsed: (o.slipDates || {})[oid] }));
    else logOnly('テスト送信', po, id, '客先注番 ' + po + '（' + o.counts.rows + '行）');   // テスト送信は EC_Log にだけ（EC_Order には書かない）
    save(); setReady(); render(); trackImport(id);
    if (!o.test) pushMany(o.orderIds, '取込依頼', () => 'バッチ ' + id);
  } catch (e) {
    console.error(e); setStatus('err', '取込を依頼できませんでした: ' + e.message); alert('取込を依頼できませんでした。\n' + e.message);
  } finally { importBusy = false; renderOutbar(); }
}

async function startImport() {
  if (!canImport() || importBusy) return;
  await refreshCodeMode();   // 取込の直前に、専用機が仮の番号に対応しているかを確かめる
  if (codeDecision.blocked) { alert('取り込めません：' + codeDecision.blocked); return; }
  const p = planOut();
  if (!p.ok.length || !M.nouhin || !M.items || p.ok.some(s => s.hasErr)) return;
  const files = [], jrows = JUCHU_ROWS(p.ok, LAY.juchu, store.cfg, cal);
  if (p.fresh.length) files.push({ name: 'nouhin.txt', rows: p.fresh.length, bytes: EC.encodeUtf16(EC.toSmileText(LAY.nouhin, EC.nouhinRows(p.fresh, LAY.nouhin, store.cfg))) });
  files.push({ name: 'juchu.txt', rows: jrows.length, slips: EC.slipCount(jrows, LAY.juchu), bytes: EC.encodeUtf16(EC.toSmileText(LAY.juchu, jrows)) });
  const net = p.ok.reduce((a, s) => a + s.netTotal, 0), gross = p.ok.reduce((a, s) => a + s.grossTotal, 0);
  await submitImport({ files, slipDates: Object.fromEntries(p.ok.map(s => [s.id, s.slipDate])), tempCodes: EC.tempCodes(p.fresh), expected: EC.expectedImport(p.ok, p.fresh), orderIds: p.ok.map(s => s.id), counts: { fresh: p.fresh.length, slips: p.ok.length, rows: jrows.length, net, gross },
    confirmMsg: (isIndexStale() ? '⚠ SMILE の最新データが ' + agoText(indexAgeHours()) + 'です。二重取込の確認が古い可能性があります。先に「SMILEの最新を取り込む」を押すことをおすすめします。\n\n' : '') +
      'SMILE に取り込みます。\n新規の納品先：' + codeDecision.reason + '\n\n今回の取込：' + p.ok.length + '件（うち納品先の新規 ' + p.fresh.length + '件）。SMILE に実際に登録されます（手配区分1の本体は製番が付きます）。\n受注伝票：' + p.ok.length + '伝票（' + jrows.length + '行）\n' + slipDateNote(p.ok) + '金額合計：税抜 ' + yen(net) + '／税込 ' + yen(gross) + '\n\n取込は RPA 専用機が行い、終わると自動で SMILE と突き合わせて、Teams に報告します。担当者が画面で確認OKを押すと起票済みになります。よろしいですか？' });
}

// テスト送信（管理者メニュー）：SMILE のテスト用得意先に仮の注文を1件。本番の注文・得意先（599801・599802）には触らない。
// 本番の注文一覧・件数・出力バーには混ぜず、「テスト送信の結果」の枠に出す
function twoDigits(n) { return String(n).padStart(2, '0'); }
async function startTestImport() {
  if (!isAdmin || importBusy) return;
  const tc = CONF.testImport, guard = EC.testSendGuard(tc, store.cfg);
  if (guard) { alert(guard); return; }
  if (!M.items) { alert('品目マスタを読めていないため、テスト送信できません。「↻ 更新」で読み直してください'); return; }
  const d = new Date(), stamp = twoDigits(d.getFullYear() % 100) + twoDigits(d.getMonth() + 1) + twoDigits(d.getDate()) + twoDigits(d.getHours()) + twoDigits(d.getMinutes());
  // testImport.codeMode：auto（既定。仮の番号に対応した専用機のときだけ仮の番号、なければ固定のコード 999998）／temp（明示。対応していなければ止める）／fixed
  await refreshCodeMode();
  const td = EC.deliveryCodeMode(Object.assign({}, (CONF.rpaImport || {}).tempCodes, { mode: tc.codeMode === 'temp' ? 'temp' : (tc.codeMode === 'fixed' ? 'real' : 'auto') }), lastHealth);
  if (td.blocked) { alert('テスト送信できません：' + td.blocked); return; }
  const tmp = td.mode === 'temp' ? (CONF.rpaImport || {}).tempCodes : null, tcm = Object.assign({}, tc, { codeMode: tmp ? 'temp' : 'fixed' });
  const guard2 = EC.testSendGuard(tcm, store.cfg);
  if (guard2) { alert(guard2); return; }
  const exist = M.nouhin && M.nouhin[tc.customerCode] && M.nouhin[tc.customerCode].keys[EC.testDeliveryKey(tc)];   // 同じ名前・郵便番号のテスト用の納品先がすでにあれば、それを使う
  const r = EC.buildTestImport(tcm, store.cfg, { items: M.items, cal, today: today(), stamp, deliveryCodes: M.testDeliveryCodes || {}, temp: tmp, existingCode: exist });
  if (r.error) { alert('テスト送信できません：' + r.error); return; }
  const tcfg = store.cfg, jrows = JUCHU_ROWS(r.slips, LAY.juchu, tcfg, cal), files = [];
  if (r.fresh.length) files.push({ name: 'nouhin.txt', rows: r.fresh.length, bytes: EC.encodeUtf16(EC.toSmileText(LAY.nouhin, EC.nouhinRows(r.fresh, LAY.nouhin, tcfg))) });
  files.push({ name: 'juchu.txt', rows: jrows.length, slips: EC.slipCount(jrows, LAY.juchu), bytes: EC.encodeUtf16(EC.toSmileText(LAY.juchu, jrows)) });
  await submitImport({ files, tempCodes: EC.tempCodes(r.fresh), expected: EC.expectedImport(r.slips, r.fresh), orderIds: [], test: true, counts: { fresh: r.fresh.length, slips: 1, rows: jrows.length, net: r.net, gross: r.gross, po: r.id },
    confirmMsg: store.cfg.customers[tc.customerCode].name + '（' + tc.customerCode + '）に、テスト用の注文1件と、' + (!r.fresh.length ? '既存の納品先 ' + r.slips[0].deliveryCode + ' を使い' : (r.slips[0].deliveryTemp ? '新しい納品先（番号は取込の直前に専用機が決めます）を登録し' : '納品先 ' + tc.deliveryCode + ' を登録し')) + 'ます。終わったら SMILE で削除してください。\n\n（SMILE に入っている間は、東京の売上・日報に載ります）\n\n客先注番：' + r.id + '\n納品先の新規：' + r.fresh.length + '件' + (M.testDeliveryCodes ? '' : '（テスト用の納品先がマスタにあるか確認できないため、新規として送ります）') +
      '\n受注伝票：1伝票（' + jrows.length + '行）\n品目：' + r.slips[0].lines.map(l => l.code + '（' + yen(l.unitNet) + '）').join('・') + '（製番・製造手配が作られない品目だけを使います）\n金額合計：税抜 ' + yen(r.net) + '／税込 ' + yen(r.gross) + '\n\nよろしいですか？' });
}

function trackImport(id) {
  const imp = store.imports[id]; if (!imp) return;
  if (importTimers[id]) importTimers[id]();
  if (imp.phase === 'queued' || imp.phase === 'importing') {
    rpaReady().then(() => { importTimers[id] = RpaQueue.watch(imp.queueName, s => onImportQueue(id, s), { intervalMs: RI().pollSeconds * 1000 }); }).catch(e => console.warn(e));
  } else if (imp.phase === 'verify') trackVerify(id);
}
async function onImportQueue(id, s) {
  const imp = store.imports[id]; if (!imp) return;
  if (s.state === 'pending') { imp.phase = 'queued'; imp.ahead = s.ahead; }
  else if (s.state === 'running') imp.phase = 'importing';
  else if (s.state === 'timeout') imp.message = '状況を確認できません（時間切れ）。ページを開き直すと続きを確認します';
  else if (s.state === 'done' || s.state === 'failed') { await finishImport(imp, s); return; }
  saveImp(imp);
}
async function readImportResult(id) {
  for (const path of [RI().importDir + '/' + id + '/result.json', RI().importDir + '/done/' + id + '/result.json', RI().importDir + '/failed/' + id + '/result.json']) {
    try { const r = await RpaQueue.readJson(path); if (r) return r; } catch (e) { console.warn(e); }
  }
  return null;
}
function setOrders(imp, status, extra) {
  imp.orderIds.forEach(id => {
    const r = store.orders[id]; if (!r) return;
    r.status = status; if (status === 'ok') { delete r.batchId; delete r.slipUsed; }
    Object.assign(r, extra || {});
  });
}
async function finishImport(imp, s) {
  const r = await readImportResult(imp.batchId), j = EC.judgeImportResult(r);
  imp.result = r ? { state: r.state, message: r.message || '', files: r.files || [], retries: r.retries || 0 } : null;
  imp.assigned = (r && Array.isArray(r.assigned)) ? r.assigned : [];   // 専用機が決めた本当の納品先コード [{ customer, temp, code }]（無い旧形式は空）
  imp.retries = (r && r.retries) || 0;
  imp.importFinishedAt = (r && r.finishedAt) || s.finishedAt || new Date().toISOString();   // 確認用ファイルの generatedAt がこれより新しくなるのを待つ
  if (j.kind === 'done' && s.state === 'done') { imp.phase = 'verify'; imp.message = ''; setOrders(imp, 'waiting'); pushMany(imp.orderIds, '取込結果', () => '取込完了。SMILE との突合待ち'); saveImp(imp); trackVerify(imp.batchId); return; }
  if (j.kind === 'done') { j.kind = 'check'; j.message = '専用機の記録が失敗になっています：' + (s.error || ''); }
  if (j.kind === 'retry') {            // 取込件数0 → 何も入っていないので、もう一度「SMILEに取り込む」を押せる
    imp.phase = 'failed'; imp.message = j.message; delete imp.expected; setOrders(imp, 'ok', { importBy: undefined, importAt: undefined });
    pushMany(imp.orderIds, '取込結果', () => '取り込めませんでした（やり直せます）：' + j.message);
  } else {                              // 一部だけ入った・結果不明 → 再取込はさせず、SMILE を見て判断
    imp.phase = 'check'; imp.message = j.message; delete imp.expected;
    setOrders(imp, 'check', { checkMessage: j.message, diffs: [] });
    pushMany(imp.orderIds, '取込結果', () => '要確認：' + j.message);
  }
  // 取込が止まった・失敗したときも、専用機が result.json に書いた理由（message）を Teams に報告する（突合に進んだバッチは done/、止まったバッチは failed/ に印を置く）
  imp.reportDir = 'failed';
  save(); render();
  sendReport(imp, false);
}

async function trackVerify(id) {
  const imp = store.imports[id]; if (!imp || imp.phase !== 'verify') return;
  try {
    await rpaReady();
    if (!imp.verifyName) {
      // 専用機は取込のあと確認用出力を自動で依頼する。見つかればそれを待ち、一定時間たっても無ければこちらで依頼する
      const found = await RpaQueue.find(RI().jobVerify, imp.queueName);
      if (found.length) imp.verifyName = found[found.length - 1].name;
      else if (Date.now() - Date.parse(imp.importFinishedAt) > RI().verifyWaitSeconds * 1000) imp.verifyName = (await RpaQueue.request(RI().jobVerify, { app: 'EC売上（取込の確認）', requestedBy: imp.requestedBy })).name;
      saveImp(imp);
    }
  } catch (e) { console.warn(e); }
  if (!imp.verifyName) { const t = setTimeout(() => trackVerify(id), 15000); importTimers[id] = () => clearTimeout(t); return; }
  importTimers[id] = RpaQueue.watch(imp.verifyName, s => onVerifyQueue(id, s), { intervalMs: RI().pollSeconds * 1000, timeoutMs: 40 * 60 * 1000 });
}
async function onVerifyQueue(id, s) {
  const imp = store.imports[id]; if (!imp || imp.phase !== 'verify') return;
  if (s.state === 'done') { await applyVerify(imp); return; }
  if (s.state === 'failed') { imp.phase = 'verifyFailed'; imp.message = '確認用の出力に失敗しました：' + (s.error || ''); saveImp(imp); return; }
  if (s.state === 'timeout') { imp.message = '確認用の出力が終わりません（時間切れ）。ページを開き直すと続きを確認します'; saveImp(imp); return; }
  imp.verifyState = s.state; renderImportPanel();
}
async function retryVerify(id) {
  const imp = store.imports[id]; if (!imp || !canImport()) return;
  try { await rpaReady(); imp.verifyName = (await RpaQueue.request(RI().jobVerify, { app: 'EC売上（取込の確認）', requestedBy: account.username })).name; imp.phase = 'verify'; imp.message = ''; saveImp(imp); trackVerify(id); }
  catch (e) { alert('確認用の出力を依頼できませんでした。\n' + e.message); }
}
// 軽量ファイル（ec_smile_index.json）を読んで、注文ごとに突き合わせる。一致した注文だけ起票済みにして、SMILE の受注№を紐づける。
// generatedAt が取込の完了時刻より新しくなるまでは「確認待ち」のまま待つ（古いファイルで「見つからない」と誤判定しない）
// テスト送信の突き合わせ：結果は imp.testResult だけに持つ（store.orders＝本番の注文には書かない）
function applyTestVerify(imp, idx) {
  imp.expected = EC.resolveAssigned(imp.expected, imp.assigned).expected;   // 仮の番号 → 最終の納品先コード
  const res = EC.verifyImport(imp.expected, EC.indexObjects(idx.testOrders || idx.orders), EC.indexObjects(idx.nouhin)), id = Object.keys(imp.expected.orders)[0], v = res.orders[id];
  const eo = imp.expected.orders[id], dc = imp.expected.deliveries[0] && imp.expected.deliveries[0].code, dv = dc && res.deliveries[dc];
  imp.testResult = { id, status: v.status, juchuNo: v.juchuNo, diffs: v.diffs.slice(0, 40), deliveryStatus: dv ? dv.status : '', deliveryCode: eo.unresolved ? '' : eo.deliveryCode };   // 最終の納品先コード（SMILE で削除するもの）
  imp.phase = v.status === 'ok' ? 'done' : 'check';
  imp.message = v.status === 'ok' ? '' : (v.status === 'missing' ? 'SMILE の確認用ファイルに見つかりません（出力・JSON作成が終わっていない可能性、またはSMILE に入っていない可能性。' + (idx.testOrders ? '' : '軽量ファイルにテスト送信の注文の欄（testOrders）がありません。専用機の build_ec_index が古い可能性もあります。') + '）' : 'SMILE の内容が期待値と違います');
  delete imp.expected;
  save(); render();
}
async function applyVerify(imp) {
  const waitAgain = (msg) => {
    imp.waitTries = (imp.waitTries || 0) + 1;
    if (imp.waitTries > 60) { imp.phase = 'verifyFailed'; imp.message = msg + '（30分待っても新しくなりません。専用機の状態を確認してください）'; saveImp(imp); return; }
    imp.message = msg; saveImp(imp);
    const t = setTimeout(() => applyVerify(imp), RI().pollSeconds * 1000);
    importTimers[imp.batchId] = () => clearTimeout(t);
  };
  try {
    const r = await fetchCsv(CONF.files.index);
    const idx = JSON.parse(r.text);
    if (!(Date.parse(idx.generatedAt) >= Date.parse(imp.importFinishedAt))) {
      waitAgain('確認用ファイル（' + stamp(idx.generatedAt) + ' 作成）が取込より古いため、新しくなるのを待っています');
      return;
    }
    if (imp.test) { applyTestVerify(imp, idx); return; }
    const rs = EC.resolveAssigned(imp.expected, imp.assigned);   // 仮の番号 → 専用機が決めた本当のコード（無ければ要確認）
    imp.expected = rs.expected;
    const res = EC.verifyImport(imp.expected, EC.indexObjects(idx.orders), EC.indexObjects(idx.nouhin));
    let ok = 0, ng = 0;
    imp.orderIds.forEach(id => {
      const rec0 = store.orders[id], v = res.orders[id]; if (!rec0 || !v) return;
      if (v.status === 'ok') {
        // 一致：担当者の最終確認を待つ（自動では起票済みにしない）。受注№は確認待ちの時点で表示する
        const eo = imp.expected.orders[id] || {};
        ok++; rec0.status = EC.matchToStatus(v); rec0.matchedAt = new Date().toISOString(); rec0.juchuNo = v.juchuNo; rec0.matchedShip = eo.shipDate || ''; rec0.orderName = eo.name || ''; rec0.deliveryCode = eo.deliveryCode; delete rec0.diffs; delete rec0.checkMessage;
      } else {
        const eo = imp.expected.orders[id] || {};
        ng++; if (!eo.unresolved) rec0.deliveryCode = eo.deliveryCode; rec0.status = EC.matchToStatus(v); rec0.diffs = v.diffs.slice(0, 40); rec0.matchedShip = eo.shipDate || ''; rec0.orderName = eo.name || '';
        rec0.checkMessage = eo.unresolved ? '納品先コードの番号を確認できません（専用機が決めた番号が結果ファイルにありません。専用機の常駐スクリプトが古い可能性があります。SMILE を見て判断してください）' : v.status === 'missing' ? 'SMILE の確認用ファイルに見つかりません（出力・JSON作成が終わっていない可能性、またはSMILE に入っていない可能性があります）' : 'SMILE の内容がアプリの期待値と違います';
        if (v.juchuNo) rec0.juchuNo = v.juchuNo;
      }
    });
    pushMany(imp.orderIds, '突合結果', id => { const r = store.orders[id] || {}; return r.status === 'confirm' ? '一致（SMILE受注№ ' + (r.juchuNo || '') + '）' : '不一致：' + (EC.reportReasons({ diffs: r.diffs, message: r.checkMessage }).join('／') || '理由不明'); });
    imp.summary = { ok, ng }; imp.phase = EC.importPhase(imp, store.orders); imp.message = ng ? ng + '件が期待値と違います。注文をクリックして、SMILE の値と見比べてください' : '';
    delete imp.expected;   // 比べ終えたら期待値（お客様の住所など）は持たない
    save(); render();
    sendReport(imp, false);   // 担当者へ Teams で報告（バッチごとに1回だけ。失敗しても突合の結果には影響しない）
  } catch (e) {
    console.warn(e);
    waitAgain('確認用ファイル（' + CONF.files.index + '）を読めません：' + e.message);
  }
}

const IMP_STEPS = ['依頼中', '取込中', '突合待ち', '確認待ち'];
// テスト送信で SMILE に登録された納品先コード（仮の番号のときは、専用機が決めた最終のコード。まだ分からないときは説明）
function testDCode(tc, tr) {
  if (tr && tr.deliveryCode) return tr.deliveryCode;
  return tc.codeMode === 'fixed' || !tempCfg() ? (tc.deliveryCode || '') : '（取込の直前に専用機が決めます）';
}
// テスト送信の結果（本番の注文一覧・件数には混ぜない）
function renderTestPanel() {
  const el = $('testPanel'); if (!el || !store) return;
  const list = Object.values(store.imports).filter(i => !i.dismissed && i.test).sort((a, b) => a.requestedAt < b.requestedAt ? 1 : -1);
  el.hidden = !list.length;
  const tc = CONF.testImport || {};
  el.innerHTML = list.map(i => {
    const stepNow = { queued: 0, importing: 1, verify: 2, done: 3 }[i.phase], c = i.counts || {}, tr = i.testResult;
    const steps = stepNow == null ? '' : '<span class="steps">' + IMP_STEPS.map((l, k) => '<span' + (k === stepNow ? ' class="on"' : '') + '>' + (k ? '→ ' : '') + l + '</span>').join('') + '</span>';
    const tag = { done: '<span class="tag ok">確認OK</span>', check: '<span class="tag err">要確認</span>', failed: '<span class="tag err">取込失敗</span>', verifyFailed: '<span class="tag err">確認の出力に失敗</span>' }[i.phase] || '';
    const fin = ['done', 'check', 'failed', 'verifyFailed'].includes(i.phase);
    let body = '';
    if (tr) {
      body += '<div>突き合わせ：' + (tr.status === 'ok' ? '<span class="tag ok">一致</span>' : '<span class="tag err">' + (tr.status === 'missing' ? 'SMILEに見つかりません' : '不一致') + '</span>') +
        (tr.juchuNo ? ' ／ SMILE の受注№ <b>' + esc(tr.juchuNo) + '</b>' : '') + (tr.deliveryStatus ? ' ／ 納品先 ' + esc(testDCode(tc, tr)) + '：' + (tr.deliveryStatus === 'ok' ? '一致' : '不一致') : '') + '</div>';
      if (tr.diffs && tr.diffs.length) body += '<table style="margin-top:4px"><thead><tr><th>項目</th><th>アプリの期待値</th><th>SMILE の値</th></tr></thead><tbody>' + tr.diffs.map(x => '<tr><td>' + esc(x.label) + '</td><td>' + esc(x.expected) + '</td><td class="bad">' + esc(x.actual) + '</td></tr>').join('') + '</tbody></table>';
    }
    if (fin && i.phase !== 'failed') body += '<div class="muted" style="margin-top:6px"><b>次に SMILE で削除するもの：</b>受注伝票（客先注番 ' + esc(c.po || '') + (tr && tr.juchuNo ? '／受注№ ' + esc(tr.juchuNo) : '') + '）' + (c.fresh ? '、<b>最終の納品先コード ' + esc(testDCode(tc, tr)) + '</b>（今回の送信で新規に登録）' : '') + '。<b>削除するまで、東京（' + esc(tc.customerCode || '') + '）の売上・日報に載ります。</b>テスト送信は製番・製造手配を作らない品目（手配区分2・在庫管理なし）だけを使っています。</div>';
    return '<div style="padding:6px 0;border-bottom:1px solid var(--line)"><div class="imp" style="border:none"><b>テスト送信の結果</b>' + tag + steps + '<span class="muted">客先注番 ' + esc(c.po || '') + '・' + stamp(i.requestedAt) + ' 依頼・' + esc(i.batchId) + '</span>' +
      (i.message ? '<span class="' + (i.phase === 'done' ? 'muted' : 'bad') + '">' + esc(i.message) + '</span>' : '') + '<div class="grow"></div>' +
      (i.phase === 'verifyFailed' && canImport() ? '<button class="btn sec sm" data-impverify="' + esc(i.batchId) + '">確認だけやり直す</button>' : '') +
      (fin ? '<button class="btn sec sm" data-impclose="' + esc(i.batchId) + '">閉じる</button>' : '') + '</div>' + body + '</div>';
  }).join('');
}
// 取込1回分の注文の今の状態の件数（確認待ち・起票済み・要確認）
function impCounts(imp) {
  const c = { confirm: 0, exported: 0, check: 0 };
  (imp.orderIds || []).forEach(id => { const r = store.orders[id]; if (r && c[r.status] != null) c[r.status]++; });
  return c;
}
// Teams への報告の状態（本番の取込だけ）
function reportHtml(i) {
  const r = i.report; if (!r) return '';
  if (r.state === 'sent') return '<span class="tag ok">Teams報告済み</span>';
  if (r.state === 'requested') return '<span class="muted">Teams に報告中…</span>';
  return '<span class="tag err">報告に失敗</span><span class="bad">' + esc(r.message || '') + '</span>' + (isAdmin ? '<button class="btn sec sm" data-impreport="' + esc(i.batchId) + '">報告を再送</button>' : '');
}
function renderImportPanel() {
  const el = $('importPanel'); if (!el || !store) return;
  renderTestPanel();
  const list = Object.values(store.imports).filter(i => !i.dismissed && !i.test).sort((a, b) => a.requestedAt < b.requestedAt ? 1 : -1);
  el.hidden = !list.length;
  el.innerHTML = list.map(i => {
    const stepNow = { queued: 0, importing: 1, verify: 2, confirm: 3 }[i.phase];
    const steps = stepNow == null ? '' : '<span class="steps">' + IMP_STEPS.map((l, k) => '<span' + (k === stepNow ? ' class="on"' : '') + '>' + (k ? '→ ' : '') + l + '</span>').join('') + '</span>';
    const tag = { confirm: '<span class="tag warn">確認待ち</span>', done: '<span class="tag ok">起票済み</span>', check: '<span class="tag err">要確認</span>', failed: '<span class="tag err">取込失敗</span>', verifyFailed: '<span class="tag err">突合の出力に失敗</span>' }[i.phase] || '';
    const c = i.counts || {}, fin = ['done', 'check', 'failed'].includes(i.phase), live = impCounts(i);
    const extra = i.phase === 'queued' && i.ahead ? '（前に ' + i.ahead + '件待ち）' : '';
    const sum = ['confirm', 'check', 'done'].includes(i.phase) ? [live.confirm ? '確認待ち ' + live.confirm + '件' : '', live.exported ? '起票済 ' + live.exported + '件' : '', live.check ? '要確認 ' + live.check + '件' : ''].filter(Boolean).join('／') : '';
    return '<div class="imp">' + tag + steps + '<span><b>SMILE取込</b> 受注 ' + (c.slips || 0) + '伝票・納品先の新規 ' + (c.fresh || 0) + '件' + extra + '</span><span class="muted">' + esc(i.batchId) + '・' + stamp(i.requestedAt) + ' 依頼</span>' +
      (sum ? '<span>' + esc(sum) + '</span>' : '') + (i.message ? '<span class="' + (['failed', 'check', 'verifyFailed'].includes(i.phase) ? 'bad' : 'muted') + '">' + esc(i.message) + '</span>' : '') + reportHtml(i) +
      '<div class="grow"></div>' + (i.phase === 'confirm' && live.confirm && isAdmin ? '<button class="btn sm" data-impconfirm="' + esc(i.batchId) + '">確認待ち ' + live.confirm + '件をまとめて確認OK</button>' : '') +
      (i.phase === 'verifyFailed' && canImport() ? '<button class="btn sec sm" data-impverify="' + esc(i.batchId) + '">突合だけやり直す</button>' : '') +
      (fin || i.phase === 'verifyFailed' ? '<button class="btn sec sm" data-impclose="' + esc(i.batchId) + '">閉じる</button>' : '') + '</div>';
  }).join('');
}

// ---- 確認OK（管理者だけ。押した人・日時を記録する）
async function confirmOrders(ids) {
  if (!isAdmin) { alert('確認OKは管理者だけが行えます'); return 0; }
  const who = account && account.username, now = new Date().toISOString();
  const r = await commit({ ids, expect: () => ['確認待ち'], mutate: id => EC.confirmOk(store.orders[id], who, now, isAdmin).ok, action: '確認OK', detail: id => 'SMILE受注№ ' + ((store.orders[id] && store.orders[id].juchuNo) || '') });
  Object.values(store.imports).forEach(imp => {
    if (imp.test || !['confirm', 'check'].includes(imp.phase) || !imp.orderIds.some(id => r.done.includes(id))) return;
    imp.phase = EC.importPhase(imp, store.orders);
    if (imp.phase === 'done') imp.message = '';
  });
  save(); render();
  return r.done.length;
}
function confirmWaitingIds(only) {
  return (only || Object.keys(store.orders)).filter(id => store.orders[id] && store.orders[id].status === 'confirm');
}
function confirmBulkHtml() {
  if (curFilter !== (FLOW_UI() ? 'p3' : 'confirm') || !isAdmin) return '';
  const n = confirmWaitingIds().length;
  return n ? '<div class="row" style="margin-bottom:8px"><button class="btn" id="o-confirmall">確認待ち ' + n + '件をまとめて確認OK（起票済みにする）</button><span class="muted">SMILEの受注№・出荷予定日を見て、問題なければ押します</span></div>' : '';
}
function confirmBulk(ids) {
  if (!isAdmin || !ids.length) return;
  if (!confirm('確認待ち ' + ids.length + '件を「確認OK（起票済み）」にします。SMILEに入った受注№・出荷予定日を確認しましたか？')) return;
  confirmOrders(ids);
}

// ---- 担当者への報告（Teams のチャネル。専用機のジョブ ec_report）。突合が済んだバッチごとに1回だけ。
// 二重投稿しない印：_rpa_import/done/<バッチ>/reported.json を先に書いてから依頼する（ブラウザを閉じて開き直しても、印があれば再送しない）。
// 報告に失敗しても取込・突合の結果には影響しない（画面に「報告に失敗」と出して、再送ボタン）。
function reportOrders(imp) {
  return imp.orderIds.map(id => {
    const r = store.orders[id] || {}, s = slips.find(x => x.id === id);
    if (imp.phase === 'failed') return { name: r.orderName || (s && s.name) || ('#' + id), juchuNo: '', shipDate: '', status: 'check', diffs: [], message: imp.message || '取り込めませんでした' };   // 取込に失敗（やり直せる）：理由をそのまま
    return { name: r.orderName || (s && s.name) || ('#' + id), juchuNo: r.juchuNo || '', shipDate: r.matchedShip || (s && shipOf(s)) || '', status: r.status, diffs: r.diffs || [], message: r.checkMessage || '', deliveryCode: r.deliveryCode || '' };
  });
}
async function sendReport(imp, force) {
  if (imp.test || !imp.needsReport) return;
  // リストに報告済みの印（ReportedAt）がある（別の端末が報告した）なら、二重に報告しない
  if (!force && imp.orderIds.length && imp.orderIds.every(id => store.orders[id] && store.orders[id].reportedAt)) { imp.report = { state: 'sent' }; saveImp(imp); return; }
  try {
    await rpaReady();
    const marker = RI().importDir + '/' + (imp.reportDir || 'done') + '/' + imp.batchId + '/reported.json';
    if (!force && await RpaQueue.exists(marker)) { imp.report = Object.assign({}, imp.report, { state: 'sent' }); markReported(imp); saveImp(imp); return; }
    const parts = EC.buildReport({ batchId: imp.batchId, counts: imp.counts, orders: reportOrders(imp), url: location.origin + location.pathname, maxChars: RI().reportMaxChars || 3000 });
    imp.report = { state: 'requested', at: new Date().toISOString() }; saveImp(imp);
    await RpaQueue.writeFile(marker, JSON.stringify({ batchId: imp.batchId, at: imp.report.at, by: account && account.username }), 'application/json');   // 先に印（二重投稿を防ぐ）
    const req = await RpaQueue.request(RI().jobReport, { app: 'EC売上（報告）', requestedBy: account && account.username, batchId: imp.batchId, params: EC.reportParams({ batchId: imp.batchId, parts, requestedBy: imp.requestedBy || (account && account.username), requestedByName: imp.requestedByName || (account && account.name) }) });   // 取込を依頼した人へのメンション（メールの形でなければ付けない）
    imp.report.queueName = req.name; saveImp(imp);
    watchReport(imp);
  } catch (e) {
    console.warn('報告を依頼できません', e);
    imp.report = { state: 'failed', message: e.message }; saveImp(imp);
    logOnly('報告失敗', '', imp.batchId, e.message);
  }
}
// 報告済みの印（ReportedAt）を、リストにも書く（_rpa_import 側の reported.json と、どちらかが済んでいれば二重に報告しない）
function markReported(imp) {
  const now = new Date().toISOString(), ids = imp.orderIds.filter(id => store.orders[id] && !store.orders[id].reportedAt);
  ids.forEach(id => { store.orders[id].reportedAt = now; });
  save(); pushMany(ids, '報告送信', () => 'Teams へ報告（バッチ ' + imp.batchId + '）');
}
function watchReport(imp) {
  RpaQueue.watch(imp.report.queueName, s => {
    if (s.state === 'done') { imp.report = Object.assign({}, imp.report, { state: 'sent', message: '' }); markReported(imp); }
    else if (s.state === 'failed') { imp.report = Object.assign({}, imp.report, { state: 'failed', message: s.error || '専用機が報告に失敗しました' }); logOnly('報告失敗', '', imp.batchId, imp.report.message); }
    else if (s.state === 'timeout') imp.report = Object.assign({}, imp.report, { state: 'failed', message: '報告の結果を確認できません（時間切れ）' });
    else return;
    saveImp(imp);
  }, { intervalMs: RI().pollSeconds * 1000, timeoutMs: 30 * 60 * 1000 });
}
// 開き直したとき：突合が済んでいて、まだ報告していない取込を再開して1回だけ報告する
async function resumeReports() {
  for (const imp of Object.values(store.imports)) {
    if (imp.test || !imp.needsReport || !['confirm', 'check', 'done', 'failed'].includes(imp.phase) || (imp.phase === 'failed' && !imp.reportDir)) continue;
    const r = imp.report;
    if (r && r.state === 'sent') continue;
    if (r && r.state === 'requested' && r.queueName) { try { await rpaReady(); watchReport(imp); } catch (e) { console.warn(e); } continue; }
    if (r && r.state === 'requested') { imp.report = { state: 'failed', message: '報告の依頼が途中で中断しました。再送してください' }; saveImp(imp); continue; }
    if (!r) await sendReport(imp, false);   // 失敗した報告は自動で再送しない（再送ボタン）
  }
}

// ---- SMILE の最新データ（ec_smile_index.json）の古さと、管理者の「SMILEの最新を取り込む」
function indexAgeHours() { return M.indexInfo ? (Date.now() - Date.parse(M.indexInfo.generatedAt)) / 36e5 : null; }
// Shopify の自動取得ファイルが古いとき（取得が止まっている）に知らせる。しきい値は設定 shopifyStaleHours（既定36）
function shopifyAgeText() {
  const m = M.stamps.shopify_orders; if (!m) return '';
  const h = (Date.now() - Date.parse(m)) / 36e5, lim = (CONF.config && CONF.config.shopifyStaleHours) || 36;
  return ' ／ Shopify取得：' + agoText(h) + (h >= lim ? ' ⚠ 自動取得が止まっている可能性があります（専用機のタスクを確認）' : '');
}
// SMILEのデータが古いと、二重取込の確認が当てにならない。強い警告を出し、取込の操作も止める（管理者だけは確認のうえ続けられる）
function renderStale() {
  const el = $('staleBox'); if (!el) return;
  if (!isIndexStale()) { el.hidden = true; return; }
  const h = indexAgeHours(), at = M.indexInfo && M.indexInfo.generatedAt, d = at ? new Date(at) : null;
  el.hidden = false;
  el.innerHTML = '<div class="stale-in"><div><b>⚠ SMILEデータが古いため、安全に起票できません</b><div style="font-size:12px">二重取込の確認が、最新のSMILEに基づきません。最終取得：' + (d ? d.getFullYear() + '/' + twoDigits(d.getMonth() + 1) + '/' + twoDigits(d.getDate()) + ' ' + twoDigits(d.getHours()) + ':' + twoDigits(d.getMinutes()) : '—') + '（' + agoText(h) + '）</div></div><div class="grow"></div>' +
    (canImport() ? '<button class="btn" id="stale-sync">SMILEの最新を取り込む</button>' : '<span style="font-size:12px">取込担当者に最新化を頼んでください</span>') + '</div>';
}
function isIndexStale() { const h = indexAgeHours(); return h != null && h >= (RI().staleHours || 6); }
function agoText(h) { return h < 1 ? Math.max(1, Math.round(h * 60)) + '分前' : (h < 48 ? '約' + Math.round(h) + '時間前' : '約' + Math.round(h / 24) + '日前'); }
let syncBusy = false;
async function syncSmile() {
  if (!canImport() || syncBusy) return;
  if (!confirm('SMILE から最新の受注・納品先を全件出力して、確認用ファイルを作り直します（約3分）。取込の前に行うと、二重取込の確認が最新になります。よろしいですか？')) return;
  syncBusy = true; $('btn-sync').disabled = true;
  const since = Date.now() - 5000;
  try {
    await rpaReady();
    setStatus('loading', 'SMILEの最新を取り込む：依頼中…');
    const req = await RpaQueue.request(RI().jobVerify, { app: 'EC売上（SMILEの最新化）', requestedBy: account.username });
    const fin = await new Promise(resolve => RpaQueue.watch(req.name, s => {
      if (s.state === 'pending') setStatus('loading', 'SMILEの最新を取り込む：順番待ち…' + (s.ahead ? '（前に ' + s.ahead + '件）' : ''));
      else if (s.state === 'running') setStatus('loading', 'SMILEの最新を取り込む：SMILEから全件出力し、確認用ファイルを作っています（約3分）…');
      else if (s.state === 'done' || s.state === 'failed' || s.state === 'timeout') resolve(s);
    }, { intervalMs: RI().pollSeconds * 1000, timeoutMs: 30 * 60 * 1000 }));
    if (fin.state !== 'done') throw new Error(fin.state === 'failed' ? (fin.error || '専用機で失敗しました') : '時間切れ');
    for (let i = 0; i < 40; i++) {   // OneDrive の同期の遅れ：ファイルが新しくなるのを待つ
      try { const r = await fetchCsv(CONF.files.index); if (Date.parse(JSON.parse(r.text).generatedAt) >= since) break; } catch (e) { /* 待つ */ }
      await new Promise(r => setTimeout(r, RI().pollSeconds * 1000));
    }
    await loadMasters(); recompute(); render(); setReady();
  } catch (e) { console.warn(e); setStatus('err', 'SMILEの最新を取り込めませんでした：' + e.message); }
  finally { syncBusy = false; $('btn-sync').disabled = false; }
}


/* ------------------------------------------------------------ 対応表・設定（共有保存）
   SharedMasters の ec_sales_settings.json に保存して、全員で使う（読み書きと差分は ec_sales_settings.js）。
   一覧は読み取りだけ。直すのは、編集者（管理者＋ _rpa_queue/ec_settings_editors.json の人）が、行をクリック → ドロワー →「編集」→ 確認の画面 →「この内容で保存する」。 */
let settingsIo = null, settingsEtag = null, settingsEditor = false, adminsRaw = null, mapDrawer = null, mapQ = '';
let settingsInfo = { state: 'init', updatedAt: '', updatedBy: '', error: '' };   // state: init / shared（共有ファイルあり）/ default（まだ無い）/ offline（接続できない）
let BASE = null;                                  // 共有ファイルを重ねる前の既定（ec_sales_config.json）
const baseSettings = () => ({ mapping: clone(BASE.mapping), cfg: clone(BASE.cfg) });
const curSettings = () => ({ mapping: clone(store.mapping), cfg: clone(store.cfg) });
const canEditSettings = () => settingsEditor && settingsInfo.state !== 'offline';

async function loadSettings() {
  try {
    const did = await resolveDriveId();
    settingsIo = EcSettings.create({ getToken: () => getToken(), getWriteToken: () => getWriteToken(), driveId: did, fileName: CONF.files.settings });
    const r = await settingsIo.read();
    settingsEtag = r.etag;
    const a = EcSettings.applyFile(baseSettings(), r.settings);
    store.mapping = a.mapping; store.cfg = a.cfg;
    settingsInfo = { state: r.settings ? 'shared' : 'default', updatedAt: r.settings ? r.settings.updatedAt : '', updatedBy: r.settings ? r.settings.updatedBy : '', error: '' };
    let editors = null; try { editors = await settingsIo.readJson(RI().settingsEditorsFile); } catch (e) { /* 編集者の一覧はなくてよい */ }
    settingsEditor = EcSettings.canEdit(account && account.username, adminsRaw, editors);
    if (r.settings && store.legacy) { delete store.legacy; save(); }   // 共有ファイルがあれば、この端末の古い対応表は使わない
  } catch (e) {
    console.warn('共有の設定', e);
    settingsInfo = { state: 'offline', updatedAt: '', updatedBy: '', error: settingsIo && settingsIo.isUnavailable(e) ? '' : '（' + e.message + '）' };
    settingsEditor = false;
  }
}
// 保存。成功したら画面の設定を差し替えて、EC_Log に変更の要約だけを残す
async function saveSettings(after, diff) {
  if (!canEditSettings() || !settingsIo) return { ok: false, msg: '設定を編集できる人は、管理者と、設定の編集者だけです' };
  const who = account && account.username, now = new Date().toISOString();
  try {
    const w = await settingsIo.write(EcSettings.fileOf(after.mapping, after.cfg, who, now), settingsEtag);
    settingsEtag = w.etag; store.mapping = after.mapping; store.cfg = after.cfg;
    settingsInfo = { state: 'shared', updatedAt: now, updatedBy: who, error: '' };
    delete store.legacy;
    queueLog(EC.logRow({ action: 'その他', actor: who, now, detail: '対応表を変更（' + EcSettings.logDetail(diff) + '）' }));
    save(); recompute(); render();
    return { ok: true };
  } catch (e) {
    if (settingsIo.isConflict(e)) { await loadSettings(); recompute(); render(); return { ok: false, conflict: true, msg: '他の人が更新しました。最新の内容を読み直しました。もう一度やり直してください' }; }
    return { ok: false, msg: '保存できませんでした' + (settingsIo.isUnavailable(e) ? '（共有の設定に接続できません・権限を確認してください）' : '（' + e.message + '）') };
  }
}

/* ---- 確認の画面（変更前／変更後を並べる。納品先の編集の確認画面と同じ流儀） */
function reviewSettings(o) {
  const diff = EcSettings.diffSettings(o.before, o.after, M.items);
  if (!diff.count) { alert('変更がありません'); return; }
  const errs = o.errors || [], warns = o.warns || [];
  const tbl = (rows, hd) => '<table style="width:100%;border-collapse:collapse;margin:4px 0 10px"><thead><tr><th></th><th>変更前</th><th>変更後</th></tr></thead><tbody>' + rows.map(f => '<tr><th style="text-align:left;vertical-align:top;white-space:nowrap">' + esc(f.label) + '</th><td style="word-break:break-all;vertical-align:top">' + esc(f.before) + '</td><td style="background:#fff1c2;font-weight:600;word-break:break-all;vertical-align:top">' + esc(f.after) + '</td></tr>').join('') + '</tbody></table>';
  const typeTag = { add: '追加', del: '削除', edit: '編集', move: '順番' };
  const ltbl = x => !x.lines || !x.lines.length || (x.type === 'edit' && x.lines.every(l => l.status === 'same')) ? '' : '<div class="muted" style="margin-top:6px">SMILE に入る明細（行ごと。緑＝追加／赤＝削除／黄＝変更）</div><table class="lt"><thead><tr><th style="width:50%">変更前</th><th>変更後</th></tr></thead><tbody>' +
    x.lines.map(l => '<tr><td class="' + (l.status === 'del' ? 'del' : l.status === 'chg' ? 'chg' : '') + '">' + esc(l.before) + '</td><td class="' + (l.status === 'add' ? 'add' : l.status === 'chg' ? 'chg' : '') + '">' + esc(l.after) + '</td></tr>').join('') + '</tbody></table>';
  const body = diff.rules.map(x => '<div style="margin-top:8px"><span class="tag ' + (x.type === 'del' ? 'err' : x.type === 'add' ? 'ok' : 'info') + '">' + typeTag[x.type] + '</span> <b>' + esc(x.label) + '</b></div>' + (x.type === 'del' ? '<div class="muted">このルールを消します。該当していた商品は「対応表にない商品」になります</div>' : x.type === 'move' ? tbl(x.fields) : tbl(x.fields) + ltbl(x)) + (x.type === 'del' ? ltbl(x) : '')).join('') +
    (diff.settings.length ? '<div style="margin-top:8px"><span class="tag info">設定</span></div>' + tbl(diff.settings) : '');
  const ov = document.createElement('div');
  ov.id = 'editConfirm';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(22,26,61,.5);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:760px;width:100%;padding:20px 24px;max-height:90vh;overflow:auto"><h2 style="margin:0 0 6px;font-size:16px">' + esc(o.title) + '</h2>' +
    '<div class="muted" style="margin-bottom:6px">' + esc(o.note || '保存すると、全員の画面に反映され、これから作る取込ファイルがこの内容になります。') + '</div>' + body +
    errs.map(x => '<div class="alert err" style="margin-top:8px">' + esc(x) + '（直してから保存してください）</div>').join('') +
    warns.map(x => '<div class="alert warn" style="margin-top:8px">' + esc(x) + '</div>').join('') +
    '<div class="muted" style="margin-top:8px">誰がいつ変えたかは、変更の履歴（EC_Log）と、SharePoint のファイルの版履歴（SharedMasters の ec_sales_settings.json）に残ります。間違えたときは版履歴から戻せます。</div>' +
    '<div id="rvMsg" class="bad" style="margin-top:6px"></div>' +
    '<div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px"><button class="btn sec" id="rv-back">戻って直す</button><button class="btn" id="rv-save"' + (errs.length ? ' disabled' : '') + '>この内容で保存する</button></div></div>';
  document.body.appendChild(ov);
  $('rv-back').onclick = () => ov.remove();
  $('rv-save').onclick = async () => {
    $('rv-save').disabled = true; $('rv-back').disabled = true; $('rvMsg').textContent = '保存中…';
    const r = await saveSettings(o.after, diff);
    if (r.ok) { ov.remove(); if (o.onSaved) o.onSaved(); render(); return; }
    if (r.conflict) { ov.remove(); mapDrawer = null; render(); alert(r.msg); return; }
    $('rvMsg').textContent = r.msg; $('rv-back').disabled = false;
  };
}

/* ---- ドロワー（右から）：ルール／納期の設定 */
function ruleDraft(r, pos) {
  return {
    id: r.id, scope: r.scope, label: r.label || '', wordsText: (r.words || []).join('、'), pattern: r.pattern || '', match: r.match || 'contains', qtyUnit: r.qtyUnit || '',
    code: r.code || '', net: r.net == null ? '' : String(r.net), leadDays: r.leadDays == null ? '' : String(r.leadDays), note: r.note || r.warn || '', hasWarn: !!r.warn,
    includes: (r.includes || []).map(x => ({ code: x.code, qty: String(x.qty), net: x.net == null ? '' : String(x.net) })),
    swapFrom: r.swap ? r.swap.from : '', swapTo: r.swap ? r.swap.to : '', hasSwap: !!r.swap, pos, tryText: '',
    qtyMode: r.qtyUnit ? 'unit' : (r.qty === 'g1' ? 'g1' : 'fixed'), qty: r.qty == null || r.qty === 'g1' ? '1' : String(r.qty)
  };
}
function draftRule(d, orig) {
  const r = clone(orig || {});
  r.id = d.id; r.scope = d.scope; r.label = d.label; r.match = d.match; r.code = d.code; r.net = d.net; r.leadDays = d.leadDays;
  if (d.scope === 'option') {
    if (d.qtyMode === 'unit') { r.qtyUnit = d.qtyUnit; delete r.qty; }
    else { delete r.qtyUnit; if (d.qtyMode === 'g1') r.qty = 'g1'; else if (d.qty === '1' && (!orig || orig.qty == null)) delete r.qty; else r.qty = d.qty; }
  } else { delete r.qtyUnit; delete r.qty; }
  r.words = d.wordsText.split(/[、,\n]/).map(x => x.trim()).filter(Boolean);
  if (!r.words.length && d.pattern) { r.pattern = d.pattern; delete r.words; } else delete r.pattern;
  if (d.hasWarn) { r.warn = d.note; delete r.note; } else r.note = d.note;
  r.includes = d.scope === 'body' ? d.includes : undefined;
  r.swap = d.scope === 'option' && (d.hasSwap || d.swapFrom || d.swapTo) ? { from: d.swapFrom, to: d.swapTo } : undefined;
  return EcSettings.normalizeRule(r);
}
function proposedMapping(d) {
  const m = clone(store.mapping), rule = draftRule(d, m.rules.find(r => r.id === d.id));
  const i = m.rules.findIndex(r => r.id === d.id); if (i >= 0) m.rules.splice(i, 1);
  m.rules.splice(Math.max(0, Math.min(d.pos, m.rules.length)), 0, rule);
  return { mapping: m, rule };
}
function openRule(id) { if (!confirmDiscardEdit()) return; openId = null; editId = null; editDraft = null; mapDrawer = { kind: 'rule', id, mode: 'view' }; renderDrawer(); }
function startNewRule(word) {
  if (!confirmDiscardEdit()) return;
  openId = null; editId = null; editDraft = null; curTab = 'map';
  mapDrawer = { kind: 'rule', id: null, mode: 'edit', isNew: true, draft: ruleDraft({ id: 'r' + Date.now(), scope: 'option', label: word || '', words: word ? [word] : [], match: 'contains' }, store.mapping.rules.length) };
  render();
}
function startLeadEdit() {
  const m = store.mapping, c = store.cfg;
  openId = null; mapDrawer = { kind: 'lead', mode: 'edit', draft: { leadDays: String(m.leadDays), cutoffTime: c.cutoffTime || '15:00', closedText: (c.closedDates || []).join('\n'), overrides: (m.leadOverrides || []).map(o => ({ from: o.from, to: o.to, days: String(o.days), codes: (o.codes || []).join(',') })) } };
  renderDrawer();
}
// 閉じる。編集中なら確認する。閉じたら true
function closeMapDrawer() {
  if (!mapDrawer) return true;
  if (mapDrawer.mode === 'edit' && !confirm('編集中の内容は保存されません。閉じますか？')) return false;
  mapDrawer = null; renderDrawer(); return true;
}
function lineHtml(l) {
  if (l.text) return '<div class="rc-l muted">' + esc(l.text) + '</div>';
  return '<div class="rc-l"><span class="tag info">' + esc(l.role) + '</span> ' + (l.found === false ? '<b class="bad">' + esc(l.code) + '</b> <span class="bad">品目マスタにありません</span>' : '<b>' + esc(l.code) + '</b> ' + esc(l.name)) +
    ' <span class="muted">' + esc(l.qty) + '・' + esc(l.price) + (l.found !== false && (l.unit || l.teihai) ? '・単位 ' + esc(l.unit || '—') + '／手配区分 ' + esc(l.teihai || '—') : '') + '</span></div>';
}
function stackHtml(d) {
  let html = '', tree = '';
  d.lines.forEach(l => { if (l.role === '＋セット内') tree += lineHtml(l); else { if (tree) { html += '<div class="rc-tree">' + tree + '</div>'; tree = ''; } html += lineHtml(l); } });
  return html + (tree ? '<div class="rc-tree">' + tree + '</div>' : '');
}
function itemHint(code) {
  if (!code || !M.items) return '';
  const it = EcSettings.itemInfo(M.items, code);
  return it.found ? esc(it.name) + '　単位 ' + esc(it.unit || '—') + '／手配区分 ' + esc(it.teihai || '—') : '<span class="bad">品目マスタにありません</span>';
}
function updateHints() {
  const md = mapDrawer; if (!md || md.kind !== 'rule' || md.mode !== 'edit') return;
  const d = md.draft; if ($('hint-main')) $('hint-main').innerHTML = itemHint(d.code);
  d.includes.forEach((x, i) => { if ($('hint-i' + i)) $('hint-i' + i).innerHTML = itemHint(x.code); });
}
function combosHtml(rule, mapping) {
  const list = EcSettings.comboStats(rule, orders, mapping, 5);
  return list.length ? list.map(c => '<div class="combo"><div>' + esc(c.productName) + ' <span class="muted">' + c.count + '件（最近 ' + esc(c.last) + '）</span></div><div class="muted">→ ' + c.items.map(i => esc(i.code) + '×' + i.qty + '（' + esc(i.label) + '）').join('、') + '</div></div>').join('') : '<div class="muted">' + (orders.length ? '直近の注文に、このルールで当たったものはありません' : 'Shopify の注文を読み込むと、ここに表示されます') + '</div>';
}
function recentHtml(rule, mapping) {
  const list = EcSettings.recentMatches(rule, orders, mapping, 5);
  return list.length ? list.map(x => '<div>' + esc(x.orderName) + ' <span class="muted">' + esc(x.date) + '</span> ' + esc(x.productName) + '</div>').join('') : '<div class="muted">' + (orders.length ? '直近の注文に、このルールで当たったものはありません' : 'Shopify の注文を読み込むと、ここに表示されます') + '</div>';
}
function renderMapDrawer() {
  const dr = $('drawer'), sc = $('scrim'), md = mapDrawer;
  dr.hidden = sc.hidden = false; dr.classList.add('wide'); md.rendered = true;
  const ed = canEditSettings(), inp = (k, v, ex) => '<input type="text" data-md="' + k + '" value="' + esc(v) + '" style="width:100%"' + (ex || '') + '>';
  const close = '<button class="btn sec sm" data-mdclose>閉じる</button>';
  if (md.kind === 'lead') {
    const d = md.draft;
    dr.innerHTML = '<div class="row"><h2>出荷予定日の決め方を編集</h2><div class="grow"></div>' + close + '</div>' +
      '<h3>基本</h3><dl><dt>締め時刻</dt><dd><input type="time" data-md="cutoffTime" value="' + esc(d.cutoffTime) + '" style="width:120px"> 以降に取込を押した受注は、受注日付を翌営業日にする</dd>' +
      '<dt>既定の納期</dt><dd><input type="text" inputmode="numeric" data-md="leadDays" value="' + esc(d.leadDays) + '" style="width:70px"> 営業日（受注日付から数える。品目ごとの日数は、各ルールの「納期」で決める）</dd></dl>' +
      '<h3>期間の例外（在庫の都合など）</h3><div class="muted" style="margin-bottom:4px">品目コードは , 区切り。空なら全品目。</div>' +
      (d.overrides.map((o, i) => '<div class="row" style="margin-bottom:4px"><input type="date" data-md="from" data-oi="' + i + '" value="' + esc(o.from) + '"> 〜 <input type="date" data-md="to" data-oi="' + i + '" value="' + esc(o.to) + '"> <input type="text" inputmode="numeric" data-md="days" data-oi="' + i + '" value="' + esc(o.days) + '" style="width:56px"> 営業日 <input type="text" data-md="codes" data-oi="' + i + '" value="' + esc(o.codes) + '" placeholder="品目コード（空=全部）" size="26"><button class="btn sec sm" data-mdact="ovdel" data-oi="' + i + '">削除</button></div>').join('') || '<div class="muted">例外はありません</div>') +
      '<div style="margin-top:6px"><button class="btn sec sm" data-mdact="ovadd">＋ 例外を追加</button></div>' +
      '<h3>個別に追加する休み</h3><div class="muted" style="margin-bottom:4px">共通予定表（Outlook）に入っていない日だけ。1行に1日、YYYY-MM-DD。全員に反映されます。</div><textarea data-md="closedText" rows="4" style="width:100%">' + esc(d.closedText) + '</textarea>' +
      '<div class="row" style="margin-top:16px;gap:8px"><button class="btn" data-mdact="leadreview">確認へ</button><button class="btn sec" data-mdact="cancel">キャンセル</button></div>';
    return;
  }
  const rules = store.mapping.rules, orig = rules.find(r => r.id === md.id);
  if (md.mode === 'view') {
    if (!orig) { mapDrawer = null; dr.hidden = sc.hidden = true; return; }
    const d = EcSettings.describeRule(orig, M.items, store.mapping.leadDays), i = rules.indexOf(orig), rel = EcSettings.relatedRules(orig, rules);
    dr.innerHTML = '<div class="row"><h2>' + esc(orig.label) + '</h2><span class="tag info">' + esc(d.scopeLabel) + '</span><div class="grow"></div>' + (ed ? '<button class="btn" data-mdact="edit">編集</button>' : '') + close + '</div>' +
      '<div class="muted">上から ' + (i + 1) + ' 番目（上から順に、最初に当たった行を使います）</div>' + (ed ? '' : '<div class="muted">編集は担当者が行います</div>') +
      '<div class="mcard shop"><h3>Shopify：商品名がこうなら</h3><div>' + esc(d.words) + '</div><div class="muted">' + (orig.scope === 'body' ? '商品名の「 - 」より前（本体）を見ます' : orig.scope === 'option' ? '商品名の「 - 」より後（オプション）を見ます' : '商品名ぜんたいを見ます') + '</div></div>' +
      '<div class="mcard smile"><h3>SMILE：入る内容</h3>' + stackHtml(d) +
      '<h3>納期</h3><div>' + esc(d.lead) + '</div>' + (d.note ? '<h3>メモ</h3><div>' + esc(d.note) + '</div>' : '') + '</div>' +
      (rel.length ? '<h3>関連するルール</h3>' + rel.map(x => '<div><button class="btn sec sm" data-rulelink="' + esc(x.id) + '">' + esc(x.label) + '</button> <span class="muted">' + esc(x.scopeLabel) + (x.swap ? '（色の差し替え）' : '') + '</span></div>').join('') : '') +
      '<h3>実際の注文での組み合わせ（直近の注文）</h3>' + combosHtml(orig, store.mapping) +
      '<h3>このルールで当たる最近の注文</h3>' + recentHtml(orig, store.mapping);
    return;
  }
  // 編集（新規も同じ）
  const d = md.draft, sc0 = d.scope, mp = proposedMapping(d);
  const sel = (k, opts, v, re) => '<select data-md="' + k + '"' + (re ? ' data-mdre' : '') + ' style="width:auto">' + opts.map(([a, b]) => '<option value="' + a + '"' + (v === a ? ' selected' : '') + '>' + b + '</option>').join('') + '</select>';
  const row = (lb, html) => '<dt>' + lb + '</dt><dd>' + html + '</dd>';
  dr.innerHTML = '<div class="row"><h2>' + (md.isNew ? 'ルールを追加' : esc(orig ? orig.label : '') + ' を編集') + '</h2><div class="grow"></div>' + close + '</div>' +
    '<div class="mcard shop"><h3>Shopify：商品名の条件</h3><dl style="grid-template-columns:120px 1fr">' +
    row('区分', sel('scope', [['body', '本体'], ['option', 'オプション'], ['single', '単品']], sc0, true)) +
    row('名前', inp('label', d.label, ' placeholder="見やすい名前"')) +
    row('商品名の言葉', inp('wordsText', d.wordsText, ' placeholder="例：ブラック、BK（、で区切る）"') + '<div class="row" style="gap:6px;margin-top:4px">' + sel('match', [['contains', '含む'], ['starts', 'この言葉で始まる'], ['exact', 'ちょうど同じ']], d.match, false) +
      '</div>' + (d.pattern && !d.wordsText.trim() ? '<div class="muted">詳細な指定（旧）：' + esc(d.pattern) + '</div>' : '')) + '</dl></div>' +
    '<div class="mcard smile"><h3>SMILE：入る内容</h3><dl style="grid-template-columns:120px 1fr">' +
    (sc0 === 'option' && (d.hasSwap || d.swapFrom || d.swapTo) ? row('色の差し替え', '<input type="text" data-md="swapFrom" value="' + esc(d.swapFrom) + '" size="10"> → <input type="text" data-md="swapTo" value="' + esc(d.swapTo) + '" size="10"> <span class="muted">セット内の品目を、オプションの文言で差し替える</span>') : '') +
    row('品目コード', inp('code', d.code, ' placeholder="SMILE の品目コード"') + '<div class="muted" id="hint-main">' + itemHint(d.code) + '</div>') +
    (sc0 === 'option' ? row('数量', sel('qtyMode', [['fixed', '固定'], ['unit', '商品名の言葉の中の「N個」']].concat(d.qtyMode === 'g1' ? [['g1', '言葉の中の数字（旧）']] : []), d.qtyMode, true) +
      (d.qtyMode === 'unit' ? ' 単位 <input type="text" data-md="qtyUnit" value="' + esc(d.qtyUnit) + '" placeholder="例：個" size="3"> <span class="muted">言葉の直後の「2個」の2が数量になります</span>' : d.qtyMode === 'fixed' ? ' <input type="text" inputmode="numeric" data-md="qty" value="' + esc(d.qty) + '" style="width:60px"> <span class="muted">注文の数量にかけます</span>' : '')) : '') +
    row('標準単価（税抜）', '<input type="text" inputmode="decimal" data-md="net" value="' + esc(d.net) + '" style="width:120px"> <span class="muted">' + (sc0 === 'body' ? '空欄＝注文の合計から計算（値引きは本体が吸収）' : '空欄＝商品の値段から計算') + '</span>') +
    (sc0 === 'body' ? row('セット内', d.includes.map((x, i) => '<div class="row" style="gap:6px;margin-bottom:3px"><input type="text" data-md="code" data-mi="' + i + '" value="' + esc(x.code) + '" size="10" placeholder="品目コード"> ×<input type="text" inputmode="numeric" data-md="qty" data-mi="' + i + '" value="' + esc(x.qty) + '" style="width:44px"> 単価<input type="text" inputmode="decimal" data-md="net" data-mi="' + i + '" value="' + esc(x.net) + '" style="width:80px"><button class="btn sec sm" data-mdact="incdel" data-mi="' + i + '">削除</button></div><div class="muted" id="hint-i' + i + '" style="margin:-2px 0 4px">' + itemHint(x.code) + '</div>').join('') + '<button class="btn sec sm" data-mdact="incadd">＋ セット内の品目を足す</button>') : '') +
    row('納期（営業日）', '<input type="text" inputmode="numeric" data-md="leadDays" value="' + esc(d.leadDays) + '" style="width:70px" placeholder="既定' + store.mapping.leadDays + '"> <span class="muted">空欄＝既定</span>') +
    row('メモ', inp('note', d.note, ' placeholder="確認の文言・申し送り"')) + '</dl></div>' +
    '<h3>順番</h3><div class="row" style="gap:6px">上から <b>' + (Math.min(d.pos, store.mapping.rules.length - (md.isNew ? 0 : 1)) + 1) + '</b> 番目 <button class="btn sec sm" data-mdact="up">↑ 上へ</button><button class="btn sec sm" data-mdact="down">↓ 下へ</button><span class="muted">上から順に、最初に当たった行を使います</span></div>' +
    '<h3>判定テスト（この内容で、商品名がどうなるか）</h3><input type="text" data-md="tryText" value="' + esc(d.tryText) + '" style="width:100%" placeholder="Shopify の商品名を貼る"><div id="mdTest" style="margin-top:6px"></div>' +
    '<h3>このルールで当たる最近の注文</h3><div id="mdRecent">' + recentHtml(mp.rule, mp.mapping) + '</div>' +
    '<div class="row" style="margin-top:18px;gap:8px"><button class="btn" data-mdact="review">確認へ</button><button class="btn sec" data-mdact="cancel">キャンセル</button><div class="grow"></div>' + (md.isNew ? '' : '<button class="btn sec" data-mdact="del" style="color:var(--red)">このルールを削除</button>') + '</div>';
  updateDraftTest();
}
function updateDraftTest() {
  const md = mapDrawer; if (!md || md.kind !== 'rule' || md.mode !== 'edit') return;
  updateHints();
  const mp = proposedMapping(md.draft);
  if ($('mdTest')) $('mdTest').innerHTML = md.draft.tryText ? tryHtml(md.draft.tryText, mp.mapping) : '<span class="muted">商品名を入れると、本体とオプションに分けて、どの品目・数量になるかを表示します</span>';
  if ($('mdRecent')) $('mdRecent').innerHTML = recentHtml(mp.rule, mp.mapping);
}
function mdInput(t) {
  const md = mapDrawer; if (!md || !md.draft) return;
  const d = md.draft, k = t.dataset.md;
  if (md.kind === 'lead') { if (t.dataset.oi !== undefined) d.overrides[+t.dataset.oi][k] = t.value; else d[k] = t.value; return; }
  if (t.dataset.mi !== undefined) d.includes[+t.dataset.mi][k] = t.value; else d[k] = t.value;
  if (k === 'scope' && d.scope !== 'option') { d.qtyUnit = ''; }
  updateDraftTest();
}
function reviewRule() {
  const md = mapDrawer, d = md.draft, orig = store.mapping.rules.find(r => r.id === d.id), mp = proposedMapping(d);
  const errs = EcSettings.validateRule(mp.rule, M.items);
  const dup = store.mapping.rules.some(r => r.id !== d.id && r.scope === mp.rule.scope && (r.words || []).length && JSON.stringify(r.words) === JSON.stringify(mp.rule.words) && r.match === mp.rule.match);
  const warns = [];
  if (dup) warns.push('同じ区分・同じ言葉のルールがすでにあります（上にあるほうが先に使われます）');
  const codes = [mp.rule.code].concat((mp.rule.includes || []).map(x => x.code)).filter(Boolean);
  if (M.items) codes.filter(c => !M.items[c]).forEach(c => warns.push('品目コード ' + c + ' は品目マスタにありません'));
  const after = curSettings(); after.mapping = mp.mapping;
  reviewSettings({ before: curSettings(), after, errors: errs, warns, title: md.isNew ? 'この内容でルールを追加しますか？' : 'この内容でルールを変更しますか？', onSaved: () => { mapDrawer = md.isNew ? null : { kind: 'rule', id: d.id, mode: 'view' }; renderDrawer(); } });
}
function reviewLead() {
  const d = mapDrawer.draft, errs = [], after = curSettings();
  const ld = d.leadDays.trim() === '' ? NaN : +d.leadDays;
  if (!(isFinite(ld) && ld >= 0 && Math.floor(ld) === ld)) errs.push('既定の納期は 0 以上の整数で入れてください'); else after.mapping.leadDays = ld;
  if (!/^\d\d:\d\d$/.test(d.cutoffTime)) errs.push('締め時刻を入れてください'); else after.cfg.cutoffTime = d.cutoffTime;
  const dates = d.closedText.split(/\s+/).filter(Boolean), bad = dates.filter(x => !/^\d{4}-\d\d-\d\d$/.test(x));
  if (bad.length) errs.push('日付の形が違います：' + bad.join('、') + '（YYYY-MM-DD）'); else after.cfg.closedDates = Array.from(new Set(dates)).sort();
  after.mapping.leadOverrides = d.overrides.map((o, i) => {
    const days = o.days.trim() === '' ? NaN : +o.days;
    if (!o.from || !o.to) errs.push('例外 ' + (i + 1) + '：期間を入れてください'); else if (o.from > o.to) errs.push('例外 ' + (i + 1) + '：期間の終わりが始まりより前です');
    if (!(isFinite(days) && days >= 0 && Math.floor(days) === days)) errs.push('例外 ' + (i + 1) + '：営業日は 0 以上の整数で入れてください');
    return { from: o.from, to: o.to, days, codes: o.codes.split(',').map(x => x.trim()).filter(Boolean) };
  });
  reviewSettings({ before: curSettings(), after, errors: errs, title: 'この内容で出荷予定日の決め方を変更しますか？', onSaved: () => { mapDrawer = null; renderDrawer(); } });
}
function reviewLegacy() {
  const lg = store.legacy, plan = lg && EcSettings.migrationPlan(lg, baseSettings());
  if (!plan || !plan.needed) { alert('この端末の対応表は、既定と同じです'); delete store.legacy; save(); render(); return; }
  const after = baseSettings(); after.mapping = clone(lg.mapping);
  after.cfg.cutoffTime = (lg.cfg || {}).cutoffTime || after.cfg.cutoffTime; after.cfg.closedDates = (lg.cfg || {}).closedDates || after.cfg.closedDates || [];
  reviewSettings({ before: baseSettings(), after, title: 'この端末の対応表を、共有に保存しますか？', note: 'この端末のブラウザに残っていた対応表・設定を、全員で使う共有ファイルにします。下は、既定との違いです。', onSaved: () => { delete store.legacy; save(); } });
}
function mapAction(act, t) {
  const md = mapDrawer, d = md && md.draft;
  switch (act) {
    case 'edit': { const r = store.mapping.rules.find(x => x.id === md.id); md.mode = 'edit'; md.draft = ruleDraft(r, store.mapping.rules.indexOf(r)); md.rendered = false; renderDrawer(); break; }
    case 'cancel': if (md.isNew || md.kind === 'lead') { mapDrawer = null; renderDrawer(); } else { md.mode = 'view'; delete md.draft; md.rendered = false; renderDrawer(); } break;
    case 'review': reviewRule(); break;
    case 'leadedit': startLeadEdit(); break;
    case 'leadreview': reviewLead(); break;
    case 'up': d.pos = Math.max(0, d.pos - 1); renderMapDrawer(); break;
    case 'down': d.pos = Math.min(store.mapping.rules.length - (md.isNew ? 0 : 1), d.pos + 1); renderMapDrawer(); break;
    case 'incadd': d.includes.push({ code: '', qty: '1', net: '' }); renderMapDrawer(); break;
    case 'incdel': d.includes.splice(+t.dataset.mi, 1); renderMapDrawer(); break;
    case 'ovadd': d.overrides.push({ from: today(), to: today(), days: '3', codes: '' }); renderMapDrawer(); break;
    case 'ovdel': d.overrides.splice(+t.dataset.oi, 1); renderMapDrawer(); break;
    case 'del': {
      const r = store.mapping.rules.find(x => x.id === md.id); if (!r) return;
      if (!confirm('ルール「' + r.label + '」を削除します。次の画面で内容を確認してから保存します。よろしいですか？')) return;
      const after = curSettings(); after.mapping.rules = after.mapping.rules.filter(x => x.id !== md.id);
      reviewSettings({ before: curSettings(), after, title: 'このルールを削除しますか？', onSaved: () => { mapDrawer = null; renderDrawer(); } }); break;
    }
    case 'reset':
      if (!canEditSettings()) return;
      reviewSettings({ before: curSettings(), after: baseSettings(), title: '対応表・設定を初期値に戻しますか？', note: '共有ファイルを、ec_sales_config.json の既定の内容で上書きします。下は、いまの内容との違いです。' }); break;
  }
}
function mapRulesHtml() {
  const m = store.mapping, rules = m.rules, S = EcSettings, shown = new Set(S.searchRules(rules, mapQ)), stats = S.optionStats(orders, m);
  let out = '';
  [['body', '本体（Shopify の商品＝本体の部分）'], ['option', 'オプション（商品名の「 - 」より後ろ）'], ['single', '単品（商品名ぜんたい）']].forEach(([sc, lb]) => {
    const idx = rules.map((r, i) => i).filter(i => rules[i].scope === sc && shown.has(i));
    if (!idx.length) return;
    out += '<h3 style="margin:14px 0 2px;font-size:13px;color:var(--sub)">' + lb + '　' + idx.length + '件</h3>';
    idx.forEach(i => {
      const r = rules[i], d = S.describeRule(r, M.items, m.leadDays), top = sc === 'body' ? S.topOptions(stats, r.id, rules, 3) : [], nl = d.lines.filter(l => !l.text).length;
      out += '<div class="rcard sc-' + sc + '" data-maprule="' + esc(r.id) + '"><div class="rc-head"><span class="num">' + (i + 1) + '</span><b>' + esc(r.label) + '</b><span class="tag info">' + esc(d.scopeLabel) + '</span><span class="grow"></span><span class="muted">納期 ' + esc(d.lead) + '</span></div>' +
        '<div class="rc-pair"><div class="rc-sh"><div class="rc-ph">Shopify（この言葉があれば）</div><div class="rc-words">' + esc(d.words) + '</div></div><div class="rc-ar">→</div>' +
        '<div class="rc-sm"><div class="rc-ph">SMILE' + (nl > 1 ? '（' + nl + '行になります）' : '') + '</div><div class="rc-lines">' + stackHtml(d) + '</div></div></div>' +
        (top.length ? '<div class="rc-foot">よく一緒に付くオプション：' + top.map(x => esc(x.label) + ' ' + x.count + '件').join('／') + '</div>' : '') +
        (d.note ? '<div class="rc-foot">メモ：' + esc(d.note) + '</div>' : '') + '</div>';
    });
  });
  return out || '<div class="empty">当てはまるルールがありません</div>';
}
function renderMap() {
  // タブの数字（対応表にない商品の種類）は、見えていないときも更新する。表の中身は、見えるときだけ作る
  const un = {};
  slips.forEach(s => { if (stateOf(s) === 'excluded' || s.inSmile || stateOf(s) === 'exported') return; s.flags.forEach(f => { if (f.text.startsWith('対応表にない商品：')) { const k = f.text.slice(9); un[k] = (un[k] || 0) + 1; } }); });
  const keys = Object.keys(un);
  $('cnt-map').textContent = keys.length;
  if (curTab !== 'map') return;
  const m = store.mapping, S = EcSettings, ed = canEditSettings(), c = store.cfg, info = settingsInfo;
  // 共有の状態
  let st = '';
  if (info.state === 'offline') st = '<div class="alert err" style="margin-bottom:8px">共有の設定に接続できません。いまは既定の設定で動いています（直しても保存できません）。' + esc(info.error) + '</div>';
  else st = '<div class="muted" style="margin-bottom:8px">' + (info.state === 'shared' ? '共有の設定（SharedMasters）：最終更新 ' + esc(stamp(info.updatedAt)) + ' ' + esc(EC.shortUser(info.updatedBy)) : '共有の設定ファイルはまだありません（既定の設定で動いています）') + '／' + (ed ? 'あなたは設定を編集できます' : '編集は担当者が行います') + '</div>';
  const lgPlan = store.legacy && info.state === 'default' && ed ? S.migrationPlan(store.legacy, baseSettings()) : null;
  if (store.legacy && info.state === 'default' && ed && lgPlan && !lgPlan.needed) { delete store.legacy; save(); }
  if (lgPlan && lgPlan.needed) st += '<div class="alert warn" style="margin-bottom:8px">この端末に、以前の対応表・設定が残っています（既定との違い ' + lgPlan.diff.count + '件）。<button class="btn sec sm" data-mdact="legacy">共有に保存する…</button> <button class="btn sec sm" data-mdact="legacydrop">使わない</button></div>';
  $('mapShared').innerHTML = st;
  // 納期
  const ov = (m.leadOverrides || []), cd = c.closedDates || [];
  $('leadBox').innerHTML = '<div class="row"><h2 style="margin:0">出荷予定日の決め方</h2><div class="grow"></div>' + (ed ? '<button class="btn sec sm" data-mdact="leadedit">編集</button>' : '') + '</div>' +
    '<dl style="display:grid;grid-template-columns:130px 1fr;gap:4px 12px;margin:8px 0;font-size:13px"><dt class="muted">締め時刻</dt><dd style="margin:0">' + esc(c.cutoffTime || CONF.config.cutoffTime) + ' 以降に取込を押した受注は、受注日付を翌営業日にする</dd>' +
    '<dt class="muted">既定の納期</dt><dd style="margin:0">受注日付から ' + m.leadDays + ' 営業日後（品目ごとの日数は、下の対応表の「納期」。複数の品目があるときは、いちばん長い日数）</dd>' +
    '<dt class="muted">期間の例外</dt><dd style="margin:0">' + (ov.length ? ov.map(o => esc(o.from + ' 〜 ' + o.to) + '：' + o.days + '営業日（' + ((o.codes || []).length ? esc(o.codes.join(',')) : '全品目') + '）').join('<br>') : 'ありません') + '</dd>' +
    '<dt class="muted">個別の休み</dt><dd style="margin:0">' + (cd.length ? esc(cd.join('、')) : 'ありません') + '</dd></dl>';
  $('cal-status').textContent = calInfo;
  const today0 = today(), up = outlookClosed.filter(x => x >= today0).slice(0, 12);
  $('cal-list').innerHTML = up.length ? '今後の休業日：' + up.map(x => esc(md(x)) + ' ' + esc((window.__closedNames || {})[x] || '')).join('、') : '';
  // 対応表
  $('map-add').hidden = !ed; $('map-reset').hidden = !ed;
  $('rules').innerHTML = mapRulesHtml();
  // 対応表にない商品（un・keys は、上で数えたもの）
  $('unmapped').innerHTML = keys.length ? '<h2>対応表にない商品（' + keys.length + '種）</h2>' + keys.map(k => '<div><span class="tag err">' + un[k] + '件</span> ' + esc(k) + ' <button class="btn sec sm" data-try="' + esc(k) + '">判定を見る</button>' + (ed ? ' <button class="btn sec sm" data-newrule="' + esc(k) + '">ルールを足す</button>' : '') + '</div>').join('') + '<div class="muted" style="margin-top:6px">ルールを足すと、該当の注文が自動で直ります。' + (ed ? '' : '足すのは担当者が行います。') + '</div>' : '<h2>対応表にない商品</h2><div class="muted">ありません</div>';
}
function tryHtml(name, mapping) {
  const m = EC.mapLine({ name, qty: 1, price: 0 }, mapping, today());
  const s = EC.splitName(name, today());
  return '本体の部分：<b>' + esc(s.body) + '</b>／オプションの部分：<b>' + esc(s.option || '（なし）') + '</b><br>' +
    (m.items.length ? m.items.map(i => esc(i.code || '') + ' ×' + i.qty + '（' + esc(i.label) + (i.net != null ? '・' + yen(i.net) : '') + '）').join('<br>') : '<span class="bad">当たる行がありません</span>') +
    m.unknown.map(u => '<div class="bad">未対応：' + esc(u) + '</div>').join('') + m.warns.map(u => '<div class="tag warn">' + esc(u) + '</div>').join('');
}
function tryName(name) { $('try-out').innerHTML = tryHtml(name, store.mapping); }

/* ------------------------------------------------------------ 描画：入金（総務） */
function custOfOrder(name) {
  const k = name.replace(/\D/g, '');
  if (M.smileCust && M.smileCust[k]) return M.smileCust[k];
  const o = orderIndex[k];
  return o ? EC.customerFor(o.createdAt, store.cfg) : store.cfg.defaultCustomer;
}
let payGroups = [];
function renderPay() {
  if (!$('pay-from').value) $('pay-from').value = EC.addDays(today(), -45);
  if (!payTx || !payouts) { $('payList').innerHTML = '<div class="empty">Shopify の入金 CSV と入金の中身 CSV を入れてください</div>'; $('cnt-pay').textContent = 0; renderPayBar(); return; }
  const from = $('pay-from').value;
  payGroups = EC.groupPayouts(payTx, payouts, custOfOrder).filter(g => g.date >= from);
  let n = 0, html = '';
  payGroups.forEach(g => g.parts.forEach(p => {
    const key = g.date + '|' + p.cust, smile = M.nyukin && M.nyukin[p.cust + '|' + g.date];
    const paid = g.status === 'paid', can = paid && g.match && !smile;
    if (can) n++;
    html += '<tr><td><input type="checkbox" data-pay="' + key + '"' + (can ? ' checked' : '') + (paid && g.match ? '' : ' disabled') + '></td><td>' + g.date + '</td><td>' + esc(store.cfg.customers[p.cust].short) + '</td><td class="num">' + p.orders.length + '件</td>' +
      '<td class="num">' + yen(p.amount) + '</td><td class="num">' + yen(p.fee) + '</td><td class="num"><b>' + yen(p.net) + '</b></td>' +
      '<td>' + (!paid ? '<span class="tag warn">' + esc(g.status || '入金未確認') + '</span>' : g.match ? '<span class="tag ok">Shopify入金額と一致</span>' : '<span class="tag err">不一致（入金 ' + yen(g.bank) + ' / 取引計 ' + yen(g.total) + '）</span>') + '</td>' +
      '<td>' + (smile ? '<span class="tag warn">SMILEに同日の入金あり ' + smile.map(yen).join(',') + '</span>' : (M.nyukin ? '<span class="tag info">なし</span>' : '<span class="muted">確認できず</span>')) + '</td></tr>';
  }));
  $('cnt-pay').textContent = n;
  $('payList').innerHTML = '<div style="overflow:auto"><table><thead><tr><th></th><th>入金日</th><th>得意先</th><th class="num">注文</th><th class="num">売上</th><th class="num">手数料</th><th class="num">振込（純額）</th><th>Shopify側の確認</th><th>SMILE側</th></tr></thead><tbody>' + html + '</tbody></table></div>' +
    '<div class="muted" style="margin-top:6px">SMILE側の確認は 入金明細出力.csv（' + (stamp(M.stamps.nyukin) || '読めていません') + ' 時点）で見ています。' + (M.stamps.nyukin && Date.now() - Date.parse(M.stamps.nyukin) > 3 * 864e5 ? '<b class="bad">データが古いので、取り込む前に SMILE で同じ日の入金がないか確認してください。</b>' : '') + '<br>通帳（普通預金）の入金との突合は次の段階で足します。いまは Shopify の入金額との一致を見ています。</div>';
  renderPayBar();
}
function renderPayBar() {
  const bar = $('outbar');
  if (curTab !== 'pay') return;
  const picked = [...document.querySelectorAll('[data-pay]:checked')].length;
  bar.hidden = false;
  bar.innerHTML = '<div><b>選択 ' + picked + '件</b> <span class="muted">振込＝純額・支払手数料の2行で1伝票</span></div><div class="grow"></div><button class="btn" id="o-pay"' + (picked ? '' : ' disabled') + '>入金伝票ファイルを保存</button>';
}
function outPay() {
  const keys = new Set([...document.querySelectorAll('[data-pay]:checked')].map(e => e.dataset.pay));
  const groups = payGroups.map(g => ({ date: g.date, parts: g.parts.filter(p => keys.has(g.date + '|' + p.cust)) })).filter(g => g.parts.length);
  if (!groups.length) return;
  download('入金伝票_取込_SHOPIFY_' + stampName() + '.txt', EC.encodeUtf16(EC.toSmileText(LAY.nyukin, EC.nyukinRows(groups, LAY.nyukin, store.cfg))));
}

/* ------------------------------------------------------------ 全体 */
// 出荷チェック（ec_ship_tab.js）：受注を SMILE に起票した注文の、出荷伝票・送り状番号を、専用機が毎時作る ship_index.json から見せる
// 出荷チェックの「報告済み」の印（EC＝Shopify に送り状№を登録した／ふるさと＝サイネックスに出荷報告した）。共有のリストに残る
async function markShipReported(ids, on) {
  lastPushErr = null;
  const at = new Date().toISOString(), who = account && account.username;
  await commit({ ids, action: 'その他', detail: () => on ? '出荷報告済みにした' : '出荷報告済みを戻した',
    mutate: id => { const r = store.orders[id] = store.orders[id] || (() => { const s = slips.find(x => x.id === id); return s ? { cust: s.cust, orderDate: s.orderDate, net: s.netTotal } : {}; })(); if (on) { r.shipReportedAt = at; r.shipReportedBy = who; } else { delete r.shipReportedAt; delete r.shipReportedBy; } return true; } });
  await pushChain;
  if (lastPushErr) { const m = String(lastPushErr && lastPushErr.message || lastPushErr); lastPushErr = null;
    alert(['この端末には記録しましたが、共有のリストに保存できませんでした（他の人には反映されません）。', '注文のリストに、列「ShipReportedBy」「ShipReportedAt」が無い可能性があります。専用機に列の追加を依頼してください。', '', m.slice(0, 200)].join(String.fromCharCode(10))); }
}
// サイネックスへの出荷報告：Excel を作り、添付した Outlook の下書きを自分のメールボックスに作る（送信は人が押す）。
// 下書きを作れない（権限がない等）ときは、Excel をダウンロードして、メールは手で作る
const MAIL_SCOPES = ['Mail.ReadWrite'];
async function getMailToken() {
  try { return (await msalInstance.acquireTokenSilent({ scopes: MAIL_SCOPES, account })).accessToken; }
  catch { return (await msalInstance.acquireTokenPopup({ scopes: MAIL_SCOPES })).accessToken; }
}
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((ok, ng) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = ok; s.onerror = () => ng(new Error('Excel の部品を読み込めません')); document.head.appendChild(s); });
}
async function makeShipMail(items) {
  if (!items.length) return false;
  const rep = FurusatoShipReport.build({ items, conf: CONF });
  await loadXLSX();
  const ws = XLSX.utils.aoa_to_sheet(rep.aoa); ws['!cols'] = rep.aoa[0].map((_, i) => (rep.widths[i] ? { wch: rep.widths[i] } : undefined));   // 幅を決めない列は、空の指定を書かない（空だと、Excel が幅0＝隠れた列として開く）
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + await getMailToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: rep.subject, body: { contentType: 'HTML', content: rep.bodyHtml },
        toRecipients: rep.to.map(a => ({ emailAddress: { address: a } })), ccRecipients: rep.cc.map(a => ({ emailAddress: { address: a } })),
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: rep.fileName, contentType: XLSX_TYPE, contentBytes: b64 }] }) });
    if (!r.ok) throw new Error('Graph ' + r.status);
    const m = await r.json();
    if (m.webLink) window.open(m.webLink, '_blank', 'noopener');
    alert('Outlook に下書きを作りました（' + rep.count + '行・' + rep.orders + '件）。\n内容を確認して、送信してください。\n件名：' + rep.subject);
    return true;
  } catch (e) {
    console.warn('下書きを作れません', e);
    const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    download(rep.fileName, u8, XLSX_TYPE);
    alert('Outlook の下書きは作れませんでした（メールの権限がない可能性があります）。\nExcel をダウンロードしたので、メールに添付して送ってください。\n宛先：' + rep.to.join('、') + '\nCc：' + rep.cc.join('、') + '\n件名：' + rep.subject);
    return true;
  }
}
/* ------------------------------------------------------------ 出荷チェック：Shopify に送り状番号を自動で登録する
   「Shopify に自動で登録する」→ 確認の画面（注文・運送会社・送り状番号／お客様への通知）→ 専用機に依頼（ジョブ ec_shopify_fulfill）→ 結果（SharedMasters/_ec_fulfill/<batchId>/result.json）。
   成功（done）と、すでにあった（already）注文は、「Shopify に登録済み」にする（確認のみのときは、しない）。
   画面を閉じても、専用機の処理は続く。もう一度押すと、登録済み（already）と確かめられて、「登録済み」になる。
   約束事：scripts/rpa_setup/ec_shopify_fulfill_setup.md */
const FUL_STATUS = { done: ['登録しました', 'ok'], already: ['すでに登録されています', 'ok'], skipped: ['人が登録してください', 'warn'], error: ['エラー', 'err'] };
function fulfillOverlay(html) {
  let ov = document.getElementById('fulfillDlg');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'fulfillDlg';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(22,26,61,.5);z-index:70;display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
  }
  ov.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:760px;width:100%;padding:20px 24px;max-height:90vh;overflow:auto">' + html + '</div>';
  return ov;
}
function fulfillClose() { const ov = document.getElementById('fulfillDlg'); if (ov) ov.remove(); }
function fulfillTable(rows) {
  return '<table style="width:100%;border-collapse:collapse;margin:8px 0"><thead><tr><th style="text-align:left">注文</th><th style="text-align:left">運送会社</th><th style="text-align:left">送り状番号</th><th style="text-align:left">結果</th></tr></thead><tbody>' +
    rows.map(r => '<tr><td><b>#' + esc(r.id) + '</b></td><td>' + esc(r.carrier || '') + '</td><td>' + esc(r.fmt || '') + '</td><td>' + (r.html || '') + '</td></tr>').join('') + '</tbody></table>';
}
// 確認の画面。選んだ答えを返す：{ run: true/false, dryRun, notify }。やめるときは null
function fulfillConfirm(plan, fconf) {
  return new Promise(resolve => {
    const rows = plan.orders.map(o => ({ id: o.id, carrier: o.carrier, fmt: o.fmt, html: '<span class="muted">登録します</span>' }))
      .concat(plan.skipped.map(s => ({ id: s.id, html: '<span class="tag warn">対象外</span> ' + esc(s.reason) })));
    const ov = fulfillOverlay('<h2 style="margin:0 0 6px;font-size:16px">Shopify に送り状番号を登録します</h2>' +
      '<div class="muted">専用機が、Shopify の注文を「発送済み」にして、運送会社・送り状番号・追跡URLを付けます（いまの手作業と同じ内容）。</div>' +
      fulfillTable(rows) +
      '<label style="display:block;margin:8px 0"><input type="checkbox" id="ful-notify" checked> お客様に、Shopify から<b>発送通知メール</b>を送る（いまの手作業と同じ。外すと、お客様には届きません）</label>' +
      '<div class="muted" style="margin:4px 0 10px">最初は「確認のみ」で、Shopify に何も書き込まずに、結果だけを見られます。</div>' +
      '<div class="row" style="gap:8px;justify-content:flex-end"><button class="btn sec" id="ful-cancel">やめる</button><button class="btn sec" id="ful-dry">確認のみ（書き込まない）</button>' +
      '<button class="btn" id="ful-go"' + (plan.orders.length ? '' : ' disabled') + '>登録する（' + plan.orders.length + '件）</button></div>');
    const done = v => { fulfillClose(); resolve(v); };
    ov.querySelector('#ful-cancel').onclick = () => done(null);
    ov.querySelector('#ful-dry').onclick = () => done({ dryRun: true, notify: ov.querySelector('#ful-notify').checked });
    ov.querySelector('#ful-go').onclick = () => {
      const notify = ov.querySelector('#ful-notify').checked;
      if (!confirm(plan.orders.length + '件を、Shopify で発送済みにします。' + (notify ? '\nお客様に、発送通知メールが届きます。' : '\nお客様への通知メールは、送りません。') + '\nよろしいですか？')) return;
      done({ dryRun: false, notify });
    };
  });
}
// 専用機の結果を待つ（依頼の処理が終わるまで。閉じるボタンで画面だけ閉じられる＝処理は続く）
function fulfillWait(name, batchId, dryRun) {
  return new Promise((resolve, reject) => {
    let stop = null, closed = false;
    const ov = fulfillOverlay('<h2 style="margin:0 0 6px;font-size:16px">' + (dryRun ? '確認のみ：Shopify の状態を確かめています…' : 'Shopify に登録しています…') + '</h2>' + (dryRun ? '<div class="alert info" style="margin:6px 0">確認のみです。Shopify には、何も書き込みません。</div>' : '') + '<div id="ful-status" class="muted">専用機に依頼しました。</div>' +
      '<div class="muted" style="margin:8px 0">この画面を閉じても、専用機の処理は続きます（もう一度押すと、結果を確かめて、「登録済み」にします）。</div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn sec" id="ful-hide">画面を閉じる</button></div>');
    ov.querySelector('#ful-hide').onclick = () => { closed = true; if (stop) stop(); fulfillClose(); resolve(null); };
    rpaReady().then(() => {
      stop = RpaQueue.watch(name, s => {
        if (closed) return;
        const el = document.getElementById('ful-status');
        if (s.state === 'pending') { if (el) el.textContent = '順番を待っています' + (s.ahead ? '（前に ' + s.ahead + '件）' : '') + '。' + RpaQueue.workerWarning(s); return; }
        if (s.state === 'running') { if (el) el.textContent = dryRun ? '専用機が、Shopify の状態を確かめています（何も書き込みません）…' : '専用機が、Shopify に登録しています…'; return; }
        if (s.state === 'done') { resolve({ ok: true }); return; }
        if (s.state === 'failed') { resolve({ ok: false, error: s.error || '理由は分かりません' }); return; }
        if (s.state === 'timeout') { resolve({ ok: false, error: '時間内に終わりませんでした（専用機が動いているか確認してください）' }); }
      }, { intervalMs: 5 * 1000, timeoutMs: 15 * 60 * 1000 });
    }).catch(reject);
  });
}
async function runShopifyFulfill(items) {
  const F = CONF.shipReport && CONF.shipReport.fulfill;
  if (!F) { alert('この画面では、Shopify への自動登録は使えません'); return false; }
  if (!canImport()) { alert('Shopify への登録は、管理者と取込担当者が行えます'); return false; }
  const plan = EC.fulfillPlan(items, F);
  if (!plan.orders.length && !plan.skipped.length) return false;
  const pick = await fulfillConfirm(plan, F);
  if (!pick) return false;
  const batchId = EC.fulfillBatchId();
  await rpaReady();
  const params = { orders: plan.orders.map(o => ({ id: o.id, company: o.company, number: o.number, url: o.url || '' })), dryRun: pick.dryRun, notify: pick.notify };
  const req = await RpaQueue.request(F.job, { app: 'EC売上（Shopify登録）', requestedBy: account && account.username, batchId, params });
  const out = await fulfillWait(req.name, batchId, pick.dryRun);
  if (!out) return false;   // 画面を閉じた（処理は続いている）
  if (!out.ok) { fulfillOverlay('<h2 style="margin:0 0 6px;font-size:16px">' + (pick.dryRun ? '確認できませんでした' : '登録できませんでした') + '</h2><div class="alert err">' + esc(out.error) + '</div>' +
    '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="ful-ok">閉じる</button></div>').querySelector('#ful-ok').onclick = fulfillClose; return false; }
  // 結果のファイルは、専用機から OneDrive 経由で届くので、少し遅れることがある（最大 約1分、待つ）
  let res = null;
  for (let i = 0; i < 20 && !(res && Array.isArray(res.results)); i++) {
    try { res = await RpaQueue.readJson((F.resultDir || '_ec_fulfill') + '/' + batchId + '/result.json'); } catch (e) { res = null; }
    if (!(res && Array.isArray(res.results))) await new Promise(r => setTimeout(r, 3000));
  }
  if (!res || !Array.isArray(res.results)) {
    fulfillOverlay('<h2 style="margin:0 0 6px;font-size:16px">結果を読めませんでした</h2><div class="alert warn">専用機の処理は終わっていますが、結果のファイルを読めません。Shopify の管理画面で確かめてください（もう一度押すと、登録済みかどうかを確かめられます）。</div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="ful-ok">閉じる</button></div>').querySelector('#ful-ok').onclick = fulfillClose;
    return false;
  }
  const byId = {}; plan.orders.forEach(o => { byId[o.id] = o; });
  const okIds = res.results.filter(r => (r.status === 'done' || r.status === 'already') && byId[r.id]).map(r => byId[r.id].key);   // 記録のキー（アプリの中の注文の印）に戻す
  if (!res.dryRun && okIds.length) await markShipReported(okIds, true);   // 登録できた注文は「Shopify に登録済み」にする（共有のリストにも書く）
  const rows = res.results.map(r => { const st = FUL_STATUS[r.status] || [r.status, 'info'], o = byId[r.id] || {}; return { id: r.id, carrier: o.carrier, fmt: o.fmt, html: '<span class="tag ' + st[1] + '">' + esc(res.dryRun && r.status === 'done' ? '確認のみ' : st[0]) + '</span> ' + esc(r.message || '') }; })
    .concat(plan.skipped.map(s => ({ id: s.id, html: '<span class="tag warn">対象外</span> ' + esc(s.reason) })));
  const summary = res.dryRun ? '確認のみです。Shopify には、何も書き込んでいません。' : (okIds.length + '件を「Shopify に登録済み」にしました。') + (res.ok && !plan.skipped.length ? '' : ' 残りは、内容を見て、管理画面で登録してください。');
  fulfillOverlay('<h2 style="margin:0 0 6px;font-size:16px">' + (res.dryRun ? '確認のみの結果' : '登録の結果') + '</h2><div class="muted">' + esc(summary) + '</div>' + fulfillTable(rows) +
    '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="ful-ok">閉じる</button></div>').querySelector('#ful-ok').onclick = fulfillClose;
  return okIds.length > 0;
}

function shipCtx() {
  return { EC, conf: CONF, box: $('shipBox'), cnt: $('cnt-ship'), visible: curTab === 'ship', slips: () => slips, stateOf, rec, shipPlan: shipOf, canReport: canImport(), markReported: markShipReported, mailDraft: (window.FurusatoShipReport && CONF.shipReport && CONF.shipReport.mail) ? makeShipMail : null,
    fulfill: (CONF.shipReport && CONF.shipReport.fulfill && CONF.shipReport.fulfill.enabled === true && canImport()) ? { run: runShopifyFulfill } : null,   // enabled が true のときだけ、ボタンを出す（専用機の準備ができてから true にする）
    loadJson: async name => JSON.parse((await fetchCsv(name)).text), rerender: () => render() };
}
function render() {
  if (!cal) cal = buildCal();
  ['orders', 'map', 'pay', 'ship'].forEach(t => { const el = $('p-' + t); if (el) el.hidden = (t !== curTab); });
  document.querySelectorAll('.tab').forEach(e => e.classList.toggle('active', e.dataset.tab === curTab));
  $('btn-sync').hidden = !canImport();
  document.querySelectorAll('[data-v]').forEach(e => e.classList.toggle('active', e.dataset.v === curView));
  document.querySelectorAll('[data-s]').forEach(e => e.classList.toggle('active', e.dataset.s === curSort));
  renderOrders(); renderMap(); renderDrawer(); renderImportPanel(); renderSharedBanner(); renderStale();
  if (window.EcShipTab && $('shipBox')) EcShipTab.render(shipCtx());
  if (isSoumu) renderPay();
  if (curTab === 'pay') renderPayBar(); else renderOutbar();
}
function setReady() {
  const bits = [];
  const st = (k, l) => M.stamps[k] ? l + ' ' + stamp(M.stamps[k]) : null;
  [st('items', '品目'), st('nouhin', '納品先'), st('juchu', '受注')].filter(Boolean).forEach(b => bits.push(b));
  const stale = isIndexStale(), h = indexAgeHours();
  setStatus(M.indexMissing || stale ? 'loading' : 'ok', 'SMILEマスタ読込済（' + (bits.join('／') || '—') + ' 時点）' + (orders.length ? ' ／ Shopify注文 ' + orders.length + '件' : '') + shopifyAgeText() +
    (h != null ? ' ／ SMILEの最新データ：' + agoText(h) : '') +
    (stale ? ' ⚠ 古いため、二重取込の確認が最新のSMILEに基づきません。' + (canImport() ? '「SMILEの最新を取り込む」を押してから取り込んでください' : '取込担当者に最新化を頼んでください') : '') +
    (M.indexMissing ? ' ／ 軽量ファイルが無いので全件CSVを読んでいます（時間がかかります）' : ''));
}

document.addEventListener('click', async e => {
  if (moreOpen && !e.target.closest('.morewrap') && $('moreMenu')) { moreOpen = false; $('moreMenu').hidden = true; }
  if (e.target.closest('[data-close]') || e.target.id === 'scrim') { if (mapDrawer && !closeMapDrawer()) return; if (!confirmDiscardEdit()) return; openId = null; editId = null; editDraft = null; renderDrawer(); return; }
  const tr = e.target.closest('tr[data-row]');
  if (tr && !e.target.closest('input,button,select,a,label')) { mapDrawer = null; if (openId !== tr.dataset.row) { if (!confirmDiscardEdit()) return; editId = null; editDraft = null; slipView = 'cmp'; } openId = tr.dataset.row; renderDrawer(); return; }
  const t = e.target.closest('[data-tab],[data-f],[data-v],[data-s],[data-act],[data-gset],[data-gok],[data-ov],[data-ovdel],[data-mv],[data-rdel],[data-try],button');
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { if (mapDrawer && !closeMapDrawer()) return; curTab = d.tab; render(); return; }
  if (d.f) { curFilter = d.f; sel.clear(); render(); return; }
  if (d.v) { curView = d.v; render(); return; }
  if (d.s) { curSort = d.s === 'desc' ? 'desc' : 'asc'; try { localStorage.setItem(SORT_KEY, curSort); } catch (err) { /* 覚えられなくても並び替えはできる */ } render(); return; }
  if (d.act) {
    const s = slips.find(x => x.id === d.id); if (!s) return;
    const who = account && account.username, now = new Date().toISOString();
    if (d.act === 'ok') { await commit({ ids: [s.id], expect: () => ['未確認'], mutate: () => setOk(s), action: 'OK' }); return; }
    if (d.act === 'confirmok') { await confirmOrders([s.id]); return; }
    if (d.act === 'confirmed') {
      await commit({ ids: [s.id], expect: () => ['要確認'], action: '確認OK', detail: () => '要確認の注文を SMILE で確認して起票済みにした',
        mutate: id => { const r = store.orders[id]; if (!r) return false; r.status = 'exported'; r.exportedAt = now; r.exportedBy = who; r.confirmedBy = who; r.confirmedAt = now; r.manualConfirmed = true; delete r.checkMessage; return true; } });
      return;
    }
    if (d.act === 'edstart') { const dv = EC.deliveryFromOrder(s.order, store.cfg); editId = s.id; editDraft = {}; EC.EDIT_FIELDS.forEach(f => { editDraft[f.k] = dv[f.k] == null ? '' : dv[f.k]; }); renderDrawer(); return; }
    if (d.act === 'edcancel') { editId = null; editDraft = null; renderDrawer(); return; }
    if (d.act === 'edrev') { const dv = EC.deliveryFromOrder(s.order, store.cfg); editDraft[t.dataset.k] = dv.auto[t.dataset.k] || ''; renderDrawer(); return; }
    if (d.act === 'edzip') { await zipHint(s); return; }
    if (d.act === 'edreview') { reviewDeliveryEdit(s); return; }
    if (d.act === 'edrevall') {
      if (!confirm('「' + s.name + '」の納品先を、Shopify の値に戻します（直した内容は消えます）。よろしいですか？')) return;
      const dv = EC.deliveryFromOrder(s.order, store.cfg); await saveDeliveryEdit(s, {}, dv.auto, '納品先の手動変更をすべて元に戻した'); return;
    }
    if (d.act === 'slipauto') {
      const r0 = store.orders[s.id]; if (!r0 || !r0.slipDate) return;
      delete r0.slipDate; save(); render(); return;
    }
    if (d.act === 'shipauto') {
      const r0 = store.orders[s.id]; if (!r0 || !r0.shipDate) return;
      delete r0.shipDate; save(); render();
      if (r0.status) queuePush(s.id, '出荷予定日変更', '自動の日付に戻した');
      return;
    }
    if (d.act === 'exclude') {
      const st0 = stateOf(s); if (st0 !== 'new' && st0 !== 'check') return;
      const reason = prompt('「' + s.name + '」を対象外にします（SMILEには取り込みません。あとで「未確認に戻す」で戻せます）。' + String.fromCharCode(10) + (st0 === 'check' ? '※要確認の注文は、SMILE に取り込まれている可能性があります。SMILE を確認してから外してください。' + String.fromCharCode(10) : '') + String.fromCharCode(10) + '理由を入力してください（例：返金対応・別経路で処理済み・テスト注文）。お客様の名前・住所・電話は書かないでください。');
      if (reason === null) return;
      if (!reason.trim()) { alert('理由を入力してください'); return; }
      await commit({ ids: [s.id], expect: () => [st0 === 'check' ? '要確認' : '未確認'], action: 'その他', detail: () => '対象外にした：' + reason.trim(),
        mutate: id => { const r = store.orders[id] = store.orders[id] || {}; Object.assign(r, { status: 'excluded', excludeReason: reason.trim(), excludedBy: who, excludedAt: now, cust: s.cust, orderDate: s.orderDate, net: s.netTotal }); return true; } });
      return;
    }
    const was = store.orders[s.id] && store.orders[s.id].status; if (!was) return;
    await commit({ ids: [s.id], expect: () => [EC.listStatus(was)], action: was === 'excluded' ? 'その他' : 'OK取消', detail: () => EC.listStatus(was) + 'から未確認に戻した',
      mutate: id => { const r = store.orders[id]; if (!r) return false; UNDO_KEYS.forEach(k => delete r[k]); return true; } });
    return;
  }
  if (d.gok) { const g = window.__groups[d.gok], list = g.list.filter(s => stateOf(s) === 'new' && !s.hasErr); await commit({ ids: list.map(s => s.id), expect: () => ['未確認'], mutate: id => setOk(list.find(s => s.id === id)), action: 'OK', detail: () => 'まとめてOK' }); return; }
  if (d.gset !== undefined) {
    const v = document.querySelector('[data-gdate="' + CSS.escape(d.gset) + '"]').value; if (!v) return;
    const gids = [];
    window.__groups[d.gset].list.forEach(s => { if (stateOf(s) === 'new' || stateOf(s) === 'ok') { store.orders[s.id] = Object.assign(store.orders[s.id] || {}, { shipDate: v }); gids.push(s.id); } });
    save(); render();
    gids.filter(id => store.orders[id].status).forEach(id => queuePush(id, '出荷予定日変更', 'まとめて ' + v + ' に変更'));
    return;
  }
  if (d.try) { $('try-name').value = d.try; tryName(d.try); return; }
  if (d.impclose) { store.imports[d.impclose].dismissed = true; save(); renderImportPanel(); renderOutbarIfOrders(); return; }
  if (d.impverify) { retryVerify(d.impverify); return; }
  if (d.impconfirm) { const imp = store.imports[d.impconfirm]; if (imp) confirmBulk(confirmWaitingIds(imp.orderIds)); return; }
  if (d.impreport) { const imp = store.imports[d.impreport]; if (imp && isAdmin) sendReport(imp, true); return; }
  switch (t.id) {
    case 'o-import': startImport(); break;
    case 'stale-sync': syncSmile(); break;
    case 'src-info': { const el = $('src-detail'); if (el) el.hidden = !el.hidden; break; }
    case 'o-migrate': moreOpen = false; migrateLocal(); break;
    case 'o-confirmall': confirmBulk(confirmWaitingIds()); break;
    case 'o-test': moreOpen = false; startTestImport(); break;
    case 'o-more': moreOpen = !moreOpen; $('moreMenu').hidden = !moreOpen; break;
    case 'map-add': startNewRule(''); break;
    case 'map-reset': mapAction('reset'); break;
    case 'map-csv': mapCsv(); break;
    case 'o-dest': outDest(); break;
    case 'o-juchu': outJuchu(); break;
    case 'o-done': markExported(); break;
    case 'o-pay': outPay(); break;
  }
});
document.addEventListener('input', e => { const k = e.target.dataset && e.target.dataset.ed; if (k && editDraft) { editDraft[k] = e.target.value; if (e.target.value.trim()) e.target.dataset.last = e.target.value; refreshEditErr(); } });
// 必須項目は、空のまま確定させない（欄を出たときに、直前の値へ戻す）
document.addEventListener('change', e => {
  const t = e.target, k = t.dataset && t.dataset.ed;
  if (!k || ED_REQUIRED.indexOf(k) < 0 || !editDraft || t.value.trim()) return;
  t.value = t.dataset.last || ''; editDraft[k] = t.value; refreshEditErr();
  const msg = document.getElementById('edMsg'); if (msg) msg.insertAdjacentHTML('afterbegin', '<div>必須項目は空にできません。元の値に戻しました</div>');
});
// 保存の前の確認の画面。変更前→変更後を並べて、「この内容で保存」を押したときだけ保存する
function reviewDeliveryEdit(s) {
  const dv = EC.deliveryFromOrder(s.order, store.cfg), diff = EC.diffDeliveryEdit(dv.auto, editDraft);
  if (!Object.keys(diff).length) { alert('変更がありません'); return; }
  const merged = Object.assign({}, dv.auto, diff), chk = EC.checkDeliveryEdit(merged, store.cfg);
  const exCode = reuseCode(s, dv);
  if (exCode && diff.memo) chk.warns.push('既存の納品先（' + exCode + '）です。配達員向けメモは、取込では入りません（納品先マスタの取込は新規だけ）。SMILE の荷受け人名１に直接入れてください');
  const rows = Object.keys(diff).map(k => { const f = EC.EDIT_FIELDS.find(x => x.k === k); return '<tr><th>' + esc(f.label) + '</th><td>' + esc(dv.auto[k] || '（空）') + '</td><td style="background:#fff1c2;font-weight:600">' + esc(diff[k] || '（空）') + '</td></tr>'; }).join('');
  const ov = document.createElement('div');
  ov.id = 'editConfirm';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(22,26,61,.5);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML = '<div style="background:#fff;border-radius:12px;max-width:640px;width:100%;padding:20px 24px;max-height:90vh;overflow:auto"><h2 style="margin:0 0 6px;font-size:16px">この内容で納品先を変更しますか？</h2>' +
    '<div class="muted" style="margin-bottom:8px">注文 ' + esc(s.name) + '。SMILE に取り込まれる納品先が、この内容になります。</div>' +
    '<table style="width:100%;border-collapse:collapse"><thead><tr><th></th><th>変更前（Shopify の値）</th><th>変更後</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    chk.errors.map(x => '<div class="alert err" style="margin-top:8px">' + esc(x) + '（直してから保存してください）</div>').join('') +
    chk.warns.map(x => '<div class="alert warn" style="margin-top:8px">' + esc(x) + '</div>').join('') +
    '<div class="muted" style="margin-top:8px">保存すると、誰がいつどの項目を直したかが履歴に残ります（値は残りません）。あとから「元に戻す」で Shopify の値に戻せます。</div>' +
    '<div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px"><button class="btn sec" id="ec-back">戻って直す</button><button class="btn" id="ec-save"' + (chk.errors.length ? ' disabled' : '') + '>この内容で保存する</button></div></div>';
  document.body.appendChild(ov);
  $('ec-back').onclick = () => ov.remove();
  $('ec-save').onclick = async () => { $('ec-save').disabled = true; $('ec-back').disabled = true; const ok = await saveDeliveryEdit(s, diff, dv.auto, '納品先を手動で変更'); ov.remove(); if (!ok) renderDrawer(); };
}
// 郵便番号から住所を引く（郵便番号だけを zipcloud.ibsnet.jp に送る。個人情報は送らない）。結果は確認用の表示だけで、自動では入れない
async function zipHint(s) {
  const el = $('zipHint'), z = String(editDraft.zip || '').replace(/\D/g, '');
  if (z.length !== 7) { el.textContent = '郵便番号を7桁で入れてください'; return; }
  el.textContent = '確認中…';
  try {
    // 郵便番号検索 zipcloud。ibsnet.jp の名前が引けない環境があるので、appspot.com のほうを先に試す（どちらも同じサービス）
    let r = null;
    for (const host of ['https://zip-cloud.appspot.com', 'https://zipcloud.ibsnet.jp']) {
      try { r = await (await fetch(host + '/api/search?zipcode=' + z)).json(); if (r) break; } catch (e) { r = null; }
    }
    if (!r) throw new Error('zipcloud に接続できません');
    const x = r && r.results && r.results[0];
    if (!x) { el.textContent = 'この郵便番号の住所が見つかりません'; return; }
    const base = x.address1 + x.address2, town = x.address3, cur = String(editDraft.addr1 || '') + String(editDraft.addr2 || '');
    const ok = cur.normalize('NFKC').replace(/\s/g, '').startsWith(base) ;
    el.innerHTML = '郵便番号の住所：<b>' + esc(base + town) + '</b> ' + (ok ? '<span style="color:#12a76a">（住所１と一致）</span>' : '<span style="color:#a8620a">⚠ いまの住所と違います</span> <button class="btn sec sm" id="zipfill">住所１を「' + esc(base) + '」にする</button>');
    const b = $('zipfill'); if (b) b.onclick = () => { editDraft.addr1 = base; renderDrawer(); };
  } catch (e) { el.textContent = '取得できませんでした（通信を確認）'; }
}
document.addEventListener('change', e => {
  const t = e.target, d = t.dataset;
  if (t.matches('[data-selall]')) { document.querySelectorAll('[data-sel]').forEach(c => { c.checked = t.checked; t.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); }); return; }
  if (d.sel) { t.checked ? sel.add(d.sel) : sel.delete(d.sel); return; }
  if (d.ship !== undefined) {
    const s = slips.find(x => x.id === d.ship); if (!s) return;
    const r = store.orders[s.id] = store.orders[s.id] || {};
    if (!t.value || t.value === s.autoShip) delete r.shipDate; else r.shipDate = t.value;
    save(); render();
    if (r.status) queuePush(s.id, '出荷予定日変更', r.shipDate ? r.shipDate + ' に変更' : '自動の日付に戻した');
    return;
  }
  if (d.slip !== undefined) {
    const s = slips.find(x => x.id === d.slip); if (!s) return;
    const r = store.orders[s.id] = store.orders[s.id] || {};
    if (!t.value || t.value === slipAuto()) delete r.slipDate; else r.slipDate = t.value;
    save(); render();
    return;
  }
  if (d.memo !== undefined) {
    const r = store.orders[d.memo] = store.orders[d.memo] || {};
    const v = t.value.trim();
    if (v) r.memoNote = v; else delete r.memoNote;
    save(); render();
    if (r.status) queuePush(d.memo, '社内メモ追記', v ? '社内メモを追記（' + v.length + '文字）' : '社内メモを消した');   // ログには内容を書かない
    return;
  }
  if (d.pay !== undefined) { renderPayBar(); return; }
  if (t.id === 'f-from' || t.id === 'f-q') { render(); return; }
  if (t.id === 'pay-from') { renderPay(); return; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && mapDrawer) { closeMapDrawer(); return; } if (e.key === 'Escape' && openId) { if (!confirmDiscardEdit()) return; editId = null; editDraft = null; openId = null; renderDrawer(); } });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'try-name') tryName(t.value);
  else if (t.id === 'map-q') { mapQ = t.value; $('rules').innerHTML = mapRulesHtml(); }
  else if (t.dataset && t.dataset.md !== undefined) mdInput(t);
  else if (t.dataset && t.dataset.memo !== undefined) { const sl = slips.find(x => x.id === t.dataset.memo), out = document.getElementById('memoOut-' + t.dataset.memo); if (sl && out) out.textContent = EC.joinMemo(sl.baseMemo || sl.memo, t.value, store.cfg); }   // 取り込まれるメモを、入力に合わせて見せる
});
document.addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.md !== undefined) { mdInput(t); if (t.dataset.mdre !== undefined) renderMapDrawer(); } });
// 対応表・設定：行クリック → ドロワー／ドロワーのボタン
document.addEventListener('click', e => {
  const dv = e.target.closest('[data-dview]');
  if (dv) { slipView = dv.dataset.dview === 'image' ? 'image' : 'cmp'; renderDrawer(); return; }
  const t = e.target.closest('[data-mdact],[data-newrule],[data-mdclose],[data-rulelink],.rcard[data-maprule]'); if (!t) return;
  if (t.matches('.rcard[data-maprule]')) { if (!e.target.closest('input,button,select,a,label')) openRule(t.dataset.maprule); return; }
  if (t.dataset.rulelink !== undefined) { if (mapDrawer && !closeMapDrawer()) return; openRule(t.dataset.rulelink); return; }
  if (t.dataset.mdclose !== undefined) { closeMapDrawer(); return; }
  if (t.dataset.newrule !== undefined) { startNewRule(t.dataset.newrule); return; }
  if (t.dataset.mdact === 'legacy') { reviewLegacy(); return; }
  if (t.dataset.mdact === 'legacydrop') { if (confirm('この端末に残っている以前の対応表・設定は使いません。よろしいですか？')) { delete store.legacy; save(); render(); } return; }
  mapAction(t.dataset.mdact, t);
});
$('f-q').addEventListener('input', () => renderOrders());

function mapCsv() {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['区分', '名前', '商品名に含まれる言葉', 'あてはめ方', 'SMILE品目コード', '標準単価(税抜)', '納期(営業日)', 'メモ']].concat(store.mapping.rules.map(r => [{ body: '本体', option: 'オプション', single: '単品' }[r.scope], r.label, (r.words || [r.pattern]).join('、'), { contains: '含む', starts: '始まる', exact: 'ちょうど同じ' }[r.match || 'contains'], r.code || '', r.net == null ? '' : r.net, r.leadDays == null ? '' : r.leadDays, r.note || r.warn || '']));
  download('EC品目対応表.csv', new TextEncoder().encode('\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n')), 'text/csv');
}

async function initAuth() {
  if (typeof msal === 'undefined') { showLoginError('MSALライブラリを読み込めませんでした。再読み込みしてください。'); return; }
  msalInstance = new msal.PublicClientApplication(HanaokaAuth.msalConfig());
  await msalInstance.initialize();
  await msalInstance.handleRedirectPromise();
  window.enterApp = async () => {
    $('loginScreen').style.display = 'none';
    try { CONF = await (await fetch(CONFIG_URL, { cache: 'no-cache' })).json(); } catch (e) { setStatus('err', '設定ファイル（' + CONFIG_URL + '）を読めません'); return; }
    await loadSharedConfig();
    BASE = { mapping: clone(CONF.mapping), cfg: clone(CONF.config) };
    store = loadStore();
    const n = account.name || account.username;
    $('sp-user').textContent = n; $('sp-avatar').textContent = (n || '?').charAt(0);
    wireDrop('orders', 'orders'); wireDrop('payouts', 'payouts'); wireDrop('tx', 'tx');
    setStatus('loading', 'SharePoint（SharedMasters）から読み込み中…');
    startEarly();   // マスタ・注文・休業日・共有の履歴は、設定を待たずに先に読み始める
    // 総務の権限の確認と、管理者→対応表・設定は、互いに待たずに進める（設定は管理者の一覧を使うので、この2つは順番）
    [isSoumu] = await Promise.all([soumuHasAccess(), loadAdmins().then(() => loadSettings())]);
    $('tab-pay').hidden = !isSoumu || !!PROFILE.noPay;
    const failed = await loadMasters();
    await syncFromList({ first: true, noRender: true });   // 共有の履歴（リスト）を読んで、この端末の記録を復元する
    recompute(); render();
    healShipReports();
    Object.keys(store.imports).forEach(id => { if (['queued', 'importing', 'verify'].includes(store.imports[id].phase)) trackImport(id); });
    codeDecision = EC.deliveryCodeMode((CONF.rpaImport || {}).tempCodes, null); refreshCodeMode();   // 専用機の稼働の印で、新規の納品先のコードの決め方を判定する
    setInterval(() => { if (document.visibilityState === 'visible') refreshCodeMode(); }, 60 * 1000);
    resumeReports();   // 突合が済んでいて、まだ報告していない取込があれば、1回だけ報告する   // 開き直したら、待っている取込の続きを見る
    // 他の人が更新した内容を、定期的に反映する（画面が見えているときだけ）
    setInterval(() => { if (document.visibilityState === 'visible' && shared && !importBusy && !syncBusy) syncFromList({ quiet: true }); }, ((CONF.sharedHistory || {}).pollSeconds || 60) * 1000);
    if (failed.length) setStatus('err', '読み込めませんでした: ' + failed.join('、') + '（二重取込の確認・品目名の取得ができません）'); else setReady();
  };
  $('loginBtn').onclick = async () => {
    try { $('loginError').style.display = 'none'; account = await HanaokaAuth.login(msalInstance, SCOPES); await window.enterApp(); }
    catch (e) { showLoginError('サインインに失敗しました: ' + e.message); }
  };
  $('btn-sync').onclick = syncSmile;
  $('btn-reload').onclick = async () => {
    $('btn-reload').disabled = true; setStatus('loading', '読み込み中…');
    if (window.EcShipTab) EcShipTab.reset();
    const failed = await loadMasters(); await loadSettings(); await syncFromList({ noRender: true }); recompute(); render();
    failed.length ? setStatus('err', '読み込めませんでした: ' + failed.join('、')) : setReady();
    $('btn-reload').disabled = false;
  };
  account = await HanaokaAuth.restore(msalInstance, SCOPES);
  if (account) await window.enterApp();
}
initAuth();
