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

  // 受注№ → 同じ受注の出荷（分けて出荷したときの、ほかの出荷）。ship は含めない
  S.siblings = function (idx, ship) {
    var set = {}; (ship.juchu || []).forEach(function (j) { set[j] = 1; });
    return (idx.ships || []).filter(function (s) { return s !== ship && (s.juchu || []).some(function (j) { return set[j]; }); });
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
