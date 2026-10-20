/* ============================================================
   営業車の空き確認・予約（デモ機予約の画面 demo_reserve.html / my_schedule.html から使う）
   ------------------------------------------------------------
   デモ機を予約するとき、同じ期間の営業車の空きも見て、一緒に予約できるようにする。
   ・空き：営業車マスター（SharePoint）の各車のリソース予定表を読む（car_reserve.html と同じ読み方）。
   ・予約：Outlook の予定を1件作り、選んだ車を「リソース」として招待する。
           これは今まで Outlook で「宛先に車両を追加」していたのと同じ形で、車側の自動承諾が
           重複を判定する（重複なら車が辞退する）。作成後に回答を確認し、辞退された車は予定から外す。
   ・権限：空きを見る = Calendars.Read.Shared（既存）／予約 = Calendars.ReadWrite（新規）。
           ★ページ本来のサインインには混ぜない★ 未同意だとページ全体が開けなくなるため、使うとき
           （検索・予約ボタンを押したとき）に、このモジュールが別に取る。
           予約の権限が取れないときは、日付と車を入れた Outlook の新規作成画面へのリンクを出す。
   ============================================================ */
(function () {
  'use strict';
  const JST = 9 * 3600e3, DAY = 86400e3;
  const MASTER_NAME = '営業車管理一覧';
  const LOC_ORDER = ['本社', '工場', '名古屋', '大阪'];
  const RX_MAIL = /resource.*mail|mail.*resource|resourceemail|^email$|mail$|メール|アドレス/i;
  const RX_NAME = /vehicle|車両|車名|^title$/i;
  const RX_LOC  = /baselocation|location|拠点|site|base/i;
  const SCOPE_READ = ['Calendars.Read.Shared'];
  const SCOPE_WRITE = ['Calendars.ReadWrite'];

  let H = null;                       /* ホスト（各ページ）が渡す道具 */
  let CARS = [], loaded = false, loadErr = '';
  let SEL = new Set();                /* 選んだ車（メール） */
  let BUSY = new Map(), BAD = new Set(), RANGE = null;   /* 直近の検索：メール→重なる予約[] ／ 読めなかった車 ／ 期間 */
  let CHECK = new Map();              /* 「空き状況を確認」の結果：メール→重なる予約 */
  let FIL = { loc: '', q: '' }, TAB = 'demo', SEQ = 0;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const jd = ms => { const d = new Date(ms + JST); return d; };
  const fmt = ms => { const d = jd(ms); return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const wall = ms => { const d = jd(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const overlaps = (a, s, e) => a.s < e && a.e > s;

  /* ---- 認証：使うときに別に取る（ページ本来のサインインには混ぜない） ---- */
  async function token(scopes) {
    const m = H.msal(), account = H.account();
    try { return (await m.acquireTokenSilent({ scopes, account })).accessToken; }
    catch (e) { return (await m.acquireTokenPopup({ scopes, account })).accessToken; }
  }
  async function gfetch(tok, method, path, body) {
    const r = await fetch('https://graph.microsoft.com/v1.0' + path, { method,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  }

  /* ---- 営業車マスター ---- */
  function pickKey(keys, rx) {
    const cand = keys.filter(k => rx.test(k) && !/^(id|contenttype|_|odata|attachments|edit|linktitle|itemchild|folder|compliance|appauthor|appeditor|author|editor|created|modified|filesystem|servername|encoded|linkfilename|docicon|itemtype|sortbehavior|parentversion|parentleaf|selecttype|order|guid|instanceid|owshidden|progid|scopeid|healthreport|virus|checked|isrecord|displayorder)/i.test(k));
    return cand[0] || null;
  }
  async function loadCars() {
    if (loaded) return;
    const key = 'listId:' + MASTER_NAME;
    let id = sessionStorage.getItem(key);
    if (!id) {
      const r = await H.gGet(`/sites/${H.siteId}/lists?$select=id,displayName&$top=200`);
      const hit = (r.value || []).find(l => l.displayName === MASTER_NAME);
      id = hit && hit.id;
      if (id) sessionStorage.setItem(key, id);
    }
    if (!id) throw new Error(`リスト「${MASTER_NAME}」が見つかりません`);
    const items = await H.gGetAll(`/sites/${H.siteId}/lists/${id}/items?$expand=fields&$top=500`);
    if (!items.length) throw new Error(`「${MASTER_NAME}」に行がありません`);
    const keys = Object.keys(items[0].fields || {});
    const kMail = pickKey(keys, RX_MAIL), kName = pickKey(keys, RX_NAME), kLoc = pickKey(keys, RX_LOC);
    CARS = items.map(it => {
      const f = it.fields || {};
      const raw = kLoc ? f[kLoc] : '';
      return { n: String((kName && f[kName]) || f.Title || '(名称なし)'),
               loc: String((raw && typeof raw === 'object' ? (raw.Value || raw.LookupValue || '') : raw) || ''),
               mail: String((kMail && f[kMail]) || '').trim().toLowerCase() };
    }).filter(c => c.mail);
    const rank = v => { const i = LOC_ORDER.indexOf(v); return i < 0 ? 99 : i; };
    CARS.sort((a, b) => rank(a.loc) - rank(b.loc));
    loaded = true;
  }

  /* ---- 空き：各車のリソース予定表を読む ---- */
  /* ★終日の境界は2通り★ 日本時間で作られた終日は「前日15:00Z」、UTCで作られたものは「当日0:00Z」で
     返る。日付部分だけ読むと前者が1日ずれるので、JSTの0時ちょうどならそのまま、違えば日付だけを見る。 */
  function allDayMs(x) {
    const raw = String(x && x.dateTime || '');
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return NaN;
    const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z');
    if (!isNaN(t) && (((t + JST) % DAY) + DAY) % DAY === 0) return t;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST;
  }
  function evRange(ev) {
    if (ev.isAllDay) {
      const a = allDayMs(ev.start), b = allDayMs(ev.end);
      return { s: a, e: (isNaN(a) || isNaN(b) || b <= a) ? a + DAY : b };
    }
    const p = x => { const r = String(x && x.dateTime || ''); return Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(r) ? r : r + 'Z'); };
    return { s: p(ev.start), e: p(ev.end) };
  }
  async function fetchBusy(tok, cars, s, e) {
    const busy = new Map(), bad = new Set();
    const q = `startDateTime=${encodeURIComponent(new Date(s - DAY).toISOString())}&endDateTime=${encodeURIComponent(new Date(e + DAY).toISOString())}`
            + `&$select=id,subject,start,end,organizer,isCancelled,isAllDay,showAs&$orderby=start/dateTime&$top=100`;
    for (let i = 0; i < cars.length; i += 20) {
      const chunk = cars.slice(i, i + 20);
      const r = await gfetch(tok, 'POST', '/$batch', { requests: chunk.map((c, k) => ({ id: String(k), method: 'GET',
        url: `/users/${encodeURIComponent(c.mail)}/calendarView?${q}`, headers: { Prefer: 'outlook.timezone="UTC"' } })) });
      const resps = (r.body && r.body.responses) || [];
      chunk.forEach((c, k) => {
        const x = resps.find(z => z.id === String(k));
        if (!x || x.status !== 200 || !x.body || !Array.isArray(x.body.value)) { bad.add(c.mail); return; }
        x.body.value.forEach(ev => {
          if (ev.isCancelled) return;
          const rg = evRange(ev);
          if (isNaN(rg.s) || isNaN(rg.e) || !overlaps(rg, s, e)) return;
          if (!busy.has(c.mail)) busy.set(c.mail, []);
          busy.get(c.mail).push({ t: ev.subject || '(件名なし)', who: ev.organizer?.emailAddress?.name || '', s: rg.s, e: rg.e });
        });
      });
    }
    return { busy, bad };
  }

  /* ---- 画面：タブと営業車パネル（空き検索モーダルの中に差し込む） ---- */
  function injectStyle() {
    if (document.getElementById('cb-style')) return;
    const st = document.createElement('style'); st.id = 'cb-style';
    st.textContent =
      '.cb-tabs{display:flex;gap:4px;margin:2px 0 8px;border-bottom:1px solid #dde2ec}' +
      '.cb-tab{border:none;background:transparent;padding:7px 14px;font:inherit;font-size:13px;font-weight:700;color:#6b7a99;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-1px}' +
      '.cb-tab.on{color:#23268f;border-bottom-color:#23268f}' +
      '#car-panel{font-size:12.5px}' +
      '#car-panel h4{font-size:13px;margin:0 0 7px;color:#23268f}' +
      '#cb-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}' +
      '#cb-filters select,#cb-filters input{border:1px solid #dfe4ef;border-radius:8px;padding:5px 8px;font:inherit;font-size:12px}' +
      '#cb-list .cb-grp{margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}' +
      '#cb-list .cb-grp b{color:#6b7a99;font-weight:600;min-width:64px;font-size:11.5px}' +
      '#cb-list .cb-none{color:#c0392b;font-weight:700}' +
      '#cb-list .cb-hint{color:#6b7a99}';
    document.head.appendChild(st);
  }
  function mount() {
    injectStyle();
    const panel = document.getElementById('seek-panel');
    if (!panel || document.getElementById('car-panel')) return;
    const tabs = document.createElement('div'); tabs.className = 'cb-tabs';
    tabs.innerHTML = '<button type="button" class="cb-tab on" data-tab="demo">デモ機</button>' +
                     '<button type="button" class="cb-tab" data-tab="car" id="cb-tab-car">🚗 営業車</button>';
    panel.parentNode.insertBefore(tabs, panel);
    const cp = document.createElement('div'); cp.id = 'car-panel'; cp.style.display = 'none';
    cp.innerHTML = '<div id="cb-filters"></div><div id="cb-list"></div>';
    panel.parentNode.insertBefore(cp, panel.nextSibling);
    tabs.addEventListener('click', ev => { const b = ev.target.closest('.cb-tab'); if (b) showTab(b.dataset.tab); });
    cp.addEventListener('click', ev => {
      const c = ev.target.closest('.chip[data-mail]'); if (!c || c.classList.contains('busy')) return;
      const m = c.dataset.mail; if (SEL.has(m)) SEL.delete(m); else SEL.add(m);
      render(); H.onChange && H.onChange();
    });
    cp.addEventListener('input', ev => {
      if (ev.target.id === 'cb-loc') FIL.loc = ev.target.value;
      if (ev.target.id === 'cb-q') FIL.q = ev.target.value;
      renderList();
    });
  }
  function showTab(t) {
    TAB = t;
    document.querySelectorAll('.cb-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    const demo = document.getElementById('seek-panel'), car = document.getElementById('car-panel');
    if (demo) demo.style.display = t === 'demo' ? '' : 'none';
    if (car) car.style.display = t === 'car' ? '' : 'none';
    /* 拠点・区分／機種名の絞り込みはデモ機用。営業車タブでは隠す（営業車は自分の絞り込みを持つ） */
    const sc = document.getElementById('sCat'), row = sc && sc.closest('.f2');
    if (row) row.style.display = t === 'demo' ? '' : 'none';
  }

  function visibleCars() {
    const q = FIL.q.trim().toLowerCase();
    return CARS.filter(c => (!FIL.loc || c.loc === FIL.loc) && (!q || c.n.toLowerCase().includes(q)));
  }
  function render() { renderFilters(); renderList(); paintTab(); }
  function renderFilters() {
    const box = document.getElementById('cb-filters'); if (!box) return;
    if (box.dataset.built === String(CARS.length)) return;   /* 入力中のフォーカスを失わないよう、車が変わったときだけ作り直す */
    const locs = [...new Set(CARS.map(c => c.loc).filter(Boolean))];
    box.innerHTML = `<select id="cb-loc"><option value="">全拠点</option>${locs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>`
      + `<input id="cb-q" type="search" placeholder="車名で検索" value="${esc(FIL.q)}">`;
    box.dataset.built = String(CARS.length);
  }
  function renderList() {
    const box = document.getElementById('cb-list'); if (!box) return;
    if (loadErr) { box.innerHTML = `<div class="cb-none">${esc(loadErr)}</div>`; return; }
    if (!RANGE) { box.innerHTML = '<div class="cb-hint">「🔍 この期間の空き機体を検索」を押すと、デモ機と同じ期間の営業車の空きがここに出ます。</div>'; return; }
    if (RANGE.loading) { box.innerHTML = '<div class="cb-hint">営業車の空きを確認中...</div>'; return; }
    const list = visibleCars();
    const free = list.filter(c => !BUSY.has(c.mail) && !BAD.has(c.mail));
    const used = list.filter(c => BUSY.has(c.mail));
    const bad  = list.filter(c => BAD.has(c.mail));
    let h = `<h4>${fmt(RANGE.s)} 〜 ${fmt(RANGE.allDay ? RANGE.e - 60e3 : RANGE.e)}${RANGE.allDay ? '（終日）' : ''}　空いている営業車 ${free.length}台 / 対象 ${list.length}台</h4>`;
    if (!free.length) h += '<div class="cb-none">この期間に空いている営業車はありません</div>';
    else [...new Set(free.map(c => c.loc))].forEach(L => {
      h += `<div class="cb-grp"><b>${esc(L || 'その他')}</b>` + free.filter(c => c.loc === L)
        .map(c => `<span class="chip${SEL.has(c.mail) ? ' on' : ''}" data-mail="${esc(c.mail)}">🚗 ${esc(c.n)}</span>`).join('') + '</div>';
    });
    if (used.length) {
      h += '<div class="cb-grp" style="margin-top:8px"><b>予約済み</b>' + used.map(c => {
        const r = BUSY.get(c.mail)[0];
        return `<span class="chip busy" title="${esc(r.t)}${r.who ? '（' + esc(r.who) + '）' : ''} ${fmt(r.s)}〜${fmt(r.e)}">🚗 ${esc(c.n)}</span>`;
      }).join('') + '<span class="cb-hint">車名にマウスを乗せると誰が押さえているか出ます</span></div>';
    }
    if (bad.length) h += `<div class="cb-hint" style="margin-top:8px">予定表を読めなかった車（空きは確認できません）：${bad.map(c => esc(c.n)).join('、')}</div>`;
    if (free.length) h += '<div class="cb-hint" style="margin-top:9px">空いている車をクリックして選ぶと、デモ機と一緒にまとめて予約できます（予約ボタンは上に固定してあります）</div>';
    box.innerHTML = h;
  }
  function paintTab() {
    const b = document.getElementById('cb-tab-car'); if (!b) return;
    const n = SEL.size;
    if (RANGE && !RANGE.loading && !loadErr) {
      const free = CARS.filter(c => !BUSY.has(c.mail) && !BAD.has(c.mail)).length;
      b.textContent = `🚗 営業車（空き${free}/${CARS.length}${n ? `・選択${n}` : ''}）`;
    } else b.textContent = n ? `🚗 営業車（選択${n}）` : '🚗 営業車';
  }

  /* ---- ホストから呼ぶ ---- */
  async function search(s, e, allDay) {
    const my = ++SEQ;
    RANGE = { s, e, allDay: !!allDay, loading: true }; BUSY = new Map(); BAD = new Set(); loadErr = '';
    render();
    try {
      await loadCars();
      const tok = await token(SCOPE_READ);
      const r = await fetchBusy(tok, CARS, s, e);
      if (my !== SEQ) return;                    /* 追い越された */
      BUSY = r.busy; BAD = r.bad;
      SEL.forEach(m => { if (BUSY.has(m)) SEL.delete(m); });     /* 期間内に埋まった車は選択から外す */
    } catch (err) {
      if (my !== SEQ) return;
      loadErr = '営業車の空きを確認できませんでした：' + (err.message || err);
    }
    RANGE.loading = false;
    render(); H.onChange && H.onChange();
  }
  /* 「空き状況を確認」：選んだ車だけ、モーダル内の期間で取り直す。{total, busy} を返す */
  async function check(s, e) {
    CHECK = new Map();
    const cars = selectedCars();
    if (!cars.length) return { total: 0, busy: 0 };
    const r = await fetchBusy(await token(SCOPE_READ), cars, s, e);
    r.busy.forEach((v, k) => CHECK.set(k, v[0]));
    return { total: cars.length, busy: CHECK.size };
  }
  function selectedCars() { return CARS.filter(c => SEL.has(c.mail)); }
  function selCount() { return SEL.size; }
  function clearSel() { SEL = new Set(); CHECK = new Map(); render(); }
  function reset() { SEL = new Set(); CHECK = new Map(); BUSY = new Map(); BAD = new Set(); RANGE = null; loadErr = ''; FIL = { loc: '', q: '' };
    const box = document.getElementById('cb-filters'); if (box) box.dataset.built = ''; showTab('demo'); render(); }
  function resetCheck() { CHECK = new Map(); }
  function bulkChipsHtml() {
    return selectedCars().map(c => {
      const r = CHECK.get(c.mail);
      return r ? `<span class="chip busy" title="${esc(r.t)}${r.who ? '（' + esc(r.who) + '）' : ''} ${fmt(r.s)}〜${fmt(r.e)}">🚗 ${esc(c.n)}</span>`
               : `<span class="chip">🚗 ${esc(c.n)}</span>`;
    }).join('');
  }

  /* ---- 予約：Outlook の予定を1件作り、選んだ車をリソースとして招待する ---- */
  function composeUrl(d, cars) {
    const p = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: d.title,
      startdt: wall(d.s), enddt: wall(d.e), to: cars.map(c => c.mail).join(';'), location: d.dest || '',
      body: [d.cust && `顧客名：${d.cust}`, d.notes && `備考：${d.notes}`].filter(Boolean).join('\n') });
    if (d.allDay) p.set('allday', 'true');
    return 'https://outlook.office.com/calendar/0/deeplink/compose?' + p.toString();
  }
  const RESP_NG = new Set(['declined']);
  /* 予約ボタンを押した直後（クリックの勢いが残っているうち）に呼ぶ。初回の同意ポップアップが
     デモ機の予約処理のあとだとブロックされることがあるため、先に権限だけ取っておく。 */
  let PREP = null;
  function prepare() { PREP = token(SCOPE_WRITE).then(t => t, () => null); return PREP; }
  async function book(d) {
    const cars = selectedCars();
    const lines = [];
    const out = { okCount: 0, total: cars.length, lines, changed: false };
    let tok = null;
    try { tok = await (PREP || prepare()); } catch (err) { tok = null; }
    PREP = null;
    if (!tok) {
      lines.push(`<span style="color:var(--danger)">✗ 営業車を予約できませんでした — カレンダーへの書き込み権限（Calendars.ReadWrite）が取得できません。`
        + `いったんサインアウトして入り直すか、総務部にご連絡ください。それまでは、<a href="${esc(composeUrl(d, cars))}" target="_blank" rel="noopener noreferrer">Outlookで予定を作成（日付・車入り）</a>から予約できます。</span>`);
      return out;
    }
    const body = {
      subject: d.title,
      body: { contentType: 'text', content: [d.cust && `顧客名：${d.cust}`, d.notes && `備考：${d.notes}`, '※デモ機・営業車の予約画面から登録'].filter(Boolean).join('\n') },
      start: { dateTime: wall(d.s), timeZone: 'Tokyo Standard Time' },
      end:   { dateTime: wall(d.e), timeZone: 'Tokyo Standard Time' },
      isAllDay: !!d.allDay, showAs: 'busy',
      location: { displayName: d.dest || '' },
      attendees: cars.map(c => ({ emailAddress: { address: c.mail, name: c.n }, type: 'resource' })),
      transactionId: (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)
    };
    const r = await gfetch(tok, 'POST', '/me/events', body);
    if (r.status !== 201 || !r.body || !r.body.id) {
      lines.push(`<span style="color:var(--danger)">✗ 営業車の予約を登録できませんでした（${r.status} ${esc(r.body?.error?.message || '')}）</span>`
        + ` <a href="${esc(composeUrl(d, cars))}" target="_blank" rel="noopener noreferrer">Outlookで予定を作成</a>`);
      return out;
    }
    out.changed = true;
    const id = r.body.id;
    /* 車（リソース）の自動承諾は少し遅れて返る。数回確認して、辞退（＝重複）した車を見つける */
    let resp = new Map();
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 2000 : 2500);
      const g = await gfetch(tok, 'GET', `/me/events/${id}?$select=attendees`);
      resp = new Map(((g.body && g.body.attendees) || []).map(a => [String(a.emailAddress?.address || '').toLowerCase(), a.status?.response || 'none']));
      if (cars.every(c => (resp.get(c.mail) || 'none') !== 'none' && resp.get(c.mail) !== 'notResponded')) break;
    }
    const declined = cars.filter(c => RESP_NG.has(resp.get(c.mail)));
    const kept = cars.filter(c => !RESP_NG.has(resp.get(c.mail)));
    cars.forEach(c => {
      const st = resp.get(c.mail) || 'none';
      if (RESP_NG.has(st)) lines.push(`<span style="color:var(--danger)">✗ 🚗 ${esc(c.n)} — 同じ時間に他の予約があり、車から辞退されました</span>`);
      else if (st === 'accepted' || st === 'tentativelyAccepted') { out.okCount++; SEL.delete(c.mail); lines.push(`<span style="color:var(--success)">✓ 🚗 ${esc(c.n)}</span>`); }
      else { out.okCount++; SEL.delete(c.mail); lines.push(`<span style="color:var(--success)">✓ 🚗 ${esc(c.n)} — 承諾待ち（車の自動承諾は数分以内に確定します。辞退された場合はOutlookにお知らせが届きます）</span>`); }
    });
    /* 辞退された車は予定から外す（全部辞退なら予定ごと消す）。予定が残ると、使えない車が自分の予定に出続けるため */
    try {
      if (declined.length && !kept.length) await gfetch(tok, 'DELETE', `/me/events/${id}`);
      else if (declined.length) await gfetch(tok, 'PATCH', `/me/events/${id}`, { attendees: kept.map(c => ({ emailAddress: { address: c.mail, name: c.n }, type: 'resource' })) });
    } catch { /* 外せなくても予約結果の表示は優先。Outlookで手動で外してもらう */ }
    render(); H.onChange && H.onChange();
    return out;
  }

  window.CarBook = {
    init(h) { H = h; }, mount, prepare, search, check, selectedCars, selCount, clearSel, reset, resetCheck, bulkChipsHtml, book, showTab,
    afterBook: async () => { if (H.afterBook) await H.afterBook(); }
  };
})();
