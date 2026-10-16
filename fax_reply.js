/* ============================================================
 * FAX返信作成（β）— 受け取ったFAXのPDFに、画面でクリックした位置へ文字を書き込み、
 *   元のPDFに文字を重ねた返信用PDFをブラウザだけで作る。
 *
 *   使い方：
 *     FaxReply.open({
 *       pdfBytes,            // 元のFAX PDF（ArrayBuffer / Uint8Array）
 *       title,               // 画面の見出し（例：案件名）
 *       senderFax,           // 返信先のFAX番号（画面に大きく出す。コピーできる）
 *       submitLabel,         // 決定ボタンの文字（例：「登録して印刷」）
 *       extraPanelHtml,      // 右側に足すHTML（送付種別の選択など。省略可）
 *       initial,             // 続きを編集のとき、前回の edit（{ boxes, shapes }）。省略可
 *       onSubmit: async ({ bytes, texts, shapes, summaryText, edit }) => { ... }  // 作成したPDFと書き込み内容
 *     });
 *     FaxReply.printPdf(bytes)   // 印刷画面を開く（PC-FAX を選んで送信する）
 *
 *   座標：文字の位置は「縮尺1の画面上の点（px＝pt）」で持ち、PDF.js の viewport で
 *   PDF内部の座標に直す。ページに回転が付いていても、画面で見えている向きのまま書ける。
 *   日本語：BIZ UDゴシック（static/fonts、SIL OFL）の字の形を fontkit で取り出し、図形として描く（フォントは埋め込まない）。
 * ============================================================ */
(function () {
  'use strict';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const LIBS = [
    ['pdfjsLib', 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'],
    ['PDFLib',   'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'],
    ['fontkit',  'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'],
  ];
  const FONT_URL = 'static/fonts/BIZUDGothic-Regular.ttf';
  const DEFAULT_SIZE = 12;          // 文字の大きさ（pt）
  const BOX_PAD = 3;                // テキストボックスの余白（pt）
  const SEAL_PAD = 2;               // 社判の白い背景の余白（pt）
  const MM_PER_PT = 25.4 / 72;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---- ライブラリ・フォントの読み込み（必要になったときに1回だけ）----
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('読み込めません: ' + src));
      document.head.appendChild(s);
    });
  }
  let libsReady = null, fontBytes = null, parsedFont = null;
  function ensureLibs() {
    if (!libsReady) {
      libsReady = (async () => {
        for (const [g, src] of LIBS) if (!window[g]) await loadScript(src);
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      })();
    }
    return libsReady;
  }
  async function ensureFont() {
    if (!fontBytes) {
      const r = await fetch(FaxReply.fontUrl);
      if (!r.ok) throw new Error('日本語フォントを読み込めません（' + r.status + '）');
      fontBytes = await r.arrayBuffer();
    }
    return fontBytes;
  }

  // ---- 見た目 ----
  const CSS = `
  /* 後ろの幕は薄く・クリックを通す（開いたまま裏のアプリも見たり触ったりできる）。編集画面は見出しで移動、右下で大きさ変更 */
  .fr-overlay{position:fixed;inset:0;background:rgba(15,17,40,.15);z-index:3000;display:flex;align-items:center;justify-content:center;pointer-events:none}
  .fr-modal{pointer-events:auto;background:#fff;color:#1f2330;width:min(1400px,97vw);height:94vh;min-width:560px;min-height:360px;max-width:100vw;max-height:100vh;resize:both;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit}
  .fr-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #e3e5ef;flex-wrap:wrap;cursor:move;user-select:none}
  .fr-head button,.fr-head select{cursor:pointer}
  .fr-title{font-weight:700;font-size:14px;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fr-beta{font-size:10px;background:#fff1d6;color:#8a5a00;border-radius:8px;padding:1px 7px;font-weight:700}
  .fr-fax{display:flex;align-items:center;gap:6px;background:#eef0fc;border:1px solid #c9cdf3;border-radius:8px;padding:4px 10px}
  .fr-fax .l{font-size:11px;color:#5a5f7a}.fr-fax .n{font-size:18px;font-weight:700;letter-spacing:.03em;color:#23268f}
  .fr-btn{border:1px solid #d5d8e5;background:#fff;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;color:#1f2330}
  .fr-btn:hover{background:#f3f4f9}.fr-btn.primary{background:#23268f;border-color:#23268f;color:#fff;font-weight:700}
  .fr-btn.primary:hover{background:#1b1e73}.fr-btn:disabled{opacity:.5;cursor:default}
  .fr-body{flex:1;display:flex;min-height:0}
  .fr-pages{flex:1;overflow:auto;background:#e9ebf2;padding:16px;display:flex;flex-direction:column;align-items:flex-start;gap:16px}
  .fr-page{position:relative;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:crosshair;flex-shrink:0;margin:0 auto}
  .fr-page canvas{display:block}
  .fr-pno{position:absolute;top:-14px;left:0;font-size:10px;color:#6b7089}
  .fr-box{position:absolute;z-index:2;display:flex;align-items:flex-start;cursor:default}
  .fr-grip{width:12px;margin-right:2px;cursor:move;color:#23268f;font-size:11px;line-height:1;opacity:0;user-select:none}
  .fr-text{min-width:6px;outline:1px dashed rgba(35,38,143,.55);background:rgba(255,255,230,.55);white-space:pre;color:#000;line-height:1.25;padding:0;font-family:'BIZ UDGothic','BIZ UDPGothic','Yu Gothic',sans-serif}
  .fr-box:focus-within .fr-text{outline:2px solid #23268f;background:rgba(255,255,200,.85)}
  .fr-box:hover .fr-grip,.fr-box:focus-within .fr-grip{opacity:1}
  .fr-tools{position:absolute;top:-24px;left:14px;display:none;gap:2px;background:#23268f;border-radius:5px;padding:2px;white-space:nowrap}
  .fr-box:focus-within .fr-tools{display:flex}
  .fr-tools button{border:none;background:transparent;color:#fff;font-size:11px;padding:1px 6px;cursor:pointer;border-radius:3px}
  .fr-tools button:hover{background:rgba(255,255,255,.2)}
  .fr-tools button.on{background:#fff;color:#23268f}
  .fr-seal{width:100%;box-sizing:border-box;border:1px solid #d5d8e5;border-radius:5px;padding:4px 6px;font-size:11px;line-height:1.5;font-family:inherit;resize:vertical}
  .fr-side{width:300px;border-left:1px solid #e3e5ef;display:flex;flex-direction:column;min-height:0}
  .fr-side-in{flex:1;overflow:auto;padding:12px 14px;font-size:12px}
  .fr-help{background:#f6f7fb;border-radius:8px;padding:8px 10px;color:#4a4f68;line-height:1.6;margin-bottom:10px}
  .fr-helpbox summary{cursor:pointer;color:#23268f;font-weight:700;margin-bottom:8px;user-select:none}
  .fr-helpbox[open] summary{margin-bottom:6px}
  .fr-list{display:flex;flex-direction:column;gap:4px;margin:6px 0 12px}
  .fr-li{border:1px solid #e3e5ef;border-radius:6px;padding:5px 8px;cursor:pointer;white-space:pre-wrap;word-break:break-all}
  .fr-li:hover{border-color:#23268f}.fr-li small{color:#8a8fa8}
  .fr-side-foot{padding:10px 14px;border-top:1px solid #e3e5ef;display:flex;flex-direction:column;gap:6px}
  .fr-status{font-size:11px;color:#5a5f7a;min-height:14px}
  .fr-h{font-weight:700;margin:4px 0 2px}
  .fr-modes{display:flex;gap:2px;background:#f0f1f7;border-radius:8px;padding:2px}
  .fr-modes .fr-btn{border-color:transparent;background:transparent}
  .fr-modes .fr-btn.on{background:#23268f;color:#fff}
  .fr-lw{border:1px solid #d5d8e5;border-radius:6px;padding:4px 6px;font-size:12px;background:#fff}
  .fr-shapes{position:absolute;left:0;top:0;z-index:1;pointer-events:none;overflow:visible}
  .fr-shapes.fr-stamps{z-index:3}
  .fr-shapes .hit{pointer-events:stroke;cursor:move}
  .fr-stamp{display:grid;grid-template-columns:auto 1fr;gap:4px 6px;align-items:center;margin:4px 0 2px}
  .fr-stamp input,.fr-stamp select{border:1px solid #d5d8e5;border-radius:5px;padding:3px 6px;font-size:12px;min-width:0}
  .fr-hdl{position:absolute;z-index:4;width:10px;height:10px;margin:-6px 0 0 -6px;background:#fff;border:2px solid #d33;border-radius:2px;box-sizing:content-box}
  .fr-sdel{position:absolute;z-index:4;border:none;background:#c0392b;color:#fff;font-size:11px;border-radius:4px;padding:1px 6px;cursor:pointer}
  `;
  function injectCss() {
    if (document.getElementById('fr-css')) return;
    const st = document.createElement('style'); st.id = 'fr-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- 図形の補助 ----
  const STAMP_KEY = 'fax-reply-stamp-v1';
  function loadStampCfg() { try { return JSON.parse(localStorage.getItem(STAMP_KEY) || '{}'); } catch (_) { return {}; } }
  function saveStampCfg(c) { try { localStorage.setItem(STAMP_KEY, JSON.stringify(c)); } catch (_) {} }
  // 楕円を4本のベジェ曲線で（画面上の点）
  function ellipseCmds(cx, cy, rx, ry) {
    const k = 0.5523, a = rx * k, b = ry * k;
    return [['M', cx + rx, cy], ['C', cx + rx, cy + b, cx + a, cy + ry, cx, cy + ry], ['C', cx - a, cy + ry, cx - rx, cy + b, cx - rx, cy],
            ['C', cx - rx, cy - b, cx - a, cy - ry, cx, cy - ry], ['C', cx + a, cy - ry, cx + rx, cy - b, cx + rx, cy], ['Z']];
  }
  // データ印の配置：円の中に上段・日付・下段、日付の上下に横線
  function stampLayout(s) {
    const r = s.d / 2, cx = s.x1, cy = s.y1, h = r * 0.32, cw = Math.sqrt(r * r - h * h) * 0.97;
    const est = t => [...(t || '')].reduce((a, ch) => a + (/[ -~]/.test(ch) ? 0.55 : 1), 0);   // おおよその字幅（1pt あたり）
    const mk = (text, ty, size, maxW) => {
      const sz = Math.min(size, maxW / Math.max(est(text), 0.01));
      return { text: text || '', cx, base: ty + sz * 0.36, size: sz, maxW, estW: est(text) * sz };
    };
    return {
      chords: [[cx - cw, cy - h, cx + cw, cy - h], [cx - cw, cy + h, cx + cw, cy + h]],
      texts: [mk(s.top, cy - r * 0.64, r * 0.4, r * 1.3), mk(s.date, cy, r * 0.42, r * 1.7), mk(s.bottom, cy + r * 0.64, r * 0.46, r * 1.3)],
    };
  }
  // 色（画面の色, PDFの色）。文字・枠・線・丸・社判は選べる（最初は青）。データ印・完了は赤
  const COLORS = { blue: ['#1f3fbf', [0.12, 0.25, 0.75]], black: ['#000000', [0, 0, 0]], red: ['#c8102e', [0.78, 0.06, 0.18]] };
  const colHex = c => (COLORS[c] || COLORS.black)[0];
  const colRgb = c => (COLORS[c] || COLORS.black)[1];
  const estW = t => [...(t || '')].reduce((a, ch) => a + (/[ -~]/.test(ch) ? 0.55 : 1), 0);   // おおよその字幅（1pt あたり）
  // 完了：中心 (x1,y1)、幅 d。二重の四角に「完了」
  function doneLayout(s) {
    const W = s.d, H = s.d * 0.46, cx = s.x1, cy = s.y1, ins = H * 0.09, size = H * 0.6;
    return { W, H, outer: [cx - W / 2, cy - H / 2, cx + W / 2, cy + H / 2], inner: [cx - W / 2 + ins, cy - H / 2 + ins, cx + W / 2 - ins, cy + H / 2 - ins],
             text: { text: '完　了', cx, base: cy + size * 0.36, size, maxW: W - ins * 4 } };
  }
  // 社判：左上 (x1,y1)、d＝基本の字の大きさ。会社名の行だけ大きく
  function sealLayout(s) {
    const fs = s.d, items = []; let y = s.y1, w = 0;
    (s.lines || []).forEach(t => {
      const size = /株式会社|有限会社|合同会社/.test(t) ? fs * 1.45 : fs;
      items.push({ text: t, size, x0: s.x1, base: y + size * 0.88 });
      w = Math.max(w, estW(t) * size); y += size * 1.3;
    });
    return { items, w: Math.max(w, fs * 4), h: Math.max(y - s.y1, fs) };
  }
  function shapeBox(s) {
    if (s.kind === 'stamp') { const r = s.d / 2; return { x1: s.x1 - r, y1: s.y1 - r, x2: s.x1 + r, y2: s.y1 + r }; }
    if (s.kind === 'done') { const L = doneLayout(s); return { x1: L.outer[0], y1: L.outer[1], x2: L.outer[2], y2: L.outer[3] }; }
    if (s.kind === 'seal') { const L = sealLayout(s); return { x1: s.x1, y1: s.y1, x2: s.x1 + L.w, y2: s.y1 + L.h }; }
    return { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2), x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) };
  }
  // スタンプ（データ印・完了・社判）は文字より上に重ねる
  const isStampKind = s => s.kind === 'stamp' || s.kind === 'done' || s.kind === 'seal';
  // 「枠1・線2・丸1・データ印1」
  function shapeCountNote(list, sp) {
    const names = [['rect', '枠'], ['line', '線'], ['ellipse', '丸'], ['stamp', 'データ印'], ['done', '完了'], ['seal', '社判']];
    return names.map(([k, n]) => { const c = list.filter(s => s.kind === k).length; return c ? `${n}${sp}${c}` : ''; }).filter(Boolean).join('・');
  }

  // ---- 本体 ----
  async function open(opts) {
    injectCss();
    const o = Object.assign({ title: 'FAX返信の作成', senderFax: '', submitLabel: 'PDFを作成', extraPanelHtml: '' }, opts || {});
    const ov = document.createElement('div');
    ov.className = 'fr-overlay';
    ov.innerHTML = `<div class="fr-modal">
      <div class="fr-head">
        <span class="fr-title" title="${esc(o.title)}">✍ ${esc(o.title)}</span><span class="fr-beta">β</span>
        <span class="fr-fax"><span class="l">返信先FAX</span><span class="n">${esc(o.senderFax || '（不明）')}</span>
          <button class="fr-btn" data-act="copy"${o.senderFax ? '' : ' style="display:none"'}>コピー</button>
          ${o.onFaxEdit ? '<button class="fr-btn" data-act="faxedit" title="読み違いを直す（元の受信FAXの「送信元FAX」も直ります）">✎ 直す</button>' : ''}</span>
        <span class="fr-modes"><button class="fr-btn on" data-mode="text" title="クリックした所に文字を書く">Ａ 文字</button><button class="fr-btn" data-mode="textbox" title="クリックした所に、枠つき・白背景の文字（コメント）を書く">▭ テキストボックス</button><button class="fr-btn" data-mode="rect" title="ドラッグで四角い枠を描く">□ 枠</button><button class="fr-btn" data-mode="line" title="ドラッグで直線を描く（ほぼ水平・垂直なら真っすぐにそろえる。Shiftで必ずそろえる）">／ 線</button><button class="fr-btn" data-mode="ellipse" title="ドラッグで丸（楕円）を描く。Shiftで正円">◯ 丸</button><button class="fr-btn" data-mode="stamp" title="押したい所をクリックしてスタンプを押す（種類は右の選択、内容は右側で設定）">印 スタンプ</button></span>
        <select class="fr-lw fr-stype" title="スタンプの種類"><option value="data">データ印</option><option value="done">完了</option><option value="seal">社判（全部）</option><option value="sealshort">社判（住所・会社名）</option></select>
        <select class="fr-lw fr-col" title="文字・枠・線・丸・社判の色"><option value="blue" selected>色：青</option><option value="black">色：黒</option><option value="red">色：赤</option></select>
        <select class="fr-lw fr-width" title="枠・線の太さ"><option value="1">細</option><option value="1.5" selected>中</option><option value="2.5">太</option></select>
        <button class="fr-btn" data-act="undo" title="最後に書いたものを消す">↶ 元に戻す</button>
        <span style="flex:1"></span>
        <button class="fr-btn" data-act="zoomout">－</button><span class="fr-zoom" style="font-size:12px;min-width:42px;text-align:center"></span><button class="fr-btn" data-act="zoomin">＋</button>
        <button class="fr-btn" data-act="close">閉じる</button>
      </div>
      <div class="fr-body">
        <div class="fr-pages"><div style="padding:40px;color:#6b7089">PDFを読み込み中...</div></div>
        <div class="fr-side">
          <div class="fr-side-in">
            <details class="fr-helpbox"><summary>❓ 使い方（クリックで開く）</summary><div class="fr-help"><b>Ａ 文字</b>：書きたい所をクリックして入力（⠿ で移動、Enter で改行）。入力中に出る小さなボタンで 大きさ・<b>B 太字</b>・<b>U 下線</b>・<b>▭ 枠と白背景</b>・削除。<br>
              <b>▭ テキストボックス</b>：枠つき・白背景の文字（コメント）。<br>
              <b>□ 枠／／ 線／◯ 丸</b>：ドラッグで描く（丸は Shift で正円）。<br>
              描いた枠・線・丸・データ印は<b>ドラッグで移動</b>（選んで矢印キーでも少しずつ動く）。クリックで選ぶと、<b>□ のつまみで大きさ</b>を変えられ、✕ で消せます。<br>
              <b>印 スタンプ</b>：右の選択で データ印／完了／社判（全部・住所と会社名だけ）を選び、押したい所をクリック（内容は下で設定）。<br>
              色は上の「色」で選びます（最初は青。データ印・完了は赤）。<br>
              <b>↶ 元に戻す</b>：最後に書いたものを消します。<br>
              <b>画面の移動</b>：上の見出しをドラッグで移動、右下の角で大きさ変更（ダブルクリックで中央に戻る）。開いたまま裏の画面も見られます。</div></details>
            <div class="fr-h">書き込んだ文字</div>
            <div class="fr-list"><div style="color:#8a8fa8">まだありません</div></div>
            <div class="fr-h">データ印</div>
            <div class="fr-stamp">
              <span>上段</span><input data-st="top" maxlength="8">
              <span>日付</span><input data-st="date" maxlength="10">
              <span>下段</span><input data-st="bottom" maxlength="6" placeholder="名前">
              <span>大きさ</span><select data-st="d"><option value="34">小（12mm）</option><option value="42.5">中（15mm）</option><option value="51">大（18mm）</option></select>
            </div>
            <div style="color:#8a8fa8;margin-bottom:10px">上段・下段・大きさはこのパソコンに覚えます。日付は毎回その日になります。</div>
            <div class="fr-h">社判</div>
            <textarea class="fr-seal" data-seal rows="6"></textarea>
            <select class="fr-lw" data-seal-bg style="margin-top:4px;padding:3px 6px;font-size:11px" title="社判の背景（白にすると下の文字や線を隠せます）"><option value="none">背景：透明</option><option value="white">背景：白</option></select>
            <button class="fr-btn" data-seal-reset style="margin-top:4px;padding:3px 8px;font-size:11px" title="社判の内容を最初の状態（住所・会社名・TEL・担当・Mail）に戻す">↺ 初期値に戻す</button>
            <div style="color:#8a8fa8;margin-bottom:10px">1行ずつ入れます（「株式会社」の行は大きく出ます）。「社判（住所・会社名）」を選ぶと、会社名の行までを押します。このパソコンに覚えます。押したあと □ のつまみで大きさを変えられます。</div>
            ${o.extraPanelHtml}
          </div>
          <div class="fr-side-foot">
            <div class="fr-status"></div>
            <button class="fr-btn primary" data-act="submit">${esc(o.submitLabel)}</button>
          </div>
        </div>
      </div></div>`;
    document.body.appendChild(ov);
    const $ = sel => ov.querySelector(sel);
    const status = t => { $('.fr-status').textContent = t || ''; };
    // 見出しをドラッグで編集画面を移動（ボタン・選択欄の上は除く）。ダブルクリックで中央に戻す
    {
      const modal = $('.fr-modal'), head = $('.fr-head');
      let mx = 0, my = 0;
      const place = () => { modal.style.transform = `translate(${mx}px, ${my}px)`; };
      head.title = '見出しをドラッグで移動（ダブルクリックで中央に戻す）／右下の角で大きさを変えられます';
      head.addEventListener('mousedown', e => {
        if (e.button !== 0 || e.target.closest('button,select,input,textarea,a')) return;
        e.preventDefault();
        const sx = e.clientX - mx, sy = e.clientY - my;
        const mv = ev => {
          // 見出しが画面の外に出ないように（少なくとも80px は残す）
          const r = modal.getBoundingClientRect(), bx = r.left - mx, by = r.top - my;
          mx = Math.max(80 - bx - r.width, Math.min(window.innerWidth - 80 - bx, ev.clientX - sx));
          my = Math.max(-by, Math.min(window.innerHeight - 40 - by, ev.clientY - sy));
          place();
        };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
      head.addEventListener('dblclick', e => { if (e.target.closest('button,select,input,textarea,a')) return; mx = my = 0; place(); });
    }
    let scale = 1.4, baseScale = 1.4, pdf = null, pages = [], boxes = [], nextId = 1, closed = false;
    // 枠・線：{ id, kind:'rect'|'line', page, x1, y1, x2, y2, w }（座標は文字と同じ「縮尺1の画面上の点」、w は線の太さpt）
    let mode = 'text', shapes = [], selShape = null;
    const history = [];   // 書いた順（元に戻す用）
    const hasWork = () => boxes.some(b => b.text.trim()) || shapes.length > 0;
    const onKey = e => {
      if (!selShape) return;
      if (document.activeElement && (document.activeElement.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeShape(selShape); return; }
      // 矢印キーで少しずつ動かす（Shift で大きく）
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault(); moveShape(selShape, d[0], d[1]); drawShapes(selShape.page);
    };
    document.addEventListener('keydown', onKey);
    // データ印の設定（上段・下段・大きさはこのブラウザに保存、日付は当日）
    const today = new Date();
    const stampCfg = Object.assign({ top: '花岡車輌', bottom: '', d: 42.5 }, o.stamp || {}, loadStampCfg(),
      { date: `${String(today.getFullYear()).slice(2)}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}` });
    const sealDefault = () => ['〒135-0021 東京都江東区白河2-17-10', '花岡車輌株式会社', 'TEL 03-3643-5271',
                               '担当：' + (stampCfg.bottom || ''), 'Mail：gyoumu@hanaoka-corp.co.jp'].join('\n');
    if (!stampCfg.seal) stampCfg.seal = sealDefault();
    stampCfg.seal = stampCfg.seal.replace('白河2-1710', '白河2-17-10')   // 試験中に配った番地の誤りを直す
      .replace(/^登録番号：T9010601007789\n?/m, '');                     // 初めの版に入れていた登録番号は不要（10/15）
    const sealEl = ov.querySelector('[data-seal]');
    sealEl.value = stampCfg.seal;
    const saveSeal = () => saveStampCfg({ top: stampCfg.top, bottom: stampCfg.bottom, d: stampCfg.d, seal: stampCfg.seal, sealBg: stampCfg.sealBg });
    // 社判の背景（透明／白）。選んでいる社判があれば、それも切り替える
    const sealBgEl = ov.querySelector('[data-seal-bg]');
    sealBgEl.value = stampCfg.sealBg === 'white' ? 'white' : 'none';
    sealBgEl.addEventListener('change', () => {
      stampCfg.sealBg = sealBgEl.value; saveSeal();
      if (selShape && selShape.kind === 'seal') { selShape.bg = sealBgEl.value; drawShapes(selShape.page); }
    });
    sealEl.addEventListener('input', () => { stampCfg.seal = sealEl.value; saveSeal(); });
    // 社判を最初の内容に戻す（担当はデータ印の下段＝今の名前）
    ov.querySelector('[data-seal-reset]').addEventListener('click', () => {
      if (!confirm('社判の内容を初期値に戻しますか？\n（直した内容は消えます）')) return;
      stampCfg.seal = sealDefault(); sealEl.value = stampCfg.seal; saveSeal(); status('社判を初期値に戻しました');
    });
    const curColor = () => $('.fr-col').value || 'blue';
    ov.querySelectorAll('[data-st]').forEach(el => {
      el.value = stampCfg[el.dataset.st];
      el.addEventListener('input', () => {
        stampCfg[el.dataset.st] = el.dataset.st === 'd' ? +el.value : el.value.trim();
        saveSeal();
      });
    });
    // 返信先FAX番号の読み違いを直す。保存は呼び出し側（onFaxEdit）が元の受信FAXの記録に行う
    async function editFax() {
      let v = prompt('返信先のFAX番号を入力してください\n（元の受信FAXの「送信元FAX」も直ります）', o.senderFax || '');
      if (v == null) return;
      v = v.trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－ー―‐−]/g, '-').replace(/\s/g, '');
      if (v === (o.senderFax || '')) return;
      const digits = v.replace(/\D/g, '');
      if (v && (!/^[0-9-]+$/.test(v) || digits.length < 9 || digits.length > 12)) { alert('FAX番号の形になっていません（例：06-1234-5678）'); return; }
      try {
        status('FAX番号を保存中...');
        await o.onFaxEdit(v);
        o.senderFax = v;
        $('.fr-fax .n').textContent = v || '（不明）';
        $('[data-act="copy"]').style.display = v ? '' : 'none';
        status('FAX番号を直しました');
      } catch (err) { status('FAX番号を保存できませんでした：' + err.message); }
    }
    const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); ov.remove(); };
    $('.fr-stype').addEventListener('change', () => { mode = 'stamp'; ov.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === 'stamp')); });
    ov.addEventListener('click', async e => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      const md = e.target && e.target.dataset && e.target.dataset.mode;
      if (md) { mode = md; ov.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === md)); }
      if (act === 'undo') undo();
      if (act === 'close') { if (!hasWork() || confirm('書き込んだ内容は保存されません。閉じますか？')) close(); }
      if (act === 'copy') { try { await navigator.clipboard.writeText(o.senderFax); status('FAX番号をコピーしました'); } catch (_) { status('コピーできませんでした'); } }
      if (act === 'faxedit') await editFax();
      if (act === 'zoomin') { scale = Math.min(3, scale * 1.2); await renderAll(); }
      if (act === 'zoomout') { scale = Math.max(0.4, scale / 1.2); await renderAll(); }
      if (act === 'submit') await submit();
    });

    try {
      await ensureLibs();
      const data = o.pdfBytes instanceof Uint8Array ? o.pdfBytes.slice() : new Uint8Array(o.pdfBytes);
      pdf = await pdfjsLib.getDocument({ data: data.slice() }).promise;
      o._bytes = data;
      // 最初は1ページ目の幅が画面に収まる大きさにする（横向きのFAXでも全体が見えるように）
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      const room = $('.fr-pages').clientWidth - 40;
      scale = Math.max(0.6, Math.min(1.6, room / first.width));
      baseScale = scale;
      await renderAll();
      // 続きを編集：前回書いたもの（build() が返した edit）を戻す
      const ini = o.initial || {};
      (ini.boxes || []).forEach(b => { if (pages[b.page] && b.text) addBox(b.page, b.x, b.y, b.text, b.size, false,
        { color: b.color || 'black', bold: !!b.bold, underline: !!b.underline, boxed: !!b.boxed }); });
      (ini.shapes || []).forEach(x => {
        if (!pages[x.page]) return;
        const sh = Object.assign({}, x, { id: nextId++, w: x.w || 1.5 });
        shapes.push(sh); history.push(sh);
      });
      if ((ini.shapes || []).length) { pages.forEach((_, i) => drawShapes(i)); refreshList(); }
      ensureFont().catch(() => {});   // フォントは裏で先に読んでおく
    } catch (err) {
      $('.fr-pages').innerHTML = `<div style="padding:40px;color:#c0392b">PDFを開けませんでした：${esc(err.message)}</div>`;
      return { close };
    }

    async function renderAll() {
      $('.fr-zoom').textContent = Math.round(scale / baseScale * 100) + '%';
      const wrap = $('.fr-pages');
      wrap.innerHTML = '';
      pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale });
        const div = document.createElement('div');
        div.className = 'fr-page';
        div.style.width = vp.width + 'px'; div.style.height = vp.height + 'px';
        const cv = document.createElement('canvas');
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
        cv.style.width = vp.width + 'px'; cv.style.height = vp.height + 'px';
        div.appendChild(cv);
        div.insertAdjacentHTML('beforeend', `<span class="fr-pno">${i} / ${pdf.numPages} ページ</span>`);
        wrap.appendChild(div);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
        const idx = i - 1;
        // 重なり順：svg（枠・線・丸）→ 文字（.fr-box）→ svg2（スタンプ、いちばん上）
        const mkSvg = cls => {
          const v = document.createElementNS(SVGNS, 'svg');
          v.setAttribute('class', cls);
          v.setAttribute('width', vp.width); v.setAttribute('height', vp.height);
          div.appendChild(v); return v;
        };
        const svg = mkSvg('fr-shapes'), svg2 = mkSvg('fr-shapes fr-stamps');
        pages.push({ page, div, svg, svg2 });
        div.addEventListener('mousedown', e => {
          if (e.target !== cv) return;   // 文字や枠の上をクリックしたときは新しく作らない
          const r = div.getBoundingClientRect();
          const at = ev => [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale];
          e.preventDefault();
          if (selShape) { const p = selShape.page; selShape = null; drawShapes(p); }
          if (mode === 'text' || mode === 'textbox') {
            addBox(idx, at(e)[0], at(e)[1] - DEFAULT_SIZE * 0.6, '', DEFAULT_SIZE, true,
                   { color: curColor(), boxed: mode === 'textbox' });
            return;
          }
          if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
          const [x1, y1] = at(e);
          if (mode === 'stamp' && $('.fr-stype').value === 'done') {   // 完了：クリックした所を中心に
            const st = { id: nextId++, kind: 'done', page: idx, x1, y1, x2: x1, y2: y1, w: 1.5, d: 56 };
            shapes.push(st); history.push(st); drawShapes(idx); refreshList();
            return;
          }
          if (mode === 'stamp' && /^seal/.test($('.fr-stype').value)) {   // 社判：クリックした所が左上
            let lines = String(stampCfg.seal || '').split('\n').map(t => t.trim()).filter(Boolean);
            if ($('.fr-stype').value === 'sealshort') {   // 住所・会社名だけ＝会社名の行まで（会社名が無ければ先頭2行）
              const ci = lines.findIndex(t => /株式会社|有限会社|合同会社/.test(t));
              lines = lines.slice(0, ci >= 0 ? ci + 1 : 2);
            }
            if (!lines.length) { status('社判の内容を右側で入れてください'); sealEl.focus(); return; }
            const st = { id: nextId++, kind: 'seal', page: idx, x1, y1, x2: x1, y2: y1, w: 1, d: 8, lines, color: curColor(), bg: stampCfg.sealBg || 'none' };
            shapes.push(st); history.push(st); drawShapes(idx); refreshList();
            return;
          }
          if (mode === 'stamp') {   // データ印はクリックした所を中心に押す
            if (!stampCfg.bottom) { status('データ印の下段（名前）を右側で入れてください'); const b = ov.querySelector('[data-st="bottom"]'); if (b) b.focus(); return; }
            const st = { id: nextId++, kind: 'stamp', page: idx, x1, y1, x2: x1, y2: y1, w: 1.2,
                         d: stampCfg.d, top: stampCfg.top, date: stampCfg.date, bottom: stampCfg.bottom };
            shapes.push(st); history.push(st); drawShapes(idx); refreshList();
            return;
          }
          const s = { id: nextId++, kind: mode, page: idx, x1, y1, x2: x1, y2: y1, w: +$('.fr-width').value, color: curColor() };
          const mv = ev => {
            let [x2, y2] = at(ev);
            if (s.kind === 'line') {   // ほぼ水平・垂直なら真っすぐに（Shift で必ず）
              const ax = Math.abs(x2 - x1), ay = Math.abs(y2 - y1);
              if (ay < ax * 0.1 || (ev.shiftKey && ay <= ax)) y2 = y1;
              else if (ax < ay * 0.1 || ev.shiftKey) x2 = x1;
            }
            if (s.kind === 'ellipse' && ev.shiftKey) {   // Shift で正円
              const m = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
              x2 = x1 + Math.sign(x2 - x1 || 1) * m; y2 = y1 + Math.sign(y2 - y1 || 1) * m;
            }
            s.x2 = x2; s.y2 = y2; drawShapes(idx, s);
          };
          const up = () => {
            document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
            if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * scale < 4) { drawShapes(idx); return; }   // クリックだけなら描かない
            shapes.push(s); history.push(s); drawShapes(idx); refreshList();
          };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
      }
      pages.forEach((_, i) => drawShapes(i));
      boxes.forEach(placeBox);
      refreshList();
    }

    // b.x, b.y は「縮尺1の画面上の左上（pt）」
    // fmt：{ color, bold, underline, boxed }（boxed＝枠つき・白背景のテキストボックス）
    function addBox(pageIdx, x, y, text, size, focus, fmt) {
      const b = Object.assign({ id: nextId++, page: pageIdx, x, y, text: text || '', size: size || DEFAULT_SIZE,
                                color: 'black', bold: false, underline: false, boxed: false }, fmt || {});
      boxes.push(b); history.push(b);
      placeBox(b);
      refreshList();
      if (focus) setTimeout(() => { const t = b.el && b.el.querySelector('.fr-text'); if (t) t.focus(); }, 0);
      return b;
    }
    function placeBox(b) {
      const host = pages[b.page] && pages[b.page].div;
      if (!host) return;
      if (b.el) b.el.remove();
      const el = document.createElement('div');
      el.className = 'fr-box';
      el.innerHTML = `<span class="fr-grip" title="ドラッグで移動">⠿</span>`
        + `<div class="fr-text" contenteditable="plaintext-only" spellcheck="false"></div>`
        + `<div class="fr-tools"><button data-t="minus" title="小さく">A−</button><span style="color:#fff;font-size:11px;padding:1px 4px" data-t="size"></span>`
        + `<button data-t="plus" title="大きく">A＋</button><button data-t="bold" title="太字" style="font-weight:700">B</button>`
        + `<button data-t="underline" title="下線" style="text-decoration:underline">U</button><button data-t="boxed" title="枠と白背景（テキストボックス）">▭</button>`
        + `<button data-t="del" title="削除">✕</button></div>`;
      const t = el.querySelector('.fr-text');
      t.textContent = b.text;
      host.appendChild(el);
      b.el = el;
      layoutBox(b);
      t.addEventListener('input', () => { b.text = t.innerText.replace(/\n$/, ''); refreshList(); });
      t.addEventListener('blur', () => { if (!b.text.trim()) removeBox(b); });
      el.querySelector('.fr-tools').addEventListener('mousedown', e => {
        const k = e.target.dataset.t; if (!k) return;
        e.preventDefault();   // 入力欄のフォーカスを外さない
        if (k === 'del') { removeBox(b); return; }
        if (k === 'bold' || k === 'underline' || k === 'boxed') { b[k] = !b[k]; layoutBox(b); refreshList(); return; }
        if (k !== 'plus' && k !== 'minus') return;
        b.size = Math.max(6, Math.min(36, b.size + (k === 'plus' ? 1 : -1)));
        layoutBox(b); refreshList();
      });
      // ⠿ でドラッグ移動
      el.querySelector('.fr-grip').addEventListener('mousedown', e => {
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y;
        const mv = ev => { b.x = ox + (ev.clientX - sx) / scale; b.y = oy + (ev.clientY - sy) / scale; layoutBox(b); };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); refreshList(); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    }
    function layoutBox(b) {
      if (!b.el) return;
      b.el.style.left = (b.x * scale - 14) + 'px';   // ⠿ の分だけ左にずらし、文字の頭がクリック位置に来るように
      b.el.style.top = (b.y * scale) + 'px';
      const t = b.el.querySelector('.fr-text'), pad = BOX_PAD * scale;
      t.style.fontSize = (b.size * scale) + 'px';
      t.style.color = colHex(b.color);
      t.style.fontWeight = b.bold ? '700' : '400';
      t.style.textDecoration = b.underline ? 'underline' : 'none';
      // テキストボックス：文字の位置は変えずに、周りに余白・枠・白背景（PDFでも同じ寸法で描く）
      t.style.border = b.boxed ? `${Math.max(1, 0.8 * scale)}px solid ${colHex(b.color)}` : '';
      t.style.background = b.boxed ? '#fff' : '';
      t.style.padding = b.boxed ? pad + 'px' : '0';
      t.style.margin = b.boxed ? `${-pad}px 0 0 ${-pad}px` : '0';
      b.el.querySelector('[data-t="size"]').textContent = b.size + 'pt';
      ['bold', 'underline', 'boxed'].forEach(k => b.el.querySelector(`[data-t="${k}"]`).classList.toggle('on', !!b[k]));
    }
    function removeBox(b) {
      boxes = boxes.filter(x => x !== b);
      if (b.el) b.el.remove();
      refreshList();
    }
    function drawShapes(pageIdx, temp) {
      const pg = pages[pageIdx];
      if (!pg) return;
      const SEL = '#ff8c00';   // 選んでいるもの
      const one = s => {
        if (s.kind === 'stamp') return stampSvg(s);
        if (s.kind === 'done') return doneSvg(s);
        if (s.kind === 'seal') return sealSvg(s);
        const st = `stroke="${s === selShape ? SEL : colHex(s.color)}" stroke-width="${Math.max(1, s.w * scale)}" fill="none"`;
        const shape = s.kind === 'rect'
          ? a => `<rect x="${Math.min(s.x1, s.x2) * scale}" y="${Math.min(s.y1, s.y2) * scale}" width="${Math.abs(s.x2 - s.x1) * scale}" height="${Math.abs(s.y2 - s.y1) * scale}" ${a}/>`
          : s.kind === 'ellipse'
          ? a => `<ellipse cx="${(s.x1 + s.x2) / 2 * scale}" cy="${(s.y1 + s.y2) / 2 * scale}" rx="${Math.abs(s.x2 - s.x1) / 2 * scale}" ry="${Math.abs(s.y2 - s.y1) / 2 * scale}" ${a}/>`
          : a => `<line x1="${s.x1 * scale}" y1="${s.y1 * scale}" x2="${s.x2 * scale}" y2="${s.y2 * scale}" stroke-linecap="round" ${a}/>`;
        return shape(st) + (s === temp ? '' : shape(`class="hit" data-sid="${s.id}" stroke="transparent" stroke-width="12" fill="none"`));
      };
      // データ印の見た目（PDFでは stampLayout の同じ配置で字の形を描く）
      const stampSvg = s => {
        const L = stampLayout(s), z = scale, col = s === selShape ? SEL : '#c8102e';
        const r = s.d / 2;
        const tx = t => t.text ? `<text x="${t.cx * z}" y="${t.base * z}" font-size="${t.size * z}" text-anchor="middle" fill="${col}"
            font-family="'BIZ UDGothic','Yu Gothic',sans-serif"${t.estW > t.maxW ? ` textLength="${t.maxW * z}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(t.text)}</text>` : '';
        return `<circle cx="${s.x1 * z}" cy="${s.y1 * z}" r="${r * z}" fill="none" stroke="${col}" stroke-width="${1.2 * z}"/>`
          + L.chords.map(c => `<line x1="${c[0] * z}" y1="${c[1] * z}" x2="${c[2] * z}" y2="${c[3] * z}" stroke="${col}" stroke-width="${0.8 * z}"/>`).join('')
          + L.texts.map(tx).join('')
          + `<circle class="hit" data-sid="${s.id}" cx="${s.x1 * z}" cy="${s.y1 * z}" r="${r * z}" fill="transparent" stroke="transparent" style="pointer-events:all"/>`;
      };
      const FF = `font-family="'BIZ UDGothic','Yu Gothic',sans-serif"`;
      const hitRect = (s, b) => `<rect class="hit" data-sid="${s.id}" x="${b.x1 * scale}" y="${b.y1 * scale}" width="${(b.x2 - b.x1) * scale}" height="${(b.y2 - b.y1) * scale}" fill="transparent" stroke="transparent" style="pointer-events:all"/>`;
      const doneSvg = s => {
        const L = doneLayout(s), z = scale, col = s === selShape ? SEL : '#c8102e', t = L.text;
        const rc = (q, w) => `<rect x="${q[0] * z}" y="${q[1] * z}" width="${(q[2] - q[0]) * z}" height="${(q[3] - q[1]) * z}" rx="${L.H * 0.12 * z}" fill="none" stroke="${col}" stroke-width="${w * z}"/>`;
        return rc(L.outer, 1.6) + rc(L.inner, 0.6)
          + `<text x="${t.cx * z}" y="${t.base * z}" font-size="${t.size * z}" text-anchor="middle" fill="${col}" font-weight="700" ${FF}>${esc(t.text)}</text>`
          + hitRect(s, shapeBox(s));
      };
      const sealSvg = s => {
        const L = sealLayout(s), z = scale, col = s === selShape ? SEL : colHex(s.color), b = shapeBox(s);
        return (s.bg === 'white' ? `<rect x="${(b.x1 - SEAL_PAD) * z}" y="${(b.y1 - SEAL_PAD) * z}" width="${(b.x2 - b.x1 + SEAL_PAD * 2) * z}" height="${(b.y2 - b.y1 + SEAL_PAD * 2) * z}" fill="#fff"/>` : '')
          + L.items.map(t => `<text x="${t.x0 * z}" y="${t.base * z}" font-size="${t.size * z}" fill="${col}" ${FF}>${esc(t.text)}</text>`).join('')
          + hitRect(s, shapeBox(s));
      };
      const onPage = shapes.filter(s => s.page === pageIdx).concat(temp ? [temp] : []);
      pg.svg.innerHTML = onPage.filter(s => !isStampKind(s)).map(one).join('');
      pg.svg2.innerHTML = onPage.filter(isStampKind).map(one).join('');
      // 押すと選ぶ（✕ 消す が出る）。そのままドラッグすると移動
      pg.div.querySelectorAll('svg .hit').forEach(h => h.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
        const prev = selShape;
        const sh = shapes.find(x => x.id === +h.dataset.sid) || null;
        selShape = sh;
        if (sh && sh.kind === 'seal') sealBgEl.value = sh.bg === 'white' ? 'white' : 'none';   // 選んだ社判の背景を表示
        if (prev && prev.page !== pageIdx) drawShapes(prev.page);
        drawShapes(pageIdx);
        if (!sh) return;
        let lx = e.clientX, ly = e.clientY;
        const mv = ev => {
          moveShape(sh, (ev.clientX - lx) / scale, (ev.clientY - ly) / scale);
          lx = ev.clientX; ly = ev.clientY;
          drawShapes(pageIdx);
        };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      }));
      pg.div.querySelectorAll('.fr-sdel,.fr-hdl').forEach(x => x.remove());
      if (selShape && selShape.page === pageIdx) {
        const s = selShape, btn = document.createElement('button');
        btn.className = 'fr-sdel'; btn.textContent = '✕ 消す';
        const bb = shapeBox(s);
        btn.style.left = (bb.x2 * scale + 4) + 'px';
        btn.style.top = (bb.y1 * scale - 20) + 'px';
        btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); removeShape(s); });
        pg.div.appendChild(btn);
        // 大きさを変えるつまみ：枠・丸は4隅、線は両端、データ印は右下（円周上）
        const r = s.d / 2, dg = Math.SQRT1_2;
        const bb2 = shapeBox(s);
        const hs = s.kind === 'stamp' ? [['r', s.x1 + r * dg, s.y1 + r * dg, 'nwse-resize']]
          : (s.kind === 'done' || s.kind === 'seal') ? [['k', bb2.x2, bb2.y2, 'nwse-resize']]
          : s.kind === 'line' ? [['x1y1', s.x1, s.y1, 'move'], ['x2y2', s.x2, s.y2, 'move']]
          : [['x1y1', s.x1, s.y1], ['x2y1', s.x2, s.y1], ['x2y2', s.x2, s.y2], ['x1y2', s.x1, s.y2]].map(h => {
              const left = h[1] === Math.min(s.x1, s.x2), top = h[2] === Math.min(s.y1, s.y2);
              return h.concat(left === top ? 'nwse-resize' : 'nesw-resize');
            });
        hs.forEach(([key, hx, hy, cur]) => {
          const el = document.createElement('div');
          el.className = 'fr-hdl'; el.title = 'ドラッグで大きさを変える';
          el.style.left = hx * scale + 'px'; el.style.top = hy * scale + 'px'; el.style.cursor = cur;
          el.addEventListener('mousedown', e => {
            e.preventDefault(); e.stopPropagation();
            const rc = pg.div.getBoundingClientRect();
            const mv = ev => {
              let x = (ev.clientX - rc.left) / scale, y = (ev.clientY - rc.top) / scale;
              if (key === 'r') {   // データ印：中心からの距離で直径（約7〜28mm）
                s.d = Math.max(20, Math.min(80, Math.hypot(x - s.x1, y - s.y1) * 2));
              } else if (key === 'k' && s.kind === 'done') {   // 完了：幅（約11〜70mm）
                s.d = Math.max(30, Math.min(200, Math.abs(x - s.x1) * 2));
              } else if (key === 'k') {   // 社判：右下の位置に合わせて字の大きさ（5〜20pt）
                const L = sealLayout(s);
                s.d = Math.max(5, Math.min(20, s.d * Math.max(0.1, (x - s.x1)) / L.w));
              } else {
                const kx = key.slice(0, 2), ky = 'y' + key[3];
                if (s.kind === 'line') {   // 線は描くときと同じく、ほぼ水平・垂直ならそろえる（Shiftで必ず）
                  const ox = kx === 'x1' ? s.x2 : s.x1, oy = ky === 'y1' ? s.y2 : s.y1;
                  const ax = Math.abs(x - ox), ay = Math.abs(y - oy);
                  if (ay < ax * 0.1 || (ev.shiftKey && ay <= ax)) y = oy;
                  else if (ax < ay * 0.1 || ev.shiftKey) x = ox;
                }
                s[kx] = x; s[ky] = y;
              }
              drawShapes(pageIdx);
            };
            const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
          });
          pg.div.appendChild(el);
        });
      }
    }
    function moveShape(s, dx, dy) { s.x1 += dx; s.x2 += dx; s.y1 += dy; s.y2 += dy; }
    function removeShape(s) {
      shapes = shapes.filter(x => x !== s);
      if (selShape === s) selShape = null;
      drawShapes(s.page); refreshList();
    }
    function undo() {
      while (history.length) {
        const it = history.pop();
        if (it.kind) { if (shapes.includes(it)) { removeShape(it); return; } }
        else if (boxes.includes(it)) { removeBox(it); return; }
      }
      status('元に戻すものがありません');
    }
    function refreshList() {
      const list = $('.fr-list');
      const live = boxes.filter(b => b.text.trim());
      list.innerHTML = live.length ? live.map(b =>
        `<div class="fr-li" data-id="${b.id}">${esc(b.text)}<br><small>${b.page + 1}ページ・${b.size}pt${b.bold ? '・太字' : ''}${b.underline ? '・下線' : ''}${b.boxed ? '・ボックス' : ''}</small></div>`).join('')
        : '<div style="color:#8a8fa8">まだありません</div>';
      const note = shapeCountNote(shapes, ' ');
      if (note) list.insertAdjacentHTML('beforeend', `<div style="color:#5a5f7a">${note}</div>`);
      list.querySelectorAll('.fr-li').forEach(li => li.addEventListener('click', () => {
        const b = boxes.find(x => x.id === +li.dataset.id);
        if (b && b.el) { b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.el.querySelector('.fr-text').focus(); }
      }));
    }

    // ---- PDFを作る ----
    async function build() {
      const { PDFDocument, rgb } = PDFLib;
      const doc = await PDFDocument.load(o._bytes, { ignoreEncryption: true });
      // 文字はフォントを埋め込まず、字の形（アウトライン）を図形として描く。
      //   pdf-lib の subset 埋め込みは日本語フォントで字が欠ける不具合があり（「あいうえお」→「えお」）、
      //   丸ごと埋め込むと1通4.7MBになるため。FAXで送るので文字として選べなくても困らない（文字は記録に残す）
      const fk = parsedFont || (parsedFont = fontkit.create(new Uint8Array(await ensureFont())));
      // ページごとの座標変換：画面上の点（縮尺1）→ PDFの点。図形は画面上の点で作ってから変換する（回転したページでも見たまま）
      const conv = pageIdx => {
        const vp1 = pages[pageIdx].page.getViewport({ scale: 1 });
        const P = (x, y) => { const q = vp1.convertToPdfPoint(x, y); return { x: q[0], y: q[1] }; };
        // M/L/Q/C/Z の線を PDF の座標に（drawSvgPath は y を反転するので -Y を渡す）
        const pathPdf = cmds => cmds.map(c => c[0] + (c.length > 1 ? c.slice(1).reduce((a, v, i) => {
          if (i % 2) return a; const q = P(v, c[i + 2]); return a + `${Math.round(q.x * 1000) / 1000} ${Math.round(-q.y * 1000) / 1000} `;
        }, '') : '')).join('');
        return { P, pathPdf, page: doc.getPage(pageIdx) };
      };
      // 1行の字の形（画面上の点）。x0＝左端、by＝ベースライン
      const glyphCmds = (text, size, x0, by) => {
        const run = fk.layout(text), k = size / fk.unitsPerEm, cmds = [];
        let pen = 0;
        run.glyphs.forEach((g, i) => {
          for (const c of g.path.commands) {
            const a = c.args, pts = [];
            for (let j = 0; j < a.length; j += 2) pts.push(x0 + pen + a[j] * k, by - a[j + 1] * k);
            const op = { moveTo: 'M', lineTo: 'L', quadraticCurveTo: 'Q', bezierCurveTo: 'C', closePath: 'Z' }[c.command];
            if (op) cmds.push([op, ...pts]);
          }
          pen += run.positions[i].xAdvance * k;
        });
        return { cmds, w: pen };
      };
      const textW = (text, size) => fk.layout(text).positions.reduce((a, q) => a + q.xAdvance, 0) / fk.unitsPerEm * size;
      const rectCmds = (x1, y1, x2, y2) => [['M', x1, y1], ['L', x2, y1], ['L', x2, y2], ['L', x1, y2], ['Z']];
      const texts = [];
      const drawTexts = () => { for (const b of boxes) {
        const text = b.text.replace(/\s+$/, '');
        if (!text.trim()) continue;
        const { P, pathPdf, page } = conv(b.page);
        const col = rgb(...colRgb(b.color));
        const ascent = fk.ascent / fk.unitsPerEm * b.size;
        const lineH = b.size * 1.25;
        const lines = text.split('\n');
        const maxW = Math.max(...lines.map(l => l ? textW(l, b.size) : 0));
        if (b.boxed) {   // テキストボックス：白で塗って枠（画面と同じ余白）
          page.drawSvgPath(pathPdf(rectCmds(b.x - BOX_PAD, b.y - BOX_PAD, b.x + maxW + BOX_PAD, b.y + lineH * lines.length + BOX_PAD)),
            { x: 0, y: 0, color: rgb(1, 1, 1), borderColor: col, borderWidth: 0.8 });
        }
        lines.forEach((line, i) => {
          if (!line) return;
          const by = b.y + ascent + lineH * i;
          const g = glyphCmds(line, b.size, b.x, by);
          if (!g.cmds.length) return;
          // 太字は字の輪郭を同じ色でなぞって太くする（太字フォントを読み込まずに済む）
          page.drawSvgPath(pathPdf(g.cmds), Object.assign({ x: 0, y: 0, color: col },
            b.bold ? { borderColor: col, borderWidth: b.size * 0.05 } : {}));
          if (b.underline) {
            const uy = by + b.size * 0.13;
            page.drawLine({ start: P(b.x, uy), end: P(b.x + g.w, uy), thickness: b.size * 0.06, color: col });
          }
        });
        texts.push({ page: b.page + 1, text, size: b.size, color: b.color, bold: b.bold, underline: b.underline, boxed: b.boxed,
                     xMm: Math.round(b.x * MM_PER_PT * 10) / 10, yMm: Math.round(b.y * MM_PER_PT * 10) / 10 });
      } };
      // 枠・線：両端（枠は4隅）をPDFの座標に直して線で結ぶ（回転したページでも見たままの向き）
      const { LineCapStyle } = PDFLib;
      const shapesOut = [];
      const mm = v => Math.round(v * MM_PER_PT * 10) / 10;
      const red = rgb(0.78, 0.06, 0.18);
      const drawShapePdf = s => {
        const { P, pathPdf, page } = conv(s.page);
        const col = rgb(...colRgb(s.color));   // 色の無い古い記録は黒
        const seg = (a, b, cap) => page.drawLine({ start: a, end: b, thickness: s.kind === 'stamp' ? 0.8 : s.w,
                                                    color: s.kind === 'stamp' ? red : col, lineCap: cap });
        if (s.kind === 'line') seg(P(s.x1, s.y1), P(s.x2, s.y2), LineCapStyle.Round);
        else if (s.kind === 'ellipse') {
          page.drawSvgPath(pathPdf(ellipseCmds((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2)),
            { x: 0, y: 0, borderColor: col, borderWidth: s.w });
        } else if (s.kind === 'done') {
          const L = doneLayout(s), t = L.text;
          page.drawSvgPath(pathPdf(rectCmds(...L.outer)), { x: 0, y: 0, borderColor: red, borderWidth: 1.6 });
          page.drawSvgPath(pathPdf(rectCmds(...L.inner)), { x: 0, y: 0, borderColor: red, borderWidth: 0.6 });
          const size = Math.min(t.size, t.maxW / Math.max(textW(t.text, 1), 0.01));
          const g = glyphCmds(t.text, size, t.cx - textW(t.text, size) / 2, t.base);
          if (g.cmds.length) page.drawSvgPath(pathPdf(g.cmds), { x: 0, y: 0, color: red, borderColor: red, borderWidth: size * 0.04 });
        } else if (s.kind === 'seal') {
          const items = sealLayout(s).items;
          if (s.bg === 'white') {   // 背景を白：元のFAXの上に白を敷いてから字（幅は実際の字幅で）
            const w = Math.max(...items.map(t => textW(t.text, t.size)), 0);
            const last = items[items.length - 1];
            page.drawSvgPath(pathPdf(rectCmds(s.x1 - SEAL_PAD, s.y1 - SEAL_PAD, s.x1 + w + SEAL_PAD, (last ? last.base + last.size * 0.3 : s.y1) + SEAL_PAD)),
              { x: 0, y: 0, color: rgb(1, 1, 1) });
          }
          for (const t of items) {
            const g = glyphCmds(t.text, t.size, t.x0, t.base);
            if (g.cmds.length) page.drawSvgPath(pathPdf(g.cmds), { x: 0, y: 0, color: col });
          }
        } else if (s.kind === 'stamp') {
          const r = s.d / 2, L = stampLayout(s);
          page.drawSvgPath(pathPdf(ellipseCmds(s.x1, s.y1, r, r)), { x: 0, y: 0, borderColor: red, borderWidth: 1.2 });
          L.chords.forEach(c => seg(P(c[0], c[1]), P(c[2], c[3]), LineCapStyle.Butt));
          for (const t of L.texts) {
            if (!t.text) continue;
            // 実際の字幅で大きさを合わせ、中央にそろえる
            const run = fk.layout(t.text);
            const w1 = run.positions.reduce((a, q) => a + q.xAdvance, 0) / fk.unitsPerEm;   // 1pt あたりの幅
            const size = Math.min(t.size, t.maxW / Math.max(w1, 0.01));
            const g = glyphCmds(t.text, size, t.cx - w1 * size / 2, t.base);
            if (g.cmds.length) page.drawSvgPath(pathPdf(g.cmds), { x: 0, y: 0, color: red });
          }
        } else {
          const c = [P(s.x1, s.y1), P(s.x2, s.y1), P(s.x2, s.y2), P(s.x1, s.y2)];
          c.forEach((a, i) => seg(a, c[(i + 1) % 4], LineCapStyle.Projecting));   // 角が欠けないよう線端を伸ばす
        }
        shapesOut.push(Object.assign({ page: s.page + 1, kind: s.kind, w: s.w, color: s.color, x1Mm: mm(s.x1), y1Mm: mm(s.y1), x2Mm: mm(s.x2), y2Mm: mm(s.y2) },
          s.kind === 'stamp' ? { dMm: mm(s.d), top: s.top, date: s.date, bottom: s.bottom } : {},
          s.kind === 'done' ? { dMm: mm(s.d) } : {}, s.kind === 'seal' ? { size: s.d, lines: s.lines, bg: s.bg || 'none' } : {}));
      };
      // 重なり順（画面と同じ）：枠・線・丸 → 文字・テキストボックス → スタンプ（いちばん上）
      shapes.filter(s => !isStampKind(s)).forEach(drawShapePdf);
      drawTexts();
      shapes.filter(isStampKind).forEach(drawShapePdf);
      const bytes = await doc.save();
      const cn = shapeCountNote(shapesOut, '');
      const shapeNote = cn ? `［${cn}］` : '';
      const summaryText = texts.map(t => t.text.replace(/\n/g, ' ')).join(' ／ ') + shapeNote;
      // edit：あとで「続きを編集」で戻すための元の値（縮尺1の画面上の点）
      const r2 = v => Math.round(v * 100) / 100;
      const edit = {
        boxes: boxes.filter(b => b.text.trim()).map(b => ({ page: b.page, x: r2(b.x), y: r2(b.y), size: b.size, text: b.text,
                                                           color: b.color, bold: b.bold, underline: b.underline, boxed: b.boxed })),
        shapes: shapes.map(x => {
          const o2 = { kind: x.kind, page: x.page, x1: r2(x.x1), y1: r2(x.y1), x2: r2(x.x2), y2: r2(x.y2), w: x.w };
          ['color', 'd', 'top', 'date', 'bottom', 'lines', 'bg'].forEach(k => { if (x[k] !== undefined) o2[k] = x[k]; });
          return o2;
        }),
      };
      return { bytes, texts, shapes: shapesOut, summaryText, edit };
    }
    async function submit() {
      const btn = $('[data-act="submit"]');
      if (!hasWork()) { status('まだ何も書き込まれていません'); return; }
      btn.disabled = true;
      try {
        status('PDFを作成中...（初回は日本語フォントの読み込みで数秒かかります）');
        const result = await build();
        status('');
        if (o.onSubmit) {
          const r = await o.onSubmit(result, { close, status, panel: $('.fr-side-in') });
          if (r !== false) close();
        } else close();
      } catch (err) {
        console.error(err);
        status('エラー：' + err.message);
      } finally { btn.disabled = false; }
    }
    return { close, panel: $('.fr-side-in') };
  }

  // ---- 印刷画面を開く（PC-FAX を選んで送信）----
  function printPdf(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
    fr.src = url;
    fr.onload = () => {
      setTimeout(() => {
        try { fr.contentWindow.focus(); fr.contentWindow.print(); }
        catch (_) { window.open(url, '_blank'); }   // 印刷画面を開けないブラウザでは、別タブで開いて印刷してもらう
      }, 300);
      setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 10 * 60 * 1000);
    };
    document.body.appendChild(fr);
  }

  window.FaxReply = { open, printPdf, fontUrl: FONT_URL, ensureLibs };
})();
