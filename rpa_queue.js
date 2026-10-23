/* RPA専用機へのジョブ依頼（順番待ち）共通部品
   SharePoint の SharedMasters/_rpa_queue/pending/ に依頼ファイルを1件置くと、RPA専用機の
   常駐スクリプト（scripts/rpa_queue_worker.ps1）が古い順に1件ずつ実行し、
   pending → running → done / failed とフォルダを移しながら結果を書き込む。
   ジョブ名と中身は scripts/rpa_jobs.json で定義する。

   使い方（各画面のサインイン処理のあとで）:
     RpaQueue.init({ getToken, driveId: <SharedMastersのドライブID>, getWriteToken });   // getWriteToken は書き込み用（省略時は getToken）
     const { name } = await RpaQueue.request('sales_master', { app: '営業日報ダッシュボード', requestedBy: account.username });
     // 取込のように「依頼ごとに別の仕事」になるジョブは batchId を付ける（同じ batchId の依頼だけをまとめる）。
     // 依頼に付随するファイルは writeFile / readJson / exists で SharedMasters 直下から置き・読む。
     const stop = RpaQueue.watch(name, s => { ... s.state: pending / running / done / failed / timeout ... });

   status の中身:
     pending : { state, ahead, workerOk, workerSeenAt }  … 前に待っているジョブ数（実行中を含む）
     running : { state, startedAt, workerOk, workerSeenAt }
     done    : { state, startedAt, finishedAt }
     failed  : { state, finishedAt, error }
     unknown : { state }               … 同期の途中などで一時的に見つからない（待ち続けてよい）
     timeout : { state }               … watch の上限時間を過ぎた
   workerOk が false のときは、RPA専用機の常駐スクリプトが止まっている（_rpa_queue/heartbeat.json が
   20分以上更新されていない）。RpaQueue.workerWarning(s) で画面に出す文言が取れる。 */
const RpaQueue = (() => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const ROOT = '_rpa_queue';
  // 常駐スクリプトは動いている印(heartbeat.json)を5分ごとに書く。同期の遅れも見込んで20分で「応答なし」
  const HEARTBEAT_STALE_MS = 20 * 60 * 1000;
  let cfg = null;

  function init({ getToken, driveId, getWriteToken }) {
    cfg = { getToken, driveId, getWriteToken: getWriteToken || getToken };
  }

  function itemUrl(folder, name) {
    const path = [ROOT, folder, name].filter(Boolean).map(encodeURIComponent).join('/');
    return `${GRAPH}/drives/${cfg.driveId}/root:/${path}`;
  }

  async function graph(url, opts = {}) {
    if (!cfg) throw new Error('RpaQueue.init() を先に呼んでください');
    const { write, ...fetchOpts } = opts;
    const token = await (write ? cfg.getWriteToken : cfg.getToken)();
    const res = await fetch(url, {
      ...fetchOpts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
    return res;
  }

  // フォルダ内の依頼ファイル名(古い順)。フォルダがまだ無ければ空
  async function list(folder) {
    const res = await graph(itemUrl(folder) + ':/children?$select=name&$top=999');
    if (!res) return [];
    return (await res.json()).value.map(f => f.name).filter(n => n.endsWith('.json')).sort();
  }

  async function read(folder, name) {
    const res = await graph(itemUrl(folder, name) + ':/content');
    return res ? res.json() : null;
  }

  // ファイル名: <UTC日時>_<ジョブ名>_<乱数>.json（名前順＝依頼順）
  function newName(job) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
    const rand = Math.random().toString(16).slice(2, 6);
    return `${ts}_${job}_${rand}.json`;
  }

  function jobOf(name) {
    const m = String(name).match(/^[^_]+_(.+)_[^_]+\.json$/);
    return m ? m[1] : null;
  }

  // SharedMasters 直下からのパス（_rpa_import/<バッチ番号>/manifest.json など）
  function pathUrl(path) {
    return `${GRAPH}/drives/${cfg.driveId}/root:/${String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  }
  async function exists(path) {
    return !!(await graph(pathUrl(path) + '?$select=id'));
  }
  async function readJson(path) {
    const res = await graph(pathUrl(path) + ':/content');
    return res ? res.json() : null;
  }
  // 小さいファイル（4MBまで）を置く。フォルダが無ければ自動で作られる。body は文字列か Uint8Array
  async function writeFile(path, body, contentType = 'application/octet-stream') {
    await graph(pathUrl(path) + ':/content', { method: 'PUT', write: true, headers: { 'Content-Type': contentType }, body });
  }

  // 依頼を登録する。同じジョブがすでに待っていれば登録せず、その依頼を返す
  // （RPA専用機は同じジョブをまとめて1回で実行するので、重ねて依頼する意味がない）。
  // batchId を付けたときは、同じ batchId の依頼だけをまとめる（別の batchId は別の仕事として並べる）
  // params：ジョブに渡す値（例 支払管理の仕入 { payYm: '2026/10' }）。依頼ファイルにそのまま入る（RPA 専用機のフローが読む）
  async function request(job, { app = '', requestedBy = '', batchId = '', params = null } = {}) {
    const pending = await list('pending');
    for (const n of pending.filter(n => jobOf(n) === job)) {
      if (!batchId) return { name: n, deduped: true };
      const r = await read('pending', n).catch(() => null);
      if (r && r.batchId === batchId) return { name: n, deduped: true };
    }
    const name = newName(job);
    const body = { job, app, requestedBy, requestedAt: new Date().toISOString() };
    if (batchId) body.batchId = batchId;
    if (params) body.params = params;
    await graph(itemUrl('pending', name) + ':/content', {
      method: 'PUT',
      write: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { name, deduped: false };
  }

  // RPA専用機の常駐スクリプトが動いているか。確認できなかったときは null（誤って「止まっている」と出さない）
  async function health() {
    try {
      const hb = await read(null, 'heartbeat.json');
      const seenAt = hb ? Date.parse(hb.updatedAt) : NaN;
      return {
        ok: !isNaN(seenAt) && Date.now() - seenAt < HEARTBEAT_STALE_MS,
        seenAt: isNaN(seenAt) ? null : seenAt,
        job: (hb && hb.job) || '',
        // 専用機が対応している機能（heartbeat.json の features。例 ['tempDeliveryCodes']）。無い・古い版は空
        features: hb && Array.isArray(hb.features) ? hb.features.map(String) : [],
      };
    } catch (e) {
      console.warn('[RpaQueue] 稼働状況の確認に失敗', e);
      return null;
    }
  }

  function withHealth(s, h) {
    return h ? { ...s, workerOk: h.ok, workerSeenAt: h.seenAt } : s;
  }

  // 待ち・実行中の依頼について、RPA専用機が止まっていそうなら画面に出す文言を返す（問題なければ空文字）
  function workerWarning(s) {
    if (!s || s.workerOk !== false || (s.state !== 'pending' && s.state !== 'running')) return '';
    let seen = '記録なし';
    if (s.workerSeenAt) {
      const d = new Date(s.workerSeenAt);
      seen = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `⚠️ RPA専用機が応答していません（最終応答: ${seen}）。RPA専用機が動いているか確認してください（依頼は残っているので、動けば順番に処理されます）`;
  }

  async function status(name) {
    const [pending, running] = await Promise.all([list('pending'), list('running')]);
    const idx = pending.indexOf(name);
    if (idx >= 0) {
      // 自分より前の別ジョブの数（同じジョブはまとめて実行されるので数えない）＋実行中
      const job = jobOf(name);
      const before = new Set(pending.slice(0, idx).map(jobOf).filter(j => j !== job));
      return withHealth({ state: 'pending', ahead: before.size + (running.length ? 1 : 0) }, await health());
    }
    if (running.includes(name)) {
      const r = await read('running', name);
      return withHealth({ state: 'running', startedAt: r && r.startedAt }, await health());
    }
    const done = await read('done', name);
    if (done) return { state: 'done', startedAt: done.startedAt, finishedAt: done.finishedAt };
    const failed = await read('failed', name);
    if (failed) return { state: 'failed', finishedAt: failed.finishedAt, error: failed.error || '' };
    return { state: 'unknown' };
  }

  // 状態を定期的に確認して onUpdate に渡す。done / failed / timeout で止まる。止める関数を返す
  function watch(name, onUpdate, { intervalMs = 30 * 1000, timeoutMs = 60 * 60 * 1000 } = {}) {
    const started = Date.now();
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      let s;
      try {
        s = await status(name);
      } catch (e) {
        // 一時的な通信エラーは次の確認で取り返せるので、待機は続ける
        console.warn('[RpaQueue] 状況の確認に失敗', e);
      }
      if (stopped) return;
      if (s) {
        onUpdate(s);
        if (s.state === 'done' || s.state === 'failed') return;
      }
      if (Date.now() - started > timeoutMs) { onUpdate({ state: 'timeout' }); return; }
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }

  // 名前の先頭の日時（UTC。名前順＝依頼順）
  function stampOf(name) { return String(name).split('_')[0]; }

  // 指定ジョブの依頼を、pending / running / done / failed から探す（afterName より後に依頼されたもの。新しい順）。
  // 取込のあとに専用機が自動で足す確認用出力の依頼を、アプリが見つけるために使う
  async function find(job, afterName = '') {
    const out = [];
    for (const folder of ['pending', 'running', 'done', 'failed']) {
      (await list(folder)).forEach(n => { if (jobOf(n) === job && stampOf(n) > stampOf(afterName)) out.push({ name: n, folder }); });
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  return { init, request, status, watch, health, workerWarning, jobOf, find, exists, readJson, writeFile };
})();
