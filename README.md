# hanaoka-ops

花岡車輌株式会社 業務システム集

## システム一覧

| システム                 | URL                  | 利用対象              | 機能 |
|--------------------------|----------------------|----------------------|------|
| HANAOKA HUB（社内ポータル） | hanaoka_hub.html  | 全社員               | 今日の予定・タスク・KPI・各業務アプリへの入口（index.htmlはリダイレクト用スタブ） |
| 受付案件管理システム     | case_management.html | 業務センター         | FAX/電話受付の案件管理・進捗追跡 |
| 売掛管理システム         | ar_management.html   | 経理                 | 売掛金の入金消込・名寄せ |
| 営業ダッシュボード       | sales_dashboard.html | 営業部全員           | 売上実績・前年対比・拠点別/担当者別の進捗可視化 |
| 営業日報ダッシュボード   | sales_report_dashboard.html | 営業部全員     | 受注金額・売上金額・売先ジャンル別・機種別・機工商社別などを日報Excel相当で可視化 |
| 営業目標エディタ         | targets_editor.html  | 営業部長＋指定幹部   | 月次目標・年間目標の編集（バージョン履歴管理） |
| 会計ダッシュボード       | kaikei_dashboard.html | 役員限定             | 月次経営会議用の会計サマリー・営業利益の増減要因（滝グラフ）・主要経費ランキング |
| 会計 仕訳明細            | kaikei_ledger.html   | 役員限定             | 会計サマリーからのドリルダウン。科目・部門・摘要キーワードで仕訳明細を検索 |
| 会計 予算・前年実績編集   | kaikei_budget.html   | 役員限定             | 科目グループ×月度で予算・前年実績を編集（保存の都度スナップショットを保持） |
| 会計 データ取り込み      | kaikei_upload.html   | 役員限定             | SMILE元帳CSVをブラウザで解析し、SharePointの会計データへ保存（月次） |
| 書類管理システム         | doc_management.html  | 役員限定＋総務       | スキャンされた書類をAIが読み取って仕分け・要約。期限があるものはタスク化。全文検索と書類間のつながり追跡 |
| 社内ワークフロー（試験運用） | wf_app.html      | 全社員（フォームは順次公開） | 申請・承認・差し戻し・後処理・回覧。GRIDY/kintone の置き換え。経路計算は wf-engine.js。フォーム・経路・人はすべて SharePoint `WF_*` リストから読む（画面に業務データを書かない）。処理は Power Automate「WF_操作受付」「WF_段の起票」 |

## 認証

すべてのシステムは Azure AD「業務アプリ」によるシングルサインオン。
花岡車輌のM365アカウントでログイン可能。

## データソース

- **マスタ・売上**：SharePoint `SharedMasters` ライブラリ（CSV / JSON）
- **目標値**：`dashboard_facts.json` 内 `dept_monthly_targets`（`目標_部門目標出力.csv` から
  `regenerate_facts.py` が毎朝生成。部門名は元データの表記ゆれをそのまま格納しているため、
  参照側で「全社」「国内営業部」等へのマッピングが必要）
- **案件**：SharePoint List `FAX_CaseManagement` / `FAX_EventHistory`
- **会計データ**：SharePoint `executive-workspace` サイト（役員限定、給与データと同じサイト）の
  `会計データ` フォルダ（CSVを取り込んだ後のJSON。**リポジトリには絶対に置かない**）。
  - `account_master.json`：勘定科目コード → P/L区分（売上高/売上原価/販管費/営業外収益/営業外費用/特別損益等）・正常残高側
  - `expense_lines.json`：経営会議で使う科目グループ定義（例: 旅費交通費 = コード519+648の合算）
  - `monthly/YYYYMM.json`：元帳CSVから取り込んだ月次の科目別集計(`byAccount`)と仕訳明細(`journal`)
  - `budget.json` / `prior_actuals.json`：予算・前年実績（科目グループ×月度）。`kaikei_budget.html` で編集
  - 取り込みは `kaikei_upload.html` でSMILE元帳CSVをブラウザにドラッグするだけ（サーバー・定期実行スクリプトなし）
- **書類データ**：`executive-workspace` サイトの既定ドキュメントライブラリ配下 `書類管理/`
  （会計データ・給与データと同じサイト。銀行残高・融資・住民税明細・財形など個人名と
  金額を含む書類を扱うため、受付案件管理と同じサイトには置かない）
  - `DocRegistry`（リスト）：書類台帳。1書類＝1行
    - 列は**絞り込み・並べ替えに使うものだけ**（Category / Sender / DocDate / ReceivedDate /
      DueDate / Amount / DocStatus / TaskStatus / ThreadId / FileName / FileUrl）。
      読み取った項目・要約・全文・つながりは `Data` 列にJSONで入る。
      **書類は種類が読めないので、新しい項目が出てきても列を足さなくて済む形にしている**
  - `書類管理/原本/YYYY/`：原本PDF（スキャンフォルダからのコピー。元ファイルは動かさない）
  - `書類管理/_取込待ち/`：取込エージェントが置く取込票(JSON)。画面を開くと台帳に登録され `_取込済/` へ移る
  - 取込は `scripts/doc_ingest/取込手順.md` に従って、福田さんのPCで動くClaudeが実施。
    **エージェントは書き込み権限を持たない**（同期フォルダに置くだけ。台帳に行を作るのは
    常にサインインした人の権限）。新着検出は `scripts/doc_ingest/new_scans.sh`
  - 誰が見られるかは **SharePointのサイト権限がそのまま効く**。画面側に権限判定を書かない
    （判定を書くと、その判定のバグがそのまま漏洩になる）
  - リダイレクトURIは共通の `auth.html`（ap_* 系と同じ）。Azure側の追加登録は不要。
    ポップアップ認証のみ対応（iOS/Safariのリダイレクト方式は未対応。PC用の画面のため）

### dashboard_facts.json の `order_rows`（受注明細）について

`order_rows` の各行末尾（index 27）に **納期** を追加済み（2026年9月〜）。
`年月度` は受注時点で固定され、納期の変更を反映しないため、月次の受注集計（当月受注・
翌月受注など）には `年月度` ではなく **納期** を使う必要がある。
`受注日付` は「当日」の判定にのみ使う（それ以外の目的で使うと締まっていない
当日以降の入力データが紛れ込む）。詳しくは `sales_report_dashboard.html` の実装を参照。

## 開発・運用

- HTMLはGitHub Pagesで配信
- Azure ADのリダイレクトURIに登録されたURLからのみアクセス可
- 編集権限はSharePoint Listの権限管理で制御（個別Listごとに設定）
