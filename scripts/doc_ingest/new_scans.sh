#!/usr/bin/env bash
# ------------------------------------------------------------
# スキャンフォルダの「まだ取り込んでいないPDF」を出す
#
# 状態ファイルは持たない。原本フォルダに同じファイル名があるか
# どうかだけで判定する。状態ファイルは壊れる・ズレる・消える。
# 「置いてあるかどうか」は嘘をつかない。
#
#   使い方:  bash new_scans.sh            … 新着の一覧
#            bash new_scans.sh --count    … 件数だけ
# ------------------------------------------------------------
set -u

# スキャンフォルダの場所は scan_dir.local に書く（.gitignore 済み）。
# このリポジトリは公開されているので、社内ファイルサーバのパスは置かない。
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONF="$HERE/scan_dir.local"

SCAN_DIR="${DOC_SCAN_DIR:-}"
if [ -z "$SCAN_DIR" ] && [ -f "$CONF" ]; then
  SCAN_DIR=$(grep -v '^[[:space:]]*#' "$CONF" | grep -v '^[[:space:]]*$' | head -1)
fi

if [ -z "$SCAN_DIR" ]; then
  echo "[ERROR] スキャンフォルダの場所が設定されていません。" >&2
  echo "        $CONF に1行でパスを書いてください。例:" >&2
  echo "          //<サーバ>/<共有>/総務スキャン/<担当>" >&2
  echo "        または環境変数 DOC_SCAN_DIR で渡してください。" >&2
  exit 1
fi

FILED_DIR="$HOME/OneDrive - 花岡車輌 株式会社/Executive Workspace - ドキュメント/書類管理/原本"

if [ ! -d "$SCAN_DIR" ]; then
  echo "[ERROR] スキャンフォルダに到達できません: $SCAN_DIR" >&2
  echo "        ファイルサーバに繋がっているか確認してください。" >&2
  exit 1
fi

# 既に取り込み済みのファイル名（年フォルダをまたいで集める）
filed=$(find "$FILED_DIR" -type f -iname '*.pdf' -printf '%f\n' 2>/dev/null | sort -u)

new=()
while IFS= read -r -d '' f; do
  base=$(basename "$f")
  if ! grep -qxF "$base" <<< "$filed"; then
    new+=("$f")
  fi
done < <(find "$SCAN_DIR" -maxdepth 1 -type f -iname '*.pdf' -print0 2>/dev/null | sort -z)

if [ "${1:-}" = "--count" ]; then
  echo "${#new[@]}"
  exit 0
fi

if [ "${#new[@]}" -eq 0 ]; then
  echo "新しい書類はありません。"
  exit 0
fi

echo "未取込の書類 ${#new[@]}件:"
for f in "${new[@]}"; do
  printf '  %s  (%s, %s)\n' "$(basename "$f")" \
    "$(du -h "$f" | cut -f1)" \
    "$(date -r "$f" '+%Y-%m-%d %H:%M')"
done
