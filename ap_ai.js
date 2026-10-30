/* ap_ai.js — 支払の請求書を Claude API で読む（Power Automate「AI_Claude中継」経由。API キーは PA だけが持つ）
   流れ：ワークフローのサイトの AI_Request に行を作る → PA を呼ぶ（no-cors・text/plain。WF_Action と同じ）→ 行が「完了」になるまで待つ
        → 返事（答えの JSON）を ap_read.ps1 と同じ形の result.json にして /BILLS/ai_result に置く → 呼び出し側が APIntake.apply で取り込む
   指示文と答えの形：AP_Setting の ai.invoice（正本 admin/defs/ap-ai-invoice.json）。モデル：WF_Setting の ai.models（read）
   マスタ（科目・部門・内訳・過去の仕訳）は /BILLS/masters の CSV から作り、指示文と一緒にキャッシュする（2件目から安い）
   使い方：await APAI.readInvoice({ call, site, onMsg }, { apCode, invoiceId, category, location, targetYm, round, method, vendorCode, vendorName, smileAmount, file, pdfName })
          file＝PDF か画像の Blob、pdfName＝incoming での名前。戻り値 { ok, status, message }
          1件の請求書が何ファイルかに分かれているとき：files＝[{ file, name }]（file・pdfName の代わり。全部を1回で渡し、1枚の請求書として読む） */
(function () {
  'use strict';
  const WF_SITE_PATH = 'hanaokacorp.sharepoint.com:/sites/msteams_7aab51:';
  const RES = '/BILLS/ai_result', MASTERS = '/BILLS/masters';
  const RATE = { '課税10%': 0.1, '軽減8%': 0.08 };
  const WAIT_MS = 5 * 60 * 1000, POLL_MS = 3000;
  let S = null;   // 一度読んだ設定・マスタ（ページを開いている間）

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== '');
  }
  const objs = rows => { const h = rows[0] || []; return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] == null ? '' : r[i]]))); };
  async function csv(ctx, name) {
    const b = await ctx.call('GET', `/sites/${ctx.site}/drive/root:${encodeURI(MASTERS + '/' + name)}:/content`, null, null, true);
    return objs(parseCSV(new TextDecoder('utf-8').decode(await b.arrayBuffer())));
  }
  // マスタの文（科目・部門・内訳が要る科目・過去の仕訳）。scratchpad の試し（ai-eval.ps1）と同じ作り
  function mastersText(km, bm, um, jr, sq) {
    const kmT = km.filter(x => x['科目コード']).map(x => `${x['科目コード']} ${x['科目名']} ${x['既定税名'] || ''}`.trim()).join('\n');
    const bmT = bm.filter(x => x['部門名']).map(x => `${x['部門コード']} ${x['部門名']}`).join('\n');
    const ug = {}; um.forEach(x => { if (x['科目コード']) (ug[x['科目コード']] = ug[x['科目コード']] || []).push(x); });
    const umT = Object.entries(ug).filter(([, g]) => g.length <= 30 && !g.some(x => x['内訳コード'] === '000000'))
      .map(([k, g]) => `${k} ${g[0]['科目名']}：` + g.map(x => `${x['内訳コード']} ${x['略称'] || x['内訳名']}`).join(' / ')).join('\n');
    // 過去の仕訳：支払先（摘要の最初の語）ごとに、よく使う科目・部門・税（仕入高は除く。2回以上）
    const key = m => String(m || '').replace(/^\(\d+\)/, '').replace(/[　\s]+/g, ' ').trim().split(' ')[0];
    const hg = {};
    jr.filter(x => (/^000[5-7]/.test(x['科目コード']) && x['科目コード'] !== '000501') || x['科目コード'] === '000317').forEach(x => { const k = key(x['摘要']); if (k) (hg[k] = hg[k] || []).push(x); });
    const yms = [...new Set(jr.map(x => x['年月']).filter(Boolean))].sort();
    // 直近を正にする：会計（外注）の付け方は年度の変わり目などで変わる（例：2026/04 から 001110→005110）。直近6か月にある支払先は、その6か月の付け方だけを数える
    const ymEnd = yms[yms.length - 1] || '', recentFrom = (() => { const m = ymEnd.match(/^(\d{4})\/(\d{2})$/); if (!m) return ''; const d = new Date(+m[1], +m[2] - 6, 1); return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0'); })();
    const recentOf = k => { const r = hg[k].filter(x => String(x['年月'] || '') >= recentFrom); return r.length ? r : hg[k]; };
    const histT = Object.keys(hg).filter(k => hg[k].length >= 2).sort().map(k => {
      const rs = recentOf(k), c = {}; rs.forEach(x => { const s = `${x['科目コード']} ${x['科目名']}・部門 ${x['部門コード']}・${x['税区分']}` + (x['内訳'] ? `・内訳 ${x['内訳']}` : ''); c[s] = (c[s] || 0) + 1; });
      const last = hg[k].slice().sort((a, b) => String(b['伝票日付'] || b['年月']).localeCompare(String(a['伝票日付'] || a['年月'])))[0];   // 摘要の書き方をそろえるため、新しい1件の例
      return `${k}（${rs.length < hg[k].length ? `直近${rs.length}回` : `${hg[k].length}回・最後 ${last ? last['年月'] : ''}`}）：` + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}×${n}`).join(' / ') + (last && last['摘要'] ? `　摘要の例「${String(last['摘要']).replace(/\s+/g, ' ').slice(0, 40)}」` : '');
    }).join('\n');
    // アプリで確かめた決裁メモ（app）：会計の直近の科目に無い科目の行は手本にしない（人が直した科目が会計と違うことがある）。支払日・払う月・振込先名義の話は外す（その月だけのこと）
    const nk = s => String(s || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|[\s　・.,、。()（）]/g, '');
    const acctOf = payee => { const p = nk(payee); if (p.length < 2) return null; const k = Object.keys(hg).find(k => { const q = nk(k); return q.length >= 2 && (p.includes(q) || q.includes(p)); }); return k ? new Set(recentOf(k).map(x => x['科目コード'])) : null; };
    sq = (sq || []).filter(x => { if (!x.app) return true; const s = acctOf(x['取引先名']); return !s || !x['科目コード'] || s.has(x['科目コード']); }).map(x => x.app ? Object.assign({}, x, { '備考': cleanNote(x['備考']) }) : x).filter(x => x['備考']);
    // 過去の決裁メモ（請求Quick の明細の備考。社長・室長が見る説明）：取引先ごとに、いちばん新しい支払の行（最大20行。リース会社は車が10台以上ある）
    //   リースの回数（36/84回 → 次は 37/84回）・部署ごとの内訳・人数×単価などを、同じ書き方で続けられるように
    const sg = {}; (sq || []).forEach(x => { const k = String(x['取引先名'] || '').trim(); if (k && x['備考']) (sg[k] = sg[k] || []).push(x); });
    const sqT = Object.keys(sg).sort().map(k => {
      const last = sg[k].map(x => x['取引日']).sort().pop(), ls = sg[k].filter(x => x['取引日'] === last).slice(0, 20);
      return `${k}（${last}）：` + ls.map(x => `${x['内訳名']}｜${String(x['備考']).replace(/\s+/g, ' ').slice(0, 60)}｜${x['金額（税込）']}円`).join(' ／ ');
    }).join('\n');
    return `## マスタ：科目（コード 名前 既定の税）\n${kmT}\n\n## マスタ：部門（コード 名前）\n${bmT}\n\n## マスタ：内訳が要る科目（科目コード 名前：内訳コード 名前）\n${umT}\n\n## 過去の仕訳（支払先 → よく使う科目・部門・税。${yms[0] || ''}〜${ymEnd}。直近6か月（${recentFrom}〜）にある支払先は、その付け方を正とする）\n${histT}` + (sqT ? `\n\n## 過去の決裁メモ（取引先 → いちばん新しい支払の 内訳｜決裁メモ｜税込。社長・室長への説明。ApprovalNote はこの書き方にそろえる）\n${sqT}` : '');
  }

  // ---- アプリで確かめた決裁メモ（AP_PaymentSlip の 決裁メモ × AP_Invoice の 支払先・払う月）----
  //   1段目より先に進んだもの・確定したものだけ（AI が書いたままの確認待ちは入れない）。決裁メモ.csv と同じ形にして、払う月の末日を取引日にする
  async function listAll(ctx, name) {
    const ls = await ctx.call('GET', `/sites/${ctx.site}/lists?$select=id,displayName`);
    const l = (ls.value || []).find(x => x.displayName === name); if (!l) return { rows: [], fmap: {} };
    const cols = await ctx.call('GET', `/sites/${ctx.site}/lists/${l.id}/columns?$select=name,displayName`), fmap = {};
    (cols.value || []).forEach(c => { fmap[c.displayName] = c.name; });
    const rows = []; let next = `/sites/${ctx.site}/lists/${l.id}/items?$expand=fields&$top=500`;
    while (next) { const r = await ctx.call('GET', next); (r.value || []).forEach(x => rows.push(x)); next = r['@odata.nextLink'] ? r['@odata.nextLink'].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '') : null; }
    return { rows, fmap };
  }
  async function appNotes(ctx) {
    const [sl, iv] = await Promise.all([listAll(ctx, 'AP_PaymentSlip'), listAll(ctx, 'AP_Invoice')]);
    const fs = d => sl.fmap[d] || d, fi = d => iv.fmap[d] || d;
    if (!sl.fmap['決裁メモ']) return [];
    const inv = {}; iv.rows.forEach(x => { const f = x.fields;
      if (f[fi('アーカイブフラグ')] === true) return;
      const ok = (+f.ExpenseStep || 0) >= 1 || (f[fi('支払ステータス')] && f[fi('支払ステータス')] !== '確認待');
      if (ok) inv[String(x.id)] = { payee: f[fi('支払先名')] || '', ym: f[fi('対象年月')] || '' }; });
    return sl.rows.map(x => x.fields).filter(f => f[fs('決裁メモ')] && inv[String(f[fs('請求書ID')])]).map(f => {
      const v = inv[String(f[fs('請求書ID')])];
      return { '取引日': (v.ym || '') + '/28', '取引先名': v.payee, '内訳名': f[fs('勘定科目名')] || '', '科目コード': String(f[fs('勘定科目コード')] || '').padStart(6, '0'), '金額（税込）': String(Math.round(+f[fs('金額_税込')] || 0)), '備考': f[fs('決裁メモ')], app: true };
    });
  }
  // 決裁メモから、その月だけの話（支払日・払う月・納期限・引落・振込先名義）を外す。かっこの中は ・ で分けて、その項目だけ外す
  const NOTE_X = /払う月|支払日|納期限|振替日|引落|振込先名義|月末払い/;
  function cleanNote(s) {
    s = String(s || '').replace(/[（(]([^）)]*)[）)]/g, (m, a) => { if (!NOTE_X.test(a)) return m; const k = a.split('・').filter(t => !NOTE_X.test(t)); return k.length ? '（' + k.join('・') + '）' : ''; });
    return s.split(/[。｜|／]/).map(t => NOTE_X.test(t) ? t.split('・').filter(u => !NOTE_X.test(u)).join('・') : t).map(t => t.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  // ---- 覚えたこと（人が「AI に教える」で教えたこと。/BILLS/masters/ai_memory.json）。読み取りのとき、いちばん優先の手がかりにする ----
  const MEM = MASTERS + '/ai_memory.json';
  async function loadMemory(ctx) {
    try { const b = await ctx.call('GET', `/sites/${ctx.site}/drive/root:${encodeURI(MEM)}:/content`, null, null, true); const j = JSON.parse(await b.text()); return Array.isArray(j) ? j : []; }
    catch (e) { return []; }
  }
  const memoryText = mem => mem.length ? '\n\n## 覚えたこと（人が教えた。過去の決裁メモよりも優先する）\n' + mem.map(m => `- ${m.key}：${m.fact}${m.payee ? `（${m.payee}）` : ''}`).join('\n') : '';
  async function remember(ctx, items, by) {
    const mem = await loadMemory(ctx), now = new Date().toISOString();
    (items || []).filter(x => x && x.key && x.fact).forEach(x => {
      const i = mem.findIndex(m => m.key === x.key && (m.payee || '') === (x.payee || ''));
      const v = { key: String(x.key).trim(), fact: String(x.fact).trim(), payee: x.payee || '', by: by || '', at: now };
      if (i >= 0) mem[i] = v; else mem.push(v);
    });
    await ctx.call('PUT', `/sites/${ctx.site}/drive/root:${encodeURI(MEM)}:/content`, new Blob([JSON.stringify(mem, null, 1)], { type: 'application/json' }), 'application/json');
    S = null;   // 次の読み取りから、覚えたことを入れて作り直す
    return mem;
  }
  // ---- AI に教える（会話。Haiku）：人の答えから、決裁メモの直しと「覚えたこと」を作る ----
  const TEACH_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply', 'notes', 'memory'], properties: {
    reply: { type: 'string' },
    notes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'ApprovalNote'], properties: { index: { type: 'integer' }, ApprovalNote: { type: 'string' } } } },
    memory: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'fact'], properties: { key: { type: 'string' }, fact: { type: 'string' } } } } } };
  // ---- 仕訳を決める（会話。Sonnet）：科目・部門・税は AI が会計の実績から決める。決められないときは、人に「何の支払か」を聞く（科目は聞かない） ----
  const JOURNAL_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply', 'decided', 'summary', 'lines', 'memory'], properties: {
    reply: { type: 'string' }, decided: { type: 'boolean' }, summary: { type: 'string' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'AccountCode', 'DeptCode', 'TaxRate', 'SubCode', 'ApprovalNote', 'reason'], properties: {
      index: { type: 'integer' }, AccountCode: { type: 'string' }, DeptCode: { type: 'string' }, TaxRate: { type: 'string', enum: ['課税10%', '軽減8%', '非課税', '対象外'] }, SubCode: { type: 'string' }, ApprovalNote: { type: 'string' }, reason: { type: 'string' } } } },
    memory: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'fact'], properties: { key: { type: 'string' }, fact: { type: 'string' } } } } } };
  const nkey = s => String(s || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|[\s　・.,、。()（）]/g, '');
  // 支払先の会計の実績（摘要に支払先名が入っている行）：直近6か月を先に、新しい順
  function historyOf(jr, payee) {
    const p = nkey(payee); if (p.length < 2) return [];
    const hit = jr.filter(x => { const q = nkey(String(x['摘要'] || '').replace(/^\(\d+\)/, '').trim().split(/[\s　]/)[0]); return q.length >= 2 && (p.includes(q) || q.includes(p)); });
    return hit.sort((a, b) => String(b['伝票日付'] || b['年月']).localeCompare(String(a['伝票日付'] || a['年月'])));
  }
  async function journal(ctx, t) {
    const s = await setup(ctx), R = s.raw || { km: [], bm: [], um: [], jr: [], mem: [] };
    const hist = historyOf(R.jr, t.payee), ymEnd = hist.length ? hist[0]['年月'] : '';
    const sys = 'あなたは花岡車輌の総務で、経費の請求書の仕訳（科目・部門・税・内訳）を決める担当です。正解は「会計（外注の会計事務所）に実際に入っている仕訳」です。人の Excel の付け方や好みではありません。\n' +
      '- 科目・部門・税・内訳は、あなたが決める。人に「どの科目ですか」とは聞かない\n' +
      '- まず「この支払先の会計の実績」を見る。同じ内容の実績があれば、いちばん新しい付け方にそろえる（会計の付け方は 2026/04 に変わったものがあるので、古いものより新しいものを正とする）\n' +
      '- 実績が無い・内容が違う・実績で付け方が割れていて決められないときは、決めずに（decided=false、lines は空）、人に支払の中身を聞く：何を買った／何のサービスか、どの拠点・部署で使うか、一回きりか毎月か、など。1回に1〜2問、短く\n' +
      '- 人の答えで決められたら decided=true、lines に直す行を入れる（index は行の番号、AccountCode は科目マスタの6桁、DeptCode は部門マスタの6桁、内訳が要る科目は SubCode、要らなければ ""。ApprovalNote は直さないなら ""）。reason に決めた理由（どの実績にそろえたか、実績が無いなら何から判断したか）を短く\n' +
      '- 決めたとき（decided=true）は summary に、この相談の要約を1〜3文で書く：AI が何を聞き、人がどう答え、それでどの科目・部門・税にしたか（例「名古屋で使うコピー用紙かを確認。人の答え：名古屋営業所の事務用。会計の実績どおり 消耗事務費・002240 にした」）。人に聞かずに決めたときは、どの実績にそろえたか。決めていないときは ""\n' +
      '- 金額や行の分け方は変えない（人が決める）。行を分けた方がよいと思ったら reply で伝える\n' +
      '- memory には、次から聞かずに済む「毎月変わらない事実」だけを入れる（例 key「契約番号 00-4049-0155」fact「名古屋営業所のネット回線」）。科目・部門・税そのもの、支払日・払う月、一度きりのことは入れない\n' +
      '- reply は短い日本語';
    const kmT = R.km.filter(x => x['科目コード']).map(x => `${x['科目コード']} ${x['科目名']}`).join('\n');
    const bmT = R.bm.filter(x => x['部門名']).map(x => `${x['部門コード']} ${x['部門名']}`).join('\n');
    const ug = {}; R.um.forEach(x => { if (x['科目コード']) (ug[x['科目コード']] = ug[x['科目コード']] || []).push(x); });
    const umT = Object.entries(ug).filter(([, g]) => g.length <= 30 && !g.some(x => x['内訳コード'] === '000000')).map(([k, g]) => `${k}：` + g.map(x => `${x['内訳コード']} ${x['略称'] || x['内訳名']}`).join(' / ')).join('\n');
    const histT = hist.slice(0, 40).map(x => `${x['年月']}｜${x['科目コード']} ${x['科目名']}｜部門 ${x['部門コード']}｜${x['税区分']}${x['内訳'] ? '｜内訳 ' + x['内訳'] : ''}｜${x['金額']}円｜${String(x['摘要'] || '').replace(/\s+/g, ' ').slice(0, 50)}`).join('\n');
    const mem = (R.mem || []).filter(m => !m.payee || nkey(m.payee) === nkey(t.payee)).map(m => `- ${m.key}：${m.fact}`).join('\n');
    const ctxText = `## 請求書\n支払先：${t.payee || ''}\n拠点：${t.loc || ''}\n\n## 今の仕訳の行（番号｜科目｜部門｜税率｜内訳｜税込｜摘要｜決裁メモ）\n` +
      (t.lines || []).map((l, i) => `${i}｜${l.acode || ''} ${l.aname || ''}｜${l.dept || ''}｜${l.rate || ''}｜${l.sub || ''}｜${yen(l.amount)}｜${l.note || ''}｜${l.memo || ''}`).join('\n') +
      (t.items && t.items.length ? `\n\n## 請求書の明細（AI が読んだもの）\n${t.items.slice(0, 40).map(x => `${x.Name || x.Description || ''}｜${x.Amount || ''}`).join('\n')}` : '') +
      `\n\n## この支払先の会計の実績（新しい順・最大40行${ymEnd ? `・最新 ${ymEnd}` : ''}）\n${histT || '（実績なし：初めての支払先か、摘要の書き方が違う）'}` +
      (mem ? `\n\n## 覚えたこと（人が教えた事実）\n${mem}` : '') +
      `\n\n## 科目マスタ\n${kmT}\n\n## 部門マスタ\n${bmT}\n\n## 内訳が要る科目\n${umT}\n\n## 相談のきっかけ\n${t.issue || '仕訳を決めてください'}`;
    const msgs = [{ role: 'user', content: ctxText }].concat((t.history || []).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text })));
    const merged = []; msgs.forEach(m => { const p = merged[merged.length - 1]; if (p && p.role === m.role) p.content += '\n\n' + m.content; else merged.push({ role: m.role, content: m.content }); });
    if (merged[merged.length - 1].role !== 'user') merged.push({ role: 'user', content: '続けてください' });
    const body = { model: (s.models && s.models.read) || 'claude-sonnet-5-5', max_tokens: 3000, system: sys, messages: merged,
      output_config: { format: { type: 'json_schema', schema: JOURNAL_SCHEMA } } };
    const r = await ask(ctx, s, { title: 'ap.journal', caller: t.invoiceId || '' }, body);
    if (r.status !== '完了') throw new Error(r.message || 'AI に聞けませんでした');
    const a = JSON.parse(r.text); a.history = hist.length; return a;
  }
  async function teach(ctx, t) {
    const s = await setup(ctx);
    const sys = 'あなたは花岡車輌の総務で、経費の請求書の「決裁メモ」（社長・室長が決裁で読む、仕訳の行ごとの短い説明）を直す担当です。AI が請求書を読んだときにわからなかったこと（気づき）について、人が答えを教えてくれます。\n' +
      '- 人の答えをもとに、直す行の決裁メモ（ApprovalNote）を、今の書き方（拠点＋物件名・回数・ナンバーなど）を残したまま、わからなかった所だけ埋めて返す（notes。index は行の番号。直さない行は入れない）\n' +
      '- 次の請求書から同じことを聞かないように、覚えておくことを memory に入れる：key はナンバー・契約番号・品番など請求書に出てくる見分けの手がかり、fact はそれが何か（例 key「なにわ480あ1234」fact「大阪のエブリィ（リース車）」）。一般的すぎること・一度きりのことは入れない\n' +
      '- 答えがあいまいで決められないときは、notes と memory は空にして、reply で短く聞き返す\n- reply は短い日本語（直したこと・覚えたこと、または聞き返し）';
    const ctxText = `## 請求書\n支払先：${t.payee || ''}\n\n## 仕訳の行（番号｜科目｜税込｜決裁メモ｜摘要）\n` +
      (t.lines || []).map((l, i) => `${i}｜${l.aname || ''}｜${yen(l.amount)}｜${l.memo || ''}｜${l.note || ''}`).join('\n') + `\n\n## AI の気づき（わからなかったこと）\n${t.issue || ''}`;
    const msgs = [{ role: 'user', content: ctxText }].concat((t.history || []).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text })));
    // 会話は user／assistant を交互に。最初の文脈と最初の人の答えをつなげる
    const merged = []; msgs.forEach(m => { const p = merged[merged.length - 1]; if (p && p.role === m.role) p.content += '\n\n' + m.content; else merged.push({ role: m.role, content: m.content }); });
    const body = { model: s.models.chat || 'claude-haiku-5-5', max_tokens: 2000, system: sys, messages: merged,
      output_config: { format: { type: 'json_schema', schema: TEACH_SCHEMA } } };
    const r = await ask(ctx, s, { title: 'ap.teach', caller: t.invoiceId || '' }, body);
    if (r.status !== '完了') throw new Error(r.message || 'AI に聞けませんでした');
    return JSON.parse(r.text);
  }

  async function setup(ctx) {
    if (S) return S;
    const call = ctx.call, s = {};
    // 指示と答えの形（AP_Setting）
    const st = await call('GET', `/sites/${ctx.site}/lists/AP_Setting/items?$expand=fields&$top=100`);
    const it = (st.value || []).find(x => x.fields && x.fields.Title === 'ai.invoice');
    if (!it) throw new Error('AP_Setting に ai.invoice がありません（Provision-SmileAP.ps1 -Apply）');
    s.cfg = JSON.parse(it.fields.Value || '{}');
    // マスタ
    const [km, bm, um, jr, sq] = await Promise.all(['smile_kamoku.csv', 'smile_bumon.csv', 'smile_uchiwake.csv', '仕訳インデックス.csv', '決裁メモ.csv'].map(n => csv(ctx, n).catch(() => [])));
    // アプリで確かめた決裁メモ（人が直したものも）を、請求Quick の分より新しい例として足す ／ 人が教えた「覚えたこと」
    const [appSq, mem] = await Promise.all([appNotes(ctx).catch(e => { console.warn('アプリの決裁メモを読めません', e); return []; }), loadMemory(ctx)]);
    s.masters = mastersText(km, bm, um, jr, sq.concat(appSq)) + memoryText(mem);
    s.raw = { km, bm, um, jr, mem };   // 仕訳の相談（teach の journal）で、支払先の分だけを渡す
    if (window.AP_MOCK) { s.mock = true; s.models = { read: 'claude-sonnet-5-5' }; return (S = s); }
    // ワークフローのサイト（AI_Request・WF_Setting の flow.urlAI・ai.models）
    s.wf = (await call('GET', `/sites/${WF_SITE_PATH}`)).id;
    const ls = await call('GET', `/sites/${s.wf}/lists?$select=id,displayName`);
    const lid = n => { const l = (ls.value || []).find(x => x.displayName === n); if (!l) throw new Error(`ワークフローのサイトに ${n} がありません`); return l.id; };
    s.aiList = lid('AI_Request'); const setList = lid('WF_Setting');
    const ws = await call('GET', `/sites/${s.wf}/lists/${setList}/items?$expand=fields&$top=200`);
    const v = t => { const x = (ws.value || []).find(i => i.fields && i.fields.Title === t); return x ? x.fields.Value : ''; };
    s.url = v('flow.urlAI'); s.models = JSON.parse(v('ai.models') || '{}');
    if (!s.url) throw new Error('WF_Setting の flow.urlAI が空です（フロー AI_Claude中継 の URL）');
    return (S = s);
  }

  const b64 = blob => new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => ng(r.error); r.readAsDataURL(blob); });
  function docBlock(data, type, name) {
    const t = type || (/\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg');
    return t === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: t, data } } : { type: 'image', source: { type: 'base64', media_type: t, data } };
  }
  const yen = n => Math.round(+n || 0).toLocaleString('ja-JP');

  // 返事 → result.json の1件分（ap_read.ps1 の Record と同じ：消費税・合計・検算はここで計算する）
  //   it：{items, amount}（請求書の明細と、その金額が 税抜／税込）。仕訳の無い仕入の請求書で、税抜・消費税を出すのに使う
  function record(h, lines, total, comments, loc, it) {
    const ls = []; let i = 0;
    for (const l of lines || []) {
      if (!l) continue; i++;
      const ex = Math.round(+l.AmountExclTax || 0);
      const tx = l.Tax != null && l.Tax !== '' ? Math.round(+l.Tax) : Math.floor(ex * (RATE[l.TaxRate] || 0));
      ls.push({ LineNo: i, Location: String(l.DeptCode || '').startsWith('003') ? '工場' : loc,
        AccountName: l.AccountName || '', AccountCode: l.AccountCode || '', SubCode: l.SubCode || '', DeptCode: l.DeptCode || '',
        TaxMethod: l.TaxMethod || '税込', TaxRate: l.TaxRate || '', AmountExclTax: ex, Tax: tx, AmountInclTax: ex + tx, Description: l.Description || '', ApprovalNote: l.ApprovalNote || '', LineConfidence: +l.LineConfidence || 0 });
    }
    const cm = (comments || []).filter(x => x && String(x).trim());
    const tot = Math.round(+total || 0);
    let ex2, tx2, in2;
    if (ls.length) { ex2 = ls.reduce((s, x) => s + x.AmountExclTax, 0); tx2 = ls.reduce((s, x) => s + x.Tax, 0); in2 = ex2 + tx2; }
    else {
      // 仕入（仕訳なし）：税抜は請求書の明細（税抜の明細ならその合計）から。無ければ 税込 ÷ 1.1（前は 税抜＝税込・消費税 0 にしていた）
      in2 = tot;const isum = Math.round(((it && it.items) || []).reduce((s, x) => s + (+x.Amount || 0), 0));
      if (it && it.amount === '税抜' && isum > 0 && isum <= tot) ex2 = isum;
      else if (it && it.amount === '税込' && isum === tot) ex2 = Math.round(tot / 1.1);
      else ex2 = Math.round(tot / 1.1);
      tx2 = tot - ex2;
      if (tot && !(it && it.amount === '税抜' && isum > 0 && isum <= tot)) cm.push(`税抜 ${yen(ex2)} 円は 税込÷1.1 で出しました（請求書の税抜の印字と違えば直してください）`);
    }
    const diff = in2 - tot;
    if (ls.length && diff) cm.push(`仕訳の合計 ${yen(in2)} 円が請求書の総額 ${yen(tot)} 円と ${diff > 0 ? '+' : '−'}${yen(Math.abs(diff))} 円違います（端数か読み落とし）`);
    const hh = {};
    ['PayeeName', 'RegistrationNo', 'InvoiceNo', 'InvoiceDate', 'DueDate', 'TargetMonth', 'PayDateType', 'PayMethod', 'DebitDate', 'AIConfidence', 'BankCode', 'BankName', 'BranchCode', 'BranchName', 'AcctType', 'AcctNo', 'AcctHolder'].forEach(k => { if (h && h[k] != null && h[k] !== '') hh[k] = String(h[k]); });
    const m = String(hh.DebitDate || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) hh.DebitDate = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`; else delete hh.DebitDate;
    if (hh.BankCode && !/^\d{4}$/.test(hh.BankCode)) delete hh.BankCode;
    if (hh.BranchCode && !/^\d{3}$/.test(hh.BranchCode)) delete hh.BranchCode;
    Object.assign(hh, { AmountExclTax: ex2, Tax: tx2, AmountInclTax: in2 });
    return { header: hh, lines: ls, comments: cm, validation: { InvoiceTotalInclTax: tot, LinesSumInclTax: in2, Diff: diff } };
  }

  async function ask(ctx, s, job, body) {
    const call = ctx.call;
    if (s.mock) return window.AP_MOCK.ai ? await window.AP_MOCK.ai(job, body) : { status: 'エラー', message: 'dev：AP_MOCK.ai がありません' };
    const it = await call('POST', `/sites/${s.wf}/lists/${s.aiList}/items`, { fields: { Title: job.title || 'ap.invoice', Status: '受付', Caller: `ap:${job.apCode || job.caller || ''}` } });
    const payload = { id: Number(it.id), body };
    if (body.fallbacks) payload.beta = 'server-side-fallback-2026-07-01';
    await fetch(s.url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      let f; try { f = (await call('GET', `/sites/${s.wf}/lists/${s.aiList}/items/${it.id}?$expand=fields`)).fields; } catch (e) { continue; }
      if (f.Status === '完了') { const r = JSON.parse(f.ResultJson || '{}'); return { status: '完了', text: r.text || '', stop: r.stop_reason, model: r.model, usage: r.usage }; }
      if (f.Status === 'エラー') return { status: 'エラー', message: String(f.ResultMessage || '').slice(0, 300) };
    }
    return { status: 'エラー', message: 'AI の読み取りが5分たっても終わりません' };
  }

  // 答えの形は null をほとんど使わない（structured outputs の上限：型を2つ持つ項目は16個まで）。分からないものは 文字＝""、数量・単価＝0 で来るので null に戻す
  function normItem(x) {
    const o = {};
    Object.keys(x || {}).forEach(k => { const v = x[k]; o[k] = (v === '' || ((k === 'Qty' || k === 'UnitPrice') && v === 0)) ? null : v; });
    return o;
  }

  async function readInvoice(ctx, job) {
    const msg = ctx.onMsg || (() => {});
    const s = await setup(ctx), cfg = s.cfg;
    // ファイル：1つ（file・pdfName）か、まとめた何ファイルか（files）。まとめたときは「1枚の請求書」と伝える
    const fs = job.files && job.files.length ? job.files : [{ file: job.file, name: job.pdfName }];
    const docs = []; for (const f of fs) docs.push(docBlock(await b64(f.file), f.file.type, f.name));
    job.pdfName = job.pdfName || fs.map(f => f.name).join('・');
    const info = [
      '## 受付の情報',
      `- 区分：${job.category || ''}`, `- 拠点：${job.location || ''}`, `- 払う月：${job.targetYm || '（未定）'}`, `- 支払回：${job.round || '（受付では未定）'}`,
      `- 支払方法：${job.method || '（受付では未定）'}`, `- 仕入先コード：${job.vendorCode || 'なし'}${job.vendorName ? '（' + job.vendorName + '）' : ''}`,
      `- SMILE の額：${job.smileAmount != null && job.smileAmount !== '' ? yen(job.smileAmount) + ' 円' : 'なし'}`,
      // 仕入の「請求書を渡す」：仕入先は決まっていない。今月の支払先リストから発行元を選ばせる（PayeeCode）。付けるのは画面の決まった手順
      ...(job.candidates ? ['', '## 今月の支払先リスト（仕入先コード 名前 今回支払残高）', job.candidates] : []),
      ...(fs.length > 1 ? ['', `## 添付は  つのファイルですが、1枚の請求書です（ページが分かれたもの・明細が別紙のものなど）。全部を合わせて1件として読み、total・items・仕訳は全体で1つにしてください（extra に分けない）`] : []),
      '', 'この請求書を読んで、決められた形で答えてください。'].join('\n');
    const body = { model: s.models.read || 'claude-sonnet-5-5', max_tokens: cfg.maxTokens || 16000, fallbacks: 'default',
      output_config: { effort: cfg.effort || 'medium', format: { type: 'json_schema', schema: cfg.schema } },
      system: [{ type: 'text', text: cfg.system }, { type: 'text', text: s.masters, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: docs.concat([{ type: 'text', text: info }]) }] };
    msg(`AI が読んでいます：${job.pdfName}`);
    const r = await ask(ctx, s, job, body);
    let d = null, err = '';
    if (r.status !== '完了') err = r.message || 'AI の読み取りに失敗しました';
    else if (r.stop === 'refusal') err = 'AI が読み取りを断りました（安全のための判断）';
    else if (r.stop === 'max_tokens') err = 'AI の答えが長すぎて途中で切れました';
    else { try { d = JSON.parse(r.text); } catch (e) { err = 'AI の答えを読めませんでした'; } }
    const loc = job.location === '工場' ? '工場' : '本社';
    const rec = d ? record(d.header, d.lines, d.total, d.comments, loc, { items: Array.isArray(d.items) ? d.items : [], amount: d.itemsAmount || '' }) : record({}, [], 0, [`AI の読み取りに失敗しました：${err}。請求書を見て入れてください`], loc);
    const pc = d && d.header && /^\d{6}$/.test(String(d.header.PayeeCode || '')) ? String(d.header.PayeeCode) : '';
    if (job.inbox && pc) rec.comments.unshift(`AI の候補：${pc}`);
    const doc = { v: 3, ap_code: job.apCode, invoice_id: String(job.invoiceId || ''), category: job.category || '', status: d ? (d.status === '読取失敗' ? '読取失敗' : 'AI確認済') : '読取失敗',
      pdf_files: fs.map(f => f.name), moved: !!job.moved, new: false, location: loc, received_at: '',
      header: rec.header, lines: rec.lines, comments: rec.comments, validation: rec.validation,
      items: d && Array.isArray(d.items) ? d.items.map(normItem) : [], items_amount: d && /^税(抜|込)$/.test(d.itemsAmount || '') ? d.itemsAmount : '',   // 請求書に印字された明細（受入明細・仕訳と比べる）
      extra: d ? (d.extra || []).map(x => record(x.header, x.lines, x.total, x.comments, loc)) : [],
      processed_at: new Date().toISOString(), ai: { model: r.model || '', usage: r.usage || null, via: 'claude-api' },
      replace_lines: !!job.replaceLines };   // 読み直し：取り込みで前の仕訳を新しい答えで書き換える
    await ctx.call('PUT', `/sites/${ctx.site}/drive/root:${encodeURI(`${RES}/${job.apCode}.result.json`)}:/content`, new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), 'application/json');
    msg('');
    return { ok: !!d, status: doc.status, message: err };
  }

  window.APAI = { readInvoice, teach, journal, remember, loadMemory, _record: record, _mastersText: mastersText, _historyOf: historyOf };
})();
