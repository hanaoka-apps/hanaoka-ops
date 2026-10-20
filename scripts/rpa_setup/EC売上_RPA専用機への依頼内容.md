# EC売上アプリ：RPA専用機に頼むこと（約束事・作業手順）

RPA専用機の担当の方へ。**上から順に読んで作業すれば済む**ように並べています（1〜2が「やること」、3以降が「決まりごとの詳細」）。
キューの基本は `新PC引き継ぎ.md`、PADフローの作り方と試運転は `ec_import.md` にあります。

## 0. 何が起きるか（3行）

1. 管理者がEC売上アプリの「SMILEに取り込む」を押す → 取込ファイルが SharedMasters の `_rpa_import/<バッチ番号>/` に置かれ、`ec_smile_import` の依頼が入る。
2. 専用機の常駐スクリプトが、確認（管理者・二重取込・ファイルの中身）→ PADフロー2つでSMILEに取込 → `result.json` を書く。
3. 続けて `ec_smile_verify_export`：SMILEの**全件出力**（受注明細出力.csv・納品先マスタ.csv。夜間の定時出力と同じ名前・同じ全件）→ 軽量ファイル `ec_smile_index.json` を作る → アプリがそれと突き合わせて、一致した注文だけ「起票済み」にする。

```
Shopify ──(A) 定期取得──▶ ec_shopify_*.csv ──▶ 画面でチェック・OK ──「SMILEに取り込む」(管理者のみ)
                                                                      │
   SharedMasters/_rpa_import/<バッチ番号>/ （nouhin.txt・juchu.txt・manifest.json）＋ pending に ec_smile_import
                                                                      ▼
   専用機：管理者確認 → 二重取込確認 → 中身の確認 → PAD①納品先取込 → PAD②受注取込 → result.json
                                                                      ▼
   専用機：ec_smile_verify_export ＝ PAD③全件出力（受注明細出力.csv・納品先マスタ.csv）→ build_ec_index.py
                                                                      ▼
   SharedMasters/ec_smile_index.json ──▶ アプリが客先注番で突き合わせ → 起票済み＋SMILEの受注№ ／ 違えば要確認
```

## 1. いまの状況（リポジトリ側で済んでいること／次のPRで入ること）

| | 内容 |
|---|---|
| **main に入っている**（PR #236） | 常駐スクリプトの取込処理（`type: import`：管理者確認・二重取込確認・manifest照合・固定フォルダ配置・PADフロー順次起動・`result.json`・done/failed・30日削除）、`rpa_jobs.json` の `ec_smile_import`、アプリの「SMILEに取り込む」と突き合わせ、PADフローの作り方（`ec_import.md`） |
| **次のPRで入る**（このブランチ。マージされるまで専用機に反映されない） | ① 確認用出力を**全件出力＋ `ec_smile_index.json` 作成**にする（`ec_smile_verify_export` は本番と同じ名前の全件出力、`after: build_ec_index`、`scripts/build_ec_index.py`）／② 夜間の `ec_index` ジョブ（01:10）／③ **`executed`（SMILEの「実行」を押したか）による再実行ルール**／④ 後処理 `build_ec_index` に対応した常駐スクリプト |
| **専用機で人がやること** | 下の「2. 専用機の作業」すべて（PADフロー3つ、環境変数2つ、`ec_import_admins.json`、固定フォルダ、更新の取り込み、試運転） |

アプリ側（画面）は、`ec_smile_index.json` が無いあいだは今までどおり全件CSVを読み、取込後の突き合わせはJSONができるまで「確認待ち」のままになります。専用機の準備が終わるまで、画面の「⋯」メニューの手動取込（ファイルを保存して手でSMILEに取り込む）が使えます。

## 2. 専用機の作業（上から順に）

### 2-1. 更新を取り込む（次のPRがmainに入ったら）

- `rpa_jobs.json` と `build_ec_index.py` は、**常駐スクリプトが毎回GitHubのmainから取得する**ので、PC側の作業は不要（マージすれば反映）。
- **常駐スクリプト本体（`scripts/rpa_queue_worker.ps1`）は専用機のリポジトリのコピーから動く**ので、差し替えが必要：
  1. 専用機のリポジトリのフォルダで最新のmainを取り込む（`git pull`。そのPCのClaude Codeに「最新のmainを取り込んで」と頼んでもよい）。`rpa_queue_worker.ps1` が新しくなったことを確認する。
  2. タスクスケジューラーの「Hanaoka 再集計リクエスト監視」を**いったん終了して開始**する（常駐スクリプトは起動時にファイルを読むので、再起動しないと古いまま動く）。
  3. ログ（`%USERPROFILE%\regenerate_watcher.log`）に「監視を開始します」が出て、エラーが出ていないこと。
- 実行中の取込があるときは、終わってから再起動する（途中で止めると、その依頼は「要確認」になる）。
- PythonでSMILE出力から JSON を作るので、**標準の Python が動くこと**（`python --version`。`build_ec_index.py` は標準ライブラリだけで動く。追加インストール不要）。

### 2-2. 環境変数・Shopify（Shopifyの定期取得を使うとき）

- ユーザー環境変数 `SHOPIFY_SHOP`（例：`xxxx.myshopify.com`）と、認証の `SHOPIFY_CLIENT_ID`・`SHOPIFY_CLIENT_SECRET`（Dev Dashboard のアプリ。2026/1/1 以降に作るアプリはこちら。実行のたびにスクリプトがトークンを取る）。既存のレガシーなカスタムアプリがある場合だけ、代わりに `SHOPIFY_ACCESS_TOKEN`（固定トークン）。
- **Client secret・トークンは専用機の環境変数だけに入れる。リポジトリ・アプリ・チャット（Claude や Teams）に貼らない。**
- Shopify側の準備（Dev Dashboard でのアプリ作成・読み取り権限・インストール・Client ID/Secret の確認。アプリとストアは同じ Shopify 組織にあること）は福田さんが管理者に頼む。

### 2-3. 管理者の一覧 `ec_import_admins.json`

- 置き場所：`SharedMasters\_rpa_queue\ec_import_admins.json`。**リポジトリには置かない**（メールの一覧は専用機側で管理）。
- 形：`{ "admins": ["管理者のメール", "…"] }`（大文字小文字は区別しない）。
- 使われ方：①常駐スクリプトが、取込の依頼者（`requestedBy`）がこの一覧にいるか照合する。②アプリが同じファイルを読んで、「SMILEに取り込む」ボタンを出すか決める（見た目の制限）。

### 2-4. 固定フォルダ

- `C:\RPA\ec_import\current\` を作り、PADを動かすユーザーに書き込み権限を付ける。変えるときは `rpa_queue_worker.ps1` の `$EcImportCurrentDir` を直す。
- 常駐スクリプトが取込のたびに `納品先.txt`・`受注.txt` を置き、終わったら（失敗しても）消す（お客様の名前・住所・電話が入っているため）。

### 2-5. PADフロー3つ（作り方は `ec_import.md`）

| フロー名 | やること |
|---|---|
| `Smile_EC納品先取込` | SMILEの汎用データ受入（納品先マスタ）で `納品先.txt` を取り込み、`result_nouhin.json` を書く |
| `Smile_EC受注取込` | SMILEの受注の汎用データ受入で `受注.txt` を取り込む（**「新規に採番する」を必ずオン**）。`result_juchu.json` を書く |
| `Smile_EC確認用出力` | **既存の全件出力フロー（`Smile_日報用マスタ出力`）を複製して、受注明細出力.csv と 納品先マスタ.csv の2つだけを出力する**（約2分の見込み。出力名・パターンは本番と同じ） |

フロー名を変えるときは、`rpa_jobs.json` の `flow` も合わせてPRで直す。

### 2-6. 試運転（最初は必ずテスト用の得意先・納品先で）

**アプリの「テスト送信」が一番かんたん**：管理者でサインイン → 画面下の「⋯」→「テスト送信（仮データ1件）」。**EC売上の東京（得意先 599801）**に、テストと分かる仮の注文1件（客先注番 `TEST` ＋ yymmddHHMM、社内メモ『花岡EC（テスト送信）』）と、テスト用の納品先 `999998`（『テスト納品先（削除予定）』）を送り、取込から突き合わせまで通しで試せる。結果は「テスト送信の結果」の枠に出る。**SMILE に入っている間は、東京の売上・日報に載りうる。終わったら SMILE で、その受注伝票（客先注番 `TEST…`）と納品先 `999998` を削除する**。詳しくは `ec_import.md` の「テスト送信」。

`ec_import.md` の「試運転」に従う（SMILEのテスト用 `999999` で、フロー単体 → エラーの形 → 常駐スクリプト経由 → アプリの表示 → 異常系の順）。本番の得意先（599801・599802）で最初に試さない。

### 2-7. チェックリスト

- [ ] 更新の取り込み（2-1）：`git pull` → 常駐スクリプトの再起動 → ログに「監視を開始します」
- [ ] `rpa_jobs.json` に `ec_smile_import`・`ec_smile_verify_export`・`ec_index` があること（mainから自動取得）
- [ ] 環境変数 `SHOPIFY_SHOP`・`SHOPIFY_CLIENT_ID`・`SHOPIFY_CLIENT_SECRET`（Shopifyの定期取得を使うとき。秘密はチャットに貼らない）
- [ ] `_rpa_queue\ec_import_admins.json`
- [ ] `C:\RPA\ec_import\current\` と書き込み権限
- [ ] PADフロー3つ
- [ ] 試運転（テスト用の得意先・納品先 `999999`）：取込 → 全件出力＋JSON → アプリの突き合わせ（起票済み・受注№）まで1件通す
- [ ] 夜間：翌朝 `ec_smile_index.json` の更新日時が 01:10 ごろになっていること

---

## 3. 決まりごとの詳細

### 3-1. 画面の操作（アプリ側）

画面下のバーのボタンは **「SMILEに取り込む」の1つだけ**（納品先と受注伝票をまとめて登録する）。

- 押せるのは管理者だけ（2-3の一覧）。管理者でない人には「OK済 n件（取込は管理者が行います）」と出す。
- 押すと確認ダイアログ（納品先の新規件数・受注の伝票数と行数・金額合計）→ OKで取込ファイルを置いて依頼する。
- 取込後の突き合わせで一致した注文は**自動で「起票済み」**になり、SMILEが付けた受注№が注文に紐づく。一致しない注文は「要確認」（SMILEの値とアプリの期待値を並べて表示。再取込はさせない）。
- 状態の表示：依頼中 → 取込中 → 確認待ち（SMILEから出力中）→ 確認OK／要確認／取込失敗。
- 予備：管理者だけに出る小さな「⋯」メニューに、ファイルの手動保存と「手で取り込んだので起票済みにする」。

### 3-2. アプリが置くもの（`SharedMasters/_rpa_import/<バッチ番号>/`）

| ファイル | 中身 |
|---|---|
| `nouhin.txt` | 納品先マスタ取込ファイル（UTF-16 BOM・タブ区切り・CRLF・1行目見出し、42列）。新規がなければ置かない |
| `juchu.txt` | 受注伝票取込ファイル（同形式、121列） |
| `manifest.json` | `{ "batchId", "requestedBy", "requestedAt", "files": [{ "name", "rows", "sha256" }] }` |

- **バッチ番号**は `ec-` ＋ 16桁の16進（ファイルの中身のsha256から作る。同じ内容なら同じ番号）。専用機はこの形以外を受け付けない。
- 依頼ファイル（pending）：`{ "job": "ec_smile_import", "requestedBy", "batchId" }`。同じ `batchId` の依頼だけをまとめ、別の `batchId` は別の仕事として順に実行する。

### 3-3. 常駐スクリプトがやること（`ec_smile_import`）

1. **押した人の確認**：`requestedBy` が `ec_import_admins.json` にあること。なければ failed（権限なし）。
2. **二重取込の確認**：`_rpa_import/done/<バッチ番号>/` があれば failed（取込済み）。`failed/<バッチ番号>/` に同じバッチがあるときは、その `result.json` の `executed` が `false` なら再実行を許し（古い failed の記録は消す）、`true`・不明（項目なし）なら再実行せず `partial`（要確認）で止める（記録は残す）。
3. **中身の確認**：`manifest.json` と実ファイルの行数・sha256、見出しの列数（納品先42／受注121）、必須項目（得意先・品目コード・数量・納期など）が空でない。だめなら failed（`executed: false`。SMILEには触らない）。
4. **PADに渡す**：固定フォルダに `納品先.txt`・`受注.txt` をコピー。
5. **PADフローを順に実行**：①`Smile_EC納品先取込` → ②`Smile_EC受注取込`。**①にエラーがあれば②は実行しない**。SMILEが閉じていれば自動起動する（**1〜3の確認がすべて済んだあと**。権限のない依頼ではSMILEを起動しない。起動に失敗したら、SMILEには触っていないので `failed`・`executed: false` の `result.json` を書いて `failed/` へ移す）。
6. **結果を書く**：PADが固定フォルダに書く `result_nouhin.json`／`result_juchu.json`（`{ executed, imported, errors, errorRows }`）を待って、`_rpa_import/<バッチ番号>/result.json` にまとめる。完了を知らせるのは `result.json`。結果ファイルが時間内（1フロー15分）に出ないときは `partial`。
7. **移す・消す**：`_rpa_import/done/<バッチ番号>/`（`done` のとき）または `failed/`（それ以外）へ移す。依頼ファイルも done／failed に移す。**30日たったら消す**（お客様の名前・住所・電話が入っているため。アプリ側の記録も30日）。
8. **続けて確認用出力**：`done` のとき `ec_smile_verify_export` を依頼に追加する（アプリが待たなくてよいように）。アプリは取込の依頼より後のこのジョブを探して待ち、90秒たっても見つからなければ自分で依頼する。

### 3-3b. どの経路で終わっても `result.json` を書く

アプリは `result.json` で完了を判断するので、**取込フォルダがあるまま `result.json` なしで終わる経路を作らない**。常駐スクリプトは次の経路でも `result.json` を書き、`failed/` へ移し、固定フォルダ（`C:\RPA\ec_import\current\`）の中身も消す。`message` には人が読める理由を入れる。

| 経路 | `state` | `executed` |
|---|---|---|
| SMILEの自動起動に失敗（管理者・二重取込・中身の確認のあと。SMILEには触っていない） | `failed` | `false` |
| 取込の途中で常駐スクリプトが止まった（PC再起動・タスク再起動。次の起動時に処理） | `partial` | **キーを書かない**（不明） |
| 取込処理の中の予期しない例外（OneDriveのロックでコピー・移動に失敗など）：PADフローを起動する前 | `failed` | `false` |
| 同：PADフローを1つでも起動したあと | `partial` | 押したと分かっていれば `true`、不明ならキーを書かない |

アプリは `executed` が `false` 以外なら「要確認」で止めるので、キーが無い（不明）ものは再実行できない。

### 3-4. 2つの失敗の分かれ目と `executed`

**SMILEの「実行」ボタンを押す前に止まったか、押したあとか**で扱いが変わる。

| 止まった場所 | `executed` | `result.json` の `state` | アプリ |
|---|---|---|---|
| 押す**前**（権限なし・ファイル不整合・SMILEのログイン切れ／想定外の画面で、実行前） | `false` | `failed` | **やり直しOK**（「SMILEに取り込む」をもう一度押せる） |
| 押した**後**（取込の途中・エラーが出た・件数が取れない） | `true` | `partial` | **要確認**で止める（再実行ボタンなし。SMILEを見て人が判断） |
| 押したか分からない（結果ファイルが出ない・`executed` の項目がない旧形式） | 不明 | `partial` | **要確認** |

- 押したあとは、取込件数が0でも一部が入っているかもしれないので、再実行させない。
- **PADフローでの `executed` の書き方**：結果ファイルに `executed` を入れる。**「実行」を押す直前まで `false`、押したら `true`**（押す直前に変数を `true` にして、その値を最後に書く）。途中で想定外の画面になったときも同じ。押したか分からない状況では `true` で書くか、結果ファイルを書かずに終了する（どちらも要確認になる）。
- 常駐スクリプトはこれをまとめて `result.json` の `executed`（どれか1つでも `true` なら `true`）にする。

```json
{
  "batchId": "ec-…",
  "state": "done | failed | partial",
  "message": "失敗の理由（権限なし／取込済み／ファイル不整合／SMILEのエラー など）",
  "executed": true,
  "files": [
    { "name": "nouhin.txt", "executed": true, "imported": 3, "errors": 0, "errorRows": [] },
    { "name": "juchu.txt",  "executed": true, "imported": 20, "errors": 1, "errorRows": [{ "row": 5, "message": "…" }] }
  ],
  "startedAt": "ISO8601", "finishedAt": "ISO8601"
}
```

### 3-5. 確認用出力（ジョブ `ec_smile_verify_export`）＝全件出力＋軽量JSON

SMILEの出力は**全データを上書き保存する限り、日中に何度出しても問題ない**（夜間の定時出力も同じ全件出力）。なので、取込後の確認も同じ全件出力にして、アプリは軽量JSONで確認する。**出力を一部の内容で上書きしてはいけない**（絞り込んだ条件パターンは使わない）。

| 項目 | 内容 |
|---|---|
| PADフロー | `Smile_EC確認用出力`（既存の全件出力フローを複製して、下の2ファイルだけ出力。約2分） |
| 出力（SharedMasters直下に上書き・夜間と同じ名前） | `受注明細出力.csv`、`納品先マスタ.csv`（全件） |
| 完了の判断 | 2つの出力ファイルがどちらも起動後に更新され、サイズが30秒変わらず、書き込み中でない（上限10分） |
| 後処理（`after`） | **`build_ec_index`**：専用機のPythonで `scripts/build_ec_index.py` を実行（毎回GitHubのmainから取得。環境変数 `SHARED_MASTERS_DIR`）。成功したらジョブ完了。失敗したらジョブも failed |
| `rpa_jobs.json` | `ec_smile_verify_export`：`outputs` に上の2ファイル、`timeoutMinutes: 10`、`after: build_ec_index` |

### 3-6. `ec_smile_index.json`（軽量ファイル）と `build_ec_index.py`

- 入力：`受注明細出力.csv`（約90MB）・`納品先マスタ.csv`・`品目マスタ.csv`・`入金明細出力.csv`（任意）。タブ区切り・カンマ区切り、UTF-8／Shift-JISのどれでも読む。1行ずつ処理するのでメモリは少ない（120MBで約2秒）。
- 出力：SharedMasters直下の `ec_smile_index.json`（一時ファイル→置き換え。**失敗したら前回のファイルが残る**）。
  - `generatedAt`（UTC）、`sources`（元ファイル名・更新日時・行数）
  - `orders`＝ECの得意先（599801・599802。`EC_CUSTOMERS` 環境変数か `--customers` で変更可）の受注の行（受注№・行・受注日付・得意先・納品先コード・品目コード・数量・単価・金額・納期・出荷予定日・客先注番・社内メモ・操作日付 など）
  - `nouhin`＝ECの納品先（コード・名前・索引・荷受け人・郵便番号・住所・電話）と得意先ごとの最大コード
  - `items`＝品目（コード・名前・単位・手配区分）、`nyukin`＝ECの入金
- 個人情報（名前・住所・電話）が入るが、**ログには件数だけ**を出す。サイズは1MB前後の見込み。
- アプリは、`generatedAt` が**取込の完了時刻（`result.json` の `finishedAt`）より新しくなるまで「確認待ち」**にする（古いJSONで「見つからない」と誤判定しない）。
- アプリは、突き合わせだけでなく、品目・納品先・二重取込の確認・入金の同日確認にも、このJSONを優先して使う（無いときだけ全件CSVを読む）。

- **テスト送信の注文**（客先注番が `testImport.poPrefix`＝`TEST` で始まる受注）は、`orders` に入れず `testOrders` に分けて持つ（本番の二重取込確認・件数に混ぜない）。納品先 `999998` は連番の上限（`config.deliveryCodeLimit`＝`099999`）より大きいので、`maxCode`（得意先ごとの最大コード）の計算に入れない（マスタの一覧には出る）。得意先・印・上限は設定ファイルから読む：常駐スクリプトが `ec_sales_config.json`（SharedMasters に同名のファイルがあればそれ、無ければ main から取得）を `--config` で `build_ec_index.py` に渡す。

### 3-7. 夜間のジョブ `ec_index`

0:00台のSMILE定時出力が終わったあと、**PADなし**で `build_ec_index` だけを実行する（`rpa_jobs.json` の `schedules`：`facts_only` が 01:00、`ec_index` が 01:10）。夜間出力のあとのJSONを最新にしておくためで、`facts_only` と同じ作り。

### 3-8. 突き合わせの内容（アプリ側）

客先注番（Shopifyの注文番号）で、「取り込むはずだった内容」と `ec_smile_index.json` の受注を比べる：品目コード・数量・単価・金額（1円の端数まで）・納期・出荷予定日・納品先コード・社内メモ・行数。新規の納品先は、コードがマスタにあり、名前・住所・電話が合うか。SMILEが自動で付ける項目（製番など）は比べない。**一致しなければ「要確認」**。見つからないときは「出力・JSON作成が終わっていない可能性／SMILEに入っていない可能性」と表示する。

### 3-9. Shopifyの定期取得（ジョブ名なし。タスクスケジューラー）

| 項目 | 内容 |
|---|---|
| 実行するもの | `scripts/shopify_fetch.py`（別セッションで作成中。Python 3.11、`pip install requests`） |
| いつ | 平日 8:00〜18:00 の毎時0分（受注の締め15時の前後で最新になるよう）。休日は不要 |
| 出力先 | SharedMasters直下に**上書き保存**：`ec_shopify_orders.csv`・`ec_shopify_payouts.csv`・`ec_shopify_transactions.csv` |
| 失敗したとき | ログを `SharedMasters/_rpa_queue/logs/` に残し、前回のファイルはそのまま残す（上書きは成功したときだけ） |

## 4. 専用機側で決めてほしいこと

1. PADが「結果ファイル」を書く方法：どの画面から何を読むか（件数・エラー行の取り方）。専用機でSMILEの取込画面を実際に見て決める。
2. 取込の途中でSMILEの画面が想定外になったとき（ログイン切れ・ダイアログ）の止め方（工程の記録・待ち時間の上限・Teamsに【失敗】通知。取込は自動でやり直さない）。`executed` をどの時点で `true` にするか（「実行」を押す直前）。
3. 全件出力フロー（`Smile_EC確認用出力`）の実際の所要時間（約2分の見込みで、`timeoutMinutes: 10` で足りるか）。

## 5. 対応状況

- 2026-10-20：常駐スクリプト（`rpa_queue_worker.ps1`）の取込ジョブで、**`result.json` が書かれないまま終わる3つの経路**を直した（3-3b の表）。①SMILE自動起動の失敗（確認を先に済ませ、失敗しても `result.json` を書く）、②取込の途中で常駐スクリプトが止まった（`partial`・executed 不明で `failed/` へ、固定フォルダを消す）、③取込処理の中の予期しない例外（起動前は `failed`・`executed:false`、起動後は `partial`）。模擬PADのテストで各経路を確認済み。**実機（PAD・SMILE・OneDrive）では未確認**。
- 専用機に反映するには、2-1 の手順（`git pull` → 常駐スクリプトの再起動）が必要。
