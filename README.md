# hanaoka-ops

花岡車輌株式会社 業務システム集

## システム一覧

| システム                 | URL                  | 利用対象              | 機能 |
|--------------------------|----------------------|----------------------|------|
| HANAOKA HUB（社内ポータル） | index.html        | 全社員               | 今日の予定・タスク・KPI・各業務アプリへの入口 |
| 受付案件管理システム     | case_management.html | 業務センター         | FAX/電話受付の案件管理・進捗追跡 |
| 売掛管理システム         | ar_management.html   | 経理                 | 売掛金の入金消込・名寄せ |
| 営業ダッシュボード       | sales_dashboard.html | 営業部全員           | 売上実績・前年対比・拠点別/担当者別の進捗可視化 |
| 営業日報ダッシュボード   | sales_report_dashboard.html | 営業部全員     | 受注金額・売上金額・売先ジャンル別・機種別・機工商社別などを日報Excel相当で可視化 |
| 営業目標エディタ         | targets_editor.html  | 営業部長＋指定幹部   | 月次目標・年間目標の編集（バージョン履歴管理） |

## 認証

すべてのシステムは Azure AD「業務アプリ」によるシングルサインオン。
花岡車輌のM365アカウントでログイン可能。

## データソース

- **マスタ・売上**：SharePoint `SharedMasters` ライブラリ（CSV / JSON）
- **目標値**：`dashboard_facts.json` 内 `dept_monthly_targets`（`目標_部門目標出力.csv` から
  `regenerate_facts.py` が毎朝生成。部門名は元データの表記ゆれをそのまま格納しているため、
  参照側で「全社」「国内営業部」等へのマッピングが必要）
- **案件**：SharePoint List `FAX_CaseManagement` / `FAX_EventHistory`

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
