# hanaoka-ops

花岡車輌株式会社 業務システム集

## システム一覧

| システム                 | URL                  | 利用対象              | 機能 |
|--------------------------|----------------------|----------------------|------|
| HANAOKA HUB（社内ポータル） | hanaoka_hub.html  | 全社員               | 今日の予定・タスク・KPI・各業務アプリへの入口（index.htmlはリダイレクト用スタブ） |
| 受付案件管理システム     | case_management.html | 業務センター         | FAX/電話受付の案件管理・進捗追跡 |
| 売掛管理システム         | ar_management.html   | 経理                 | 売掛金の入金消込・名寄せ |
| 請求・入金・違算（試作）  | ar_billing.html      | 営業・総務・業務センター | 得意先ごとの請求書（明細）と入金をいつでも見られる。回収予定日を過ぎて請求額と入金額が合わないもの（違算）を拠点別に一覧。読み取りだけ。データは SharePoint `SharedMasters` の `請求明細出力.txt` / `入金明細出力.csv` / `得意先マスタ.csv` / `担当者マスタ.csv`。計算は `ar_billing_core.js`（テスト `tests/test_ar_billing_core.cjs`） |
| 営業ダッシュボード       | sales_dashboard.html | 営業部全員           | 売上実績・前年対比・拠点別/担当者別の進捗可視化 |
| 営業日報ダッシュボード   | sales_report_dashboard.html | 営業部全員     | 受注金額・売上金額・売先ジャンル別・機種別・機工商社別などを日報Excel相当で可視化 |
| 営業目標エディタ         | targets_editor.html  | 営業部長＋指定幹部   | 月次目標・年間目標の編集（バージョン履歴管理） |
| マスタビューワー         | master_viewer.html   | 全社員               | 得意先・仕入先マスタの閲覧（読み取り専用）。得意先はTOVAS請求設定を請求情報に統合し、請求方法・回収方法を業務の言葉に組み立てて表示。仕入先は支払条件（振込・手形の振り分け）を中心に表示。CSV そのままの「元データ」表示も可。データは SharePoint `SharedMasters` の `得意先マスタ.csv` / `仕入先マスタ.csv` / `TOVAS得意先別請求明細書情報.csv` |
| 会計ダッシュボード       | kaikei_dashboard.html | 役員限定             | 月次経営会議用の会計サマリー・営業利益の増減要因（滝グラフ）・主要経費ランキング |
| 会計 仕訳明細            | kaikei_ledger.html   | 役員限定             | 会計サマリーからのドリルダウン。科目・部門・摘要キーワードで仕訳明細を検索 |
| 会計 予算                | kaikei_budget.html   | 役員限定             | 予算の版（事業計画・ストレス・確保計画…）の比較と中身（科目×月）。直すときは新しい版として保存し、過去の版は変更しない。採用中の版が月次資料の「予算・予算差」になる |
| 会計 データ取り込み      | kaikei_upload.html   | 役員限定             | SMILE元帳CSVをブラウザで解析し、SharePointの会計データへ保存（月次） |
| 書類管理システム         | doc_management.html  | 役員限定＋総務       | スキャンされた書類をAIが読み取って仕分け・要約。期限があるものはタスク化。全文検索と書類間のつながり追跡 |
| 社内ワークフロー（試験運用） | wf_app.html      | 全社員（フォームは順次公開） | 申請・承認・差し戻し・後処理・回覧。GRIDY/kintone の置き換え。経路計算は wf-engine.js。フォーム・経路・人はすべて SharePoint `WF_*` リストから読む（画面に業務データを書かない）。処理は Power Automate「WF_操作受付」「WF_段の起票」 |

## 認証（サインイン）

すべてのシステムは Azure AD「業務アプリ」によるシングルサインオン。
花岡車輌のM365アカウントでログイン可能。

**サインインは共通ファイル `hanaoka_auth.js` 1つにまとめてある（2026-10 から）。**
HUB で1回サインインすれば、ほかのアプリはサインインし直さずに開ける。

- サインイン情報は `localStorage` に置き、全アプリで共有する（以前の `sessionStorage` はタブごとに別だった）
- PC はポップアップ、iPhone・iPad・Safari はページ移動でサインインする（端末を見て自動で切り替え）
- 戻り先は共通の `auth.html`。元のページ（`?` や `#` も含む）へ戻すので、**アプリごとに Azure へリダイレクトURIを登録しなくてよい**
- サインイン済みなら、確認中・読み込み中にサインインボタンを見せない（ボタンや案内文に `data-ha-login` を付ける）
- **FUJIN だけは対象外**（現場の共用端末向けに、毎回アカウントを選ばせる作りのため）

### 新しいアプリを作るとき

```html
<script src="https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.10.0/lib/msal-browser.min.js" crossorigin="anonymous"></script>
<script src="hanaoka_auth.js"></script>   <!-- <head> で読む（本文が描かれる前にボタンを隠すため） -->
...
<button id="loginBtn" data-ha-login>サインイン</button>
```

```js
const pca = new msal.PublicClientApplication(HanaokaAuth.msalConfig());
await pca.initialize();
await pca.handleRedirectPromise();               // iPhone/iPad のページ移動から戻ったときの受け取り（必須）
let account = await HanaokaAuth.restore(pca, SCOPES);   // 起動時。だめなら null（例外は投げない）
if (account) showApp();
loginBtn.onclick = async () => { account = await HanaokaAuth.login(pca, SCOPES); showApp(); };
// サインアウトやエラーでサインイン画面をまた見せるとき
HanaokaAuth.done();
```

- `msalConfig()` を使い、**clientId・authority・cacheLocation をページに直接書かない**
- アプリは**リポジトリのルートに置く**（フォルダに入れると `folder/auth.html` を探して404になる）
- 読み込みに時間がかかり、その間もサインイン画面（「読み込み中」）を出したままにする作りなら、
  `HanaokaAuth.holdUntilError(['エラー欄のid'])` を呼ぶ（エラーが出るまでボタンを隠したまま。給与の画面が使用）
- 細かい約束ごとは `hanaoka_auth.js` の先頭のコメントを参照

## デザイン（見た目）

**色・フォント・角丸・影・左メニューは共通ファイル `hanaoka_theme.css` 1か所で決める（2026-10 から）。**
HUB・営業日報と同じ見た目（白い背景のカード＋紺 `#23268f`、Inter / Noto Sans JP）。

| ファイル | 使っている画面 | 役割 |
|---|---|---|
| `hanaoka_theme.css` | 全アプリ（直接、または下のテーマ経由） | 基本の色・フォント・角丸・影。`nav.js` が作る左メニュー（`.hx-sidebar`） |
| `ap_theme.css` | 支払管理（ap_*） | 古い画面の部品を塗り替える上書き |
| `reserve_theme.css` | 予約状況・スケジュール | 〃 |
| `kaikei_theme.css` / `payroll_theme.css` | 会計 / 給与 | 〃（給与はダーク表示をやめて明るい表示だけ） |
| `kachi_theme.css` | 付加価値・原価エディタ・営業目標エディタ | 〃（もとの濃紺＋金を HUB の見た目に） |
| `shutsuzu_theme.css` | 出図・出荷 | 〃（**アクセントのピンク・青は残す**） |
| `wf_theme.css` | ワークフロー | 〃 |

### 新しいアプリを作るとき

- `<head>` で、ページの `<style>` より**前**に `<link rel="stylesheet" href="hanaoka_theme.css?v=…">` を読む
- 色は**直接書かずに変数で**：`var(--navy)` `var(--bg)` `var(--txt)` `var(--sub)` `var(--line)` `var(--radius)` `var(--shadow)` `var(--font)` など
  （一覧は `hanaoka_theme.css` の先頭。値を直すときもそこだけ）
- ★`--accent` は共通ファイルでは**赤**（支払系の昔の名前）。主ボタンの色には `--navy`（または `--pri` / `--primary`）を使う
- 左メニューを付けるなら `nav.js` の `GROUPS` にグループを足し、`<グループ>_theme.css` を読む画面にする
- ロゴは「紺のグラデーションの角丸＋白い線のアイコン」。タブのアイコン（favicon）も同じ絵で作る（`favicon_*.svg` を参照）
- CSS を直したら、読んでいる画面の `?v=` を上げる（ブラウザに古いファイルが残らないように）

## データソース

- **マスタ・売上**：SharePoint `SharedMasters` ライブラリ（CSV / JSON）
- **目標値**：`dashboard_facts.json` 内 `dept_monthly_targets`（`目標_部門目標出力.csv` から
  `regenerate_facts.py` が毎朝生成。部門名は元データの表記ゆれをそのまま格納しているため、
  参照側で「全社」「国内営業部」等へのマッピングが必要）
- **請求・入金（ar_billing.html）**：SMILE から出して `SharedMasters` に置く
  - `請求明細出力.txt`：請求明細出力（条件パターン「SharedMaster」、UTF-8・カンマ・見出しあり）。締めて請求書を発行したら出す。
    **請求書番号**が締め回（と都度発行）ごとの連番で、請求書1枚＝請求先ｺｰﾄﾞ×請求書番号。0 は未請求。
    消費税は請求書ごとに1行（課税区分名「消費税」）で、その日付が締日。請求一覧表と1円単位で一致することを確認済み（2026-10）
  - `入金明細出力.csv`：入金明細出力。総務が入金を登録したら出す。売上割引料・支払手数料・販売促進費（属性「調整」）も入金として数える
  - **特別請求**（SMILE の締めとは別に作った請求書）：同じサイトのリスト `AR_特別請求`。総務が画面で伝票を選んで登録する
    （最初の保存のときにアプリが作る）。1件＝1行、選んだ伝票の中身は `Data` 列に JSON。書けるかどうかは SharePoint の権限で決める
    （総務だけ編集にする）。選んだ伝票は SMILE の請求書から外し、登録した回収予定日で判定。いずれは特別請求稟議（ワークフロー）とつなぐ
  - 得意先マスタの「支払条件追記」の「○万以上 N日後振込」は回収予定日に反映（でんさい・期日指定はいつもの期日のまま）
  - どちらも**期間は長めに出す**（最初の日より前の売上を含む請求書は、請求額がわからないので違算の判定に使わない）
- **案件**：SharePoint List `FAX_CaseManagement` / `FAX_EventHistory`
- **会計データ**：SharePoint `executive-workspace` サイト（役員限定、給与データと同じサイト）の
  `会計データ` フォルダ（CSVを取り込んだ後のJSON。**リポジトリには絶対に置かない**）。
  - `account_master.json`：勘定科目コード → P/L区分（売上高/売上原価/販管費/営業外収益/営業外費用/特別損益等）・正常残高側
  - `expense_lines.json`：経営会議で使う科目グループ定義（例: 旅費交通費 = コード519+648の合算）
  - `monthly/YYYYMM.json`：元帳CSVから取り込んだ月次の科目別集計(`byAccount`)と仕訳明細(`journal`)
  - `budget/index.json`：予算の版の一覧と年度ごとの採用中の版。`budget/vN.json`：1つの版の中身（売上・付加価値率・経費の科目×月）。
    版ファイルは一度保存したら上書きしない（`kaikei_budget.html` で「新しい版」として保存）。売上の月別の配分は営業目標エディタの部門月次目標から取る
  - `prior_actuals.json`：前年実績の初期データ（元帳を取り込む前の月の補完用）
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

### hub_kpi_facts.json（HANAOKA HUB 用の軽量版）

`regenerate_facts.py` が `dashboard_facts.json` のアップロード後に出力する。
形式・列位置は `dashboard_facts.json` と同じで、**直近の行**（年月度・伝票日付・納期の
いずれかがビルド月の2か月前以降）と **HUBの「会社の現在地」が使う列だけ** を残し、
他の列は `null` にしてある。HUB（`hanaoka_hub.html`）はこれを優先して読み、
ファイルが無いときだけ全量の `dashboard_facts.json` で集計する。
HUBで新しい列を使う場合は `HUB_KEEP_COLS` に追加すること（テスト: `tests/test_hub_kpi_facts.py`）。

## 開発・運用

- HTMLはGitHub Pagesで配信
- Azure ADのリダイレクトURIに登録されたURLからのみアクセス可
- 編集権限はSharePoint Listの権限管理で制御（個別Listごとに設定）
