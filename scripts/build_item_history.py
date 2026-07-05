"""
品目コード単位の「実績&予定」インデックスを生成する。

SharedMastersから以下を読む:
  - 受入明細出力.csv         (カンマ区切り, UTF-8 BOM) -- 過去2ヶ月分が想定
  - 製造指図出力.csv     (タブ区切り, UTF-8 BOM)   -- 過去2ヶ月分が想定
  - 受注明細出力.csv         (タブ区切り, UTF-8 BOM)   -- 製番→受注№辞書用

出力:
  - data/item_history.json
  - auth_dist/item_history.json (auth_distが存在すれば自動コピー)

データ種別自動検出: 各CSVのヘッダーを見て期待列が揃っているかチェック。
([[fujin_rpa_naming_incident]] の教訓)

設計方針:
  - 品目コードでgrouping
  - 受入と製造指図は別配列で持つ (型情報を保持)
  - 製番→受注№辞書も同梱 (未確定行から受注番号を逆引きするため)
  - 日付は YYYY/MM/DD 形式に正規化
"""
import csv
import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
try:
    from zoneinfo import ZoneInfo
    _JST = ZoneInfo("Asia/Tokyo")
except Exception:
    _JST = None

# パスを動的に解決
# scripts/ に置いた場合は .parent でリポジトリルートを指す
BASE = Path(__file__).resolve().parent
if BASE.name == "scripts":
    BASE = BASE.parent
DATA = BASE / "data"
_onedrive_candidates = [
    Path.home() / "Library/CloudStorage/OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    BASE.parent / "OneDrive-花岡車輌株式会社/花岡車輌 - SharedMasters",
    BASE / "data",  # フォールバック: ローカルスナップショット / GitHub Actions
]
SHARED = next((p for p in _onedrive_candidates if p.exists()), DATA)
AUTH_DIST = BASE / "auth_dist"

# 過去2ヶ月分の窓 (実績の対象期間)
# CI(GitHub Actions)はUTCのため、JSTで「今日」を確定する(基準日/期間窓が1日ズレる事故防止)。
TODAY = (datetime.now(_JST) if _JST else datetime.now()).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
LOOKBACK_DAYS = 75  # 2ヶ月ちょっと余裕
CUTOFF_DATE = TODAY - timedelta(days=LOOKBACK_DAYS)


def _norm_date(s: str) -> str:
    """SMILE出力の日付(YYYYMMDD or YYYY/MM/DD or 空)を YYYY/MM/DD に正規化。空ならそのまま空。"""
    if not s:
        return ""
    s = str(s).strip().strip('"')
    if not s:
        return ""
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}/{s[4:6]}/{s[6:8]}"
    if "/" in s and len(s) >= 8:
        # 既に YYYY/MM/DD 形式
        parts = s.split("/")
        if len(parts) == 3:
            return f"{parts[0]:>04}/{parts[1].zfill(2)}/{parts[2].zfill(2)}"
    return s


def _parse_yyyymmdd(s: str):
    """YYYYMMDD or YYYY/MM/DD を datetime に。失敗時 None。"""
    if not s:
        return None
    s = str(s).strip().strip('"')
    try:
        if len(s) == 8 and s.isdigit():
            return datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]))
        if "/" in s:
            parts = s.split("/")
            return datetime(int(parts[0]), int(parts[1]), int(parts[2]))
    except Exception:
        return None
    return None


def _detect_delimiter(path: Path) -> str:
    """先頭1行を読んでタブとカンマの数を比較し、多い方を区切り文字として採用。
       [[fujin_rpa_naming_incident]] の教訓を反映。"""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        first = f.readline()
    tabs = first.count("\t")
    commas = first.count(",")
    return "\t" if tabs > commas else ","


def _expect_columns(headers, required, file_label):
    """期待カラムが全部入っているか検証。なければエラー。"""
    missing = [c for c in required if c not in headers]
    if missing:
        raise ValueError(
            f"[{file_label}] 期待カラムが見つかりません: {missing}\n"
            f"  → ファイル名違い or データ種別違い ([[fujin_rpa_naming_incident]] 参照)"
        )


def _sf(s) -> float:
    try:
        return float(str(s).replace(",", "").strip().strip('"'))
    except Exception:
        return 0.0


def load_receipts():
    """受入明細出力.csv を読み込み、品目コード単位にgroup化"""
    p = SHARED / "受入明細出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[受入明細] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    by_item = {}
    n_total = 0
    n_kept = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["伝票日付", "品目ｺｰﾄﾞ", "受入数量", "受注№", "製番", "手配№", "発注№"],
            "受入明細出力.csv",
        )
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("伝票日付", ""))
            if d is None or d < CUTOFF_DATE:
                continue
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            qty = _sf(row.get("受入数量"))
            entry = {
                "date": _norm_date(row.get("伝票日付", "")),
                "qty": qty,
                "unit": (row.get("発注単位") or row.get("在庫単位") or "").strip().strip('"'),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "order_no": (row.get("受注№") or "").strip().strip('"'),
                "customer_po": (row.get("客先注番") or "").strip().strip('"'),
                "tehai_no": (row.get("手配№") or "").strip().strip('"'),
                "hat_no": (row.get("発注№") or "").strip().strip('"'),
                "arrival_no": (row.get("入荷№") or "").strip().strip('"'),
                "supplier": (row.get("仕入先名略称") or row.get("仕入先名１") or "").strip().strip('"'),
                "warehouse": (row.get("倉庫名") or "").strip().strip('"'),
                "amount": _sf(row.get("受入金額")),
                "complete": (row.get("完納区分名") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    # 日付昇順
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[受入明細] 読込 {n_total}行 → 期間内 {n_kept}行, 品目数 {len(by_item)}")
    return by_item


def load_production():
    """製造指図出力.csv を読み込み、品目コード単位にgroup化。工程ごとに全展開。"""
    p = SHARED / "製造指図出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[製造指図] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    by_item = {}
    n_total = 0
    n_kept = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["手配日付", "手配№", "品目ｺｰﾄﾞ", "製番", "手配数量", "報告済数量"],
            "製造指図出力.csv",
        )
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("手配日付", ""))
            if d is None or d < CUTOFF_DATE:
                continue
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            entry = {
                "date": _norm_date(row.get("手配日付", "")),
                "tehai_no": (row.get("手配№") or "").strip().strip('"'),
                "tehai_type": (row.get("手配伝票区分名") or "").strip().strip('"'),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "route_no": (row.get("手順№") or "").strip().strip('"'),
                "process_code": (row.get("工程ｺｰﾄﾞ") or "").strip().strip('"'),
                "process_name": (row.get("工程名") or "").strip().strip('"'),
                "supplier": (row.get("手配先略称") or "").strip().strip('"'),
                "qty": _sf(row.get("手配数量")),
                "unit": (row.get("数量単位") or "").strip().strip('"'),
                "reported_qty": _sf(row.get("報告済数量")),
                "purchased_qty": _sf(row.get("仕入済数量")),
                "remaining_status": (row.get("手配残区分名") or "").strip().strip('"'),
                "force_complete": (row.get("手配強制完納区分名") or "").strip().strip('"'),
                "planned_date": _norm_date(row.get("手配予定日(年月日)", "")),
                "due_date": _norm_date(row.get("手配納期(年月日)", "")),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    # 日付昇順, 同日内は手順№昇順
    for code in by_item:
        by_item[code].sort(key=lambda x: (x["date"], x.get("route_no") or ""))
    print(f"[製造指図] 読込 {n_total}行 → 期間内 {n_kept}行, 品目数 {len(by_item)}")
    return by_item


def load_sales():
    """売上明細出力.csv から過去の出庫実績(売上=出荷)を抽出。「売上」種別で時系列に追加。
       過去2ヶ月のみ（実績ウィンドウと一致）。"""
    p = SHARED / "売上明細出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[売上明細] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    by_item = {}
    n_total = 0
    n_kept = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["伝票日付", "売上№", "品目ｺｰﾄﾞ", "数量"],
            "売上明細出力.csv",
        )
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("伝票日付", ""))
            if d is None or d < CUTOFF_DATE:
                continue
            qty = _sf(row.get("数量"))
            if qty <= 0:
                continue
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            entry = {
                "date": _norm_date(row.get("伝票日付", "")),
                "sales_no": (row.get("売上№") or "").strip().strip('"'),
                "shipment_no": (row.get("出荷№") or "").strip().strip('"'),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "customer": (row.get("得意先名略称") or "").strip().strip('"'),
                "qty": qty,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[売上明細] 読込 {n_total}行 → 期間内 {n_kept}行, 品目数 {len(by_item)}")
    return by_item


def load_sales_orders():
    """受注明細出力.csv から未完納・納期(or出荷予定日)が未来のレコードを抽出。
       「受注(出庫予定)」として時系列に追加する。"""
    p = SHARED / "受注明細出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[受注残] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    by_item = {}
    n_total = 0
    n_kept = 0
    horizon = TODAY + timedelta(days=60)  # 2ヶ月先まで (1年だとノイズ多いので絞る)
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["受注№", "納期", "品目ｺｰﾄﾞ", "数量", "完納区分名"],
            "受注明細出力.csv (受注残)",
        )
        for row in reader:
            n_total += 1
            kanno = (row.get("完納区分名") or "").strip().strip('"')
            # 完納済みは除外 (「完納」のみ、「未完納」「部分完納」は残す)
            if kanno == "完納":
                continue
            qty = _sf(row.get("数量"))
            sold = _sf(row.get("売上済数量"))
            remaining = qty - sold
            if remaining <= 0:
                continue
            # 出荷予定日 > 納期 の順に優先
            shukka = (row.get("出荷予定日") or "").strip().strip('"')
            nouki = (row.get("納期") or "").strip().strip('"')
            target_str = shukka or nouki
            d = _parse_yyyymmdd(target_str)
            if d is None:
                continue
            # 過去納期は除外 (遅延案件は別管理で扱うため)
            if d < TODAY:
                continue
            if d > horizon:
                continue
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            entry = {
                "date": _norm_date(target_str),
                "order_no": (row.get("受注№") or "").strip().strip('"'),
                "order_id": (row.get("オーダー№") or "").strip().strip('"'),
                "customer": (row.get("得意先名略称") or "").strip().strip('"'),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "qty": qty,
                "remaining_qty": remaining,
                "sold_qty": sold,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
                "due": _norm_date(nouki),
                "shipment_date": _norm_date(shukka),
                "manufacture_date": _norm_date(row.get("製造納期(年月日)", "")),
                "complete": kanno,
                "order_type": (row.get("受注区分名") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[受注残] 読込 {n_total}行 → 未完納で抽出 {n_kept}行, 品目数 {len(by_item)}")
    return by_item


def load_planned_consumption():
    """生産計画(K製番)から未来の子部品消費予定を計算する。

       雅さん 2026-05-23: 「計画が並んでいるところ、この先で消費する予定が組まれているが入っていない」

       ロジック:
         生産計画.csv: 親=K製番の予定品目、計画数量、計画日付
         構成マスタ: 親 → [(子, 取数)] (前述の load_consumption と同じBOM)
         → 計画の日付に 子部品が「消費予定」 として計上
    """
    p_bom = SHARED / "構成マスタ.csv"
    if not p_bom.exists():
        return {}
    delim_bom = _detect_delimiter(p_bom)
    bom_pc = {}
    with open(p_bom, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim_bom)
        for row in reader:
            parent = (row.get("親品目ｺｰﾄﾞ") or "").strip().strip('"')
            child = (row.get("子品目ｺｰﾄﾞ") or "").strip().strip('"')
            qty = _sf(row.get("取数(分子)"))
            if not parent or not child or qty <= 0: continue
            forbid = (row.get("使用禁止日") or "").strip().strip('"')
            if forbid:
                f_date = _parse_yyyymmdd(forbid)
                if f_date and f_date <= TODAY: continue
            key = (parent, child)
            bom_pc[key] = bom_pc.get(key, 0) + qty
    bom = {}
    for (parent, child), qty in bom_pc.items():
        bom.setdefault(parent, []).append((child, qty))

    # 生産計画を読み込み (load_production_plans と同じ条件: 未完成・未来)
    p_plan = SHARED / "生産計画出力.csv"
    horizon = TODAY + timedelta(days=60)
    by_item = {}
    n_from_plan = 0
    if p_plan.exists():
        delim_plan = _detect_delimiter(p_plan)
        with open(p_plan, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim_plan)
            for row in reader:
                d = _parse_yyyymmdd(row.get("生産計画日付", ""))
                if d is None or d < TODAY or d > horizon: continue
                parent = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
                if not parent or parent not in bom: continue
                qty = _sf(row.get("生産計画数量"))
                done = _sf(row.get("完成済数"))
                remaining = qty - done
                if remaining <= 0: continue
                status = (row.get("製番状態区分名") or row.get("製番状態区分") or "").strip().strip('"')
                if "完了" in status: continue
                seiban = (row.get("製番") or "").strip().strip('"')
                date_str = _norm_date(row.get("生産計画日付", ""))
                for (child, qty_per) in bom[parent]:
                    by_item.setdefault(child, []).append({
                        "date": date_str,
                        "parent_code": parent,
                        "parent_seiban": seiban,
                        "qty": remaining * qty_per,
                        "qty_per": qty_per,
                        "plan_status": status,
                        "source": "生産計画",
                    })
                    n_from_plan += 1

    # 未確定_購買手配 (社内工程・外注工程) の親手配からも消費予定を計算
    # 雅さん 2026-05-23: 「25日 ダンディ完組 のように、親の工程手配で子部品が消費される予定」
    p_un = SHARED / "未確定_購買手配データ.csv"
    n_from_un = 0
    if p_un.exists():
        delim_un = _detect_delimiter(p_un)
        seen_un = set()
        with open(p_un, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.DictReader(f, delimiter=delim_un)
            for row in reader:
                # 工程コードがある=工程手配(=親の組立予定)。購買データは工程コード=000000 or 空
                proc_code = (row.get("工程コード") or "").strip().strip('"')
                if not proc_code or proc_code in ("000000", "0"):
                    continue
                tehai_kind = (row.get("手配データ区分") or "").strip().strip('"')
                parent = (row.get("品目コード") or "").strip().strip('"')
                if not parent or parent not in bom: continue
                d = _parse_yyyymmdd(row.get("手配予定日（年月日）", ""))
                if d is None: continue
                # 過去は除外 (実績は消費種別で別途扱う)
                if d < TODAY: continue
                if d > horizon: continue
                qty = _sf(row.get("手配数量"))
                if qty <= 0: continue
                seiban = (row.get("内部製番") or "").strip().strip('"')
                tehai_no = (row.get("手配番号") or "").strip().strip('"')
                # 重複防止 (同じ親・製番・手配で複数行=工程展開がある)
                key = (parent, seiban, tehai_no)
                if key in seen_un: continue
                seen_un.add(key)
                date_str = _norm_date(row.get("手配予定日（年月日）", ""))
                for (child, qty_per) in bom[parent]:
                    by_item.setdefault(child, []).append({
                        "date": date_str,
                        "parent_code": parent,
                        "parent_seiban": seiban,
                        "qty": qty * qty_per,
                        "qty_per": qty_per,
                        "plan_status": tehai_kind,
                        "source": "未確定手配",
                    })
                    n_from_un += 1

    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[消費予定] 計画由来 {n_from_plan:,}件 + 未確定由来 {n_from_un:,}件 = 合計{n_from_plan+n_from_un:,}件, 対象品目 {len(by_item):,}")
    return by_item


def load_production_plans():
    """生産計画出力.csv から未完成・未来日付の計画を抽出。
       「計画(製造予定)」として時系列に追加する。"""
    p = SHARED / "生産計画出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[生産計画] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    by_item = {}
    n_total = 0
    n_kept = 0
    horizon = TODAY + timedelta(days=60)  # 受注と合わせる
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["生産計画日付", "製番", "品目ｺｰﾄﾞ", "生産計画数量", "完成済数"],
            "生産計画出力.csv",
        )
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("生産計画日付", ""))
            if d is None:
                continue
            if d < TODAY:
                continue
            if d > horizon:
                continue
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            qty = _sf(row.get("生産計画数量"))
            done = _sf(row.get("完成済数"))
            remaining = qty - done
            if remaining <= 0:
                continue
            # 状態名(製番状態区分名) を優先、無ければ区分コードを使う
            status = (row.get("製番状態区分名") or row.get("製番状態区分") or "").strip().strip('"')
            if "完了" in status:
                continue
            entry = {
                "date": _norm_date(row.get("生産計画日付", "")),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "qty": qty,
                "remaining_qty": remaining,
                "done_qty": done,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
                "status": status,
                "name": (row.get("品目名") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[生産計画] 読込 {n_total}行 → 未完成で抽出 {n_kept}行, 品目数 {len(by_item)}")
    return by_item


def load_consumption():
    """親品目の製造実績 × 構成マスタ から子部品の「消費(出庫)」を計算する。

       雅さん 2026-05-23: 「工程の順番が決まっているので、それを追う形で消費を計算できる」
       → 確認: 構成マスタの使用工程コードはほぼ「000000」(指定なし)で運用されているため、
         工程毎ではなく「(製番, 親品目)単位の最大報告済数量 × 親全体のBOM」で展開する。
         消費日は親手配の最も古い手配日付 (=最初に着手された日 ≒ 部品投入タイミング)。

       誤差注意: 廃棄・歩留まり・流用は反映されない。あくまでBOM理論値。
    """
    # 構成マスタを (親, 子) ペアで合算 (同じ親→同じ子が複数行登録されているケースが多いため)
    # 雅さん 2026-05-23: 「消費が大量に重複」報告 → (親,子) ペア集約で解消
    p_bom = SHARED / "構成マスタ.csv"
    if not p_bom.exists():
        print(f"[WARN] {p_bom.name} が見つかりません", file=sys.stderr)
        return {}
    delim_bom = _detect_delimiter(p_bom)
    bom_pc = {}  # (parent, child) -> qty_total
    n_bom_rows = 0
    with open(p_bom, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim_bom)
        for row in reader:
            parent = (row.get("親品目ｺｰﾄﾞ") or "").strip().strip('"')
            child = (row.get("子品目ｺｰﾄﾞ") or "").strip().strip('"')
            qty = _sf(row.get("取数(分子)"))
            if not parent or not child or qty <= 0:
                continue
            forbid = (row.get("使用禁止日") or "").strip().strip('"')
            if forbid:
                f_date = _parse_yyyymmdd(forbid)
                if f_date and f_date <= TODAY:
                    continue
            key = (parent, child)
            bom_pc[key] = bom_pc.get(key, 0) + qty
            n_bom_rows += 1
    # 親 → [(子, 合算取数)] のリスト形式に変換
    bom = {}
    for (parent, child), qty in bom_pc.items():
        bom.setdefault(parent, []).append((child, qty))
    print(f"[構成マスタ] {n_bom_rows:,}行 → (親,子)ユニーク {len(bom_pc):,}ペア / {len(bom):,}親品目")

    # 製造指図明細を (製番, 親) でgroup化、報告済数量の最大値を「親の完成数」とみなす
    p_pro = SHARED / "製造指図出力.csv"
    if not p_pro.exists():
        return {}
    delim_pro = _detect_delimiter(p_pro)
    # (seiban, parent) -> {qty(最大報告済), date(最古手配日), tehai_no, process_name(参考)}
    parent_completion = {}
    with open(p_pro, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim_pro)
        for row in reader:
            d = _parse_yyyymmdd(row.get("手配日付", ""))
            if d is None or d < CUTOFF_DATE:
                continue
            parent = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not parent or parent not in bom:
                continue
            reported = _sf(row.get("報告済数量"))
            if reported <= 0:
                continue
            seiban = (row.get("製番") or "").strip().strip('"')
            tehai_no = (row.get("手配№") or "").strip().strip('"')
            proc_name = (row.get("工程名") or "").strip().strip('"')
            date_str = _norm_date(row.get("手配日付", ""))
            key = (seiban, parent)
            cur = parent_completion.get(key)
            if cur is None:
                parent_completion[key] = {
                    "qty": reported,
                    "date": date_str,
                    "tehai_no": tehai_no,
                    "process_name": proc_name,
                }
            else:
                if reported > cur["qty"]:
                    cur["qty"] = reported
                # 最も古い手配日を採用 (=部品が投入された日に近い)
                if date_str and (not cur["date"] or date_str < cur["date"]):
                    cur["date"] = date_str
                    cur["tehai_no"] = tehai_no
                    cur["process_name"] = proc_name

    # 子部品視点で消費レコードを生成 (qty_per_unit はすでに集約済み)
    by_item = {}
    n_consumed = 0
    for (seiban, parent), info in parent_completion.items():
        children = bom.get(parent) or []
        for (child, qty_per) in children:
            consumed_qty = info["qty"] * qty_per
            entry = {
                "date": info["date"],
                "parent_code": parent,
                "parent_seiban": seiban,
                "parent_tehai_no": info["tehai_no"],
                "qty": consumed_qty,
                "qty_per": qty_per,
                "process_name": info["process_name"],
            }
            by_item.setdefault(child, []).append(entry)
            n_consumed += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[BOM消費] 親完成数{len(parent_completion):,}キー → 子部品消費 {n_consumed:,}件, 対象品目 {len(by_item):,}")
    return by_item


def load_purchase_orders_confirmed():
    """確定済_購買発注一覧.csv から未入荷の発注を抽出。
       「発注済」種別 = 既に発注済み・これから入荷予定 (未確定より一段確実)"""
    p = SHARED / "確定済_購買発注一覧.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    by_item = {}
    n_total = 0
    n_kept = 0
    horizon = TODAY + timedelta(days=120)  # 4ヶ月先まで
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            n_total += 1
            # 【重要】入出庫区分=1:入庫 のみ採用
            # CSV名は「確定済_購買発注一覧」だが、実際は「2:出庫」(受注の出荷指示)も混入している。
            # 雅さんとの調査 2026-05-23: SMILE発注リストで22501検索すると1件のみ、
            # CSVの「2:出庫」行はSMILE発注に実在しない不整合データ
            nyuko = (row.get("入出庫区分") or "").strip().strip('"')
            if not nyuko.startswith("1") and "入庫" not in nyuko:
                continue
            # 発注区分=1:購買発注 のみ採用 (補助チェック)
            houchu = (row.get("発注区分") or "").strip().strip('"')
            if houchu and not (houchu.startswith("1") or "購買" in houchu):
                continue
            # 完納済みを除外
            forced = (row.get("強制完納区分") or "").strip().strip('"')
            if forced and "未完" not in forced and ("完納" in forced or forced.startswith(("1", "2"))):
                continue
            # 納期 >= 今日 のみ
            d = _parse_yyyymmdd(row.get("納期日", ""))
            if d is None: continue
            if d < TODAY - timedelta(days=30): continue  # 30日以上前の未入荷は表示外(残骸)
            if d > horizon: continue
            code = (row.get("商品コード") or "").strip().strip('"')
            if not code: continue
            qty = _sf(row.get("発注数量"))
            if qty <= 0: continue
            entry = {
                "date": _norm_date(row.get("納期日", "")),
                "order_date": _norm_date(row.get("発注日", "")),
                "shipment_date": _norm_date(row.get("入出荷予定日", "")),
                "hat_no": (row.get("発注番号") or "").strip().strip('"'),
                "tehai_no": (row.get("手配番号") or "").strip().strip('"'),
                "seiban": (row.get("製　番") or row.get("製番（メイン）") or "").strip().strip('"'),
                "supplier": (row.get("仕入先略称") or "").strip().strip('"'),
                "qty": qty,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
                "customer_po": (row.get("客先注番") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[確定済発注] 読込 {n_total:,}行 → 未入荷で抽出 {n_kept:,}行, 品目数 {len(by_item):,}")
    return by_item


def load_process_orders_confirmed():
    """確定済_工程手配一覧.csv から残量あり(=未完了)の工程手配を抽出。
       「製造中」種別 = 既に着手済み・これから完成する予定"""
    p = SHARED / "確定済_工程手配一覧.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    by_item = {}
    n_total = 0
    n_kept = 0
    horizon = TODAY + timedelta(days=120)
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("手配日付（年月日）", ""))
            if d is None: continue
            if d < TODAY - timedelta(days=30): continue  # 30日以上前で残量あり=放置の可能性、出さない
            if d > horizon: continue
            code = (row.get("品目コード") or "").strip().strip('"')
            if not code: continue
            qty = _sf(row.get("手配数量"))
            reported = _sf(row.get("報告済数量"))
            remaining = qty - reported
            if remaining <= 0: continue
            entry = {
                "date": _norm_date(row.get("手配日付（年月日）", "")),
                "tehai_no": (row.get("手配番号") or "").strip().strip('"'),
                "seiban": (row.get("製番") or row.get("製　番") or "").strip().strip('"'),
                "process_code": (row.get("工程コード") or "").strip().strip('"'),
                "process_name": (row.get("工程略称") or "").strip().strip('"'),
                "supplier": (row.get("仕入先略称") or row.get("手配先略称") or "").strip().strip('"'),
                "qty": qty,
                "reported_qty": reported,
                "remaining_qty": remaining,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
            }
            by_item.setdefault(code, []).append(entry)
            n_kept += 1
    for code in by_item:
        by_item[code].sort(key=lambda x: x["date"])
    print(f"[確定済工程] 読込 {n_total:,}行 → 残量あり {n_kept:,}行, 品目数 {len(by_item):,}")
    return by_item


def load_item_names():
    """品目マスタ.csv から {品目コード: 品目名} を取得。
       構成ツリー画面の検索枠で「品目名でも検索可能」にするため。"""
    p = SHARED / "品目マスタ.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    names = {}
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            code = (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"')
            if not code:
                continue
            name = (row.get("品目名") or row.get("品目") or "").strip().strip('"')
            if name:
                names[code] = name
    print(f"[品目マスタ] {len(names):,}件の品目名マップを構築")
    return names


def load_sales_order_details():
    """受注明細出力.csv から「未完納」の受注について、受注№単位で
       ヘッダー情報・明細行・拡張項目をまとめる。受注№クリック詳細表示用。"""
    p = SHARED / "受注明細出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[受注詳細] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    details = {}  # 受注№ -> {header, lines[], extended}
    n_total = 0
    n_kept_lines = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        for row in reader:
            n_total += 1
            kanno = (row.get("完納区分名") or "").strip().strip('"')
            if kanno == "完納":
                continue
            order_no = (row.get("受注№") or "").strip().strip('"')
            if not order_no:
                continue
            qty = _sf(row.get("数量"))
            sold = _sf(row.get("売上済数量"))
            if qty - sold <= 0:
                continue
            # 初回のみヘッダー/拡張を取る (同一受注№なら同じはず)
            if order_no not in details:
                details[order_no] = {
                    "header": {
                        "order_no": order_no,
                        "order_date": _norm_date(row.get("受注日付", "")),
                        "due_date": _norm_date(row.get("納期", "")),
                        "shipment_date": _norm_date(row.get("出荷予定日", "")),
                        "manufacture_date": _norm_date(row.get("製造納期(年月日)", "")),
                        "customer_code": (row.get("得意先ｺｰﾄﾞ") or "").strip().strip('"'),
                        "customer_name": (row.get("得意先名１") or "").strip().strip('"'),
                        "customer_alias": (row.get("得意先名略称") or "").strip().strip('"'),
                        "delivery_to_code": (row.get("納品先ｺｰﾄﾞ") or "").strip().strip('"'),
                        "delivery_to_name": (row.get("納品先名") or "").strip().strip('"'),
                        "warehouse_code": (row.get("倉庫ｺｰﾄﾞ") or "").strip().strip('"'),
                        "warehouse_name": (row.get("倉庫名") or "").strip().strip('"'),
                        "staff_code": (row.get("担当者ｺｰﾄﾞ") or "").strip().strip('"'),
                        "staff_name": (row.get("担当者名") or "").strip().strip('"'),
                        "dept_code": (row.get("部門ｺｰﾄﾞ") or "").strip().strip('"'),
                        "dept_name": (row.get("部門名") or "").strip().strip('"'),
                        "customer_po": (row.get("客先注番") or "").strip().strip('"'),
                        "tax_rate": (row.get("消費税率％") or "").strip().strip('"'),
                        "deal_type": (row.get("取引区分名") or "").strip().strip('"'),
                        "order_type": (row.get("受注区分名") or "").strip().strip('"'),
                        # 操作ログ (SMILE記入者)
                        "login_id": (row.get("ﾛｸﾞｲﾝID") or "").strip().strip('"'),
                        "login_name": (row.get("ﾛｸﾞｲﾝ名") or "").strip().strip('"'),
                        "operation_date": _norm_date(row.get("操作日付", "")),
                    },
                    "lines": [],
                    "extended": {
                        "delivery_designated_date": _norm_date(row.get("配送指定日", "")),
                        "delivery_seino": (row.get("配達指定名") or "").strip().strip('"'),
                        "internal_memo": (row.get("社内メモ") or "").strip().strip('"'),
                        "office_stop_name": (row.get("営業所止め名") or "").strip().strip('"'),
                        "carrier_usage": (row.get("運送業者利用区分") or "").strip().strip('"'),
                        "tonami_delivery": (row.get("配送指定（トナミ用）") or "").strip().strip('"'),
                        "tonami_shipper_code": (row.get("トナミ荷送人コード") or "").strip().strip('"'),
                        "tonami_shipper_name": (row.get("トナミ荷送人名") or "").strip().strip('"'),
                        "daiichi_must_arrive": (row.get("必着指定(第一貨物用)") or "").strip().strip('"'),
                        "daiichi_time_class": (row.get("時間区分(第一貨物用)") or "").strip().strip('"'),
                        "bs_order_no": (row.get("BS受注№") or "").strip().strip('"'),
                    },
                }
            # 明細行を追加
            details[order_no]["lines"].append({
                "code": (row.get("品目ｺｰﾄﾞ") or "").strip().strip('"'),
                "name": (row.get("品目名") or "").strip().strip('"'),
                "model": (row.get("型番") or "").strip().strip('"'),
                "drawing_no": (row.get("図番") or "").strip().strip('"'),
                "seiban": (row.get("製番") or "").strip().strip('"'),
                "qty": qty,
                "sold_qty": sold,
                "remaining_qty": qty - sold,
                "unit": (row.get("数量単位") or "").strip().strip('"'),
                "unit_price": _sf(row.get("単価")),
                "amount": _sf(row.get("金額")),
                "complete": kanno,
                "line_due": _norm_date(row.get("納期", "")),
                "line_shipment_date": _norm_date(row.get("出荷予定日", "")),
                "line_remark": (row.get("行摘要１") or "").strip().strip('"'),
            })
            n_kept_lines += 1
    print(f"[受注詳細] 読込 {n_total}行 → 未完納明細 {n_kept_lines}行 / 受注数 {len(details)}")
    return details


def load_seiban_to_order():
    """受注明細出力.csv を読み、製番→受注№(+得意先略称, オーダー№, 納期) の辞書を作る。
       過去1年分まで遡る (実績2ヶ月＋未確定の長期分をカバー)"""
    p = SHARED / "受注明細出力.csv"
    if not p.exists():
        print(f"[WARN] {p.name} が見つかりません", file=sys.stderr)
        return {}
    delim = _detect_delimiter(p)
    print(f"[受注明細] 区切り={'TAB' if delim == chr(9) else 'CSV'}")
    long_cutoff = TODAY - timedelta(days=365)
    seiban_map = {}
    n_total = 0
    n_kept = 0
    with open(p, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f, delimiter=delim)
        _expect_columns(
            reader.fieldnames or [],
            ["受注日付", "受注№", "製番", "得意先名略称"],
            "受注明細出力.csv",
        )
        for row in reader:
            n_total += 1
            d = _parse_yyyymmdd(row.get("受注日付", ""))
            if d is None or d < long_cutoff:
                continue
            seiban = (row.get("製番") or "").strip().strip('"')
            order_no = (row.get("受注№") or "").strip().strip('"')
            if not seiban or not order_no:
                continue
            cust = (row.get("得意先名略称") or "").strip().strip('"')
            order_id = (row.get("オーダー№") or "").strip().strip('"')
            due = _norm_date(row.get("納期", ""))
            entry = {
                "order_no": order_no,
                "order_id": order_id,
                "customer": cust,
                "due": due,
                "date": _norm_date(row.get("受注日付", "")),
            }
            existing = seiban_map.get(seiban)
            if not existing:
                seiban_map[seiban] = [entry]
            else:
                # 同じ受注№なら重複しない
                if not any(e["order_no"] == order_no for e in existing):
                    existing.append(entry)
            n_kept += 1
    print(f"[受注明細] 読込 {n_total}行 → 期間内 {n_kept}行, 製番数 {len(seiban_map)}")
    return seiban_map


def main():
    print(f"[基準日] TODAY = {TODAY.strftime('%Y/%m/%d')}")
    print(f"[実績ウィンドウ] {CUTOFF_DATE.strftime('%Y/%m/%d')} 以降")
    print()

    receipts = load_receipts()
    production = load_production()
    sales = load_sales()
    consumption = load_consumption()
    sales_orders = load_sales_orders()
    production_plans = load_production_plans()
    planned_consumption = load_planned_consumption()
    purchase_orders_conf = load_purchase_orders_confirmed()
    process_orders_conf = load_process_orders_confirmed()
    sales_order_details = load_sales_order_details()
    seiban_to_order = load_seiban_to_order()
    item_names = load_item_names()

    # 全品目コードの和集合
    all_codes = (set(receipts.keys()) | set(production.keys()) | set(sales.keys())
                 | set(consumption.keys()) | set(sales_orders.keys())
                 | set(production_plans.keys()) | set(planned_consumption.keys())
                 | set(purchase_orders_conf.keys()) | set(process_orders_conf.keys()))

    items = {}
    for code in sorted(all_codes):
        items[code] = {
            "receipts": receipts.get(code, []),
            "production": production.get(code, []),
            "sales": sales.get(code, []),
            "consumption": consumption.get(code, []),
            "sales_orders": sales_orders.get(code, []),
            "production_plans": production_plans.get(code, []),
            "planned_consumption": planned_consumption.get(code, []),
            "purchase_orders_conf": purchase_orders_conf.get(code, []),
            "process_orders_conf": process_orders_conf.get(code, []),
        }

    out = {
        "as_of": TODAY.strftime("%Y/%m/%d"),
        "window_start": CUTOFF_DATE.strftime("%Y/%m/%d"),
        "items": items,
        "seiban_to_order": seiban_to_order,
        "sales_order_details": sales_order_details,
        "item_names": item_names,
    }

    DATA.mkdir(exist_ok=True)
    payload = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    # JSONとJSの両方を出す。
    #   JSON: 将来HTTP配信する場合用 (data/)
    #   JS:   file://でscriptタグ経由で読む用 (auth_dist/) -- ローカルブラウザ閲覧の本命
    json_path = DATA / "item_history.json"
    json_path.write_text(payload, encoding="utf-8")
    js_path = DATA / "item_history.js"
    js_path.write_text(f"window.ITEM_HISTORY = {payload};\n", encoding="utf-8")
    print(f"\n[出力] {json_path}  ({json_path.stat().st_size:,} bytes)")
    print(f"[出力] {js_path}  ({js_path.stat().st_size:,} bytes)")
    print(f"      品目数 {len(items)}, 製番→受注辞書 {len(seiban_to_order)}件")

    # 2026-06-10 セキュリティ移行(段階B): item_history(仕入先名・金額を含む)を
    # 公開Pages(fujin/)に置かない。auth_dist へのコピーを廃止し、代わりに
    # scripts/upload_fujin_data.py が SharePoint(SharedMasters)へアップロードする。
    # 画面側は auth_wrapper の認証fetchで window._fujinItemHistory を取得する。
    # ※ data/item_history.json は upload_fujin_data.py のアップロード元として残す。
    print("[配置] item_history は auth_dist にコピーしない(SharePoint認証配信へ移行済)")


if __name__ == "__main__":
    main()
