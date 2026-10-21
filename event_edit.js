/* ============================================================
   自分の予定の追加・変更・削除（共通部品）
   ------------------------------------------------------------
   「自分の予定」（my_schedule.html）と「全社員の予定」（staff_schedule.html）で
   まったく同じフォーム・同じ動きにするため、1か所にまとめている。

   ・Outlook の予定表を直接書き換える（このアプリ専用のデータは持たない）。
   ・変更・削除できるのは、自分が主催した、繰り返しでない予定だけ（canEdit）。
   ・書き込み権限（Calendars.ReadWrite）はページ本来のサインインに混ぜず、押したときに別に取る。
     取れなければ Outlook へ案内する。
   ・営業車・会議室が入っている予定の時間を変えて、断られたものがあれば元の時間に戻す。

   使い方（ページ側）
     MyEvent.init({ msal: () => msalInstance, account: () => currentAccount,
                    snack: showSnack, reload: () => loadAll() });
     MyEvent.openNew();                // 追加
     MyEvent.openEdit(d);              // 変更   d = { id, t, s, e, allDay, loc, showAs, sens, online, body, others, facs[] }
     await MyEvent.remove(d);          // 削除（確認つき。消したら true）
     MyEvent.canEdit(d);               // d.isOrg && !d.recurring
   ページ側のモーダル・ボタン・フォームの部品（.modal .card .fm .f .f2 .chk .note .msg button.act）を使う。
   ============================================================ */
(function () {
  'use strict';
  const JST = 9 * 3600e3, DAY = 86400e3;
  const pad = n => String(n).padStart(2, '0');
  const toJ = ms => new Date(ms + JST);
  const msToLocal = ms => { const d = toJ(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const msToDate = ms => msToLocal(ms).slice(0, 10);
  const localToMs = v => v ? Date.parse(v + ':00Z') - JST : NaN;
  const dateToMs = v => v ? Date.parse(v + 'T00:00:00Z') - JST : NaN;
  const wallOf = ms => `${msToLocal(ms)}:00`;
  const jFull = ms => { const d = toJ(ms); return `${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const SHOWAS = ['busy', 'free', 'tentative', 'oof', 'workingElsewhere'];

  let H = null, built = false, mode = 'new', cur = null;

  function build() {
    if (built) return; built = true;
    const st = document.createElement('style');
    st.textContent = '.msg{font-size:12px}.msg.ok{color:#2e7d52}.msg.ng{color:#c0392b}button.dngr{color:#c0392b;border-color:#e3b3ae}';
    document.head.appendChild(st);
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'mEvEdit';
    m.innerHTML =
      '<div class="card">' +
      '<h3 id="peHead">予定を追加する</h3>' +
      '<div class="bd"><div class="fm">' +
        '<div class="f"><span>件名（必須）</span><input type="text" id="peTitle"></div>' +
        '<div class="f"><span>場所</span><input type="text" id="peLoc"></div>' +
        '<label class="chk"><input type="checkbox" id="peAllDay"> 終日</label>' +
        '<div class="f2" id="peTimeRow">' +
          '<div class="f"><span>開始（JST）</span><input type="datetime-local" id="peFrom"></div>' +
          '<div class="f"><span>終了（JST）</span><input type="datetime-local" id="peTo"></div></div>' +
        '<div class="f2" id="peDateRow" style="display:none">' +
          '<div class="f"><span>開始日（JST）</span><input type="date" id="peFromD"></div>' +
          '<div class="f"><span>終了日（この日も含む）</span><input type="date" id="peToD"></div></div>' +
        '<div class="f"><span>表示（他の人から見たときの状態）</span><select id="peShowAs">' +
          '<option value="busy">予定あり</option><option value="free">空き時間</option><option value="tentative">仮の予定</option>' +
          '<option value="oof">不在・休暇</option><option value="workingElsewhere">別の場所で勤務</option></select></div>' +
        '<label class="chk"><input type="checkbox" id="pePrivate"> 非公開（他の人には件名が見えません）</label>' +
        '<label class="chk" id="peTeamsRow"><input type="checkbox" id="peTeams"> Teams会議にする（会議のURLを予定に付けます）</label>' +
        '<div class="f"><span>メモ</span><textarea id="peMemo" rows="4" style="border:1px solid #dde2ec;border-radius:4px;padding:6px 8px;font-size:13px;font-family:inherit;resize:vertical"></textarea></div>' +
      '</div><div class="note" id="peNote"></div></div>' +
      '<div class="ft"><span class="msg" id="peMsg"></span><button class="act" id="peCancel">キャンセル</button><button class="act pri" id="peSave">保存</button></div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('on'); });
    $('peCancel').onclick = () => m.classList.remove('on');
    $('peSave').onclick = save;
    $('peAllDay').addEventListener('change', paintAllDay);
    $('peFromD').addEventListener('change', () => { const s = $('peFromD').value, e = $('peToD').value; if (s && (!e || e < s)) $('peToD').value = s; });
    $('peFrom').addEventListener('change', () => {
      const s = $('peFrom').value, e = $('peTo').value; if (!s) return;
      const sd = s.slice(0, 10), ed = e ? e.slice(0, 10) : '';
      if (!ed || ed < sd) $('peTo').value = sd + 'T' + (e ? e.slice(11) : s.slice(11));
    });
  }
  function allDayOn() { return $('peAllDay').checked; }
  function paintAllDay() { const on = allDayOn(); $('peTimeRow').style.display = on ? 'none' : ''; $('peDateRow').style.display = on ? '' : 'none'; }
  function range() {
    if (allDayOn()) { const a = dateToMs($('peFromD').value), b = dateToMs($('peToD').value); return { s: a, e: isNaN(b) ? NaN : b + DAY }; }
    return { s: localToMs($('peFrom').value), e: localToMs($('peTo').value) };
  }

  async function writeToken(interactive) {
    const scopes = ['Calendars.ReadWrite'], pca = H.msal(), account = H.account();
    try { return (await pca.acquireTokenSilent({ scopes, account })).accessToken; }
    catch {
      if (!interactive || (window.HanaokaAuth && HanaokaAuth.useRedirect())) return null;
      try { return (await pca.acquireTokenPopup({ scopes })).accessToken; } catch { return null; }
    }
  }
  async function send(tok, method, path, body) {
    const r = await fetch(GRAPH + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  }

  function openForm(d) {
    build();
    mode = d ? 'edit' : 'new'; cur = d || null;
    $('peHead').textContent = d ? '予定を変更する' : '予定を追加する';
    let s, e, all = false;
    if (d) { s = d.s; e = d.e; all = !!d.allDay; }
    else { const h = Math.ceil(Date.now() / 3600e3) * 3600e3; s = h; e = h + 3600e3; }
    $('peTitle').value = d ? String(d.t || '').replace(/^\(件名なし\)$/, '') : '';
    $('peLoc').value = d ? (d.loc || '') : '';
    $('peAllDay').checked = all;
    $('peFrom').value = msToLocal(all ? s + 9 * 3600e3 : s); $('peTo').value = msToLocal(all ? s + 17 * 3600e3 : e);
    $('peFromD').value = msToDate(s);
    const dd = toJ(e), mid = dd.getUTCHours() === 0 && dd.getUTCMinutes() === 0;
    $('peToD').value = msToDate(all && mid ? e - DAY : e);
    paintAllDay();
    $('peShowAs').value = d && SHOWAS.includes(d.showAs) ? d.showAs : 'busy';
    $('pePrivate').checked = !!d && (d.sens === 'private' || d.sens === 'confidential');
    $('peTeams').checked = false;
    $('peTeamsRow').style.display = (!d || !d.online) ? '' : 'none';      /* すでにTeams会議なら出さない */
    $('peMemo').value = d ? String(d.body || '').trim() : '';
    const notes = [];
    if (d && d.others) notes.push(`<b>この予定には他の参加者（${d.others}人）がいます。変更は参加者にも通知されます。</b>`);
    if (d && d.facs && d.facs.length) notes.push('営業車・会議室が入っています。時間を変えて断られたものがあれば、自動で元の時間に戻します。');
    if (d && d.body && String(d.body).trim()) notes.push('メモを書き換えると、元の書式（太字・表など）は失われ、文字だけの内容になります。');
    $('peNote').innerHTML = notes.join('<br>') || '保存すると、あなたのOutlookの予定表に反映されます。';
    $('peMsg').textContent = ''; $('peMsg').className = 'msg';
    $('peSave').disabled = false;
    $('mEvEdit').classList.add('on');
  }

  async function save() {
    const msg = $('peMsg'), btn = $('peSave');
    const title = $('peTitle').value.trim();
    if (!title) { msg.textContent = '件名を入力してください'; msg.className = 'msg ng'; return; }
    const { s, e } = range();
    if (isNaN(s) || isNaN(e) || e <= s) { msg.textContent = '開始と終了を確認してください（終了は開始より後）'; msg.className = 'msg ng'; return; }
    const d = mode === 'edit' ? cur : null;
    const allDay = allDayOn(), timeChanged = !d || s !== d.s || e !== d.e || allDay !== !!d.allDay;
    btn.disabled = true; msg.textContent = '保存中...'; msg.className = 'msg';
    const tok = await writeToken(true);
    if (!tok) {
      msg.innerHTML = '予定の書き込み権限が取得できません。いったんサインアウトして入り直すか、<a href="https://outlook.office.com/calendar/" target="_blank" rel="noopener noreferrer">Outlook</a> で行ってください';
      msg.className = 'msg ng'; btn.disabled = false; return;
    }
    const body = { subject: title, location: { displayName: $('peLoc').value.trim() }, showAs: $('peShowAs').value,
      sensitivity: $('pePrivate').checked ? 'private' : 'normal' };
    if (!d || timeChanged) Object.assign(body, { isAllDay: allDay, start: { dateTime: wallOf(s), timeZone: 'Tokyo Standard Time' }, end: { dateTime: wallOf(e), timeZone: 'Tokyo Standard Time' } });
    const memo = $('peMemo').value.trim();
    if (!d ? !!memo : memo !== String(d.body || '').trim()) body.body = { contentType: 'text', content: memo };
    if ($('peTeams').checked && (!d || !d.online)) Object.assign(body, { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' });
    let r;
    if (!d) {
      body.transactionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
      r = await send(tok, 'POST', '/me/events', body);
    } else r = await send(tok, 'PATCH', `/me/events/${d.id}`, body);
    if (r.status !== 200 && r.status !== 201) {
      msg.textContent = `保存できませんでした（${r.status} ${r.body?.error?.message || ''}）`; msg.className = 'msg ng'; btn.disabled = false; return;
    }
    /* 営業車・会議室が入っている予定の時間を変えたら、断られていないか確かめ、断られたら元の時間に戻す */
    if (d && timeChanged && d.facs && d.facs.length) {
      msg.textContent = '車・会議室の承諾を確認中...';
      let declined = [];
      for (let i = 0; i < 4; i++) {
        await sleep(i === 0 ? 2000 : 2500);
        const g = await send(tok, 'GET', `/me/events/${d.id}?$select=attendees`);
        const res = ((g.body && g.body.attendees) || []).filter(a => a.type === 'resource');
        declined = res.filter(a => a.status?.response === 'declined');
        if (res.every(a => { const x = a.status?.response || 'none'; return x !== 'none' && x !== 'notResponded'; })) break;
      }
      if (declined.length) {
        await send(tok, 'PATCH', `/me/events/${d.id}`, { isAllDay: !!d.allDay, start: { dateTime: wallOf(d.s), timeZone: 'Tokyo Standard Time' }, end: { dateTime: wallOf(d.e), timeZone: 'Tokyo Standard Time' } });
        msg.textContent = `新しい時間は ${declined.map(a => a.emailAddress?.name || '').join('、')} が他の予約と重なるため、時間は元に戻しました（件名などの変更は反映済み）`;
        msg.className = 'msg ng'; btn.disabled = false; if (H.reload) await H.reload(); return;
      }
    }
    btn.disabled = false; $('mEvEdit').classList.remove('on');
    if (H.reload) await H.reload();
    if (H.snack) H.snack(d ? '予定を変更しました' : '予定を追加しました');
  }

  async function remove(d) {
    if (!d || !d.isOrg || d.recurring) return false;
    let q = `予定「${d.t}」を削除します。\n\n　${d.allDay ? jFull(d.s).slice(0, 10) + '（終日）' : jFull(d.s) + ' 〜 ' + jFull(d.e)}\n`;
    if (d.facs && d.facs.length) q += `\n含まれる営業車・会議室の枠も空きに戻ります。\n`;
    if (d.others) q += `\n★他の参加者（${d.others}人）にも取消が通知されます。★\n`;
    q += `\nOutlook の「削除済みアイテム」に残るので、必要なら戻せます。よろしいですか？`;
    if (!confirm(q)) return false;
    const tok = await writeToken(true);
    if (!tok) { if (H.snack) H.snack('予定の書き込み権限が取得できません。サインインし直してください'); return false; }
    const r = await send(tok, 'DELETE', `/me/events/${d.id}`);
    if (r.status >= 300) { if (H.snack) H.snack(`削除できませんでした（${r.status}）`); return false; }
    if (H.reload) await H.reload();
    if (H.snack) H.snack('予定を削除しました');
    return true;
  }

  window.MyEvent = {
    init(h) { H = h; },
    openNew() { openForm(null); },
    openEdit(d) { if (d) openForm(d); },
    remove,
    canEdit: d => !!d && !!d.isOrg && !d.recurring
  };
})();
