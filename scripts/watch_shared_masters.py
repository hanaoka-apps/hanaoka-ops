#!/usr/bin/env python3
"""SharedMasters の入力ファイルが差し替えられたら「FUJIN 日次ビルド」を起動する。

- 監視対象: download_shared_masters.py が読む入力ファイル(REQUIRED/OPTIONAL)と standard-cost/ フォルダ。
  ビルド自身が SharePoint に上げる出力(value_analysis.json など)や、別ジョブが頻繁に作る
  dashboard_facts.json は監視しない(ビルドが自分自身を呼び続けないように)。
- 直近の日次ビルドの開始時刻より後に更新されたファイルがあれば workflow_dispatch で起動する。
- 実行中・待機中のビルドがある場合や、直近の起動から MIN_INTERVAL_MIN 分以内の場合は起動しない。

環境変数: AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / GITHUB_TOKEN / GITHUB_REPOSITORY
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import download_shared_masters as dsm  # noqa: E402

WORKFLOW = "fujin-daily.yml"
MIN_INTERVAL_MIN = 60
NOT_WATCHED = {"value_analysis.json", "dashboard_facts.json"}
JST = timezone(timedelta(hours=9))


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def list_children(token: str, folder: str = "") -> list[dict]:
    path = f"root:/{requests.utils.quote(folder)}:" if folder else "root"
    url = f"https://graph.microsoft.com/v1.0/drives/{dsm.DRIVE_ID}/{path}/children?$select=name,lastModifiedDateTime,file&$top=999"
    out = []
    while url:
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
        if r.status_code == 404:
            return out
        r.raise_for_status()
        j = r.json()
        out += [x for x in j.get("value", []) if "file" in x]
        url = j.get("@odata.nextLink")
    return out


def watched_files(token: str) -> list[tuple[str, datetime]]:
    names = (set(dsm.REQUIRED_FILES) | set(dsm.OPTIONAL_FILES)) - NOT_WATCHED
    files = [(x["name"], parse_iso(x["lastModifiedDateTime"])) for x in list_children(token) if x["name"] in names]
    for x in list_children(token, dsm.STANDARD_COST_FOLDER):
        if dsm.STANDARD_COST_FILE.fullmatch(x["name"]) or dsm.LEGACY_STANDARD_COST_FILE.fullmatch(x["name"]):
            files.append((f"{dsm.STANDARD_COST_FOLDER}/{x['name']}", parse_iso(x["lastModifiedDateTime"])))
    return files


def main() -> int:
    repo = os.environ["GITHUB_REPOSITORY"]
    gh = {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json"}
    api = f"https://api.github.com/repos/{repo}/actions/workflows/{WORKFLOW}"
    runs = requests.get(f"{api}/runs?per_page=10", headers=gh, timeout=30)
    runs.raise_for_status()
    runs = runs.json().get("workflow_runs", [])
    if any(r["status"] in ("queued", "in_progress", "waiting", "pending", "requested") for r in runs):
        print("[skip] 日次ビルドが実行中・待機中")
        return 0
    last = max((parse_iso(r.get("run_started_at") or r["created_at"]) for r in runs), default=None)
    now = datetime.now(timezone.utc)
    if last and now - last < timedelta(minutes=MIN_INTERVAL_MIN):
        print(f"[skip] 直近のビルドから{MIN_INTERVAL_MIN}分以内 (開始 {last.astimezone(JST):%m/%d %H:%M})")
        return 0

    token = dsm.get_token(os.environ["AZURE_TENANT_ID"], os.environ["AZURE_CLIENT_ID"], os.environ["AZURE_CLIENT_SECRET"])
    changed = [(n, t) for n, t in watched_files(token) if last is None or t > last]
    if not changed:
        print(f"[ok] 差し替えなし (直近ビルド開始 {last.astimezone(JST):%m/%d %H:%M})" if last else "[ok] 差し替えなし")
        return 0
    for n, t in sorted(changed, key=lambda x: x[1]):
        print(f"[changed] {n}  {t.astimezone(JST):%m/%d %H:%M}")
    r = requests.post(f"{api}/dispatches", headers=gh, json={"ref": "main"}, timeout=30)
    if r.status_code not in (201, 204):
        print(f"[error] 起動失敗 HTTP {r.status_code}: {r.text[:300]}")
        return 1
    print(f"[dispatch] 日次ビルドを起動しました ({len(changed)}件の差し替え)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
