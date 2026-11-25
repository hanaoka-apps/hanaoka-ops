/* 販売価格体系表の「最安」を出す共通の部品（原価エディタ・付加価値ダッシュボードで使う）
   最安 ＝ 社名ごとの在庫価格のうちいちばん安いもの。在庫価格がなければ A'（5掛）ランクの価格。
   計算は「価格・送料の早見」と同じ（price_core.js の unitPrice）。体系表のルールは SharePoint のリスト（PR_定価・PR_得意先区分・PR_例外）。
   読むだけで、書き込みはしない。価格・掛率はこのファイルに書かない。
   ブラウザでは window.TaikeiMin。 */
(function (root) {
  "use strict";

  // 品目コード（SMILE）と体系表の型式の書き方が違うもの（「×10」「ハイフン」の違いだけのもの）。
  // 体系表に対応する型式が見つからないものは入れない（UDL15/SW・UDL25/SW・UDA50/SW・UDA35W/SW・UDA80/SW・UDLV15/SW・UDLV50/SW・HDLC/R・EEPトレ・BCC-ANA）
  var ALIAS = {
    "UXALSC": "UXA-LSC", "UDL15": "UDL150", "UDL25": "UDL250", "UDA50": "UDA500", "UDA80": "UDA800", "UDA35W": "UDA350W",
    "UDLV15": "UDLV150", "UDLV25": "UDLV250", "UDLV50": "UDLV500",
  };
  // 最安が「在庫価格」「A'」ではない機種（台数別の最安）。体系表のリストに台数別の掛率が入っていないので自動では出さない（エディタで手入力）。
  var MANUAL = {
    "FCART2x4": "200台ロットの金額が最安", "FCART2x4BK": "200台ロットの金額が最安",
  };
  var LISTS = { prices: "PR_定価", classes: "PR_得意先区分", exceptions: "PR_例外" };

  // getJson(パス)：Graph の GET を行い JSON を返す関数（エディタは graphGet、ダッシュボードは spGraphGet）
  async function load(getJson, siteId) {
    var d = await getJson("/sites/" + siteId + "/lists?$select=id,displayName&$top=200");
    var lists = d.value || [];
    var out = { prices: [], classes: [], exceptions: [], fares: [], costs: [], assembly: [] };
    for (var k of Object.keys(LISTS)) {
      var hit = lists.find(function (l) { return l.displayName === LISTS[k]; });
      if (!hit) throw new Error("SharePointのリスト「" + LISTS[k] + "」が見つかりません");
      var url = "/sites/" + siteId + "/lists/" + hit.id + "/items?$expand=fields($select=Data)&$top=999";
      while (url) {
        var r = await getJson(url);
        (r.value || []).forEach(function (v) { try { out[k].push(JSON.parse((v.fields || {}).Data || "{}")); } catch (e) {} });
        url = r["@odata.nextLink"] ? r["@odata.nextLink"].replace("https://graph.microsoft.com/v1.0", "") : null;
      }
    }
    return out;
  }

  // 在庫価格を持つ社名（その日に有効な在庫口の掛率がある社名）
  function stockShas(data, date) {
    var PC = root.PriceCore, d = String(date || "").slice(0, 10), seen = new Map();
    (data.classes || []).forEach(function (c) {
      if (c.対象の種類 !== "社名" || !c.対象コード || PC.num(c.在庫口の掛率) === null) return;
      if (String(c.適用開始日 || "").slice(0, 10) > d || (c.適用終了日 && String(c.適用終了日).slice(0, 10) < d)) return;
      if (!seen.has(c.対象コード)) seen.set(c.対象コード, c.対象名 || c.対象コード);
    });
    return Array.from(seen).map(function (e) { return { shaCode: e[0], name: e[1] }; });
  }
  // 社名ごとの「在庫品の型式」：例外リストの「在庫口のみ」の行にある型式
  function stockSet(data) {
    var PC = root.PriceCore, m = new Map();
    (data.exceptions || []).forEach(function (d) {
      if (d.対象の種類 !== "社名" || !d.対象コード || d.在庫口のみ !== true || !d.型式) return;
      if (!m.has(d.対象コード)) m.set(d.対象コード, new Set());
      m.get(d.対象コード).add(PC.asmKey(d.型式));
    });
    return m;
  }

  // 戻り値：{ price, src:"在庫"|"A'", who, code(体系表の型式) } ／ 手入力の機種・体系表に型式がない・定価が0のときは null
  // 在庫価格は、その社名の「在庫品」に型式が載っているときだけ使う（載っていない社名・型式には出さない）。
  function minPrice(data, code, date) {
    var PC = root.PriceCore;
    if (!data || !PC || MANUAL[code]) return null;
    var tc = ALIAS[code] || code;
    if (!PC.listPriceRow(data.prices, tc, date)) return null;
    var cache = data._tm || (data._tm = {});
    var shas = cache["s" + date] || (cache["s" + date] = stockShas(data, date));
    var stock = cache.stock || (cache.stock = stockSet(data));
    var key = PC.asmKey(tc), best = null;
    shas.forEach(function (x) {
      var set = stock.get(x.shaCode);
      if (!set || !set.has(key)) return;
      var r = PC.unitPrice(data, { code: tc, qty: 1, date: date, customer: { code: "", shaCode: x.shaCode, shaName: x.name, name: x.name, kakeName: "" }, forceStock: true });
      if (r.price != null && r.price > 0 && (best === null || r.price < best.price)) best = { price: r.price, who: x.name };
    });
    if (best) return { price: best.price, src: "在庫", who: best.who, code: tc };
    var a = PC.unitPrice(data, { code: tc, qty: 1, date: date, customer: { code: "", shaCode: "", shaName: "", name: "", kakeName: "5掛(A')" } });
    if (a.price != null && a.price > 0) return { price: a.price, src: "A'", who: "A'ランク", code: tc };
    return null;
  }

  root.TaikeiMin = { ALIAS: ALIAS, MANUAL: MANUAL, load: load, minPrice: minPrice };
})(typeof window !== "undefined" ? window : globalThis);
