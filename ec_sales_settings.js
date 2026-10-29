/* EC売上アプリの「対応表・設定」を、SharedMasters の共有ファイル（ec_sales_settings.json）に保存・読込する部品。
 * 画面（ec_sales.html）に依存しないので Node でテストできる（tests/test_ec_sales_settings.cjs。fetch を差し替えて Graph を真似る）。
 *
 * 共有ファイルの中身：{ version, updatedAt, updatedBy, mapping:{ rules, leadDays, leadOverrides }, cfg:{ cutoffTime, closedDates } }
 *   cfg は納期に関わる 2 つだけ。得意先・担当者のコードなどの業務設定は ec_sales_config.json（リポジトリ）のまま。
 * 読込：共有ファイルがあれば、リポジトリの既定（ec_sales_config.json の mapping／config）より優先。無ければ既定。
 * 保存：編集者（管理者＋ _rpa_queue/ec_settings_editors.json の人）だけ。ETag（If-Match）で、読んだ後に他の人が更新していたら上書きしない。
 *
 * 使い方：
 *   const io = EcSettings.create({ getToken, getWriteToken, driveId, fileName: 'ec_sales_settings.json' });
 *   const { settings, etag } = await io.read();               // settings は無ければ null
 *   await io.write(EcSettings.fileOf(mapping, cfg, by, at), etag);   // 競合なら e.conflict === true */
(function (root) {
  'use strict';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var EC = root.EcSales || (typeof require === 'function' ? require('./ec_sales_core.js') : null);

  var SCOPE_LABEL = { body: '本体', option: 'オプション', single: '単品' };
  var MATCH_LABEL = { contains: 'を含む', starts: 'で始まる', exact: 'とちょうど同じ' };
  var RULE_FIELDS = [
    ['scope', '区分'], ['label', '名前'], ['words', '商品名の言葉'], ['match', 'あてはめ方'], ['qtyUnit', '数量の単位'], ['pattern', '詳細な指定（旧）'],
    ['code', '品目コード'], ['net', '標準単価（税抜）'], ['includes', 'セット内'], ['swap', '色の差し替え'], ['qty', '数量'], ['leadDays', '納期（営業日）'], ['note', 'メモ'], ['warn', '確認の文言']
  ];
  var FIELD_LABEL = {}; RULE_FIELDS.forEach(function (f) { FIELD_LABEL[f[0]] = f[1]; });
  var yen = function (n) { return '¥' + Math.round(n).toLocaleString('ja-JP'); };
  function clone(x) { return JSON.parse(JSON.stringify(x, function (k, v) { return k[0] === '_' ? undefined : v; })); }

  /* ============================================================ 表示用の文章 */
  function itemName(items, code) { return code && items && items[code] ? items[code].name : ''; }
  function wordsText(r) {
    if (!(r.words && r.words.length) && r.pattern) return '詳細な指定（旧）：' + r.pattern;
    var w = (r.words || []).map(function (x) { return '「' + x + '」'; });
    if (!w.length) return '（言葉が未入力）';
    var m = r.match || 'contains';
    return (w.length > 1 ? w.join('、') + ' のどれか' : w[0]) + (m === 'contains' ? 'を含む' : m === 'starts' ? 'で始まる' : 'とちょうど同じ');
  }
  // ルール1つ →「SMILE に入る内容」を縦に積む行。{ role, code, name, qty, price, text }
  function describeRule(r, items, leadDefault) {
    var lines = [], missing = [], itemsOk = !!items;
    function line(role, code, qty, price) {
      var nm = itemName(items, code);
      if (code && itemsOk && !items[code]) missing.push(code);
      lines.push({ role: role, code: code || '', name: nm, qty: qty, price: price });
    }
    if (r.scope === 'body') {
      line('本体', r.code, '×注文の数量', '合計から計算（値引きは本体が吸収）');
      (r.includes || []).forEach(function (x) { line('＋セット内', x.code, '×' + x.qty + '（注文の数量ごと）', x.net != null ? '標準単価 ' + yen(x.net) : '標準単価なし'); });
    } else if (r.scope === 'option') {
      if (r.swap) lines.push({ role: '色の差し替え', code: '', name: '', qty: '', price: '', text: '色はオプションの文言で ' + r.swap.from + '→' + r.swap.to });
      if (r.code) line('オプション', r.code, r.qtyUnit ? '×N（商品名の「N」' + r.qtyUnit + '）' : '×' + (r.qty || 1), r.net != null ? '標準単価 ' + yen(r.net) : '標準単価なし');
    } else {
      line('単品', r.code, '×注文の数量', r.net != null ? '標準単価 ' + yen(r.net) : '商品の値段から計算');
    }
    return {
      scopeLabel: SCOPE_LABEL[r.scope] || r.scope, words: wordsText(r), lines: lines, missing: missing,
      lead: r.leadDays != null ? r.leadDays + '営業日' : '既定' + (leadDefault == null ? '' : ' ' + leadDefault + '営業日'),
      note: r.note || r.warn || ''
    };
  }
  function ruleLabel(r) { return r.label || '（名前なし）'; }

  /* ============================================================ 入力の検証（確認の画面の前に） */
  function validateRule(r, items) {
    var e = [], isNum = function (v) { return v == null || v === '' || (isFinite(v) && +v >= 0); };
    if (!SCOPE_LABEL[r.scope]) e.push('区分を選んでください');
    if (!String(r.label || '').trim()) e.push('名前を入力してください');
    if (!(r.words && r.words.length) && !r.pattern) e.push('商品名の言葉を入力してください');
    if (r.pattern) { try { new RegExp(r.pattern); } catch (x) { e.push('詳細な指定の書き方が正しくありません'); } }
    if (!r.swap && !String(r.code || '').trim()) e.push('品目コードを入力してください');
    if (r.swap && (!r.swap.from || !r.swap.to)) e.push('色の差し替えは、元と先の品目コードを入れてください');
    if (!isNum(r.net)) e.push('標準単価は 0 以上の数字で入れてください');
    if (r.leadDays != null && r.leadDays !== '' && !(isFinite(r.leadDays) && +r.leadDays >= 0 && Math.floor(r.leadDays) === +r.leadDays)) e.push('納期（営業日）は 0 以上の整数で入れてください');
    (r.includes || []).forEach(function (x, i) {
      if (!String(x.code || '').trim()) e.push('セット内 ' + (i + 1) + ' 行目の品目コードが空です');
      if (!(+x.qty > 0)) e.push('セット内 ' + (i + 1) + ' 行目の数量は 1 以上で入れてください');
      if (!isNum(x.net)) e.push('セット内 ' + (i + 1) + ' 行目の標準単価は 0 以上の数字で入れてください');
    });
    return e;
  }
  // 入力欄の値を、保存する形にそろえる（空の項目は持たない）
  function normalizeRule(r) {
    var o = clone(r), num = function (v) { return v === '' || v == null ? null : +v; };
    o.label = String(o.label || '').trim();
    o.code = String(o.code || '').trim();
    if (o.words) o.words = o.words.map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (o.net !== undefined) { o.net = num(o.net); }
    if (o.leadDays !== undefined) { if (num(o.leadDays) == null) delete o.leadDays; else o.leadDays = num(o.leadDays); }
    if (o.scope !== 'option') { delete o.qtyUnit; delete o.swap; }
    if (o.scope !== 'body') delete o.includes;
    if (o.qtyUnit === '') delete o.qtyUnit;
    if (o.includes) { o.includes = o.includes.map(function (x) { return { code: String(x.code || '').trim(), qty: +x.qty, net: num(x.net) }; }); if (!o.includes.length) delete o.includes; }
    if (!o.note) delete o.note; if (!o.warn) delete o.warn;
    if (o.swap) { o.swap = { from: String(o.swap.from || '').trim(), to: String(o.swap.to || '').trim() }; delete o.code; }
    return o;
  }

  /* ============================================================ 共有ファイルの形 */
  function fileOf(mapping, cfg, by, at) {
    var m = clone(mapping);
    return {
      version: 1, updatedAt: at, updatedBy: by,
      mapping: { rules: m.rules || [], leadDays: m.leadDays, leadOverrides: m.leadOverrides || [] },
      cfg: { cutoffTime: cfg.cutoffTime, closedDates: (cfg.closedDates || []).slice() }
    };
  }
  // 既定（base＝{mapping,cfg}）の上に、共有ファイルの内容を重ねる。cfg は納期の 2 項目だけ
  function applyFile(base, file) {
    var mapping = clone(base.mapping), cfg = clone(base.cfg);
    if (file && file.mapping) {
      if (Array.isArray(file.mapping.rules)) mapping.rules = clone(file.mapping.rules);
      if (file.mapping.leadDays != null) mapping.leadDays = file.mapping.leadDays;
      if (Array.isArray(file.mapping.leadOverrides)) mapping.leadOverrides = clone(file.mapping.leadOverrides);
    }
    if (file && file.cfg) {
      if (file.cfg.cutoffTime) cfg.cutoffTime = file.cfg.cutoffTime;
      if (Array.isArray(file.cfg.closedDates)) cfg.closedDates = file.cfg.closedDates.slice();
    }
    return { mapping: mapping, cfg: cfg };
  }
  // 設定を編集できる人：管理者（ec_import_admins.json）＋ 編集者（ec_settings_editors.json）
  function listOf(o, key) { return Array.isArray(o) ? o : (o && Array.isArray(o[key]) ? o[key] : []); }
  function canEdit(me, admins, editors) {
    me = String(me || '').toLowerCase(); if (!me) return false;
    return listOf(admins, 'admins').concat(listOf(editors, 'editors')).some(function (m) { return String(m).toLowerCase() === me; });
  }

  /* ============================================================ 変更前後の差 */
  function fmtVal(k, v) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return k === 'net' ? '（合計から計算）' : k === 'leadDays' ? '（既定）' : '（なし）';
    if (k === 'scope') return SCOPE_LABEL[v] || v;
    if (k === 'match') return { contains: '含む', starts: '始まる', exact: 'ちょうど同じ' }[v] || v;
    if (k === 'words') return v.join('、');
    if (k === 'includes') return v.map(function (x) { return x.code + '×' + x.qty + (x.net != null ? '（' + yen(x.net) + '）' : ''); }).join('、');
    if (k === 'swap') return v.from + '→' + v.to;
    if (k === 'net') return yen(v);
    return String(v);
  }
  function same(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  function ruleFieldDiff(a, b) {
    var out = [];
    RULE_FIELDS.forEach(function (f) { var k = f[0]; if (!same(a[k], b[k]) && !(a[k] == null && b[k] == null)) out.push({ k: k, label: f[1], before: fmtVal(k, a[k]), after: fmtVal(k, b[k]) }); });
    return out;
  }
  // before / after は { mapping, cfg }。戻り値 { rules:[{type:'add'|'del'|'edit'|'move', id, label, fields}], settings:[{label,before,after}], count, summary:[文] }
  function diffSettings(before, after) {
    var br = (before.mapping.rules || []), ar = (after.mapping.rules || []), bi = {}, ai = {};
    br.forEach(function (r) { bi[r.id] = r; }); ar.forEach(function (r) { ai[r.id] = r; });
    var rules = [], settings = [];
    br.forEach(function (r) { if (!ai[r.id]) rules.push({ type: 'del', id: r.id, label: ruleLabel(r), fields: [] }); });
    ar.forEach(function (r) {
      if (!bi[r.id]) { rules.push({ type: 'add', id: r.id, label: ruleLabel(r), fields: ruleFieldDiff({}, r) }); return; }
      var f = ruleFieldDiff(bi[r.id], r); if (f.length) rules.push({ type: 'edit', id: r.id, label: ruleLabel(r), fields: f });
    });
    // 順番：両方にあるルールだけを並べて、位置が変わったもの
    var bc = br.filter(function (r) { return ai[r.id]; }).map(function (r) { return r.id; }), ac = ar.filter(function (r) { return bi[r.id]; }).map(function (r) { return r.id; });
    ac.forEach(function (id, i) { if (bc[i] !== id) rules.push({ type: 'move', id: id, label: ruleLabel(ai[id]), fields: [{ label: '順番', before: (bc.indexOf(id) + 1) + '番目', after: (i + 1) + '番目' }] }); });
    var bm = before.mapping, am = after.mapping, bc2 = before.cfg || {}, ac2 = after.cfg || {};
    if (!same(bm.leadDays, am.leadDays)) settings.push({ label: '既定の納期（営業日）', before: String(bm.leadDays), after: String(am.leadDays) });
    if (!same(bc2.cutoffTime, ac2.cutoffTime)) settings.push({ label: '締め時刻', before: String(bc2.cutoffTime || ''), after: String(ac2.cutoffTime || '') });
    var bd = bc2.closedDates || [], ad = ac2.closedDates || [];
    if (!same(bd, ad)) {
      var add = ad.filter(function (x) { return bd.indexOf(x) < 0; }), rem = bd.filter(function (x) { return ad.indexOf(x) < 0; });
      settings.push({ label: '個別の休み', before: rem.length ? '削除：' + rem.join('、') : (bd.length + '日'), after: add.length ? '追加：' + add.join('、') : (ad.length + '日') });
    }
    var bo = bm.leadOverrides || [], ao = am.leadOverrides || [];
    if (!same(bo, ao)) {
      var ot = function (a) { return a.length ? a.map(function (o) { return o.from + '〜' + o.to + ' ' + o.days + '営業日' + ((o.codes || []).length ? '（' + o.codes.join(',') + '）' : ''); }).join('／') : '（なし）'; };
      settings.push({ label: '期間の例外', before: ot(bo), after: ot(ao) });
    }
    var summary = [];
    rules.forEach(function (x) {
      summary.push(x.type === 'add' ? 'ルール「' + x.label + '」を追加' : x.type === 'del' ? 'ルール「' + x.label + '」を削除' : x.type === 'move' ? 'ルール「' + x.label + '」の順番を変更'
        : 'ルール「' + x.label + '」を編集（' + x.fields.map(function (f) { return f.label; }).join('・') + '）');
    });
    settings.forEach(function (x) { summary.push('設定の変更（' + x.label + '）'); });
    return { rules: rules, settings: settings, count: rules.length + settings.length, summary: summary };
  }
  // EC_Log の Detail。変更の要約だけ（お客様の情報は入らない）
  function logDetail(diff) {
    var s = diff.summary.join('／');
    return s.length > 250 ? s.slice(0, 247) + '…' : s;
  }
  // 旧：この端末（localStorage）に残っている対応表・設定が、既定と違うか
  function migrationPlan(legacy, base) {
    if (!legacy || !legacy.mapping) return { needed: false, diff: null };
    var d = diffSettings(base, { mapping: legacy.mapping, cfg: Object.assign({}, base.cfg, { cutoffTime: (legacy.cfg || {}).cutoffTime || base.cfg.cutoffTime, closedDates: (legacy.cfg || {}).closedDates || base.cfg.closedDates || [] }) });
    return { needed: d.count > 0, diff: d };
  }

  /* ============================================================ このルールで当たる最近の注文 */
  // orders：Shopify の注文（createdAt, name, lines）。mapping のうちこのルール（id）が使われた行を、新しい順に最大 n 件
  function recentMatches(rule, orders, mapping, n) {
    var m = clone(mapping), i = m.rules.findIndex(function (r) { return r.id === rule.id; });
    if (i >= 0) m.rules[i] = clone(rule); else m.rules.push(clone(rule));
    var out = [], list = (orders || []).slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
    for (var k = 0; k < list.length && out.length < n; k++) {
      var o = list[k];
      for (var j = 0; j < o.lines.length && out.length < n; j++) {
        var r = EC.mapLine(o.lines[j], m, o.createdAt);
        if (r.items.some(function (it) { return it.ruleId === rule.id; })) out.push({ orderName: o.name, date: o.createdAt, productName: o.lines[j].name });
      }
    }
    return out;
  }
  // 一覧の検索：言葉・名前・品目コード
  function searchRules(rules, q) {
    q = EC.matchKey ? EC.matchKey(q || '') : String(q || '').toLowerCase();
    if (!q) return rules.map(function (r, i) { return i; });
    var out = [];
    rules.forEach(function (r, i) {
      var hay = [r.label, (r.words || []).join(' '), r.pattern, r.code, (r.includes || []).map(function (x) { return x.code; }).join(' '), r.swap ? r.swap.from + ' ' + r.swap.to : '', r.note, r.warn].join(' ');
      if ((EC.matchKey ? EC.matchKey(hay) : hay.toLowerCase()).indexOf(q) >= 0) out.push(i);
    });
    return out;
  }

  /* ============================================================ SharedMasters の読み書き（Graph） */
  function create(opt) {
    var fetchFn = opt.fetchImpl || function () { return root.fetch.apply(root, arguments); };
    var api = {};
    function pathUrl(p) { return GRAPH + '/drives/' + opt.driveId + '/root:/' + String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
    async function call(url, o, write) {
      var token = await (write && opt.getWriteToken ? opt.getWriteToken() : opt.getToken());
      o = o || {};
      var res = await fetchFn(url, { method: o.method || 'GET', headers: Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {}), body: o.body });
      return res;
    }
    function fail(res, text) { var e = new Error('Graph ' + res.status); e.status = res.status; e.detail = text || ''; e.conflict = res.status === 412 || res.status === 409; return e; }
    // 共有に接続できない（権限なし・ネットワーク）か。そのときは既定で動き続ける
    api.isUnavailable = function (e) { return !e || !e.status || e.status === 401 || e.status === 403; };
    api.isConflict = function (e) { return !!(e && e.conflict); };

    async function meta(p) {
      var res = await call(pathUrl(p) + '?$select=id,eTag,lastModifiedDateTime');
      if (res.status === 404) return null;
      if (!res.ok) throw fail(res);
      var j = await res.json(); return { etag: j.eTag, modified: j.lastModifiedDateTime || '' };
    }
    api.readJson = async function (p) {
      var res = await call(pathUrl(p) + ':/content');
      if (res.status === 404) return null;
      if (!res.ok) throw fail(res);
      return res.json();
    };
    // 戻り値 { settings（無ければ null）, etag, modified }。内容と ETag がずれないように、前後で ETag を見て、違えば読み直す
    api.read = async function () {
      for (var i = 0; i < 3; i++) {
        var m1 = await meta(opt.fileName);
        if (!m1) return { settings: null, etag: null, modified: '' };
        var settings = await api.readJson(opt.fileName);
        var m2 = await meta(opt.fileName);
        if (m2 && m2.etag === m1.etag) return { settings: settings, etag: m1.etag, modified: m1.modified };
      }
      throw new Error('共有の設定を読み直しても落ち着きません（他の人が保存中）。もう一度「更新」を押してください');
    };
    // etag を渡すと、その版のときだけ上書き（If-Match）。null なら新規作成のみ（すでにあれば競合）
    api.write = async function (settings, etag) {
      var url = pathUrl(opt.fileName) + ':/content' + (etag ? '' : '?@microsoft.graph.conflictBehavior=fail');
      var res = await call(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, etag ? { 'If-Match': etag } : {}), body: JSON.stringify(settings, null, 2) }, true);
      if (!res.ok) { var t = ''; try { t = String(await res.text()).slice(0, 300); } catch (x) {} throw fail(res, t); }
      var j = await res.json(); return { etag: j.eTag };
    };
    return api;
  }

  var api = {
    create: create, describeRule: describeRule, wordsText: wordsText, validateRule: validateRule, normalizeRule: normalizeRule,
    fileOf: fileOf, applyFile: applyFile, canEdit: canEdit, diffSettings: diffSettings, logDetail: logDetail, migrationPlan: migrationPlan,
    recentMatches: recentMatches, searchRules: searchRules, fmtVal: fmtVal, SCOPE_LABEL: SCOPE_LABEL, FIELD_LABEL: FIELD_LABEL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EcSettings = api;
})(typeof window !== 'undefined' ? window : globalThis);
