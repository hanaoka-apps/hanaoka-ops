# 価格・送料の早見（price_check）を引き継ぐ AI への案内

このファイルは、「価格・送料の早見」の開発を引き継ぐ AI（Cowork・Claude Code・Codex など）に、最初にそのまま読ませるためのものです。
リポジトリ全体の約束は `AGENTS.md` にあります。先に `AGENTS.md`・`README.md`・`price_check_help.html` を読み、このファイルと合わせて守ってください。

- 引き継ぎ日：2026-11-12（作っていた人：福田 → 引き継ぐ人：営業部長）
- 画面：`price_check.html`（リポジトリのルート。HUB にはまだ出していない）

---

## 1. 必ず守ること

### 変更の出し方：必ず PR を作ってからマージする

1. **main に直接 push しない。** 必ずブランチを作り、プルリクエスト（PR）を作ってからマージする。
   - 作業を始めるときに `git fetch` して、`origin/main` から新しいブランチを作る。名前は `price/` で始める（例：`price/quote-form`）。
   - 1つの PR には、1つのまとまった変更だけを入れる。
   - PR の題名と説明は日本語で、専門用語を避けて書く。説明には「何を変えたか・なぜ・どう確かめたか・確かめられなかったこと」を書く。
   - PR を作ったら、PR のリンクと変更の要点を依頼者に伝え、**了承をもらってからマージする。**
   - マージの前に `origin/main` を取り込み直し、テストをもう一度通す。ほかの人の変更を消さない。main への `--force` は使わない。
   - マージは GitHub の PR から行う（`gh pr merge <番号> --merge --delete-branch`）。終わったら `git checkout main && git pull` で取り直す。
2. **PR を作る前に、テストを通す。**`node tests/test_price_core.cjs` を実行して `ok test_price_core` と出ること。計算を変えたら、テストも足す。
3. **`price_core.js` を直したら、`price_check.html` の読み込みの `?v=` を上げる**（例：`price_core.js?v=20261112g` → `20261113a`）。
4. **改行コードは元のファイルに合わせる（CRLF）。** 差分がファイル全体に出たら、改行コードが変わっている。
5. main に入った変更は、GitHub Pages ですぐ全社員の画面に出る。

### このアプリだけの決まり

- **まだ HUB に出さない。**`hub_sidebar.js` の `MENU`、`hanaoka_hub.html` のタイルには足さない（公開するかは福田が決める）。`usage_stats.html` の `APP_NAMES` には登録済み。
- **リポジトリは公開されている。** 得意先名・得意先コード・価格・掛率などの業務データを、コード・テスト・コメント・PR・コミットに書かない。見本は架空の名前と数字にする。
- **本物のデータを、一時的にでもリポジトリのフォルダに置かない。**
- **価格と送料はルールの表で決める。** AI に計算させない。画面の説明の文章も、ルールから組み立てる（`excSentence`・`clsSentence` など）。
- **単価は10円単位で丸める**（SMILE の受注伝票と合わせている。`ROUND_UNIT = 10`）。
- ルールの中身は SharePoint のリストにあり、画面から直す。**リストの作り（列や Data の項目）を変えるときは、先に依頼者に確認する。**
- サインインは共通の `hanaoka_auth.js`、見た目は `hanaoka_theme.css` の変数を使う（色を直接書かない）。
- **GSE（ソリューション営業部・空港）は対象外のまま。**
- 画面の文言・コメント・コミットは日本語で、専門用語を避ける。

---

## 2. 作りの全体

| ファイル | 役目 |
|---|---|
| `price_check.html` | 画面のすべて（HTML・CSS・JS が1つのファイル）。サインイン → データの読み込み → 各画面 |
| `price_core.js` | 計算（単価・送料・説明の文章・照合）。画面とテストで共通。`window.PriceCore` と `module.exports` の両方に出す |
| `tests/test_price_core.cjs` | 計算のテスト（架空のデータ） |
| `price_check_help.html` | 使い方のページ。画面を変えたら、ここも直す |
| `favicon_price.svg` | アイコン |

### データ

- **ルール（読み書き）**：SharePoint のリスト（SharedMasters と同じサイト。`SITE_ID` は `price_check.html` の中）。
  1行の中身は `Data` 列の JSON。ほかに `Title`・`Code`・`StartDate` 列。リストがなければ、最初の保存のときに作る。
  | キー | リスト名 | 主な項目（Data の中） |
  |---|---|---|
  | `price` | `PR_定価` | 型式・品名・定価・適用開始日・商品の種類・運賃の重量kg・重量の確からしさ・出典・メモ |
  | `cls` | `PR_得意先区分` | 対象の種類（得意先／社名）・対象コード・対象名・商品の種類・掛率・在庫口・在庫口の掛率・計算方式（通常／本部経由／運賃込み）・運賃込みの地域・適用開始日・適用終了日・要確認・メモ |
  | `exc` | `PR_例外` | 型式・対象の種類（得意先／社名／ランク／全部／未整理）・対象コード・対象名・在庫口のみ・台数以上・掛率・金額・適用開始日・適用終了日・出典・要確認・メモ |
  | `fare` | `PR_運賃` | 種類（地域／路線便／ミニ便／決まり）・地域・県・運送会社・上限・金額・適用開始日・適用終了日 |
  - 項目の定義は `price_check.html` の `LISTS`。直す画面（`openEdit`）もここから作る。
  - 全部の行に `更新者`・`更新日時` を入れる。
- **元のデータ（読むだけ）**：SharedMasters の `得意先マスタ.csv`・`品目マスタ.csv`・`受注明細出力.csv`（タブ区切り）と納品先マスタ。Graph で読み、書き換えない。

### 画面の中のおもな変数と関数（price_check.html）

- 変数：`RULES`（`{price,cls,exc,fare}`、各行は `{spId, data}`）、`CUST`・`CUSTMAP`（得意先。`{code,name,shaCode,shaName,kakeName}`）、`ITEMS`・`ITEMKEY`・`ITEMINFO`（品目マスタ）、`ORDERS`（直近の受注。GSE の印つき）、`PRICED`、`VIEWSTATE`（画面ごとの状態）
- 読み込み：`loadAll` → `loadRules`・`readList`。書き込み：`graphSend`、まとめて書くときは `batchRun`（Graph の `$batch`、20件ずつ、混んでいたら待ってやり直す）
- 画面：`renderRuleViews` がまとめて描き直す。`goView('calc'|'check'|'price'|'rank'|'cls'|'exc'|'fare'|'match'|'import')`
  - 早見：`initCalc`・`recalc`・`renderDetail`
  - ルールの状況：`renderCheckView`
  - ① 定価：`renderPriceView`・`openProduct`（改定の履歴）
  - ② ランク：`renderRankView`（SMILE の掛率名。ここでは直さない）
  - ③ 得意先の区分・④ 例外：`renderCoView('cls'|'exc')`。商社（得意先社名）ごとに畳み、条件が同じ行を1行にまとめる（`CLS_SAME`・`EXC_SAME`・`groupRows`・`coIndex`）。④ は「型式ごとに見る」で `renderExcByCode`
  - ⑤ 運賃：`renderFareView`（タイル地図 `japanMap`、運送会社の色 `CARRIER`、運賃テスト）
  - 品目マスタとの照合：`renderMatchView`・`renameCodes`・`deleteCodes`
  - 直す画面：`openEdit(key,row,{group})`。`group` を渡すと、まとめて直す（行ごとに値が違う項目は出さずに、それぞれのままにする）

### 計算の決まり（price_core.js）

- **単価**（`unitPrice`）：定価（見積日に有効な行）× 掛率 → 10円単位で丸める。掛率の決まり方は次の順で、先に当たったものを使う。
  1. ④ 例外：得意先コード → 得意先社名 → ランク → すべての得意先。同じ順位なら、在庫口だけ → 台数の条件が大きい → 新しいもの。未整理は使わない。
  2. ③ 得意先の区分：得意先コードの行 → 社名の行。商品の種類を名指しした行が「全部」より先。在庫口は得意先コードの行で決まる。
  3. ② ランク：SMILE の掛率名（`rankOf`）。
- **本部経由**：販社への見積単価 ＝ Aランク価格 ÷ 0.93（10円単位で切り上げ）、本部の受注単価 ＝ 見積単価 × 0.93（1円単位で四捨五入）。掛率が決まらないときは A（0.525）を元にする。
- **運賃込み**：決めた地域あての1台分の運賃を単価に足す。
- **旧定価**：改定のあと183日は「旧定価なら」も出す。
- **送料**（`freight`・`fareQuote`）：届け先の県 → 地域 → 運送会社。路線便は重さの合計で重量帯。400kg を超えた分は「400kg の運賃＋残りの運賃」。部品・輸入品だけで9個以下ならミニ便。オプションは本体と一緒に送る。部品のまとめ（`/P`）は人が決める。個人宅は西濃で2倍。沖縄・離島は都度見積。
- 照合：`normCode`（表記ゆれをならす）・`matchItemCode`（ok / norm / kakaku / multi / memo / unknown）・`looksLikeMemo`

---

## 3. 確かめ方

### 計算
```
node tests/test_price_core.cjs
```

### 画面（手元・見本データ）
本物のデータはリポジトリに置けないので、手元では見本データを入れて確かめる。
1. リポジトリのフォルダを配る：`python -m http.server 8792`（Claude Code なら `.claude/launch.json` の `price-check-preview`）
2. `http://localhost:8792/price_check.html` を開き、開発者ツールで見本データを入れて画面を描く：
```js
account={name:'見本 太郎',username:'demo'}; showApp();
const S=(arr,p)=>arr.map((d,i)=>({spId:p+(i+1),data:d}));
CUST=[{code:'100',name:'見本商事 東京支店',shaCode:'9001',shaName:'見本商事',kakeName:'B'}];
CUSTMAP={}; CUST.forEach(c=>CUSTMAP[c.code]=c);
ITEMS={'UDL15':'見本台車L'}; ITEMINFO={}; ITEMKEY={}; ORDERS=[];
RULES.price=S([{型式:'UDL15',品名:'見本台車L',定価:100000,適用開始日:'2025-01-01'}],'p');
RULES.cls=S([{対象の種類:'社名',対象コード:'9001',対象名:'見本商事',商品の種類:'全部',掛率:0.6,計算方式:'通常',適用開始日:'2025-01-01'}],'c');
RULES.exc=[]; RULES.fare=S([{種類:'地域',地域:'南関東',運送会社:'西濃運輸',県:'埼玉 千葉 東京 神奈川'}],'f');
updateCounts(); fillCodeList(); renderRuleViews(); goView('cls');
```
3. 保存を試すときは、書き込みをまねる（本物のリストに書かない）：
```js
findList=async()=>'L'; ensureList=async()=>'L'; readList=async k=>RULES[k];
batchRun=async reqs=>{ console.log(reqs); return {done:reqs.length,failed:[]}; };
```

### 画面（本物のデータ）
- サインイン済みのブラウザで、公開先の `https://hanaoka-apps.github.io/hanaoka-ops/price_check.html` を開いて**読むだけ**にする。保存・削除はしない。
- 出したばかりのときは、古いファイルが残っていることがある。URL に `?v=何か` を付けて開き直す。
- アプリ内のブラウザ（Claude のブラウザの画面など）は、サインインのポップアップが止められたり、個人の Microsoft アカウントに進んだりしてサインインできないことがある。そのときは Chrome など、会社のアカウントでサインインしたブラウザを使う。
- 確かめられなかったことは、そう伝える。

---

## 4. いまの状態（2026-11-12）

- 画面はひととおりできている：早見（理由・注意・前回の受注つき）、ルールの状況、① 定価、② ランク、③ 得意先の区分・④ 例外（商社ごと・まとめて直す）、⑤ 運賃（地図・運送会社の色・運賃テスト）、品目マスタとの照合、最初のデータの取り込み。
- 最初のデータは SharePoint のリストに取り込み済み（定価 1364行・得意先の区分 64行・例外 574行・運賃 250行）。
- 2026年の受注と比べて、単価は約8割、送料は自動で出せる分の約7割が一致。
- 最初のデータを作った仕組みは、福田の作業フォルダ（リポジトリの外）にある。業務データを含むので、リポジトリには持ってこない。

## 5. 次にやること

- **作る**
  - ① 定価を大分類ごとに畳む。
  - ② ランクに、その掛率の得意先を出す。
  - ③④ に「この決まりで試す」（早見を開いて試せる）を足す。
  - 見積作成・受注伝票作成につなげる（入口は案件管理 `case_management.html`。kintone の見積から移す）。
- **整える**：品目マスタとの照合を進めて、「定価なし」になる型式を減らす。③ と ④ の要確認、④ の未整理を片づける。
- **決める（依頼者に聞く）**
  - 見積書の丸めを10円にするか100円にするか（受注伝票は10円）。
  - 新定価に切り替わる時期が得意先ごとに違う件の持たせ方。
  - リストの権限（直せる人を業務センター＋営業本部に絞る）の設定。
