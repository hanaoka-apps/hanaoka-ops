# RPA専用機 セットアップ・運用資料

このファイルは、RPA専用機（PADでSMILEなどを操作するPC）を**新しく用意する／入れ替える**ときに、
そのPCのClaude Codeがリポジトリを取得した直後に読んで、仕組み・やることを把握するための資料です。
最初に「`scripts/rpa_setup/新PC引き継ぎ.md` を読んで、書かれている順に進めて」と指示してください。

## 目的と仕組み

各アプリ（どのPCからでも）からの依頼で、RPA専用機がPADフローを**1件ずつ順番に**実行する。
最初のジョブは、日報締め後の「SMILE出力 → 営業日報ダッシュボード反映」（`sales_master`）。

```
[各アプリ]  rpa_queue.js で依頼
   │ SharePoint の SharedMasters/_rpa_queue/pending/ に依頼ファイルを1件置く
   │   例: 20261009T101650123Z_sales_master_ab12.json（名前順＝依頼順）
   ▼ (OneDrive同期)
[RPA専用機] scripts/rpa_queue_worker.ps1（タスクスケジューラーでログオン時に常駐）
   │ 30秒ごとに pending を確認し、古い順に1件ずつ実行（同じジョブはまとめて1回）
   │ pending → running → done / failed とフォルダを移し、状態・エラーを書き込む
   │ ジョブの中身は scripts/rpa_jobs.json（毎回GitHubのmainから取得）:
   │   PADフローをURIで起動 → outputs のファイルがすべて更新されるまで待つ → after の処理
   ▼
[アプリ] _rpa_queue を見て「順番待ち／実行中／完了／失敗」を表示
```

- PADは同時に1つのフローしか動かせないため、RPA専用機1台で1列に並べて処理する
- PADフローを `ms-powerautomate:` のURIで起動すると完了を待たずに戻るので、**出力ファイルの更新で完了を判断する**
- OneDrive同期で届いたファイルはファイル変更通知（FileSystemWatcher）が来ないことがあるため、30秒ごとの確認にしている
- 依頼から開始までは、OneDrive同期（数十秒〜1分強）＋最大30秒かかる
- done / failed の記録は30日で自動削除

## 部品

| 部品 | 場所 | 役割 |
|---|---|---|
| ジョブ定義 | `scripts/rpa_jobs.json` | ジョブ名 → PADフロー名・出力ファイル・待ち時間の上限・後処理 |
| 常駐スクリプト（本体） | `scripts/rpa_queue_worker.ps1` | 依頼の順番待ち処理。ログは `%USERPROFILE%\regenerate_watcher.log` |
| 常駐スクリプト（入口） | `scripts/watch_regenerate_request.ps1` | タスクスケジューラーが起動するファイル。本体を呼ぶだけ |
| アプリ用部品 | `rpa_queue.js` | 依頼の登録・状態の確認（使い方はファイル先頭のコメント） |
| JSON生成 | `scripts/regenerate_facts.py` | `sales_master` / `facts_only` の後処理。`SHARED_MASTERS_DIR` 指定で同期フォルダを直接読み書きする（`AZURE_*` 不要）。`dashboard_facts.json`（Sales HUB・日報・価値ダッシュボード・目標エディター）、`hub_kpi_facts.json`（HANAOKA HUB）、`dashboard_visits.json`（Sales HUBの訪問実績）を作る |
| 定時の再作成 | `scripts/rpa_jobs.json` の `schedules` | 常駐スクリプトが毎日 **1:00** に `facts_only` を自分で依頼する（SMILEの業務予定「マスタ出力」が毎日 **0:00** に出力したCSVから作り直す）。PCが止まっていて時刻を過ぎても、その日のうちに起動すれば依頼する。依頼済みの記録は `%LOCALAPPDATA%\hanaoka-rpa\schedule_state.json` |
| GitHub Actions | `.github/workflows/regenerate-facts.yml` | **手動実行専用**（非常用）。以前の定時実行（06:00 / 16:15）は、GitHubの定時実行が3〜7時間遅れて時刻どおりに動かなかったため止めた |
| 旧方式の合図ファイル | `SharedMasters/_regenerate_request.json` | 移行用。置かれたら常駐スクリプトが `sales_master` の依頼として受け付け、ジョブ完了後に消す |

## ジョブを追加する

1. RPA専用機でPADフローを作る。出力ファイルは SharedMasters 直下に**上書き保存**し、ファイル名は固定にする
   - SMILEの出力画面を使うだけなら、`Smile_日報用マスタ出力` を複製して、5行目「テキストの分割」の画面名一覧を書き換えるのが早い
     （各画面で条件パターン「SharedMasters更新」を**既定**として保存しておく。画面名はSMILEの検索欄に入れる名前）
2. `scripts/rpa_jobs.json` にジョブを1件足してPRを出す（マージすれば常駐スクリプトに反映される。PC側の作業は不要）
   ```json
   "<ジョブ名>": {
     "label": "画面に出す名前",
     "flow": "<PADのフロー名>",
     "outputs": ["<出力ファイル名>", "..."],
     "timeoutMinutes": 20
   }
   ```
   - `outputs` は**すべて**が起動後に更新され、30秒サイズが変わらず、書き込み中でなくなったら完了とみなす
   - 複数のPADフローを順に動かすジョブは、`flow` / `outputs` の代わりに `steps` を書く（各手順の出力完了を待ってから次へ進む。失敗時は「手順2/2（フロー名）: …」と止まった手順が出る）
     ```json
     "<ジョブ名>": {
       "label": "画面に出す名前",
       "timeoutMinutes": 20,
       "steps": [
         { "flow": "<1つ目のPADフロー名>", "outputs": ["<1つ目の出力ファイル名>"] },
         { "flow": "<2つ目のPADフロー名>", "outputs": ["<2つ目の出力ファイル名>"] }
       ]
     }
     ```
     手順ごとに `timeoutMinutes` を書けば、その手順だけ待ち時間の上限を変えられる
   - 後処理が要るときは `"after": "regenerate_facts"`（今はこれだけ対応。増やすときは `rpa_queue_worker.ps1` の `Invoke-NextJob` に足す）
   - ジョブ名は英数字と `_` にする（ファイル名に入るため）
3. アプリから依頼する
   ```js
   RpaQueue.init({ getToken, driveId: <SharedMastersのドライブID> });
   const { name } = await RpaQueue.request('<ジョブ名>', { app: '<アプリ名>', requestedBy: account.username });
   RpaQueue.watch(name, s => { /* s.state: pending(s.ahead) / running / done / failed(s.error) / timeout */ });
   ```
   同じジョブがすでに待っていれば新しくは登録せず、その依頼を返す（まとめて1回で実行されるため）

## 新しいRPA専用機を用意する手順

### 1. 準備
- [ ] M365アカウントでOneDriveにサインインし、`SharedMasters` を同期する
- [ ] 同期先パスが `rpa_queue_worker.ps1` 先頭の `$SharedMastersPath` と一致するか確認（違えば**スクリプト側を書き換える**）
- [ ] Python 3.11 目安 + `pip install requests`
- [ ] Power Automate Desktop が使えること、SMILEにこのPCからログインできること
- [ ] Git（`winget install Git.Git`）でこのリポジトリをクローンする。OneDrive上に置く場合は、そのフォルダを「このデバイス上に常に保持する」にする

### 2. PADフロー
- `rpa_jobs.json` の各ジョブの `flow` と同じ名前でPADフローを作る（`sales_master` は `Smile_日報用マスタ出力`）
- `sales_master` が出力する5帳票（SharedMasters 直下に上書き保存。ファイル名は固定）
  - `受注明細出力.csv`（当期の受注）
  - `売上明細出力.csv`（当期の売上）
  - `目標_部門目標出力.csv` / `目標_担当者目標出力.csv`（`regenerate_facts.py` が月次目標として使う）
  - `目標_得意先目標出力.csv`（`regenerate_facts.py` では未使用だが同じフローで出力する）
- `customer_master` のフロー `Smile_得意先マスタ出力` は、`Smile_日報用マスタ出力` の複製で、画面名一覧を
  `生産得意先マスター出力,得意先別請求明細書情報出力` にしたもの
  - → `得意先マスタ.csv`（UTF-8・カンマ・タイトル有り）と `TOVAS得意先別請求明細書情報.csv`
  - `得意先マスタ.csv` はSMILE標準の定時処理「マスタ出力(毎日1時)」でも毎日1:05に出力されている（同じファイルを上書き）
- CSVの列構成は `scripts/regenerate_facts.py` が前提にしているので、**列名・順序を変えない**
- ほかのCSV（`daily_reports.csv`、`web_tracking_*` など）はSMILE出力ではないので触らない

### 3. 常駐スクリプトの登録
- タスクスケジューラーに登録：トリガー＝「ログオン時」に**1回だけ**起動、実行時間の上限なし、多重起動しない
- 操作：プログラム `conhost.exe`、引数 `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<クローン先>\scripts\watch_regenerate_request.ps1"`
  - `powershell.exe -WindowStyle Hidden` を直接起動にしない。Windows 11 で既定のターミナルが「Windows ターミナル」だと
    画面が見えてしまい、それを閉じると常駐スクリプトも終了する（タスクの結果 `0xC000013A`。実際に発生した）
- PADが画面を操作するので、ログオン中のユーザーとして（対話型で）実行する
- 環境変数の設定は不要（以前の `SMILE_EXPORT_COMMAND` / `AZURE_*` は使わない）

### 4. 通し確認
- [ ] ダッシュボードで「🔄 再集計をリクエスト」→ 画面に「受付待ち／順番待ち」→「SMILE出力・集計中」と出る
- [ ] ログに「ジョブを開始します: sales_master」が出て、SharedMasters の5CSVの更新日時が変わる
- [ ] `regenerate_facts.py` が成功し、`dashboard_facts.json` が更新される
- [ ] 画面に「✅ 再集計が完了し、最新データを表示しています（データ更新: …）」と出る
- [ ] 失敗時は `_rpa_queue/failed/` に移り、画面とログにエラーが出る

## 作業ルール（このリポジトリ共通）
- 変更は**必ず最新のmainから新しいブランチを切って**行い、pushしてPRにする。**mainへ直接マージしない**
- 秘密情報（シークレット・パスワード・個人情報の入ったCSV）はリポジトリに置かない
- 追加・修正したスクリプトは、実際に動かして確認してからPRにする
- PowerShellスクリプトは**BOM付きUTF-8**で保存する（Windows PowerShell 5.1 はBOMなしだと日本語を誤読し、パスが文字化けする）

## 補足
- `regenerate_facts.py` をGitHub Actionsから手動実行すると、RPA専用機の実行と同じ `dashboard_facts.json` を上書きする。Actionsとは排他していないので、RPA専用機でジョブが動いていないときに使う
- 定時の時刻を変えるときは `rpa_jobs.json` の `schedules` の `time`（HH:mm）を書き換えてPRを出す（RPA専用機は10分以内に新しい定義を読む）
- Power Automate（クラウドフロー）からPADを直接起動する方式は、以前PADの更新などで止まったことがあるため使っていない（タスクスケジューラー常駐の方が安定）
- 日次の業務フロー全体の手順書は「日報締め業務フロー」ランブック（Artifact）にある。RPA化が完了したら「SMILEからデータ出力」のステータスを更新する
