/* ふるさと納税アプリ（furusato_sales.html）の「プロフィール」。画面の本体は EC売上と同じ ec_sales_app.js で、
 * 注文の読み込み・伝票の作り方・言葉だけをここで差し替える（EC売上の画面を直すと、こちらにも反映される）。 */
(function () {
  var FS = window.FurusatoSales;
  var enc = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };

  // 専用機が解凍した注文CSV（<inboxDir>/csv/<ZIPの名前>/*.csv）を、新しいものから読む。同じ発注番号は新しいほうを使う
  async function loadOrders(api) {
    var conf = api.conf, inbox = ((conf.csv || {}).inboxDir) || '_furusato_inbox', base = inbox + '/csv';
    var did = await api.resolveDriveId(), orders = {}, seen = 0, newest = '';
    var dirs;
    try { dirs = (await api.graphGet('/drives/' + did + '/root:/' + enc(base) + ':/children?$select=name,folder&$top=200')).value || []; }
    catch (e) { api.setOrders([]); api.note('注文CSVのフォルダ（' + base + '）を読めませんでした：' + (e && e.message || e)); return; }
    dirs = dirs.filter(function (d) { return d.folder; }).sort(function (a, b) { return a.name < b.name ? 1 : -1; }).slice(0, 120);
    for (var i = 0; i < dirs.length; i++) {
      var files = (await api.graphGet('/drives/' + did + '/root:/' + enc(base + '/' + dirs[i].name) + ':/children?$select=name,file,lastModifiedDateTime,@microsoft.graph.downloadUrl&$top=50')).value || [];
      for (var j = 0; j < files.length; j++) {
        var f = files[j]; if (!/\.csv$/i.test(f.name) || !f['@microsoft.graph.downloadUrl']) continue;
        var r = await fetch(f['@microsoft.graph.downloadUrl']); if (!r.ok) continue;
        var stamp = FS.fileStamp(f.name);
        if (!stamp) { var m = /^(\d{4})(\d{2})(\d{2})/.exec(dirs[i].name); stamp = m ? { date: m[1] + '-' + m[2] + '-' + m[3], time: '' } : { date: (f.lastModifiedDateTime || '').slice(0, 10), time: '' }; }
        FS.parseOrders(FS.decode(await r.arrayBuffer()), stamp, conf).forEach(function (o) { if (!orders[o.id]) orders[o.id] = o; });   // 新しい順に読むので、先に入ったものが新しい
        seen++;
      }
    }
    var list = Object.keys(orders).map(function (k) { return orders[k]; });
    api.setOrders(list);
    api.note('注文CSV：フォルダ ' + dirs.length + '個・CSV ' + seen + '件を読み、注文 ' + list.length + '件（' + base + '）');
  }

  window.EC_PROFILE = {
    storeKey: 'furusato_sales_v1', configUrl: 'furusato_config.json', noPay: true,
    words: { 'Shopify': 'サイネックス', 'EC売上': 'ふるさと納税', 'EC_Order': 'FS_Order', 'EC_Log': 'FS_Log' },
    emptyOrders: 'サイネックスからの注文メール（ZIP）を専用機が解凍すると、ここに注文が並びます',
    buildSlip: function (o, ctx) { return FS.buildSlip(o, ctx); },
    juchuRows: function (slips, header, cfg, cal, conf) { return FS.juchuRows(slips, header, cfg, cal, conf && conf.biko); },
    loadOrders: loadOrders
  };
})();
