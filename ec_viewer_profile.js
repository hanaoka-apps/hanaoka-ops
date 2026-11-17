/* EC受注の状況（ec_viewer.html）の「プロフィール」。画面の本体 ec_viewer.js が、言葉・注文の読み方・完了の判定を、ここから受け取る。
 * 元の注文＝Shopify の注文（SharedMasters の ec_shopify_orders.csv。専用機が毎時取る・直近55日分）。完了＝Shopify の発送状況が「発送済み」。 */
(function () {
  var span = function (s) { return '<span style="font-weight:500">' + s + '</span>'; };
  window.VIEWER_PROFILE = {
    page: 'ec_viewer',
    configUrl: 'ec_sales_config.json',
    source: 'Shopify',
    sourceWhy: '専用機の毎時の取得がまだか、権限がない可能性があります',
    staleHours: 12,
    pastDays: 55,   // Shopify の注文は直近55日分。これより前で、Shopify にない注文は「過去の注文」（SMILE・出荷の一部だけ結べる）
    hasCancel: true, showTotal: true, noPrefix: '#',
    receipt: true,   // 領収証の発行・管理（receipt_ui.js）。EC の画面だけ。ふるさと納税には付けない。実際に出すかは、設定（ec_sales_config.json の receipt.enabled）で決める
    labels: { shopify: 'Shopify受注', wait: '受注伝票作成済（出荷待ち）', shipped: '出荷済', done: 'Shopify登録済（完了）', cancelled: 'キャンセル' },
    tileTitles: { shopify: '① Shopify受注', wait: '② 受注伝票作成済<small>（出荷待ち）</small>', shipped: '③ 出荷済', done: '④ Shopify登録済<small>（完了）</small>' },
    stepTitles: { shopify: '① Shopify受注', wait: '② 受注伝票作成済' + span('（出荷待ち）'), shipped: '③ 出荷済', done: '④ Shopify登録済' + span('（完了）') },
    subs: { past: '55日より前（分かる分だけ表示）', shopify: 'Shopify に注文が入った', wait: 'SMILE に受注伝票がある・出荷前', shipped: '送り状番号が出た', done: 'Shopify に登録・お客様に通知済み', doneUnknown: 'Shopify に登録・お客様に通知済み', cancelled: 'Shopify でキャンセル' },
    pastTag: '過去の注文（Shopify のデータ外）', noSourceTag: 'Shopify のデータなし（古い注文）', noSourceStep: 'Shopify のデータなし', unknownDoneStep: '不明（Shopify のデータなし）', doneUnreadable: '',
    doneStep: '<b>登録済み</b><div class="muted">発送のお知らせ済み</div>',
    cardTags: function (sh) {
      var t = [];
      if (sh.has && sh.financial === 'pending') t.push('入金待ち');
      if (sh.has && (sh.financial === 'refunded' || sh.financial === 'partially_refunded')) t.push('返金あり');
      return t;
    },
    detailStatus: function (sh, u) {
      if (!sh.has) return '';
      return u.esc((u.FIN[sh.financial] || sh.financial) + '／' + (sh.fulfillment === 'fulfilled' ? '発送済み' : sh.fulfillment === 'partial' ? '一部発送' : '未発送')) + (sh.refunded ? u.esc('／返金 ' + u.yen(sh.refunded)) : '');
    },
    smileFile: function (conf) { return (conf.files || {}).index || 'ec_smile_index.json'; },
    custCodes: function (conf) { return Object.keys((conf.config || {}).customers || {}); },
    // Shopify の注文（ec_shopify_orders.csv）を読む
    load: async function (api) {
      var name = (api.CONF.shopifyFiles || {}).orders || 'ec_shopify_orders.csv';
      var r = await api.fetchFile(name), objs = api.EC.parseObjects(api.decodeText(r.buf));
      if (!objs.length || !('Lineitem name' in objs[0])) throw new Error('注文CSVの形式ではありません（Lineitem name 列がありません）');
      return { orders: api.EC.groupShopifyOrders(objs), modified: r.modified };
    },
    help: '<ul>\n' +
      '<li><b>① Shopify受注</b>：Shopify に注文が入った。SMILE の受注伝票は、まだ</li>\n' +
      '<li><b>② 受注伝票作成済（出荷待ち）</b>：SMILE に受注伝票ができた。出荷予定日が決まっていて、まだ出荷されていない（出荷伝票ができて、送り状番号を待っている状態も含みます）</li>\n' +
      '<li><b>③ 出荷済</b>：送り状番号が出た。Shopify への登録は、まだ</li>\n' +
      '<li><b>④ Shopify登録済（完了）</b>：Shopify に送り状番号を登録して、お客様に発送のお知らせが届いた</li>\n' +
      '<li><b>キャンセル</b>：Shopify でキャンセルになった注文</li>\n</ul>\n' +
      '<h3>探し方</h3>\n<ul>\n' +
      '<li>注文番号・お客様の名前・会社・電話・メール・住所・送り状番号・SMILE の受注№・商品名・担当（川島など）を、そのまま入れて探せます</li>\n' +
      '<li>空白で区切ると、<b>すべてを含む</b>注文だけが出ます（例：<code>山田 大阪</code>）。全角と半角・カタカナとひらがな・番号のハイフンは区別しません</li>\n' +
      '<li>「出荷予定日を過ぎている」は、出荷予定日を過ぎたのに、まだ出荷されていない注文です</li>\n</ul>\n' +
      '<h3>知っておくこと</h3>\n<ul>\n' +
      '<li>Shopify の注文は、<b>直近 55 日分</b>です。それより古い注文は、「<b>過去の注文</b>」として、SMILE と出荷のデータで分かる分だけ出ます（Shopify の状況と、古い出荷の送り状番号は分かりません）。上の4つの状況の件数には、数えません</li>\n' +
      '<li>Shopify の発送状況は、毎時取得しています。Shopify で発送済みにしても、反映まで<b>最大 1 時間</b>ほどかかります（画面上の「更新」の時刻を見てください）</li>\n</ul>',
    // 領収証の説明。領収証が有効なとき（設定 receipt.enabled が true）だけ、見方の欄・使い方ページに足す（まだ使えない間は出さない）
    helpReceipt: '<h3>領収証（営業・EC担当）</h3>\n<ul>\n' +
      '<li>「領収証」と入れると、領収証を発行済みの注文だけが出ます（領収証番号でも探せます）</li>\n' +
      '<li>入金が済んだ注文のカードに、「領収証を発行」のボタンが出ます。押すと、宛名・但し書き・金額・領収日・発行日を入れる画面が開きます（初めは自動で入っています。直せます）</li>\n' +
      '<li>発行すると、領収証番号が付いて、印刷・PDF にできます。同じ注文にもう一度出すときは「再発行」になります。間違えたときは「取り消す」（番号は使い回しません）</li>\n' +
      '<li>入金待ち・キャンセル・全額返金の注文には、出せません。一部返金の注文は、支払済み−返金までの金額で出せます</li>\n' +
      '<li>このボタンは、記録を読める人（営業・EC担当）にだけ出ます。出ない方は、管理者に連絡してください</li>\n</ul>'
  };
})();
