/* ふるさと納税の状況（furusato_viewer.html）の「プロフィール」。画面の本体 ec_viewer.js が、言葉・注文の読み方・完了の判定を、ここから受け取る。
 * 元の注文＝サイネックスの注文CSV（専用機が解凍した SharedMasters/_furusato_inbox/csv/…。読み方は furusato_sales_profile.js の loadOrders と同じ）。
 * 完了＝「サイネックスへの出荷報告」を済ませた印（共有の履歴 FS_Order の ShipReportedAt）。この履歴は、ふるさと納税の担当と管理者だけが読める権限なので、
 * 読めない人には、完了の判定は出ない（出荷済までで止まる。画面に、そう書く）。 */
(function () {
  var V = window.EcViewer;
  var span = function (s) { return '<span style="font-weight:500">' + s + '</span>'; };
  window.VIEWER_PROFILE = {
    page: 'furusato_viewer',
    configUrl: 'furusato_config.json',
    source: 'サイネックス',
    sourceWhy: '専用機が解凍した注文CSVがまだか、権限がない可能性があります',
    staleHours: 0,
    pastDays: 60,   // 注文CSVは、新しいほうから読む（最大120フォルダ）。これより前で、注文CSVにない注文は「過去の注文」
    hasCancel: false, showTotal: false, noPrefix: '',
    labels: { shopify: 'サイネックス受注', wait: '受注伝票作成済（出荷待ち）', shipped: '出荷済', done: 'サイネックス報告完了', cancelled: 'キャンセル' },
    tileTitles: { shopify: '① サイネックス受注', wait: '② 受注伝票作成済<small>（出荷待ち）</small>', shipped: '③ 出荷済', done: '④ サイネックス報告完了' },
    stepTitles: { shopify: '① サイネックス受注', wait: '② 受注伝票作成済' + span('（出荷待ち）'), shipped: '③ 出荷済', done: '④ サイネックス報告完了' },
    subs: { past: '60日より前（分かる分だけ表示）', shopify: 'サイネックスから注文が届いた', wait: 'SMILE に受注伝票がある・出荷前', shipped: '送り状番号が出た', done: 'サイネックスへの出荷報告まで済み', doneUnknown: '報告済みの印を読めません（権限）', cancelled: '' },
    pastTag: '過去の注文（注文CSVの範囲外）', noSourceTag: 'サイネックスの注文データなし（古い注文）', noSourceStep: 'サイネックスの注文データなし', unknownDoneStep: '不明（注文データなし）',
    doneStep: '<b>報告済み</b><div class="muted">サイネックスへ出荷報告済み</div>',
    doneUnreadable: '報告済みかどうかは、権限がなく分かりません',
    cardTags: function () { return []; },
    detailStatus: null,
    smileFile: function (conf) { return (conf.files || {}).index || 'ec_smile_index.json'; },
    custCodes: function (conf) { return Object.keys((conf.config || {}).customers || {}); },
    load: async function (api) {
      var list = [], loader = window.EC_PROFILE && window.EC_PROFILE.loadOrders;
      if (!loader) throw new Error('注文CSVを読む部品（furusato_sales_profile.js）がありません');
      await loader({ conf: api.CONF, graphGet: api.graphGet, resolveDriveId: api.resolveDriveId, stamp: api.stamp, note: function () {}, setOrders: function (l) { list = l; } });
      list.forEach(function (o) {
        o.searchExtra = [o.juchuNo, o.donorNo];
        o.detailExtra = [['サイネックスの受注番号', o.juchuNo], ['寄附者番号', o.donorNo], ['配達希望日', o.wantDate], ['配達時間帯', o.wantTime], ['依頼（備考）', o.request]];
      });
      // 報告済みの印（共有の履歴 FS_Order）。読めない人は、完了の判定なしで続ける
      var warns = [], doneUnknown = false;
      try {
        var L = (api.CONF.sharepoint || {}).lists;
        if (!L || !window.EcShared) throw new Error('共有の履歴の設定がありません');
        var shared = window.EcShared.create({ getToken: api.getToken, sitePath: L.sitePath, orderList: L.order, logList: L.log });
        await shared.connect();
        V.applyReported(list, await shared.loadAll());
      } catch (e) {
        console.warn(e); doneUnknown = true;
        warns.push('サイネックスへの出荷報告の記録（共有の履歴 FS_Order）を読めませんでした。ふるさと納税の担当と管理者だけが読める記録なので、「サイネックス報告完了」は出ません（「出荷済」までを表示します）');
      }
      return { orders: list, modified: '', warns: warns, doneUnknown: doneUnknown };
    },
    help: '<ul>\n' +
      '<li><b>① サイネックス受注</b>：サイネックスから注文の CSV が届いた。SMILE の受注伝票は、まだ</li>\n' +
      '<li><b>② 受注伝票作成済（出荷待ち）</b>：SMILE に受注伝票ができた。出荷予定日が決まっていて、まだ出荷されていない（出荷伝票ができて、送り状番号を待っている状態も含みます）</li>\n' +
      '<li><b>③ 出荷済</b>：送り状番号が出た。サイネックスへの出荷報告は、まだ</li>\n' +
      '<li><b>④ サイネックス報告完了</b>：サイネックスへ出荷報告（メール）を送った。この印は、ふるさと納税の担当と管理者だけが読めます。読めない人には、この判定は出ません（出荷済までの表示です）</li>\n</ul>\n' +
      '<h3>探し方</h3>\n<ul>\n' +
      '<li>発注番号・お届け先の名前・電話・住所・送り状番号・SMILE の受注№・サイネックスの受注番号・寄附者番号・商品番号や商品名を、そのまま入れて探せます</li>\n' +
      '<li>空白で区切ると、<b>すべてを含む</b>注文だけが出ます。全角と半角・カタカナとひらがな・番号のハイフンは区別しません</li>\n' +
      '<li>「出荷予定日を過ぎている」は、出荷予定日を過ぎたのに、まだ出荷されていない注文です</li>\n</ul>\n' +
      '<h3>知っておくこと</h3>\n<ul>\n' +
      '<li>サイネックスの注文は、専用機が解凍した注文 CSV（新しいほうから最大 120 フォルダ）から読んでいます。60日より前で、CSV にない注文は「<b>過去の注文</b>」として、SMILE と出荷のデータで分かる分だけ出ます。上の4つの状況の件数には、数えません</li>\n</ul>'
  };
})();
