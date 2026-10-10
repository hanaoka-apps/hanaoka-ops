/* ap_ai.js — 支払の請求書を Claude API で読む（Power Automate「AI_Claude中継」経由。API キーは PA だけが持つ）
   流れ：ワークフローのサイトの AI_Request に行を作る → PA を呼ぶ（no-cors・text/plain。WF_Action と同じ）→ 行が「完了」になるまで待つ
        → 返事（答えの JSON）を ap_read.ps1 と同じ形の result.json にして /BILLS/ai_result に置く → 呼び出し側が APIntake.apply で取り込む
   指示文と答えの形：AP_Setting の ai.invoice（正本 admin/defs/ap-ai-invoice.json）。モデル：WF_Setting の ai.models（read）
   マスタ（科目・部門・内訳・過去の仕訳）は /BILLS/masters の CSV から作り、指示文と一緒にキャッシュする（2件目から安い）
   使い方：await APAI.readInvoice({ call, site, onMsg }, { apCode, invoiceId, category, location, targetYm, round, method, vendorCode, vendorName, smileAmount, file, pdfName })
          file＝PDF か画像の Blob、pdfName＝incoming での名前。戻り値 { ok, status, message } */
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
  function mastersText(km, bm, um, jr) {
    const kmT = km.filter(x => x['科目コード']).map(x => `${x['科目コード']} ${x['科目名']} ${x['既定税名'] || ''}`.trim()).join('\n');
    const bmT = bm.filter(x => x['部門名']).map(x => `${x['部門コード']} ${x['部門名']}`).join('\n');
    const ug = {}; um.forEach(x => { if (x['科目コード']) (ug[x['科目コード']] = ug[x['科目コード']] || []).push(x); });
    const umT = Object.entries(ug).filter(([, g]) => g.length <= 30 && !g.some(x => x['内訳コード'] === '000000'))
      .map(([k, g]) => `${k} ${g[0]['科目名']}：` + g.map(x => `${x['内訳コード']} ${x['略称'] || x['内訳名']}`).join(' / ')).join('\n');
    // 過去の仕訳：支払先（摘要の最初の語）ごとに、よく使う科目・部門・税（仕入高は除く。2回以上）
    const key = m => String(m || '').replace(/^\(\d+\)/, '').replace(/[　\s]+/g, ' ').trim().split(' ')[0];
    const hg = {};
    jr.filter(x => (/^000[5-7]/.test(x['科目コード']) && x['科目コード'] !== '000501') || x['科目コード'] === '000317').forEach(x => { const k = key(x['摘要']); if (k) (hg[k] = hg[k] || []).push(x); });
    const histT = Object.keys(hg).filter(k => hg[k].length >= 2).sort().map(k => {
      const c = {}; hg[k].forEach(x => { const s = `${x['科目コード']} ${x['科目名']}・部門 ${x['部門コード']}・${x['税区分']}` + (x['内訳'] ? `・内訳 ${x['内訳']}` : ''); c[s] = (c[s] || 0) + 1; });
      const last = hg[k].slice().sort((a, b) => String(b['伝票日付'] || b['年月']).localeCompare(String(a['伝票日付'] || a['年月'])))[0];   // 摘要の書き方をそろえるため、新しい1件の例
      return `${k}（${hg[k].length}回）：` + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}×${n}`).join(' / ') + (last && last['摘要'] ? `　摘要の例「${String(last['摘要']).replace(/\s+/g, ' ').slice(0, 40)}」` : '');
    }).join('\n');
    const yms = [...new Set(jr.map(x => x['年月']).filter(Boolean))].sort();
    return `## マスタ：科目（コード 名前 既定の税）\n${kmT}\n\n## マスタ：部門（コード 名前）\n${bmT}\n\n## マスタ：内訳が要る科目（科目コード 名前：内訳コード 名前）\n${umT}\n\n## 過去の仕訳（支払先 → よく使う科目・部門・税。${yms[0] || ''}〜${yms[yms.length - 1] || ''}）\n${histT}`;
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
    const [km, bm, um, jr] = await Promise.all(['smile_kamoku.csv', 'smile_bumon.csv', 'smile_uchiwake.csv', '仕訳インデックス.csv'].map(n => csv(ctx, n).catch(() => [])));
    s.masters = mastersText(km, bm, um, jr);
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
  function record(h, lines, total, comments, loc) {
    const ls = []; let i = 0;
    for (const l of lines || []) {
      if (!l) continue; i++;
      const ex = Math.round(+l.AmountExclTax || 0);
      const tx = l.Tax != null && l.Tax !== '' ? Math.round(+l.Tax) : Math.floor(ex * (RATE[l.TaxRate] || 0));
      ls.push({ LineNo: i, Location: String(l.DeptCode || '').startsWith('003') ? '工場' : loc,
        AccountName: l.AccountName || '', AccountCode: l.AccountCode || '', SubCode: l.SubCode || '', DeptCode: l.DeptCode || '',
        TaxMethod: l.TaxMethod || '税込', TaxRate: l.TaxRate || '', AmountExclTax: ex, Tax: tx, AmountInclTax: ex + tx, Description: l.Description || '', LineConfidence: +l.LineConfidence || 0 });
    }
    const cm = (comments || []).filter(x => x && String(x).trim());
    const tot = Math.round(+total || 0);
    let ex2, tx2, in2;
    if (ls.length) { ex2 = ls.reduce((s, x) => s + x.AmountExclTax, 0); tx2 = ls.reduce((s, x) => s + x.Tax, 0); in2 = ex2 + tx2; }
    else { in2 = tot; tx2 = 0; ex2 = in2; }
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
    const it = await call('POST', `/sites/${s.wf}/lists/${s.aiList}/items`, { fields: { Title: 'ap.invoice', Status: '受付', Caller: `ap:${job.apCode}` } });
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

  async function readInvoice(ctx, job) {
    const msg = ctx.onMsg || (() => {});
    const s = await setup(ctx), cfg = s.cfg;
    const info = [
      '## 受付の情報',
      `- 区分：${job.category || ''}`, `- 拠点：${job.location || ''}`, `- 払う月：${job.targetYm || '（未定）'}`, `- 支払回：${job.round || '（受付では未定）'}`,
      `- 支払方法：${job.method || '（受付では未定）'}`, `- 仕入先コード：${job.vendorCode || 'なし'}${job.vendorName ? '（' + job.vendorName + '）' : ''}`,
      `- SMILE の額：${job.smileAmount != null && job.smileAmount !== '' ? yen(job.smileAmount) + ' 円' : 'なし'}`,
      '', 'この請求書を読んで、決められた形で答えてください。'].join('\n');
    const body = { model: s.models.read || 'claude-sonnet-5-5', max_tokens: cfg.maxTokens || 16000, fallbacks: 'default',
      output_config: { effort: cfg.effort || 'medium', format: { type: 'json_schema', schema: cfg.schema } },
      system: [{ type: 'text', text: cfg.system }, { type: 'text', text: s.masters, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [docBlock(await b64(job.file), job.file.type, job.pdfName), { type: 'text', text: info }] }] };
    msg(`AI が読んでいます：${job.pdfName}`);
    const r = await ask(ctx, s, job, body);
    let d = null, err = '';
    if (r.status !== '完了') err = r.message || 'AI の読み取りに失敗しました';
    else if (r.stop === 'refusal') err = 'AI が読み取りを断りました（安全のための判断）';
    else if (r.stop === 'max_tokens') err = 'AI の答えが長すぎて途中で切れました';
    else { try { d = JSON.parse(r.text); } catch (e) { err = 'AI の答えを読めませんでした'; } }
    const loc = job.location === '工場' ? '工場' : '本社';
    const rec = d ? record(d.header, d.lines, d.total, d.comments, loc) : record({}, [], 0, [`AI の読み取りに失敗しました：${err}。請求書を見て入れてください`], loc);
    const doc = { v: 3, ap_code: job.apCode, invoice_id: String(job.invoiceId || ''), category: job.category || '', status: d ? (d.status === '読取失敗' ? '読取失敗' : 'AI確認済') : '読取失敗',
      pdf_files: [job.pdfName], moved: !!job.moved, new: false, location: loc, received_at: '',
      header: rec.header, lines: rec.lines, comments: rec.comments, validation: rec.validation,
      extra: d ? (d.extra || []).map(x => record(x.header, x.lines, x.total, x.comments, loc)) : [],
      processed_at: new Date().toISOString(), ai: { model: r.model || '', usage: r.usage || null, via: 'claude-api' } };
    await ctx.call('PUT', `/sites/${ctx.site}/drive/root:${encodeURI(`${RES}/${job.apCode}.result.json`)}:/content`, new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), 'application/json');
    msg('');
    return { ok: !!d, status: doc.status, message: err };
  }

  window.APAI = { readInvoice, _record: record, _mastersText: mastersText };
})();
