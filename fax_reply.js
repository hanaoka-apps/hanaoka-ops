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
  .fr-overlay{position:fixed;inset:0;background:rgba(15,17,40,.55);z-index:3000;display:flex;align-items:center;justify-content:center}
  .fr-modal{background:#fff;color:#1f2330;width:min(1400px,97vw);height:94vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:inherit}
  .fr-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #e3e5ef;flex-wrap:wrap}
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
  .fr-box{position:absolute;display:flex;align-items:flex-start;cursor:default}
  .fr-grip{width:12px;margin-right:2px;cursor:move;color:#23268f;font-size:11px;line-height:1;opacity:0;user-select:none}
  .fr-text{min-width:6px;outline:1px dashed rgba(35,38,143,.55);background:rgba(255,255,230,.55);white-space:pre;color:#000;line-height:1.25;padding:0;font-family:'BIZ UDGothic','BIZ UDPGothic','Yu Gothic',sans-serif}
  .fr-box:focus-within .fr-text{outline:2px solid #23268f;background:rgba(255,255,200,.85)}
  .fr-box:hover .fr-grip,.fr-box:focus-within .fr-grip{opacity:1}
  .fr-tools{position:absolute;top:-24px;left:14px;display:none;gap:2px;background:#23268f;border-radius:5px;padding:2px;white-space:nowrap}
  .fr-box:focus-within .fr-tools{display:flex}
  .fr-tools button{border:none;background:transparent;color:#fff;font-size:11px;padding:1px 6px;cursor:pointer;border-radius:3px}
  .fr-tools button:hover{background:rgba(255,255,255,.2)}
  .fr-side{width:300px;border-left:1px solid #e3e5ef;display:flex;flex-direction:column;min-height:0}
  .fr-side-in{flex:1;overflow:auto;padding:12px 14px;font-size:12px}
  .fr-help{background:#f6f7fb;border-radius:8px;padding:8px 10px;color:#4a4f68;line-height:1.6;margin-bottom:10px}
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
  .fr-shapes{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
  .fr-shapes .hit{pointer-events:stroke;cursor:pointer}
  .fr-sdel{position:absolute;z-index:2;border:none;background:#c0392b;color:#fff;font-size:11px;border-radius:4px;padding:1px 6px;cursor:pointer}
  `;
  function injectCss() {
    if (document.getElementById('fr-css')) return;
    const st = document.createElement('style'); st.id = 'fr-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
          ${o.senderFax ? '<button class="fr-btn" data-act="copy">コピー</button>' : ''}</span>
        <span class="fr-modes"><button class="fr-btn on" data-mode="text" title="クリックした所に文字を書く">Ａ 文字</button><button class="fr-btn" data-mode="rect" title="ドラッグで四角い枠を描く">□ 枠</button><button class="fr-btn" data-mode="line" title="ドラッグで直線を描く（ほぼ水平・垂直なら真っすぐにそろえる。Shiftで必ずそろえる）">／ 線</button></span>
        <select class="fr-lw" title="枠・線の太さ"><option value="1">細</option><option value="1.5" selected>中</option><option value="2.5">太</option></select>
        <button class="fr-btn" data-act="undo" title="最後に書いたものを消す">↶ 元に戻す</button>
        <span style="flex:1"></span>
        <button class="fr-btn" data-act="zoomout">－</button><span class="fr-zoom" style="font-size:12px;min-width:42px;text-align:center"></span><button class="fr-btn" data-act="zoomin">＋</button>
        <button class="fr-btn" data-act="close">閉じる</button>
      </div>
      <div class="fr-body">
        <div class="fr-pages"><div style="padding:40px;color:#6b7089">PDFを読み込み中...</div></div>
        <div class="fr-side">
          <div class="fr-side-in">
            <div class="fr-help"><b>Ａ 文字</b>：書きたい所をクリックして入力（⠿ で移動、小さなボタンで大きさ・削除、Enter で改行）。<br>
              <b>□ 枠／／ 線</b>：ドラッグで描く。描いた枠・線をクリックすると ✕ で消せます。<br>
              <b>↶ 元に戻す</b>：最後に書いたものを消します。</div>
            <div class="fr-h">書き込んだ文字</div>
            <div class="fr-list"><div style="color:#8a8fa8">まだありません</div></div>
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
    let scale = 1.4, baseScale = 1.4, pdf = null, pages = [], boxes = [], nextId = 1, closed = false;
    // 枠・線：{ id, kind:'rect'|'line', page, x1, y1, x2, y2, w }（座標は文字と同じ「縮尺1の画面上の点」、w は線の太さpt）
    let mode = 'text', shapes = [], selShape = null;
    const history = [];   // 書いた順（元に戻す用）
    const hasWork = () => boxes.some(b => b.text.trim()) || shapes.length > 0;
    const onKey = e => {
      if (!selShape || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
      if (document.activeElement && document.activeElement.isContentEditable) return;
      e.preventDefault(); removeShape(selShape);
    };
    document.addEventListener('keydown', onKey);
    const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); ov.remove(); };
    ov.addEventListener('click', async e => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      const md = e.target && e.target.dataset && e.target.dataset.mode;
      if (md) { mode = md; ov.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === md)); }
      if (act === 'undo') undo();
      if (act === 'close') { if (!hasWork() || confirm('書き込んだ内容は保存されません。閉じますか？')) close(); }
      if (act === 'copy') { try { await navigator.clipboard.writeText(o.senderFax); status('FAX番号をコピーしました'); } catch (_) { status('コピーできませんでした'); } }
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
      (ini.boxes || []).forEach(b => { if (pages[b.page] && b.text) addBox(b.page, b.x, b.y, b.text, b.size, false); });
      (ini.shapes || []).forEach(x => {
        if (!pages[x.page]) return;
        const sh = { id: nextId++, kind: x.kind, page: x.page, x1: x.x1, y1: x.y1, x2: x.x2, y2: x.y2, w: x.w || 1.5 };
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
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('class', 'fr-shapes');
        svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height);
        div.appendChild(svg);
        pages.push({ page, div, svg });
        div.addEventListener('mousedown', e => {
          if (e.target !== cv) return;   // 文字や枠の上をクリックしたときは新しく作らない
          const r = div.getBoundingClientRect();
          const at = ev => [(ev.clientX - r.left) / scale, (ev.clientY - r.top) / scale];
          e.preventDefault();
          if (selShape) { const p = selShape.page; selShape = null; drawShapes(p); }
          if (mode === 'text') {
            addBox(idx, at(e)[0], at(e)[1] - DEFAULT_SIZE * 0.6, '', DEFAULT_SIZE, true);
            return;
          }
          if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
          const [x1, y1] = at(e);
          const s = { id: nextId++, kind: mode, page: idx, x1, y1, x2: x1, y2: y1, w: +$('.fr-lw').value };
          const mv = ev => {
            let [x2, y2] = at(ev);
            if (s.kind === 'line') {   // ほぼ水平・垂直なら真っすぐに（Shift で必ず）
              const ax = Math.abs(x2 - x1), ay = Math.abs(y2 - y1);
              if (ay < ax * 0.1 || (ev.shiftKey && ay <= ax)) y2 = y1;
              else if (ax < ay * 0.1 || ev.shiftKey) x2 = x1;
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
    function addBox(pageIdx, x, y, text, size, focus) {
      const b = { id: nextId++, page: pageIdx, x, y, text: text || '', size: size || DEFAULT_SIZE };
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
        + `<button data-t="plus" title="大きく">A＋</button><button data-t="del" title="削除">✕</button></div>`;
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
      b.el.querySelector('.fr-text').style.fontSize = (b.size * scale) + 'px';
      b.el.querySelector('[data-t="size"]').textContent = b.size + 'pt';
    }
    function removeBox(b) {
      boxes = boxes.filter(x => x !== b);
      if (b.el) b.el.remove();
      refreshList();
    }
    function drawShapes(pageIdx, temp) {
      const pg = pages[pageIdx];
      if (!pg) return;
      const one = s => {
        const st = `stroke="${s === selShape ? '#d33' : '#000'}" stroke-width="${Math.max(1, s.w * scale)}" fill="none"`;
        const shape = s.kind === 'rect'
          ? a => `<rect x="${Math.min(s.x1, s.x2) * scale}" y="${Math.min(s.y1, s.y2) * scale}" width="${Math.abs(s.x2 - s.x1) * scale}" height="${Math.abs(s.y2 - s.y1) * scale}" ${a}/>`
          : a => `<line x1="${s.x1 * scale}" y1="${s.y1 * scale}" x2="${s.x2 * scale}" y2="${s.y2 * scale}" stroke-linecap="round" ${a}/>`;
        return shape(st) + (s === temp ? '' : shape(`class="hit" data-sid="${s.id}" stroke="transparent" stroke-width="12" fill="none"`));
      };
      pg.svg.innerHTML = shapes.filter(s => s.page === pageIdx).map(one).join('') + (temp ? one(temp) : '');
      pg.svg.querySelectorAll('.hit').forEach(h => h.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        const prev = selShape;
        selShape = shapes.find(x => x.id === +h.dataset.sid) || null;
        if (prev && prev.page !== pageIdx) drawShapes(prev.page);
        drawShapes(pageIdx);
      }));
      pg.div.querySelectorAll('.fr-sdel').forEach(x => x.remove());
      if (selShape && selShape.page === pageIdx) {
        const s = selShape, btn = document.createElement('button');
        btn.className = 'fr-sdel'; btn.textContent = '✕ 消す';
        btn.style.left = (Math.max(s.x1, s.x2) * scale + 4) + 'px';
        btn.style.top = (Math.min(s.y1, s.y2) * scale - 20) + 'px';
        btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); removeShape(s); });
        pg.div.appendChild(btn);
      }
    }
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
        `<div class="fr-li" data-id="${b.id}">${esc(b.text)}<br><small>${b.page + 1}ページ・${b.size}pt</small></div>`).join('')
        : '<div style="color:#8a8fa8">まだありません</div>';
      const nr = shapes.filter(s => s.kind === 'rect').length, nl = shapes.length - nr;
      if (nr || nl) list.insertAdjacentHTML('beforeend', `<div style="color:#5a5f7a">${[nr ? `枠 ${nr}` : '', nl ? `線 ${nl}` : ''].filter(Boolean).join('・')}</div>`);
      list.querySelectorAll('.fr-li').forEach(li => li.addEventListener('click', () => {
        const b = boxes.find(x => x.id === +li.dataset.id);
        if (b && b.el) { b.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); b.el.querySelector('.fr-text').focus(); }
      }));
    }

    // ---- PDFを作る ----
    async function build() {
      const { PDFDocument, rgb, degrees } = PDFLib;
      const doc = await PDFDocument.load(o._bytes, { ignoreEncryption: true });
      // 文字はフォントを埋め込まず、字の形（アウトライン）を図形として描く。
      //   pdf-lib の subset 埋め込みは日本語フォントで字が欠ける不具合があり（「あいうえお」→「えお」）、
      //   丸ごと埋め込むと1通4.7MBになるため。FAXで送るので文字として選べなくても困らない（文字は記録に残す）
      const fk = parsedFont || (parsedFont = fontkit.create(new Uint8Array(await ensureFont())));
      const glyphSvg = (line, size) => {
        const k = size / fk.unitsPerEm, run = fk.layout(line);
        let pen = 0, d = '';
        const f = v => Math.round(v * 1000) / 1000;
        run.glyphs.forEach((g, i) => {
          for (const c of g.path.commands) {
            const a = c.args, pt = j => `${f(pen + a[j] * k)} ${f(-a[j + 1] * k)}`;
            if (c.command === 'moveTo') d += `M${pt(0)}`;
            else if (c.command === 'lineTo') d += `L${pt(0)}`;
            else if (c.command === 'quadraticCurveTo') d += `Q${pt(0)} ${pt(2)}`;
            else if (c.command === 'bezierCurveTo') d += `C${pt(0)} ${pt(2)} ${pt(4)}`;
            else if (c.command === 'closePath') d += 'Z';
          }
          pen += run.positions[i].xAdvance * k;
        });
        return d;
      };
      const texts = [];
      for (const b of boxes) {
        const text = b.text.replace(/\s+$/, '');
        if (!text.trim()) continue;
        const pg = pages[b.page].page;
        const vp1 = pg.getViewport({ scale: 1 });
        // 画面上の3点をPDFの座標に直し、文字の進む向き(dx)と下向き(dy)を求める（回転したページでもそのまま正しい）
        const p0 = vp1.convertToPdfPoint(b.x, b.y);
        const px = vp1.convertToPdfPoint(b.x + 1, b.y);
        const py = vp1.convertToPdfPoint(b.x, b.y + 1);
        const dx = [px[0] - p0[0], px[1] - p0[1]], dy = [py[0] - p0[0], py[1] - p0[1]];
        const angle = Math.atan2(dx[1], dx[0]) * 180 / Math.PI;
        const ascent = fk.ascent / fk.unitsPerEm * b.size;
        const lineH = b.size * 1.25;
        const page = doc.getPage(b.page);
        text.split('\n').forEach((line, i) => {
          if (!line) return;
          const down = ascent + lineH * i;
          const d = glyphSvg(line, b.size);
          if (!d) return;
          page.drawSvgPath(d, {
            x: p0[0] + dy[0] * down, y: p0[1] + dy[1] * down,
            color: rgb(0, 0, 0), rotate: degrees(angle),
          });
        });
        texts.push({ page: b.page + 1, text, size: b.size,
                     xMm: Math.round(b.x * MM_PER_PT * 10) / 10, yMm: Math.round(b.y * MM_PER_PT * 10) / 10 });
      }
      // 枠・線：両端（枠は4隅）をPDFの座標に直して線で結ぶ（回転したページでも見たままの向き）
      const { LineCapStyle } = PDFLib;
      const shapesOut = [];
      const mm = v => Math.round(v * MM_PER_PT * 10) / 10;
      for (const s of shapes) {
        const vp1 = pages[s.page].page.getViewport({ scale: 1 });
        const P = (x, y) => { const q = vp1.convertToPdfPoint(x, y); return { x: q[0], y: q[1] }; };
        const page = doc.getPage(s.page);
        const seg = (a, b, cap) => page.drawLine({ start: a, end: b, thickness: s.w, color: rgb(0, 0, 0), lineCap: cap });
        if (s.kind === 'line') seg(P(s.x1, s.y1), P(s.x2, s.y2), LineCapStyle.Round);
        else {
          const c = [P(s.x1, s.y1), P(s.x2, s.y1), P(s.x2, s.y2), P(s.x1, s.y2)];
          c.forEach((a, i) => seg(a, c[(i + 1) % 4], LineCapStyle.Projecting));   // 角が欠けないよう線端を伸ばす
        }
        shapesOut.push({ page: s.page + 1, kind: s.kind, w: s.w, x1Mm: mm(s.x1), y1Mm: mm(s.y1), x2Mm: mm(s.x2), y2Mm: mm(s.y2) });
      }
      const bytes = await doc.save();
      const nr = shapesOut.filter(s => s.kind === 'rect').length, nl = shapesOut.length - nr;
      const shapeNote = (nr || nl) ? `［${[nr ? `枠${nr}` : '', nl ? `線${nl}` : ''].filter(Boolean).join('・')}］` : '';
      const summaryText = texts.map(t => t.text.replace(/\n/g, ' ')).join(' ／ ') + shapeNote;
      // edit：あとで「続きを編集」で戻すための元の値（縮尺1の画面上の点）
      const r2 = v => Math.round(v * 100) / 100;
      const edit = {
        boxes: boxes.filter(b => b.text.trim()).map(b => ({ page: b.page, x: r2(b.x), y: r2(b.y), size: b.size, text: b.text })),
        shapes: shapes.map(x => ({ kind: x.kind, page: x.page, x1: r2(x.x1), y1: r2(x.y1), x2: r2(x.x2), y2: r2(x.y2), w: x.w })),
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
