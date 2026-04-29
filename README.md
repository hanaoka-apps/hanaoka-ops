# hanaoka-ops

花岡車輌株式会社 業務システム集

## システム一覧

| システム                 | URL                  | 利用対象              | 機能 |
|--------------------------|----------------------|----------------------|------|
| 受付案件管理システム     | case_management.html | 業務センター         | FAX/電話受付の案件管理・進捗追跡 |
| 売掛管理システム         | ar_management.html   | 経理                 | 売掛金の入金消込・名寄せ |
| 営業ダッシュボード       | sales_dashboard.html | 営業部全員           | 売上実績・前年対比・拠点別/担当者別の進捗可視化 |
| 営業目標エディタ         | targets_editor.html  | 営業部長＋指定幹部   | 月次目標・年間目標の編集（バージョン履歴管理） |

## 認証

すべてのシステムは Azure AD「業務アプリ」によるシングルサインオン。
花岡車輌のM365アカウントでログイン可能。

## データソース

- **マスタ・売上**：SharePoint `SharedMasters` ライブラリ（CSV / JSON）
- **目標値**：SharePoint List `SalesTargets`
- **案件**：SharePoint List `FAX_CaseManagement` / `FAX_EventHistory`

## 開発・運用

- HTMLはGitHub Pagesで配信
- Azure ADのリダイレクトURIに登録されたURLからのみアクセス可
- 編集権限はSharePoint Listの権限管理で制御（個別Listごとに設定）
