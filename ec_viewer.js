'use strict';
/* 注文の状況の閲覧画面（EC受注の状況 ec_viewer.html／ふるさと納税の状況 furusato_viewer.html）。見るだけで、書き込みはしない。
 * 注文ごとに、元の注文（EC＝Shopify／ふるさと納税＝サイネックスの注文CSV）・SMILE の受注・出荷（送り状）を1つにまとめて、
 *   ① 受注 → ② 受注伝票作成済（出荷待ち） → ③ 出荷済 → ④ 完了（EC＝Shopify登録済／ふるさと納税＝サイネックス報告完了）
 * のどこまで進んだかを出す。状況の決め方・検索は ec_viewer_core.js（EcViewer）。
 * 画面ごとの違い（言葉・注文の読み方・完了の判定）は、先に読み込む「プロフィール」（window.VIEWER_PROFILE。
 * EC＝ec_viewer_profile.js／ふるさと納税＝furusato_viewer_profile.js）に書く。
 * データはすべて SharedMasters（読み取りのみ）：元の注文／SMILE の受注（ec_smile_index.json）／出荷（ship_index.json）。
 * 運送会社の名前・追跡URLは ship_config.json。 */
const V = window.EcViewer, EC = window.EcSales, SS = window.ShipSearch, P = window.VIEWER_PROFILE;
const SCOPES = ['User.Read', 'Sites.Read.All', 'Files.Read.All'];
const PAGE = 40;   // 1回に出す件数

let SC = null, CONF = null, msalInstance = null, account = null, driveId = null;
let SHIP = null, SMILE = null, SRC = null;   // 読み込んだデータ（SRC＝{ orders, modified, doneUnknown }：元の注文）
let RECS = [], FILT = [], shown = 0, LOADWARN = [];
const FS = { q: '', stages: [], from: '', to: '', carrier: '', tag: '', late: false };
let period = '';

// 使われ方の記録（usage_log.js）。誰が・いつ・何をしたか、だけ。検索の言葉・お客様名・番号は記録しない
const ulog = (a, d, every) => { try { if (window.UsageLog) UsageLog.log(a, d, every ? { every: true } : undefined); } catch (e) { /* 記録の失敗で止めない */ } };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(type, msg) { $('statusBar').className = type || ''; $('sp-status').textContent = msg; }
function showLoginError(m) { HanaokaAuth.done(); const e = $('loginError'); e.textContent = m; e.style.display = 'block'; }
const today = () => V.todayJst();
function stamp(iso) { if (!iso) return ''; const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function ago(iso) { if (!iso) return ''; const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 90 ? m + '分前' : Math.round(m / 60) + '時間前'; }

/* ------------------------------------------------------------ SharePoint（SharedMasters・読み取りのみ） */
async function getToken() {
  try { return (await msalInstance.acquireTokenSilent({ scopes: SCOPES, account })).accessToken; }
  catch { return (await msalInstance.acquireTokenPopup({ scopes: SCOPES })).accessToken; }
}
async function graphGet(url) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + url, { headers: { Authorization: 'Bearer ' + await getToken() } });
  if (!r.ok) throw new Error('Graph ' + r.status + ': ' + url);
  return r.json();
}
async function resolveDriveId() {
  if (driveId) return driveId;
  const nm = SC.sharepoint.driveName, re = new RegExp(nm, 'i');
  const drives = (await graphGet('/sites/' + SC.sharepoint.siteId + '/drives?$select=id,name,webUrl&$top=100')).value || [];
  const hit = drives.find(d => d.name === nm) || drives.find(d => re.test(d.name || '') || re.test(d.webUrl || ''));
  if (!hit) throw new Error('SharePoint のライブラリ（' + nm + '）が見つかりません');
  driveId = hit.id; return driveId;
}
async function fetchFile(name) {
  const did = await resolveDriveId();
  const meta = await graphGet('/drives/' + did + '/root:/' + encodeURIComponent(name));
  const dl = meta['@microsoft.graph.downloadUrl'];
  if (!dl) throw new Error('downloadUrl がありません: ' + name);
  const r = await fetch(dl);
  if (!r.ok) throw new Error('取得失敗 ' + r.status + ': ' + name);
  return { buf: await r.arrayBuffer(), modified: meta.lastModifiedDateTime || '' };
}
function decodeText(buf) {
  let t = new TextDecoder('utf-8').decode(buf);
  if ((t.match(/�/g) || []).length > 5) { try { t = new TextDecoder('shift_jis').decode(buf); } catch (e) { /* utf-8 のまま */ } }
  return t.replace(/^﻿/, '');
}
const API = () => ({ SC, CONF, EC, V, getToken, graphGet, resolveDriveId, fetchFile, decodeText, stamp });
async function loadAll() {
  const warn = [], smileFile = P.smileFile(CONF);
  const [ship, smile, src] = await Promise.allSettled([
    fetchFile(SC.files.index).then(r => JSON.parse(decodeText(r.buf))),
    fetchFile(smileFile).then(r => ({ idx: JSON.parse(decodeText(r.buf)), modified: r.modified })),
    P.load(API())
  ]);
  SHIP = ship.status === 'fulfilled' && ship.value && Array.isArray(ship.value.ships) ? ship.value : null;
  SMILE = smile.status === 'fulfilled' && smile.value.idx && smile.value.idx.orders ? smile.value : null;
  SRC = src.status === 'fulfilled' && src.value && src.value.orders ? src.value : null;
  if (!SRC) { console.warn(src.reason); warn.push(P.source + ' の注文を読めませんでした。注文の一覧が出ない・古い注文だけになる場合があります（' + P.sourceWhy + '）'); }
  else (SRC.warns || []).forEach(w => warn.push(w));
  if (!SMILE) warn.push('SMILE の受注（' + smileFile + '）を読めません。「' + P.labels.wait + '」以降の判定が出ません');
  if (!SHIP) warn.push('出荷のデータ（' + SC.files.index + '）を読めません。「' + P.labels.shipped + '」の判定が出ません');
  return warn;
}
function rebuild() {
  const sm = SMILE ? EC.indexObjects(SMILE.idx.orders) : [];
  RECS = V.build({ shopifyOrders: SRC ? SRC.orders : [], smileRows: sm, shipLookup: SHIP ? EC.shipLookup(SHIP) : null, custCodes: P.custCodes(CONF), today: today(), labels: P.labels, pastDays: P.pastDays });
}
function renderMeta(warn) {
  const w = (warn || []).slice();
  if (SRC && SRC.modified && P.staleHours && Date.now() - Date.parse(SRC.modified) > P.staleHours * 3600 * 1000) w.push(P.source + ' の注文が古くなっています（' + stamp(SRC.modified) + ' 取得）。専用機の取得が止まっている可能性があります');
  if (SHIP && SC.staleHours && Date.now() - Date.parse(SHIP.generatedAt) > (SC.staleHours.index || 30) * 3600 * 1000) w.push('出荷のデータが古くなっています（' + stamp(SHIP.generatedAt) + ' 作成）');
  const box = $('warnBox'); box.hidden = !w.length; box.innerHTML = w.map(x => '<div>⚠ ' + esc(x) + '</div>').join('');
}
function setReady() {
  const p = [];
  if (SRC) p.push(P.source + (SRC.modified ? ' ' + stamp(SRC.modified) + '（' + ago(SRC.modified) + '）' : ''));
  if (SMILE) p.push('SMILE ' + stamp(SMILE.idx.generatedAt || SMILE.modified));
  if (SHIP) p.push('出荷 ' + stamp(SHIP.generatedAt));
  setStatus(SRC || SMILE || SHIP ? 'ok' : 'err', 'データの更新：' + (p.join('／') || 'なし') + '　注文 ' + RECS.length + '件');
}

/* ------------------------------------------------------------ 絞り込み・検索 */
const PERIODS = [{ k: '7', label: '直近7日', days: 7 }, { k: '30', label: '直近30日', days: 30 }, { k: '', label: 'すべて', days: 0 }];
function addDays(s, n) { const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) + n * 86400000); return d.toISOString().slice(0, 10); }
function drawPeriods() {
  $('periods').innerHTML = PERIODS.map(p => '<span class="chip' + (period === p.k ? ' active' : '') + '" data-period="' + p.k + '">' + p.label + '</span>').join('');
}
function drawStages() {
  const base = V.filter(RECS, Object.assign({}, FS, { stages: [] })), c = V.counts(base);
  const on = k => FS.stages.indexOf(k) >= 0, none = !FS.stages.length && !FS.late;
  const tile = (title, sub, n, kind, attr) => '<div class="ftile ' + kind + (attr.active ? ' active' : '') + '" ' + attr.data + ' role="button" tabindex="0" aria-pressed="' + (attr.active ? 'true' : 'false') + '"><div class="ft-t">' + title + (attr.active ? '<span class="ft-on">✓ 表示中</span>' : '') + '</div><div class="ft-s">' + sub + '</div><div class="ft-c">' + n + '<small>件</small></div></div>';
  const st = (k, title, kind, sub) => tile(title, sub == null ? P.subs[k] : sub, c[k], kind, { active: on(k), data: 'data-stage="' + k + '"' });
  const T = P.tileTitles, arrow = '<div class="farrow">→</div>';
  const doneSub = SRC && SRC.doneUnknown ? P.subs.doneUnknown : P.subs.done;
  const hasSel = !none;
  $('stages').innerHTML = '<div class="flow-all">' + tile('すべて', hasSel ? 'ほかの状況も含めて、全部を表示' : '全部の状況を表示しています', c.all, 'k-all', { active: none, data: 'data-stage=""' }) +
    '<div class="flow' + (hasSel ? ' has-sel' : '') + '">' + st('shopify', T.shopify, 'k-s1') + arrow + st('wait', T.wait, 'k-s2') + arrow + st('shipped', T.shipped, 'k-s3') + arrow + st('done', T.done, 'k-s4', doneSub) + '</div></div>' +
    '<div class="flow flow-sub' + (hasSel ? ' has-sel' : '') + '"><div class="fsub-l">ほかの絞り込み</div>' +
    tile('⚠ 出荷予定日を過ぎている', '出荷待ちのまま予定日を超過', c.late, 'k-attn' + (c.late ? ' hot' : ''), { active: FS.late, data: 'data-late="1"' }) +
    (P.hasCancel ? st('cancelled', 'キャンセル', 'k-cancel') : '') +
    (P.pastDays ? st('past', '過去の注文', 'k-past') : '') + '</div>';
}
function buildSelects() {
  const car = $('f-carrier'), tag = $('f-tag');
  const cs = Object.keys((SC && SC.carriers) || {}).filter(k => k.charAt(0) !== '_' && SC.carriers[k] && SC.carriers[k].name);
  car.innerHTML = '<option value="">すべて</option>' + cs.map(k => '<option value="' + esc(k) + '">' + esc(SC.carriers[k].name) + '</option>').join('');
  const tags = {}; RECS.forEach(r => r.shopify.tags.forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
  const tl = tag.closest('label'); if (tl) tl.hidden = !Object.keys(tags).length;   // 担当のタグがない画面では、選択欄を出さない
  tag.innerHTML = '<option value="">すべて</option>' + Object.keys(tags).sort().map(t => '<option value="' + esc(t) + '">' + esc(t) + '（' + tags[t] + '）</option>').join('');
  car.value = FS.carrier; tag.value = FS.tag;
}
function readFilters() {
  FS.q = $('f-q').value; FS.from = $('f-from').value; FS.to = $('f-to').value; FS.carrier = $('f-carrier').value; FS.tag = $('f-tag').value;
}
function doSearch() {
  readFilters();
  FILT = V.filter(RECS, FS); shown = 0;
  drawStages(); render();
}
function userSearch() { ulog(P.page + '_search', FS.q.trim() ? '言葉あり' : '言葉なし', true); doSearch(); }

/* ------------------------------------------------------------ 表示 */
const FIN = { paid: '支払済み', pending: '入金待ち', refunded: '返金済み', partially_refunded: '一部返金', voided: '無効', authorized: '承認済み（未入金）', partially_paid: '一部入金' };
const yen = n => '¥' + Math.round(Number(n) || 0).toLocaleString();
function trackHtml(sl) {
  const u = SS.trackingUrl(SC, sl.c, sl.no);
  return (u ? '<a class="track" href="' + esc(u) + '" target="_blank" rel="noopener">追跡</a>' : '');
}
function slipHtml(sl) {
  return '<div><span class="muted">' + esc(sl.carrier) + '</span> <b>' + esc(sl.fmt) + '</b> <button class="btn sec sm" data-copy="' + esc(sl.no) + '" title="送り状番号をコピー">コピー</button>' + trackHtml(sl) + '</div>';
}
function stepsHtml(r) {
  const sh = r.shopify, sm = r.smile, sp = r.ship, known = sp.slips.length ? 2 : (sm.has || sp.ships.length) ? 1 : 0;
  const idx = r.stage === 'past' ? known : { shopify: 0, wait: 1, shipped: 2, done: 3 }[r.stage];   // 過去の注文は、わかっている分（SMILE・送り状）まで色を付ける
  const cls = i => 'st' + (idx != null && i <= idx ? ' on' : '') + (i === idx ? (r.stage === 'done' ? ' done-all' : ' cur') : '');
  const v0 = sh.has ? esc(V.md(sh.createdAt)) + ' ' + esc(sh.createdTime) : '<span class="muted">' + esc(P.noSourceStep) + '</span>';
  let v1 = '—';
  if (sm.has) v1 = '受注№ <b>' + esc(sm.juchuNos.join('、')) + '</b><br>受注日 ' + esc(V.md(sm.orderDate)) + '<br>出荷予定日 <b>' + esc(V.md(sm.shipPlan) || '未定') + '</b>' + (r.late ? ' <span class="tag warn">過ぎています</span>' : '');
  else if (sp.ships.length) v1 = '出荷伝票あり';
  let v2 = '—';
  if (sp.slips.length) v2 = sp.slips.map(slipHtml).join('') + (sp.shipDate ? '<div class="muted">出荷日 ' + esc(V.md(sp.shipDate.slice(0, 10))) + '</div>' : '');
  else if (sp.ships.length) v2 = '送り状番号を待っています' + (sp.shipDate ? '<div class="muted">出荷日 ' + esc(V.md(sp.shipDate.slice(0, 10))) + '</div>' : '');
  const v3 = r.stage === 'done' ? P.doneStep : r.noShopify ? '<span class="muted">' + esc(P.unknownDoneStep) + '</span>' : SRC && SRC.doneUnknown ? '<span class="muted">' + esc(P.doneUnreadable) + '</span>' : '<span class="muted">まだ</span>';
  const T = P.stepTitles;
  return '<div class="steps"><div class="' + cls(0) + '"><div class="sl">' + T.shopify + '</div><div class="sv">' + v0 + '</div></div>' +
    '<div class="' + cls(1) + '"><div class="sl">' + T.wait + '</div><div class="sv">' + v1 + '</div></div>' +
    '<div class="' + cls(2) + '"><div class="sl">' + T.shipped + '</div><div class="sv">' + v2 + '</div></div>' +
    '<div class="' + cls(3) + '"><div class="sl">' + T.done + '</div><div class="sv">' + v3 + '</div></div></div>';
}
function detailHtml(r) {
  const sh = r.shopify, sm = r.smile, row = (k, v) => v ? '<dt>' + k + '</dt><dd>' + v + '</dd>' : '';
  return '<dl class="detail">' +
    row('お客様', esc([sh.shipCompany, sh.shipName].filter(Boolean).join(' '))) + row('電話', esc(sh.phone)) + row('メール', esc(sh.email)) +
    row('住所', esc([sh.zip && sh.zip.replace(/^(\d{3})(\d{4})$/, '$1-$2'), sh.address].filter(Boolean).join(' '))) +
    row('担当（タグ）', esc(sh.tags.join('、'))) + row('SMILE の納品先', esc(sm.dest)) +
    (P.detailStatus ? row(esc(P.source) + ' の状況', P.detailStatus(sh, { FIN, yen, esc })) : '') +
    sh.extra.map(e => row(esc(e[0]), esc(e[1]))).join('') +
    row('SMILE の納期', sm.nouki ? esc(V.md(sm.nouki)) : '') + row('出荷№', esc(r.ship.shipNos.join('、'))) + row('お客様のメモ', esc(sh.notes)) + '</dl>';
}
function cardHtml(r, i) {
  const sh = r.shopify, st = r.stage;
  const who = sh.shipCompany ? sh.shipCompany + (sh.shipName ? '（' + sh.shipName + '）' : '') : (sh.shipName || r.smile.dest || '');
  const tags = [];
  if (r.late) tags.push('<span class="tag warn">出荷予定日を過ぎています</span>');
  if (r.noShopify) tags.push('<span class="tag info">' + esc(r.past ? P.pastTag : P.noSourceTag) + '</span>');
  if (P.cardTags) P.cardTags(sh).forEach(t => tags.push('<span class="tag warn">' + esc(t) + '</span>'));
  const nm = s => String(s || '').replace(/\s*-\s*オプションは注文しない$/, '');   // 商品名の「- オプションは注文しない」は、営業の方には要らない
  const lines = (sh.lines.length ? sh.lines.map(l => esc(nm(l.name)) + ' ×' + l.qty) : r.smile.lines.map(l => esc(l.code) + ' ' + esc(l.name) + ' ×' + l.qty)).slice(0, 4);
  const more = (sh.lines.length || r.smile.lines.length) - lines.length;
  const body = st === 'cancelled'
    ? '<div class="notice" style="color:var(--red)">この注文は、' + esc(P.source) + ' でキャンセルになっています' + (sh.cancelledAt ? '（' + esc(V.md(sh.cancelledAt)) + '）' : '') + '</div>'
    : stepsHtml(r);
  return '<div class="oc s-' + st + '" data-i="' + i + '"><div class="oc-top"><span class="oc-no">' + esc(P.noPrefix) + esc(r.id) + '</span><span class="badge b-' + st + '">' + esc(V.stageLabel(st, P.labels)) + '</span>' + tags.join(' ') +
    '<span class="oc-who">' + esc(who) + '</span><span class="grow"></span><span class="oc-sub">' + (sh.has ? esc(V.md(sh.createdAt)) + ' ' + esc(sh.createdTime) + ' 注文' + (P.showTotal ? '　' + yen(sh.total) : '') : '') + '</span></div>' +
    body + '<div class="lines">' + lines.join('<span class="muted">／</span>') + (more > 0 ? '<span class="muted">　ほか ' + more + '行</span>' : '') + '</div>' +
    '<div class="det" hidden>' + detailHtml(r) + '</div></div>';
}
function render() {
  const n = FILT.length;
  $('summary').textContent = RECS.length ? (n === RECS.length ? '全 ' + n + ' 件' : RECS.length + ' 件中 ' + n + ' 件') + (n ? '（カードを押すと、お客様・住所・メモなどの詳細が開きます）' : '') : '';
  const part = FILT.slice(0, shown + PAGE); shown = part.length;
  $('list').innerHTML = part.length ? part.map((r, i) => cardHtml(r, i)).join('') : '<div class="empty">' + (RECS.length ? 'この条件の注文は、ありません' : '注文のデータがありません') + '</div>';
  $('moreBox').hidden = FILT.length <= shown;
}

/* ------------------------------------------------------------ 操作 */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* 何もしない */ }
    ta.remove(); return ok;
  }
}
function wire() {
  $('searchForm').onsubmit = e => { e.preventDefault(); userSearch(); };
  let timer = null;
  $('f-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(userSearch, 250); });
  ['f-from', 'f-to'].forEach(id => $(id).addEventListener('change', () => { period = ''; drawPeriods(); userSearch(); }));
  ['f-carrier', 'f-tag'].forEach(id => $(id).addEventListener('change', userSearch));
  $('periods').addEventListener('click', e => {
    const c = e.target.closest('[data-period]'); if (!c) return;
    period = c.dataset.period; const p = PERIODS.find(x => x.k === period);
    $('f-from').value = p && p.days ? addDays(today(), -p.days) : ''; $('f-to').value = '';
    drawPeriods(); userSearch();
  });
  $('stages').addEventListener('click', e => {
    const l = e.target.closest('[data-late]'); const c = e.target.closest('[data-stage]');
    if (l) FS.late = !FS.late;
    else if (c) { const k = c.dataset.stage; if (!k) { FS.stages = []; FS.late = false; } else { const i = FS.stages.indexOf(k); if (i >= 0) FS.stages.splice(i, 1); else FS.stages.push(k); } }
    else return;
    ulog(P.page + '_filter', l ? '予定日超過' : '状況', true); doSearch();
  });
  $('btn-clear').onclick = () => {
    $('f-q').value = ''; $('f-from').value = ''; $('f-to').value = ''; $('f-carrier').value = ''; $('f-tag').value = ''; period = '';
    FS.stages = []; FS.late = false; drawPeriods(); doSearch(); $('f-q').focus();
  };
  $('btn-more').onclick = () => render();   // 表示中の件数に、さらに PAGE 件を足す
  $('list').addEventListener('click', async e => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { e.stopPropagation(); const ok = await copyText(cp.dataset.copy); const t = cp.textContent; cp.textContent = ok ? 'コピーしました' : 'コピーできません'; setTimeout(() => { cp.textContent = t; }, 1500); ulog(P.page + '_copy', '送り状番号', true); return; }
    if (e.target.closest('a, button, input, select')) return;
    const c = e.target.closest('.oc'); if (!c) return;
    if (String(window.getSelection && window.getSelection()).trim()) return;   // 文字を選んでいるときは開かない
    const d = c.querySelector('.det'); if (d) { d.hidden = !d.hidden; if (!d.hidden) ulog(P.page + '_detail', '', true); }
  });
  document.addEventListener('click', e => { const l = e.target.closest('a.track'); if (l) ulog(P.page + '_track', '', true); });
  $('helpBox').addEventListener('toggle', () => { if ($('helpBox').open) ulog(P.page + '_help', ''); });
  $('btn-reload').onclick = async () => {
    ulog(P.page + '_reload', '');
    $('btn-reload').disabled = true; setStatus('loading', '読み込み中…');
    try { LOADWARN = await loadAll(); rebuild(); renderMeta(LOADWARN); buildSelects(); doSearch(); setReady(); } catch (e) { setStatus('err', '読み込めませんでした：' + e.message); }
    $('btn-reload').disabled = false;
  };
}

/* ------------------------------------------------------------ 起動 */
async function initAuth() {
  if (typeof msal === 'undefined') { showLoginError('MSALライブラリを読み込めませんでした。再読み込みしてください。'); return; }
  msalInstance = new msal.PublicClientApplication(HanaokaAuth.msalConfig());
  await msalInstance.initialize();
  await msalInstance.handleRedirectPromise();
  window.enterApp = async () => {
    $('loginScreen').style.display = 'none';
    try { SC = await (await fetch('ship_config.json', { cache: 'no-cache' })).json(); CONF = await (await fetch(P.configUrl, { cache: 'no-cache' })).json(); }
    catch (e) { setStatus('err', '設定ファイル（ship_config.json・' + P.configUrl + '）を読めません'); return; }
    const n = account.name || account.username;
    $('sp-user').textContent = n; $('sp-avatar').textContent = (n || '?').charAt(0);
    $('helpBody').innerHTML = P.help;
    setStatus('loading', 'SharePoint（SharedMasters）から読み込み中…');
    drawPeriods(); wire();
    const q = new URLSearchParams(location.search).get('q'); if (q) $('f-q').value = q;
    try { LOADWARN = await loadAll(); } catch (e) { console.warn(e); setStatus('err', '読み込めませんでした：' + e.message); return; }
    rebuild(); renderMeta(LOADWARN); buildSelects(); doSearch(); setReady();
    if (window.UsageLog) { UsageLog.init({ page: P.page, msal: () => msalInstance, account: () => account, max: 400 }); ulog('open', 'から=' + (q ? '他のアプリ（番号で検索）' : '直接')); }
    setInterval(() => { if (document.visibilityState === 'visible') { try { renderMeta(LOADWARN); } catch (e) { /* 注意の表示だけ */ } } }, 10 * 60 * 1000);
  };
  $('loginBtn').onclick = async () => {
    try { $('loginError').style.display = 'none'; account = await HanaokaAuth.login(msalInstance, SCOPES); await window.enterApp(); }
    catch (e) { showLoginError('サインインに失敗しました: ' + e.message); }
  };
  account = await HanaokaAuth.restore(msalInstance, SCOPES);
  if (account) await window.enterApp();
}
initAuth();
