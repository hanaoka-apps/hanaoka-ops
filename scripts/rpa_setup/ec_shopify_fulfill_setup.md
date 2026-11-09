# Shopify へ送り状番号を登録：準備と試し方（`scripts/shopify_fulfill.py`・ジョブ `ec_shopify_fulfill`）

EC売上アプリの出荷チェックで「Shopify に登録する」を押すと、専用機が、Shopify の注文に **運送会社・送り状番号・追跡URL** を付けて発送済みにします
（いままで担当者が、番号をコピーして Shopify の管理画面に貼り付けていた作業の自動化）。

読み取り用の `shopify_fetch.py`（`ec_shopify_fetch_setup.md`）とは**別のアプリ**を使います。書き込みの権限は、このアプリだけに付けます。

## いまの手作業（2026-11 に、発送済みの注文の履歴で確認した形）

| 項目 | 内容 |
|---|---|
| 運送会社 | 「西濃運輸」（Shopify の運送会社の一覧にある名前） |
| 追跡番号 | ハイフンなしの数字（アプリの 907-228-4252 → `9072284252`） |
| お客様への通知 | **送っている**（履歴に「配送情報通知メールを…に送信しました」） |
| 発送元の拠点 | 「白河2-17-10」の1か所だけ |
| 操作したアカウント | 「花岡車輌業務部」（共用のスタッフアカウント）。API で登録した分は、アプリの名前で履歴に残る |

## 1. 何をするか（注文1件ごと）

1. 注文番号で探す。見つからない・複数なら `error`。キャンセル済みは `skipped`。
2. すでに同じ送り状番号が登録されていれば `already`（二重登録しない）。
3. まだ発送していない「発送の指示」が1つなら、`fulfillmentCreate` で、運送会社・番号・追跡URLを付けて発送済みにする（通知は依頼の `notify`、既定は送る）。
4. すでに発送済みで、追跡の番号が無い発送が1つなら、`fulfillmentTrackingInfoUpdate` で追跡情報を付け足す。
5. それ以外（発送の指示が複数・保留中・一部だけ発送済み・発送が複数・別の番号がすでにある）は、勝手に決めず `skipped`（管理画面で人が見る）。

「確認のみ」（`dryRun`）で頼むと、Shopify には何も書かず、何をするかだけが結果に出ます。**最初は必ず確認のみで試します。**

## 2. Shopify 側の準備（管理者）

読み取り用のアプリとは**別に**、Dev Dashboard（dev.shopify.com）で、アプリを新しく作ります（例：「花岡EC連携（出荷登録）」）。手順は `ec_shopify_fetch_setup.md` の 1-A と同じです。

| スコープ | 何のため |
|---|---|
| `read_orders` | 注文を番号で探す・発送の状態を読む（直近60日の注文） |
| `read_merchant_managed_fulfillment_orders` | 注文の「発送の指示」を読む |
| `write_merchant_managed_fulfillment_orders` | 発送済みにする・追跡情報を付ける |

- 発送元の拠点（白河2-17-10）は、自社で管理する拠点（merchant-managed）です。外部の発送サービスに割り当てられた注文は、対象外です。
- 追跡情報の更新（`fulfillmentTrackingInfoUpdate`）に、別のスコープが要るかは、**公式の資料で確認できていません**。権限のエラー（ACCESS_DENIED）が出たら、エラー文に出るスコープを足してください。
- 作ったら、Client ID と Client secret を、次の環境変数に設定します（**値はチャット・メール・リポジトリに書かない**）。

## 3. 専用機の準備

1. 常駐スクリプト `rpa_queue_worker.ps1` を、この版に更新する（新しいジョブの型 `fulfill` を追加した版。既存の更新手順どおり）。
2. ユーザー環境変数（タスクを動かすアカウント）：

| 変数 | 内容 |
|---|---|
| `SHOPIFY_SHOP` | ストアのドメイン `xxxx.myshopify.com`（読み取り用と同じ） |
| `SHOPIFY_FULFILL_CLIENT_ID` / `SHOPIFY_FULFILL_CLIENT_SECRET` | 2. で作ったアプリの Client ID / Client secret |
| `SHOPIFY_API_VERSION` | （任意）既定は `shopify_fulfill.py` の `DEFAULT_API_VERSION` |

3. `requests` が入っていること（読み取り用と同じ）。スクリプトは、毎回 GitHub の main から取得されるので、置く作業は要りません。
4. ジョブ定義 `scripts/rpa_jobs.json` の `ec_shopify_fulfill`（type: fulfill）が、GitHub の main にあること。

## 4. アプリからの頼み方・結果

- アプリは、`ec_shopify_fulfill` を依頼します。`params = { orders: [{ id, company, number, url }], dryRun, notify }`、`batchId` は英数字・`_`・`-` だけ。
- 依頼できるのは、取込と同じ人（管理者・取込担当者。`ec_import_admins.json`）だけです。
- 結果は `SharedMasters\_ec_fulfill\<batchId>\result.json`：

```json
{ "batchId": "ful-…", "finishedAt": "…", "dryRun": false, "notify": true, "ok": true,
  "results": [ { "id": "1772", "status": "done", "action": "create", "message": "発送済みにして、送り状番号を登録しました" } ] }
```

`status` は `done`（登録した）／`already`（すでにあった）／`skipped`（人が見る）／`error`。`ok` は全件が done か already のとき true。
ログは `SharedMasters\_rpa_queue\logs\shopify_fulfill.log`（注文番号と状態だけ。お客様の名前・住所・メール・電話、秘密、追跡URLは書かない）。

## 5. 試し方（この順で）

1. **確認のみ**で、未発送の注文を1〜2件頼む。結果の `action`（create／update）と `message` を見る。**何も書き込まれていないこと**を、Shopify の管理画面で確かめる。
2. 担当者と一緒に、**本当の注文を1件だけ**登録する（通知メールが、お客様に届く）。管理画面で、次を確認する。
   - 履歴に「…アプリ…発送済みとしてマークしました」と、通知メールの記録がある。
   - 運送会社が「西濃運輸」で、追跡番号がハイフンなしの数字で、追跡のリンクが開く。
   - 発送元が「白河2-17-10」になっている。
3. 問題なければ、複数件をまとめて頼む。

間違えて登録したときは、管理画面の「追跡情報を編集」で直せます（通知メールは、すでに届いてしまいます）。

## 確認できていないこと（最初の試しで確かめる）

- 運送会社の名前「西濃運輸」を、API にそのまま渡して、管理画面の表示（西濃運輸の追跡）と同じになるか。ならなければ、`company` の文字を調整する。
- `fulfillmentTrackingInfoUpdate` に必要なスコープ。
- 第一貨物・トナミ運輸の名前の扱い（EC で使うことがあるか、担当者に確認中）。
