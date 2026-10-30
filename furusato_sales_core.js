/* ふるさと納税（鴻巣市・サイネックス）の注文CSV → EC売上の計算部品（ec_sales_core.js）に渡せる「注文」にする。
 * 注文の形は Shopify の注文と同じにそろえるので、伝票（buildSlip）・納品先（planDeliveries）・取込ファイル（juchuRows など）は EC売上と同じものを使う。
 * 得意先・担当・品目コード・単価は furusato_config.json から読む（ここには書かない）。
 * 注文CSV：Shift_JIS・1行＝1品。値が ="A112170384" の形（Excel の式）で入っている列がある。注文日の列は無い（CSV のファイル名の日時を使う）。 */
(function (root) {
  var EC = root.EcSales || (typeof require !== 'undefined' ? require('./ec_sales_core.js') : null);
  var FS = {};

  FS.unwrap = function (v) {
    // 取込の CSV の読み取りが引用符を外すので、="A1" は =A1 になって届く（引用符ごと残る場合も外す）
    var s = String(v == null ? '' : v).trim(), m = /^="?([\s\S]*?)"?$/.exec(s);
    return m ? m[1].trim() : s;
  };
  FS.decode = function (buf) {
    try { return new TextDecoder('shift_jis').decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
  };
  // sendorder_data_A11217043_261030150342.csv → { date:'2026-10-30', time:'15:03' }（取れなければ null）
  FS.fileStamp = function (name) {
    var m = /_(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.[A-Za-z]+)?$/.exec(String(name || ''));
    if (!m) return null;
    return { date: '20' + m[1] + '-' + m[2] + '-' + m[3], time: m[4] + ':' + m[5] };
  };

  // 住所の1本の文字列を、住所１（都道府県＋市区町村）と住所２（それ以降）に分ける（SMILE の納品先と同じ分け方）。分けられなければ都道府県だけ
  FS.splitAddress = function (full) {
    var s = EC.cleanText ? String(full || '').trim() : String(full || '').trim();
    var pm = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/.exec(s);
    if (!pm) return { province: '', city: '', rest: s };
    var rest = s.slice(pm[1].length), city = '';
    var cm = /^(?:.{1,4}?郡.{1,4}?[町村]|.{1,6}?市(?:.{1,4}?区)?|.{1,4}?[区町村])/.exec(rest);
    if (cm) {
      city = cm[0];
      if (/市$/.test(city) && rest.charAt(city.length) === '市') city += '市';   // 四日市市
      rest = rest.slice(city.length);
    }
    return { province: pm[1], city: city, rest: rest };
  };

  // 備考に入っている定型（「鴻巣市ふるさと納税　　寄附者番号　　名前カナ「…」」）を除いた、お客様の依頼の文
  FS.requestText = function (biko) {
    var t = String(biko || '').replace(/鴻巣市ふるさと納税/g, '').replace(/名前カナ「[^」]*」/g, '').replace(/[\s　]+/g, ' ').trim();
    return t.replace(/^\d{6,12}\s*/, '').trim();   // 寄附者番号（数字）
  };
  FS.donorNo = function (biko) { var m = /鴻巣市ふるさと納税[\s　]*(\d{6,12})/.exec(String(biko || '')); return m ? m[1] : ''; };

  // 商品番号に当たる対応表の行
  FS.findRule = function (mapping, code) {
    var k = EC.matchKey(code);
    return (mapping.rules || []).filter(function (r) { return (r.words || []).some(function (w) { return EC.matchKey(w) === k; }); })[0] || null;
  };

  /* 注文CSV（文字にしたもの）→ 注文の配列（発注番号ごとに1注文。同じ発注番号の行は1注文の明細）
   * stamp: { date:'yyyy-mm-dd', time:'hh:mm' } 注文日時（CSV のファイル名から。なければ opts.today）
   * conf: furusato_config.json（mapping と config を使う） */
  FS.parseOrders = function (text, stamp, conf) {
    var objs = EC.parseObjects(EC.stripBom(String(text || '')), ',');
    var map = {}, list = [];
    stamp = stamp || {};
    objs.forEach(function (raw) {
      var r = {};
      Object.keys(raw).forEach(function (k) { r[k] = FS.unwrap(raw[k]); });
      var id = (r['発注番号'] || '').trim();
      if (!id || !/^\d+$/.test(id)) return;
      var code = (r['商品番号'] || '').trim(), qty = Number(r['数量']) || 1;
      var nameRaw = String(r['品名'] || '').replace(/ - /g, ' ').replace(/※/g, '');
      var o = map[id];
      if (!o) {
        var a = FS.splitAddress(r['お届け先住所']), req = FS.requestText(r['備考']);
        o = map[id] = {
          name: id, id: id, head: true, source: 'furusato', lines: [], createdAt: stamp.date || '', createdTime: stamp.time || '',
          email: '', financial: 'paid', fulfillment: '', cancelledAt: '', total: 0, subtotal: 0, shipping: 0, taxes: 0, discountAmount: 0, discountCode: '', refunded: 0,
          paymentMethod: '', shippingMethod: '', notes: '', tags: '',
          ship: { name: (r['お届け先名'] || '').trim(), company: (r['お届け先会社名・部門'] || '').trim(), zip: (r['お届け先郵便番号'] || '').trim(), province: a.province, city: a.city, addr1: a.rest, addr2: (r['お届け先建物名'] || '').trim(), phone: (r['お届け先電話番号'] || '').trim() },
          bill: { name: '', company: '', zip: '', province: '', city: '', addr1: '', addr2: '', phone: '' }, phone: '',
          juchuNo: (r['受注番号'] || '').trim(), slipNo: (r['送り状番号'] || '').trim(), donorNo: FS.donorNo(r['備考']),
          wantDate: (r['配達希望日'] || '').trim(), wantTime: (r['配達時間帯'] || '').trim(), request: req, fileRows: 0
        };
        list.push(o);
      }
      o.fileRows++;
      o.lines.push({ name: code + ' ' + nameRaw, sku: code, qty: qty, price: 0, discount: 0, shipped: '' });
    });
    list.forEach(function (o) { FS.priceOrder(o, conf.mapping); });
    return list;
  };

  // 金額は対応表の契約単価（税抜）から決める：行の単価＝税込、注文の合計＝行の合計。
  // 対応表を直したあとにも使えるよう、伝票を作るたびにやり直す（画面で単価を直したとき、すぐ反映される）
  FS.priceOrder = function (o, mapping) {
    var total = 0;
    o.lines.forEach(function (l) {
      var rule = FS.findRule(mapping, l.sku), net = rule && rule.net != null ? Number(rule.net) : 0;
      l.price = Math.round(net * 1.1); total += Math.round(net * l.qty * 1.1);
    });
    o.total = total; o.subtotal = total;
    return o;
  };

  // 時間帯の「希望無」「指定なし」は指定ではない
  function hasTime(t) { return !!t && !/^(希望無|指定なし|なし|-)?$/.test(String(t).trim()); }

  // 注文 → 伝票（EC売上の buildSlip に、ふるさと納税の確認ポイントを足す）
  // ctx: { mapping, cfg, items, smileOrders, cal }。ctx.mapping / ctx.cfg は furusato_config.json の mapping / config
  FS.buildSlip = function (o, ctx) {
    FS.priceOrder(o, ctx.mapping);
    var s = EC.buildSlip(o, ctx);
    s.source = 'furusato';
    // 合計0円の扱い（ギフティング）は EC 用。ふるさと納税では出さない
    s.flags = s.flags.filter(function (f) { return f.text.indexOf('ギフティング') !== 0; });
    if (o.wantDate) s.flags.push({ level: 'warn', text: '配達日の指定あり（' + o.wantDate + '）：宅配便の「指定日配達シール」を付けてください' });
    if (hasTime(o.wantTime)) s.flags.push({ level: 'warn', text: '配達時間の指定あり（' + o.wantTime + '）：宅配便の「時間指定シール」を付けてください' });
    if (o.request) s.flags.push({ level: 'warn', text: 'お客様の依頼（備考）：' + o.request.slice(0, 80) + '（日時の指定があれば、シールを付けてください）' });
    if (o.slipNo) s.flags.push({ level: 'info', text: '送り状番号：' + o.slipNo });
    return s;
  };

  // 受注伝票の取込行。EC売上と同じ行に、備考（SMILEの備考欄）へ「ふるさと納税返礼品」を入れる（社内メモは使わない）
  FS.juchuRows = function (slips, header, cfg, cal, biko) {
    var rows = EC.juchuRows(slips, header, cfg, cal), bi = header.indexOf('備考'), mi = header.indexOf('社内メモ');
    var lim = (cfg && cfg.limits) || {};
    rows.forEach(function (r) {
      if (bi >= 0) r[bi] = EC.cutBytes(biko || '', lim.memo || 64);
      if (mi >= 0 && !(cfg.memo || '')) r[mi] = '';
    });
    return rows;
  };

  root.FurusatoSales = FS;
  if (typeof module !== 'undefined' && module.exports) module.exports = FS;
})(typeof window !== 'undefined' ? window : globalThis);
