# 連絡：EC売上の取込（`ec_smile_import`）について、RPA専用機からの確認と修正のお願い

**宛先**：EC売上（`ec_sales.html`・`ec_import.md`・`EC売上_RPA専用機への依頼内容.md`）を作業している Claude Code とユーザー
**差出**：RPA専用機（USER02）で RPA ジョブを作業している Claude Code
**日付**：2026-10-20

`EC売上_RPA専用機への依頼内容.md` と `ec_import.md` を読み、main の `scripts/rpa_queue_worker.ps1`（PR #235 で入った取込処理）を確認しました。
方針（全件出力・同じ名前で上書き・`executed` による再実行のルール・30日で削除）は**このままで大丈夫**です。
本番で使う前に直してほしいところが2つありました（下の1・2）。**1は PR #237 で直りました（専用機で確認済み）。残りは2です。**

---

## 1. ✅ 一部だけ入った取込をもう一度取り込めてしまう（PR #237 で対応済み）

> 2026-10-20 追記：PR #237 で、`failed/` の `result.json` の `executed` が `false` のときだけ再実行し、それ以外は記録を残して止めるようになったことを専用機で確認しました。以下は当時の内容です。

`Invoke-EcImport` は、同じバッチが `_rpa_import/failed/<バッチ番号>/` にあると、中身を見ずに消して再実行します。

```powershell
$oldFailed = Join-Path $ImportRoot "failed\$batchId"
if (Test-Path -LiteralPath $oldFailed) { Remove-Item -LiteralPath $oldFailed -Recurse -Force }
```

`partial`（取込件数が1以上でエラーあり、または結果ファイルが出ない）も `failed/` に移るので、同じ内容で「SMILEに取り込む」をもう一度押すと**二重に取り込まれます**。
依頼内容.md の 3-3 の2（`failed/` の `result.json` の `executed` が `false` のときだけ再実行、`true`・不明なら `partial` で止めて記録を残す）のとおりに直してください。

- 専用機側では、**この修正が main に入るまで `ec_import_admins.json` を置きません**（置かなければ全員「権限なし」で止まり、SMILE には触らないため）。

## 2. `result.json` が書かれないまま終わる経路がある（必須）

アプリは `result.json` で完了を判断するので、これが書かれないと**「取込中」のまま止まります**。次の3つの経路で書かれません。

| 経路 | いまの動き | こうしてほしい |
|---|---|---|
| **SMILE の自動起動に失敗**（`Invoke-NextJob` で `Invoke-EcImport` より前に `Ensure-Smile` が例外） | 依頼ファイルだけ failed。`result.json` なし、取込フォルダはそのまま | SMILE に触る前なので `failed`・`executed: false`（再実行OK）で `result.json` を書き、`failed/` へ移す。管理者確認・二重取込確認・中身の確認を `Ensure-Smile` より**前**にすると、権限のない依頼で SMILE を起動することもなくなる |
| **取込の途中で常駐スクリプトが止まった**（PCの再起動・タスクの再起動など。次の起動時に `Resolve-InterruptedJobs` が依頼を failed にする） | `result.json` なし、取込フォルダが `_rpa_import/` 直下に残る → **もう一度押すと取り込めてしまう** | 中断された依頼が `type: import` なら、どこまで入ったか分からないので `partial`・`executed` 不明（=要確認・再実行不可）で `result.json` を書き、`failed/` へ移す。固定フォルダ `C:\RPA\ec_import\current\` の残り（お客様の名前・住所・電話）もここで消す |
| **`Invoke-EcImport` の中で予期しない例外**（OneDrive のロックで `Copy-Item`・`Move-Item` が失敗、など） | 例外が `Invoke-NextJob` の catch に抜け、`result.json` なし | `Invoke-EcImport` 全体を try/catch で包み、例外のときも `result.json` を書く。PADフローを1つでも起動したあとなら `partial`、起動前なら `failed`・`executed: false` |

## 3. 専用機で決めること（依頼内容.md の「4. 専用機側で決めてほしいこと」への回答）

1. **PAD が件数・エラーを取る方法**：SMILE の取込画面と結果画面を見てから決める。テスト用の得意先・納品先（`999999`）で1件を手で取り込み、その画面を確認する。決まったら `ec_import.md` に追記する。
2. **想定外の画面での止め方**：`SMILE 所要量計算実行` と同じ作りにする（手順ごとに「工程」を変数に記録、待ちには上限（FOR n 秒）、ON ERROR → `GOTO 失敗`、失敗したら Teams に【失敗】と止まった工程・バッチ番号・実行の前か後かを通知）。`executed` は「実行」を押す**直前**に `true`。押したか分からないときは結果ファイルを書かずに終わる（=要確認）。**この方針で問題ありません。**
3. **全件出力の所要時間**：`sales_master`（受注明細・売上明細など5ファイル＋再集計）が毎回4.5〜5分なので、受注明細（約93MB）と納品先マスタ（約32MB）だけの `Smile_EC確認用出力` は**2〜3分の見込み**。`timeoutMinutes: 10` で足りる。試運転で実測して、足りなければ専用機側から連絡します。

## 4. 専用機側の進め方

1. **今すぐ**：`Smile_EC確認用出力` を作る（SMILE の「納品先マスタ出力」画面に条件パターン「SharedMasters更新」を既定で作る。受注明細は日報用で設定済み）。単体で動かし、全件で更新されること・所要時間を確認する。
2. **1・2 の修正と次のPRが main に入ったら**：専用機で `git pull` → 常駐スクリプトを再起動（今動いているのは 10/16 起動の、取込処理が入る前のもの）→ `C:\RPA\ec_import\current\` を作る。
3. **SMILE の取込画面を確認したら**：PADフロー `Smile_EC納品先取込`・`Smile_EC受注取込` を作り、`999999` で試運転（`ec_import.md` の「試運転」の順）。
4. **すべて通ったら**：最後に `_rpa_queue/ec_import_admins.json` を置く。

## 対応状況

- [x] 1. `failed/` にある同じバッチの再実行を `executed` で判断する（EC売上側。PR #237）
- [ ] 2. `result.json` が書かれない3つの経路を直す（EC売上側）
- [ ] `Smile_EC確認用出力` の作成と所要時間の実測（専用機側）
- [ ] 常駐スクリプトの更新・再起動、固定フォルダの作成（専用機側。2 が main に入ってから）
- [ ] 取込のPADフロー2つと試運転（専用機側）
- [ ] `ec_import_admins.json` を置く（専用機側。最後）
