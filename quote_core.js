// 見積・受注（quote.html）の計算。画面は持たない（テスト：node tests/test_quote_core.cjs）
//   単価と送料そのものは price_core.js が出す。ここは「書類」としてのまとめ：
//   品目コードの読み替え・単価を変えたときの記録・合計・確認すること・番号・保存する形
(function (root) {
  "use strict";
  var P = (typeof module !== "undefined" && module.exports) ? require("./price_core.js") : root.PriceCore;
  var num = P.num, ymd = P.ymd, key = P.asmKey;

  // 単価を変えたときに選ぶ理由（あとで設定のリストから読めるようにする）
  var REASONS = ["1ランク上げ", "数量", "競合", "新規開拓", "継続の特価", "価格改定前の見積", "上長の了承", "その他"];
  // 変えた理由の大もとの2択：今回だけ特別（上の理由から選ぶ）か、アプリの計算が違う（ルールを直す対象）か
  var WRONG = "アプリの計算が違う", ONCE = "今回だけ特別";
  var STATUSES = ["下書き", "提出済み", "受注", "失注"];
  var TAX_RATE = 0.1;

  function fmt(v) { return v === null || v === undefined || v === "" ? "" : Math.round(v).toLocaleString("ja-JP"); }
  // 0.575 → 「5.75掛」
  function kake(k) { return k === null || k === undefined ? "" : String(Math.round(k * 1000) / 100) + "掛"; }
  // SMILE の掛率名「5.75掛(B)」→「Bランク」
  function rankLabel(kakeName) {
    var r = P.rankOf(kakeName);
    if (!r || !r.rank) return "";
    return /^[A-Z]'?$/.test(r.rank) ? r.rank + "ランク" : r.rank;
  }

  // 探すときの表記ゆれをならす（全角・半角、大文字・小文字、ハイフン・空白、小さいカナ）
  var SMALL = { "ァ": "ア", "ィ": "イ", "ゥ": "ウ", "ェ": "エ", "ォ": "オ", "ャ": "ヤ", "ュ": "ユ", "ョ": "ヨ", "ッ": "ツ", "ヮ": "ワ" };
  function norm(s) {
    return String(s || "").normalize("NFKC").toUpperCase().replace(/[ァィゥェォャュョッヮ]/g, function (c) { return SMALL[c]; })
      .replace(/[\s\-‐－ー―・\/／_.()（）]/g, "");
  }
  // 一覧から探す。空白で区切った言葉が全部入っているものを、先頭が合うものから順に n 件
  //   rows: [{ key: ならした文字, head: 先頭で比べる文字, ... }]
  function search(rows, q, n) {
    var words = String(q || "").split(/[\s　]+/).map(norm).filter(Boolean);
    if (!words.length) return [];
    var hit = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], ok = true;
      for (var j = 0; j < words.length; j++) if (r.key.indexOf(words[j]) < 0) { ok = false; break; }
      if (!ok) continue;
      var h = r.head || r.key, w = words[0];
      hit.push({ row: r, score: h === w ? 0 : h.indexOf(w) === 0 ? 1 : 2 });
    }
    hit.sort(function (a, b) { return a.score - b.score || a.row.key.length - b.row.key.length; });
    return hit.slice(0, n || 8).map(function (x) { return x.row; });
  }

  // ---------- 品目コードの読み替え ----------
  // 定価リストの型式を、ならした名前で引けるようにする。priced＝定価がある型式、any＝重さだけの行も含む
  function buildIndex(prices) {
    // same＝ならすと同じになる型式の書き方ぜんぶ（XA-BT2 と XABT2）。送料の重さを探すのに使う
    var priced = {}, any = {}, same = {};
    (prices || []).forEach(function (p) {
      var k = key(p.型式); if (!k) return;
      if (!any[k]) any[k] = p.型式;
      if (num(p.定価) !== null && !priced[k]) priced[k] = p.型式;
      var s = same[k] || (same[k] = []); if (s.indexOf(p.型式) < 0) s.push(p.型式);
    });
    return { priced: priced, any: any, same: same };
  }
  // 入れた型式・品目コードから、定価リストの型式を決める。
  //   ① そのまま（書き方違いはそろえる）→ ② 品目マスタの「価格表記載名」（UDL25 → UDL250）
  //   items: { 品目ｺｰﾄﾞ: { name, kakaku } }。返す：{ code, via, noPrice }
  function resolveCode(code, items, index) {
    var k = key(code);
    if (!k) return { code: "", via: "" };
    if (index.priced[k]) return { code: index.priced[k], via: "" };
    var it = items && items[code], kk = it && it.kakaku ? key(it.kakaku) : "";
    if (kk && index.priced[kk]) return { code: index.priced[kk], via: "価格表記載名" };
    if (index.any[k]) return { code: index.any[k], via: "", noPrice: true };
    return { code: "", via: "" };
  }

  // 枝番つきの品目コード（うしろに /C・/T・/TEL など）。OP/〜・P/〜・R/〜（オプション・部品・修理）は枝番ではない
  function isVariant(code) { return /^(?!OP\/|P\/|R\/).+\/[A-Za-z0-9]{1,4}$/i.test(String(code || "")); }

  // 価格表記載名 → その名前を持つ品目コード（枝番つきは除く）。送料の重さを探すのに使う
  function kakakuIndex(items) {
    var m = {};
    Object.keys(items || {}).forEach(function (c) {
      var it = items[c]; if (!it || !it.kakaku || isVariant(c)) return;
      var k = key(it.kakaku); (m[k] = m[k] || []).push(c);
    });
    return m;
  }

  // ---------- 前回の受注単価 ----------
  // 受注明細から「取引先 × 品目 → いちばん新しい受注の単価」を作る。h：{ c:{ "得意先コード|品目": [単価, 日付] }, s:{ "社名コード|品目": … } }
  // 2026-06〜11 の受注では、前回の受注がある行の 74％が前回と同じ単価だった（ルールにない特別単価も、定価のない部品も）
  function historyNew() { return { c: {}, s: {} }; }
  //   r: { date:"YYYY-MM-DD", cust, sha, code, qty, unit, ret:返品か }。運賃の行・返品・0円（サンプル）は入れない
  function historyPush(h, r) {
    var u = num(r.unit);
    if (!r.code || r.code === "FR" || r.ret || !(num(r.qty) > 0) || u === null || u <= 0 || !r.cust) return;
    var k = key(r.code), v = [u, ymd(r.date)];
    var put = function (m, id) { if (!m[id] || m[id][1] <= v[1]) m[id] = v; };
    put(h.c, r.cust + "|" + k);
    if (r.sha) put(h.s, r.sha + "|" + k);
  }
  // 返す：{ unit, date, from:"cust"（同じ取引先）|"sha"（同じ社名） } か null
  function prevOf(h, cust, codes) {
    if (!h || !cust) return null;
    var ks = []; (codes || []).forEach(function (c) { var k = key(c); if (k && ks.indexOf(k) < 0) ks.push(k); });
    var find = function (m, id, from) {
      if (!id) return null;
      var best = null;
      ks.forEach(function (k) { var v = (m || {})[id + "|" + k]; if (v && (!best || v[1] > best.date)) best = { unit: v[0], date: v[1], from: from }; });
      return best;
    };
    return find(h.c, cust.code, "cust") || find(h.s, cust.shaCode, "sha");
  }

  // ---------- 単価 ----------
  // その単価の決め手を、短いことばにする（行の下に出す）
  function whyText(r) {
    if (!r || r.price === null || r.price === undefined) return "";
    var s;
    if (r.exception) {
      s = "特価（" + (r.exceptionLabel || "") + "）";
      if (num(r.exception.金額) === null && r.k !== null && r.k !== undefined) s = "定価 " + fmt(r.listPrice) + " × " + s + " " + kake(r.k);
    } else {
      var label = r.isStock ? "在庫価格" : (r.classText && r.classText.length ? "この取引先の決まり" : (rankLabel(r.rankName) || "掛率"));
      s = "定価 " + fmt(r.listPrice) + " × " + label + " " + kake(r.k);
    }
    if (r.method === "本部経由" && r.quotePrice !== undefined && r.quotePrice !== null) s += " ÷0.93（本部経由）";
    if (r.method === "運賃込み" && r.fareIncluded !== undefined && r.fareIncluded !== null) s += " ＋運賃 " + fmt(r.fareIncluded);
    return s;
  }

  // 明細の1行を計算する。
  //   line: { code, name, qty, unitName, price(手で入れた単価), manual, ov:{ price, k, reason, memo }, lead, note, ship }
  //   ctx : { customer, priceDate, kind:"quote"|"order", items, index, withBody }
  function priceLine(data, line, ctx) {
    var qty = Math.max(0, num(line.qty) || 0);
    var out = { code: line.code || "", listCode: "", via: "", name: line.name || "", qty: qty, unitName: line.unitName || "台",
      manual: !!line.manual, base: null, unit: null, amount: null, changed: false, reason: "", memo: "", cost: null,
      lead: line.lead || "", note: line.note || "", ship: line.ship || "", warnings: [] };
    var ov = line.ov || {};
    if (out.manual || !out.code) {
      out.manual = true; out.unit = num(line.price); out.name = line.name || line.code || "";
    } else {
      var rc = resolveCode(out.code, ctx.items, ctx.index);
      out.listCode = rc.code; out.via = rc.via;
      var it = ctx.items && ctx.items[out.code];
      if (!rc.code) {
        out.noRule = true; out.unit = num(line.price);
        out.name = line.name || (it && it.name) || "";
        out.warnings.push("定価リストにない型式です：" + out.code + "（単価を入れてください）");
      } else if (rc.via && isVariant(out.code)) {
        // 枝番つき（SLLSC/C＝キャスター変更、RIDE/T＝特注 など）は、元の型式とは値段が違う。
        // 元の型式の定価では計算しない（2026-11 の受注で、枝番つきは元の型式の単価と1件も合わなかった）。
        // 元の型式の単価は参考として見せ、送料の重さには元の型式を使う
        var rr = P.unitPrice(data, { code: rc.code, qty: qty || 1, date: ctx.priceDate, customer: ctx.customer || {}, withBody: !!ctx.withBody });
        out.variantOf = rc.code; out.refPrice = rr.price === undefined ? null : rr.price;
        out.noRule = true; out.unit = num(line.price);
        out.name = line.name || (it && it.name) || "";
      } else {
        var r = P.unitPrice(data, { code: rc.code, qty: qty || 1, date: ctx.priceDate, customer: ctx.customer || {}, withBody: !!ctx.withBody });
        var has = r.price !== null && r.price !== undefined;
        // 本部経由の取引先は、見積は販社への単価、受注伝票は本部からの受注単価
        var basePrice = !has ? null : (ctx.kind === "order" && r.orderPrice !== undefined && r.orderPrice !== null ? r.orderPrice : r.price);
        out.base = { price: basePrice, list: r.listPrice === undefined ? null : r.listPrice, k: r.k === undefined ? null : r.k,
          why: whyText(r), method: r.method || "", isStock: !!r.isStock, explain: r.explain || [], notes: r.notes || [], steps: r.steps || [],
          quotePrice: r.quotePrice === undefined ? null : r.quotePrice, orderPrice: r.orderPrice === undefined ? null : r.orderPrice,
          oldPrice: r.oldPrice === undefined ? null : r.oldPrice, listFrom: r.listFrom || "" };
        out.name = line.name || r.name || (it && it.name) || "";
        (r.warnings || []).forEach(function (w) { out.warnings.push(w); });
        if (num(ov.price) !== null) out.unit = num(ov.price);
        else if (num(ov.k) !== null && out.base.list !== null) out.unit = P.round(out.base.list * num(ov.k), P.roundUnit(ctx.priceDate));
        else out.unit = basePrice;
        if (basePrice === null) { out.noRule = true; if (out.unit === null) out.unit = num(line.price); }
        out.changed = basePrice !== null && out.unit !== null && out.unit !== basePrice;
        if (out.changed) { out.reason = ov.reason || ""; out.memo = ov.memo || ""; out.wrong = out.reason === WRONG; }
        var c = P.costRow(data.costs || [], rc.code, ctx.priceDate);
        out.cost = c ? num(c.原価) : null;
      }
    }
    out.amount = out.unit === null ? null : out.unit * qty;
    return out;
  }

  // ---------- 書類ぜんたい ----------
  // 定価を選ぶ日：見積日（受注伝票なら受注日）。出荷の予定日では選ばない。
  // 2026-06〜11 の受注では、10月に受けて11月以降に出荷した分の9割近くが、受注日の定価（改定前）だった
  function priceDateOf(doc) { return ymd(doc.date); }
  function usedLines(doc) {
    return (doc.lines || []).filter(function (l) { return l && (l.code || l.name || num(l.price) !== null); });
  }

  // doc: { kind, date, shipDate, cust, dest:{ name, pref, personal }, lines, fareManual }
  // env: { items, index }。返す：{ lines, fare, totals, margin, checks, priceDate }
  function compute(data, doc, env) {
    var priceDate = priceDateOf(doc), cust = doc.cust || null, kind = doc.kind === "order" ? "order" : "quote";
    var src = usedLines(doc);
    var index = env.index || buildIndex(data.prices);
    var isBody = function (l) {
      if (l.manual || !l.code) return false;
      var rc = resolveCode(l.code, env.items, index); if (!rc.code) return false;
      var row = P.listPriceRow(data.prices, rc.code, priceDate, true);
      return !!row && row.商品の種類 !== "部品" && !P.isOption(rc.code);
    };
    var withBody = src.some(isBody);
    var lines = src.map(function (l) { return priceLine(data, l, { customer: cust || {}, priceDate: priceDate, kind: kind, items: env.items, index: index, withBody: withBody }); });

    // 送料
    var dest = doc.dest || {}, logis = lines.some(function (l) { return l.base && l.base.method === "本部経由" && l.base.quotePrice !== null; });
    // 送料の重さは、入れた品目コードの行にあればそれを使う。なければ読み替えた型式の行。
    // （定価は UDL250 の行、重さは UDL25 の行、というように分かれていることがある）
    var hasWeight = function (c) { var r = c && P.listPriceRow(data.prices, c, priceDate, true); return !!r && num(r.運賃の重量kg) !== null; };
    //  ① 入れたコードの行 → ② 読み替えた型式の行 → ③ 同じ価格表記載名を持つ品目コードの行（UDL250 と入れたときの UDL25）
    var kk = env._kk || (env._kk = kakakuIndex(env.items));
    //  どの段でも、ハイフンのあり・なしだけが違う書き方（XA-BT2 と XABT2）は同じ型式として探す
    var weighted = function (c) { return ((index.same || {})[key(c)] || []).filter(hasWeight)[0]; };
    var fareCode = function (l) {
      var own = weighted(l.code);
      if (own) return own;
      var list = weighted(l.listCode);
      if (list) return list;
      var alt = (kk[key(l.listCode)] || []).map(weighted).filter(Boolean)[0];
      return alt || l.listCode;
    };
    // 前回の受注単価（同じ取引先・同じ品目。なければ同じ社名の別の支店）。参考に見せるだけで、単価は変えない
    if (env.history && cust) lines.forEach(function (l) {
      if (l.code) l.prev = prevOf(env.history, cust, [l.code, l.listCode].concat(kk[key(l.listCode || l.code)] || []));
    });
    var fl = lines.filter(function (l) { return l.listCode && l.qty > 0; }).map(function (l) { return { code: fareCode(l), qty: l.qty, ship: l.ship }; });
    var f = { amount: null, explain: [], warnings: [] };
    if (fl.length) f = P.freight(data, fl, { pref: dest.pref || "", date: priceDate, personal: !!dest.personal, logis: logis });
    var rule = f.amount === null || f.amount === undefined ? null : (logis && f.quoteAmount !== undefined ? (kind === "order" ? f.orderAmount : f.quoteAmount) : f.amount);
    var manualFare = num(doc.fareManual);
    var fare = { rule: rule, amount: manualFare !== null ? manualFare : rule, changed: manualFare !== null && manualFare !== rule, reason: "", memo: "",
      carrier: f.carrier || "", region: f.region || "", kg: f.kg || 0, how: f.method || "", explain: f.explain || [], warnings: f.warnings || [] };

    if (fare.changed) { fare.reason = doc.fareReason || ""; fare.memo = doc.fareMemo || ""; }
    fare.wrong = fare.reason === WRONG;

    // 合計（消費税は切り捨て）
    var sub = 0; lines.forEach(function (l) { sub += l.amount || 0; });
    var fa = fare.amount || 0, tax = Math.floor((sub + fa) * TAX_RATE + 1e-9);
    var totals = { subtotal: sub, fare: fa, beforeTax: sub + fa, tax: tax, total: sub + fa + tax };

    // 利益率（原価がわかる行だけ。社内だけで見る）
    var sales = 0, cost = 0, n = 0;
    lines.forEach(function (l) { if (l.cost !== null && l.amount !== null && l.qty > 0) { sales += l.amount; cost += l.cost * l.qty; n++; } });
    var margin = n && sales > 0 ? { rate: (sales - cost) / sales, lines: n, all: n === lines.length } : null;

    return { lines: lines, fare: fare, totals: totals, margin: margin, priceDate: priceDate,
      checks: checksOf(data, doc, lines, fare, index, env.items) };
  }

  // 確認すること（画面ではここにだけ注意を出す）。level：warn＝直してから出す、info＝知っておく
  function checksOf(data, doc, lines, fare, index, items) {
    var out = [], seen = {};
    var add = function (level, text) { if (!text || seen[text]) return; seen[text] = 1; out.push({ level: level, text: text }); };
    var cust = doc.cust, noCust = !cust || !(cust.name || cust.code);
    if (noCust) add("warn", "取引先を選んでください");
    else if (cust.isNew) add("info", "新しい取引先です。ランクがないので、単価は入れた金額になります");
    if (!lines.length) add("warn", "商品を1行入れてください");
    lines.forEach(function (l) {
      var nm = l.code || l.name || "（名前なし）";
      if (!(l.qty > 0)) add("warn", nm + " の数量を入れてください");
      // 取引先がまだのときは、定価のある品の単価は出せなくて当たり前なので、言わない（取引先を選べば出る）
      if (l.unit === null && !(noCust && l.listCode)) add("warn", nm + " の単価が入っていません");
      if (l.changed && !l.reason) add("warn", nm + " の単価を変えた理由を選んでください");
      else if (l.wrong && !String(l.memo || "").trim()) add("warn", nm + " の単価：正しくはどう決まるかを、ひとこと書いてください（ルールを直す人が読みます）");
      else if (l.changed) add("info", nm + " の単価を基本から変えています（" + l.reason + "）");
      if (l.base && l.base.isStock) add("info", nm + " は在庫価格です。見積書には「御社在庫品」と書きます");
      // 「単価を入れてください」で足りる注意は重ねて出さない（確認することを増やさない）
      l.warnings.forEach(function (w) { if (!/定価リストにない型式|ランクが「|掛率が決まりません/.test(w)) add("info", w); });
    });
    // 価格の改定：定価は見積日で選ぶ。改定が近いとき・改定してすぐのときに知らせる
    var d1 = priceDateOf(doc), soon = {}, just = {};
    lines.forEach(function (l) {
      if (!l.listCode) return;
      var hist = P.priceHistory(data.prices, l.listCode).filter(function (p) { return num(p.定価) !== null; });
      hist.forEach(function (p, i) {
        var s = ymd(p.適用開始日);
        if (s > d1 && daysBetween(d1, s) <= 120) soon[s] = 1;
        else if (i > 0 && s <= d1 && daysBetween(s, d1) <= 60) just[s] = 1;
      });
    });
    Object.keys(soon).sort().slice(0, 1).forEach(function (s) {
      add("info", s + " に定価が変わります。この見積は、見積日の定価（今の定価）で出しています");
    });
    Object.keys(just).sort().slice(-1).forEach(function (s) {
      add("info", s + " に定価が変わりました。改定前に出した見積の分は、単価を変えて、理由に「価格改定前の見積」を選んでください");
    });
    if (!(doc.dest && doc.dest.pref) && lines.some(function (l) { return l.listCode; })) add("info", "届け先の県を入れると送料が出ます");
    fare.warnings.forEach(function (w) { if (!/届け先の県/.test(w)) add("info", w); });
    // AI が読み取ったときの注意（quote_ai.js）。取引先を選んだら、取引先の注意は出さない
    ((doc.ai && doc.ai.notes) || []).forEach(function (n) { if (!(n.k === "cust" && cust && (cust.name || cust.code))) add("info", n.text); });
    if (fare.changed && !fare.reason) add("warn", "送料を変えた理由を選んでください（今回だけ特別／アプリの計算が違う）");
    else if (fare.wrong && !String(fare.memo || "").trim()) add("warn", "送料：正しくはどう決まるかを、ひとこと書いてください（ルールを直す人が読みます）");
    else if (fare.changed) add("info", "送料を基本（" + (fare.rule === null ? "なし" : fmt(fare.rule)) + "）から変えています");
    return out;
  }
  // 「見積書を出すまで あと○項目」。決まった4つ（取引先・商品と数量・単価・届け先の県）と、
  // 単価や送料を変えたときだけ出る「変えた理由」。notes＝知っておくこと（直すものではないので、数に入れない）
  //   返す：{ items:[{ key, label, done, line }], left, notes:[文] }。line＝直す行の番号（comp.lines の順。なければ -1）
  function todo(doc, comp) {
    var cust = doc.cust, lines = comp.lines, fare = comp.fare;
    var first = function (f) { for (var i = 0; i < lines.length; i++) if (f(lines[i])) return i; return -1; };
    var noQty = first(function (l) { return !(l.qty > 0); }), noUnit = first(function (l) { return l.unit === null; });
    var needWhy = function (l) { return l.changed && (!l.reason || (l.wrong && !String(l.memo || "").trim())); };
    var items = [
      { key: "cust", label: "取引先", done: !!(cust && (cust.name || cust.code)), line: -1 },
      { key: "lines", label: "商品と数量", done: lines.length > 0 && noQty < 0, line: noQty },
      { key: "price", label: "単価", done: lines.length > 0 && noUnit < 0, line: noUnit },
      { key: "pref", label: "届け先の県（送料）", done: !!(doc.dest && doc.dest.pref) || num(doc.fareManual) !== null, line: -1 }
    ];
    if (lines.some(function (l) { return l.changed; }) || fare.changed) {
      var w = first(needWhy), fareNg = fare.changed && (!fare.reason || (fare.wrong && !String(fare.memo || "").trim()));
      items.push({ key: w >= 0 || !fareNg ? "reason" : "fareReason", label: "変えた理由", done: w < 0 && !fareNg, line: w });
    }
    return { items: items, left: items.filter(function (x) { return !x.done; }).length,
      notes: comp.checks.filter(function (c) { return c.level !== "warn"; }).map(function (c) { return c.text; }) };
  }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

  // ---------- 見積書に載せる行 ----------
  // 返す：[{ name, note, unit, qty, unitName, amount, list, lead }]。送料は最後に1行
  function sheetRows(doc, comp) {
    var rows = comp.lines.map(function (l) {
      return { name: l.manual ? (l.name || l.code) : (l.code + (l.name && l.name !== l.code ? "　" + l.name : "")), note: l.note,
        unit: l.unit, qty: l.qty, unitName: l.unitName, amount: l.amount, list: doc.showList && l.base ? l.base.list : null, lead: l.lead };
    });
    if (comp.fare.amount) {
      var pref = doc.dest && doc.dest.pref ? "（" + doc.dest.pref + "送り）" : "";
      rows.push({ name: "送料" + pref, note: "", unit: comp.fare.amount, qty: 1, unitName: "一式", amount: comp.fare.amount, list: null, lead: "" });
    }
    return rows;
  }

  // ---------- 番号 ----------
  // 見積は Q、受注伝票は J。「Q261114-003」＝ 2026年11月14日の3件目。existing：その日までに使った番号
  function nextNumber(kind, date, existing) {
    var d = ymd(date).replace(/-/g, "").slice(2), head = (kind === "order" ? "J" : "Q") + d + "-", max = 0;
    (existing || []).forEach(function (no) {
      if (String(no).indexOf(head) !== 0) return;
      var n = parseInt(String(no).slice(head.length), 10);
      if (n > max) max = n;
    });
    return head + String(max + 1).padStart(3, "0");
  }

  // ---------- 保存する形 ----------
  // 入れた内容（doc）に、そのとき計算した結果（snap）を添えて残す。
  // あとでルールが変わっても、出した見積の金額と「なぜその値段だったか」が変わらないように
  function toRecord(doc, comp, who, now) {
    var snap = {
      priceDate: comp.priceDate, totals: comp.totals,
      fare: { amount: comp.fare.amount, rule: comp.fare.rule, changed: comp.fare.changed, reason: comp.fare.reason, wrong: comp.fare.wrong, memo: comp.fare.memo || "", carrier: comp.fare.carrier, region: comp.fare.region, kg: comp.fare.kg },
      margin: comp.margin ? comp.margin.rate : null,
      lines: comp.lines.map(function (l) {
        return { code: l.code, listCode: l.listCode, name: l.name, qty: l.qty, unitName: l.unitName, unit: l.unit, amount: l.amount,
          list: l.base ? l.base.list : null, basePrice: l.base ? l.base.price : null, baseWhy: l.base ? l.base.why : "",
          changed: l.changed, reason: l.reason, wrong: !!l.wrong, memo: l.memo, prev: l.prev ? l.prev.unit : null, manual: l.manual || !!l.noRule, cost: l.cost };
      })
    };
    var cust = doc.cust || {};
    var data = Object.assign({}, doc, { snap: snap, savedBy: who || "", savedAt: now || "", v: 1 });
    return {
      fields: { Title: doc.no || "", Kind: doc.kind === "order" ? "受注" : "見積", Status: doc.status || "下書き",
        Customer: String(cust.fullName || cust.name || "").slice(0, 250), CustomerCode: cust.code || "", CaseId: doc.caseId || "",
        DocDate: ymd(doc.date), Total: comp.totals.total, Subject: String(doc.title || "").slice(0, 250), Owner: doc.staff || who || "",
        Data: JSON.stringify(data) },
      data: data
    };
  }
  // 新しい書類の初期値
  function blank(kind, today, staff) {
    return { no: "", kind: kind === "order" ? "order" : "quote", status: "下書き", date: today, shipDate: "", cust: null, toName: "", honor: "御中",
      dest: { name: "", pref: "", personal: false }, lines: [{ code: "", qty: 1 }], fareManual: null,
      title: "", expiry: "発行後1ヶ月", pay: "従来通り", notes: "", showList: false, dept: "", staff: staff || "", caseId: "", from: "" };
  }
  // 複製：番号・状態・日付を新しくする（内容はそのまま）
  function duplicate(doc, today, staff) {
    var d = JSON.parse(JSON.stringify(doc));
    delete d.snap; delete d.savedBy; delete d.savedAt; delete d.spId;
    d.no = ""; d.status = "下書き"; d.date = today; d.staff = staff || d.staff; d.copiedFrom = doc.no || "";
    return d;
  }

  // ---------- 計算のしくみ（画面で、今のルールがどう働くかを見せる） ----------
  // 6つの段を、上から順に返す。comp（取引先と商品を1つ入れて計算した結果）を渡すと、
  // その組み合わせで各段がどう働いたか（state・result）も入る。
  //   state："used"＝単価を決めた段／"over"＝当てはまったが、あとの段が優先された／"skip"＝当てはまらない／""＝試していない
  function flow(data, comp) {
    var prices = (data && data.prices) || [], pricedSet = {}, weightSet = {};
    prices.forEach(function (p) { if (num(p.定価) !== null) pricedSet[key(p.型式)] = 1; if (num(p.運賃の重量kg) !== null) weightSet[key(p.型式)] = 1; });
    var nPriced = Object.keys(pricedSet).length, nWeight = Object.keys(pricedSet).filter(function (k) { return weightSet[k]; }).length;
    var steps = [
      { key: "price", title: "定価を選ぶ", rule: "定価リストから、型式と日付で選びます。日付は見積日です（出荷の予定日では選びません）。品目コードが定価リストにないときは、品目マスタの「価格表記載名」で読み替えます。", stat: "定価のある型式 " + nPriced + " 件" },
      { key: "rank", title: "ランクの掛け率", rule: "得意先マスタ（SMILE）のランクで掛け率が決まります。ここが基本です。", stat: "" },
      { key: "cls", title: "この取引先の決まり", rule: "取引先ごと・社名ごとに、ランクと違う掛け率や、計算の方式（本部経由・運賃込み・在庫口）を決めています。ランクより優先します。", stat: ((data && data.classes) || []).length + " 件" },
      { key: "exc", title: "例外（特価）", rule: "型式ごとの特別な掛け率・金額です。ランクとこの取引先の決まりより優先します。例外どうしでは、得意先 → 社名 → ランク → 全員 の順に細かいほうを使います。", stat: ((data && data.exceptions) || []).length + " 件" },
      { key: "round", title: "単価にする", rule: "定価 × 掛け率 を 100円単位で四捨五入します（2026-11-01 より前の日付は 10円単位）。本部経由の取引先は、見積は ÷0.93 の切り上げ、受注は ×0.93 です。", stat: "" },
      { key: "fare", title: "送料", rule: "型式ごとの重さ × 台数 を足して、届け先の県の地域と運賃表から決めます。400kg を超えたら分けて計算します。部品だけで 9個以内ならミニ便、個人宅は 2倍、沖縄は都度見積です。", stat: "重さが入っている型式 " + nWeight + " ／ " + nPriced + " 件" }
    ];
    steps.forEach(function (s) { s.state = ""; s.result = []; });
    var l = comp && comp.lines && comp.lines[0];
    if (!l) return steps;
    var by = {}; steps.forEach(function (s) { by[s.key] = s; s.state = "skip"; });
    var where = { "定価": "price", "ランク": "rank", "得意先の区分": "cls", "在庫価格": "cls", "本部経由": "cls", "例外": "exc" };
    var b = l.base, st = (b && b.steps) || [], last = "";
    if (l.listCode && l.via) by.price.result.push(l.code + " は、品目マスタの価格表記載名から " + l.listCode + " と読み替えました");
    st.forEach(function (x) {
      var s = by[where[x.label]]; if (!s) return;
      s.state = s.key === "price" ? "used" : "over";
      if (s.key !== "price") last = s.key;
      s.result.push(x.label === "定価" ? "定価 " + fmt(x.amount) + "（" + x.detail + "）"
        : (x.detail || x.label) + (x.k !== null && x.k !== undefined ? " → " + kake(x.k) : "") + (x.amount !== null && x.amount !== undefined ? "（定価に掛けると " + fmt(x.amount) + "）" : ""));
    });
    if (last && b && b.price !== null) by[last].state = "used";
    if (!st.length) by.price.result.push(l.variantOf ? l.variantOf + " の枝番つきです。元の型式とは値段が違うので、自動では決めません（単価を入れます）"
      : l.noRule || !l.listCode ? "定価リストにない型式です（単価を入れます）" : "");
    if (b && b.price !== null) {
      by.round.state = "used";
      (b.explain || []).forEach(function (e) { if (/^単価 ＝|^本部経由|^本部からの|^販社と直接|^運賃込み/.test(e)) by.round.result.push(e); });
      by.round.result.push("この組み合わせの単価：" + fmt(b.price));
    } else if (st.length) by.round.result.push("掛け率が決まらないので、単価は出ません（単価を入れます）");
    var f = comp.fare || {};
    if (f.rule !== null && f.rule !== undefined) { by.fare.state = "used"; (f.explain || []).forEach(function (e) { by.fare.result.push(e); }); by.fare.result.push("この組み合わせの送料：" + fmt(f.rule)); }
    else (f.warnings || []).concat(f.explain || []).forEach(function (e) { by.fare.result.push(e); });
    steps.forEach(function (s) { s.result = s.result.filter(Boolean); });
    return steps;
  }

  var API = { REASONS: REASONS, WRONG: WRONG, ONCE: ONCE, flow: flow, todo: todo, historyNew: historyNew, historyPush: historyPush, prevOf: prevOf, STATUSES: STATUSES, TAX_RATE: TAX_RATE, fmt: fmt, kake: kake, rankLabel: rankLabel, norm: norm, search: search,
    buildIndex: buildIndex, resolveCode: resolveCode, isVariant: isVariant, whyText: whyText, priceLine: priceLine, priceDateOf: priceDateOf, usedLines: usedLines,
    compute: compute, sheetRows: sheetRows, nextNumber: nextNumber, toRecord: toRecord, blank: blank, duplicate: duplicate };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.QuoteCore = API;
})(typeof window !== "undefined" ? window : this);
