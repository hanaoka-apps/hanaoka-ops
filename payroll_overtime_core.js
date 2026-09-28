/* 時間外労働の定期確認（36協定 限度時間管理）計算ロジック
   画面（payroll_overtime.html）とテスト（Node）の両方から使う。個人データは含まない。
   データは勤怠CSV（本社事業場、1行＝1人1日、賃金計算期間16日〜翌月15日）を想定。 */
(function (root) {
  'use strict';

  /** 個人名などを含まない既定マスタ。実際のマスタはSharePointの 給与データ/overtime/master.json に保存する */
  const DEFAULT_MASTER = {
    事業場: '本社事業場（本社・大阪支店・名古屋営業所）',
    区分: {
      '営業系': { 限度: 45, 注意: 36 },
      '1年単位変形': { 限度: 42, 注意: 34 },
    },
    部署: {
      '東京営業': { 区分: '営業系', 業務: '営業' },
      '大阪支店': { 区分: '営業系', 業務: '営業' },
      '名古屋営業所': { 区分: '営業系', 業務: '営業' },
      'ソリューション営業部': { 区分: '営業系', 業務: '営業' },
      '全社業務センター': { 区分: '1年単位変形', 業務: '業務' },
      '販売企画室': { 区分: '1年単位変形', 業務: '販売企画室' },
      '総務': { 区分: '1年単位変形', 業務: '経理' },
    },
    除外部署: ['取締役'],
    管理監督者の役職: ['部長', '次長', '所長', '支店長', '課長'],  // 従業員マスタの「役職」がこれなら管理監督者として除外
    管理監督者: [],            // [{従業員コード, メモ}]（役職で判定できない人の個別指定）
    シフト勤務の給与種別: ['時給者'],  // パート・アルバイト：所定労働日でもシフトがない日は打刻なしで正常。見込みは出勤率で按分
    所定: { 始業: '08:55', 終業: '17:40', 休憩: '00:50', 所定内: '07:55' },
    個別所定: {},              // {従業員コード: {始業: 'hh:mm'}}（パート等）
    確認日: [28, 5, 10],
    特別条項: { 月上限: 78, 年回数: 6, 起算: '03-16' },
    事由: {
      '営業': '突発的な製品トラブル・見積もり業務への対応',
      '業務': '突発的な案件への受注・クレーム等対応',
      '経理': '突発的な支払・請求・伝票処理対応',
      '販売企画室': 'デザイン・広報・システム作業のため',
    },
    従業員代表: { 氏名: '', 所属: '', 連絡先: '' },
    その他休日を時間外に含める: true,  // 法定休日以外の休日（所定休日）の労働は法定時間外として限度時間に含める
    未申請しきい値分: 60,
    // 幹部チャットに載せる「打刻と申請の差」の範囲。締日直前にまとめて申請する人がいるため、確認日の日付で段階的に広げる
    差の掲載基準: [
      { 名前: '初回（28日）', 開始日: 16, 終了日: 31, 差の下限時間: 3, 見込み80も: false },
      { 名前: '中間（5日）', 開始日: 1, 終了日: 9, 差の下限時間: 3, 見込み80も: true },
      { 名前: '最終（10日）', 開始日: 10, 終了日: 15, 差の下限時間: 1, 見込み80も: false },
    ],
    異常_最大拘束時間: 16,
    超過回数手入力: {},        // {協定年度: {従業員コード: 回数}}（月次確定値からの自動集計を上書き）
  };

  // ---------- 時刻・日付 ----------
  /** "hh:mm"（24超可）→分。空欄はnull */
  function toMin(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;
    const m = s.match(/^(\d{1,3}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  /** 分→"h:mm" */
  function fmt(min) {
    if (min == null || isNaN(min)) return '';
    const neg = min < 0; min = Math.abs(Math.round(min));
    return (neg ? '-' : '') + Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
  }
  function fmtH(min) { return min == null ? '' : (Math.round(min / 6) / 10).toFixed(1) + 'h'; }
  function ymd(s) { return String(s).trim().replace(/-/g, '/'); }
  function dateAdd(s, n) {
    const [y, m, d] = s.split('/').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.getUTCFullYear() + '/' + String(t.getUTCMonth() + 1).padStart(2, '0') + '/' + String(t.getUTCDate()).padStart(2, '0');
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(v => v !== ''));
  }

  const REQUIRED = ['部署名', '従業員コード', '氏名', '日付', '休日設定', '出社時刻', '退社時刻', '休憩時間', '所定内労働時間', '法定内残業', '残業合計', '深夜残業'];

  /** 勤怠CSV（本社形式）の文字列 → 行オブジェクトの配列 */
  function parseAttendance(text) {
    const rows = parseCSV(text.replace(/^﻿/, ''));
    const hi = rows.findIndex(r => r.includes('従業員コード') && r.includes('日付'));
    if (hi < 0) throw new Error('勤怠CSVの見出し行（従業員コード・日付）が見つかりません。');
    const head = rows[hi].map(h => h.trim());
    const missing = REQUIRED.filter(k => !head.includes(k));
    if (missing.length) throw new Error('勤怠CSVに必要な列がありません：' + missing.join('、') + '（工場の勤怠CSVは形式が別のため、まだ対応していません）');
    return rows.slice(hi + 1).map(r => {
      const o = {}; head.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
      o.日付 = ymd(o.日付);
      o.届出有無 = o.届出有無 || o['届出・備考'] || '';
      return o;
    }).filter(o => o.従業員コード && /^\d{4}\/\d{2}\/\d{2}$/.test(o.日付));
  }

  // ---------- 期間・協定年度 ----------
  /** 期間の締日（最終日）から「N月分」の年月（YYYY-MM）。16日〜翌月15日 → 翌月分 */
  function payMonthOf(endDate) { const [y, m] = endDate.split('/'); return y + '-' + m; }
  /** 協定年度（起算3/16）：締日が4/15〜翌3/15の期間を同じ年度にまとめる。4月分が第1月 */
  function agreementYear(payYm) { const [y, m] = payYm.split('-').map(Number); return m >= 4 ? y : y - 1; }
  /** 協定年度内で、当月より前の給与月（YYYY-MM）の一覧 */
  function priorMonthsInYear(payYm) {
    const fy = agreementYear(payYm), out = [];
    let y = fy, m = 4;
    while (y + '-' + String(m).padStart(2, '0') !== payYm) {
      out.push(y + '-' + String(m).padStart(2, '0'));
      m++; if (m > 12) { m = 1; y++; }
      if (out.length > 12) break;
    }
    return out;
  }

  function mode(values) {
    const c = {}; let best = null, n = 0;
    values.forEach(v => { c[v] = (c[v] || 0) + 1; if (c[v] > n) { n = c[v]; best = v; } });
    return best;
  }

  // ---------- 本体 ----------
  /**
   * @param rows      parseAttendanceの結果
   * @param master    マスタ
   * @param asOf      データ基準日 'yyyy/mm/dd'（この日までの打刻で集計し、翌日以降を見込みに使う）
   * @param history   {給与月YYYY-MM: {従業員コード: 時間外分}}（協定年度の過去月の確定値。特別条項の回数に使う）
   * @param titles    {従業員コード: 役職}（従業員マスタ。管理監督者の判定に使う）
   * @param payTypes  {従業員コード: 給与種別名称}（従業員マスタ。シフト勤務＝時給者の判定に使う）
   */
  function evaluate(rows, master, asOf, history, titles, payTypes) {
    master = master || DEFAULT_MASTER; history = history || {}; titles = titles || {}; payTypes = payTypes || {};
    const managerTitles = new Set(master.管理監督者の役職 || []);
    const shiftTypes = new Set(master.シフト勤務の給与種別 || []);
    const dates = rows.map(r => r.日付).sort();
    const period = { 開始: dates[0], 締日: dates[dates.length - 1] };
    period.給与月 = payMonthOf(period.締日);
    period.協定年度 = agreementYear(period.給与月);
    const limitMax = toMin(String(master.異常_最大拘束時間) + ':00');
    const unreportThreshold = master.未申請しきい値分;
    const excludedCodes = new Set((master.管理監督者 || []).map(x => x.従業員コード));

    const byPerson = new Map();
    rows.forEach(r => {
      if (!byPerson.has(r.従業員コード)) byPerson.set(r.従業員コード, []);
      byPerson.get(r.従業員コード).push(r);
    });

    const people = [], anomalies = [], excluded = [];
    for (const [code, days] of byPerson) {
      days.sort((a, b) => a.日付 < b.日付 ? -1 : 1);
      const dept = days[days.length - 1].部署名;
      const name = days[0].氏名.replace(/　/g, ' ');
      if ((master.除外部署 || []).includes(dept)) { excluded.push({ 従業員コード: code, 氏名: name, 所属: dept, 理由: '役員' }); continue; }
      if (managerTitles.has(titles[code])) { excluded.push({ 従業員コード: code, 氏名: name, 所属: dept, 理由: '管理監督者（役職：' + titles[code] + '）' }); continue; }
      if (excludedCodes.has(code)) { excluded.push({ 従業員コード: code, 氏名: name, 所属: dept, 理由: '管理監督者（個別指定）' }); continue; }
      if (!days.some(d => d.出社時刻 || d.退社時刻 || d.所定内労働時間)) { excluded.push({ 従業員コード: code, 氏名: name, 所属: dept, 理由: '期間中の勤怠データなし' }); continue; }

      const deptM = master.部署[dept] || null;
      const kubun = deptM ? deptM.区分 : null;
      const kb = kubun ? master.区分[kubun] : null;
      const limit = kb ? kb.限度 * 60 : null, caution = kb ? kb.注意 * 60 : null;
      const start = toMin((master.個別所定[code] || {}).始業 || master.所定.始業);
      const scheduled = toMin(mode(days.map(d => d.所定内労働時間).filter(Boolean))) || toMin(master.所定.所定内);

      const shift = shiftTypes.has(payTypes[code]);
      let stamp = 0, applied = 0, night = 0, holidayWork = 0, workDays = 0, remaining = 0, pastScheduled = 0;
      const daily = [];
      for (const d of days) {
        const isHoliday = !!d.休日設定;
        const inT = toMin(d.出社時刻), outT = toMin(d.退社時刻), brk = toMin(d.休憩時間) || 0;
        const ap = (toMin(d.残業合計) || 0) + (toMin(d.法定内残業) || 0);
        if (d.日付 > asOf) {
          if (!isHoliday) remaining++;
          continue;
        }
        applied += ap; night += toMin(d.深夜残業) || 0;
        if (!isHoliday) pastScheduled++;
        const note = [d.届出有無, d.MC].filter(Boolean).join(' / ');
        const base = { 従業員コード: code, 氏名: name, 所属: dept, 日付: d.日付, 休日設定: d.休日設定, 出社: d.出社時刻, 退社: d.退社時刻, 届出: note };
        if ((inT == null) !== (outT == null)) {
          anomalies.push({ ...base, 種類: inT == null ? '出社打刻なし' : '退社打刻なし' });
          continue;
        }
        if (inT == null) {
          // シフト勤務（時給者）はシフトがない日なので異常にしない
          if (!isHoliday && !note && !shift) anomalies.push({ ...base, 種類: '所定労働日に打刻・届出なし' });
          continue;
        }
        if (outT - inT > limitMax) {
          anomalies.push({ ...base, 種類: '拘束' + master.異常_最大拘束時間 + '時間超（退社打刻の誤りの可能性）' });
          continue;
        }
        if (isHoliday) {
          const w = Math.max(0, outT - inT - brk);
          const countAsOT = d.休日設定 !== '法定休日' && master.その他休日を時間外に含める;
          if (countAsOT) stamp += w; else holidayWork += w;
          daily.push({ 日付: d.日付, 時間外: countAsOT ? w : 0, 休日労働: countAsOT ? 0 : w });
          continue;
        }
        const work = outT - Math.max(inT, start) - brk;
        const ot = Math.max(0, work - scheduled);
        stamp += ot; workDays++;
        daily.push({ 日付: d.日付, 時間外: ot });
      }

      // シフト勤務は残りの所定労働日のうち、これまでの出勤率の分だけ出勤すると見込む
      const attendRate = shift && pastScheduled ? Math.min(1, workDays / pastScheduled) : 1;
      const projected = workDays ? stamp + stamp / workDays * remaining * attendRate : stamp;
      const diff = Math.max(0, stamp - applied);
      const peak = Math.max(stamp, applied);
      const flags = [];
      let 判定 = '';
      if (limit != null) {
        const cap = master.特別条項.月上限 * 60;
        if (peak > cap) 判定 = '特別条項上限超過';
        else if (peak > limit) 判定 = '超過';
        else if (peak >= caution) 判定 = '80%到達';
        else if (projected > limit) 判定 = '超過見込み';
        else if (projected >= caution) 判定 = '80%超見込み';
      } else 判定 = '区分未設定';
      const unreported = diff >= unreportThreshold;
      if (!判定 && unreported) 判定 = '未申請あり';

      // 特別条項の回数（協定年度）：過去月の確定値＋当月（超過または超過見込みなら当月を1回として数える）
      const manual = ((master.超過回数手入力 || {})[period.協定年度] || {})[code];
      const pastMonths = priorMonthsInYear(period.給与月).filter(ym => limit != null && (history[ym] || {})[code] > limit);
      const pastCount = manual != null ? manual : pastMonths.length;
      const thisMonth = limit != null && (peak > limit || projected > limit);

      people.push({
        従業員コード: code, 氏名: name, 所属: dept, 区分: kubun || '未設定', 業務: deptM ? deptM.業務 : '',
        限度: limit, 注意: caution, 出勤日数: workDays, 打刻推定: stamp, 申請済: applied, 深夜: night,
        休日労働: holidayWork, 差: diff, 残日数: remaining, 見込み: projected, シフト勤務: shift, 出勤率: shift ? attendRate : null, 判定, 未申請あり: unreported,
        過去超過回数: pastCount, 過去超過月: manual != null ? ['手入力'] : pastMonths, 今回超過: thisMonth,
        超過回数: pastCount + (thisMonth ? 1 : 0), 所定内: scheduled, 日別: daily,
      });
    }
    const order = { '特別条項上限超過': 0, '超過': 1, '80%到達': 2, '超過見込み': 3, '80%超見込み': 4, '未申請あり': 5, '区分未設定': 6, '': 7 };
    people.sort((a, b) => order[a.判定] - order[b.判定] || b.見込み - a.見込み);
    anomalies.sort((a, b) => a.所属.localeCompare(b.所属, 'ja') || a.氏名.localeCompare(b.氏名, 'ja') || (a.日付 < b.日付 ? -1 : 1));
    return { period, asOf, people, anomalies, excluded };
  }

  /** 確認日（'yyyy/mm/dd'）に当てはまる差の掲載基準と、その基準で載せる人 */
  function diffStage(master, checkDate, people) {
    const day = Number(checkDate.split('/')[2]);
    const list = master.差の掲載基準 || DEFAULT_MASTER.差の掲載基準;
    const st = list.find(s => day >= s.開始日 && day <= s.終了日) || list[list.length - 1];
    const minBig = st.差の下限時間 * 60, minAny = master.未申請しきい値分;
    const picked = people.filter(x => x.差 >= minAny && (x.差 >= minBig || (st.見込み80も && x.注意 != null && x.見込み >= x.注意)));
    const label = `差が${st.差の下限時間}時間以上の方` + (st.見込み80も ? `、および限度時間の80%に達する見込みで差が${minAny / 60}時間以上の方` : '');
    return { stage: st, label, people: picked };
  }

  /** 基準日の初期値：退社打刻がある最新日（当日出力時の出社のみの行を拾わないため） */
  function defaultAsOf(rows) {
    const withOut = rows.filter(r => r.退社時刻).map(r => r.日付).sort();
    return withOut.length ? withOut[withOut.length - 1] : rows.map(r => r.日付).sort()[0];
  }

  const api = { DEFAULT_MASTER, toMin, fmt, fmtH, dateAdd, parseCSV, parseAttendance, evaluate, diffStage, defaultAsOf, payMonthOf, agreementYear, priorMonthsInYear };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OT = api;
})(this);
