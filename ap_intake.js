/* AI の読み取り結果（/BILLS/ai_result/{APコード}.result.json）を取り込む（新フロー整理 v3・SKILL v3）
   ・受付（アプリ・支払依頼のワークフロー）で作った AP_Invoice の行を、invoice_id で埋める（税納付の住民税だけ足す）
   ・複合機のスキャン（メールで incoming に届いた、受付の無い PDF）は new=true：経費の行をここで作る（登録者＝メール（複合機））
   ・経費は仕訳（AP_PaymentSlip）を作る。仕入は作らない
   ・PDF：読み取り側（定時の Claude）が processed へ移している（moved=true）。古い形は incoming → processed へ移す。DOCコードを直す
   ・result.json と task.json は ai_result/_archive へ
   ・受付で入れた 対象年月・支払回・支払方法・支払先コード は残す（空のときだけ埋める）
   使い方：await APIntake.apply({call, site, onMsg})  … call は各画面の Graph 呼び出し（dev は模擬） */
(function () {
  'use strict';
  const DIR = '/BILLS/ai_result', ARCH = '/BILLS/ai_result/_archive', INC = '/BILLS/incoming', PROC = '/BILLS/processed';
  const ROUNDS = ['10日', '20日', '月末'], METHODS = ['でんさい', '総合振込', '口座振替', '海外送金', '現金'], CONF = ['高', '中', '低'];
  const EXPENSE = ['本社経費', '工場経費'];
  // 全角カナ → 半角（全銀の受取人名は半角カナ。小さい字は大きく）
  const HK = {'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ','ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ','ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ','バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ','パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ','ヴ':'ｳﾞ',
    'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ','カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ','サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ','タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ','ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ','ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
    'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ','ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ','ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ','ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ','ァ':'ｱ','ィ':'ｲ','ゥ':'ｳ','ェ':'ｴ','ォ':'ｵ','ッ':'ﾂ','ャ':'ﾔ','ュ':'ﾕ','ョ':'ﾖ','ー':'-','（':'(','）':')','　':' ','．':'.','・':'.','，':',','－':'-'};
  const toHanKana = s => String(s || '').normalize('NFKC').replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).split('').map(c => HK[c] || c).join('').toUpperCase();

  async function lists(call, site) {
    const ls = await call('GET', `/sites/${site}/lists?$select=id,displayName`);
    const o = {};
    for (const n of ['AP_Invoice', 'AP_PaymentSlip']) {
      const l = ls.value.find(x => x.displayName === n); if (!l) throw new Error(n + ' がありません');
      const c = await call('GET', `/sites/${site}/lists/${l.id}/columns?$select=name,displayName`);
      const fmap = {}; c.value.forEach(x => fmap[x.displayName] = x.name); o[n] = { id: l.id, fmap };
    }
    return o;
  }
  const text = async (call, site, path) => { const b = await call('GET', `/sites/${site}/drive/root:${encodeURI(path)}:/content`, null, null, true); return new TextDecoder('utf-8').decode(await b.arrayBuffer()); };
  // パスで指定して移す（同じ名前があれば失敗する → 呼び出し側で無視）
  const move = (call, site, from, toDir) => call('PATCH', `/sites/${site}/drive/root:${encodeURI(from)}`, { parentReference: { path: `/drive/root:${toDir}` } });
  const yen = n => Math.round(+n || 0).toLocaleString('ja-JP');

  async function apply(ctx) {
    const { call, site } = ctx, msg = ctx.onMsg || (() => {});
    let names = [];
    try { const d = await call('GET', `/sites/${site}/drive/root:${encodeURI(DIR)}:/children?$select=name&$top=999`); names = (d.value || []).map(x => x.name).filter(n => /\.result\.json$/i.test(n)); }
    catch (e) { return { applied: 0, errors: [] }; }   // フォルダがまだ無い＝AI の結果なし
    if (!names.length) return { applied: 0, errors: [] };
    const L = await lists(call, site), IV = L.AP_Invoice, SL = L.AP_PaymentSlip;
    const fi = d => IV.fmap[d] || d, fs = d => SL.fmap[d] || d;
    let applied = 0; const errors = [];
    for (const name of names) {
      const path = `${DIR}/${name}`;
      try {
        msg(`AI の読み取り結果を取り込んでいます（${applied + 1}/${names.length}）`);
        const r = JSON.parse(await text(call, site, path));
        let id = String(r.invoice_id || ''), f = null;
        const done = async () => {
          await move(call, site, path, ARCH).catch(() => {});
          if (r.ap_code) await move(call, site, `${INC}/${r.ap_code}.task.json`, ARCH).catch(() => {}); };
        const H = r.header || {}, cmt = (r.comments || []).slice(), patch = {};
        if (r.new && !id) {
          // 複合機のスキャン（受付の無い経費）：ここで経費の行を作る。拠点は読み取りの判断（無ければ本社）
          const loc0 = r.location === '工場' ? '工場' : '本社', nf = { Title: H.PayeeName || (r.pdf_files || [])[0] || 'スキャン' };
          nf[fi('支払区分')] = loc0 + '経費'; nf[fi('仕分け済')] = true; nf[fi('支払ステータス')] = '確認待'; nf[fi('対象年月')] = H.TargetMonth || ctx.ym || '';
          Object.assign(nf, { AIStatus: '受付', RegisteredBy: 'メール（複合機）', RegisteredAt: r.received_at || r.processed_at || new Date().toISOString(), SiteLocation: loc0, ExpenseStep: 0 });
          const c = await call('POST', `/sites/${site}/lists/${IV.id}/items`, { fields: nf });
          id = String(c.id); f = c.fields || nf;
          cmt.unshift('複合機のスキャン（メール）で届いた請求書です。支払依頼の申請はありません');
        } else {
          let it = null; try { it = await call('GET', `/sites/${site}/lists/${IV.id}/items/${id}?$expand=fields`); } catch (e) {}
          if (!it || !it.fields) { errors.push(`${name}：受付の行（ID ${id}）がありません`); await done(); continue; }
          f = it.fields;
          if (f.AIStatus && f.AIStatus !== '受付') { await done(); continue; }   // 取り込み済み・人が先に入れたもの
        }
        const set = (d, v) => { if (v !== undefined && v !== null && v !== '') patch[fi(d)] = v; };
        const setIfEmpty = (d, v) => { const cur = f[fi(d)]; if (cur === undefined || cur === null || cur === '') set(d, v); };
        const oldAmt = +f[fi('金額_税込')] || 0;
        if (oldAmt && H.AmountInclTax != null && Math.round(oldAmt) !== Math.round(+H.AmountInclTax))
          cmt.push(`受付の金額 ${yen(oldAmt)} 円と、請求書の読み取り ${yen(H.AmountInclTax)} 円が違います（請求書の額にしました）`);
        set('支払先名', H.PayeeName); set('登録番号', H.RegistrationNo); set('請求NO', H.InvoiceNo);
        setIfEmpty('支払先コード', H.PayeeCode); setIfEmpty('対象年月', H.TargetMonth);
        if (ROUNDS.includes(H.PayDateType)) setIfEmpty('支払日区分', H.PayDateType);
        if (METHODS.includes(H.PayMethod)) setIfEmpty('支払手段', H.PayMethod);
        if (CONF.includes(H.AIConfidence)) set('AI確信度', H.AIConfidence);
        if (H.DebitDate) set('引落予定日', H.DebitDate);
        // 振込先（請求書から読んだもの。経費の支払先は振込先マスタに無いことが多い）。読めたものだけ入れる
        const BKF = { BankCode: 'PayeeBankCode', BankName: 'PayeeBankName', BranchCode: 'PayeeBranchCode', BranchName: 'PayeeBranchName', AcctType: 'PayeeAcctType', AcctNo: 'PayeeAcctNo', AcctHolder: 'PayeeAcctHolder', BankSource: 'PayeeBankSource' };
        Object.entries(BKF).forEach(([k, n]) => { if (H[k] != null && H[k] !== '' && !f[n]) patch[n] = k === 'AcctHolder' ? toHanKana(H[k]) : String(H[k]); });
        if (H.AmountInclTax != null) { patch[fi('金額_税込')] = +H.AmountInclTax || 0; patch[fi('金額_税抜')] = +H.AmountExclTax || 0; patch[fi('消費税')] = +H.Tax || 0; }
        // PDF：読み取り側が processed へ移していればそのまま。古い形は incoming → processed（移せなければ incoming のまま）
        const docs = [];
        for (const p of (r.pdf_files || []).filter(Boolean)) {
          if (r.moved) { docs.push(`/Shared Documents${PROC}/${p}`); continue; }
          try { await move(call, site, `${INC}/${p}`, PROC); docs.push(`/Shared Documents${PROC}/${p}`); }
          catch (e) { docs.push(`/Shared Documents${INC}/${p}`); }
        }
        if (docs.length) patch[fi('DOCコード')] = docs.join('\n');
        patch.AIStatus = r.status === '読取失敗' ? '読取失敗' : 'AI確認済';
        patch.AIComment = [String(f.AIComment || '').trim()].concat(cmt).filter(Boolean).join('\n');
        await call('PATCH', `/sites/${site}/lists/${IV.id}/items/${id}/fields`, patch);
        const cat = f[fi('支払区分')] || r.category || '', loc = f.SiteLocation || (cat.startsWith('工場') ? '工場' : '本社');
        const addLines = async (invId, lines) => {
          if (!EXPENSE.includes(cat) || !(lines || []).length) return;
          // 二重に作らない（同時に2人が開いたとき）
          const ex = await call('GET', `/sites/${site}/lists/${SL.id}/items?$expand=fields&$top=5&$filter=${encodeURIComponent(`fields/${fs('請求書ID')} eq '${invId}'`)}`).catch(() => ({ value: [] }));
          if ((ex.value || []).some(x => String(x.fields[fs('請求書ID')]) === String(invId))) return;
          for (const l of lines) {
            const g = { Title: `${H.PayeeName || ''} ${l.LineNo}` };
            const s = (d, v) => { g[fs(d)] = v; };
            s('請求書ID', String(invId)); s('明細行番号', l.LineNo); s('拠点', l.Location || loc); s('勘定科目名', l.AccountName || ''); s('勘定科目コード', l.AccountCode || '');
            if (l.SubCode && SL.fmap['内訳コード']) s('内訳コード', l.SubCode);   // 内訳（預り金の 000005 など）。列が無ければ入れない
            s('部門コード', l.DeptCode || ''); s('税区分', l.TaxMethod || '税込'); s('税率区分', l.TaxRate || '課税10%');
            s('金額_税抜', +l.AmountExclTax || 0); s('消費税', +l.Tax || 0); s('金額_税込', +l.AmountInclTax || 0); s('摘要', l.Description || ''); s('AI信頼スコア', +l.LineConfidence || 0);
            await call('POST', `/sites/${site}/lists/${SL.id}/items`, { fields: g });
          }
        };
        await addLines(id, r.lines);
        // 1枚で2件（税納付の住民税など）：同じ PDF・同じ区分で行を足す
        for (const x of (r.extra || [])) {
          const XH = x.header || {}, nf = { Title: XH.PayeeName || '（追加）' };
          const s = (d, v) => { if (v !== undefined && v !== null && v !== '') nf[fi(d)] = v; };
          s('支払区分', cat); s('支払先名', XH.PayeeName); s('対象年月', XH.TargetMonth || f[fi('対象年月')]); s('仕分け済', true); s('支払ステータス', '確認待');
          if (ROUNDS.includes(XH.PayDateType)) s('支払日区分', XH.PayDateType); if (METHODS.includes(XH.PayMethod)) s('支払手段', XH.PayMethod);
          if (XH.DebitDate) s('引落予定日', XH.DebitDate);
          s('金額_税込', +XH.AmountInclTax || 0); s('金額_税抜', +XH.AmountExclTax || 0); s('消費税', +XH.Tax || 0); s('DOCコード', docs.join('\n'));
          Object.assign(nf, { AIStatus: 'AI確認済', AIComment: (x.comments || []).join('\n'), RegisteredBy: f.RegisteredBy || '', RegisteredAt: f.RegisteredAt || new Date().toISOString(), SiteLocation: loc, ExpenseStep: 0 });
          const c = await call('POST', `/sites/${site}/lists/${IV.id}/items`, { fields: nf });
          await addLines(String(c.id), x.lines);
        }
        await done(); applied++;
      } catch (e) { errors.push(`${name}：${e.message}`); }
    }
    msg('');
    return { applied, errors };
  }
  window.APIntake = { apply };
})();
