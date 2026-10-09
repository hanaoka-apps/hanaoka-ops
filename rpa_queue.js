/* RPA専用機へのジョブ依頼（順番待ち）共通部品
   SharePoint の SharedMasters/_rpa_queue/pending/ に依頼ファイルを1件置くと、RPA専用機の
   常駐スクリプト（scripts/rpa_queue_worker.ps1）が古い順に1件ずつ実行し、
   pending → running → done / failed とフォルダを移しながら結果を書き込む。
   ジョブ名と中身は scripts/rpa_jobs.json で定義する。

   使い方（各画面のサインイン処理のあとで）:
     RpaQueue.init({ getToken, driveId: <SharedMastersのドライブID> });
     const { name } = await RpaQueue.request('sales_master', { app: '営業日報ダッシュボード', requestedBy: account.username });
     const stop = RpaQueue.watch(name, s => { ... s.state: pending / running / done / failed / timeout ... });

   status の中身:
     pending : { state, ahead }        … 前に待っているジョブ数（実行中を含む）
     running : { state, startedAt }
     done    : { state, startedAt, finishedAt }
     failed  : { state, finishedAt, error }
     unknown : { state }               … 同期の途中などで一時的に見つからない（待ち続けてよい）
     timeout : { state }               … watch の上限時間を過ぎた */
const RpaQueue = (() => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const ROOT = '_rpa_queue';
  let cfg = null;

  function init({ getToken, driveId }) {
    cfg = { getToken, driveId };
  }

  function itemUrl(folder, name) {
    const path = [ROOT, folder, name].filter(Boolean).map(encodeURIComponent).join('/');
    return `${GRAPH}/drives/${cfg.driveId}/root:/${path}`;
  }

  async function graph(url, opts = {}) {
    if (!cfg) throw new Error('RpaQueue.init() を先に呼んでください');
    const token = await cfg.getToken();
    const res = await fetch(url, {
      ...opts,
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

  // 依頼を登録する。同じジョブがすでに待っていれば登録せず、その依頼を返す
  // （RPA専用機は同じジョブをまとめて1回で実行するので、重ねて依頼する意味がない）
  async function request(job, { app = '', requestedBy = '' } = {}) {
    const pending = await list('pending');
    const dup = pending.find(n => jobOf(n) === job);
    if (dup) return { name: dup, deduped: true };
    const name = newName(job);
    const body = { job, app, requestedBy, requestedAt: new Date().toISOString() };
    await graph(itemUrl('pending', name) + ':/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { name, deduped: false };
  }

  async function status(name) {
    const [pending, running] = await Promise.all([list('pending'), list('running')]);
    const idx = pending.indexOf(name);
    if (idx >= 0) {
      // 自分より前の別ジョブの数（同じジョブはまとめて実行されるので数えない）＋実行中
      const job = jobOf(name);
      const before = new Set(pending.slice(0, idx).map(jobOf).filter(j => j !== job));
      return { state: 'pending', ahead: before.size + (running.length ? 1 : 0) };
    }
    if (running.includes(name)) {
      const r = await read('running', name);
      return { state: 'running', startedAt: r && r.startedAt };
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

  return { init, request, status, watch, jobOf };
})();
