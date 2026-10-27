/* ============================================================
   支払決済スケジュールの「ルール案」（payment_schedule.html から使う純粋な計算部品）
   ------------------------------------------------------------
   ・営業日 ＝ 月〜金。祝日と、共通カレンダーに入っている会社休日（件名に「休日」「祝」）は含めない。
     ★土曜は、土曜出社日であっても営業日に数えない（総務の決まり）。
   ・ここで出すのは「案」。過去のExcelは人が手で置いた月もあり、ルールどおりでない月があるため、
     画面で必ず確認・修正して使う。
   ・日付はすべて 'YYYY-MM-DD' の文字列（時差の影響を受けない）。
   ============================================================ */
(function (root) {
  'use strict';
  const pad = n => String(n).padStart(2, '0');
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const fmt = dt => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const addDays = (s, n) => fmt(new Date(parse(s).getTime() + n * 864e5));
  const dow = s => parse(s).getUTCDay();                     /* 0=日 … 6=土 */
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  /* ---- 日本の祝日（1980〜2099年の春分・秋分の近似式つき） ---- */
  const hcache = {};
  function nthMonday(y, m, n) { // m月の第n月曜日
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  }
  function jpHolidays(y) {
    if (hcache[y]) return hcache[y];
    const h = new Map();                                    /* 日付 → 名前 */
    const add = (m, d, name) => h.set(ymd(y, m, d), name);
    add(1, 1, '元日');
    add(1, nthMonday(y, 1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    if (y >= 2020) add(2, 23, '天皇誕生日');
    const sh = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    add(3, sh, '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日'); add(5, 4, 'みどりの日'); add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 7, 3), '海の日');
    if (y >= 2016) add(8, 11, '山の日');
    add(9, nthMonday(y, 9, 3), '敬老の日');
    const au = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    add(9, au, '秋分の日');
    add(10, nthMonday(y, 10, 2), 'スポーツの日');
    add(11, 3, '文化の日'); add(11, 23, '勤労感謝の日');
    /* 国民の休日（前後を祝日にはさまれた平日） */
    for (const k of [...h.keys()]) {
      const mid = addDays(k, 1), after = addDays(k, 2);
      if (h.has(after) && !h.has(mid) && dow(mid) !== 0) h.set(mid, '国民の休日');
    }
    /* 振替休日（祝日が日曜なら、次の祝日でない日） */
    for (const k of [...h.keys()].sort()) {
      if (dow(k) === 0) { let n = addDays(k, 1); while (h.has(n)) n = addDays(n, 1); h.set(n, '振替休日'); }
    }
    hcache[y] = h; return h;
  }
  const isPublicHoliday = s => jpHolidays(Number(s.slice(0, 4))).has(s);

  /* ---- 営業日 ---- */
  /* ctx = { calHolidays: Set<'YYYY-MM-DD'>（共通カレンダーの会社休日） } */
  function isBiz(s, ctx) {
    const w = dow(s);
    if (w === 0 || w === 6) return false;
    if (isPublicHoliday(s)) return false;
    if (ctx && ctx.calHolidays && ctx.calHolidays.has(s)) return false;
    return true;
  }
  function shiftBiz(s, n, ctx) {                            /* s から n営業日前（n>0）／後（n<0） */
    const step = n > 0 ? -1 : 1; let k = Math.abs(n), cur = s;
    for (let guard = 0; k > 0 && guard < 400; guard++) { cur = addDays(cur, step); if (isBiz(cur, ctx)) k--; }
    return cur;
  }
  const prevBizOrSelf = (s, ctx) => { let c = s; for (let g = 0; g < 400 && !isBiz(c, ctx); g++) c = addDays(c, -1); return c; };
  const lastBizOfMonth = (y, m, ctx) => prevBizOrSelf(ymd(y, m, lastDay(y, m)), ctx);

  /* ---- ルール案（月ごとの予定を作る） ----
     返すもの：{ date, title, kind('main'|'sub'), owner, memo } の配列
     ・10日／20日：起算日（営業日でなければ前の営業日）の1営業日前が決済、2営業日前が資料完成
     ・月末：最終営業日を起算日にして、1・3・3・4・5営業日前の作業ステップ
     ・総合会議：その月の土曜出社日（共通カレンダーにあれば） */
  function generate(ym, ctx, opts) {
    const payBefore = (opts && opts.payrollBefore) || 1;
    const [y, m] = ym.split('-').map(Number);
    const out = [];
    const add = (date, title, kind, owner, memo) => out.push({ date, title, kind, owner: owner || '', memo: memo || '' });
    const sat = ctx && ctx.satWork ? [...ctx.satWork].filter(d => d.startsWith(ym)).sort()[0] : null;
    if (sat) add(sat, '総合会議', 'main', '', '土曜出社日');
    for (const day of [10, 20]) {
      const base = prevBizOrSelf(ymd(y, m, day), ctx);
      add(shiftBiz(base, 1, ctx), `${day}日支払決済`, 'main', '総務幹部', `${day}日から1営業日前`);
      add(shiftBiz(base, 2, ctx), `<${day}日>支払決済資料 完成`, 'sub', '幹部', `${day}日から2営業日前`);
    }
    /* 給与決済：支給日（25日。営業日でなければ前の営業日）の n営業日前。過去20か月では1営業日前が13回、3営業日前が6回
       （賞与などの月）だったので、既定は1営業日前。月ごとに画面で切り替える */
    const pr = opts && opts.payroll;                           /* 社労士と決めた日程 { m:振込方法, a:勤怠確定日, p:給与決裁日, s:支給日 }（日にち） */
    if (pr && pr.p) {
      add(ymd(y, m, pr.p), '車輌・株ハナ 給与決済', 'main', '花岡', `給与決裁日（支給日${pr.s}日${pr.m ? '・' + pr.m : ''}）`);
    } else {
      const payDay = prevBizOrSelf(ymd(y, m, 25), ctx);
      add(shiftBiz(payDay, payBefore, ctx), '車輌・株ハナ 給与決済', 'main', '花岡', `給与支給日（${m}/${Number(payDay.slice(8))}）の${payBefore}営業日前`);
    }
    const LB = lastBizOfMonth(y, m, ctx);
    add(shiftBiz(LB, 1, ctx), '月末支払決済・でんさい(本社・工場)', 'main', '総務幹部', '最終営業日の1営業日前');
    add(shiftBiz(LB, 1, ctx), '株ハナ月末支払決済', 'main', '花岡', '最終営業日の1営業日前');
    add(LB, '<月末>でんさい決済', 'sub', '総務', '最終営業日');
    add(shiftBiz(LB, 1, ctx), '<月末>銀行送金・送金内容確認', 'sub', '総務', '1営業日前');
    add(shiftBiz(LB, 3, ctx), '<月末>各部提出・確認', 'sub', '全社', '3営業日前');
    add(shiftBiz(LB, 3, ctx), '<月末>工場支払決済・確認', 'sub', '総務', '3営業日前');
    add(shiftBiz(LB, 4, ctx), '<月末>支払決済資料 工場以外完成', 'sub', '総務', '4営業日前');
    add(shiftBiz(LB, 5, ctx), '<月末>支払決済資料 工場完成', 'sub', '工場総務', '5営業日前');
    return out.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'main' ? -1 : 1));
  }

  /* 共通カレンダーに登録する件名（担当は「（担当：〇〇）」で付ける） */
  const subjectOf = it => it.owner ? `${it.title}（担当：${it.owner}）` : it.title;

  const api = { parse, fmt, ymd, addDays, dow, lastDay, jpHolidays, isPublicHoliday, isBiz, shiftBiz, prevBizOrSelf, lastBizOfMonth, generate, subjectOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PayRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
