// 見積・受注（quote.html）の読み書き。SharePoint のリストと SharedMasters だけを相手にする。
//   画面は QuoteStore.create(...) が返すものだけを使う。見本（QuoteStore.demo）も同じ形なので、画面は違いを知らない。
//   価格のルール（PR_〜）は読むだけ。書くのは SD_書類（見積・受注伝票）と SD_設定（会社の情報など）だけ。
(function (root) {
  "use strict";
  var GRAPH = "https://graph.microsoft.com/v1.0";
  // 価格・送料の早見と同じサイト（SharedMasters と同じ所）
  var SITE_ID = "hanaokacorp.sharepoint.com,57813f25-8b28-40ac-affa-1e7d06d56802,eb428e92-6c63-46a9-a144-f6a2283a2f23";
  var FALLBACK_DRIVE_ID = "b!JT-BVyiLrECvh59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
  var RULE_LISTS = { prices: "PR_定価", classes: "PR_得意先区分", exceptions: "PR_例外", fares: "PR_運賃", assembly: "PR_組立出荷重量", costs: "PR_原価" };
  var DOC_LIST = "SD_書類", SET_LIST = "SD_設定", HIST_KEY = "quote_history_v1";
  var DATA_COL = { name: "Data", text: { allowMultipleLines: true, textType: "plain" } };
  // 一覧で絞り込み・並べ替えに使う値だけ列にして、中身は Data 列に JSON で入れる
  var DOC_COLS = [{ name: "Kind", text: {} }, { name: "Status", text: {} }, { name: "Customer", text: {} }, { name: "CustomerCode", text: {} },
    { name: "CaseId", text: {} }, { name: "DocDate", text: {} }, { name: "Total", number: {} }, { name: "Subject", text: {} }, { name: "Owner", text: {} }, DATA_COL];
  var DOC_HEAD = "Title,Kind,Status,Customer,CustomerCode,CaseId,DocDate,Total,Subject,Owner";
  var DEFAULT_SETTINGS = { company: "花岡車輌株式会社", regNo: "", bank: "", offices: [] };

  function headOf(id, f) {
    return { spId: id, no: f.Title || "", kind: f.Kind === "受注" ? "order" : "quote", status: f.Status || "", customer: f.Customer || "",
      customerCode: f.CustomerCode || "", caseId: f.CaseId || "", date: f.DocDate || "", total: Number(f.Total) || 0, subject: f.Subject || "", owner: f.Owner || "" };
  }
  // 得意先マスタ・品目マスタ（CSV）を、画面で使う形にする
  function customersFrom(text, P) {
    return P.toObjects(text).map(P.customerFromMaster).filter(function (c) { return c.code && !/^[×✕☓]/.test(c.name) && !/^[×✕☓]/.test(c.fullName); });
  }
  function itemsFrom(text, P) {
    var rows = P.parseCSV(text), H = rows[0] || [], ix = function (n) { return H.indexOf(n); };
    // 「改廃項目」は同じ名前の列が2つ（コードと名前）あるので、後ろのほう（名前）を読む
    var I = { code: ix("品目ｺｰﾄﾞ"), name: ix("品目名"), dai: ix("大分類名"), kakaku: ix("価格表記載名名"), kaihai: H.lastIndexOf("改廃項目") };
    var out = {};
    rows.slice(1).forEach(function (r) {
      var c = r[I.code]; if (!c) return;
      var g = function (k) { return I[k] >= 0 ? (r[I[k]] || "") : ""; };
      out[c] = { name: g("name"), dai: g("dai"), kakaku: g("kakaku"), kaihai: g("kaihai") };
    });
    return out;
  }

  // ---------- 本物（SharePoint） ----------
  // opt: { getToken: async () => アクセストークン, P: PriceCore, confirm: (文) => はい/いいえ }
  function create(opt) {
    var P = opt.P, listIds = {}, driveId = null;
    async function get(url) {
      var r = await fetch(GRAPH + url, { headers: { Authorization: "Bearer " + (await opt.getToken()) } });
      if (!r.ok) throw new Error("読み込めませんでした（" + r.status + "）");
      return r.json();
    }
    async function send(method, url, body) {
      var r = await fetch(GRAPH + url, { method: method, headers: { Authorization: "Bearer " + (await opt.getToken()), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) { var t = await r.text(); throw new Error("保存できませんでした（" + r.status + "）" + t.slice(0, 160)); }
      return r.status === 204 ? {} : r.json();
    }
    async function findList(name) {
      if (listIds[name]) return listIds[name];
      var d = await get("/sites/" + SITE_ID + "/lists?$select=id,displayName&$top=300");
      (d.value || []).forEach(function (l) { listIds[l.displayName] = l.id; });
      return listIds[name] || null;
    }
    async function ensureList(name, cols, what) {
      var id = await findList(name); if (id) return id;
      if (!opt.confirm(what + "の保存先（SharePoint のリスト「" + name + "」）がまだありません。作りますか？\n（見られる人・直せる人の設定は、作ったあと SharePoint で行います）")) return null;
      var d = await send("POST", "/sites/" + SITE_ID + "/lists", { displayName: name, columns: cols, list: { template: "genericList" } });
      listIds[name] = d.id; return d.id;
    }
    async function allItems(id, select) {
      var out = [], url = "/sites/" + SITE_ID + "/lists/" + id + "/items?$expand=fields($select=" + select + ")&$top=999";
      while (url) {
        var d = await get(url);
        (d.value || []).forEach(function (v) { out.push(v); });
        url = d["@odata.nextLink"] ? d["@odata.nextLink"].replace(GRAPH, "") : null;
      }
      return out;
    }
    async function ruleRows(name) {
      var id = await findList(name); if (!id) return [];
      return (await allItems(id, "Data")).map(function (v) { try { return JSON.parse((v.fields || {}).Data || "{}"); } catch (e) { return {}; } });
    }
    async function drive() {
      if (driveId) return driveId;
      try {
        var d = await get("/sites/" + SITE_ID + "/drives?$select=id,name,webUrl&$top=100");
        var hit = (d.value || []).find(function (x) { return x.name === "SharedMasters"; }) || (d.value || []).find(function (x) { return /SharedMasters/i.test((x.name || "") + (x.webUrl || "")); });
        if (hit) { driveId = hit.id; return driveId; }
      } catch (e) { /* 下の決まった ID を使う */ }
      driveId = FALLBACK_DRIVE_ID; return driveId;
    }
    async function fileText(name) {
      var meta = await get("/drives/" + (await drive()) + "/root:/" + encodeURIComponent(name));
      var r = await fetch(meta["@microsoft.graph.downloadUrl"]);
      if (!r.ok) throw new Error(name + " を読めませんでした");
      var buf = await r.arrayBuffer(), t = new TextDecoder("utf-8").decode(buf);
      if ((t.match(/�/g) || []).length > 5) { try { t = new TextDecoder("shift_jis").decode(buf); } catch (e) { /* そのまま */ } }
      return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;
    }
    return {
      demo: false,
      // Graph をそのまま呼ぶ（AI の中継が、ワークフローのサイトのリストを読み書きするのに使う）
      call: function (method, url, body) { return method === "GET" ? get(url) : send(method, url, body); },
      // 価格のルール（読むだけ）。返す：{ prices, classes, exceptions, fares, assembly, costs }
      loadRules: async function () {
        var out = {}, keys = Object.keys(RULE_LISTS);
        var rows = await Promise.all(keys.map(function (k) { return ruleRows(RULE_LISTS[k]); }));
        keys.forEach(function (k, i) { out[k] = rows[i]; });
        return out;
      },
      loadCustomers: async function () { return customersFrom(await fileText("得意先マスタ.csv"), P); },
      loadItems: async function () { return itemsFrom(await fileText("品目マスタ.csv"), P); },
      // 前回の受注単価（受注明細は大きいので、少しずつ読んで要る所だけ残す。ファイルが変わるまでは、このブラウザに覚えておく）
      loadHistory: async function () {
        var Q = opt.Q, meta = await get("/drives/" + (await drive()) + "/root:/" + encodeURIComponent("受注明細出力.csv"));
        var stamp = String(meta.lastModifiedDateTime || "") + "|" + String(meta.size || "");
        try { var c = JSON.parse(localStorage.getItem(HIST_KEY) || "null"); if (c && c.stamp === stamp && c.data) return c.data; } catch (e) { /* 読み直す */ }
        var r = await fetch(meta["@microsoft.graph.downloadUrl"]);
        if (!r.ok) throw new Error("受注明細を読めませんでした");
        var rd = r.body.getReader(), dec = new TextDecoder("utf-8"), buf = "", I = null, h = Q.historyNew();
        var since = new Date(Date.now() - 550 * 86400000).toISOString().slice(0, 10); // 1年半より前の受注は見ない
        var cell = function (s) { return String(s || "").replace(/^"|"$/g, ""); };
        var take = function (line) {
          var c = line.split("\t");
          if (!I) { var H = c.map(cell), ix = function (n) { return H.indexOf(n); };
            I = { date: ix("受注日付"), cust: ix("得意先ｺｰﾄﾞ"), sha: ix("得意先社名ｺｰﾄﾞ"), code: ix("品目ｺｰﾄﾞ"), qty: ix("数量"), unit: ix("単価"), kind: ix("取引区分名") }; return; }
          var d = cell(c[I.date]).replace(/\//g, "-"); if (/^\d{8}$/.test(d)) d = d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6);
          if (d < since) return;
          Q.historyPush(h, { date: d, cust: cell(c[I.cust]), sha: cell(c[I.sha]), code: cell(c[I.code]), qty: cell(c[I.qty]), unit: cell(c[I.unit]), ret: /返品/.test(cell(c[I.kind])) });
        };
        for (;;) {
          var x = await rd.read(); if (x.done) break;
          buf += dec.decode(x.value, { stream: true });
          var p; while ((p = buf.indexOf("\n")) >= 0) { take(buf.slice(0, p).replace(/\r$/, "")); buf = buf.slice(p + 1); }
        }
        if (buf) take(buf);
        try { localStorage.setItem(HIST_KEY, JSON.stringify({ stamp: stamp, data: h })); } catch (e) { /* 覚えられなくても動く */ }
        return h;
      },
      // 書類の一覧（中身は読まない）
      listDocs: async function () {
        var id = await findList(DOC_LIST); if (!id) return [];
        return (await allItems(id, DOC_HEAD)).map(function (v) { return headOf(v.id, v.fields || {}); });
      },
      getDoc: async function (spId) {
        var id = await findList(DOC_LIST);
        var v = await get("/sites/" + SITE_ID + "/lists/" + id + "/items/" + spId + "?$expand=fields($select=Data)");
        var d = JSON.parse((v.fields || {}).Data || "{}"); d.spId = v.id; return d;
      },
      // 新しく作る（spId なし）か、上書きする。返す：spId
      saveDoc: async function (fields, spId) {
        var id = await ensureList(DOC_LIST, DOC_COLS, "見積・受注伝票"); if (!id) return null;
        if (spId) { await send("PATCH", "/sites/" + SITE_ID + "/lists/" + id + "/items/" + spId + "/fields", fields); return spId; }
        var d = await send("POST", "/sites/" + SITE_ID + "/lists/" + id + "/items", { fields: fields });
        return d.id;
      },
      getSettings: async function () {
        var id = await findList(SET_LIST); if (!id) return Object.assign({}, DEFAULT_SETTINGS);
        var rows = await allItems(id, "Title,Data"), hit = rows.find(function (v) { return (v.fields || {}).Title === "会社"; });
        var s = {}; try { s = hit ? JSON.parse(hit.fields.Data || "{}") : {}; } catch (e) { /* 初期値 */ }
        var out = Object.assign({}, DEFAULT_SETTINGS, s); out._spId = hit ? hit.id : null; return out;
      },
      saveSettings: async function (s) {
        var id = await ensureList(SET_LIST, [DATA_COL], "会社の情報"); if (!id) return false;
        var body = Object.assign({}, s), sp = body._spId; delete body._spId;
        var fields = { Title: "会社", Data: JSON.stringify(body) };
        if (sp) await send("PATCH", "/sites/" + SITE_ID + "/lists/" + id + "/items/" + sp + "/fields", fields);
        else s._spId = (await send("POST", "/sites/" + SITE_ID + "/lists/" + id + "/items", { fields: fields })).id;
        return true;
      }
    };
  }

  // ---------- 見本（架空のデータ。サインインなしで画面を確かめる用） ----------
  // d: quote_demo.js の中身。書類はこのブラウザの中にだけ残す
  function demo(d) {
    var KEY = "quote_demo_docs_v1";
    var read = function () { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } };
    var write = function (a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* 残せなくても動く */ } };
    var settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
    return {
      demo: true,
      loadRules: async function () { return d.rules; },
      loadCustomers: async function () { return d.customers; },
      loadItems: async function () { return d.items; },
      loadHistory: async function () { return d.history || null; },
      listDocs: async function () { return read().map(function (x) { return headOf(x.spId, x.fields); }); },
      getDoc: async function (spId) {
        var x = read().find(function (y) { return y.spId === spId; });
        var doc = JSON.parse(x.fields.Data); doc.spId = spId; return doc;
      },
      saveDoc: async function (fields, spId) {
        var a = read();
        if (spId) { var x = a.find(function (y) { return y.spId === spId; }); if (x) x.fields = fields; }
        else { spId = "d" + Date.now(); a.push({ spId: spId, fields: fields }); }
        write(a); return spId;
      },
      getSettings: async function () { return Object.assign({}, settings); },
      saveSettings: async function (s) { settings = Object.assign({}, s); return true; }
    };
  }

  var API = { create: create, demo: demo, customersFrom: customersFrom, itemsFrom: itemsFrom, DEFAULT_SETTINGS: DEFAULT_SETTINGS };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.QuoteStore = API;
})(typeof window !== "undefined" ? window : this);
