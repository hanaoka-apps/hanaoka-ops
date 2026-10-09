/* ============================================================
   請求・入金・違算（ar_billing.html）の計算部分
   ------------------------------------------------------------
   画面から切り離してあるのは、Node で実データを使って確かめるため
   （tests/test_ar_billing_core.cjs）。ブラウザでは window.ARCore、Node では module.exports。

   使うデータ（どれも SMILE から出して SharePoint「SharedMasters」に置く）
     請求明細出力.txt … 売上の明細。「請求書番号」が締め回（と都度発行）ごとの連番。0 は未請求
     入金明細出力.csv … 登録済みの入金伝票。振込・手形・相殺のほか、売上割引料・支払手数料・
                        販売促進費（取引区分属性「調整」＝請求一覧表の値引調整額）も入金として数える
     得意先マスタ.csv … 担当者・回収条件（入金ｻｲｸﾙ名１・入金日１）・回収管理区分
     担当者マスタ.csv … 担当者の部門（違算 Excel のシート分け：本社/大阪/名古屋/ｿﾘｭｰｼｮﾝ/工場）

   請求額の考え方
     請求書1枚 ＝ 請求先ｺｰﾄﾞ × 請求書番号。請求額 ＝ 税抜の行の合計 ＋ 消費税の行。
     消費税は請求書ごとにまとめて1行（課税区分名「消費税」・品目名「消費税等(課税対象額…)」）で、
     その行の日付が締日。消費税の行がない請求書（非課税など）は、最後の伝票日付を締日とみなす。
     2026-10 に 9/15・9/20・9/25・9/30 締の請求一覧表と 1 円単位で一致することを確認した。

   違算の考え方（違算 Excel と同じ答えになるようにした）
     回収予定日（土日祝なら翌営業日）ごとに「回」を作り、前後の回収予定日との中間までに入った入金を
     その回の請求に充てる。回収予定日を過ぎても請求額と入金額が合わなければ違算。
       請求額 − 入金額 ＞ 0 … 未入金　　＜ 0 … 過入金
     中間までに遅れて入った入金は、その回の入金として自動で解消する。それより遅い入金は次の回で
     過入金に見えるが、足し続けた「累計」が 0 に戻れば解消（Excel の「前月違算解消分」）。
     今の違算 ＝ 判定済みの最後の回の累計。
     データの最初の日より前の売上を含む請求書は、請求額がわからないので違算の判定に使わない。
   ============================================================ */
(function (root) {
  "use strict";

  // ---------- CSV ----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], field = "", i = 0, inQ = false; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQ) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; } field += c; i++; continue; }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ',') { row.push(field); field = ""; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  // 1行目を見出しにして {列名: 値} の配列にする
  function toObjects(text) {
    const rows = parseCSV(text); const h = rows[0] || []; const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (r.length < 2) continue;
      const o = {}; for (let j = 0; j < h.length; j++) o[h[j]] = r[j] == null ? "" : r[j];
      out.push(o);
    }
    return out;
  }

  // ---------- 日付（"YYYY-MM-DD" の文字列で持つ。Date はタイムゾーンでずれるので計算の中だけ） ----------
  function ymd(y, m, d) { return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }
  function fromSmile(s) { s = String(s || ""); return s.length === 8 ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : ""; }
  function parts(s) { return [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)]; }
  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  // n か月ずらして day 日に（day が 30 以上か 0 なら月末）
  function addMonths(s, n, day) {
    let [y, m] = parts(s); m += n;
    while (m > 12) { y++; m -= 12; } while (m < 1) { y--; m += 12; }
    const ld = lastDay(y, m);
    return ymd(y, m, (day >= 30 || day === 0) ? ld : Math.min(day, ld));
  }
  function addDays(s, n) { const [y, m, d] = parts(s); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  function weekday(s) { const [y, m, d] = parts(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function daysBetween(a, b) { const [y1, m1, d1] = parts(a), [y2, m2, d2] = parts(b); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000); }

  // 銀行の休業日（土日・祝日・年末年始）。祝日は内閣府の一覧から。年が変わったら足す
  const HOLIDAYS = new Set([
    "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
    "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22",
    "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31",
    "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-22", "2027-04-29",
    "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11",
    "2027-11-03", "2027-11-23", "2027-12-31"
  ]);
  function nextBusinessDay(s) { while (weekday(s) === 0 || weekday(s) === 6 || HOLIDAYS.has(s)) s = addDays(s, 1); return s; }

  // ---------- 回収条件 ----------
  // 入金ｻｲｸﾙ名１：当月／翌月／2ヶ月後…。空欄は回収条件なし（海外・現金など）
  function cycleMonths(name) {
    name = String(name || "").normalize("NFKC");
    if (name === "当月") return 0;
    if (name === "翌月") return 1;
    const m = name.match(/^(\d+)ヶ?か?月後$/); return m ? +m[1] : null;
  }
  // 「支払条件追記」（得意先マスタの自由記述）から、回収予定日がずれる条件を読み取る。
  //   例）30万以上150日後振込 ／ 税別30万以上…120日後振込 ／ 50万以上翌月15日起算90日後振込み
  //       11万以上150日後振込→26.03より11万位以上でんさい60日（→ のあとは 2026-03 から別の条件）
  //   基準額以上の請求は、いつもの回収予定日の N 日後に振り込まれる（轟産業で確認：6/30 分が 12/1 着）。
  //   でんさい（旧手形）と「期日指定」は読まない：いつもの回収予定日に受け取り、その日付で入金登録される
  //   （決済予定日が先になるだけ）ので期限はずれない（トヨタL&F福岡・三甲で確認）
  function parseTermsNote(text) {
    const segs = String(text || "").normalize("NFKC").replace(/\s+/g, "").split("→");
    const froms = segs.map(seg => { const f = seg.match(/(?:20)?(\d{2})[.\/年](\d{1,2})月?(?:支払分)?より/); return f ? "20" + f[1] + "-" + f[2].padStart(2, "0") : ""; });
    const rules = [];
    segs.forEach((seg, i) => {
      if (/期日指定/.test(seg)) return;
      const r = seg.match(/(税別|税抜|税込)?([\d.]+)万円?位?以上.*?(\d+)日後(?:現金)?(?:振込|振り込み)/);
      if (!r) return;
      rules.push({ threshold: Math.round(parseFloat(r[2]) * 10000), taxEx: /税別|税抜/.test(r[1] || ""), days: +r[3],
        from: froms[i], until: froms[i + 1] || "" });
    });
    return rules;
  }
  function ruleLabel(r) {
    return (r.taxEx ? "税抜" : "") + (r.threshold / 10000).toLocaleString("ja-JP") + "万円以上は回収予定日の" + r.days + "日後"
      + (r.from ? "（" + r.from.replace("-", "/") + "〜）" : "") + (r.until ? "（〜" + r.until.replace("-", "/") + "）" : "");
  }
  // SMILE の「手形」は廃止。でんさいに読み替えて表示する
  function denLabel(s) { return String(s || "").replace(/手形/g, "でんさい"); }

  function dayLabel(d) { d = +d || 0; return d >= 30 ? "末" : (d ? d + "日" : ""); }

  // 担当者の部門 → 拠点（違算 Excel のシート名に合わせる）
  function baseOf(staff) {
    if (!staff) return "その他";
    if (/工場/.test(staff["部門名"] || "")) return "工場";
    const s = (staff["売上部門別名"] || "").normalize("NFKC");
    if (s === "本社") return "本社";
    if (s === "大阪") return "大阪";
    if (s === "名古屋") return "名古屋";
    if (/ソリューション/.test(s)) return "ソリューション";
    return "その他";
  }
  const BASES = ["本社", "大阪", "名古屋", "ソリューション", "工場", "その他"];

  // EC・店頭販売（得意先社名ｺｰﾄﾞ 店頭販売 005992 / EC直販 005998）。Shopify・PayPal などでまとめて入るので、
  // 1件ずつの消込・違算の対象にはしない
  const EC_COMPANY = new Set(["005992", "005998"]);

  function num(v) { const n = Number(String(v == null ? "" : v).replace(/,/g, "")); return isFinite(n) ? n : 0; }

  // ============================================================
  // build：4つのファイルから、請求先ごとの請求書・入金・違算を組み立てる
  //   asof … 判定日（"YYYY-MM-DD"）。省略時は「今日」と「入金明細の最後の日」の早いほう
  //   （総務がまだ登録していない入金を未入金と見誤らないため）
  // ============================================================
  function build(src, opt) {
    opt = opt || {};
    const detail = src.detail || [], pays = src.payments || [], custRows = src.customers || [], staffRows = src.staff || [];

    const cust = {}; custRows.forEach(r => { cust[r["得意先ｺｰﾄﾞ"]] = r; });
    const staff = {}; staffRows.forEach(r => { staff[r["担当者ｺｰﾄﾞ"]] = r; });

    // データの期間
    let dataStart = "9999-99-99", dataEnd = "";
    detail.forEach(r => { const d = fromSmile(r["伝票日付"]); if (!d) return; if (d < dataStart) dataStart = d; if (d > dataEnd) dataEnd = d; });
    let payStart = "9999-99-99", payEnd = "";
    pays.forEach(r => { const d = fromSmile(r["伝票日付"]); if (!d) return; if (d < payStart) payStart = d; if (d > payEnd) payEnd = d; });
    const today = opt.today || new Date().toISOString().slice(0, 10);
    const asof = opt.asof || (payEnd && payEnd < today ? payEnd : today);
    // 入金明細がない期間の請求は判定できない（入金を見ていないのに未入金と出てしまう）
    const judgeFrom = payStart === "9999-99-99" ? asof : payStart;

    const C = {};   // 請求先ｺｰﾄﾞ → 請求先
    function getC(code, nameHint) {
      if (C[code]) return C[code];
      const m = cust[code] || {};
      const st = staff[m["担当者ｺｰﾄﾞ"]];
      const cyc = cycleMonths(m["入金ｻｲｸﾙ名１"]);
      const payDay = num(m["入金日１"]);
      const closeDay = num(m["締日１"]);
      const o = C[code] = {
        code, name: m["得意先名１"] || nameHint || code, name2: m["得意先名２"] || "", short: m["得意先略称"] || "",
        kana: m["得意先ﾌﾘｶﾞﾅ"] || m["得意先名ｶﾅ"] || "",
        zip: m["郵便番号"] || "", addr1: m["住所１"] || "", addr2: m["住所２"] || "", addr3: m["住所３"] || "",
        staffCode: m["担当者ｺｰﾄﾞ"] || "", staffName: (m["担当者名"] || "").trim(), base: baseOf(st),
        closeDay, closeLabel: closeDay >= 30 ? "末締" : (closeDay ? closeDay + "日締" : ""),
        cycle: cyc, payDay,
        termsLabel: cyc == null ? "" : (["当月", "翌月"][cyc] || cyc + "ヶ月後") + dayLabel(payDay),
        payMethod: denLabel(m["入金条件名１"] || ""),
        termsNote: (m["支払条件追記"] || "").trim(),
        termRules: parseTermsNote(m["支払条件追記"]),
        noCollect: (m["回収管理区分名"] || "") === "行わない",
        specialOnly: null,
        ec: EC_COMPANY.has(m["得意先社名ｺｰﾄﾞ"] || ""),
        inMaster: !!cust[code],
        invoices: {}, unbilled: [], payments: [], periods: [], children: {}, specials: []
      };
      return o;
    }

    // ---- 特別請求（SMILE の締めとは別に作った請求書。総務が登録） ----
    //   { id, cust:請求先ｺｰﾄﾞ, no:請求書番号（手書きの番号など）, issue:請求日, due:回収予定日, net, tax, memo, status, lines:[{key,…}] }
    //   選んだ伝票は SMILE の請求書から外す。SMILE がその伝票ぶんの消費税も請求書の消費税の行に入れているので、
    //   特別請求の消費税をその請求書から差し引く
    const specials = (src.specials || []).filter(sp => sp && sp.status !== "取消" && sp.cust);
    // 特別請求だけで判定する得意先（分割請求・前金などで、SMILE の請求書と特別請求書が1対1にならない得意先）
    //   { cust, from:"YYYY-MM-DD" }。from 以降に締めた SMILE の請求書は違算の判定に使わず、特別請求書の金額と回収予定日で判定する
    const specialOnly = {};
    (src.settings || []).forEach(x => { if (x && x.cust && x.mode === "特別請求のみ" && x.status !== "取消") specialOnly[x.cust] = x; });
    const taken = {};
    specials.forEach(sp => { sp.found = []; sp.smileNos = {}; (sp.lines || []).forEach(l => { if (l && l.key) taken[l.key] = sp; }); });

    // ---- 請求明細 → 請求書 ----
    detail.forEach(r => {
      const code = r["請求先ｺｰﾄﾞ"]; if (!code) return;
      const c = getC(code, r["得意先名称１"]);
      const line = {
        date: fromSmile(r["伝票日付"]), slip: r["伝票№"], row: r["行"], cust: r["得意先ｺｰﾄﾞ"], custName: r["得意先略称"],
        dest: r["納品先名称"], kind: r["取引区分名"], item: r["品目ｺｰﾄﾞ"], itemName: r["品目名"], qty: num(r["売上数量"]), unit: r["単位"],
        price: num(r["売上単価"]), net: num(r["税抜売上金額"]), tax: num(r["消費税等"]), taxKind: r["課税区分名"],
        drawing: r["図番"], model: r["型番"], po: r["客先注番"], seiban: r["製番"], memo1: r["摘要１"], memo2: r["摘要２"]
      };
      line.key = lineKey(line);
      if (line.cust && line.cust !== code) c.children[line.cust] = line.custName;
      const no = String(r["請求書番号"] || "0").trim();
      // 特別請求に選んだ伝票は、SMILE の請求書から外して特別請求のほうへ
      const sp = taken[line.key];
      if (sp) { sp.found.push(line); if (no !== "0" && no !== "") sp.smileNos[no] = (sp.smileNos[no] || 0) + line.net; return; }
      if (no === "0" || no === "") { c.unbilled.push(line); return; }
      const inv = c.invoices[no] || (c.invoices[no] = { no, lines: [], net: 0, tax: 0, taxDate: "", firstDate: "9999-99-99", lastDate: "" });
      inv.lines.push(line); inv.net += line.net; inv.tax += line.tax;
      if (line.taxKind === "消費税" && line.tax) inv.taxDate = line.date;
      if (line.date < inv.firstDate) inv.firstDate = line.date;
      if (line.date > inv.lastDate) inv.lastDate = line.date;
    });

    // ---- 入金明細 ----
    pays.forEach(r => {
      const code = r["得意先ｺｰﾄﾞ"]; if (!code) return;
      const c = getC(code, r["得意先名１"]);
      c.payments.push({
        date: fromSmile(r["伝票日付"]), slip: r["伝票№"], row: r["行"], kind: denLabel((r["取引区分名"] || "").replace(/\s|　/g, "")),
        attr: r["取引区分属性名"] || "", amount: num(r["入金額"]), due: fromSmile(r["決済予定日"]), memo: r["備考"] || ""
      });
    });

    Object.keys(specialOnly).forEach(code => { getC(code).specialOnly = specialOnly[code]; });
    specials.forEach(sp => {
      const c = getC(sp.cust, sp.custName);
      const net = num(sp.net), tax = num(sp.tax);
      // SMILE の請求書から、この特別請求の消費税を差し引く（伝票が複数の請求書にまたがるときは税抜の割合で分ける）
      const nos = Object.keys(sp.smileNos), totalNet = nos.reduce((s, n) => s + sp.smileNos[n], 0);
      let left = tax;
      nos.forEach((n, i) => {
        const t = i === nos.length - 1 ? left : Math.round(tax * (totalNet ? sp.smileNos[n] / totalNet : 0)); left -= t;
        const inv = c.invoices[n]; if (!inv) return;
        inv.tax -= t; inv.specialOut = (inv.specialOut || 0) + sp.smileNos[n] + t;
      });
      const lines = sp.found.length ? sp.found : (sp.lines || []);   // 明細の期間外なら保存しておいた中身を出す
      const dates = lines.map(l => l.date).filter(Boolean).sort();
      c.invoices["S" + sp.id] = { no: "S" + sp.id, label: "特別 " + (sp.no || sp.id), special: sp, lines, net, tax,
        taxDate: sp.issue, firstDate: dates[0] || sp.issue, lastDate: dates[dates.length - 1] || sp.issue, missing: !sp.found.length && (sp.lines || []).length > 0 };
      c.specials.push(sp);
    });

    // ---- 請求先ごとに、回収予定日の回（period）を作って違算を判定 ----
    Object.values(C).forEach(c => {
      c.payments.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      c.unbilled.sort((a, b) => a.date < b.date ? -1 : 1);
      const invs = Object.values(c.invoices);
      invs.forEach(inv => {
        inv.amount = inv.net + inv.tax;
        inv.close = inv.taxDate || inv.lastDate;
        if (inv.special) {   // 特別請求：請求日と回収予定日は登録した値
          inv.close = inv.special.issue; inv.baseDue = inv.due = inv.special.due || "";
          inv.bound = inv.due ? nextBusinessDay(inv.due) : ""; inv.partial = false;
          return;
        }
        inv.label = "No." + inv.no;
        const so = specialOnly[c.code];
        if (so && (!so.from || inv.close >= so.from)) inv.excluded = "特別請求で請求している得意先";
        inv.baseDue = c.cycle == null ? "" : addMonths(inv.close, c.cycle, c.payDay);
        inv.due = inv.baseDue;
        // 追記の条件（基準額以上は N 日後振込）
        const ym = inv.baseDue.slice(0, 7);
        const rule = inv.baseDue && c.termRules.find(r => (!r.from || ym >= r.from) && (!r.until || ym < r.until)
          && (r.taxEx ? inv.net : inv.net + inv.tax) >= r.threshold);
        if (rule) { inv.due = addDays(inv.baseDue, rule.days); inv.rule = ruleLabel(rule); }
        inv.bound = inv.due ? nextBusinessDay(inv.due) : "";
        // 前の締め（1か月前の同じ日。月末なら月末）より後の売上だけで、データの最初の日以降に収まっているか
        const d = parts(inv.close)[2];
        const prevClose = addMonths(inv.close, -1, d >= lastDay(...parts(inv.close).slice(0, 2)) ? 30 : d);
        inv.partial = prevClose < addDays(dataStart, -1);
      });
      invs.sort((a, b) => (a.close + a.no) < (b.close + b.no) ? -1 : 1);
      c.invoiceList = invs;

      let reason = "";
      if (c.noCollect) reason = "回収管理しない得意先";
      else if (c.ec) reason = "EC・店頭販売（まとめて入金）";
      else if (c.cycle == null) reason = "回収条件の登録なし";
      c.excludeReason = reason;

      // 回ごとにまとめる（回収予定日が同じ請求書は1つの回）
      const groups = {};
      invs.forEach(inv => {
        if (!inv.bound || inv.amount === 0 || inv.excluded) return;
        (groups[inv.bound] = groups[inv.bound] || []).push(inv);
      });
      // 入金を充てる範囲：前の回収予定日との中間の翌日 〜 次の回収予定日との中間まで。
      //   期限ちょうどで区切ると、連休明けなどで数日遅れただけの入金（山善の 5/10 分が 5/15 着など）が
      //   次の回に入り「未入金→翌月過入金」に見えるため。
      //   最初の回は期限の 60 日前から（入金後出荷の前払いを拾う）。その範囲が入金データの最初の 45 日に
      //   かかるときは、データより前の請求の分の入金が混じるので、その回は判定しない。
      //   最後の回はそれ以降の入金すべて（次の請求がない得意先の遅れた入金が、どの回にも入らず消えないように）
      const bounds = Object.keys(groups).sort();
      const ruleDays = c.termRules.length ? 45 + Math.max(...c.termRules.map(r => r.days)) : 0;
      const mid = (a, b) => addDays(a, Math.floor(daysBetween(a, b) / 2));
      let cum = 0, started = false;
      const periods = [];
      bounds.forEach((b, i) => {
        const g = groups[b];
        const amt = g.reduce((s, x) => s + x.amount, 0);
        const firstDue = g.map(x => x.due).sort()[0];
        const lo = i ? mid(bounds[i - 1], b) : addDays(b, -60);
        const hi = i < bounds.length - 1 ? mid(b, bounds[i + 1]) : "9999-12-31";
        const ps = c.payments.filter(p => p.date > lo && p.date <= hi);
        const paid = ps.reduce((s, p) => s + p.amount, 0);
        const partial = g.some(x => x.partial);
        // 追記の条件（N 日後振込）がある得意先は、データより前の請求が N 日遅れで入ってくるので、その分あとから判定する
        const usable = !reason && !partial && lo >= (i ? addDays(judgeFrom, -1) : addDays(judgeFrom, 45)) && b >= addDays(judgeFrom, ruleDays);
        const judged = usable && asof >= b;
        const p = { bound: b, due: firstDue, from: lo, to: hi, invoices: g, amount: amt, paid, diff: amt - paid, payments: ps, partial, judged, usable };
        if (judged) { cum += p.diff; started = true; }
        p.cum = started ? cum : null;
        periods.push(p);
      });
      // まだ回収予定日が来ていない回のあとに入った入金（前払い・早めの入金）
      c.periods = periods;
      const J = periods.filter(p => p.judged);
      c.diff = J.length ? J[J.length - 1].cum : 0;
      // 今の違算の内訳：累計が最後に 0 だった回より後で、差が出ている回
      let lastZero = -1; J.forEach((p, i) => { if (p.cum === 0) lastZero = i; });
      c.openPeriods = J.slice(lastZero + 1).filter(p => p.diff !== 0);
      c.oldestDue = c.openPeriods.length ? c.openPeriods[0].due : "";
      c.daysOver = c.oldestDue ? daysBetween(c.oldestDue, asof) : 0;
      c.status = c.diff > 0 ? "未入金" : c.diff < 0 ? "過入金" : "";
      // 解消済み：累計が 0 に戻る前に差が出ていた回（直近 3 か月）
      c.resolved = [];
      let run = [];
      J.forEach(p => { if (p.diff !== 0) run.push(p); if (p.cum === 0 && run.length) { c.resolved.push({ periods: run, at: p.bound }); run = []; } });
      // 次の回（回収予定日がまだ来ていない最初の回）
      c.next = periods.find(p => !p.judged && p.bound >= asof) || null;
      c.unbilledAmount = c.unbilled.reduce((s, l) => s + l.net + l.tax, 0);
      c.billedTotal = invs.reduce((s, x) => s + x.amount, 0);
      c.paidTotal = c.payments.reduce((s, p) => s + p.amount, 0);
    });

    return { customers: C, list: Object.values(C), dataStart, dataEnd, payStart, payEnd, asof, today, judgeFrom };
  }

  // ============================================================
  // 会計と販売の売掛残高の照合（月次決算の確認）
  //   会計：SMILE 会計の「内訳残高一覧表」（科目 124 売掛金。内訳コード＝販売の得意先コードの上4桁）
  //   販売：SMILE 販売の「売掛残高一覧表」（得意先ごと。上4桁でまとめて会計と比べる）
  //   どちらも Excel を行の配列（[[セル,…],…]）にして渡す
  // ============================================================
  function yen0(v) { if (v == null || v === "") return 0; const n = Number(String(v).replace(/[*,\s]/g, "")); return isFinite(n) ? Math.round(n) : 0; }
  function periodOf(rows) {
    // 「令和 8年 4月 1日 ～ 令和 8年 9月30日」「2026年 4月 1日～2026年 9月30日」
    for (const r of rows.slice(0, 6)) {
      const t = String((r || []).join(" ")).normalize("NFKC");
      let m = t.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*[～~]\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
      if (m) return { from: ymd(+m[1], +m[2], +m[3]), to: ymd(+m[4], +m[5], +m[6]) };
      m = t.match(/令和\s*(\d+)年\s*(\d{1,2})月\s*(\d{1,2})日\s*[～~]\s*令和\s*(\d+)年\s*(\d{1,2})月\s*(\d{1,2})日/);
      if (m) return { from: ymd(2018 + +m[1], +m[2], +m[3]), to: ymd(2018 + +m[4], +m[5], +m[6]) };
    }
    return { from: "", to: "" };
  }
  function parseKaikei(rows) {
    const out = {};
    rows.forEach(r => {
      if (!r || String(r[0]).trim() !== "124" || r[2] == null || r[2] === "") return;   // 科目計の行（内訳コードなし）は除く
      const code = String(parseInt(r[2], 10));
      out[code] = { code, name: r[3] || "", pre: yen0(r[4]), dr: yen0(r[5]), cr: yen0(r[6]), bal: yen0(r[7]) };
    });
    return { period: periodOf(rows), byCode: out };
  }
  function parseHanbai(rows) {
    const out = {};
    rows.forEach(r => {
      if (!r) return;
      const c = String(r[0] == null ? "" : r[0]).replace(/\D/g, "");
      if (c.length !== 6) return;
      const k = String(parseInt(c.slice(0, 4), 10));
      const g = out[k] || (out[k] = { code: k, pre: 0, pay: 0, sales: 0, bal: 0, custs: [] });
      const row = { cust: c, name: r[1] || "", pre: yen0(r[2]), pay: yen0(r[3]), sales: yen0(r[7]), bal: yen0(r[8]) };
      g.pre += row.pre; g.pay += row.pay; g.sales += row.sales; g.bal += row.bal; g.custs.push(row);
    });
    return { period: periodOf(rows), byCode: out };
  }
  // ctx: { payments:[入金明細の行], customers:[得意先マスタの行] } … 手がかりを探すのに使う（なくてもよい）
  function reconcile(kaikeiRows, hanbaiRows, ctx) {
    ctx = ctx || {};
    const K = parseKaikei(kaikeiRows), H = parseHanbai(hanbaiRows);
    const from = K.period.from || H.period.from;
    const sum = (o, f) => Object.values(o).reduce((s, x) => s + x[f], 0);
    const tot = { kPre: sum(K.byCode, "pre"), kBal: sum(K.byCode, "bal"), hPre: sum(H.byCode, "pre"), hBal: sum(H.byCode, "bal") };
    tot.diff = tot.kBal - tot.hBal; tot.preDiff = tot.kPre - tot.hPre;
    const codes = [...new Set(Object.keys(K.byCode).concat(Object.keys(H.byCode)))].sort((a, b) => a - b);
    const items = [];
    codes.forEach(code => {
      const k = K.byCode[code] || { code, name: "", pre: 0, dr: 0, cr: 0, bal: 0, missing: true };
      const h = H.byCode[code] || { code, pre: 0, pay: 0, sales: 0, bal: 0, custs: [], missing: true };
      const d = { pre: k.pre - h.pre, sales: k.dr - h.sales, pay: k.cr - h.pay, bal: k.bal - h.bal };
      if (!d.pre && !d.sales && !d.pay && !d.bal) return;
      items.push({ code, name: k.name || (h.custs[0] && h.custs[0].name) || "", k, h, d, kMissing: !!k.missing, hMissing: !!h.missing, kinds: [], hints: [] });
    });
    // 種類分け
    //   コード0（内訳なし）は、税理士が入れる消費税などの調整で、販売には対応する取引がない。照合の判定からは外して別に出す
    items.forEach(it => {
      if (it.code === "0") { it.kinds.push("会計だけの調整（内訳なし・判定から除く）"); it.excluded = true; }
      if (it.d.pre) it.kinds.push("期首残高のずれ");
      const flow = it.d.sales - it.d.pay;   // 期間中の動きで残高に効く分
      if (flow) it.kinds.push(it.kMissing ? "会計に補助科目がない" : it.hMissing ? "販売に得意先がない" : "期間中の売上・入金の差");
      if (!it.d.bal && it.d.sales && it.d.sales === it.d.pay) it.kinds.push("両建て（残高に影響なし）");
      it.affects = !!it.d.bal;
    });
    // 付け違いの組：残高の差がちょうど反対の2つ
    const aff = items.filter(i => i.d.bal && i.code !== "0");
    aff.forEach(a => {
      const b = aff.find(x => x !== a && x.d.bal === -a.d.bal && !x.pair);
      if (b && !a.pair) { a.pair = b.code; b.pair = a.code; a.kinds.push("付け違いの可能性"); b.kinds.push("付け違いの可能性"); }
    });
    // 手がかり1：前の期の日付で、期の初日以降に入力された入金伝票（期首残高が動く）
    if (from && ctx.payments) {
      const late = {};
      ctx.payments.forEach(p => {
        const dd = fromSmile(p["伝票日付"]), op = fromSmile(p["操作日付"]);
        if (dd && op && dd < from && op >= from) {
          const k = String(parseInt(String(p["得意先ｺｰﾄﾞ"] || "").slice(0, 4), 10));
          (late[k] = late[k] || []).push(`${p["得意先ｺｰﾄﾞ"]} 伝票日付 ${dd}・入力 ${op}・${(p["取引区分名"] || "").replace(/\s|　/g, "")} ${num(p["入金額"]).toLocaleString("ja-JP")}円 伝票№${p["伝票№"]}${p["備考"] ? "（" + p["備考"] + "）" : ""}`);
        }
      });
      items.forEach(it => { if (it.d.pre && late[it.code]) it.hints.push("前の期の日付で、期が始まってから入力された入金伝票：" + late[it.code].join("／")); });
    }
    // 手がかり2：得意先マスタの社名コードが、得意先コードの上4桁と違う（会計の補助がその社名コードに入る）
    const odd = [];
    (ctx.customers || []).forEach(m => {
      const c = m["得意先ｺｰﾄﾞ"] || "", s = m["得意先社名ｺｰﾄﾞ"] || "";
      if (c.length === 6 && s && !/^0+$/.test(s) && String(parseInt(s.slice(-4), 10)) !== String(parseInt(c.slice(0, 4), 10)))
        odd.push({ cust: c, name: m["得意先名１"] || "", company: s, companyName: m["得意先社名名"] || "", to: String(parseInt(s.slice(-4), 10)) });
    });
    items.forEach(it => {
      odd.filter(o => o.to === it.code || String(parseInt(o.cust.slice(0, 4), 10)) === it.code).forEach(o =>
        it.hints.push(`得意先マスタ：${o.cust} ${o.name} の社名コードが ${o.company}（${o.companyName}）。会計ではそちらの補助に入っている可能性`));
      if (it.code === "0") it.hints.push("会計で内訳コードを付けずに計上された売掛金（税理士の消費税などの調整）。販売には対応する取引がないので判定から除いています");
    });
    const explained = items.filter(i => i.affects).reduce((s, i) => s + i.d.bal, 0);
    tot.excluded = items.filter(i => i.excluded).reduce((s, i) => s + i.d.bal, 0);
    tot.diffNet = tot.diff - tot.excluded;   // コード0を除いた差。0 なら一致
    return { period: { from, to: K.period.to || H.period.to }, kPeriod: K.period, hPeriod: H.period, tot, items, odd, explained };
  }

  // 明細の行を見分けるキー（伝票№は年をまたぐと同じ番号が出るので日付も入れる）
  function lineKey(l) { return l.date + "|" + l.slip + "|" + l.row; }

  const API = { reconcile, parseKaikei, parseHanbai, lineKey, parseTermsNote, ruleLabel, denLabel, parseCSV, toObjects, build, addMonths, nextBusinessDay, fromSmile, daysBetween, cycleMonths, baseOf, BASES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ARCore = API;
})(typeof window !== "undefined" ? window : this);
