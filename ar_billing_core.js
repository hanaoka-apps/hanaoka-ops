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
        staffCode: m["担当者ｺｰﾄﾞ"] || "", staffName: (m["担当者名"] || "").trim(), base: baseOf(st),
        closeDay, closeLabel: closeDay >= 30 ? "末締" : (closeDay ? closeDay + "日締" : ""),
        cycle: cyc, payDay,
        termsLabel: cyc == null ? "" : (["当月", "翌月"][cyc] || cyc + "ヶ月後") + dayLabel(payDay),
        payMethod: m["入金条件名１"] || "",
        noCollect: (m["回収管理区分名"] || "") === "行わない",
        ec: EC_COMPANY.has(m["得意先社名ｺｰﾄﾞ"] || ""),
        inMaster: !!cust[code],
        invoices: {}, unbilled: [], payments: [], periods: [], children: {}
      };
      return o;
    }

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
      if (line.cust && line.cust !== code) c.children[line.cust] = line.custName;
      const no = String(r["請求書番号"] || "0").trim();
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
        date: fromSmile(r["伝票日付"]), slip: r["伝票№"], row: r["行"], kind: (r["取引区分名"] || "").replace(/\s|　/g, ""),
        attr: r["取引区分属性名"] || "", amount: num(r["入金額"]), due: fromSmile(r["決済予定日"]), memo: r["備考"] || ""
      });
    });

    // ---- 請求先ごとに、回収予定日の回（period）を作って違算を判定 ----
    Object.values(C).forEach(c => {
      c.payments.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      c.unbilled.sort((a, b) => a.date < b.date ? -1 : 1);
      const invs = Object.values(c.invoices);
      invs.forEach(inv => {
        inv.amount = inv.net + inv.tax;
        inv.close = inv.taxDate || inv.lastDate;
        inv.due = c.cycle == null ? "" : addMonths(inv.close, c.cycle, c.payDay);
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
        if (!inv.bound || inv.amount === 0) return;
        (groups[inv.bound] = groups[inv.bound] || []).push(inv);
      });
      // 入金を充てる範囲：前の回収予定日との中間の翌日 〜 次の回収予定日との中間まで。
      //   期限ちょうどで区切ると、連休明けなどで数日遅れただけの入金（山善の 5/10 分が 5/15 着など）が
      //   次の回に入り「未入金→翌月過入金」に見えるため。
      //   最初の回は 15 日前から（それより前の入金は、データより前の請求の分）。
      //   最後の回はそれ以降の入金すべて（次の請求がない得意先の遅れた入金が、どの回にも入らず消えないように）
      const bounds = Object.keys(groups).sort();
      const mid = (a, b) => addDays(a, Math.floor(daysBetween(a, b) / 2));
      let cum = 0, started = false;
      const periods = [];
      bounds.forEach((b, i) => {
        const g = groups[b];
        const amt = g.reduce((s, x) => s + x.amount, 0);
        const firstDue = g.map(x => x.due).sort()[0];
        const lo = i ? mid(bounds[i - 1], b) : addDays(b, -15);
        const hi = i < bounds.length - 1 ? mid(b, bounds[i + 1]) : "9999-12-31";
        const ps = c.payments.filter(p => p.date > lo && p.date <= hi);
        const paid = ps.reduce((s, p) => s + p.amount, 0);
        const partial = g.some(x => x.partial);
        const usable = !reason && !partial && lo >= addDays(judgeFrom, -1);
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

  const API = { parseCSV, toObjects, build, addMonths, nextBusinessDay, fromSmile, daysBetween, cycleMonths, baseOf, BASES };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.ARCore = API;
})(typeof window !== "undefined" ? window : this);
