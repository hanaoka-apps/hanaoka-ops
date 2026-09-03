"""M365 / Microsoft Graph の共通認証・設定ローダー。

実値は環境変数または git 管理外の config.local.json から取得する。
このモジュールにはテナントID、クライアントID、シークレット、driveIdを置かない。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.parse import quote


GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default"


@dataclass(frozen=True)
class M365Settings:
    tenant_id: str
    client_id: str
    client_secret: str
    shared_masters_drive_id: str
    apps_drive_id: str = ""
    apps_base_path: str = ""

    def validate(self, *, require_secret: bool = True, require_drive: bool = True) -> None:
        missing = []
        if not self.tenant_id:
            missing.append("AZURE_TENANT_ID")
        if not self.client_id:
            missing.append("AZURE_CLIENT_ID")
        if require_secret and not self.client_secret:
            missing.append("AZURE_CLIENT_SECRET")
        if require_drive and not self.shared_masters_drive_id:
            missing.append("FUJIN_SHARED_MASTERS_DRIVE_ID")
        if missing:
            raise RuntimeError("M365設定が不足しています: " + ", ".join(missing))


def _read_local_config(path: Path) -> Mapping[str, Any]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        loaded = json.load(handle)
    if not isinstance(loaded, dict):
        raise RuntimeError(f"設定ファイルの形式が不正です: {path.name}")
    return loaded


def load_settings(
    *,
    base_dir: Optional[Path] = None,
    require_secret: bool = True,
    require_drive: bool = True,
) -> M365Settings:
    """環境変数を優先し、次に config.local.json を参照する。"""

    root = Path(base_dir or Path.cwd())
    local = _read_local_config(root / "config.local.json")
    drives = local.get("drives") if isinstance(local.get("drives"), dict) else {}
    paths = local.get("paths") if isinstance(local.get("paths"), dict) else {}

    def value(env_name: str, local_name: str) -> str:
        return str(os.environ.get(env_name) or local.get(local_name) or "").strip()

    settings = M365Settings(
        tenant_id=value("AZURE_TENANT_ID", "tenantId"),
        client_id=value("AZURE_CLIENT_ID", "clientId"),
        client_secret=value("AZURE_CLIENT_SECRET", "clientSecret"),
        shared_masters_drive_id=str(
            os.environ.get("FUJIN_SHARED_MASTERS_DRIVE_ID")
            or drives.get("sharedMasters")
            or ""
        ).strip(),
        apps_drive_id=str(
            os.environ.get("FUJIN_APPS_DRIVE_ID")
            or drives.get("appsData")
            or ""
        ).strip(),
        apps_base_path=str(
            os.environ.get("FUJIN_APPS_BASE_PATH")
            or paths.get("appsBase")
            or ""
        ).strip(),
    )
    settings.validate(require_secret=require_secret, require_drive=require_drive)
    return settings


def acquire_application_token(settings: M365Settings) -> str:
    """クライアントクレデンシャルでアプリケーショントークンを取得する。"""

    import msal

    settings.validate(require_secret=True, require_drive=False)
    app = msal.ConfidentialClientApplication(
        settings.client_id,
        authority=f"https://login.microsoftonline.com/{settings.tenant_id}",
        client_credential=settings.client_secret,
    )
    result = app.acquire_token_for_client(scopes=[GRAPH_DEFAULT_SCOPE])
    token = result.get("access_token")
    if not token:
        code = result.get("error") or "unknown_error"
        raise RuntimeError(f"M365トークン取得に失敗しました ({code})")
    return str(token)


def graph_drive_item_url(drive_id: str, item_path: str, *, content: bool = False) -> str:
    """driveIdと相対パスからGraph URLを作る。値自体はログへ出さない。"""

    clean_path = item_path.strip("/")
    encoded_path = quote(clean_path, safe="/")
    suffix = ":/content" if content else ""
    return f"https://graph.microsoft.com/v1.0/drives/{drive_id}/root:/{encoded_path}{suffix}"
