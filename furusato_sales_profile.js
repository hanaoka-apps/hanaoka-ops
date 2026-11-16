/* ふるさと納税アプリ（furusato_sales.html）の「プロフィール」。画面の本体は EC売上と同じ ec_sales_app.js で、
 * 注文の読み込み・伝票の作り方・言葉だけをここで差し替える（EC売上の画面を直すと、こちらにも反映される）。 */
(function () {
  var FS = window.FurusatoSales;
  var enc = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };

  // 専用機が解凍した注文CSV（<inboxDir>/csv/<ZIPの名前>/*.csv）を、新しいものから読む。同じ発注番号は新しいほうを使う
  async function loadOrders(api) {
    var conf = api.conf, inbox = ((conf.csv || {}).inboxDir) || '_furusato_inbox', base = inbox + '/csv';
    var did = await api.resolveDriveId(), orders = {}, seen = 0, skipped = 0;
    var dirs;
    try { dirs = (await api.graphGet('/drives/' + did + '/root:/' + enc(base) + ':/children?$select=name,folder&$top=200')).value || []; }
    catch (e) { api.setOrders([]); api.note('注文CSVのフォルダ（' + base + '）を読めませんでした：' + (e && e.message || e)); return; }
    dirs = dirs.filter(function (d) { return d.folder; }).sort(function (a, b) { return a.name < b.name ? 1 : -1; }).slice(0, 120);
    // フォルダの中身を一覧にするのを、まとめて進める（1つずつ待たない）。順番（新しい順）は、あとで守る
    var lists = await Promise.all(dirs.map(function (d) {
      return api.graphGet('/drives/' + did + '/root:/' + enc(base + '/' + d.name) + ':/children?$select=name,file&$top=50').then(function (r) { return r.value || []; });
    }));
    var tasks = [];
    dirs.forEach(function (d, i) { lists[i].forEach(function (f) { if (/\.csv$/i.test(f.name)) tasks.push({ dir: d.name, f: f }); }); });
    // CSV の取り出しも、最大6つずつ、まとめて進める（ダウンロード用の URL は、ファイルごとに取る。EC売上の fetchCsv と同じ）
    var got = new Array(tasks.length), next = 0;
    async function worker() {
      while (next < tasks.length) {
        var i = next++, k = tasks[i];
        try {
          var meta = await api.graphGet('/drives/' + did + '/root:/' + enc(base + '/' + k.dir + '/' + k.f.name)), dl = meta['@microsoft.graph.downloadUrl'];
          if (!dl) { got[i] = null; continue; }
          var r = await fetch(dl); if (!r.ok) { got[i] = null; continue; }
          got[i] = { modified: meta.lastModifiedDateTime, buf: await r.arrayBuffer() };
        } catch (e) { got[i] = null; }
      }
    }
    await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
    // 新しい順（フォルダ名の新しい順）に読む。同じ発注番号は、先に入ったほう（＝新しいほう）を使う
    tasks.forEach(function (k, i) {
      if (!got[i]) { skipped++; return; }
      var stamp = FS.fileStamp(k.f.name);
      if (!stamp) { var m = /^(\d{4})(\d{2})(\d{2})/.exec(k.dir); stamp = m ? { date: m[1] + '-' + m[2] + '-' + m[3], time: '' } : { date: (got[i].modified || '').slice(0, 10), time: '' }; }
      FS.parseOrders(FS.decode(got[i].buf), stamp, conf).forEach(function (o) { if (!orders[o.id]) orders[o.id] = o; });
      seen++;
    });
    var list = Object.keys(orders).map(function (k) { return orders[k]; });
    api.setOrders(list);
    api.note('注文CSV：フォルダ ' + dirs.length + '個・CSV ' + seen + '件を読み、注文 ' + list.length + '件（' + base + '）' + (skipped ? '／読めなかったCSV ' + skipped + '件' : ''));
  }

  window.EC_PROFILE = {
    storeKey: 'furusato_sales_v1', configUrl: 'furusato_config.json', noPay: true,
    words: { 'Shopify': 'サイネックス', 'EC売上': 'ふるさと納税', 'EC_Order': 'FS_Order', 'EC_Log': 'FS_Log', '商品名をSMILE品目コードへ変換': '商品番号をSMILE品目コードへ変換' },
    emptyOrders: 'サイネックスからの注文メール（ZIP）を専用機が解凍すると、ここに注文が並びます',
    buildSlip: function (o, ctx) { return FS.buildSlip(o, ctx); },
    juchuRows: function (slips, header, cfg, cal, conf) { return FS.juchuRows(slips, header, cfg, cal, conf && conf.biko); },
    biko: function (conf) { return conf.biko || ''; },   // SMILE の備考欄（伝票イメージの表示用）
    loadOrders: loadOrders
  };
})();
