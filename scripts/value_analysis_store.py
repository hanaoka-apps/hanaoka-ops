"""付加価値分析の非公開SQLiteストア。

データベースは ``data/`` 配下（Git管理外）に置き、ブラウザへは既存形式の
JSONだけを書き出す。月次データはUPSERTし、入力に含まれない過去月を消さない。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path


SCHEMA_VERSION = 1
TOTAL_ZONE = "__TOTAL__"
METRIC_FIELDS = (
    "sales",
    "purchase",
    "current_inventory",
    "previous_inventory",
    "inventory_change",
    "value_added",
    "value_added_rate",
    "purchase_rate",
    "inventory_contribution_rate",
)


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def migrate(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS analysis_months (
            ym TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('validated', 'partial', 'empty')),
            is_validated INTEGER NOT NULL DEFAULT 0 CHECK (is_validated IN (0, 1)),
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS analysis_metrics (
            ym TEXT NOT NULL REFERENCES analysis_months(ym),
            zone TEXT NOT NULL,
            is_total INTEGER NOT NULL DEFAULT 0 CHECK (is_total IN (0, 1)),
            sales INTEGER,
            purchase INTEGER,
            current_inventory INTEGER,
            previous_inventory INTEGER,
            inventory_change INTEGER,
            value_added INTEGER,
            value_added_rate REAL,
            purchase_rate REAL,
            inventory_contribution_rate REAL,
            PRIMARY KEY (ym, zone)
        );

        CREATE TABLE IF NOT EXISTS analysis_checks (
            ym TEXT NOT NULL REFERENCES analysis_months(ym),
            check_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT NOT NULL,
            affected_count INTEGER,
            source TEXT NOT NULL,
            PRIMARY KEY (ym, check_id)
        );

        CREATE INDEX IF NOT EXISTS idx_analysis_metrics_month
            ON analysis_metrics(ym);
        """
    )
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _month_status(month: dict, validated: bool) -> str:
    if validated:
        return "validated"
    values = [
        row.get(field)
        for row in month.get("zones", {}).values()
        for field in METRIC_FIELDS
    ]
    return "partial" if any(value is not None for value in values) else "empty"


def _metric_values(row: dict) -> tuple:
    return tuple(row.get(field) for field in METRIC_FIELDS)


def save_snapshot(path: Path, payload: dict) -> None:
    """スナップショットを履歴保持型で保存する。既存の別月は削除しない。"""

    generated_at = payload.get("meta", {}).get("generated_at", "")
    default_month = payload.get("default_month", "")
    finalized_months = set(payload.get("finalized_months", [default_month]))
    zones = payload.get("zones", [])
    monthly = payload.get("monthly", {})

    with connect(path) as connection:
        migrate(connection)
        metadata = {
            "schema_version": str(SCHEMA_VERSION),
            "default_month": default_month,
            "zones": json.dumps(zones, ensure_ascii=False),
            "meta": json.dumps(payload.get("meta", {}), ensure_ascii=False),
        }
        connection.executemany(
            """
            INSERT INTO app_meta(key, value) VALUES(?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            metadata.items(),
        )

        metric_columns = ", ".join(METRIC_FIELDS)
        metric_placeholders = ", ".join("?" for _ in METRIC_FIELDS)
        metric_updates = ", ".join(f"{field} = excluded.{field}" for field in METRIC_FIELDS)
        metric_sql = f"""
            INSERT INTO analysis_metrics(ym, zone, is_total, {metric_columns})
            VALUES(?, ?, ?, {metric_placeholders})
            ON CONFLICT(ym, zone) DO UPDATE SET
                is_total = excluded.is_total,
                {metric_updates}
        """

        for ym, month in monthly.items():
            # 月次確定は「最新表示月」と分離する。旧データ互換のため
            # finalized_months が無い場合だけ default_month を確定扱いにする。
            validated = ym in finalized_months
            connection.execute(
                """
                INSERT INTO analysis_months(ym, status, is_validated, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(ym) DO UPDATE SET
                    status = CASE
                        WHEN analysis_months.is_validated = 1 OR excluded.is_validated = 1
                        THEN 'validated'
                        ELSE excluded.status
                    END,
                    is_validated = MAX(analysis_months.is_validated, excluded.is_validated),
                    updated_at = excluded.updated_at
                """,
                (ym, _month_status(month, validated), int(validated), generated_at),
            )
            for zone in zones:
                row = month.get("zones", {}).get(zone, {})
                connection.execute(metric_sql, (ym, zone, 0, *_metric_values(row)))
            total = month.get("total", {})
            connection.execute(metric_sql, (ym, TOTAL_ZONE, 1, *_metric_values(total)))

        for ym, checks in payload.get("checks_by_month", {}).items():
            for item in checks:
                connection.execute(
                    """
                    INSERT INTO analysis_checks(
                        ym, check_id, name, status, summary, affected_count, source
                    ) VALUES(?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(ym, check_id) DO UPDATE SET
                        name = excluded.name,
                        status = excluded.status,
                        summary = excluded.summary,
                        affected_count = excluded.affected_count,
                        source = excluded.source
                    """,
                    (
                        ym,
                        item["id"],
                        item["name"],
                        item["status"],
                        item["summary"],
                        item.get("affected_count"),
                        item["source"],
                    ),
                )


def _row_to_metrics(row: sqlite3.Row | None) -> dict:
    return {field: row[field] if row is not None else None for field in METRIC_FIELDS}


def load_snapshot(path: Path) -> dict:
    """SQLiteの全月履歴を、画面が読む既存JSON形式へ戻す。"""

    with connect(path) as connection:
        migrate(connection)
        meta_rows = connection.execute("SELECT key, value FROM app_meta").fetchall()
        metadata = {row["key"]: row["value"] for row in meta_rows}
        zones = json.loads(metadata.get("zones", "[]"))
        meta = json.loads(metadata.get("meta", "{}"))
        month_rows = connection.execute(
            "SELECT ym, status, is_validated, updated_at FROM analysis_months ORDER BY ym"
        ).fetchall()
        months = [row["ym"] for row in month_rows]
        finalized_months = [row["ym"] for row in month_rows if row["is_validated"]]
        month_status = {
            row["ym"]: {
                "state": (
                    "finalized"
                    if row["is_validated"]
                    else "collecting"
                    if row["status"] == "partial"
                    else "empty"
                ),
                "is_finalized": bool(row["is_validated"]),
                "updated_at": row["updated_at"],
            }
            for row in month_rows
        }

        monthly: dict[str, dict] = {}
        for ym in months:
            rows = connection.execute(
                "SELECT * FROM analysis_metrics WHERE ym = ?", (ym,)
            ).fetchall()
            by_zone = {row["zone"]: row for row in rows}
            monthly[ym] = {
                "zones": {zone: _row_to_metrics(by_zone.get(zone)) for zone in zones},
                "total": _row_to_metrics(by_zone.get(TOTAL_ZONE)),
            }

        checks_by_month: dict[str, list[dict]] = {}
        for row in connection.execute(
            "SELECT * FROM analysis_checks ORDER BY ym, check_id"
        ):
            checks_by_month.setdefault(row["ym"], []).append(
                {
                    "id": row["check_id"],
                    "name": row["name"],
                    "status": row["status"],
                    "summary": row["summary"],
                    "affected_count": row["affected_count"],
                    "source": row["source"],
                }
            )

        return {
            "schema_version": SCHEMA_VERSION,
            "meta": meta,
            "months": months,
            "default_month": metadata.get("default_month", ""),
            "finalized_months": finalized_months,
            "month_status": month_status,
            "zones": zones,
            "monthly": monthly,
            "checks_by_month": checks_by_month,
        }
