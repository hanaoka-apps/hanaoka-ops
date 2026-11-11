/* ============================================================
   価格・送料の早見（price_check.html）の計算部分
   ------------------------------------------------------------
   画面から切り離してあるのは、Node で見本データを使って確かめるため
   （tests/test_price_core.cjs）。ブラウザでは window.PriceCore、Node では module.exports。
   このファイルには価格・得意先などの業務データを書かない（公開リポジトリ）。
   データはすべて SharePoint のリストと SharedMasters から読む。

   使うデータ
     定価リスト        … 型式・定価・適用開始日・商品の種類・運賃の重量kg
     得意先の区分リスト … 得意先（または得意先社名）× 商品の種類 → 掛率・在庫口・計算方式
     例外リスト        … 型式 × 得意先・社名・ランク → 掛率 または 金額（在庫口だけ・○台以上 などの条件つき）
     運賃リスト        … 地域（県）・路線便（重量帯）・ミニ便（台数）・決まり
     得意先マスタ.csv  … ランク（掛率名）・得意先社名ｺｰﾄﾞ（SMILE が正）

   単価の決め方（上から順に、当てはまったものを使う）
     1. 見積日・受注日に効いている定価（適用開始日がその日以前で一番新しい行）
     2. 得意先のランク（SMILE の掛率名）→ 掛率
     3. 得意先の区分で上書き（得意先コード → 得意先社名 の順。商品の種類が合うもの）
        在庫口の得意先コードあては在庫口の掛率
     4. 例外（得意先コード → 得意先社名 → ランク → 全部 の順。在庫口だけ・○台以上 の条件を見る）
     5. 単価 ＝ 定価 × 掛率 を 10円単位で四捨五入（SMILE の受注と同じ。2026年の受注で確認。
        各社価格表は100円単位で、受注とずれることがある）。例外が金額ならその金額
     6. 計算方式「本部経由」（台車本体だけ）
          販社への見積単価 ＝ 単価 ÷ 0.93 を 10円単位で切り上げ
          本部からの受注単価 ＝ 販社への見積単価 × 0.93 を 1円単位で四捨五入
     7. 計算方式「運賃込み」… 単価に、決めた地域あての 1台分の運賃を足す（一部の得意先）

   送料の決め方
     重さ ＝ 運賃の重量kg × 台数 を足したもの。400kg を超えた分は 400kg の運賃＋残りの重さの運賃。
     部品・輸入品だけで 9台以内ならミニ便（台数で引く）。個人宅は 2 倍。沖縄は都度見積。
   ============================================================ */
(function (root) {
  "use strict";

  // ---------- 小さな道具 ----------
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : null;
  }
  // 101400×0.575 が 58304.999… になるような小数の誤差で、エクセルの ROUND とずれないようにする
  function round(v, unit) { return Math.floor(Number((v / unit).toFixed(9)) + 0.5) * unit; }
  function ceil(v, unit) { return Math.ceil(v / unit - 1e-9) * unit; }
  function ymd(d) { return String(d || "").replace(/\//g, "-").slice(0, 10); }
  function yen(v) { return v === null || v === undefined ? "-" : Math.round(v).toLocaleString("ja-JP") + "円"; }
  function pct(k) { return (Math.round(k * 1000) / 100) + "掛"; }

  // ---------- ランク（SMILE の掛率名） ----------
  // 例：「5掛(A')」「5.25掛(A)」「5.75掛(B)」「7掛(ﾕｰｻﾞｰ)」「6.25掛」。「その他」や空は null
  function rankOf(kakeName) {
    var s = String(kakeName || "").replace(/’/g, "'");
    var m = s.match(/([\d.]+)掛/);
    if (!m) return null;
    var k = Number(m[1]) / 10;
    var r = s.match(/\(([^)]*)\)/);
    var rank = r ? r[1].replace(/ﾕｰｻﾞｰ/, "ユーザー") : "";
    return { rank: rank, k: k };
  }
  // 例外の「対象コード」に書かれたランク（「A'・A」「B'・B」など）に当てはまるか
  function rankMatches(target, rank) {
    if (!rank) return false;
    return String(target || "").replace(/’/g, "'").split(/[・,、\/ ]+/).some(function (t) { return t === rank; });
  }

  var ROUND_UNIT = 10; // 単価の丸め（SMILE の受注と同じ10円単位）

  // ---------- 定価 ----------
  // 定価が空の行（運賃の重さだけの行）は、定価を探すときは飛ばす
  function listPriceRow(prices, code, date, anyRow) {
    var d = ymd(date), best = null;
    for (var i = 0; i < prices.length; i++) {
      var p = prices[i];
      if (p.型式 !== code) continue;
      if (!anyRow && num(p.定価) === null) continue;
      if (ymd(p.適用開始日) > d) continue;
      if (!best || ymd(p.適用開始日) > ymd(best.適用開始日)) best = p;
    }
    return best;
  }
  function priceHistory(prices, code) {
    return prices.filter(function (p) { return p.型式 === code; })
      .sort(function (a, b) { return ymd(a.適用開始日) < ymd(b.適用開始日) ? -1 : 1; });
  }

  // 日付が効いている行だけ（同じ対象なら新しいものを優先するのは呼ぶ側）
  function inEffect(row, date) {
    var d = ymd(date);
    if (row.適用開始日 && ymd(row.適用開始日) > d) return false;
    if (row.適用終了日 && ymd(row.適用終了日) < d) return false;
    return true;
  }
  function kindMatches(rowKind, kind) { return !rowKind || rowKind === "全部" || rowKind === kind; }
  function newest(rows) {
    return rows.slice().sort(function (a, b) { return ymd(a.適用開始日) < ymd(b.適用開始日) ? 1 : -1; })[0] || null;
  }

  // ---------- 得意先の区分 ----------
  // customer: { code, shaCode, shaName, name, kakeName }
  function customerClass(classes, customer, kind, date) {
    var mine = classes.filter(function (c) { return inEffect(c, date); });
    var byCode = mine.filter(function (c) { return c.対象の種類 === "得意先" && c.対象コード === customer.code; });
    var bySha = mine.filter(function (c) { return c.対象の種類 === "社名" && c.対象コード && c.対象コード === customer.shaCode; });
    // 在庫口は得意先コードの行で決まる（商品の種類によらない）
    var isStock = byCode.some(function (c) { return c.在庫口 === true || c.在庫口 === "はい"; });
    function pick(rows) {
      var ok = rows.filter(function (c) { return kindMatches(c.商品の種類, kind); });
      // 商品の種類を名指しした行を「全部」より優先
      var named = ok.filter(function (c) { return c.商品の種類 && c.商品の種類 !== "全部"; });
      return newest(named.length ? named : ok);
    }
    // 得意先コードの行のうち、在庫口の印だけの行は区分の上書きに使わない
    var codeRow = pick(byCode.filter(function (c) {
      return num(c.掛率) !== null || num(c.在庫口の掛率) !== null || (c.計算方式 && c.計算方式 !== "通常");
    }));
    var shaRow = pick(bySha);
    return { isStock: isStock, codeRow: codeRow, shaRow: shaRow };
  }

  // ---------- 例外 ----------
  function findException(exceptions, ctx) {
    var cands = exceptions.filter(function (e) {
      if (e.型式 !== ctx.code) return false;
      if (!inEffect(e, ctx.date)) return false;
      if ((e.在庫口のみ === true || e.在庫口のみ === "はい") && !ctx.isStock) return false;
      var n = num(e.台数以上);
      if (n !== null && ctx.qty < n) return false;
      if (e.対象の種類 === "得意先") return e.対象コード === ctx.customer.code;
      if (e.対象の種類 === "社名") return !!e.対象コード && e.対象コード === ctx.customer.shaCode;
      if (e.対象の種類 === "ランク") return rankMatches(e.対象コード, ctx.rank);
      if (e.対象の種類 === "全部") return true;
      return false; // 未整理の行は自動では使わない（画面で参考に出す）
    });
    var order = { "得意先": 0, "社名": 1, "ランク": 2, "全部": 3 };
    cands.sort(function (a, b) {
      var oa = order[a.対象の種類], ob = order[b.対象の種類];
      if (oa !== ob) return oa - ob;
      // 在庫口だけの行を優先（在庫口あてのとき）、台数の条件は大きいほうを優先、新しいほうを優先
      var sa = (a.在庫口のみ === true || a.在庫口のみ === "はい") ? 0 : 1, sb = (b.在庫口のみ === true || b.在庫口のみ === "はい") ? 0 : 1;
      if (sa !== sb) return sa - sb;
      var na = num(a.台数以上) || 0, nb = num(b.台数以上) || 0;
      if (na !== nb) return nb - na;
      return ymd(a.適用開始日) < ymd(b.適用開始日) ? 1 : -1;
    });
    return cands[0] || null;
  }
  // 自動では使わないが、参考に見せたい行（未整理・要確認）
  function relatedNotes(exceptions, code) {
    return exceptions.filter(function (e) { return e.型式 === code && (e.対象の種類 === "未整理" || e.要確認 === true || e.要確認 === "はい"); });
  }

  // ---------- 運賃 ----------
  function regionOfPref(fares, pref) {
    var p = String(pref || "").replace(/[都府県]$/, "");
    if (p === "北海") p = "北海道";
    var rows = fares.filter(function (f) { return f.種類 === "地域"; });
    for (var i = 0; i < rows.length; i++) {
      var list = String(rows[i].県 || "").split(/[\s、,]+/);
      if (list.indexOf(p) >= 0) return { region: rows[i].地域, carrier: rows[i].運送会社 };
    }
    return null;
  }
  function fareRows(fares, kind, region, date) {
    // 同じ地域・上限の行は、その日に効いている一番新しいものを使う
    var map = {};
    fares.forEach(function (f) {
      if (f.種類 !== kind || f.地域 !== region || !inEffect(f, date)) return;
      var key = String(f.上限);
      if (!map[key] || ymd(f.適用開始日) > ymd(map[key].適用開始日)) map[key] = f;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return num(a.上限) - num(b.上限); });
  }
  function bandFare(rows, kg) {
    for (var i = 0; i < rows.length; i++) if (kg <= num(rows[i].上限)) return rows[i];
    return null;
  }
  function routeFare(rows, kg) {
    // 400kg を超えた分は 400kg の運賃＋残りの重さの運賃（例：480kg＝400kg＋80kg）
    if (!rows.length) return null;
    var top = rows[rows.length - 1], topKg = num(top.上限), total = 0, parts = [];
    var rest = kg;
    while (rest > topKg) { total += num(top.金額); parts.push(topKg + "kg"); rest -= topKg; }
    if (rest > 0) {
      var r = bandFare(rows, rest);
      total += num(r.金額); parts.push(num(r.上限) + "kg帯");
    }
    return { amount: total, parts: parts };
  }

  function isOption(code) { return /^OP\//i.test(String(code || "")); }
  // 部品のまとめコード：「DANDY/P」「D.LIFT/P」「P.D/P」「P/UDA50-JK」のように /P を含むもの
  function isPartBundle(code) { return /\/P$|^P\//i.test(String(code || "")); }

  // lines: [{ code, qty }]、opt: { pref, date, personal(個人宅), logis(本部経由) }
  function freight(data, lines, opt) {
    var out = { amount: null, explain: [], warnings: [] };
    var date = opt.date;
    var reg = regionOfPref(data.fares, opt.pref);
    if (!opt.pref) { out.warnings.push("届け先の県を入れると送料を出します"); return out; }
    if (/沖縄/.test(opt.pref)) { out.warnings.push("沖縄・離島は西濃の個別運賃（原価÷0.8 を百の位で切り上げ）。都度見積"); return out; }
    if (!reg) { out.warnings.push("県から地域がわかりません：" + opt.pref); return out; }
    // 本体と一緒に送るオプション（OP/〜）は本体の運賃に含める（運賃表「台車1台にPB1個なら本体運賃のみ」）。
    // 「DANDY/P」のような部品のまとめコードは中身が毎回違うので、重さを決めずに小さな荷物1個として扱う
    var info = lines.filter(function (l) { return l.code && l.qty > 0; }).map(function (l) {
      var p = listPriceRow(data.prices, l.code, date, true) || priceHistory(data.prices, l.code).slice(-1)[0];
      return { l: l, p: p, option: isOption(l.code), part: isPartBundle(l.code) };
    });
    var hasBody = info.some(function (x) { return !x.option && !x.part; });
    var kg = 0, count = 0, small = true, unknown = [], parts = false, optInBody = false;
    info.forEach(function (x) {
      var kind = x.p ? x.p.商品の種類 : "";
      if (x.part) { parts = true; return; }
      if (x.option && hasBody) { optInBody = true; return; }
      if (kind !== "部品" && kind !== "輸入品" && !x.option) small = false;
      count += x.l.qty;
      var w = x.p ? num(x.p.運賃の重量kg) : null;
      if (w === null) unknown.push(x.l.code); else kg += w * x.l.qty;
    });
    if (parts) count += 1;
    if (!count) return out;
    if (optInBody) out.explain.push("オプションは本体と一緒なので本体の運賃に含める");
    if (parts) out.warnings.push("部品のまとめコード（○○/P）は大きさで決める：小さければミニ便、箱が大きければ路線便10kg（1,700円前後）");
    var carrier = opt.personal ? "西濃運輸" : reg.carrier;
    if (small && count <= 9) {
      var mini = fareRows(data.fares, "ミニ便", reg.region, date);
      var m = bandFare(mini, count);
      if (m) {
        out.amount = num(m.金額);
        out.explain.push("ミニ便（" + reg.region + "・" + count + "個）" + yen(out.amount));
        carrier = opt.personal ? "西濃運輸" : "第一貨物";
      }
    }
    if (out.amount === null) {
      if (unknown.length) out.warnings.push("運賃の重さがわからない商品があります：" + unknown.join("、") + "（重さを入れてください）");
      if (kg <= 0) return out;
      var rows = fareRows(data.fares, "路線便", reg.region, date);
      var r = routeFare(rows, kg);
      if (!r) { out.warnings.push("運賃表がありません：" + reg.region); return out; }
      out.amount = r.amount;
      out.explain.push("路線便（" + reg.region + "・合計" + kg + "kg → " + r.parts.join("＋") + "）" + yen(r.amount));
    }
    if (opt.personal) { out.amount *= 2; out.explain.push("個人宅なので2倍 → " + yen(out.amount)); }
    if (opt.logis) {
      var q = ceil(out.amount / 0.93, 10);
      out.explain.push("本部経由：販社への見積は ÷0.93 を10円単位で切り上げ → " + yen(q) + "（本部からの受注は " + yen(round(q * 0.93, 1)) + "）");
      out.quoteAmount = q; out.orderAmount = round(q * 0.93, 1);
    }
    out.carrier = carrier; out.region = reg.region; out.kg = kg;
    if (carrier === "トナミ運輸") out.warnings.push("トナミ運輸は土曜の配達・集荷なし");
    return out;
  }

  // 1台分の運賃（「運賃込み」の得意先に使う）
  function unitFare(data, code, region, date) {
    var p = listPriceRow(data.prices, code, date, true);
    var w = p ? num(p.運賃の重量kg) : null;
    if (w === null) return null;
    var rows = fareRows(data.fares, "路線便", region, date);
    var r = routeFare(rows, w);
    return r ? r.amount : null;
  }

  // ---------- 単価 ----------
  // ctx: { code, qty, date, customer:{code,shaCode,shaName,name,kakeName}, forceStock(在庫価格を使う),
  //        withBody(同じ注文に台車などの本体がある。本部経由で部品も本部経由にするため) }
  function unitPrice(data, ctx) {
    var out = { code: ctx.code, explain: [], warnings: [], notes: [], price: null };
    var date = ymd(ctx.date);
    var row = listPriceRow(data.prices, ctx.code, date);
    if (!row) {
      var hist = priceHistory(data.prices, ctx.code);
      var priced = hist.filter(function (h) { return num(h.定価) !== null; });
      out.warnings.push(priced.length ? "この日付に効いている定価がありません（最初の定価は " + ymd(priced[0].適用開始日) + " から）" : "定価リストに定価がない型式です：" + ctx.code);
      return out;
    }
    var list = num(row.定価), kind = row.商品の種類 || "その他";
    out.listPrice = list; out.kind = kind; out.name = row.品名 || "";
    out.explain.push("定価 " + yen(list) + "（" + ymd(row.適用開始日) + " から）");

    var cust = ctx.customer || {};
    var rk = rankOf(cust.kakeName);
    var k = rk ? rk.k : null, rank = rk ? rk.rank : "";
    if (rk) out.explain.push("得意先のランク：" + (cust.kakeName || "") + " → " + pct(k));
    else out.warnings.push("得意先のランクが「" + (cust.kakeName || "なし") + "」なので、区分か例外で掛率を決めます");

    var cc = customerClass(data.classes, cust, kind, date);
    var isStock = cc.isStock || !!ctx.forceStock;
    if (cc.isStock) out.explain.push("在庫口の得意先コード → 在庫価格を使う");
    else if (ctx.forceStock) out.explain.push("「在庫価格を使う」が選ばれている（営業の指示）");
    var method = "通常", fareRegion = null;
    [cc.shaRow, cc.codeRow].forEach(function (c) { // 社名 → 得意先コード の順に上書き
      if (!c) return;
      var who = (c.対象の種類 === "得意先" ? "得意先" : "得意先社名「" + (c.対象名 || c.対象コード) + "」") + (c.商品の種類 && c.商品の種類 !== "全部" ? "・" + c.商品の種類 : "");
      if (num(c.掛率) !== null) { k = num(c.掛率); out.explain.push(who + " の区分 → " + pct(k)); }
      if (isStock && num(c.在庫口の掛率) !== null) { k = num(c.在庫口の掛率); out.explain.push(who + " の在庫口の掛率 → " + pct(k)); }
      if (c.計算方式 && c.計算方式 !== "通常") { method = c.計算方式; fareRegion = c.運賃込みの地域 || fareRegion; }
      if (c.要確認 === true || c.要確認 === "はい") out.warnings.push(who + " の区分は要確認：" + (c.メモ || ""));
    });

    var ex = findException(data.exceptions, { code: ctx.code, date: date, qty: ctx.qty || 1, isStock: isStock, customer: cust, rank: rank });
    var price = null;
    if (ex) {
      var exWho = ex.対象の種類 === "全部" ? "全員" : (ex.対象名 || ex.対象コード);
      var cond = [];
      if (ex.在庫口のみ === true || ex.在庫口のみ === "はい") cond.push("在庫口");
      if (num(ex.台数以上) !== null) cond.push(num(ex.台数以上) + "台以上");
      var lead = "例外（" + exWho + (cond.length ? "・" + cond.join("・") : "") + "）";
      if (num(ex.金額) !== null) { price = num(ex.金額); out.explain.push(lead + " → " + yen(price)); }
      else if (num(ex.掛率) !== null) { k = num(ex.掛率); out.explain.push(lead + " → " + pct(k)); }
      if (ex.要確認 === true || ex.要確認 === "はい") out.warnings.push("使った例外は要確認：" + (ex.メモ || ex.出典 || ""));
      out.exception = ex;
    }
    if (price === null) {
      if (k === null) { out.warnings.push("掛率が決まりません（ランク・区分・例外のどれもない）"); return out; }
      price = round(list * k, ROUND_UNIT);
      out.explain.push("単価 ＝ 定価 × " + pct(k) + " を" + ROUND_UNIT + "円単位で四捨五入 → " + yen(price));
    }
    out.k = k; out.isStock = isStock; out.method = method;

    if (method === "本部経由") {
      // 業務内容まとめ（2026-04）：台車本体は本部経由。台車＋部品なら部品も本部経由（Aランク÷0.93）。
      // 部品だけ・RIDE とアタッチメントは販社と直接（Bランク、運賃は通常）
      var direct = /^RIDE/i.test(ctx.code) || /(^|[\/-])RA($|[\/-])/i.test(ctx.code) || (kind === "部品" && !ctx.withBody);
      if (!direct) {
        var q = ceil(price / 0.93, 10), o = round(q * 0.93, 1);
        out.explain.push("本部経由：販社への見積単価 ＝ ÷0.93 を10円単位で切り上げ → " + yen(q));
        out.explain.push("本部からの受注単価 ＝ ×0.93 を1円単位で四捨五入 → " + yen(o) + "（受注の得意先コード・備考は区分のメモを見る）");
        out.quotePrice = q; out.orderPrice = o; out.price = q;
      } else {
        out.warnings.push("部品だけ・RIDE・アタッチメントは販社と直接取引。Bランク・運賃は通常（台車と一緒なら部品も本部経由）");
        price = round(list * 0.575, ROUND_UNIT); out.k = 0.575;
        out.explain.push("販社と直接：Bランク 5.75掛 → " + yen(price));
        out.price = price;
      }
    } else if (method === "運賃込み") {
      var f = unitFare(data, ctx.code, fareRegion || "近畿", date);
      if (f === null) { out.warnings.push("運賃込みの得意先ですが、この商品の運賃の重さがわかりません"); out.price = price; }
      else {
        out.price = price + f; out.fareIncluded = f;
        out.explain.push("運賃込み（" + (fareRegion || "近畿") + "あて1台分 " + yen(f) + "）→ " + yen(out.price));
      }
    } else out.price = price;

    if (isStock) out.notes.push("見積書には在庫価格を載せず「御社在庫品」と書く");
    relatedNotes(data.exceptions, ctx.code).forEach(function (e) {
      if (e === ex) return;
      out.notes.push("参考（" + (e.対象名 || e.対象の種類) + "）：" + (num(e.金額) !== null ? yen(num(e.金額)) : num(e.掛率) !== null ? pct(num(e.掛率)) : "") + " " + (e.メモ || "") + "［" + (e.出典 || "") + "］");
    });
    return out;
  }

  // ---------- CSV（得意先マスタ.csv などはカンマ、受注明細出力.csv はタブ） ----------
  function parseCSV(text, sep) {
    sep = sep || ",";
    var rows = [], row = [], cell = "", q = false, i = 0, t = String(text || "");
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    for (; i < t.length; i++) {
      var ch = t[i];
      if (q) {
        if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && t[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function toObjects(text, sep) {
    var rows = parseCSV(text, sep);
    if (!rows.length) return [];
    var h = rows[0], out = [];
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].length < 2) continue;
      var o = {};
      for (var c = 0; c < h.length; c++) if (!(h[c] in o)) o[h[c]] = rows[r][c] !== undefined ? rows[r][c] : "";
      out.push(o);
    }
    return out;
  }
  // 得意先マスタ.csv の1行 → 計算に使う形
  function customerFromMaster(o) {
    return { code: o["得意先ｺｰﾄﾞ"] || "", name: o["得意先名略称"] || o["得意先名１"] || "", fullName: (o["得意先名１"] || "") + (o["得意先名２"] ? " " + o["得意先名２"] : ""),
      shaCode: o["得意先社名ｺｰﾄﾞ"] || "", shaName: o["得意先社名名"] || "", kakeName: o["掛率名"] || "", kakeMemo: o["掛率備考"] || "",
      genre: o["得意先ｼﾞｬﾝﾙ名"] || "", staff: o["担当者名"] || "", address: (o["住所１"] || "") + (o["住所２"] || "") };
  }
  var PREFS = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split(" ");
  function prefOf(address) {
    var a = String(address || "");
    for (var i = 0; i < PREFS.length; i++) if (a.indexOf(PREFS[i]) === 0 || a.indexOf(PREFS[i].replace(/[都府県]$/, "")) === 0) return PREFS[i];
    return "";
  }

  var API = {
    parseCSV: parseCSV, toObjects: toObjects, customerFromMaster: customerFromMaster, PREFS: PREFS, prefOf: prefOf,
    num: num, round: round, ceil: ceil, ymd: ymd, yen: yen, pct: pct,
    rankOf: rankOf, rankMatches: rankMatches, listPriceRow: listPriceRow, priceHistory: priceHistory,
    customerClass: customerClass, findException: findException, regionOfPref: regionOfPref,
    freight: freight, unitFare: unitFare, unitPrice: unitPrice, isOption: isOption, isPartBundle: isPartBundle
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.PriceCore = API;
})(typeof window !== "undefined" ? window : this);
