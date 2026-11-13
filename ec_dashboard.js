'use strict';
/* 売上の分析（EC・ふるさと納税）：月別を基本に、切り口を変えて眺める画面。見るだけで、書き込みはしない。
 * 「対象」を EC／ふるさと納税／合計で切り替える（最初は EC）。得意先コードで分ける：EC＝ec_sales_config.json、ふるさと納税＝furusato_config.json の config.customers。
 * 「売上」は SMILE の確定した売上（売上明細出力.csv）。売上明細で作れない切り口は、Shopify の直近55日分・SMILE の受注から作る（どの切り口がどのデータかは、画面の各見出しの札に出す）。
 * 集計と、数字から作るコメントは ec_dashboard_core.js（EcDashboard）。ここは、読み込み・範囲の選択・表とグラフの表示だけ。
 * データはすべて SharedMasters（読み取りのみ）：売上明細出力.csv（約65MB。EC の得意先の行だけ先に絞って読む）／SMILE の受注と納品先（ec_smile_index.json）／Shopify の注文（ec_shopify_orders.csv・直近55日分）／出荷（ship_index.json）。
 * EC の得意先コード・ファイル名は ec_sales_config.json、出荷データの名前と SharePoint の場所は ship_config.json。 */
const D = window.EcDashboard, EC = window.EcSales;
const SCOPES = ['User.Read', 'Sites.Read.All', 'Files.Read.All'];
const SALES_FILE = '売上明細出力.csv';   // SMILE の確定した売上（SMILE が毎日更新する）

let SC = null, ECC = null, msalInstance = null, account = null, driveId = null;
let SALES = null, SMILE = null, SHOPIFY = null, SHIP = null;   // 読み込んだデータ（SALES＝売上明細）
let MODEL = null;                                  // D.build の結果（注文・Shopify の注文・補足）
let RANGE = null, PRESET = '3m', TARGET = 'ec', FURU = [], CUR = null;   // FURU＝ふるさと納税の得意先コード、CUR＝いま描いている分析
const CH = {};                                     // 描いたグラフ

// 使われ方の記録（usage_log.js）。誰が・いつ・何をしたか、だけ。画面の中身（金額・商品・お客様）は記録しない
const ulog = (a, d, every) => { try { if (window.UsageLog) UsageLog.log(a, d, every ? { every: true } : undefined); } catch (e) { /* 記録の失敗で止めない */ } };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(type, msg) { $('statusBar').className = type || ''; $('sp-status').textContent = msg; }
function showLoginError(m) { HanaokaAuth.done(); const e = $('loginError'); e.textContent = m; e.style.display = 'block'; }
const today = () => D.todayJst();
function stamp(iso) { if (!iso) return ''; const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
const md = s => s ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) : '';
const n0 = n => Math.round(Number(n) || 0).toLocaleString('ja-JP');
const yen = n => n0(n) + '円';
const man = n => (Math.round((Number(n) || 0) / 1000) / 10).toLocaleString('ja-JP') + '万';   // グラフの目盛り（万円）
const pc = n => (Math.round((Number(n) || 0) * 10) / 10) + '%';

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
async function loadAll() {
  const warn = [];
  const [ship, smile, shop, sales] = await Promise.allSettled([
    fetchFile(SC.files.index).then(r => JSON.parse(decodeText(r.buf))),
    fetchFile((ECC.files || {}).index || 'ec_smile_index.json').then(r => ({ idx: JSON.parse(decodeText(r.buf)), modified: r.modified })),
    fetchFile((ECC.shopifyFiles || {}).orders || 'ec_shopify_orders.csv').then(r => ({ text: decodeText(r.buf), modified: r.modified })),
    // 売上明細出力.csv：大きいので、EC の得意先の行だけを先に取り出してから表にする（文字コードも見分ける）
    fetchFile((ECC.files || {}).sales || SALES_FILE).then(r => ({ rows: EC.parseAuto(D.extractSalesLines(r.buf, custCodes())), modified: r.modified }))
  ]);
  SHIP = ship.status === 'fulfilled' && ship.value && Array.isArray(ship.value.ships) ? ship.value : null;
  SMILE = smile.status === 'fulfilled' && smile.value.idx && smile.value.idx.orders ? smile.value : null;
  SALES = sales.status === 'fulfilled' && sales.value.rows.length ? sales.value : null;
  if (sales.status === 'rejected') console.warn(sales.reason);
  SHOPIFY = null;
  if (shop.status === 'fulfilled') {
    try {
      const objs = EC.parseObjects(shop.value.text);
      if (objs.length && 'Lineitem name' in objs[0]) SHOPIFY = { orders: EC.groupShopifyOrders(objs), modified: shop.value.modified };
    } catch (e) { console.warn(e); }
  }
  if (!SALES) warn.push('売上明細（' + ((ECC.files || {}).sales || SALES_FILE) + '）を読めませんでした（ファイルがない・読む権限がない・形が違う、のどれかです）。売上の数字が出せません');
  if (!SMILE) warn.push('SMILE の受注（' + ((ECC.files || {}).index || 'ec_smile_index.json') + '）を読めません。地域別の都道府県と、出荷までの日数が出ません');
  if (!SHOPIFY) warn.push('Shopify の注文を読めませんでした。曜日別・時間帯別・新規とリピート・値引きが出ません（専用機の毎時の取得がまだか、権限がない可能性があります）');
  if (!FURU.length) warn.push('ふるさと納税の得意先（furusato_config.json）を読めません。「ふるさと納税」と「合計」は出ません');
  if (!SHIP) warn.push('出荷のデータ（' + SC.files.index + '）を読めません。「出荷までの日数」が出ません');
  return warn;
}
function ecCodes() { return Object.keys(((ECC.config || {}).customers) || {}); }
function custCodes() { return ecCodes().concat(FURU); }   // 売上明細から取り出す得意先（EC＋ふるさと納税）
function rebuild() {
  const idx = SMILE ? SMILE.idx : null;
  MODEL = D.build({
    salesRows: SALES ? SALES.rows : [], smileRows: idx ? EC.indexObjects(idx.orders) : [], nouhinRows: idx && idx.nouhin ? EC.indexObjects(idx.nouhin) : [],
    shopifyOrders: SHOPIFY ? SHOPIFY.orders : [], shipLookup: SHIP ? EC.shipLookup(SHIP) : null, shipIndex: SHIP, custGroups: [{ k: 'ec', codes: ecCodes() }, { k: 'furusato', codes: FURU }], today: today()
  });
}
function renderMeta(warn) {
  const w = (warn || []).slice();
  if (SALES && Date.now() - Date.parse(SALES.modified) > 36 * 3600 * 1000) w.push('売上明細が古くなっています（' + stamp(SALES.modified) + ' 更新）。SMILE からの毎日の書き出しが止まっている可能性があります');
  if (SHOPIFY && Date.now() - Date.parse(SHOPIFY.modified) > 12 * 3600 * 1000) w.push('Shopify の注文が古くなっています（' + stamp(SHOPIFY.modified) + ' 取得）。専用機の毎時の取得が止まっている可能性があります');
  if (SHIP && SC.staleHours && Date.now() - Date.parse(SHIP.generatedAt) > (SC.staleHours.index || 30) * 3600 * 1000) w.push('出荷のデータが古くなっています（' + stamp(SHIP.generatedAt) + ' 作成）');
  const box = $('warnBox'); box.hidden = !w.length; box.innerHTML = w.map(x => '<div>⚠ ' + esc(x) + '</div>').join('');
}
function setReady() {
  const p = [];
  if (SALES) p.push('売上明細 ' + stamp(SALES.modified));
  if (SMILE) p.push('受注 ' + stamp(SMILE.idx.generatedAt || SMILE.modified));
  if (SHOPIFY) p.push('Shopify ' + stamp(SHOPIFY.modified));
  if (SHIP) p.push('出荷 ' + stamp(SHIP.generatedAt));
  setStatus(SALES ? 'ok' : 'err', 'データの更新：' + (p.join('／') || 'なし') + '　売上伝票 ' + MODEL.sales.length + '枚（全期間・' + (MODEL.info.salesTo ? md(MODEL.info.salesTo) + ' まで' : '') + '）');
}

/* ------------------------------------------------------------ 範囲 */
const PRESETS = [{ k: 'thisMonth', label: '今月' }, { k: '3m', label: '直近3か月' }, { k: '6m', label: '直近6か月' }, { k: 'year', label: '今年' }, { k: 'lastYear', label: '昨年' }, { k: 'all', label: '全期間' }];
function drawTargets() {
  $('targets').innerHTML = D.TARGETS.filter(t => t.k === 'ec' || FURU.length).map(t => '<span class="chip' + (TARGET === t.k ? ' active' : '') + '" data-target="' + t.k + '">' + esc(t.label) + '</span>').join('');
}
function drawPresets() {
  $('presets').innerHTML = PRESETS.map(p => '<span class="chip' + (PRESET === p.k ? ' active' : '') + '" data-preset="' + p.k + '">' + p.label + '</span>').join('');
  $('r-from').value = RANGE.from; $('r-to').value = RANGE.to;
}
function setPreset(k) { PRESET = k; RANGE = D.preset(k, today(), MODEL.info.firstMonth); drawPresets(); render(); }

/* ------------------------------------------------------------ 表・グラフの部品 */
function table(cols, rows, opt) {
  opt = opt || {};
  if (!rows.length) return '<div class="empty">' + esc(opt.empty || 'この範囲のデータはありません') + '</div>';
  return '<div class="tblwrap"><table class="dt"><thead><tr>' + cols.map(c => '<th' + (c.name ? ' class="name"' : '') + '>' + esc(c.h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr' + (r._sub ? ' class="sub"' : '') + '>' + cols.map(c => '<td' + (c.name ? ' class="name"' : '') + '>' + (c.html ? c.f(r) : esc(c.f(r))) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
function comments(list) { return list && list.length ? '<div class="cmt"><ul>' + list.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : ''; }
const SRC = { sales: ['売上明細', 's1', '確定した売上（売上日）'], shop: ['Shopify', 's2', '直近55日分（注文日）'], order: ['受注', 's3', 'SMILE の受注（受注日）'] };
const srcTag = k => { const s = SRC[k], only = k === 'shop' && CUR && CUR.shopScope === 'ecOnly'; return '<span class="src ' + s[1] + '" title="' + esc(s[2] + (only ? '（EC の分だけ）' : '')) + '">' + s[0] + (only ? '（ECのみ）' : '') + '</span>'; };
// ふるさと納税には Shopify のデータがない：グラフは出さず、札で示す
const noShop = (id, title, a) => ({ html: '<div class="panel" id="sec-' + id + '"><h2>' + esc(title) + srcTag('shop') + '</h2><div class="empty">' + esc(a.who) + 'には、このデータ（Shopify の注文）がありません。EC を選ぶと見られます。</div></div>', draw: () => {} });
const ecOnlyNote = a => a.shopScope === 'ecOnly' ? 'EC の分だけです（ふるさと納税は含みません）。' : '';
function section(id, title, note, chartId, tableHtml, cmt, extra, src) {
  return '<div class="panel" id="sec-' + id + '"><h2>' + esc(title) + (src || []).map(srcTag).join('') + '</h2>' + (note ? '<p class="sec-note">' + esc(note) + '</p>' : '') + comments(cmt) + (extra || '') +
    '<div class="sec-body"><div class="chartbox">' + (chartId ? '<canvas id="' + chartId + '"></canvas>' : '') + '</div><div>' + tableHtml + '</div></div></div>';
}
const COL = () => { const s = getComputedStyle(document.documentElement), g = n => s.getPropertyValue(n).trim() || '#23268f'; return { navy: g('--navy'), cyan: g('--cyan'), orange: g('--orange'), green: g('--green'), purple: g('--purple'), red: g('--red'), sub: g('--sub'), line: g('--line-strong'), mute: g('--mute') }; };
function draw(key, canvasId, cfg) {
  if (CH[key]) { CH[key].destroy(); delete CH[key]; }
  const cv = $(canvasId); if (!cv) return;
  if (!window.Chart) { const b = cv.parentNode; if (!b.querySelector('.nochart')) b.insertAdjacentHTML('beforeend', '<div class="nochart">グラフを読み込めませんでした（表は右に出ています）</div>'); return; }
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false }, cfg.options || {});
  CH[key] = new Chart(cv, cfg);
}
const GRID = c => ({ color: c.line });
function barOpts(c, o) {
  o = o || {};
  return {
    plugins: { legend: { display: !!o.legend, labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: o.tip || {} } },
    scales: Object.assign({ x: { grid: { display: false }, ticks: { font: { size: 11 }, color: c.sub } }, y: { beginAtZero: true, grid: GRID(c), ticks: Object.assign({ font: { size: 11 }, color: c.sub }, o.yTicks || {}) } }, o.scales || {})
  };
}

/* ------------------------------------------------------------ 表示 */
function delta(cur, prev, label, kind) {   // 数字のカードの「前との比較」
  if (!prev) return '<div class="kd none">' + esc(label) + ' は比べられません</div>';
  const c = D.chg(cur, prev);
  if (c.flat) return '<div class="kd flat">' + esc(label.replace('との比較', '')) + 'とほぼ同じ</div><div class="kp">' + esc(label) + '：' + kind(prev) + '</div>';
  return '<div class="kd ' + (c.up ? 'up' : 'down') + '">' + (c.up ? '▲ ' : '▼ ') + esc(label) + ' ' + (c.up ? '+' : '−') + c.pct + '%</div><div class="kp">' + esc(label) + '：' + kind(prev) + '</div>';
}
function renderKpis(a) {
  const c = a.cur, p = a.prev, L = a.period.labels.prev + 'との比較';
  const cards = [
    { cl: 'k1', l: '売上（税抜・確定した売上）', v: n0(c.sales), u: '円', d: delta(c.sales, p.sales, L, yen) },
    { cl: 'k2', l: '注文件数', v: n0(c.count), u: '件', d: delta(c.count, p.count, L, x => n0(x) + '件') },
    { cl: 'k3', l: '客単価（1注文あたりの金額）', v: n0(c.avg), u: '円', d: delta(c.avg, p.avg, L, yen) },
    { cl: 'k4', l: '1注文あたりの点数', v: (Math.round(c.avgQty * 10) / 10).toLocaleString('ja-JP'), u: '台', d: delta(c.avgQty, p.avgQty, L, x => (Math.round(x * 10) / 10) + '台') }
  ];
  $('kpis').innerHTML = cards.map(k => '<div class="kpi ' + k.cl + '"><div class="kl">' + k.l + '</div><div class="kv">' + k.v + '<small>' + k.u + '</small></div>' + k.d + '</div>').join('');
  const pr = a.period;
  $('compareNote').textContent = '数えている期間：' + md(pr.cur.start) + '～' + md(pr.cur.end) + '　比べている期間：' + md(pr.prev.start) + '～' + md(pr.prev.end) + (pr.partial ? '（途中の月なので、前の期間も同じ日数までにそろえています）' : '');
}
function renderDataNote(a) {
  const i = MODEL.info, t = [];
  if (i.salesTo) t.push('売上明細は ' + md(i.salesTo) + ' の分まで（売上日で数えています）');
  const ns = TARGET === 'all' ? { count: i.notSold, amount: i.notSoldAmount } : (i.notSoldBy || {})[TARGET] || { count: 0, amount: 0 };
  if (ns.count) t.push(a.who + 'の、受注はあるが、まだ売上になっていない（出荷前の）注文が ' + ns.count + '件（受注の金額で約 ' + D.yenShort(ns.amount) + '）あります。売上には入っていません');
  if (i.waiting && a.shopAvailable) t.push('Shopify に注文があって、まだ SMILE に受注伝票がない EC の注文が ' + i.waiting + '件あります');
  if (i.shopFrom && a.shopAvailable) t.push('Shopify の注文データ：' + md(i.shopFrom) + '～' + md(i.shopTo) + '（時間帯・新規とリピート・値引き・曜日の「注文した日」は、この期間の EC の分だけ' + (a.shopScope === 'ecOnly' ? '。ふるさと納税には、この切り口がありません' : '') + '）');
  if (!a.shopAvailable) t.push('ふるさと納税には Shopify のデータがないので、時間帯別・新規とリピート・値引きは出ません');
  $('dataNote').innerHTML = t.map(x => '・' + esc(x)).join('<br>');
}
function renderMain(a) {
  const c = a.comments.sales.slice();
  $('mainComment').hidden = !c.length; $('mainCommentList').innerHTML = c.map(x => '<li>' + esc(x) + '</li>').join('');
}

function secMonthly(a, c) {
  const rows = a.series;
  const html = table([{ h: '月', f: r => D.monthLabelY(r.month) }, { h: '売上（税抜）', f: r => n0(r.sales) }, { h: '件数', f: r => n0(r.count) }, { h: '客単価', f: r => n0(r.avg) }, { h: '点数/件', f: r => (Math.round(r.avgQty * 10) / 10) }], rows.slice().reverse());
  return { html: section('monthly', '① 月別の推移', '売上は、SMILE の確定した売上（売上明細）を、売上日の月で数えています（税抜・送料込み）。出荷した月に売上になるので、受注した月とは少しずれます。', 'ch-monthly', html, a.comments.monthly, '', ['sales']), draw: () => {
    draw('monthly', 'ch-monthly', { type: 'bar', data: { labels: rows.map(r => D.monthLabel(r.month)), datasets: [
      { type: 'bar', label: '売上（万円）', data: rows.map(r => r.sales), backgroundColor: c.navy, yAxisID: 'y', order: 2 },
      { type: 'line', label: '注文件数', data: rows.map(r => r.count), borderColor: c.orange, backgroundColor: c.orange, yAxisID: 'y1', tension: .25, order: 1, pointRadius: 3 }] },
      options: barOpts(c, { legend: true, yTicks: { callback: v => man(v) }, tip: { label: x => x.dataset.yAxisID === 'y' ? '売上 ' + yen(x.raw) : '注文件数 ' + n0(x.raw) + '件' },
        scales: { y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { font: { size: 11 }, color: c.orange, precision: 0 } } } }) });
  } };
}
function secProducts(a, c) {
  const list = a.products, top = list.slice(0, 15), rest = list.slice(15);
  const rows = top.map((x, i) => ({ rank: i + 1, name: x.name, qty: x.qty, sales: x.sales, share: x.share, orders: x.orders }));
  if (rest.length) rows.push({ rank: '', name: 'その他（' + rest.length + '品目）', qty: rest.reduce((s, x) => s + x.qty, 0), sales: rest.reduce((s, x) => s + x.sales, 0), share: rest.reduce((s, x) => s + x.share, 0), orders: '', _sub: true });
  const html = table([{ h: '#', f: r => r.rank }, { h: '商品', f: r => r.name, name: true }, { h: '台数', f: r => n0(r.qty) }, { h: '売上（税抜）', f: r => n0(r.sales) }, { h: '構成比', f: r => pc(r.share) }, { h: '注文数', f: r => r.orders === '' ? '' : n0(r.orders) }], rows);
  const t10 = list.slice(0, 10);
  return { html: section('products', '② 商品別（売れ筋）', '商品ごとの台数と売上です（売上明細の明細行から。送料は入っていません）。グラフは売上の上位10品目です。', 'ch-products', html, a.comments.products, '', ['sales']), draw: () => {
    draw('products', 'ch-products', { type: 'bar', data: { labels: t10.map(x => x.name.length > 16 ? x.name.slice(0, 15) + '…' : x.name), datasets: [{ label: '売上', data: t10.map(x => x.sales), backgroundColor: c.cyan }] },
      options: Object.assign(barOpts(c, { yTicks: { callback: v => man(v) }, tip: { label: x => '売上 ' + yen(x.raw) + '（' + n0(t10[x.dataIndex].qty) + '台）' } }), { indexAxis: 'y',
        scales: { x: { beginAtZero: true, grid: GRID(c), ticks: { font: { size: 11 }, color: c.sub, callback: v => man(v) } }, y: { grid: { display: false }, ticks: { font: { size: 11 }, color: c.sub } } } }) });
  } };
}
function secRegion(a, c) {
  const g = a.region, rows = g.prefs.slice(0, 20);
  const html = table([{ h: '都道府県', f: r => r.name }, { h: '地方', f: r => r.region }, { h: '件数', f: r => n0(r.count) }, { h: '売上（税抜）', f: r => n0(r.sales) }, { h: '割合', f: r => pc(r.share) }], rows, { empty: '届け先が分かる注文がありません' });
  const note = '件数・売上は売上明細から。届け先の都道府県は、納品先コードで SMILE の納品先の住所から引いています。表は件数の多い20都道府県まで、グラフは地方ごとです。';
  return { html: section('region', '③ 地域別', note, 'ch-region', html, a.comments.region, '', ['sales']), draw: () => {
    draw('region', 'ch-region', { type: 'bar', data: { labels: g.regions.map(x => x.name), datasets: [{ label: '件数', data: g.regions.map(x => x.count), backgroundColor: c.green }] },
      options: barOpts(c, { yTicks: { precision: 0 }, tip: { label: x => n0(x.raw) + '件（' + pc(g.regions[x.dataIndex].share) + '・' + yen(g.regions[x.dataIndex].sales) + '）' } }) });
  } };
}
const shopNote = a => 'Shopify の注文 ' + n0(a.shopCount) + '件から数えています（Shopify の注文は直近55日分だけで、お客様が注文した日時です）。';
function secWeekday(a, c) {
  const rows = a.weekday, sh = a.weekdayShop, hasShop = a.shopAvailable, shRow = r => sh[r.wd === 0 ? 6 : r.wd - 1], eco = a.shopScope === 'ecOnly' ? 'EC のみ・' : '';
  const cols = [{ h: '曜日', f: r => r.name + '曜' }, { h: '売上の件数', f: r => n0(r.count) }, { h: '割合', f: r => pc(r.share) }, { h: '売上（税抜）', f: r => n0(r.sales) }];
  if (hasShop) cols.push({ h: '注文した件数', f: r => n0(shRow(r).count) }, { h: '割合', f: r => pc(shRow(r).share) });
  const html = table(cols, rows, {});
  const note = hasShop
    ? '2つの見方があります。「売上の日」は、売上明細の伝票日付の曜日＝出荷して売上になった日です。「注文した日」は、お客様が Shopify で注文した曜日です（' + eco + '直近55日分・Shopify の注文 ' + n0(a.shopCount) + '件）。' + (a.shopScope === 'ecOnly' ? '「注文した日」は EC の分だけです（ふるさと納税は含みません）。' : '') + 'グラフは、それぞれの割合（%）です。'
    : '「売上の日」は、売上明細の伝票日付の曜日＝出荷して売上になった日です。ふるさと納税には、注文した日（Shopify）のデータがありません。グラフは割合（%）です。';
  const cmt = hasShop ? a.comments.weekdayShop.concat(a.comments.weekday) : a.comments.weekday;
  return { html: section('weekday', '④ 曜日別', note, 'ch-weekday', html, cmt, '', hasShop ? ['sales', 'shop'] : ['sales']), draw: () => {
    const ds = [{ label: '売上の日（出荷した日）', data: rows.map(r => Math.round(r.share * 10) / 10), backgroundColor: c.navy }];
    if (hasShop) ds.push({ label: '注文した日（Shopify・' + eco + '直近55日）', data: rows.map(r => Math.round(shRow(r).share * 10) / 10), backgroundColor: c.orange });
    draw('weekday', 'ch-weekday', { type: 'bar', data: { labels: rows.map(r => r.name), datasets: ds },
      options: barOpts(c, { legend: ds.length > 1, yTicks: { callback: v => v + '%' }, tip: { label: x => x.dataset.label + ' ' + x.raw + '%' } }) });
  } };
}
function secHour(a, c) {
  if (!a.shopAvailable) return noShop('hour', '⑤ 時間帯別', a);
  const rows = a.hours, bands = a.bands;
  const html = table([{ h: '時間の帯', f: r => r.label }, { h: '件数', f: r => n0(r.count) }, { h: '割合', f: r => pc(r.share) }], bands, {});
  return { html: section('hour', '⑤ 時間帯別', ecOnlyNote(a) + shopNote(a), 'ch-hour', html, a.comments.hour, '', ['shop']), draw: () => {
    draw('hour', 'ch-hour', { type: 'bar', data: { labels: rows.map(r => r.hour + '時'), datasets: [{ label: '件数', data: rows.map(r => r.count), backgroundColor: c.cyan }] },
      options: barOpts(c, { yTicks: { precision: 0 }, tip: { label: x => n0(x.raw) + '件' } }) });
  } };
}
function secRepeat(a, c) {
  if (!a.shopAvailable) return noShop('repeat', '⑥ 新規とリピート', a);
  const g = a.repeat, nm = { 'new': '新規（初めて）', repeat: 'リピート', unknown: 'メールなし（不明）' };
  const rows = ['new', 'repeat', 'unknown'].filter(k => g[k].count).map(k => ({ k, name: nm[k], count: g[k].count, share: g[k].share, sales: g[k].sales, avg: g[k].avg }));
  const html = table([{ h: '区分', f: r => r.name }, { h: '件数', f: r => n0(r.count) }, { h: '割合', f: r => r.k === 'unknown' ? '' : pc(r.share) }, { h: '客単価', f: r => n0(r.avg) }], rows, {});
  const note = ecOnlyNote(a) + shopNote(a) + 'リピート＝同じメールアドレスで、前にも注文がある。メールは見分けるためにだけ使い、画面には出しません。';
  return { html: section('repeat', '⑥ 新規とリピート', note, 'ch-repeat', html, a.comments.repeat, '', ['shop']), draw: () => {
    draw('repeat', 'ch-repeat', { type: 'doughnut', data: { labels: rows.map(r => r.name), datasets: [{ data: rows.map(r => r.count), backgroundColor: rows.map(r => r.k === 'new' ? c.navy : r.k === 'repeat' ? c.green : c.mute) }] },
      options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: x => x.label + ' ' + n0(x.raw) + '件' } } } } });
  } };
}
function secShip(a, c) {
  const s = a.ship;
  const kv = '<dl class="kv2"><dt>出荷が確認できた注文</dt><dd>' + n0(s.shipped) + '件</dd><dt>平均</dt><dd>' + (s.shipped ? (Math.round(s.avg * 10) / 10) + '日' : '―') + '</dd><dt>真ん中の値</dt><dd>' + (s.shipped ? s.median + '日' : '―') + '</dd><dt>いちばん長い</dt><dd>' + (s.shipped ? s.max + '日' : '―') + '</dd><dt>出荷がまだ確認できない</dt><dd>' + n0(s.notShipped) + '件</dd></dl>';
  const html = kv + table([{ h: '受注から出荷まで', f: r => r.label }, { h: '件数', f: r => n0(r.count) }, { h: '割合', f: r => pc(r.share) }], s.buckets, {});
  return { html: section('ship', '⑦ 出荷までの日数', 'SMILE の受注（受注日が選んだ範囲の ' + n0(a.shipCount) + '件）について、お客様が注文した日（Shopify の注文があるとき。なければ SMILE の受注日）から、出荷日（出荷のデータ）までの日数です。売上日ではなく受注日で数えるので、上の売上の数字とは件数が合いません。出荷のデータは ' + md(MODEL.info.shipFrom) + ' 以降の分だけ残っているので、それより前の受注は数えません。', 'ch-ship', html, a.comments.ship, '', ['order']), draw: () => {
    draw('ship', 'ch-ship', { type: 'bar', data: { labels: s.buckets.map(b => b.label), datasets: [{ label: '件数', data: s.buckets.map(b => b.count), backgroundColor: c.orange }] },
      options: barOpts(c, { yTicks: { precision: 0 }, tip: { label: x => n0(x.raw) + '件（' + pc(s.buckets[x.dataIndex].share) + '）' } }) });
  } };
}
function secFreight(a, c) {
  const f = a.freight, fs = a.frSeries;
  const monthTbl = table([{ h: '月', f: r => D.monthLabelY(r.month) }, { h: '送料', f: r => n0(r.freight) }, { h: '売上に対する割合', f: r => pc(r.share) }], fs.slice().reverse(), {});
  const codes = a.shopAvailable && f.shopCount ? '<h3 class="mini">値引きコード（Shopify・税込）</h3>' + table([{ h: 'コード', f: r => r.code, name: true }, { h: '使われた注文', f: r => n0(r.count) + '件' }, { h: '値引き額', f: r => n0(r.amount) }], f.codes, { empty: '値引きコードを使った注文はありません' }) : '';
  const note = '送料は、売上明細の運賃（品目 FR・税抜）です。' + (a.shopAvailable ? '値引きは、Shopify の注文（直近55日分' + (a.shopScope === 'ecOnly' ? '・EC の分だけ' : '') + '）の値引きコードと値引き額です。' : 'ふるさと納税には、値引き（Shopify）のデータがありません。');
  return { html: section('freight', '⑧ 送料・値引き', note, 'ch-freight', monthTbl + codes, a.comments.freight, '', a.shopAvailable ? ['sales', 'shop'] : ['sales']), draw: () => {
    draw('freight', 'ch-freight', { type: 'bar', data: { labels: fs.map(r => D.monthLabel(r.month)), datasets: [
      { type: 'bar', label: '送料（万円）', data: fs.map(r => r.freight), backgroundColor: c.purple, yAxisID: 'y', order: 2 },
      { type: 'line', label: '売上に対する割合', data: fs.map(r => Math.round(r.share * 10) / 10), borderColor: c.orange, backgroundColor: c.orange, yAxisID: 'y1', tension: .25, order: 1, pointRadius: 3 }] },
      options: barOpts(c, { legend: true, yTicks: { callback: v => man(v) }, tip: { label: x => x.dataset.yAxisID === 'y' ? '送料 ' + yen(x.raw) : '売上に対する割合 ' + x.raw + '%' },
        scales: { y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { font: { size: 11 }, color: c.orange, callback: v => v + '%' } } } }) });
  } };
}

function render() {
  if (!MODEL) return;
  const a = D.analyze(MODEL, RANGE, today(), TARGET), c = COL();
  CUR = a;
  const pr = a.period;
  $('rangeNote').textContent = '対象：' + a.who + '　' + D.monthLabelY(pr.from) + '～' + D.monthLabelY(pr.to) + '（' + pr.n + 'か月）';
  renderKpis(a); renderDataNote(a); renderMain(a);
  const secs = [secMonthly(a, c), secProducts(a, c), secRegion(a, c), secWeekday(a, c), secHour(a, c), secRepeat(a, c), secShip(a, c), secFreight(a, c)];
  Object.keys(CH).forEach(k => { CH[k].destroy(); delete CH[k]; });
  $('sections').innerHTML = secs.map(s => s.html).join('');
  secs.forEach(s => { try { s.draw(); } catch (e) { console.warn(e); } });
}

/* ------------------------------------------------------------ 操作 */
function wire() {
  $('targets').addEventListener('click', e => { const c = e.target.closest('[data-target]'); if (!c || c.dataset.target === TARGET) return; TARGET = c.dataset.target; ulog('ec_dashboard_target', TARGET, true); drawTargets(); render(); });
  $('presets').addEventListener('click', e => { const c = e.target.closest('[data-preset]'); if (!c) return; ulog('ec_dashboard_range', 'あらかじめ', true); setPreset(c.dataset.preset); });
  ['r-from', 'r-to'].forEach(id => $(id).addEventListener('change', () => {
    const f = $('r-from').value, t = $('r-to').value; if (!/^\d{4}-\d{2}$/.test(f) || !/^\d{4}-\d{2}$/.test(t)) return;
    RANGE = f <= t ? { from: f, to: t } : { from: t, to: f }; PRESET = ''; drawPresets(); ulog('ec_dashboard_range', '月を選んだ', true); render();
  }));
  $('helpBox').addEventListener('toggle', () => { if ($('helpBox').open) ulog('ec_dashboard_help', ''); });
  $('btn-reload').onclick = async () => {
    ulog('ec_dashboard_reload', '');
    $('btn-reload').disabled = true; setStatus('loading', '読み込み中…');
    try { const w = await loadAll(); rebuild(); renderMeta(w); if (PRESET) RANGE = D.preset(PRESET, today(), MODEL.info.firstMonth); drawPresets(); render(); setReady(); } catch (e) { setStatus('err', '読み込めませんでした：' + e.message); }
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
    try { SC = await (await fetch('ship_config.json', { cache: 'no-cache' })).json(); ECC = await (await fetch('ec_sales_config.json', { cache: 'no-cache' })).json(); }
    catch (e) { setStatus('err', '設定ファイル（ship_config.json・ec_sales_config.json）を読めません'); return; }
    try { FURU = Object.keys((((await (await fetch('furusato_config.json', { cache: 'no-cache' })).json()).config || {}).customers) || {}); } catch (e) { FURU = []; }   // ふるさと納税の得意先コード
    const n = account.name || account.username;
    $('sp-user').textContent = n; $('sp-avatar').textContent = (n || '?').charAt(0);
    setStatus('loading', 'SharePoint（SharedMasters）から読み込み中…');
    let warn = [];
    try { warn = await loadAll(); } catch (e) { console.warn(e); setStatus('err', '読み込めませんでした：' + e.message); return; }
    rebuild(); RANGE = D.preset(PRESET, today(), MODEL.info.firstMonth); drawTargets(); drawPresets(); wire(); renderMeta(warn); render(); setReady();
    if (window.UsageLog) { UsageLog.init({ page: 'ec_dashboard', msal: () => msalInstance, account: () => account, max: 400 }); ulog('open', ''); }
    setInterval(() => { if (document.visibilityState === 'visible') { try { renderMeta(warn); } catch (e) { /* 注意の表示だけ */ } } }, 10 * 60 * 1000);
  };
  $('loginBtn').onclick = async () => {
    try { $('loginError').style.display = 'none'; account = await HanaokaAuth.login(msalInstance, SCOPES); await window.enterApp(); }
    catch (e) { showLoginError('サインインに失敗しました: ' + e.message); }
  };
  account = await HanaokaAuth.restore(msalInstance, SCOPES);
  if (account) await window.enterApp();
}
initAuth();
