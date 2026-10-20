# Shopify の定期取得：専用機の設定手順（`scripts/shopify_fetch.py`）

Shopify の注文・入金を Admin GraphQL API で取って、EC売上アプリが読む CSV を SharedMasters に置くスクリプトの手順。
約束事（出力ファイル・時刻・失敗時の扱い）は `EC売上_RPA専用機への依頼内容.md` の「1. Shopify の定期取得」。

| 出力（SharedMasters 直下に上書き） | 中身（Shopify 管理画面の CSV エクスポートと同じ列） |
|---|---|
| `ec_shopify_orders.csv` | 注文（注文のエクスポート）。商品が複数の注文は複数行：先頭行に注文の値、2行目以降は `Name` と `Lineitem …` の列だけ |
| `ec_shopify_payouts.csv` | 入金（入金のエクスポート） |
| `ec_shopify_transactions.csv` | 支払いの取引（取引のエクスポート。入金日×注文の突き合わせに使う） |

3つとも取れたときだけ置き換える（一時ファイルに書いて最後に置き換え）。途中で失敗したら前回のファイルがそのまま残る。
ログは `SharedMasters\_rpa_queue\logs\shopify_fetch.log` に1行ずつ追記（`[日時] 内容`。トークン・Client secret・ストア名は書かない）。

## 1. Shopify 側の準備（管理者に頼む）

Shopify は **2026/1/1 から、管理画面で新しい「レガシーなカスタムアプリ」（固定の `shpat_…` トークン）を作れなくした**。新しく作るときは **Dev Dashboard（dev.shopify.com）** でアプリを作り、**Client ID / Client secret** で、実行のたびにトークンを取る（client credentials grant）。トークンは約24時間（`expires_in`=86399秒）で切れるので、スクリプトが毎回取り直す（メモリだけに持ち、ファイル・ログには出さない）。

### 1-A. Dev Dashboard のアプリ（新規はこちら）

1. dev.shopify.com の Dev Dashboard → Apps → 「Create app」→「Start from Dev Dashboard」でアプリ名を付けて作成
2. アプリの「Versions」で **スコープ**を追加して「Release」（バージョンを1つ作らないとインストールできない）。スコープは下の表
3. 「Install app」でこのストアにインストール（スコープを変えたらバージョンを作り直して再インストール）
4. 「App settings」の **Client ID** と **Client secret** を、専用機の環境変数に設定（2. 参照。**値はチャット・メール・リポジトリに貼らない**）

**制約（公式：client credentials grant）**：このやり方は、**アプリとストアが同じ Shopify 組織（Dev Dashboard の表示）にあるときだけ**使える。ストアを持っている・インストールしただけでは足りない。組織が違うと、トークン取得が `shop_not_permitted` で失敗する（スクリプトは「同じ Shopify 組織か確認」と出す）。その場合は組織をそろえる（アプリを作る組織＝ストアの組織にする）。

### 1-B. 固定トークン（既存のレガシーなカスタムアプリがある場合だけ）

2026/1/1 より前に作った管理画面のカスタムアプリは、そのまま使える（影響なし）。ストアの管理画面 → 設定 → アプリと販売チャネル → 「アプリを開発」のアプリで、下のスコープが付いていることを確認し、Admin API アクセストークン（`shpat_`）を `SHOPIFY_ACCESS_TOKEN` に設定する。トークンは発行時の1回しか表示されない。

### 必要なスコープ（1-A・1-B 共通。読み取りだけ。書き込みは付けない）

| スコープ | 何のため | 備考（公式の access scopes ページ） |
|---|---|---|
| `read_orders` | 注文 | **直近60日の注文だけ**が対象 |
| `read_all_orders` | 60日より前の注文 | **Shopify の承認が必要**（Partner Dashboard の API access requests から申請。理由の記入が要る）。`read_orders` と一緒に使う。承認されるまでは `SHOPIFY_FETCH_DAYS` を60以下にする（既定の90日にするなら必要） |
| `read_shopify_payments_payouts` | 入金（`ShopifyPaymentsPayout`）と取引（`ShopifyPaymentsBalanceTransaction`） | 入金・取引はこのスコープに含まれる |
| `read_shopify_payments_accounts` | `shopifyPaymentsAccount`（入金・取引を引く入口） | **要確認**：スクリプトは `shopifyPaymentsAccount` の下から入金・取引を引く。権限エラー（ACCESS_DENIED）が出たらこれも追加する |

### 保護された顧客データ（お客様の名前・住所・電話・メール）

注文からお届け先の名前・住所・電話・メールを読むので、Shopify の「保護された顧客データ」に当たる（レベル2＝名前・住所・メール・電話を項目ごとに申請）。

- 公式ページ（Protected customer data）では、**カスタムアプリはレベル1・2とも「常に利用可（審査不要）」**、管理画面で作ったカスタムアプリはレベル2が「プランによる」、公開アプリは審査が必要、と書かれている。
- **Dev Dashboard のアプリがどれに当たるかは、そのページに書かれておらず確認できていない（要確認）**。承認されていない項目は**エラーまたは null（伏せ字）で返る**ので、最初の実行で名前・住所・電話が空になっていたら、Dev Dashboard のアプリの「API access requests」（Partner Dashboard の場合は Protected customer data access）で申請する。
- 申請画面の流れ（公式）：「Protected customer data」を選んで理由を書く → 必要な項目（名前・住所・メール・電話）を選んで理由を書く → データ保護の詳細を記入して提出。

## 2. 専用機の準備

1. Python 3.11 と `requests`：`py -3.11 -m pip install requests`
2. リポジトリの `scripts\shopify_fetch.py` を専用機に置く（例 `C:\RPA\shopify_fetch.py`。リポジトリを clone していればそのパスでよい）
3. **ユーザー環境変数**（タスクを動かすアカウントで設定。値はこのリポジトリ・チャット・メールに書かない）

| 変数 | 内容 |
|---|---|
| `SHOPIFY_SHOP` | ストアのドメイン `xxxx.myshopify.com`（独自ドメインではなく myshopify.com のもの） |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | 1-A のアプリの Client ID / Client secret（**新規はこちら**。両方そろえる。あればこちらを使う） |
| `SHOPIFY_ACCESS_TOKEN` | 1-B の固定トークン（レガシーなカスタムアプリがある場合だけ。上の2つが無いときに使う） |
| `SHARED_MASTERS_DIR` | OneDrive 同期済みの SharedMasters のパス（既存の `regenerate_facts.py` と同じもの） |
| `SHOPIFY_API_VERSION` | （任意）Admin API のバージョン。省略時はスクリプトの `DEFAULT_API_VERSION`。Shopify は古いバージョンを順に止めるので、四半期ごとに新しいものへ上げる |
| `SHOPIFY_FETCH_DAYS` | （任意）直近何日ぶん。省略時は 90 |
| `SHOPIFY_TZ_OFFSET_HOURS` | （任意）日時の時差。省略時は 9（日本時間） |

PowerShell で設定する例（秘密の行は画面に残らないよう、実行後に履歴を消す）：

```powershell
[Environment]::SetEnvironmentVariable('SHOPIFY_SHOP', 'xxxx.myshopify.com', 'User')
[Environment]::SetEnvironmentVariable('SHOPIFY_CLIENT_ID', '<Client ID>', 'User')
[Environment]::SetEnvironmentVariable('SHOPIFY_CLIENT_SECRET', '<Client secret>', 'User')
# 固定トークンを使う場合は上の2行の代わりに：SHOPIFY_ACCESS_TOKEN
[Environment]::SetEnvironmentVariable('SHARED_MASTERS_DIR', 'C:\Users\<専用機のユーザー>\OneDrive - …\SharedMasters', 'User')
```

## 3. 動作確認（手で1回）

新しい PowerShell を開いて（環境変数を読み直すため）：

```powershell
py -3.11 C:\RPA\shopify_fetch.py
echo $LASTEXITCODE
```

- 0＝成功。SharedMasters 直下の3つの CSV が更新され、`_rpa_queue\logs\shopify_fetch.log` に「保存しました: …」が出る。
- 1＝取得に失敗（前回のファイルは残る）。理由は同じログに書いてある（権限不足・トークン違い・レート制限の再試行切れなど）。
- 2＝環境変数が足りない。
- 中身の確認：`ec_shopify_orders.csv` を Excel で開き、Shopify 管理画面でエクスポートした CSV と、同じ注文の **Total・Created at・Lineitem・お届け先** が合っているか見る。商品が複数の注文は、2行目以降に Total が入っていないこと。
- 画面での確認：EC売上アプリ（ec_sales.html）を開いて注文が読まれ、入金タブで入金額の突き合わせが「一致」になること（取り込み中の入金は予定日どおりの行で出る）。
- 失敗時に前回のファイルが残ることの確認：Client secret（固定トークンなら SHOPIFY_ACCESS_TOKEN）をわざと間違えて実行 → 終了コード1 → CSV が変わっていないこと。確認後に戻す。

## 4. タスクスケジューラーに登録

- 全般：「ユーザーがログオンしているかどうかにかかわらず実行する」でもよいが、OneDrive の同期はログオン中のほうが確実なので、**専用機のログオン中に実行**（常駐スクリプトと同じ運用）。「最上位の特権で実行」は不要
- トリガー：毎週 月〜金、開始 8:00、「繰り返し間隔 1時間」「継続時間 10時間」（→ 8:00〜18:00 の毎時0分。18:00 は継続時間の端なので出ないときは 11 時間にする）。休業日の実行は止めなくてよい（取るだけで害はない）
- 操作：プログラム `py.exe`、引数 `-3.11 C:\RPA\shopify_fetch.py`、開始（任意）は `C:\RPA`
- 設定：「タスクを停止するまでの時間」30 分、「すでに実行中の場合」は「新しいインスタンスを開始しない」
- 登録後、「実行」で1回走らせ、ログに「保存しました」が出ることを確認

## 5. 困ったとき

| 症状 | 確認すること |
|---|---|
| `設定エラー: 環境変数が設定されていません` | タスクを動かすユーザーに環境変数が入っているか（別ユーザーで設定していないか） |
| `トークンを取得できませんでした` | Client ID / Secret とストア名。`同じ Shopify 組織` と出たら 1-A の制約 |
| `アクセス権限が足りません` | 1. のスコープ。スコープを変えたらアプリのバージョンを作り直して**再インストール**（固定トークンなら発行し直す） |
| `注文が0件でした` | `read_orders` の付け忘れ、または期間内に注文が無い。前回のファイルは残る |
| `Shopify Payments の情報を取得できません` | `read_shopify_payments_payouts`、Shopify Payments の有効化 |
| `HTTP 4xx`（バージョン関連） | `SHOPIFY_API_VERSION` が古くて止まっていないか |
| 429・THROTTLED が続く | 自動で待って再試行する（最大6回）。続くときは間隔をあけて実行 |

## 作りの注意（実機で確認が必要な点）

- このスクリプトは**架空のAPI応答だけでテスト**している（`tests\test_shopify_fetch.py`）。実トークンでの取得は未確認。最初の実行で、GraphQL の項目名の違い（Shopify 側のバージョンで変わる）が出たらログに「GraphQL エラー」として出る。
- エクスポートの列のうち、API から取れない列は空欄：Paid at・Fulfilled at・Accepts Marketing・Payment Reference・Risk Level・Tax 1〜5・Card Brand・Card Source・Available On・Checkout・Bank Reference など。画面が使う列（README の EC売上の行、`EC.groupShopifyOrders` / `EC.groupPayouts`）は埋まる。
- `Lineitem fulfillment status` は、その行の未出荷数が0なら `fulfilled`、そうでなければ `pending`。
- 入金の列：`Fees` は入金に含まれる手数料の合計、`Total` は入金額（通帳に入る額）。
- 取引は、入金そのもの（type=payout）・テスト取引は含めない。入金日は入金（payout）から付ける。期間より前の入金に属する取引は含めない。
- 期間の始まり付近の入金は、その入金に含まれる取引が期間より前にもあるため、取引を期間の7日前から取って揃えている。それでも最古の入金だけ「不一致」になることがあれば、`SHOPIFY_FETCH_DAYS` を増やす。
