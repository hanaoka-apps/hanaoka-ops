<#
.SYNOPSIS
  営業日報ダッシュボードの「🔄 再集計をリクエスト」ボタンを監視し、
  SMILE再出力 → dashboard_facts.json再生成 を自動実行する常駐スクリプト。

.DESCRIPTION
  SharedMasters (このPCにOneDrive同期されているフォルダ) に
  _regenerate_request.json が現れたら、
    ① 既存のSMILE受注/売上明細出力処理を実行 (Invoke-SmileExport /
       環境変数 SMILE_EXPORT_COMMAND の実行コマンドをこのPCで設定しておくこと)
    ② GitHubから最新の regenerate_facts.py を取得して実行
    ③ 合図ファイルを削除
  の順に行う。OSのファイル変更通知(FileSystemWatcher)に加えて、30秒ごとに
  合図ファイルの有無も確認する(OneDrive同期で届いたファイルは通知が来ない
  ことがあるため)。待機中の負荷はほぼない。

  タスクスケジューラーには「ログオン時」または「スタートアップ時」に
  このスクリプトを1回起動するトリガーで登録する(このプロセスは
  ずっと常駐し続ける。5分おきに再実行するタスクにはしないこと)。

.NOTES
  実行前に必ず以下を確認・設定すること。

  1. $SharedMastersPath が実際の同期パスと合っているか確認する。

  2. 環境変数 SMILE_EXPORT_COMMAND に、SMILE受注/売上明細出力を実行する
     コマンドをこのPCのユーザー環境変数として設定しておく
     (システムのプロパティ → 環境変数、または setx コマンド)。
     例1: setx SMILE_EXPORT_COMMAND "C:\Program Files (x86)\Power Automate Desktop\PAD.Console.Host.exe -run \"フロー名\""
     例2: setx SMILE_EXPORT_COMMAND "C:\path\to\smile_export.bat"
     このスクリプト自体はGitHub Pagesで配信されるリポジトリの一部として
     複数PC・複数環境で使われうるため、特定のPCでしか通用しないパスを
     スクリプトに直接書き込まない。PCごとに違う値を環境変数側で持たせる。

  3. regenerate_facts.py は SHARED_MASTERS_DIR=$SharedMastersPath で実行し、
     同期フォルダのCSVを直接読んでJSONも同じフォルダに書き出す
     (アップロードはOneDrive同期に任せる)。そのため AZURE_* の環境変数は不要。

  4. python (3.11目安) と pip install requests が
     このPCで実行できる状態になっていること。
#>

$ErrorActionPreference = 'Stop'

# ===== 設定 (環境に合わせて書き換える) =====
$SharedMastersPath = "$env:USERPROFILE\OneDrive - 花岡車輌 株式会社\花岡車輌 - SharedMasters"
$RequestFileName   = '_regenerate_request.json'
$LogPath           = "$env:USERPROFILE\regenerate_watcher.log"
$RepoRawBase       = 'https://raw.githubusercontent.com/hanaoka-apps/hanaoka-ops/main'
$WorkDir           = "$env:TEMP\hanaoka-regenerate-watcher"

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $LogPath -Value $line
}

function Invoke-SmileExport {
  Write-Log 'SMILE出力を開始します'
  $cmd = $env:SMILE_EXPORT_COMMAND
  if ([string]::IsNullOrWhiteSpace($cmd)) {
    throw '環境変数 SMILE_EXPORT_COMMAND が設定されていません(このPCでのSMILE出力の実行コマンドを設定してください)'
  }
  # PAD起動・バッチファイルどちらでもそのままコマンドラインとして実行できるよう、
  # cmd.exe 経由で呼び出す(引用符付きパス・引数もこの形なら書き換え不要)。
  & cmd.exe /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "SMILE出力が終了コード $LASTEXITCODE で失敗しました" }
  Write-Log 'SMILE出力が完了しました'
}

function Invoke-RegenerateFacts {
  Write-Log 'regenerate_facts.py を取得して実行します'
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  # 毎回別名で取得する。同じ名前に上書きすると、前回のファイルをウイルス対策の
  # スキャンなどが開いていた場合に「別のプロセスで使用されている」で失敗する。
  $scriptPath = Join-Path $WorkDir ('regenerate_facts_{0:yyyyMMdd_HHmmss}.py' -f (Get-Date))
  try {
    # 常に最新版を取得してから実行する(手元に古いコピーを置いて動かさない)
    Invoke-WebRequest -Uri "$RepoRawBase/scripts/regenerate_facts.py" -OutFile $scriptPath -UseBasicParsing
    # Graph APIではなく、このPCに同期済みの SharedMasters を直接読み書きする
    # (CSVのクラウド同期待ちが不要になり、AZURE_* の設定もいらない)
    $env:SHARED_MASTERS_DIR = $SharedMastersPath
    python $scriptPath
    if ($LASTEXITCODE -ne 0) { throw "regenerate_facts.py が終了コード $LASTEXITCODE で失敗しました" }
  } finally {
    Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
  }
}

function Process-Request {
  param([string]$FilePath)
  try {
    $content = Get-Content -Path $FilePath -Raw | ConvertFrom-Json
    Write-Log "再集計リクエストを検知: requestedBy=$($content.requestedBy) requestedAt=$($content.requestedAt)"
    Invoke-SmileExport
    Invoke-RegenerateFacts
    Write-Log '再集計が完了しました'
  } catch {
    Write-Log "エラー: $($_.Exception.Message)"
  } finally {
    Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue
  }
}

$requestFilePath = Join-Path $SharedMastersPath $RequestFileName

# 起動時にすでにリクエストが残っていれば先に処理する
if (Test-Path $requestFilePath) {
  Process-Request -FilePath $requestFilePath
}

Write-Log "監視を開始します: $SharedMastersPath"
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $SharedMastersPath
$watcher.Filter = $RequestFileName
$watcher.IncludeSubdirectories = $false

$isProcessing = $false
while ($true) {
  # OSのファイル変更通知を待つ。OneDriveは同期したファイルを一時ファイルからの
  # リネームで置くことがあるため Renamed も待つ。
  # ただしRPA用PCの実機では、OneDrive同期で届いた合図ファイルの通知は一度も
  # 届かなかった。そのためタイムアウトを30秒にして、タイムアウト時にも合図
  # ファイルの有無を確認する(存在確認だけなので負荷はほぼない)。
  $result = $watcher.WaitForChanged(
    [System.IO.WatcherChangeTypes]::Created -bor [System.IO.WatcherChangeTypes]::Changed -bor [System.IO.WatcherChangeTypes]::Renamed,
    30000
  )
  if ($isProcessing) { continue }

  # OneDriveの同期がファイル書き込み完了直後だと不安定なことがあるため少し待つ
  if (-not $result.TimedOut) { Start-Sleep -Seconds 2 }
  if (-not (Test-Path $requestFilePath)) { continue }

  $isProcessing = $true
  try {
    Process-Request -FilePath $requestFilePath
  } finally {
    $isProcessing = $false
  }
}
