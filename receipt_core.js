/* 領収証（Shopify で購入されたお客様向け）の計算部品。画面とは別にして、node でテストできるようにしてある（tests/test_receipt_core.cjs）。
 * 発行できる注文か・金額の上限・消費税の内訳・領収証番号・入力の検査・印刷用の HTML の組み立てをここに持つ。
 * 記録の読み書きは receipt_store.js、画面（発行の画面・札・ボタン）は receipt_ui.js。
 * 領収証は、自社が発行する書類で、お客様の希望を受けて営業が出す。ふるさと納税には付けない（EC のみ）。
 * 社名・住所・電話・登録番号は、コードに書かない。見積アプリの会社の情報（SharePoint の SD_設定）から画面が読んで渡す。社印の画像などの上書きは、SharedMasters の receipt_settings.json（なくてもよい）。 */
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

  /* ---------------------------------------------------------------- 収入印紙
   * 収入印紙が必要な金額の場合は、電子（PDF）ではなく、印刷して印紙を貼って郵送する運用。基準の金額は、経理に確認した値を設定（ec_sales_config.json の receipt.stampNoticeAmount）に入れる。
   * 設定が空（なし・0・数字でない）なら、判定しない（注意も印紙の欄も出ない）。アプリは、法的な判断をしない（基準の値を持たない）。 */
  R.stampNeeded = function (amount, threshold) {
    var t = Number(threshold);
    return isFinite(t) && t > 0 && Number(amount) >= t;
  };

  /* ---------------------------------------------------------------- 会社の情報
   * 社名・登録番号・拠点（住所・電話・FAX）は、見積アプリがすでに持っている設定（SharePoint のリスト SD_設定 の「会社」の行）をそのまま読む。
   *   見積アプリの形：{ company, regNo, bank, offices:[{ name, zip, addr, tel, fax }] }（bank＝振込先は、領収証には出さない）
   * 設定ファイル receipt_settings.json は、あってもなくてもよい「上書き」：{ stampFile（社印の画像の名前）, footerNote（書類の下に入れる一文）, offices（拠点を、ここの内容に置き換える） }
   * 実際の値は、リポジトリに入れない（公開のため）。下は、書き方の見本（架空の値）。 */
  R.SAMPLE_SETTINGS = {
    stampFile: 'receipt_stamp.png',
    footerNote: '',
    offices: [{ name: '本社', zip: '000-0000', addr: 'サンプル県サンプル市サンプル町0-0-0', tel: '000-000-0000', fax: '000-000-0001' }]
  };
  var str = function (v) { return v == null ? '' : String(v).trim(); };
  // 拠点の並びを、{ name, zip, addr, tel, fax } にそろえる（名前も住所もないものは捨てる）
  R.normOffices = function (list) {
    return (Array.isArray(list) ? list : []).filter(function (o) { return o && typeof o === 'object'; })
      .map(function (o) { return { name: str(o.name), zip: str(o.zip), addr: str(o.addr), tel: str(o.tel), fax: str(o.fax) }; })
      .filter(function (o) { return o.name || o.addr; });
  };
  // 見積アプリの会社の情報（comp。読めなければ null）と、設定ファイルの上書き（ov。なければ null）を合わせる。戻り値＝書類・画面で使う設定
  R.mergeSettings = function (comp, ov) {
    comp = comp && typeof comp === 'object' ? comp : {}; ov = ov && typeof ov === 'object' ? ov : {};
    var offices = R.normOffices(ov.offices);
    if (!offices.length) offices = R.normOffices(comp.offices);
    return { company: str(comp.company), regNo: str(comp.regNo), offices: offices, stampFile: str(ov.stampFile), footerNote: str(ov.footerNote) };
  };
  // 設定を確かめる。戻り値＝{ ok, missing:[足りない項目の名前], warnings:[注意] }。登録番号が空でも発行はできる（書類に行を出さず、注意する）
  R.checkSettings = function (s) {
    var miss = [], warn = [];
    s = s || {};
    if (!str(s.company)) miss.push('社名');
    if (!(s.offices || []).some(function (o) { return o && o.addr; })) miss.push('拠点の住所');
    if (!str(s.regNo)) warn.push('登録番号が未設定です（書類に「登録番号」の行が出ません。見積アプリの会社の情報で設定してください）');
    return { ok: !miss.length, missing: miss, warnings: warn };
  };
  R.NO_COMPANY = '会社の設定がありません（見積アプリの会社の情報を確認してください）';

  /* ---------------------------------------------------------------- 印刷用の HTML（見積書 quote.html と同じ書式）
   * rec＝{ number, orderNo, atena（敬称つき）, proviso, amount, tax, issueDate, status, reissueCount }
   * settings＝R.mergeSettings の戻り値、
   * opts＝{ office（使う拠点。なければ先頭）, staff（担当者の名前。発行した人）, stampSrc（社印の画像の data URL。なければ印なし）, stampBox（true なら、収入印紙を貼る欄を印刷する。紙で出す分だけ）,
   *         reissue（true なら、備考に「再発行」を入れる）, preview（true なら「見本（未発行）」の透かし）, auto（true で、読み込み後に印刷を始める） }
   * A4 縦に1枚。値はすべてエスケープする。外のファイルは、ロゴ（hanaoka_logo.png。リポジトリにある公開のロゴ）以外は読まない（社印は data URL）。
   * 色・字体は hanaoka_theme.css の値と同じ（この書類は別の枠の中で開くので、同じ値をここに写している。quote.html の .sheet と同じ作り）。 */
  R.printHtml = function (rec, settings, opts) {
    opts = opts || {}; rec = rec || {}; settings = settings || {};
    var e = R.esc, tx = R.splitTax(rec.amount), tax = rec.tax != null && rec.tax !== '' ? Number(rec.tax) : tx.tax;
    var net = Math.round(rec.amount) - tax, voided = rec.status === R.STATUS.voided;
    var o = opts.office || (settings.offices || [])[0] || {};
    var split = R.splitTitle(rec.atena);
    var mark = voided ? '取消' : opts.preview ? '見本（未発行）' : '';
    var remarks = [];
    if (opts.reissue) remarks.push('再発行' + (rec.reissueCount > 0 ? '（' + rec.reissueCount + '回目）' : ''));
    if (rec.orderNo) remarks.push('ご注文番号　#' + R.orderNo(rec.orderNo));
    var css = ':root{--surface:#ffffff;--bg:#f4f6fb;--line:#edf0f6;--line-strong:#dfe4ef;--txt:#161a3d;--sub:#8a90a8;--font:"Inter","Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic","Segoe UI",sans-serif}' +
      '*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--surface)}body{font-family:var(--font);-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.sheet{position:relative;width:794px;min-height:1000px;padding:44px 48px;background:var(--surface);color:var(--txt);font-size:12px;line-height:1.5}' +
      '.sheet h2{text-align:center;font-size:26px;letter-spacing:.3em;margin:0;font-weight:500}' +
      '.sheet .en{text-align:center;font-size:10px;letter-spacing:.15em;border-bottom:1px solid var(--txt);padding-bottom:8px;margin-bottom:20px}' +
      '.sheet .cols{display:grid;grid-template-columns:1.1fr 1fr;gap:36px}' +
      '.sheet .to{font-size:16px;font-weight:600;border-bottom:1px solid var(--txt);padding-bottom:3px;display:flex;justify-content:space-between;align-items:flex-end;gap:10px}' +
      '.sheet .to span:first-child{word-break:break-all}.sheet .to span:last-child{font-weight:400;font-size:12px;white-space:nowrap}' +
      '.sheet .kv{display:grid;grid-template-columns:84px 1fr;border-bottom:1px solid var(--line-strong);padding:5px 0;align-items:end}' +
      '.sheet .kv small{display:block;font-size:8px;color:var(--sub);letter-spacing:.05em}' +
      '.sheet .co{position:relative;font-size:15px;font-weight:600;margin:6px 0 2px}.sheet .co .cn{display:inline-block}.sheet .co img.logo{display:block;width:0;min-width:100%;height:auto;margin-bottom:6px}' +   /* ロゴの幅＝社名の幅（width:0;min-width:100% で、画像の大きさが枠の幅を決めないようにする） */
      '.sheet .co img.stamp{position:absolute;right:6px;top:34px;width:64px;height:64px;object-fit:contain;mix-blend-mode:multiply;opacity:.92}' +
      '.sheet .addr{font-size:10.5px}' +
      '.sheet .kv2{display:grid;grid-template-columns:70px 1fr;margin-top:8px;align-items:end}.sheet .kv2 b{font-size:13px;text-align:center}.sheet .kv2 small{display:block;font-size:8px;color:var(--sub);letter-spacing:.05em}' +
      '.sheet .remarks{border:1.5px solid var(--txt);min-height:110px;margin-top:14px;padding:10px 12px;display:grid;grid-template-columns:62px 1fr;gap:8px;white-space:pre-wrap}.sheet .remarks small{font-size:8px;color:var(--sub);display:block}' +
      '.sheet table{width:100%;border-collapse:collapse}' +
      '.sheet th{background:var(--bg);border:1px solid var(--line-strong);font-weight:500;padding:4px 6px;font-size:11px}.sheet th small{display:block;font-size:8px;color:var(--sub);font-weight:400}' +
      '.sheet td{border:1px solid var(--line-strong);padding:7px 6px;vertical-align:bottom}' +
      '.sheet .sum td{text-align:center;font-size:14px;padding:12px 6px 4px}.sheet .sum td:first-child{font-weight:600}' +
      '.sheet .bank{text-align:right;font-size:10.5px;margin-top:4px}' +
      '.sheet .ok{margin-top:22px;font-size:12px}' +
      '.sheet .sb{margin:14px 0 0 auto;width:112px;height:112px;border:1px dashed var(--sub);color:var(--sub);font-size:10px;text-align:center;display:flex;align-items:center;justify-content:center;line-height:1.6}' +
      '.sheet .fn{margin-top:22px;font-size:10.5px;color:var(--sub);white-space:pre-wrap}' +
      '.sheet .wm{position:absolute;left:0;right:0;top:300px;text-align:center;font-size:72px;font-weight:700;color:rgba(179,38,30,.16);transform:rotate(-18deg);letter-spacing:.15em;pointer-events:none}' +
      '@media print{@page{size:A4;margin:8mm}body{background:var(--surface)}.sheet{width:auto;padding:10mm 8mm;min-height:0}}';
    var kv = function (ja, en, v) { return '<div class="kv"><div>' + ja + '<small>' + en + '</small></div><div>' + e(v) + '</div></div>'; };
    var h = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>領収証_' + e(rec.number || '未発行') + '</title><style>' + css + '</style></head><body><div class="sheet">';
    if (mark) h += '<div class="wm">' + e(mark) + '</div>';
    h += '<h2>領収証</h2><div class="en">RECEIPT</div><div class="cols"><div>';
    h += '<div class="to"><span>' + e(split.name) + '</span><span>' + e(split.title) + '</span></div>';
    h += kv('発行日', 'DATE', R.jaDate(rec.issueDate)) + kv('領収証番号', 'RECEIPT #', rec.number || '（発行すると付きます）') + kv('但し書き', 'PROVISO', rec.proviso);
    h += '<div class="remarks"><div>備考<small>REMARKS</small></div><div>' + e(remarks.join('\n')) + '</div></div>';
    h += '</div><div>';
    h += '<div class="co"><div class="cn"><img class="logo" src="hanaoka_logo.png" alt="">' + e(settings.company) + '</div>' + (opts.stampSrc ? '<img class="stamp" alt="" src="' + e(opts.stampSrc) + '">' : '') + '</div>';
    h += '<div class="addr">' + (o.addr ? '〒' + e(o.zip) + ' ' + e(o.addr) : '') + '<br>' + (o.tel ? 'TEL:' + e(o.tel) : '') + (o.fax ? '　FAX:' + e(o.fax) : '') + '</div>';
    if (opts.staff) h += '<div class="kv2"><div>担当者<small>NAME</small></div><b>' + e(opts.staff) + '</b></div>';
    h += '<table class="sum" style="margin-top:16px"><tr><th>領収金額（税込）<small>TOTAL AMOUNT</small></th><th>うち消費税<small>TAX（10%）</small></th><th>税抜<small>SUBTOTAL</small></th></tr>' +
      '<tr><td>' + e(R.yen(rec.amount)) + '</td><td>' + e(R.yen(tax)) + '</td><td>' + e(R.yen(net)) + '</td></tr></table>';
    if (settings.regNo) h += '<div class="bank">登録番号｜' + e(settings.regNo) + '</div>';
    if (opts.stampBox) h += '<div class="sb">収入印紙<br>貼付欄</div>';
    h += '</div></div><div class="ok">上記、正に領収いたしました。</div>';
    if (settings.footerNote) h += '<div class="fn">' + e(settings.footerNote) + '</div>';
    h += '</div>' + (opts.auto ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})<\/script>' : '') + '</body></html>';
    return h;
  };
  // 保存するファイル名の目安（PDF に保存するときの名前）。お客様の名前は入れない
  R.fileName = function (rec) { return '領収証_' + (rec && rec.number ? rec.number : '未発行'); };

  root.ReceiptCore = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
