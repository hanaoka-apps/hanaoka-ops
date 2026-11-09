/* ============================================================
   施設・備品予約：管理者の道具（reserve_admin.js）
   ------------------------------------------------------------
   古い「デモ機」画面にあった保守の道具を、施設・備品予約の「🔧 管理」から使えるようにしたもの。
   管理者にだけボタンが出る（reserve.html の IS_ADMIN）。管理者以外の画面では、このファイルを読み込まない。
   ・準備状況（マスター・履歴の列があるか）／不足している列の作成／新しい履歴リストの作成／表示名を日本語に
   ・既存の履歴に「予約セットID」を一括付与
   ・予約対象の一括判定（部品・オプション → 予約対象＝いいえ）
   ・予約対象外を戻す（予約対象＝いいえ になっている機体を選んで はい に戻す。ショールーム機を予約できるようにしたときに作った）
   ・占有情報（LockData）の再構築（履歴から作り直す）
   ・読み込み状況（デモ機・営業車・会議室が全部読めているか）
   中身は demo_reserve.html の同名の処理と同じ。呼び出し元（reserve.html）が、通信・定数・いまの一覧を ctx で渡す。
   ============================================================ */
(function () {
  'use strict';
  const TEXT = (max = 255) => ({ text: { allowMultipleLines: false, maxLength: max, textType: 'plain' } });
  const NUM  = () => ({ number: { decimalPlaces: 'none', displayAs: 'number' } });
  const DATE = () => ({ dateTime: { displayAs: 'standard', format: 'dateTime' } });
  /* 履歴リストの列定義。name＝内部名、jp＝日本語の表示名（demo_reserve.html と同じ） */
  const HIST_COLUMNS = [
    { name: 'MachineItemId',     jp: 'マスターID',     def: NUM() },
    { name: 'SourceEquipmentId', jp: '元設備ID',       def: NUM(), indexed: true },
    { name: 'DemoMachineName',   jp: 'デモ機名',       def: TEXT() },
    { name: 'LockToken',         jp: '占有トークン',   def: TEXT(32) },
    { name: 'ReservationStart',  jp: '予約開始',       def: DATE(), indexed: true },
    { name: 'ReservationEnd',    jp: '予約終了',       def: DATE() },
    { name: 'LoanStatus',        jp: '貸出状態',       def: { choice: { allowTextEntry: false, choices: ['予約', '取消'], displayAs: 'dropDownMenu' } },
                                                       defaultValue: { value: '予約' }, indexed: true },
    { name: 'RequesterEmail',    jp: '依頼者メール',   def: TEXT(), indexed: true },
    { name: 'RequesterName',     jp: '依頼者名',       def: TEXT() },
    { name: 'CustomerName',      jp: '顧客名',         def: TEXT() },
    { name: 'Destination',       jp: '行き先',         def: TEXT() },
    { name: 'Notes',             jp: '備考',           def: { text: { allowMultipleLines: true, linesForEditing: 4, textType: 'plain' } } },
    { name: 'BookingSetId',      jp: '予約セットID',   def: TEXT(64), indexed: true },
    { name: 'CancelledByEmail',  jp: '取消した人メール', def: TEXT() },
    { name: 'CancelledByName',   jp: '取消した人',       def: TEXT() },
    { name: 'CancelledAt',       jp: '取消日時',         def: DATE() }
  ];

  let C = null;            /* 呼び出し元から渡される道具立て */
  let K = null;            /* 列の有無（開くたびに読み直す） */
  let PART_TARGETS = [];
  const el = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ok = () => '<span class="ok">あり</span>', ng = () => '<span class="ng">未作成</span>';
  function out(html, cls) { const o = el('adminOut'); if (o) { o.className = cls || ''; o.innerHTML = html; } }

  async function gCreateColumn(listId, def, displayJa) {
    const col = await C.gPost(`/sites/${C.SITE_ID}/lists/${listId}/columns`, def);
    if (displayJa) {
      const t = await C.getToken();
      await fetch(`${C.GRAPH_BASE}/sites/${C.SITE_ID}/lists/${listId}/columns/${col.id}`, { method: 'PATCH',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: displayJa }) });
    }
    return col;
  }

  async function checkCols() {
    const mc = await C.gGet(`/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/columns?$select=name`);
    const mn = new Set((mc.value || []).map(c => c.name));
    const hc = await C.gGet(`/sites/${C.SITE_ID}/lists/${C.listHist()}/columns?$select=name`);
    const hn = new Set((hc.value || []).map(c => c.name));
    return { lock: mn.has(C.LOCK_COL), resv: mn.has(C.RESV_COL), token: hn.has('LockToken'), mid: hn.has('MachineItemId'),
      cancel: hn.has('CancelledByEmail'), setId: hn.has('BookingSetId') };
  }

  /* ---------------- 画面 ---------------- */
  async function paint() {
    const body = el('adminBody');
    body.innerHTML = '<div class="cnt">準備状況を確認中...</div>';
    try { K = await checkCols(); }
    catch (e) { body.innerHTML = `<div class="msg ng">準備状況の取得に失敗しました：${esc(e.message)}</div>`; return; }
    const histNew = C.listHist() !== C.LIST_HIST_OLD;
    const all = K.lock && K.resv && K.token && K.mid && K.cancel && K.setId;
    body.innerHTML =
      `<div class="adm"><b>準備状況</b>` +
      `<div class="st-row"><code>${C.LOCK_COL}</code>（占有・CASの対象）: ${K.lock ? ok() : ng()}` + (K.lock ? '' : ' — <b>予約登録は無効です。</b>') + `</div>` +
      `<div class="st-row"><code>${C.RESV_COL}</code>（予約対象フラグ）: ${K.resv ? ok() : ng()}` + (K.resv ? '' : ' — 当面はデモ機名から部品・オプションを推定します') + `</div>` +
      `<div class="st-row">履歴リスト: ` + (histNew
          ? `<span class="ok">${esc(C.HIST_NAME)}</span> <code>${esc(C.listHist().slice(0, 8))}…</code>（本番用）`
          : `<span class="ng">旧リスト</span> <code>${esc(C.listHist().slice(0, 8))}…</code> <button class="act" data-a="mklist">新しい履歴リストを作成する</button>`) + `</div>` +
      `<div class="st-row">履歴の <code>LockToken</code>: ${K.token ? ok() : ng()}` + (K.token ? '' : ' — <b>これが無いと予約を保存できません</b>') + `</div>` +
      `<div class="st-row">履歴の取消記録（<code>CancelledByEmail</code> ほか3列）: ${K.cancel ? ok() : ng()}` + (K.cancel ? '' : ' — 取消は動きますが、<b>誰が取消したかが残りません</b>') + `</div>` +
      `<div class="st-row">履歴の <code>BookingSetId</code>（セット予約の後編集用）: ${K.setId ? ok() : ng()}` + (K.setId ? '' : ' — 無いと、まとめて予約した後の追加・削除がまとめて見られません') + `</div>` +
      `<div class="st-row" style="color:var(--muted)">履歴の取得: ${C.fetchMode() === 'server' ? '<span class="ok">サーバー側で絞り込み</span>' : C.fetchMode() === 'client' ? '<span class="ng">全件取得して絞り込み</span> — <code>ReservationStart</code> にインデックスが無いため。<b>5000件を超えると動かなくなります</b>（リストの設定 → インデックス付き列 で追加）' : '（まだ読み込んでいません）'}</div>` +
      (all ? '' : `<div class="st-row"><button class="act pri" data-a="mkcol">不足している列を作成する</button> <span class="cnt">マスターと履歴の両方をまとめて作ります</span></div>`) +
      `</div>` +
      `<div class="adm"><b>保守の道具</b>` +
      `<div class="st-row" style="gap:6px;flex-wrap:wrap">` +
        `<button class="act" data-a="parts">予約対象を一括判定…</button>` +
        `<button class="act" data-a="restore">予約対象外を戻す…</button>` +
        `<button class="act" data-a="rebuild">占有情報を再構築</button>` +
        (histNew ? `<button class="act" data-a="names">表示名を日本語にする</button>` : '') +
        (K.setId ? `<button class="act" data-a="setid">既存の履歴に予約セットIDを一括付与</button>` : '') +
      `</div>` +
      `<div class="cnt">部品・オプションを いいえ に／履歴から <code>LockData</code> を作り直す／セットIDは件名・期間・顧客名が同じ行をまとめます（何度実行しても安全）</div></div>` +
      `<div class="adm"><b>読み込み状況</b>${readState()}</div>` +
      `<div id="adminOut"></div>`;
    body.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => run(b.dataset.a); });
  }

  /* デモ機・営業車・会議室が、全部読めているか */
  function readState() {
    const res = C.resources(), src = C.src(), st = [...new Set(C.status())];
    const by = k => res.filter(r => r.k === k);
    const demo = by('demo'), car = by('car'), room = by('room');
    const bad = res.filter(r => src[r.key] === 'error'), viaList = car.filter(r => src[r.key] === 'list');
    const capOk = room.filter(r => r.cap != null).length;
    let h = `<div class="st-row">デモ機 <b>${demo.length}</b>台 ／ 営業車 <b>${car.length}</b>台 ／ 会議室 <b>${room.length}</b>室`
      + `<span class="cnt">（部品・予約対象外を除く。いま画面に出ている数）</span></div>`;
    const noMail = C.carNoMail ? C.carNoMail() : [];
    h += `<div class="st-row">営業車：リソースメールが分からず出せない <span class="${noMail.length ? 'ng' : 'ok'}">${noMail.length}台</span>${noMail.length ? `（${esc(noMail.join('、'))}。営業車管理一覧にメールを入れてください）` : ''} ／ リスト補完 ${viaList.length}台 ／ 読めず ${car.filter(r => src[r.key] === 'error').length}台</div>`;
    h += `<div class="st-row">会議室：収容人数あり <span class="${capOk ? 'ok' : 'ng'}">${capOk}</span>室 ／ 読めず ${room.filter(r => src[r.key] === 'error').length}室`
      + (room.length && !capOk ? ` <span class="cnt">（Place.Read.All が未同意か、収容人数が未設定です）</span>` : '') + `</div>`;
    if (C.nameMapTried && C.nameMapTried() && !C.nameMapOk()) h += `<div class="st-row ng">会議室の予約者名：社員名簿を読めませんでした（GroupMember.Read.All / User.Read.All の同意を確認してください）。予約者名が「使用中」になります</div>`;
    if (bad.length) h += `<div class="st-row ng">読めなかった：${esc(bad.map(r => r.n).join('、'))}</div>`;
    if (st.length) h += `<div class="st-row ng">${st.map(esc).join('<br>')}</div>`;
    else if (!bad.length) h += `<div class="st-row"><span class="ok">問題は出ていません</span></div>`;
    h += `<div class="st-row"><a href="usage_stats.html">利用状況（誰が何を使っているか）を見る</a></div>`;
    return h;
  }

  async function run(a) {
    const fn = { mkcol: makeColumns, mklist: createHistList, names: fixDisplayNames, setid: backfillSetIds, parts: previewParts, restore: previewRestore, rebuild: rebuildLocks }[a];
    if (!fn) return;
    C.usage('admin_' + a);
    try { await fn(); } catch (e) { C.snack('エラー: ' + e.message); out(`<div class="msg ng">エラー：${esc(e.message)}</div>`); console.error(e); }
  }

  /* ---------------- 不足している列の作成 ---------------- */
  async function makeColumns() {
    const done = [];
    C.snack('列を作成中...');
    if (!K.lock) {
      await gCreateColumn(C.LIST_MASTER, { name: C.LOCK_COL, displayName: C.LOCK_COL, description: '予約の占有区間（CASの対象）。アプリが管理するので手で編集しないでください',
        enforceUniqueValues: false, indexed: false, hidden: false,
        text: { allowMultipleLines: true, appendChangesToExistingText: false, linesForEditing: 4, maxLength: 8000, textType: 'plain' } }, '占有');
      done.push(C.LOCK_COL);
    }
    if (!K.resv) {
      await gCreateColumn(C.LIST_MASTER, { name: C.RESV_COL, displayName: C.RESV_COL, description: '週間表に並べる対象か。部品・オプションは いいえ',
        defaultValue: { value: '1' }, indexed: false, hidden: false, boolean: {} }, '予約対象');
      done.push(C.RESV_COL);
    }
    const H = C.listHist();
    if (!K.token) {
      await gCreateColumn(H, { name: 'LockToken', displayName: 'LockToken', description: '占有情報との対応キー。アプリが設定します',
        indexed: false, text: { allowMultipleLines: false, maxLength: 32, textType: 'plain' } }, '占有トークン');
      done.push('LockToken（履歴）');
    }
    if (!K.mid) {
      await gCreateColumn(H, { name: 'MachineItemId', displayName: 'MachineItemId', description: 'マスターのリストアイテムID（CASの対象特定用）',
        indexed: false, number: { decimalPlaces: 'none', displayAs: 'number', maximum: 1e9, minimum: 0 } }, 'マスターID');
      done.push('MachineItemId（履歴）');
    }
    if (!K.cancel) {
      for (const c of HIST_COLUMNS.filter(h => h.name.startsWith('Cancelled'))) {
        await gCreateColumn(H, { name: c.name, displayName: c.name, description: '取消の記録。アプリが設定します', indexed: false, ...c.def }, c.jp);
        done.push(`${c.name}（履歴）`);
      }
    }
    if (!K.setId) {
      await gCreateColumn(H, { name: 'BookingSetId', displayName: 'BookingSetId', description: 'まとめて予約した機体を束ねるID。アプリが設定します',
        indexed: true, text: { allowMultipleLines: false, maxLength: 64, textType: 'plain' } }, '予約セットID');
      done.push('BookingSetId（履歴）');
    }
    C.snack(done.length ? `列を作成しました: ${done.join(' / ')}` : '不足している列はありません');
    await C.reload(); await paint();
    out(done.length ? `<div class="msg ok">列を作成しました：${esc(done.join(' / '))}</div>` : '<div class="cnt">不足している列はありません</div>');
  }

  /* ---------------- 新しい履歴リストの作成 ---------------- */
  async function createHistList() {
    if (!confirm(`新しい履歴リスト「${C.HIST_NAME}」を作成します（${HIST_COLUMNS.length + 1}列）。\n\n`
      + `・内部名は英語で確定（Graphで作るため化けません）\n・表示名はあとから日本語に変更します\n・旧リストのデータは移行しません\n\n既に同名のリストがある場合は中止します。`)) return;
    C.snack('リストを作成中...');
    const chk = await C.gGet(`/sites/${C.SITE_ID}/lists?$select=id,displayName&$top=200`);
    if ((chk.value || []).some(l => l.displayName === C.HIST_NAME)) {
      C.snack(`「${C.HIST_NAME}」は既に存在します。再読込します`);
      try { sessionStorage.removeItem('listId:' + C.HIST_NAME); } catch {}
      await C.reload(); await paint(); return;
    }
    const created = await C.gPost(`/sites/${C.SITE_ID}/lists`, {
      displayName: C.HIST_NAME, list: { template: 'genericList' },
      columns: HIST_COLUMNS.map(c => ({ name: c.name, displayName: c.name, ...(c.indexed ? { indexed: true } : {}), ...(c.defaultValue ? { defaultValue: c.defaultValue } : {}), ...c.def }))
    });
    const newId = created.id;
    const rn = await renameHistColumns(newId);
    const after = await C.gGet(`/sites/${C.SITE_ID}/lists/${newId}/columns?$select=name,displayName,indexed`);
    const rows = (after.value || []).filter(c => c.name === 'Title' || HIST_COLUMNS.some(h => h.name === c.name));
    const missing = HIST_COLUMNS.filter(h => !rows.some(r => r.name === h.name)).map(h => h.name);
    const noIdx = HIST_COLUMNS.filter(h => h.indexed).map(h => h.name).filter(n => !rows.some(r => r.name === n && r.indexed));
    try { sessionStorage.setItem('listId:' + C.HIST_NAME, newId); } catch {}
    await C.reload(); await paint();
    out(`<div class="msg ok"><b>「${esc(C.HIST_NAME)}」を作成しました</b></div>`
      + `<dl class="adl"><dt>リストID</dt><dd><code>${esc(newId)}</code></dd>`
      + `<dt>作成した列</dt><dd>${rows.length}列${missing.length ? ` <span class="ng">／作成できなかった列: ${esc(missing.join(', '))}</span>` : ''}</dd>`
      + `<dt>表示名の変更</dt><dd>${rn.ng.length ? `<span class="ng">${rn.ng.length}件 失敗</span> / 成功 ${rn.ok.length}件（動作には影響しません。「表示名を日本語にする」で再試行できます）` : `<span class="ok">全${rn.ok.length}件成功</span>`}</dd>`
      + `<dt>インデックス</dt><dd>${noIdx.length ? `<span class="ng">${esc(noIdx.join(', '))} に付きませんでした</span> — リストの設定 → インデックス付き列 で手動追加してください（無いと件数が増えたとき絞り込みが失敗します）` : '<span class="ok">付きました</span>'}</dd>`
      + `<dt>次にやること</dt><dd>このまま使えます。旧リストは、Teams通知フローの作り直しが済んでから削除してください</dd></dl>`);
  }
  async function renameHistColumns(listId) {
    const want = new Map([...HIST_COLUMNS.map(c => [c.name, c.jp]), ['Title', '予約件名']]);
    const cols = await C.gGet(`/sites/${C.SITE_ID}/lists/${listId}/columns?$select=id,name,displayName`);
    const todo = (cols.value || []).filter(c => want.has(c.name) && c.displayName !== want.get(c.name));
    const okL = [], ngL = [], t = await C.getToken();
    for (const c of todo) {
      const r = await fetch(`${C.GRAPH_BASE}/sites/${C.SITE_ID}/lists/${listId}/columns/${c.id}`, { method: 'PATCH',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: want.get(c.name) }) });
      if (r.ok) okL.push(c.name);
      else { let b = null; try { b = await r.json(); } catch {} ngL.push({ name: c.name, msg: `${c.name}: [${r.status}] ${b?.error?.code || ''} ${b?.error?.message || ''}`.trim() }); }
      await C.sleep(120);
    }
    return { ok: okL, ng: ngL, skipped: (cols.value || []).length - todo.length };
  }
  async function fixDisplayNames() {
    C.snack('表示名を変更中...');
    const r = await renameHistColumns(C.listHist());
    out(`<dl class="adl"><dt>成功</dt><dd>${r.ok.length ? `${r.ok.length}件 <span class="cnt">${esc(r.ok.join(', '))}</span>` : '0件'}</dd>`
      + `<dt>対象外</dt><dd>${r.skipped}件（すでに日本語、または対象外の列）</dd>`
      + `<dt>失敗</dt><dd>${r.ng.length ? `<span class="ng">${r.ng.length}件</span><br>${r.ng.map(x => esc(x.msg)).join('<br>')}<br><span class="cnt">SharePoint の画面（リストの設定 → 列）で直してください。内部名は変わらないのでアプリには影響しません。</span>` : '<span class="ok">なし</span>'}</dd></dl>`);
  }

  /* ---------------- 予約セットIDの一括付与 ---------------- */
  async function backfillSetIds() {
    if (!K.setId) { C.snack('BookingSetId 列がありません。先に列を作成してください'); return; }
    C.snack('履歴を読み込み中...');
    const items = await C.gGetAll(`/sites/${C.SITE_ID}/lists/${C.listHist()}/items?$expand=fields&$top=500`);
    const targets = items.filter(it => !(it.fields || {}).BookingSetId);
    if (!targets.length) { C.snack('すべての履歴に予約セットIDが付与済みです'); out('<div class="msg ok">すべての履歴に予約セットIDが付与済みです</div>'); return; }
    const groups = new Map();
    for (const it of targets) {
      const f = it.fields || {};
      const key = [f.Title || '', f.ReservationStart || '', f.ReservationEnd || '', f.CustomerName || ''].join('');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    if (!confirm(`予約セットIDが未設定の履歴 ${targets.length}件を、${groups.size}件のセットにまとめます。\n\n件名・期間・顧客名が完全に一致する行を同じセットとして扱います\n（1件しかない行もそのまま1台のセットになります）。\n\n実行しますか？`)) { C.snack('中止しました'); return; }
    const writes = [];
    for (const rows of groups.values()) { const sid = C.newSetId(); rows.forEach(it => writes.push({ id: it.id, setId: sid })); }
    const res = await C.gBatch(writes.map(w => ({ method: 'PATCH', url: `/sites/${C.SITE_ID}/lists/${C.listHist()}/items/${w.id}/fields`,
      headers: { 'Content-Type': 'application/json' }, body: { BookingSetId: w.setId } })));
    const n = res.filter(r => r.status < 300).length, bad = res.length - n;
    C.snack(`予約セットIDを付与しました：${n}件` + (bad ? ` / 失敗 ${bad}件` : ''));
    out(`<div class="msg ${bad ? 'ng' : 'ok'}">予約セットIDを付与しました：${n}件${bad ? ` / 失敗 ${bad}件` : ''}</div>`);
    await C.reload();
  }

  /* ---------------- 予約対象の一括判定 ---------------- */
  function previewParts() {
    if (!K.resv) { C.snack('IsReservable 列がありません。先に列を作成してください'); return; }
    const cand = C.machines().filter(m => (m.part || m.ng) && m.resv !== false);
    PART_TARGETS = cand;
    const rows = cand.slice().sort((a, b) => a.cat.localeCompare(b.cat) || a.n.localeCompare(b.n))
      .map(m => `<tr><td>${m.id}</td><td>${esc(m.n)}</td><td>${m.part ? '部品' : ''}${m.part && m.ng ? '+' : ''}${m.ng ? 'ショールーム機' : ''}</td></tr>`).join('');
    out(`<b>予約対象を いいえ にする候補：${cand.length}件</b>` + (cand.length
      ? `<div style="max-height:34vh;overflow:auto;margin-top:6px"><table class="adt"><thead><tr><th>#ID</th><th>デモ機名</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table></div>`
        + `<div class="cnt" style="margin:6px 0">判定はデモ機名のパターン（部品・オプション）です。誤判定があればここで気づけます。実行後も SharePoint の画面で個別に直せます。</div>`
        + `<button class="act pri" id="admPartsRun">この ${cand.length}件を「予約対象＝いいえ」にする</button> <span id="admPartsMsg" class="msg"></span>`
      : `<div class="cnt">対象はありません。すでに全件処理済みです。</div>`));
    const b = el('admPartsRun'); if (b) b.onclick = runParts;
  }
  async function runParts() {
    const btn = el('admPartsRun'), msg = el('admPartsMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = `${PART_TARGETS.length}件を更新中...`;
    try {
      const res = await C.gBatch(PART_TARGETS.map(m => ({ method: 'PATCH', url: `/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/items/${m.itemId}/fields`,
        headers: { 'Content-Type': 'application/json' }, body: { [C.RESV_COL]: false } })));
      const bad = res.filter(r => r.status >= 300);
      msg.className = 'msg ' + (bad.length ? 'ng' : 'ok');
      msg.textContent = bad.length ? `成功 ${res.length - bad.length}件 / 失敗 ${bad.length}件（${bad[0].body?.error?.message || bad[0].status}）` : `${res.length}件を「予約対象＝いいえ」にしました`;
      await C.reload();
    } catch (e) { msg.className = 'msg ng'; msg.textContent = 'エラー: ' + e.message; }
    finally { btn.disabled = false; }
  }

  /* ---------------- 予約対象外を戻す ----------------
     「予約対象＝いいえ」になっている機体（部品を除く）を並べ、選んだものを「はい」に戻す。
     ショールーム機は最初から選んだ状態にする（2026-11-09 に予約できるようにしたため）。 */
  let RESTORE = [];
  function previewRestore() {
    if (!K.resv) { C.snack('IsReservable 列がありません'); return; }
    RESTORE = C.machines().filter(m => m.resv === false && !m.part)
      .sort((a, b) => a.cat.localeCompare(b.cat) || a.n.localeCompare(b.n));
    const rows = RESTORE.map((m, i) => `<tr><td><input type="checkbox" data-ri="${i}"${/ショールーム/.test(m.cat) ? ' checked' : ''}></td><td>${m.id}</td><td>${esc(m.n)}</td><td>${esc(m.cat)}</td></tr>`).join('');
    out(`<b>予約対象＝いいえ になっている機体（部品を除く）：${RESTORE.length}台</b>` + (RESTORE.length
      ? `<div style="max-height:34vh;overflow:auto;margin-top:6px"><table class="adt"><thead><tr><th></th><th>#ID</th><th>デモ機名</th><th>区分</th></tr></thead><tbody>${rows}</tbody></table></div>`
        + `<div class="cnt" style="margin:6px 0">チェックした機体を「予約対象＝はい」に戻します。ショールーム機は最初からチェックしています。廃棄・故障などで予約させたくない機体は、チェックを外してください。</div>`
        + `<button class="act pri" id="admRestoreRun">チェックした機体を予約できるようにする</button> <span id="admRestoreMsg" class="msg"></span>`
      : `<div class="cnt">予約対象＝いいえ になっている機体はありません（部品を除く）。</div>`));
    const b = el('admRestoreRun'); if (b) b.onclick = runRestore;
  }
  async function runRestore() {
    const btn = el('admRestoreRun'), msg = el('admRestoreMsg');
    const pick = [...document.querySelectorAll('#adminOut input[data-ri]')].filter(x => x.checked).map(x => RESTORE[Number(x.dataset.ri)]).filter(Boolean);
    if (!pick.length) { msg.className = 'msg ng'; msg.textContent = '機体を選んでください'; return; }
    if (!confirm(`${pick.length}台を「予約対象＝はい」に戻します。戻すと、誰でも予約できるようになります。`)) return;
    btn.disabled = true; msg.className = 'msg'; msg.textContent = `${pick.length}台を更新中...`;
    try {
      const res = await C.gBatch(pick.map(m => ({ method: 'PATCH', url: `/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/items/${m.itemId}/fields`,
        headers: { 'Content-Type': 'application/json' }, body: { [C.RESV_COL]: true } })));
      const bad = res.filter(r => r.status >= 300);
      msg.className = 'msg ' + (bad.length ? 'ng' : 'ok');
      msg.textContent = bad.length ? `成功 ${res.length - bad.length}台 / 失敗 ${bad.length}台（${bad[0].body?.error?.message || bad[0].status}）` : `${res.length}台を予約できるようにしました`;
      await C.reload();
    } catch (e) { msg.className = 'msg ng'; msg.textContent = 'エラー: ' + e.message; }
    finally { btn.disabled = false; }
  }

  /* ---------------- 占有情報の再構築 ----------------
     LockData は「原子的にCASできる対象」であることだけが仕事で、中身は履歴から100%導出できる。
     これ1回で、①LockData 列を作る前に登録された予約の取り込み ②履歴の書き込みに失敗して残った幽霊ロックの削除
     ③取消済み・期限切れのエントリの除去 が同時に片付く。
     ※ 誰かが予約操作中に実行すると、まだ履歴に書かれていないロックを消す可能性がある。他の人が触っていないときに実行する。 */
  async function rebuildLocks() {
    if (!K.lock) { C.snack('LockData 列がありません'); return; }
    if (!K.token) { C.snack('履歴に LockToken 列がありません。先に列を作成してください'); return; }
    C.snack('履歴から占有情報を計算中...');
    const now = Date.now(), cutoff = now - C.DAY, P = C.P, H = C.listHist();
    const rows = (await C.gGetAll(`/sites/${C.SITE_ID}/lists/${H}/items?$expand=fields&$top=500`)).filter(r => {
      const f = r.fields || {};
      return f.LoanStatus !== '取消' && f.ReservationStart && f.ReservationEnd && P(f.ReservationEnd) >= cutoff;
    });
    const orphans = rows.filter(r => !(r.fields || {}).LockToken);
    const issued = new Map(); orphans.forEach(r => issued.set(r.id, C.newToken()));
    const byMachine = new Map();
    rows.forEach(r => {
      const f = r.fields, mid = Number(f.SourceEquipmentId) || 0; if (!mid) return;
      if (!byMachine.has(mid)) byMachine.set(mid, []);
      byMachine.get(mid).push({ token: f.LockToken || issued.get(r.id), s: P(f.ReservationStart), e: P(f.ReservationEnd) });
    });
    /* いまのマスター（占有の現物）を読み直して比べる */
    const masters = await C.gGetAll(`/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/items?$expand=fields&$top=500`);
    const plan = [];
    for (const it of masters) {
      const f = it.fields || {}, id = Number(f.SourceEquipmentId) || 0; if (!id) continue;
      const want = (byMachine.get(id) || []).sort((a, b) => a.s - b.s);
      const have = C.prune(C.parseOcc(f[C.LOCK_COL] || ''), now).sort((a, b) => a.s - b.s);
      if (C.dumpOcc(want) !== C.dumpOcc(have)) plan.push({ itemId: it.id, name: f.Title || '', id, want, have });
    }
    if (!plan.length && !orphans.length) { C.snack('占有情報は履歴と一致しています。変更ありません'); out('<div class="msg ok">占有情報は履歴と一致しています。変更ありません</div>'); return; }
    const lines = plan.slice(0, 25).map(p => {
      const add = p.want.length - p.have.length;
      return `  ${p.name} #${p.id}: ${p.have.length} → ${p.want.length}` + (add > 0 ? '（取り込み）' : add < 0 ? '（削除）' : '（内容差異）');
    }).join('\n');
    const more = plan.length > 25 ? `\n  …他 ${plan.length - 25}機体` : '';
    if (!confirm(`履歴から占有情報を作り直します。\n\n有効な予約 ${rows.length}件` + (orphans.length ? `（うち ${orphans.length}件はトークン未設定 → 発行します）` : '') + `\n更新する機体 ${plan.length}件\n\n${lines}${more}\n\n`
      + `※ 他の方が予約操作中だと、まだ履歴に反映されていないロックを消す可能性があります。\n   誰も触っていないタイミングで実行してください。`)) { C.snack('中止しました'); return; }
    if (orphans.length) {
      const res = await C.gBatch(orphans.map(r => ({ method: 'PATCH', url: `/sites/${C.SITE_ID}/lists/${H}/items/${r.id}/fields`,
        headers: { 'Content-Type': 'application/json' }, body: { LockToken: issued.get(r.id) } })));
      const bad = res.filter(x => x.status >= 300);
      if (bad.length) { C.snack(`トークンの書き戻しに失敗 ${bad.length}件: ${bad[0].body?.error?.message || bad[0].status}`); return; }
    }
    let okN = 0, ngN = 0;
    for (const p of plan) {
      let done = false;
      for (let n = 1; n <= 3 && !done; n++) {
        const it = await C.gGet(`/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/items/${p.itemId}?$expand=fields`);
        const r = await C.gPatchIf(`/sites/${C.SITE_ID}/lists/${C.LIST_MASTER}/items/${p.itemId}/fields`, { [C.LOCK_COL]: C.dumpOcc(p.want) }, it['@odata.etag']);
        if (r.status === 200) { okN++; done = true; }
        else if (r.status === 412) await C.sleep(80 * n);
        else { ngN++; done = true; }
      }
      if (!done) ngN++;
    }
    const m = `再構築完了：${okN}機体を更新` + (ngN ? ` / ${ngN}件失敗` : '') + (orphans.length ? ` / トークン${orphans.length}件を発行` : '');
    C.snack(m); out(`<div class="msg ${ngN ? 'ng' : 'ok'}">${esc(m)}</div>`);
    await C.reload();
  }

  window.ReserveAdmin = {
    open(ctx) { C = ctx; el('adminBody').innerHTML = ''; C.openM('mAdmin'); return paint(); },
    refresh() { if (C && el('mAdmin').classList.contains('on')) return paint(); }
  };
})();
