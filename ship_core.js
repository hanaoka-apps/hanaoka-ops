/* 出荷・配送の検索（ship_search.html）の計算部品。画面に依存しない純粋な関数だけ（node でテストできる：tests/test_ship_core.cjs）。
 * データは scripts/build_ship_index.py が作る ship_index.json（売上№ごとの出荷・送り状番号・受注の要約）。
 * 運送会社の名前・追跡URLの型・古さの警告の時間は ship_config.json から渡す（ここには書かない）。 */
(function (root) {
  var S = {};
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var JST = 9 * 3600000;

  S.norm = function (s) { return String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, ' ').trim().toLowerCase(); };
  S.digits = function (s) { return String(s == null ? '' : s).normalize('NFKC').replace(/\D/g, ''); };

  // 'yyyy-mm-dd' → 'M/D(曜)'。今年でなければ年も付ける
  S.fmtDate = function (iso, nowIso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var year = nowIso ? String(nowIso).slice(0, 4) : '';
    return (year && m[1] !== year ? m[1] + '/' : '') + (+m[2]) + '/' + (+m[3]) + '(' + WD[d.getUTCDay()] + ')';
  };

  // 運送業者利用区分 → 運送会社の設定のキー（無ければ ''）
  S.carrierKeyOf = function (conf, kubun) {
    var cs = (conf && conf.carriers) || {};
    return Object.keys(cs).filter(function (k) { return k[0] !== '_' && cs[k] && String(cs[k].kubun) === String(kubun); })[0] || '';
  };
  S.carrierName = function (conf, key) { var c = ((conf && conf.carriers) || {})[key]; return c && c.name ? c.name : key; };
  S.kubunName = function (conf, kubun) {
    var k = S.carrierKeyOf(conf, kubun);
    if (k) return S.carrierName(conf, k);
    return ((conf && conf.kubunNames) || {})[String(kubun)] || (kubun ? '区分 ' + kubun : '運送会社を使わない');
  };

  // 運送会社を使わない出荷（区分が 0 か空）
  S.noCarrier = function (ship) { return !ship.kubun || String(ship.kubun) === '0'; };

  // 追跡ページの URL（設定の型の {no} を送り状番号にする。型が空なら ''）
  S.trackingUrl = function (conf, carrierKey, no) {
    var c = ((conf && conf.carriers) || {})[carrierKey], t = c && c.tracking;
    return t ? String(t).split('{no}').join(encodeURIComponent(String(no || '').trim())) : '';
  };

  /* 出荷の「送り状番号」の状態
   *   ok       送り状番号がある
   *   none     運送会社を使わない出荷（引取・自社便など）
   *   outside  運送会社のデータの取得期間より前の出荷（番号を取っていない）
   *   missing  取得期間の中なのに、運送会社のデータに見つからない（要確認）
   *   pending  運送会社のデータがまだ届いていない新しい出荷
   *   nodata   その運送会社のデータがまったく無い／運送会社の設定が無い */
  S.slipStatus = function (conf, idx, ship) {
    if (ship.slips && ship.slips.length) return { code: 'ok', text: '' };
    var key = S.carrierKeyOf(conf, ship.kubun);
    if (!key) return ship.kubun && String(ship.kubun) !== '0' ? { code: 'nodata', text: '運送会社の設定がありません（区分 ' + ship.kubun + '）' } : { code: 'none', text: '運送会社を使わない出荷です' };
    var c = (idx.carriers || {})[key];
    if (!c || !c.files || !c.from) return { code: 'nodata', text: S.carrierName(conf, key) + 'のデータがまだありません' };
    if (ship.date < c.from) return { code: 'outside', text: '取得期間外です（' + S.carrierName(conf, key) + 'のデータは ' + c.from + ' から）' };
    if (ship.date > c.to) return { code: 'pending', text: S.carrierName(conf, key) + 'のデータが届くのを待っています（最新の出荷日 ' + c.to + '）' };
    return { code: 'missing', text: S.carrierName(conf, key) + 'のデータに見つかりません。送り状を発行したか確認してください' };
  };

  // 「見つからない」出荷の手がかり：同じ運送会社・同じ出荷日で、SMILE の売上№が見つからない送り状（SMILE の売上を直して番号が変わったときに起きる。別の荷物のこともある）
  S.candidates = function (conf, idx, ship) {
    var key = S.carrierKeyOf(conf, ship.kubun);
    return key ? (idx.unmatched || []).filter(function (u) { return u.c === key && u.date === ship.date; }) : [];
  };

  // 検索用の文字列（出荷1件ぶん。一度作ったら持っておく）
  S.haystack = function (ship, idx, conf) {
    if (ship._h) return ship._h;
    var parts = [ship.no, ship.shipNo, ship.cust, ship.custName, ship.dest, ship.destName, ship.staff, S.kubunName(conf, ship.kubun)]
      .concat(ship.juchu || [], ship.po || [], (ship.lines || []).map(function (l) { return l[0] + ' ' + l[1]; }));
    var slipDigits = [];
    (ship.slips || []).forEach(function (s) { parts.push(s.no); slipDigits.push(S.digits(s.no)); parts.push(S.carrierName(conf, s.c)); });
    var h = S.norm(parts.join(' ')) + ' ' + slipDigits.join(' ');
    Object.defineProperty(ship, '_h', { value: h, enumerable: false });
    return h;
  };

  /* 検索。q＝空白で区切った言葉（すべてを含む出荷だけ）。from/to＝出荷日（yyyy-mm-dd、含む）。
   * carrier＝運送会社のキー（'' ですべて、'none' は運送会社を使わない出荷）。status＝slipStatus の code（'' ですべて、'attention' は missing と nodata） */
  S.search = function (idx, conf, f) {
    f = f || {};
    // 数字とハイフンだけの言葉（送り状番号 907-228-3808 など）は、ハイフンを外した形でも探す
    var toks = S.norm(f.q).split(' ').filter(Boolean).map(function (t) { return { t: t, d: /^[\d-]+$/.test(t) ? S.digits(t) : '' }; });
    return (idx.ships || []).filter(function (s) {
      if (f.from && s.date < f.from) return false;
      if (f.to && s.date > f.to) return false;
      if (f.carrier) {
        if (f.carrier === 'none' ? !S.noCarrier(s) : S.carrierKeyOf(conf, s.kubun) !== f.carrier) return false;
      }
      if (f.status) {
        var st = S.slipStatus(conf, idx, s).code;
        if (f.status === 'attention' ? (st !== 'missing' && st !== 'nodata') : st !== f.status) return false;
      }
      var h = toks.length ? S.haystack(s, idx, conf) : '';
      return toks.every(function (k2) { return h.indexOf(k2.t) >= 0 || (k2.d && h.indexOf(k2.d) >= 0); });
    });
  };

  // 受注の要約（受注№ごと）。受注明細に無ければ null
  S.juchuInfo = function (idx, no) { return (idx.juchu || {})[no] || null; };

  /* 分納：同じ注文を分けて出荷したときの、ほかの出荷（ship は含めない。日付の古い順）。
   * SMILE は出荷のたびに新しい受注ができるので、同じ受注№だけでは足りない。次のどちらかが同じで、
   * 出荷日が conf.bunno.windowDays（既定30日）以内のものを、同じ注文とみなす：
   *   ・受注№が同じ  ・得意先が同じで、客先注番が同じ（客先注番が空のものは対象外）
   * 同じ客先注番を長く使い回す得意先があるので、日数で区切る */
  var DAY = 86400000;
  function dayNum(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY : NaN; }
  function bunnoIndex(idx) {
    if (idx._bn) return idx._bn;
    var po = {}, ju = {};
    (idx.ships || []).forEach(function (s) {
      (s.po || []).forEach(function (p) { if (p) (po[(s.cust || '') + '\u0001' + p] = po[(s.cust || '') + '\u0001' + p] || []).push(s); });
      (s.juchu || []).forEach(function (j) { if (j) (ju[j] = ju[j] || []).push(s); });
    });
    var bn = { po: po, ju: ju };
    Object.defineProperty(idx, '_bn', { value: bn, enumerable: false });
    return bn;
  }
  S.siblings = function (idx, ship, conf) {
    var win = +((conf && conf.bunno) || {}).windowDays; if (!(win > 0)) win = 30;
    var bn = bunnoIndex(idx), seen = {}, out = [], d0 = dayNum(ship.date);
    function take(list) {
      (list || []).forEach(function (s) {
        if (s === ship || s.no === ship.no || seen[s.no]) return;
        if (!(Math.abs(dayNum(s.date) - d0) <= win)) return;
        seen[s.no] = 1; out.push(s);
      });
    }
    (ship.juchu || []).forEach(function (j) { take(bn.ju[j]); });
    (ship.po || []).forEach(function (p) { if (p) take(bn.po[(ship.cust || '') + '\u0001' + p]); });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no < b.no ? -1 : 1); });
  };

  // 分納の表（この出荷も含めて日付順）。多いときは、この出荷に日付の近いものを show 件（既定6）まで。分納でなければ null
  S.bunno = function (idx, ship, conf) {
    var sib = S.siblings(idx, ship, conf);
    if (!sib.length) return null;
    var show = +((conf && conf.bunno) || {}).show; if (!(show > 0)) show = 6;
    var all = sib.concat([ship]), d0 = dayNum(ship.date);
    var picked = all.length <= show ? all : all.slice().sort(function (a, b) {
      return (a === ship ? -1 : b === ship ? 1 : 0) || Math.abs(dayNum(a.date) - d0) - Math.abs(dayNum(b.date) - d0);
    }).slice(0, show);
    picked.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no < b.no ? -1 : 1); });
    return { total: all.length, ships: picked, hidden: all.length - picked.length };
  };

  // 品目の行を、受注№ごとにまとめる（出荷に受注が複数あるとき）
  S.linesByJuchu = function (ship) {
    var out = [], pos = {};
    (ship.lines || []).forEach(function (l) {
      var j = l[3] || '';
      if (!(j in pos)) { pos[j] = out.length; out.push({ juchu: j, lines: [] }); }
      out[pos[j]].lines.push({ code: l[0], name: l[1], qty: l[2] });
    });
    return out;
  };

  /* ------------------------------------------------------------ 送り先（実際の納品先）と出荷連絡 */
  // 送り先の住所（索引の addr。無ければ null）。{ zip, addr }
  S.addrOf = function (idx, ship) {
    var e = ((idx && idx.addr) || {})[(ship.cust || '') + '|' + (ship.dest || '')];
    return e ? { zip: e.z || '', addr: e.a || '', recv: e.r || '', tel: e.t || '' } : null;
  };
  // 送り先の名前：納品先があればその名前、納品先なし（得意先そのものに送る）なら得意先の名前
  S.destLabel = function (ship) { return ship.destName || ship.custName || ''; };
  // 直送：納品先が決まっていて、得意先とは別の名前（代理店から、その先のお客様へ送る、など）
  S.isDirect = function (conf, ship) {
    var none = String(((conf && conf.smile) || {}).noDest || '000000');
    return !!ship.dest && String(ship.dest) !== none && !!ship.destName && S.norm(ship.destName) !== S.norm(ship.custName);
  };
  S.zipAddr = function (a) { return a ? [a.zip ? '〒' + a.zip : '', a.addr].filter(Boolean).join('　') : ''; };

  function dateJa(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[1] + '年' + (+m[2]) + '月' + (+m[3]) + '日' : ''; }

  /* 出荷連絡の文面。conf.notice の { subject, lines[] } を、この出荷の値で埋める。
   *   {po}客先注番 {juchu}受注№ {items}品目 {dest}送り先の名前 {zipaddr}〒郵便番号　住所 {zip} {addr} {date}出荷日 {carrier}運送会社 {slip}送り状番号 {staff}担当
   * ・値が空の行は出さない  ・{items}・{carrier}・{slip} は複数あるので、その数だけ行（\n を含む行は、まとまりごと）を繰り返す
   * 戻り値 { subject, body, hasSlip, hasAddr, isReturn（返品の伝票）, hasSlipData（送り状に、お届け先などの控えがある） }
   * opts：{ slipBlock: 送り状に書かれている内容を付ける（既定 true）, track: 追跡のURLを付ける（既定 true） }
   *   {want}配達指定 {sQtyKg}個数・重量 {track}追跡URL {sName}{sZipAddr}{sTel}{sWant}{sNote}{sPo}＝送り状に書かれているお届け先・住所・電話・配達指定・品名・注番 */
  S.noticeText = function (conf, idx, ship, opts) {
    opts = opts || {};
    var nt = (conf && conf.notice) || {}, a = S.addrOf(idx, ship), withBlock = opts.slipBlock !== false, withTrack = opts.track !== false;
    var items = (ship.lines || []).map(function (l) { return S.zen(l[1] || l[0]) + ' × ' + S.fmtNum(l[2]); });   // 品名の半角カナは全角にそろえる
    var slips = ship.slips || [];
    var perSlip = function (fn) { return slips.map(function (s) { var v = fn(s); return v == null ? '' : v; }); };
    var V = {
      po: (ship.po || []).join('、'), juchu: (ship.juchu || []).join('、'), items: items, dest: S.zen(S.destLabel(ship)),
      zipaddr: S.zen(S.zipAddr(a)), zip: a ? a.zip : '', addr: a ? S.zen(a.addr) : '', date: dateJa(ship.date), staff: ship.staff || '',
      want: [ship.want ? S.fmtDate(ship.want) : '', ship.time || ''].filter(Boolean).join(' '),
      carrier: perSlip(function (s) { return S.carrierName(conf, s.c); }), slip: perSlip(function (s) { return s.no; }),
      sQtyKg: perSlip(function (s) { return [s.qty ? s.qty + '個' : '', s.kg && s.kg !== '0' ? s.kg + 'kg' : ''].filter(Boolean).join('・'); }),
      track: perSlip(function (s) { return withTrack ? S.trackingUrl(conf, s.c, s.no) : ''; }),
      // 送り状に書かれている内容（運送会社のデータ）。お客様に、送り状の内容を知らせる用
      sName: perSlip(function (s) { return S.zen(s.n || ''); }), sTel: perSlip(function (s) { return s.p || ''; }),
      sZipAddr: perSlip(function (s) { return S.zen([s.z ? '〒' + String(s.z).replace(/^(\d{3})(\d{4})$/, '$1-$2') : '', s.a || ''].filter(Boolean).join(' ')); }),
      sWant: perSlip(function (s) { return S.zen(s.w || '').replace(/^配達指定/, ''); }),   // 「配達指定【11月05日午前】」→「【11月05日午前】」（行の見出しと重ならないように）
      sNote: perSlip(function (s) { return S.zen(s.m || ''); }),
      sPo: perSlip(function (s) { return S.slipPoMentions([s.n, s.a, s.m]).join('、'); })
    };
    // tpl の {名前} を値で置き換える。複数ある値（品目・送り状）を含むものは、その数だけ繰り返す（0 個なら出さない）。
    // \n を含む tpl は、まとまりごとに繰り返し、値が空の行だけを出さない
    function fill(tpl) {
      var names = (tpl.match(/\{(\w+)\}/g) || []).map(function (x) { return x.slice(1, -1); });
      var lens = names.filter(function (k) { return Array.isArray(V[k]); }).map(function (k) { return V[k].length; });
      var n = lens.length ? Math.max.apply(null, lens) : 1, out = [];
      for (var i = 0; i < n; i++) {
        String(tpl).split('\n').forEach(function (sub) {
          var empty = false;
          var t = sub.replace(/\{(\w+)\}/g, function (_, k) {
            var v = Array.isArray(V[k]) ? V[k][i] : V[k];
            if (v == null || v === '') empty = true;
            return v == null ? '' : v;
          });
          if (!empty) out.push(t);
        });
      }
      return out;
    }
    var lines = [];
    (nt.lines || []).forEach(function (tpl) {
      if (tpl === '') { lines.push(''); return; }
      if (tpl === '{slipblock}') {   // 送り状に書かれている内容のまとまり（送り状ごと。付けないときは出さない）
        if (withBlock && nt.slipBlock) fill(String(nt.slipBlock)).forEach(function (x) { lines.push(x); });
        return;
      }
      fill(String(tpl)).forEach(function (x) { lines.push(x); });
    });
    // 続けて空行になるものや、最初・最後の空行は詰める
    var body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    var subject = (fill(String(nt.subject || '出荷のご連絡 {po}'))[0] || String(nt.subject || '出荷のご連絡 {po}').replace(/\{po\}/g, '')).trim();
    return { subject: subject, body: body, hasSlip: slips.length > 0, hasAddr: !!(a && (a.zip || a.addr)), isReturn: !!ship.ret,
             hasSlipData: slips.some(function (s) { return s.n || s.a || s.p || s.w || s.m; }) };
  };

  /* ------------------------------------------------------------ 伝票と送り状の見比べ
   * 伝票（SMILE）と、運送会社に渡った送り状のデータ（お届け先の名前・郵便番号・住所・配達指定・出荷日）を比べる。
   * 表記ゆれ（全角半角・㈱・様・丁目の書き方）で違って見えることがあるので、ゆるく比べ、違っても「違うかもしれません」と出すだけ。
   * 行：{ k 項目, a 伝票の値, b 送り状の値, st 'ok'（同じ）／'diff'（違うかも）／'info'（比べない・参考）／'none'（どちらかに値が無い） } */
  function nname(s) {
    return S.zen(s).replace(/[\s　]/g, '').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|\(合\)|㈱|㈲/g, '').replace(/(様|殿|御中)$/, '').toLowerCase();
  }
  function naddr(s) {
    return S.zen(s).replace(/[\s　]/g, '').replace(/[\u2010-\u2015\u2212\u30fc\uff0d-]+/g, '-').replace(/丁目|番地|番/g, '-').replace(/号/g, '').replace(/-+/g, '-').replace(/-$/, '').toLowerCase();
  }
  function bare(s) { return s.replace(/[^0-9a-z぀-ヿ一-鿿]/g, ''); }   // 記号・空白・文字化けの「?」などを外す
  // ほぼ同じ：どちらかがもう一方を含む、または、先頭からの一致が短いほうの 9 割以上（運送会社の欄の長さで、名前の末尾が切れる・つながることがあるため）
  function similar(x, y) {
    x = bare(x); y = bare(y);
    if (!x || !y) return false;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
    var n = Math.min(x.length, y.length), i = 0;
    while (i < n && x.charAt(i) === y.charAt(i)) i++;
    return i / n >= 0.9;
  }
  function ymdOfText(s, ref) {   // '11月05日午前'・'2026/11/05' → 'yyyy-mm-dd'（年が無ければ ref の年）
    var t = S.zen(s), m = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(t), y = (ref || '').slice(0, 4);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    m = /(\d{1,2})月(\d{1,2})日/.exec(t);
    return m ? y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) : '';
  }
  // 伝票の値 exp と、送り状の値 got の比べ方（記号・空白・全角半角をそろえてから）。
  //   ok＝同じ（送り状のほうが長いのも可）／cut＝送り状が、伝票の途中までしか入っていない（運送会社の欄の長さで切れた）／diff＝違う／none＝どちらかが空
  function cmpText(exp, got) {
    var x = bare(exp), y = bare(got);
    if (!x || !y) return 'none';
    if (y.indexOf(x) >= 0) return 'ok';
    return x.indexOf(y) === 0 ? 'cut' : 'diff';
  }
  var BAD = { diff: 3, missing: 2, cut: 1 };
  function worse(a, b) { return (BAD[b] || 0) > (BAD[a] || 0) ? b : a; }
  // 送り状の宛名・住所・記事に書かれた「注番：○○」の番号（複数なら全部）
  S.slipPoMentions = function (texts) {
    var out = [];
    (texts || []).forEach(function (s) {
      var re = /(?:客先)?注番[:：\s]*([A-Za-z0-9][A-Za-z0-9\-_]*)/g, m, t = S.zen(s || '');
      while ((m = re.exec(t))) { if (out.indexOf(m[1]) < 0) out.push(m[1]); }
    });
    return out;
  };
  // 見比べの表の「SMILE 側の項目名」。納品先が決まっている出荷は、納品先マスタの項目。納品先なしの出荷は、得意先マスタ（得意先そのもの）の項目
  function smileLabels(ship, conf) {
    var none = String(((conf && conf.smile) || {}).noDest || '000000'), direct = !!ship.dest && String(ship.dest) !== none;
    return { name1: direct ? '納品先名' : '得意先名１（納品先なし）', name2: '荷受け人名１', zip: '郵便番号', tel: '電話番号', addr: '住所１＋２＋３', date: '伝票日付', want: '配送指定日＋配達指定名', item: '品目名' };
  }
  /* 行：{ k 見る所, ka SMILE 側の項目名, kb 運送会社のデータの項目名, a 伝票の値, b 送り状の値, st }
   * 表は「SMILE の納品先マスタの項目 → 送り状（運送会社のデータ）の項目」の対応で並べる（項目名は ship_config.json の carriers.<会社>.labels）。
   * 運送会社のデータに欄が無い項目は、kb を「（欄なし）」にして、比べない */
  S.compareSlip = function (conf, idx, ship, slip) {
    var rows = [], ad = S.addrOf(idx, ship), none = function (v) { return v === '' || v == null; };
    var cdef = (((conf && conf.carriers) || {})[slip.c] || {}), cols = cdef.cols || {}, lb = cdef.labels || {}, sm = smileLabels(ship, conf), NOCOL = '（欄なし）';
    function add(k, ka, kb, a, b, st) { rows.push({ k: k, ka: ka, kb: kb, a: a || '', b: b || '', st: st }); }
    // 出荷日
    add('出荷日', sm.date, lb.date || '出荷日', ship.date ? S.fmtDate(ship.date) : '', slip.date ? S.fmtDate(slip.date) : '', none(slip.date) || none(ship.date) ? 'none' : (slip.date === ship.date ? 'ok' : 'diff'));
    // 宛名：1行目＝納品先名（送り状の名称１）、2行目＝荷受け人名（送り状の名称２）。名称２の欄を持たない運送会社（第一貨物）は「（欄なし）」。
    // 名称１・２に分かれていない古い送り状（前回のデータから引き継いだもの）は、つなげた名前を1行で比べる
    var an = S.destLabel(ship), recv = ad ? ad.recv : '';
    var anRecv = [an, recv].filter(Boolean).join(' ');
    if (slip.n1 == null) {
      var got = slip.n || '', stOld = none(got) ? 'none' : cmpText(nname(anRecv), nname(got));
      if ((stOld === 'diff' || stOld === 'cut') && recv && cmpText(nname(an), nname(got)) === 'ok' && nname(got).indexOf(nname(recv)) < 0) stOld = 'missing';   // 納品先名は入っているが、荷受け人名が入っていない
      add('宛名', recv ? sm.name1 + '＋' + sm.name2 : sm.name1, (cols.toName || []).length >= 2 ? (lb.toName1 || 'お届け先名称１') + '＋' + (lb.toName2 || 'お届け先名称２') : (lb.toName1 || 'お届け先名称'), S.zen(anRecv), S.zen(got), stOld);
    } else {
      var n1 = slip.n1, n2 = slip.n2 || '', hasName2 = (cols.toName || []).length >= 2, two = hasName2;
      var st1 = none(n1) ? 'none' : cmpText(nname(an), nname(n1));
      var st2 = 'none', inN1 = !!recv && nname(n1).indexOf(nname(recv)) >= 0;
      if (!hasName2) st2 = 'info';
      else if (recv) st2 = none(n2) ? 'missing' : cmpText(nname(recv), nname(n2));
      else if (n2) st2 = 'info';
      // 並び方が違うだけ（名称１に荷受け人名まで入っている、など）は、つなげて同じなら「同じ」
      if (!none(n1) && cmpText(nname(anRecv), nname(n1 + n2)) === 'ok') { st1 = 'ok'; if (st2 !== 'none' && st2 !== 'info') st2 = 'ok'; }
      add('宛名（1行目）', sm.name1, lb.toName1 || 'お届け先名称', S.zen(an), S.zen(n1), st1);
      if (recv || n2 || two) add('宛名（2行目）', sm.name2, hasName2 ? (lb.toName2 || 'お届け先名称２') : NOCOL, S.zen(recv), n2 ? S.zen(n2) : (inN1 && st2 === 'ok' ? '（名称１に続けて入っています）' : ''), st2);
    }
    // 郵便番号・住所
    var az = ad ? ad.zip : '', bz = slip.z || '';
    add('郵便番号', sm.zip, cols.toZip ? (lb.toZip || 'お届け先郵便番号') : NOCOL, az, bz, none(az) || none(bz) ? 'none' : (S.digits(az) === S.digits(bz) ? 'ok' : 'diff'));
    var aa = ad ? ad.addr : '', ba = slip.a || '';
    add('住所', sm.addr, lb.toAddr || 'お届け先住所', S.zen(aa), S.zen(ba), none(aa) || none(ba) ? 'none' : cmpText(naddr(aa), naddr(ba)));
    // 電話番号（送り状にも、お届け先の電話が載る）。マスタの電話と、数字だけにして比べる
    var at = ad ? ad.tel : '', bt = slip.p || '';
    if (at || bt) add('電話番号', sm.tel, cols.toTel ? (lb.toTel || 'お届け先電話番号') : NOCOL, at, bt, !cols.toTel || none(at) || none(bt) ? 'none' : (S.digits(at) === S.digits(bt) ? 'ok' : 'diff'));
    // 客先注番：納品先マスタの宛名・住所に「注番：…」と書き込んで、送り状に印字しているケースがある。送り状に注番が書かれているときだけ、この注文の客先注番と比べる
    // （納品先マスタの注番は納品先ごとに1つなので、古い注番が残ると、次の注文でも同じ注番が印字される）
    var pos = S.slipPoMentions([slip.n, slip.a, slip.m]);
    if (pos.length) {
      var mine = (ship.po || []).map(function (x) { return S.zen(x).replace(/[\s\-_]/g, '').toUpperCase(); }).filter(Boolean);
      var ok = pos.some(function (p) { return mine.indexOf(p.replace(/[\-_]/g, '').toUpperCase()) >= 0; });
      add('客先注番', '客先注番', '宛名・住所・記事に書かれた「注番」', (ship.po || []).join('、'), pos.join('、'), mine.length ? (ok ? 'ok' : 'diff') : 'none');
    }
    // 配達指定（日付と午前・午後）。運送会社のデータに欄がある会社だけ
    var aw = [ship.want ? S.fmtDate(ship.want) : '', ship.time || ''].filter(Boolean).join(' '), bw = slip.w || '';
    if ((aw || bw) && cols.want) {
      var st = 'ok';
      if (none(aw) !== none(bw)) st = 'diff';
      else {
        var bd = ymdOfText(bw, ship.date);
        if (ship.want && bd && ship.want !== bd) st = 'diff';
        var apm = /午前|午後/.exec(S.zen(ship.time || '')), bpm = /午前|午後/.exec(S.zen(bw));
        if (apm && bpm && apm[0] !== bpm[0]) st = 'diff';
      }
      add('配達指定', sm.want, lb.want || '配達指定', aw, S.zen(bw), st);
    }
    // 参考：個数・重量・品名（伝票に無い値、または機械で比べにくい値）
    if (slip.qty) add('個数', '', '個数', '', slip.qty + '個', 'info');
    if (slip.kg && slip.kg !== '0') add('重量', '', '重量', '', slip.kg + 'kg', 'info');
    if (slip.m) add('品名', sm.item, lb.note || '記事', (ship.lines || []).slice(0, 3).map(function (l) { return S.zen(l[1] || l[0]); }).join('、') + ((ship.lines || []).length > 3 ? ' ほか' : ''), S.zen(slip.m), 'info');
    return rows;
  };
  // カードに出す印用：確認が必要な項目（違うかも・切れている・入っていない）の数（送り状にお届け先などの控えがあるものだけ）
  S.diffCount = function (conf, idx, ship) {
    var n = 0;
    (ship.slips || []).forEach(function (sl) { if (sl.n || sl.a || sl.z) S.compareSlip(conf, idx, ship, sl).forEach(function (r) { if (r.st === 'diff' || r.st === 'cut' || r.st === 'missing') n++; }); });
    return n;
  };

  /* ------------------------------------------------------------ 伝票の詳細（ship_detail.json）の計算 */
  // 表示用：半角カナ・全角英数をそろえる（SMILE の品目名は半角カナが多い）
  S.zen = function (s) { return String(s == null ? '' : s).normalize('NFKC'); };
  function numOf(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
  // 伝票の数量合計・小計（税抜＝品目の金額の合計）・消費税・合計。d＝{lines:[[行,コード,品名,数量,単位,単価,金額,課税,摘要1,摘要2,倉庫]], tax}
  S.detailTotals = function (d) {
    var qty = 0, sub = 0;
    ((d && d.lines) || []).forEach(function (l) { qty += numOf(l[3]); sub += numOf(l[6]); });
    var tax = numOf(d && d.tax);
    return { qty: qty, sub: sub, tax: tax, total: sub + tax };
  };
  // 3桁区切り（数でなければそのまま）
  S.fmtNum = function (v) { if (v === '' || v == null) return ''; var n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? String(v) : n.toLocaleString('ja-JP'); };

  // 土日（日本時間）を除いた時間数。運送会社のデータは平日にしか届かないので、月曜の朝に「古い」と出さないため
  S.weekdayHours = function (fromMs, toMs) {
    if (!(toMs > fromMs)) return 0;
    var total = 0, t = fromMs;
    while (t < toMs) {
      var next = Math.min(toMs, (Math.floor((t + JST) / 3600000) + 1) * 3600000 - JST);
      var dow = new Date(t + JST).getUTCDay();
      if (dow !== 0 && dow !== 6) total += (next - t) / 3600000;
      t = next;
    }
    return total;
  };

  S.agoText = function (h) { return h < 1 ? Math.max(1, Math.round(h * 60)) + '分前' : (h < 48 ? '約' + Math.round(h) + '時間前' : '約' + Math.round(h / 24) + '日前'); };

  // 画面の上に出す注意（古い・足りない）。now＝Date.now() など。thresholds＝設定の staleHours
  S.warnings = function (idx, conf, now) {
    var w = [], lim = (conf && conf.staleHours) || {}, ms = function (iso) { return Date.parse(iso); };
    var hours = function (iso) { return (now - ms(iso)) / 3600000; };
    if (idx.generatedAt && hours(idx.generatedAt) >= (lim.index || 30)) w.push('検索用のデータ（ship_index.json）が ' + S.agoText(hours(idx.generatedAt)) + 'の作成のままです。専用機の定時実行を確認してください');
    (idx.sources || []).forEach(function (s) {
      if (s.modified && hours(s.modified) >= (lim.smile || 36)) w.push('SMILE の出力（' + s.name + '）が ' + S.agoText(hours(s.modified)) + 'のままです。新しい出荷が出てこない可能性があります');
    });
    Object.keys(idx.carriers || {}).forEach(function (k) {
      var c = idx.carriers[k], name = (c && c.name) || k;
      if (!c || !c.files) { w.push(name + 'のデータがまだありません（送り状番号は出ません）'); return; }
      if (((conf.carriers || {})[k] || {}).warnStale === false) return;   // 出荷した日に人が送信する運送会社（トナミ）は、数日届かなくても正常
      var h = S.weekdayHours(ms(c.newest), now);
      if (c.newest && h >= (lim.carrier || 30)) w.push(name + 'のデータが、平日で ' + Math.round(h) + '時間ぶん届いていません（最新のファイル ' + S.agoText(hours(c.newest)) + '）。ダウンロードの定時実行を確認してください');
    });
    return w;
  };

  root.ShipSearch = S;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof window !== 'undefined' ? window : globalThis);
