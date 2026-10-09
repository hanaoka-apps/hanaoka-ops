# 新PC（RPA用）セットアップ引き継ぎ

このファイルは、**新しいPCのClaude Code**がリポジトリを取得した直後に読んで、
作業の目的・現状・やることを把握するための引き継ぎ資料です。
最初に「`scripts/rpa_setup/新PC引き継ぎ.md` を読んで、書かれている順に進めて」と指示してください。

## 目的

日報締め（毎営業日16:00）後の「SMILE出力 → 営業日報ダッシュボード反映」を、人手なしで回す。

```
[SMILE] --(RPA: Power Automate Desktop)--> 売上明細出力.csv / 受注明細出力.csv
        --(OneDrive同期)--> SharedMasters
        --(scripts/regenerate_facts.py)--> dashboard_facts.json (SharedMasters)
        --> 営業日報ダッシュボード(sales_report_dashboard.html) に反映
```

## すでにできていること（mainにマージ済み）

| 部品 | 場所 | 状態 |
|---|---|---|
| 「🔄 再集計をリクエスト」ボタン | `sales_report_dashboard.html`（管理者のみ表示） | 完成。押すと SharedMasters 直下に `_regenerate_request.json` を1つ置くだけ |
| 常駐監視スクリプト | `scripts/watch_regenerate_request.ps1` | 完成。`FileSystemWatcher`で合図ファイルを検知 → ①SMILE出力 → ②`regenerate_facts.py`実行 → ③合図ファイル削除 |
| SMILE出力の呼び出し口 | 上記スクリプトの `Invoke-SmileExport` | 完成。環境変数 `SMILE_EXPORT_COMMAND` のコマンドを `cmd.exe /c` で実行。未設定ならエラーで止まる |
| JSON生成 | `scripts/regenerate_facts.py` | 完成。GitHub Actionsが毎日 06:00 / 16:15 JST にも自動実行している |

## まだ無いもの（このPCで作る）

1. **SMILEから5帳票を出力するRPAフロー**（Power Automate Desktop）
   - 出力する帳票は次の5つ
     - `受注明細出力.csv`（当期の受注）
     - `売上明細出力.csv`（当期の売上）
     - `目標_部門目標出力.csv` / `目標_担当者目標出力.csv`（`regenerate_facts.py` が月次目標として使う）
     - `目標_得意先目標出力.csv`（`regenerate_facts.py` では未使用だが同じフローで出力する）
   - 保存先は SharedMasters 直下（OneDrive同期フォルダ）。ファイル名は上記のまま固定
   - ほかのCSV（`daily_reports.csv`、`web_tracking_*` など）はSMILE出力ではないので触らない
2. このPCへの監視スクリプトの常駐設定
3. 実機での通し確認

## 手順

### 1. 準備
- [ ] M365アカウントでOneDriveにサインインし、`SharedMasters` を同期する
- [ ] 同期先パスが `watch_regenerate_request.ps1` 先頭の `$SharedMastersPath` と一致するか確認（違えば**スクリプト側を書き換える**）
- [ ] Python 3.11 目安 + `pip install requests`
- [ ] Power Automate Desktop が使えること、SMILEにこのPCからログインできること

### 2. 環境変数（ユーザー環境変数。設定後は再ログオン）
```powershell
setx SMILE_EXPORT_COMMAND "...（手順3で決まったコマンド）"
```
- `AZURE_*` は不要。監視スクリプトは `regenerate_facts.py` を `SHARED_MASTERS_DIR` 付きで実行し、
  Graph APIを使わずに同期フォルダのCSVを直接読み、JSONも同じフォルダに書き出す（アップロードはOneDrive同期に任せる）
- 手動で `regenerate_facts.py` を動かすときも `$env:SHARED_MASTERS_DIR = "<SharedMastersの同期パス>"` を設定して実行する

### 3. SMILE出力のRPAフロー作成
- 福田さんが実際にSMILEで5帳票を出す手順を見せてくれるので、それをPADフローにする
  （画面・メニュー・抽出条件（期間＝当期）・出力先・文字コードを確認しながら）
- フロー内で、出力した5つのCSVを SharedMasters 直下へ**上書き保存**まで行う
- 完成したら、コンソールから起動できることを確認して `SMILE_EXPORT_COMMAND` に設定
  例: `"C:\Program Files (x86)\Power Automate Desktop\PAD.Console.Host.exe" -run "フロー名"`
  （正確な起動コマンドはこのPCのPADのバージョンで確認する）
- **注意**: `ms-powerautomate:/console/flow/run?workflowName=...` のURIで起動する方法（`start` や `Start-Process`）は、
  フローの完了を待たずにすぐ戻る。そのまま `SMILE_EXPORT_COMMAND` にすると、出力が終わる前に
  `regenerate_facts.py` が古いCSVで集計してしまう。この場合は、フロー起動後に5つのCSVの更新・書き込み完了を
  待ってから終了する起動用スクリプトをPC側に用意し、それを `SMILE_EXPORT_COMMAND` に設定する
- CSVの列構成は `scripts/regenerate_facts.py` が前提にしているので、**列名・順序を変えない**
  （過去に出していた手動出力と同じ形式になっているか、既存CSVと見比べる）

### 4. 監視スクリプトの常駐
- タスクスケジューラーに登録：トリガー＝「ログオン時」に**1回だけ**起動（5分おき再実行にしない）
- 操作：`powershell.exe -ExecutionPolicy Bypass -File "<配置先>\watch_regenerate_request.ps1"`
- ログ：`%USERPROFILE%\regenerate_watcher.log`

### 5. 通し確認
- [ ] ダッシュボードで「🔄 再集計をリクエスト」→ ログに検知ログが出る
- [ ] SMILE出力（RPA）が走り、SharedMasters の5CSVの更新日時が変わる
- [ ] `regenerate_facts.py` が成功し、`dashboard_facts.json` が更新される
- [ ] ダッシュボードを再読み込みして数字が最新になっている（`build_meta.updated_at`）
- [ ] 失敗時（SMILE_EXPORT_COMMAND未設定・RPA失敗）にログへエラーが残り、合図ファイルが消えること

## 作業ルール（このリポジトリ共通）
- 変更は**必ず最新のmainから新しいブランチを切って**行い、pushしてPRにする。**mainへ直接マージしない**
- 秘密情報（シークレット・パスワード・個人情報の入ったCSV）はリポジトリに置かない
- 追加・修正したスクリプトは、実際に動かして確認してからPRにする
- このPCでの実運用の手順が確定したら、この資料を更新するPRも出す

## 補足
- `regenerate_facts.py` のGitHub Actions実行（06:00 / 16:15）とこのPCの実行は同じ `dashboard_facts.json` を上書きする。同時実行は避ける（監視スクリプトは処理中の合図を無視する作りだが、Actionsとは排他していない）
- 日次の業務フロー全体の手順書は「日報締め業務フロー」ランブック（Artifact）にある。RPA化が完了したら「SMILEからデータ出力」のステータスを更新する
