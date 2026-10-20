# EC売上アプリ：RPA専用機に頼むこと（約束事）

EC売上アプリ（`ec_sales.html`）が、RPA専用機に頼む仕事は3つ。どれも既存の仕組み
（SharedMasters ＋ `_rpa_queue` ＋ `scripts/rpa_queue_worker.ps1`）の延長で、**専用機でやること**と**アプリ・スクリプト側でやること**を分けて書く。
詳しい作り方は `新PC引き継ぎ.md`（既存のキューの説明）を先に読む。

## 全体の流れ

```
Shopify ──(1) 定期取得スクリプト──▶ SharedMasters/ec_shopify_*.csv ──▶ 画面でチェック・OK
                                                                   │
                                      (2) 「SMILEに取り込む」ボタン │
                                                                   ▼
        SharedMasters/_rpa_import/<バッチ番号>/  ◀── アプリが取込ファイルを置く ＋ 依頼を pending に入れる
                         │
                         ▼  専用機（常駐スクリプト）：ファイルの確認 → PAD で SMILE に取込 → result.json を書く
                         │
                         ▼  (3) 続けて「確認用出力」ジョブ：SMILE から受注明細・納品先マスタを出力
                         ▼
        アプリが出力と突き合わせ → 一致したら「起票済み」＋受注№を表示
```

## 1. Shopify の定期取得（ジョブ名なし。タスクスケジューラー）

| 項目 | 内容 |
|---|---|
| 実行するもの | `scripts/shopify_fetch.py`（別セッションで作成中。Python 3.11、`pip install requests`） |
| いつ | 平日 8:00〜18:00 の毎時0分（受注の締め15時の前後で最新になるよう）。休日は不要 |
| 出力先 | SharedMasters 直下に**上書き保存**：`ec_shopify_orders.csv`・`ec_shopify_payouts.csv`・`ec_shopify_transactions.csv`（列は Shopify の CSV エクスポートと同じ） |
| 専用機に必要な設定 | ユーザー環境変数 `SHOPIFY_SHOP`（例：`xxxx.myshopify.com`）、`SHOPIFY_ACCESS_TOKEN`（カスタムアプリのトークン）。**トークンはリポジトリにもアプリにも置かない** |
| 福田さん側の準備 | Shopify の管理者に、カスタムアプリの作成と、読み取り権限（注文・`read_all_orders`・Shopify Payments の入金）の付与、トークン発行を頼む |
| 失敗したとき | ログを `SharedMasters/_rpa_queue/logs/` に残し、前回のファイルはそのまま残す（上書きは成功したときだけ） |

## 2. SMILE への取込（ジョブ `ec_smile_import`）

### アプリが置くもの
`SharedMasters/_rpa_import/<バッチ番号>/` に次を置いてから、依頼を `_rpa_queue/pending/` に入れる。

| ファイル | 中身 |
|---|---|
| `nouhin.txt` | 納品先マスタ取込ファイル（UTF-16 BOM・タブ区切り・CRLF・1行目見出し、42列）。新規がなければ置かない |
| `juchu.txt` | 受注伝票取込ファイル（同形式、121列） |
| `manifest.json` | `{ "batchId", "requestedBy", "requestedAt", "files": [{ "name", "rows", "sha256" }] }` |

- **バッチ番号**はファイルの中身から作る（同じ内容なら同じ番号）。同じ番号を2回は実行しない。
- 依頼ファイル（pending）には `{ "job": "ec_smile_import", "requestedBy", "batchId" }` を入れる。

### 専用機（常駐スクリプト）がやること
1. **押した人を確認**：`requestedBy` が `SharedMasters/_rpa_queue/ec_import_admins.json`（管理者のメール一覧。専用機側で管理し、リポジトリには置かない）にあること。なければ failed（理由：権限なし）。
2. **二重取込の確認**：`_rpa_import/done/<バッチ番号>/` があれば failed（理由：取込済み）。
3. **中身の確認**：`manifest.json` と実ファイルの行数・sha256 が合う、見出しの列数が 納品先42／受注121、必須項目（得意先・品目コード・数量・納期）が空でない。だめなら failed（SMILE には触らない）。
4. **PAD に渡す**：専用機の固定フォルダ（例 `C:\RPA\ec_import\current\`）に、毎回同じ名前（`納品先.txt`・`受注.txt`）でコピーする。
5. **PAD フローを順番に実行**：①`Smile_EC納品先取込` → ②`Smile_EC受注取込`。**①にエラーがあれば②は実行しない**。
6. **結果を書く**：`_rpa_import/<バッチ番号>/result.json`（下記）。完了を知らせるのはこのファイル。
7. 終わったら `_rpa_import/done/<バッチ番号>/` に移す（失敗時は `failed/`）。**30日たったら消す**（お客様の名前・住所・電話が入っているため）。
8. 取込が終わったら、**続けて `ec_smile_verify_export` を依頼に追加**する（アプリが待たなくてよいように）。

### PAD フローで作るもの（専用機で人が作る）
| フロー名 | することの概要 |
|---|---|
| `Smile_EC納品先取込` | SMILE の「汎用データ受入」（マスタ取込）で、納品先マスタを選び `納品先.txt` を取り込む。取込件数・エラー件数を取る |
| `Smile_EC受注取込` | SMILE の受注の汎用データ受入で `受注.txt` を取り込む。**「新規に採番する」を必ずオン**（受注№・処理連番は仮番）。取込件数・エラー件数を取る |
| `Smile_EC確認用出力` | 下の「3.」 |

- どちらも、取込結果の画面から**取込件数・エラー件数**と、エラーがあればその内容（行番号・メッセージ）を取って `result_nouhin.json`／`result_juchu.json` を書く（形は下記）。
- **最初はテスト用の得意先・納品先**（例：SMILE の `999999` のもの）で、1件ずつ試運転する。本番で試さない。

### `result.json` の形
```json
{
  "batchId": "…",
  "state": "done | failed | partial",
  "message": "失敗の理由（権限なし／取込済み／ファイル不整合／SMILEのエラー など）",
  "files": [
    { "name": "nouhin.txt", "imported": 3, "errors": 0, "errorRows": [] },
    { "name": "juchu.txt",  "imported": 20, "errors": 1, "errorRows": [{ "row": 5, "message": "…" }] }
  ],
  "startedAt": "ISO8601", "finishedAt": "ISO8601"
}
```
- `partial` は「一部だけ入った」状態（取込件数が1以上でエラーも1以上）。**アプリは再実行ボタンを出さず、「要確認」で止める**。再実行を許すのは、取込件数が0の failed のときだけ。

## 3. 確認用の出力（ジョブ `ec_smile_verify_export`）

既存の `sales_master`（日報用・最大20分・再集計つき）とは**別の軽いジョブ**にする。

| 項目 | 内容 |
|---|---|
| PAD フロー | `Smile_EC確認用出力` |
| 出力（SharedMasters 直下に上書き） | `受注明細出力.csv`、`納品先マスタ.csv` |
| 完了の判断 | 既存のジョブと同じ：2つの出力ファイルがどちらも起動後に更新されたら完了 |
| `rpa_jobs.json` | `outputs` に上の2ファイル、`timeoutMinutes` は 10 を目安 |
| 範囲 | 直近の受注（例：受注日が1か月以内）だけでよい。短くすれば時間も短い |

アプリは、このファイルと「取り込むはずだった内容」を、客先注番（Shopify の注文番号）で突き合わせる：品目・数量・金額・納期・出荷予定日・納品先コード・社内メモ・行数。納品先は、新規のコードがマスタに入っていて名前・住所・電話が合っているか。**一致しなければ「要確認」**（SMILE 側の値と期待値を並べて表示）。

## 専用機側のチェックリスト
- [ ] `ec_shopify_fetch` のタスクスケジューラー登録と、環境変数2つ
- [ ] `rpa_jobs.json` に `ec_smile_import`・`ec_smile_verify_export` が入ったことを確認（マージで常駐スクリプトに反映される）
- [ ] 常駐スクリプトを更新（取込ジョブの種類を扱えるようにする。別セッションで作成中）
- [ ] PAD フロー3つ（`Smile_EC納品先取込`・`Smile_EC受注取込`・`Smile_EC確認用出力`）
- [ ] `_rpa_queue/ec_import_admins.json`（管理者のメール一覧）
- [ ] `C:\RPA\ec_import\current\` の作成と書き込み権限
- [ ] テスト用の得意先・納品先で、1件を最初から最後まで通す（取込 → 確認用出力 → アプリの突き合わせ）

## 決めてほしいこと（専用機側と相談）
1. PAD が「結果ファイル」を書く方法（件数・エラーを SMILE 画面からどう取るか）
2. 取込の途中で SMILE の画面が想定外になったとき（ログイン切れ・ダイアログ）の止め方
3. 確認用出力の対象期間と、所要時間の見込み
