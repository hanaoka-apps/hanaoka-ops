'use strict';
/* 出荷・配送の検索画面。SharedMasters の ship_index.json（専用機が scripts/build_ship_index.py で作る）を読んで探すだけ。書き込みはしない。
 * 計算部品は ship_core.js（ShipSearch）、運送会社の名前・追跡URLの型・古さの警告は ship_config.json。
 * ?q=… で開くと、その言葉で検索した状態になる（案件管理・EC売上・ふるさと納税から、受注№や客先注番で開けるように）。 */
const S = window.ShipSearch;
const SCOPES = ['User.Read', 'Sites.Read.All', 'Files.Read.All'];
const CONFIG_URL = 'ship_config.json';
const PAGE = 50;          // 1回に出す件数
const LINES_SHOWN = 6;    // 1件のカードに出す品目の行数（これより多いときは「ほか n 行」）

let CONF = null, IDX = null, msalInstance = null, account = null, driveId = null;
let results = [], shown = 0;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(type, msg) { $('statusBar').className = type || ''; $('sp-status').textContent = msg; }
function showLoginError(m) { HanaokaAuth.done(); const e = $('loginError'); e.textContent = m; e.style.display = 'block'; }
function today(offsetDays) {
  const d = new Date(); d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function stamp(iso) { if (!iso) return ''; const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
const fd = iso => S.fmtDate(iso, today());

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
  const nm = CONF.sharepoint.driveName, re = new RegExp(nm, 'i');
  const drives = (await graphGet('/sites/' + CONF.sharepoint.siteId + '/drives?$select=id,name,webUrl&$top=100')).value || [];
  const hit = drives.find(d => d.name === nm) || drives.find(d => re.test(d.name || '') || re.test(d.webUrl || ''));
  if (!hit) throw new Error('SharePoint のライブラリ（' + nm + '）が見つかりません');
  driveId = hit.id; return driveId;
}
async function fetchText(name) {   // ダウンロード用の URL は、ファイルごとの情報から取る（一覧の $select には入れない）
  const did = await resolveDriveId();
  const meta = await graphGet('/drives/' + did + '/root:/' + encodeURIComponent(name));
  const dl = meta['@microsoft.graph.downloadUrl'];
  if (!dl) throw new Error('downloadUrl がありません: ' + name);
  const r = await fetch(dl);
  if (!r.ok) throw new Error('取得失敗 ' + r.status + ': ' + name);
  return { text: await r.text(), modified: meta.lastModifiedDateTime || '' };
}
// SharedMasters に同名の設定ファイルがあれば、リポジトリのものより優先（コードを変えずに決まりごとを直せる）
async function loadSharedConfig() {
  try {
    const o = JSON.parse((await fetchText(CONF.sharepoint.configFile)).text);
    Object.keys(o).forEach(k => {
      if (k === 'sharepoint') return;
      if (k === 'carriers') Object.keys(o.carriers).forEach(c => { CONF.carriers[c] = Object.assign(CONF.carriers[c] || {}, o.carriers[c]); });
      else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) CONF[k] = Object.assign(CONF[k] || {}, o[k]);
      else CONF[k] = o[k];
    });
  } catch (e) { /* 共有の設定ファイルはなくてよい */ }
}
async function loadIndex() {
  const r = await fetchText(CONF.files.index);
  const idx = JSON.parse(r.text);
  if (!idx || !Array.isArray(idx.ships)) throw new Error('検索用のデータの形が違います');
  IDX = idx;
}

/* ------------------------------------------------------------ 絞り込み */
const PERIODS = [{ k: '7', label: '直近7日', days: 7 }, { k: '30', label: '直近30日', days: 30 }, { k: '90', label: '直近90日', days: 90 }, { k: '', label: 'すべて', days: 0 }];
let period = '';
const STATUS_OPTS = [['', 'すべて'], ['ok', '送り状あり'], ['attention', '要確認（見つからない・設定なし）'], ['pending', '待ち（運送会社のデータがまだ）'], ['outside', '取得期間外'], ['none', '運送会社を使わない']];

let carrier = '';   // 運送会社の絞り込み（'' ですべて、運送会社のキー、'none' は使わない出荷）
function buildFilters() {
  $('f-status').innerHTML = STATUS_OPTS.map(o => '<option value="' + o[0] + '">' + esc(o[1]) + '</option>').join('');
  drawPeriods(); drawCarriers();
}
function drawPeriods() {
  $('periods').innerHTML = PERIODS.map(p => '<span class="chip' + (p.k === period ? ' active' : '') + '" data-period="' + p.k + '">' + p.label + '</span>').join('');
}
// 運送会社のチップ（カードの運送会社のバッジと同じ色）
function drawCarriers() {
  const cs = Object.keys(CONF.carriers).filter(k => k[0] !== '_' && typeof CONF.carriers[k] === 'object');
  const chip = (k, label, cls) => '<span class="chip ' + cls + (logoOf(k) ? ' has-logo' : '') + (k === carrier ? ' active' : '') + '" data-carrier="' + esc(k) + '" title="' + esc(label) + '">' + logoOrName(k, label) + '</span>';
  $('carriers').innerHTML = '<span class="muted">運送会社</span>' + chip('', 'すべて', 'cr-none') +
    cs.map(k => chip(k, CONF.carriers[k].name || k, carrierClass(k))).join('') + chip('none', '運送会社なし', 'cr-none');
}
function readFilters() {
  return { q: $('f-q').value, from: $('f-from').value, to: $('f-to').value, carrier: carrier, status: $('f-status').value };
}

function doSearch() {
  const f = readFilters();
  results = S.search(IDX, CONF, f);
  shown = 0;
  $('list').innerHTML = '';
  try { history.replaceState(null, '', f.q.trim() ? '?q=' + encodeURIComponent(f.q.trim()) : location.pathname); } catch (e) { /* 履歴を触れない環境でも検索はできる */ }
  more();
}
function more() {
  const next = results.slice(shown, shown + PAGE);
  $('list').insertAdjacentHTML('beforeend', next.map((s, i) => card(s, shown + i)).join(''));
  shown += next.length;
  $('summary').textContent = results.length ? '全 ' + results.length + ' 件中 ' + shown + ' 件を表示（出荷日の新しい順）' : '';
  $('moreBox').hidden = shown >= results.length;
  if (!results.length) $('list').innerHTML = '<div class="empty">' + (IDX.ships.length ? '見つかりませんでした。言葉を減らすか、出荷日・運送会社の絞り込みを外してみてください。<br><span class="muted">検索できるのは ' + esc(fd(IDX.from)) + ' 以降の出荷です。</span>' : '出荷のデータがありません') + '</div>';
}

/* ------------------------------------------------------------ 出荷のカード */
// 運送会社のロゴ（設定の carriers.<キー>.logo。無ければ社名の文字だけ）
const logoOf = key => { const c = key && CONF.carriers[key]; return c && typeof c === 'object' && c.logo ? String(c.logo) : ''; };
// ロゴの画像には社名が入っているので、ロゴを出すときは文字の社名は出さない（alt・title に社名を入れる）
const logoImg = (key, name) => logoOf(key) ? '<img class="cr-logo" src="' + esc(logoOf(key)) + '" alt="' + esc(name || '') + '" title="' + esc(name || '') + '">' : '';
const logoOrName = (key, name) => logoOf(key) ? logoImg(key, name) : esc(name);
const carrierClass = key => { const ks = Object.keys(CONF.carriers).filter(k => k[0] !== '_' && typeof CONF.carriers[k] === 'object'); const i = ks.indexOf(key); return i < 0 ? 'cr-none' : 'cr-' + (i % 4); };
const STATUS_TAG = { missing: 'err', nodata: 'err', pending: 'warn', outside: 'info', none: 'info' };

function slipLine(sl, s, cls) {
  const url = S.trackingUrl(CONF, sl.c, sl.no);
  const detail = [sl.qty ? sl.qty + '個' : '', sl.kg && sl.kg !== '0' ? sl.kg + 'kg' : '', S.carrierName(CONF, sl.c) !== S.kubunName(CONF, s.kubun) ? S.carrierName(CONF, sl.c) : ''].filter(Boolean).join('・');
  return '<div class="slip' + (cls ? ' ' + cls : '') + '"><span class="slip-no">' + esc(sl.no) + '</span><button type="button" class="cbtn" data-act="copy" data-v="' + esc(sl.no) + '">コピー</button>' +
    (url ? '<a class="track" href="' + esc(url) + '" target="_blank" rel="noopener"' + (String((CONF.carriers[sl.c] || {}).tracking || '').indexOf('{no}') < 0 ? ' title="運送会社のページが開きます。番号をコピーして、貼り付けてください"' : '') + '>配送状況 ↗</a>' : '') +
    (detail ? '<span class="muted">' + esc(detail) + '</span>' : '') + '</div>';
}
function slipsHtml(s, st) {
  if (s.slips && s.slips.length) return s.slips.map(sl => slipLine(sl, s)).join('');
  let html = '<div class="slip-none' + (st.code === 'missing' || st.code === 'nodata' ? ' warn' : '') + '">' + esc(st.text || '送り状番号はまだありません') + '</div>';
  const cand = st.code === 'missing' ? S.candidates(CONF, IDX, s) : [];
  if (cand.length) {
    html += '<div class="slip-none">候補：同じ日に、SMILE の売上№が見つからない送り状があります（SMILE の売上を直して番号が変わったときに起こります。別の荷物のこともあるので、お届け先を確かめてください）</div>' +
      cand.map(u => slipLine({ c: u.c, no: u.slip, qty: '', kg: '' }, s, 'cand')).join('');
  }
  return html;
}
function linesHtml(s, idxCard) {
  const groups = S.linesByJuchu(s), multi = groups.length > 1, expanded = s._open;
  const total = (s.lines || []).length;
  let left = expanded ? Infinity : LINES_SHOWN, html = '';
  groups.forEach(g => {
    if (left <= 0) return;
    const part = g.lines.slice(0, left); left -= part.length;
    if (multi) html += '<div class="jg">受注 ' + esc(g.juchu) + '</div>';
    html += part.map(l => '<div class="ln"><span>' + esc(l.name || l.code) + (l.name && l.name !== l.code ? ' <span class="muted">' + esc(l.code) + '</span>' : '') + '</span><span class="q">× ' + esc(l.qty) + '</span></div>').join('');
  });
  if (!total) html = '<div class="muted">品目の行はありません</div>';
  else if (!expanded && total > LINES_SHOWN) html += '<div class="more"><span class="lnk" data-act="lines" data-i="' + idxCard + '">ほか ' + (total - LINES_SHOWN) + ' 行を表示</span></div>';
  return html;
}
function juchuHtml(s) {
  if (!(s.juchu || []).length) return '<span class="muted">-</span>';
  return s.juchu.map(no => {
    const j = S.juchuInfo(IDX, no);
    const info = j ? [j.date ? '受注 ' + fd(j.date) : '', j.due ? '納期 ' + fd(j.due) : '', j.plan ? '出荷予定 ' + fd(j.plan) : ''].filter(Boolean).join('　') : '';
    return '<div>' + esc(no) + (info ? ' <span class="muted">' + esc(info) + '</span>' : '') + '</div>';
  }).join('');
}
// 分納（同じ注文を分けて出荷）の表：この出荷も含めて、日付・売上№・運送会社・送り状番号・品目を並べる
const BN_STATUS = { missing: '番号が見つかりません', nodata: '要確認', pending: '番号待ち', outside: '番号は取得期間外', none: '運送会社なし' };
function bunnoHtml(s) {
  const b = S.bunno(IDX, s, CONF);
  if (!b) return '';
  const rows = b.ships.map(x => {
    const me = x === s, st = S.slipStatus(CONF, IDX, x);
    const slips = x.slips && x.slips.length
      ? x.slips.map(sl => '<span class="bn-slip">' + esc(sl.no) + '</span>' + (S.carrierName(CONF, sl.c) !== S.kubunName(CONF, x.kubun) ? ' <span class="muted">' + esc(S.carrierName(CONF, sl.c)) + '</span>' : '')).join('　')
      : '<span class="muted">' + esc(BN_STATUS[st.code] || '') + '</span>';
    const items = (x.lines || []).slice(0, 2).map(l => esc(l[1] || l[0]) + ' × ' + esc(l[2])).join('、') + ((x.lines || []).length > 2 ? ' ほか' : '');
    return '<div class="bn-row' + (me ? ' me' : ' go') + '"' + (me ? '' : ' data-act="detailno" data-no="' + esc(x.no) + '" title="この出荷の伝票の詳細を開く"') + '><span class="bn-d">' + esc(fd(x.date)) + '</span><span class="bn-no">売上№ ' + esc(x.no) + '</span>' +
      '<span class="bn-c">' + esc(S.kubunName(CONF, x.kubun)) + '</span><span class="bn-s">' + slips + '</span>' +
      (me ? '<span class="tag info">この出荷</span>' : '') + (items ? '<div class="bn-i muted">' + items + '</div>' : '') + '</div>';
  }).join('');
  return '<div class="sc-bn"><div class="bn-t">分納あり：同じ注文の出荷（全 ' + b.total + ' 回）</div>' + rows + (b.hidden ? '<div class="muted">ほか ' + b.hidden + ' 件（日付の近いものを出しています）</div>' : '') + '</div>';
}
// 納品先：名前と住所（SMILE のマスタの、いまの住所）。直送のときは、得意先と別であることが分かるように印を付ける
function destHtml(s, i) {
  const a = S.addrOf(IDX, s), za = S.zipAddr(a);
  return '<div class="sc-dest' + (S.isDirect(CONF, s) ? ' direct' : '') + '"><div class="sd-main"><div class="sd-k">納品先' + (S.isDirect(CONF, s) ? '（直送：得意先と別の納品先）' : '') + '</div>' +
    '<div class="sd-n">' + esc(S.destLabel(s) || '-') + '</div>' +
    '<div class="sd-a' + (za ? '' : ' muted') + '">' + (za ? esc(za) : '住所の登録がありません') + '</div></div>' +
    '<div class="sd-btns"><button type="button" class="btn sm sec" data-act="detail" data-i="' + i + '">伝票</button><button type="button" class="btn sm" data-act="notice" data-i="' + i + '">出荷連絡</button></div></div>';
}
function card(s, i) {
  const st = S.slipStatus(CONF, IDX, s), key = S.carrierKeyOf(CONF, s.kubun);
  const sib = S.siblings(IDX, s, CONF);
  const want = [s.want ? fd(s.want) : '', s.time].filter(Boolean).join(' ');
  return '<div class="scard ' + (key ? carrierClass(key).replace('cr-', 'cs-') : 'cs-none') + (st.code === 'missing' || st.code === 'nodata' ? ' attn' : '') + '" data-i="' + i + '">' +
    '<div class="sc-head"><b class="sc-date">' + esc(fd(s.date)) + '</b>' +
    '<span class="cr ' + (key ? carrierClass(key) : 'cr-none') + (logoOf(key) ? ' has-logo' : '') + '">' + logoOrName(key, S.kubunName(CONF, s.kubun)) + '</span>' +
    (st.code !== 'ok' ? '<span class="tag ' + (STATUS_TAG[st.code] || 'info') + '">' + esc({ missing: '見つからない', nodata: '要確認', pending: '番号待ち', outside: '取得期間外', none: '運送会社なし' }[st.code]) + '</span>' : '') +
    (s.ret ? '<span class="tag warn">返品</span>' : '') +
    (S.isDirect(CONF, s) ? '<span class="tag direct">直送</span>' : '') +
    (sib.length ? '<span class="tag ok">分納あり ' + (sib.length + 1) + '回</span>' : '') +
    (S.diffCount(CONF, IDX, s) ? '<span class="tag warn" title="伝票と、運送会社に渡った送り状で、違う・切れている・入っていない項目があります（カードを押すと見比べられます）">送り状と違うかも</span>' : '') +
    '<span class="sc-no">売上№ ' + esc(s.no) + (s.shipNo ? '　出荷№ ' + esc(s.shipNo) : '') + '</span></div>' +
    '<div class="sc-slips">' + slipsHtml(s, st) + '</div>' +
    destHtml(s, i) +
    '<div class="sc-grid">' +
    '<div><span class="k">得意先</span>' + esc(s.custName || '-') + (s.cust ? ' <span class="muted">' + esc(s.cust) + '</span>' : '') + '</div>' +
    '<div><span class="k">受注№</span><span style="display:inline-block;vertical-align:top">' + juchuHtml(s) + '</span></div>' +
    '<div><span class="k">客先注番</span>' + ((s.po || []).length ? s.po.map(p => '<span class="lnk" data-act="q" data-v="' + esc(p) + '">' + esc(p) + '</span>').join('　') : '<span class="muted">-</span>') + '</div>' +
    (want ? '<div><span class="k">配送指定</span>' + esc(want) + '</div>' : '') +
    '<div><span class="k">担当</span>' + esc(s.staff || '-') + '</div>' +
    '</div>' +
    '<div class="sc-lines" id="ln-' + i + '">' + linesHtml(s, i) + '</div>' +
    bunnoHtml(s) +
    '</div>';
}

/* ------------------------------------------------------------ 出荷連絡（右のパネル）
 * 文面は ship_config.json の notice。ここで直してから、コピー・メール作成（mailto：Outlook など、いつも使うメールのアプリが開く）。
 * 自動では送らない。担当者が中身を確認して使う。 */
const MAIL_LIMIT = 8000;   // mailto の長さ（日本語は1文字が9文字ぶんになる。長すぎると、メールのアプリが開けない・途中で切ることがある）
function openNotice(s) {
  const n = S.noticeText(CONF, IDX, s), warn = [];
  if (n.isReturn) warn.push('返品の伝票です。出荷の連絡には使えません（数量がマイナスの行があります）。');
  if (!n.hasSlip) warn.push('送り状番号がまだありません。番号が入ってから、もう一度開いてください。');
  if (!n.hasAddr) warn.push('住所の登録がありません（納品先の名前だけの案内になります）。');
  $('np-warn').innerHTML = warn.map(m => '<div>⚠ ' + esc(m) + '</div>').join('');
  $('np-warn').hidden = !warn.length;
  $('np-subject').value = n.subject; $('np-text').value = n.body;
  $('np-note').textContent = '住所は、SMILE の納品先マスタ（得意先マスタ）の、いまの内容です。出荷した時点の住所とは違うことがあります。';
  $('noticePanel').hidden = false; $('noticeBackdrop').hidden = false;
  document.body.classList.add('np-open');
  $('np-text').focus();
}
function closeNotice() { $('noticePanel').hidden = true; $('noticeBackdrop').hidden = true; document.body.classList.remove('np-open'); }
function wireNotice() {
  $('np-close').onclick = closeNotice; $('noticeBackdrop').onclick = closeNotice;
  $('dt-close').onclick = closeDetail; $('detailBackdrop').onclick = closeDetail;
  $('detailBody').addEventListener('click', async e => {   // パネルの中：分納の行で別の出荷へ、番号のコピー
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'detailno') { const s = IDX.ships.find(x => x.no === a.dataset.no); if (s) { openDetail(s); $('detailBody').scrollTop = 0; } }
    else if (a.dataset.act === 'copy') { const ok = await copyText(a.dataset.v), t = a.textContent; a.textContent = ok ? 'コピーしました' : 'コピーできません'; setTimeout(() => { a.textContent = t; }, 1500); }
  });
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!$('noticePanel').hidden) closeNotice(); if (!$('detailPanel').hidden) closeDetail(); });
  $('np-copy').onclick = async () => {
    const b = $('np-copy'), t = b.textContent, ok = await copyText($('np-text').value);
    b.textContent = ok ? 'コピーしました' : 'コピーできません'; setTimeout(() => { b.textContent = t; }, 1500);
  };
  $('np-mail').onclick = () => {
    const subj = $('np-subject').value, body = $('np-text').value.replace(/\r?\n/g, '\r\n');
    const url = 'mailto:?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(body);
    if (url.length > MAIL_LIMIT) { $('np-note').textContent = '文が長いので、メールが途中で切れることがあります。「本文をコピー」で、メールに貼り付けてください。'; return; }
    location.href = url;
  };
}

/* ------------------------------------------------------------ 伝票の詳細（カードを押すと開く。SMILE の伝票ふうの表示）
 * 品目の全行・単価・金額・摘要・備考・社内メモは、別のファイル ship_detail.json（専用機が索引と一緒に作る）から、押したときに初めて読む。
 * 原価・粗利は入っていない。 */
let DETAIL = null;   // { details, generatedAt }（読めたら持っておく）
async function loadDetail(force) {
  if (DETAIL && !force) return DETAIL;
  const r = await fetchText(CONF.files.detail || 'ship_detail.json');
  const o = JSON.parse(r.text);
  if (!o || typeof o.details !== 'object') throw new Error('伝票の詳細の形が違います');
  DETAIL = { details: o.details, generatedAt: o.generatedAt || '' };
  return DETAIL;
}
async function openDetail(s) {
  $('detailBody').innerHTML = '<div class="muted" style="padding:20px">読み込み中…</div>';
  $('detailPanel').hidden = false; $('detailBackdrop').hidden = false; document.body.classList.add('np-open');
  try {
    const D = await loadDetail();
    $('detailBody').innerHTML = detailHtml(s, D.details[s.no], D.generatedAt);
  } catch (e) {
    console.warn(e);
    $('detailBody').innerHTML = detailHtml(s, null, '') + '<div class="alert warn">伝票の詳細（' + esc(CONF.files.detail || 'ship_detail.json') + '）を読めませんでした：' + esc(e.message) + '。専用機の定時実行がまだか、データが作られていません。</div>';
  }
}
function closeDetail() { $('detailPanel').hidden = true; $('detailBackdrop').hidden = true; document.body.classList.remove('np-open'); }
// 伝票（SMILE）と送り状（運送会社のデータ）の見比べの表。違うかもしれない項目は黄色（表記ゆれで違って見えることもあるので、断定しない）
function compareHtml(s, sl) {
  const E = esc, rows = (sl.n || sl.a || sl.z || sl.w || sl.m) ? S.compareSlip(CONF, IDX, s, sl) : [], nd = rows.filter(r => r.st === 'diff' || r.st === 'cut' || r.st === 'missing').length;
  let h = '<div class="cmp-one">' + slipLine(sl, s);
  if (!rows.length) return h + '<div class="muted" style="margin-top:4px;font-size:12px">この送り状には、お届け先などの控えがありません（運送会社のデータが古い形か、引き継いだ番号です）。</div></div>';
  h += '<table class="cmp-t"><thead><tr><th></th><th>伝票（SMILE）</th><th>送り状（' + E(S.carrierName(CONF, sl.c)) + '）</th><th></th></tr></thead><tbody>' +
    rows.map(r => '<tr class="' + r.st + '"><th>' + E(r.k) + '</th><td>' + (E(r.a) || '<span class="muted">-</span>') + '</td><td>' + (E(r.b) || '<span class="muted">-</span>') + '</td><td class="cmp-m">' + ({ ok: '✓', diff: '違うかも', cut: '切れています', missing: '入っていません', none: '', info: '' }[r.st] || '') + '</td></tr>').join('') + '</tbody></table>';
  const hint = rows.some(r => r.st === 'cut') ? '「切れています」は、送り状の欄の長さで、途中までしか入っていません（運送会社ごとに、1つの欄の長さが決まっています。第一貨物＝宛名・住所とも全角15文字（30バイト）、西濃＝名称・住所とも全角30文字（60バイト））。' : '', hint2 = rows.some(r => r.st === 'missing') ? '「入っていません」は、荷受け人名が送り状に入っていません。' : '';
  return h + (nd ? '<div class="alert warn">伝票と送り状で、確認が必要な項目が ' + nd + ' 個あります。' + hint + hint2 + '表記の違い（全角・半角、「様」）のこともあるので、内容を見て確認してください。</div>' : '') + '</div>';
}
function detailHtml(s, d, gen) {
  const E = esc, Z = S.zen, F = S.fmtNum;
  const a = S.addrOf(IDX, s), za = S.zipAddr(a), st = S.slipStatus(CONF, IDX, s), key = S.carrierKeyOf(CONF, s.kubun);
  const it = (k, v) => '<div class="sl-i"><span class="sl-k">' + k + '</span><span class="sl-vv">' + (v === '' || v == null ? '<span class="muted">-</span>' : v) + '</span></div>';
  const j0 = (s.juchu || []).map(no => { const j = S.juchuInfo(IDX, no); return E(no) + (j ? ' <span class="muted">' + [j.date ? '受注 ' + E(fd(j.date)) : '', j.due ? '納期 ' + E(fd(j.due)) : '', j.plan ? '出荷予定 ' + E(fd(j.plan)) : ''].filter(Boolean).join('　') + '</span>' : ''); }).join('<br>');
  const want = [s.want ? fd(s.want) : '', s.time].filter(Boolean).join(' ');
  const T = S.detailTotals(d), hasD = !!(d && d.lines && d.lines.length);
  const banner = d ? '<div class="sl-banner actual">SMILE の出荷伝票の内容' + (gen ? '（' + E(stamp(gen)) + ' 時点）' : '') + '</div>'
                   : '<div class="sl-banner">伝票の詳細がありません（品目の数量だけ出します）</div>';
  let h = '<div class="sl">' + banner +
    '<div class="sl-hd c4">' + it('売上№', E(s.no)) + it('伝票日付', E(fd(s.date))) + it('出荷№', E(s.shipNo || '')) + it('取引', s.ret ? '返品' : '') + '</div>' +
    '<div class="sl-hd c3">' + it('得意先', E(Z(s.custName)) + (s.cust ? ' <span class="muted">' + E(s.cust) + '</span>' : '')) + it('担当者', E(Z(s.staff))) + it('運送業者', logoOf(key) ? logoImg(key, S.kubunName(CONF, s.kubun)) : E(S.kubunName(CONF, s.kubun))) + '</div>' +
    '<div class="sl-hd c2">' + it('納品先', E(Z(S.destLabel(s))) + (s.dest && s.dest !== '000000' ? ' <span class="muted">' + E(s.dest) + '</span>' : '') + (za ? '<br><span class="muted">' + E(za) + '</span>' : '')) + it('客先注番', (s.po || []).map(E).join('　')) + '</div>' +
    '<div class="sl-hd c3">' + it('受注№', j0) + it('配送指定', E(want)) + it('営業所止め', E(Z((d && d.stop) || ''))) + '</div>';
  if (hasD) {
    h += '<div class="sl-tw"><table class="sl-t"><colgroup><col style="width:34px"><col style="width:110px"><col><col style="width:60px"><col style="width:36px"><col style="width:78px"><col style="width:86px"><col style="width:62px"></colgroup>' +
      '<thead><tr><th class="n">行</th><th>品目コード</th><th>品目名</th><th class="n">数量</th><th>単位</th><th class="n">単価</th><th class="n">金額</th><th>課税</th></tr></thead><tbody>' +
      d.lines.map(l => {
        const sub = [l[10] ? '倉庫 ' + E(Z(l[10])) : '', l[8] ? '摘要 ' + E(Z(l[8])) : '', l[9] ? '摘要 ' + E(Z(l[9])) : ''].filter(Boolean).join('・');
        return '<tr><td class="n">' + E(l[0]) + '</td><td>' + E(Z(l[1])) + '</td><td>' + E(Z(l[2])) + '</td><td class="n">' + E(F(l[3])) + '</td><td>' + E(l[4]) + '</td><td class="n">' + E(F(l[5])) + '</td><td class="n">' + E(F(l[6])) + '</td><td>' + E(l[7]) + '</td></tr>' +
          (sub ? '<tr class="sub"><td></td><td colspan="7">' + sub + '</td></tr>' : '');
      }).join('') + '</tbody></table></div>' +
      '<div class="sl-sum">数量合計 <b>' + E(F(T.qty)) + '</b>小計（税抜） <b>' + E(F(T.sub)) + '</b>消費税 <b>' + E(F(T.tax)) + '</b>合計（税込） <b>' + E(F(T.total)) + '</b></div>' +
      '<div class="sl-hd c1" style="margin-top:4px">' + it('備考', E(Z(d.note))) + it('社内メモ', E(Z(d.memo))) + '</div>';
  } else {
    h += '<div class="sl-tw"><table class="sl-t"><thead><tr><th>品目コード</th><th>品目名</th><th class="n">数量</th></tr></thead><tbody>' +
      (s.lines || []).map(l => '<tr><td>' + E(Z(l[0])) + '</td><td>' + E(Z(l[1])) + '</td><td class="n">' + E(F(l[2])) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  h += '</div>';
  h += bunnoHtml(s);
  h += '<h3 class="dt-h">伝票と送り状の見比べ</h3>' + (s.slips && s.slips.length ? s.slips.map(sl => compareHtml(s, sl)).join('') : '<div class="slip-none' + (st.code === 'missing' || st.code === 'nodata' ? ' warn' : '') + '">' + E(st.text || '送り状番号はまだありません') + '</div>');
  return h;
}

/* ------------------------------------------------------------ 画面の下のほうと注意 */
function renderMeta() {
  const w = S.warnings(IDX, CONF, Date.now());
  $('warnBox').hidden = !w.length;
  $('warnBox').innerHTML = w.map(m => '<div>⚠ ' + esc(m) + '</div>').join('');
  const um = IDX.unmatched || [];
  $('unmatchedBox').hidden = !um.length;
  if (um.length) {
    $('unmatchedTitle').textContent = 'SMILE の出荷明細に見つからない送り状（' + um.length + '件）';
    $('unmatchedList').innerHTML = '<table class="lt"><thead><tr><th>運送会社</th><th>売上№（管理番号）</th><th>送り状番号</th><th>出荷日</th></tr></thead><tbody>' +
      um.slice(0, 200).map(u => '<tr><td>' + esc(S.carrierName(CONF, u.c)) + '</td><td>' + esc(u.key) + '</td><td>' + esc(u.slip) + '</td><td>' + esc(fd(u.date)) + '</td></tr>').join('') + '</tbody></table>' +
      (um.length > 200 ? '<div class="muted">ほか ' + (um.length - 200) + ' 件</div>' : '');
  }
  const lines = ['検索用データの作成：' + stamp(IDX.generatedAt) + '（' + fd(IDX.from) + ' 以降の出荷 ' + IDX.ships.length + ' 件）'];
  (IDX.sources || []).forEach(s => lines.push('SMILE の出力 ' + s.name + '：' + stamp(s.modified)));
  Object.keys(IDX.carriers || {}).forEach(k => {
    const c = IDX.carriers[k];
    lines.push((c.name || k) + '：' + (c.files ? '出荷日 ' + fd(c.from) + ' ～ ' + fd(c.to) + '・ファイル ' + c.files + ' 個・最新 ' + stamp(c.newest) : 'データがまだありません'));
  });
  if (IDX.counts && IDX.counts.blankKey) lines.push('管理番号が空で、つなげられなかった送り状：' + IDX.counts.blankKey + ' 行');
  $('stateList').innerHTML = lines.map(l => '<div>' + esc(l) + '</div>').join('');
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
  $('searchForm').onsubmit = e => { e.preventDefault(); doSearch(); };
  let timer = null;
  $('f-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 250); });
  ['f-from', 'f-to'].forEach(id => $(id).addEventListener('change', () => { period = ''; drawPeriods(); doSearch(); }));
  $('f-status').addEventListener('change', doSearch);
  $('carriers').addEventListener('click', e => {
    const c = e.target.closest('[data-carrier]'); if (!c) return;
    carrier = c.dataset.carrier; drawCarriers(); doSearch();
  });
  $('btn-clear').onclick = () => { $('f-q').value = ''; $('f-from').value = ''; $('f-to').value = ''; carrier = ''; $('f-status').value = ''; period = ''; drawPeriods(); drawCarriers(); doSearch(); $('f-q').focus(); };
  wireNotice();
  $('btn-more').onclick = more;
  $('periods').addEventListener('click', e => {
    const c = e.target.closest('[data-period]'); if (!c) return;
    period = c.dataset.period; const p = PERIODS.find(x => x.k === period);
    $('f-from').value = p && p.days ? today(-p.days) : ''; $('f-to').value = '';
    drawPeriods(); doSearch();
  });
  $('list').addEventListener('click', async e => {
    const a = e.target.closest('[data-act]');
    if (!a) {   // カードの空いているところを押したら、伝票の詳細を開く（リンク・ボタン・文字の選択中は開かない）
      const c = e.target.closest('.scard');
      if (c && !e.target.closest('a, button, input, textarea, select') && !String(window.getSelection && window.getSelection()).trim()) { const s = results[+c.dataset.i]; if (s) openDetail(s); }
      return;
    }
    if (a.dataset.act === 'copy') {
      const ok = await copyText(a.dataset.v), t = a.textContent;
      a.textContent = ok ? 'コピーしました' : 'コピーできません'; setTimeout(() => { a.textContent = t; }, 1500);
    } else if (a.dataset.act === 'q') {
      $('f-q').value = a.dataset.v; $('f-from').value = ''; $('f-to').value = ''; carrier = ''; $('f-status').value = ''; period = ''; drawPeriods(); drawCarriers(); doSearch(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (a.dataset.act === 'detail') {
      const s = results[+a.dataset.i]; if (s) openDetail(s);
    } else if (a.dataset.act === 'detailno') {
      const s = IDX.ships.find(x => x.no === a.dataset.no); if (s) openDetail(s);
    } else if (a.dataset.act === 'notice') {
      const s = results[+a.dataset.i]; if (s) openNotice(s);
    } else if (a.dataset.act === 'lines') {
      const s = results[+a.dataset.i]; if (!s) return;
      s._open = true; $('ln-' + a.dataset.i).innerHTML = linesHtml(s, a.dataset.i);
    }
  });
  $('btn-reload').onclick = async () => {
    $('btn-reload').disabled = true; setStatus('loading', '読み込み中…');
    try { await loadIndex(); renderMeta(); doSearch(); setReady(); } catch (e) { setStatus('err', '読み込めませんでした：' + e.message); }
    $('btn-reload').disabled = false;
  };
}
function setReady() {
  setStatus('ok', '検索用データ ' + stamp(IDX.generatedAt) + ' 作成（' + IDX.ships.length + ' 件）');
}

/* ------------------------------------------------------------ 起動 */
async function initAuth() {
  if (typeof msal === 'undefined') { showLoginError('MSALライブラリを読み込めませんでした。再読み込みしてください。'); return; }
  msalInstance = new msal.PublicClientApplication(HanaokaAuth.msalConfig());
  await msalInstance.initialize();
  await msalInstance.handleRedirectPromise();
  window.enterApp = async () => {
    $('loginScreen').style.display = 'none';
    try { CONF = await (await fetch(CONFIG_URL, { cache: 'no-cache' })).json(); } catch (e) { setStatus('err', '設定ファイル（' + CONFIG_URL + '）を読めません'); return; }
    const n = account.name || account.username;
    $('sp-user').textContent = n; $('sp-avatar').textContent = (n || '?').charAt(0);
    setStatus('loading', 'SharePoint（SharedMasters）から読み込み中…');
    await loadSharedConfig();
    buildFilters(); wire();
    const q = new URLSearchParams(location.search).get('q');
    if (q) $('f-q').value = q;
    try { await loadIndex(); }
    catch (e) { console.warn(e); setStatus('err', '検索用のデータ（' + CONF.files.index + '）を読めません：' + e.message + '。専用機の定時実行がまだか、データが作られていません'); $('list').innerHTML = '<div class="empty">検索用のデータがありません</div>'; return; }
    renderMeta(); doSearch(); setReady();
    setInterval(() => { if (document.visibilityState === 'visible') { try { renderMeta(); } catch (e) { /* 注意の表示だけ */ } } }, 10 * 60 * 1000);   // 開きっぱなしでも、古さの警告を更新する
  };
  $('loginBtn').onclick = async () => {
    try { $('loginError').style.display = 'none'; account = await HanaokaAuth.login(msalInstance, SCOPES); await window.enterApp(); }
    catch (e) { showLoginError('サインインに失敗しました: ' + e.message); }
  };
  account = await HanaokaAuth.restore(msalInstance, SCOPES);
  if (account) await window.enterApp();
}
initAuth();
