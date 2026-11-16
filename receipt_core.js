/* 領収証（Shopify で購入されたお客様向け）の計算部品。画面とは別にして、node でテストできるようにしてある（tests/test_receipt_core.cjs）。
 * 発行できる注文か・金額の上限・消費税の内訳・領収証番号・入力の検査・印刷用の HTML の組み立てをここに持つ。
 * 記録の読み書きは receipt_store.js、画面（発行の画面・札・ボタン）は receipt_ui.js。
 * 領収証は、自社が発行する書類で、お客様の希望を受けて営業が出す。ふるさと納税には付けない（EC のみ）。
 * 社名・住所・電話・登録番号・社印は、コードに書かない。SharedMasters の設定ファイル receipt_settings.json（と社印の画像）から画面が読んで渡す。 */
(function (root) {
  'use strict';
  var R = {};

  R.STATUS = { issued: '発行済', voided: '取消' };   // EC_Receipt の Status の選択肢（scripts/create_ec_lists.ps1 と同じ言葉）
  R.MAX_AMOUNT = 99999999;                            // 1枚の金額の上限（税込）。桁あふれ・打ち間違いの安全弁
  R.DEFAULT_PROVISO = '商品代として';
  R.TITLES = ['様', '御中', ''];                       // 宛名の敬称（'' ＝付けない）

  /* ---------------------------------------------------------------- 小道具 */
  R.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  R.yen = function (n) { return '¥' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  R.digits = function (s) { return String(s == null ? '' : s).replace(/\D/g, ''); };
  R.orderNo = function (id) { return R.digits(id); };   // 注文番号（# なしの数字）。EC_Order と同じ
  // 今日（日本時間 UTC+9）。yyyy-mm-dd
  R.todayJst = function (now) { return new Date((now || new Date()).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); };
  R.yearJst = function (now) { return +R.todayJst(now).slice(0, 4); };
  function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
    return d.toISOString().slice(0, 10) === s;
  }
  R.validDate = validDate;
  R.jaDate = function (s) { return validDate(s) ? +s.slice(0, 4) + '年' + (+s.slice(5, 7)) + '月' + (+s.slice(8, 10)) + '日' : ''; };
  function nfkc(s) { s = String(s == null ? '' : s); try { return s.normalize('NFKC'); } catch (e) { return s; } }
  // 1行の文字に整える：改行・制御文字を空白にし、前後の空白を除く（全角の空白は、そのまま）
  function oneLine(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/^[ \t]+|[ \t]+$/g, ''); }

  /* ---------------------------------------------------------------- 注文の情報（画面ごとに持っている形のちがいを、ここでそろえる）
   * 入力＝{ no, financial, cancelledAt, total, refunded, shipCompany, shipName, billCompany, billName }（Shopify の値）。 */
  R.orderInfo = function (o) {
    o = o || {};
    return {
      no: R.orderNo(o.no), financial: String(o.financial || '').toLowerCase(), cancelledAt: o.cancelledAt || '',
      total: Number(o.total) || 0, refunded: Number(o.refunded) || 0,
      shipCompany: oneLine(o.shipCompany), shipName: oneLine(o.shipName), billCompany: oneLine(o.billCompany), billName: oneLine(o.billName),
      has: o.has !== false
    };
  };

  /* 発行できる注文か。入金済み（paid）と一部返金（partially_refunded）だけ。
   * 入金待ち・承認済み（未入金）・一部入金・キャンセル・無効・全額返金・Shopify の注文データなしは、発行できない。
   * 戻り値＝{ ok, reason（発行できない理由）, max（発行できる税込の上限＝支払済み−返金）, refundNote（一部返金の注意） } */
  R.eligibility = function (o) {
    o = R.orderInfo(o);
    var out = { ok: false, reason: '', max: 0, refundNote: '' };
    if (!o.has || !o.no) { out.reason = 'Shopify の注文のデータがないため、発行できません'; return out; }
    if (o.cancelledAt || o.financial === 'voided') { out.reason = 'キャンセル（または無効）になった注文のため、発行できません'; return out; }
    if (o.financial === 'refunded') { out.reason = '全額が返金された注文のため、発行できません'; return out; }
    if (o.financial !== 'paid' && o.financial !== 'partially_refunded') {
      out.reason = o.financial === 'pending' || o.financial === 'authorized' || o.financial === 'partially_paid' ? '入金が済んでいない注文のため、まだ発行できません（入金後に発行できます）' : '入金済みの注文だけ、発行できます';
      return out;
    }
    var max = Math.round(o.total - o.refunded);
    if (!(max > 0)) { out.reason = '発行できる金額がありません（支払済みから返金を引くと、0円以下です）'; return out; }
    out.max = Math.min(max, R.MAX_AMOUNT);
    if (o.refunded > 0 || o.financial === 'partially_refunded') out.refundNote = '返金があります（返金 ' + R.yen(o.refunded) + '）。発行できる金額は、支払済み ' + R.yen(o.total) + ' − 返金 ' + R.yen(o.refunded) + ' ＝ ' + R.yen(max) + ' までです';
    out.ok = true;
    return out;
  };

  /* ---------------------------------------------------------------- 消費税の内訳（10%）
   * 税込金額から出す。アプリの既存の税の扱い（税込 ÷ 1.1 を四捨五入して税抜にする。ec_sales_core.js の totalNet と同じ）にそろえ、
   * 税額＝税込 − 税抜。例：11,000 → 税抜 10,000・消費税 1,000／1,000 → 税抜 909・消費税 91／999 → 税抜 908・消費税 91。 */
  R.splitTax = function (gross) {
    gross = Math.round(Number(gross) || 0);
    var net = Math.round(gross / 1.1);
    return { gross: gross, net: net, tax: gross - net };
  };

  /* ---------------------------------------------------------------- 宛名 */
  // 宛名の文字（敬称なし）と敬称に分ける。「株式会社〇〇 御中」→ { name: '株式会社〇〇', title: '御中' }
  R.splitTitle = function (atena) {
    var s = oneLine(atena), m = /^([\s\S]*?)[ 　]*(御中|様|殿)$/.exec(s);
    return m && m[1] ? { name: m[1], title: m[2] === '殿' ? '殿' : m[2] } : { name: s, title: '' };
  };
  R.joinAtena = function (name, title) { name = oneLine(name); return title && name ? name + ' ' + title : name; };

  // 宛名の候補（お届け先の会社名・名前、請求先の会社名・名前）。重複は除く。会社名には御中、名前には様を初めに入れておく
  R.candidates = function (o) {
    o = R.orderInfo(o);
    var list = [], seen = {};
    [[o.shipCompany, '御中'], [o.shipName, '様'], [o.billCompany, '御中'], [o.billName, '様']].forEach(function (p) {
      if (!p[0] || seen[p[0]]) return; seen[p[0]] = 1; list.push({ text: p[0], title: p[1] });
    });
    return list;
  };

  /* 発行の画面の初期値（書き換えられる）。宛名＝お届け先の会社名（なければ名前）、但し書き＝「商品代として」、
   * 金額＝発行できる上限（支払済み−返金）、発行日＝今日（日本時間）。opts＝{ now, proviso } */
  R.defaults = function (o, opts) {
    opts = opts || {};
    var el = R.eligibility(o), c = R.candidates(o);
    return {
      atena: c[0] ? c[0].text : '', title: c[0] ? c[0].title : '様',
      proviso: opts.proviso || R.DEFAULT_PROVISO, amount: el.max || 0, issueDate: R.todayJst(opts.now),
      candidates: c, max: el.max
    };
  };

  /* ---------------------------------------------------------------- 入力の検査
   * form＝{ atena（敬称なし）, title, proviso, amount, issueDate, note }、opts＝{ max（上限）, now }
   * 戻り値＝{ ok, errors:[…（日本語）], warnings:[…], value:{ atena（敬称つき）, proviso, amount, net, tax, issueDate, note } }。
   * 前の画面の入力検査は使いやすさのためだけ（守りは SharePoint の権限）。 */
  R.validate = function (form, opts) {
    form = form || {}; opts = opts || {};
    var errors = [], warnings = [], today = R.todayJst(opts.now);
    var name = oneLine(form.atena), title = R.TITLES.indexOf(form.title) >= 0 ? form.title : '';
    var proviso = oneLine(form.proviso), note = oneLine(form.note);
    if (!name) errors.push('宛名を入れてください');
    else if ((name + (title ? ' ' + title : '')).length > 60) errors.push('宛名が長すぎます（敬称を入れて60文字まで）');
    if (!proviso) errors.push('但し書きを入れてください');
    else if (proviso.length > 60) errors.push('但し書きが長すぎます（60文字まで）');
    if (note.length > 200) errors.push('メモが長すぎます（200文字まで）');
    var amtText = nfkc(form.amount).replace(/[,\s¥円]/g, ''), amount = NaN;
    if (/^\d+$/.test(amtText)) amount = +amtText;
    if (amtText === '') errors.push('金額を入れてください');
    else if (!isFinite(amount)) errors.push('金額は、数字（円・税込）で入れてください');
    else if (amount < 1) errors.push('金額は、1円以上にしてください');
    else if (amount > R.MAX_AMOUNT) errors.push('金額が大きすぎます（' + R.yen(R.MAX_AMOUNT) + ' まで）');
    else if (opts.max != null && amount > opts.max) errors.push('金額が、発行できる上限（' + R.yen(opts.max) + '）を超えています');
    var date = String(form.issueDate || '').slice(0, 10);
    if (!validDate(date)) errors.push('発行日を、日付で入れてください');
    else if (date > today) warnings.push('発行日が、今日より先の日付です');
    var tx = isFinite(amount) && amount >= 1 ? R.splitTax(amount) : { net: 0, tax: 0 };
    return { ok: !errors.length, errors: errors, warnings: warnings, value: { atena: R.joinAtena(name, title), proviso: proviso, amount: isFinite(amount) ? amount : 0, net: tx.net, tax: tx.tax, issueDate: date, note: note } };
  };

  /* ---------------------------------------------------------------- 領収証番号
   * リストの項目の ID（連番）から作る：R-2026-00012（年は、発行した日の日本時間の年。連番は ID なので、年が変わっても続く。取消した番号は、使い回さない）。 */
  R.numberOf = function (id, year) {
    var n = +R.digits(id);
    return 'R-' + (year || R.yearJst()) + '-' + ('00000' + n).slice(-Math.max(5, String(n).length));
  };
  R.isNumber = function (s) { return /^R-\d{4}-\d{5,}$/.test(String(s || '')); };
  R.PENDING_TITLE = '(番号つけ中)';   // 項目を作った直後〜番号を付けるまでの、仮のタイトル

  /* ---------------------------------------------------------------- 記録（リストの行）との変換 */
  var DATE_NOON = function (s) { return s ? String(s).slice(0, 10) + 'T12:00:00Z' : null; };   // 正午(UTC)にして、日本時間でも同じ日になるようにする
  // 画面の記録 → リストに書く項目。お客様の名前（宛名）は、営業・EC担当だけが読めるこのリストにだけ書く
  R.toFields = function (rec) {
    var f = {
      Title: rec.number || R.PENDING_TITLE, OrderNo: R.orderNo(rec.orderNo), Atena: rec.atena, Proviso: rec.proviso,
      Amount: Math.round(rec.amount), Tax: Math.round(rec.tax), IssueDate: DATE_NOON(rec.issueDate), IssuedBy: rec.issuedBy || '',
      Status: rec.status || R.STATUS.issued, ReissueCount: rec.reissueCount || 0, Note: rec.note || '', Source: rec.source || ''
    };
    return f;
  };
  // リストの行（{ id, createdDateTime, fields }）→ 画面の記録
  R.fromItem = function (it) {
    var f = (it && it.fields) || {}, id = String(it && it.id || '');
    var created = (it && it.createdDateTime) || '';
    var number = R.isNumber(f.Title) ? f.Title : R.numberOf(id, created ? R.yearJst(new Date(created)) : R.yearJst());   // 番号が付いていない行も、ID から同じ番号を出す
    return {
      id: id, number: number, numberPending: !R.isNumber(f.Title), orderNo: R.orderNo(f.OrderNo), atena: f.Atena || '', proviso: f.Proviso || '',
      amount: Number(f.Amount) || 0, tax: Number(f.Tax) || 0, issueDate: String(f.IssueDate || '').slice(0, 10), issuedBy: f.IssuedBy || '',
      status: f.Status === R.STATUS.voided ? R.STATUS.voided : R.STATUS.issued, reissueCount: Number(f.ReissueCount) || 0, note: f.Note || '', source: f.Source || '', created: created
    };
  };
  R.isActive = function (rec) { return !!rec && rec.status === R.STATUS.issued; };
  // 1つの注文の記録（新しい順）から、有効なもの（取消でない最新の1枚）
  R.activeOf = function (recs) { return (recs || []).filter(R.isActive)[0] || null; };
  R.sortNewest = function (recs) { return (recs || []).slice().sort(function (a, b) { return (+b.id || 0) - (+a.id || 0); }); };
  // 全部の記録 → { 注文番号: [記録（新しい順）] }
  R.groupByOrder = function (recs) {
    var m = {}; (recs || []).forEach(function (r) { if (r.orderNo) (m[r.orderNo] = m[r.orderNo] || []).push(r); });
    Object.keys(m).forEach(function (k) { m[k] = R.sortNewest(m[k]); });
    return m;
  };
  // 利用ログ・履歴（EC_Log）に書く文。番号だけ。宛名・金額・お客様名は入れない
  R.logDetail = function (rec, what) { return (rec && rec.number ? rec.number : '') + (what ? ' ' + what : ''); };

  /* ---------------------------------------------------------------- 設定ファイル receipt_settings.json
   * SharedMasters に置く。実際の値は、リポジトリに入れない（公開のため）。下は、書き方の見本（架空の値）。 */
  R.SAMPLE_SETTINGS = {
    company: { name: 'サンプル商事株式会社', zip: '000-0000', address: 'サンプル県サンプル市サンプル町0-0-0', tel: '000-000-0000', registrationNo: 'T0000000000000' },
    stampFile: 'receipt_stamp.png',
    footerNote: ''
  };
  // 設定を確かめる。戻り値＝{ ok, missing:[足りない項目の名前] }（stampFile と footerNote は、なくてよい）
  R.checkSettings = function (s) {
    var miss = [], c = s && s.company;
    if (!c || typeof c !== 'object') return { ok: false, missing: ['company（社名・住所・電話・登録番号）'] };
    [['name', '社名'], ['address', '住所'], ['tel', '電話'], ['registrationNo', '登録番号']].forEach(function (p) {
      if (!String(c[p[0]] == null ? '' : c[p[0]]).trim()) miss.push('company.' + p[0] + '（' + p[1] + '）');
    });
    return { ok: !miss.length, missing: miss };
  };

  /* ---------------------------------------------------------------- 印刷用の HTML
   * rec＝{ number, orderNo, atena（敬称つき）, proviso, amount, tax, issueDate, status, reissueCount }
   * settings＝receipt_settings.json の中身、opts＝{ stampSrc（社印の画像の data URL。なければ印なし）, reissue（true なら「再発行」を入れる）, preview（true なら「見本（未発行）」の透かし）, auto（true で、読み込み後に印刷を始める） }
   * A4 縦に1枚。値はすべてエスケープする。外のファイルは読まない（社印は data URL）。色は、印刷用の書類なので、ここだけ直接書く。 */
  R.printHtml = function (rec, settings, opts) {
    opts = opts || {}; rec = rec || {}; settings = settings || {};
    var c = settings.company || {}, e = R.esc, tx = R.splitTax(rec.amount), tax = rec.tax != null && rec.tax !== '' ? Number(rec.tax) : tx.tax;
    var net = Math.round(rec.amount) - tax, voided = rec.status === R.STATUS.voided;
    var split = R.splitTitle(rec.atena);
    var reissue = !!opts.reissue;   // 再発行のときだけ、「再発行」を入れる（最初に出すときは入れない）
    var mark = voided ? '取消' : opts.preview ? '見本（未発行）' : '';
    var css = '@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}' +
      'body{width:210mm;min-height:297mm;font-family:"Yu Gothic","Hiragino Kaku Gothic ProN","Meiryo",sans-serif;color:#111;font-size:11pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.sheet{position:relative;width:210mm;height:297mm;padding:24mm 22mm 20mm;overflow:hidden}' +
      '.rs{position:absolute;top:14mm;left:22mm;border:1.5pt solid #b3261e;color:#b3261e;font-weight:700;font-size:13pt;padding:1.2mm 5mm;letter-spacing:.2em}' +
      'h1{margin:0 0 10mm;text-align:center;font-size:30pt;font-weight:700;letter-spacing:.9em;padding-left:.9em;border-bottom:2.5pt double #111;padding-bottom:4mm}' +
      '.meta{text-align:right;font-size:10.5pt;line-height:1.7;margin-bottom:8mm}.meta b{font-weight:700}' +
      '.to{display:flex;align-items:flex-end;gap:4mm;border-bottom:1pt solid #111;padding:0 2mm 1.5mm;margin-bottom:12mm;width:125mm}' +
      '.to .nm{font-size:19pt;font-weight:700;word-break:break-all;line-height:1.35}.to .tt{font-size:13pt;white-space:nowrap}' +
      '.amt{display:flex;align-items:center;justify-content:center;gap:6mm;border:1.5pt solid #111;padding:6mm 8mm;margin:0 auto 9mm;width:140mm}' +
      '.amt .l{font-size:12pt;letter-spacing:.3em}.amt .v{font-size:28pt;font-weight:700;letter-spacing:.04em}.amt .s{font-size:10pt}' +
      '.pr{font-size:12.5pt;margin-bottom:3mm;padding-left:2mm}.pr .k{display:inline-block;min-width:14mm}' +
      '.ok{font-size:12pt;margin-bottom:10mm;padding-left:2mm}' +
      'table.bk{border-collapse:collapse;width:96mm;font-size:10.5pt;margin-bottom:10mm}table.bk th,table.bk td{border:.8pt solid #111;padding:1.6mm 3mm}' +
      'table.bk th{background:#f1f1f1;font-weight:500;text-align:left;width:44mm}table.bk td{text-align:right}' +
      '.ono{font-size:9.5pt;color:#444;margin-bottom:12mm}' +
      '.from{position:absolute;right:22mm;bottom:26mm;width:100mm;font-size:10.5pt;line-height:1.7}' +
      '.from .cn{font-size:14pt;font-weight:700;margin-bottom:1mm}.from .rg{margin-top:1mm}' +
      '.from img.stamp{position:absolute;right:2mm;top:-11mm;width:22mm;height:22mm;object-fit:contain;opacity:.92}' +
      '.fn{position:absolute;left:22mm;right:22mm;bottom:12mm;font-size:8.5pt;color:#555}' +
      '.wm{position:absolute;left:0;right:0;top:112mm;text-align:center;font-size:54pt;font-weight:700;color:rgba(179,38,30,.16);transform:rotate(-18deg);letter-spacing:.15em;pointer-events:none}';
    var h = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>領収証_' + e(rec.number || '未発行') + '</title><style>' + css + '</style></head><body><div class="sheet">';
    if (reissue) h += '<div class="rs">再発行' + (rec.reissueCount > 0 ? '（' + e(rec.reissueCount) + '回目）' : '') + '</div>';
    if (mark) h += '<div class="wm">' + e(mark) + '</div>';
    h += '<h1>領収証</h1><div class="meta"><div>領収証番号　<b>' + e(rec.number || '（発行すると付きます）') + '</b></div><div>発行日　<b>' + e(R.jaDate(rec.issueDate)) + '</b></div></div>';
    h += '<div class="to"><span class="nm">' + e(split.name) + '</span>' + (split.title ? '<span class="tt">' + e(split.title) + '</span>' : '') + '</div>';
    h += '<div class="amt"><span class="l">金額</span><span class="v">' + e(R.yen(rec.amount)) + '</span><span class="s">（税込）</span></div>';
    h += '<div class="pr"><span class="k">但し</span>' + e(rec.proviso) + '</div><div class="ok">上記、正に領収いたしました。</div>';
    h += '<table class="bk"><tr><th>税抜金額（10%対象）</th><td>' + e(R.yen(net)) + '</td></tr><tr><th>消費税等（10%）</th><td>' + e(R.yen(tax)) + '</td></tr><tr><th>合計（税込）</th><td>' + e(R.yen(rec.amount)) + '</td></tr></table>';
    if (rec.orderNo) h += '<div class="ono">ご注文番号　#' + e(R.orderNo(rec.orderNo)) + '</div>';
    h += '<div class="from">' + (opts.stampSrc ? '<img class="stamp" alt="" src="' + e(opts.stampSrc) + '">' : '') + '<div class="cn">' + e(c.name) + '</div>' +
      (c.zip || c.address ? '<div>' + (c.zip ? '〒' + e(c.zip) + '　' : '') + e(c.address) + '</div>' : '') + (c.tel ? '<div>TEL ' + e(c.tel) + '</div>' : '') +
      (c.registrationNo ? '<div class="rg">登録番号　' + e(c.registrationNo) + '</div>' : '') + '</div>';
    if (settings.footerNote) h += '<div class="fn">' + e(settings.footerNote) + '</div>';
    h += '</div>' + (opts.auto ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})<\/script>' : '') + '</body></html>';
    return h;
  };
  // 保存するファイル名の目安（PDF に保存するときの名前）。お客様の名前は入れない
  R.fileName = function (rec) { return '領収証_' + (rec && rec.number ? rec.number : '未発行'); };

  root.ReceiptCore = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
