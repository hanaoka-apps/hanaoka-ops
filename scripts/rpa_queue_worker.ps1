<#
.SYNOPSIS
  RPA専用機の常駐スクリプト。SharedMasters\_rpa_queue に置かれたRPAの依頼を、
  古い順に1件ずつ実行する。

.DESCRIPTION
  依頼ファイル(アプリが rpa_queue.js で置く):
    _rpa_queue\pending\<UTC日時>_<ジョブ名>_<乱数>.json
    { "job": "sales_master", "requestedBy": "...", "requestedAt": "ISO8601", "app": "..." }

  処理の流れ:
    pending → running(実行中) → done(成功) / failed(失敗)
    フォルダを移す前に、依頼ファイルへ status / startedAt / finishedAt / error を書き込む。
    アプリはフォルダと中身を見て、順番待ち・実行中・完了・失敗を表示する。

  ジョブの中身は scripts/rpa_jobs.json (毎回GitHubのmainから取得) で決める:
    PADフローをURIで起動 → outputs のファイルがすべて更新されるまで待つ → after の処理
    (URIで起動したPADフローは完了を待たずに戻るため、出力ファイルで完了を判断する)

  PADは同時に1つのフローしか動かせないので、1件ずつ順番に処理する。
  同じジョブの依頼が複数待っていたら、まとめて1回だけ実行する。

  旧方式の合図ファイル(SharedMasters\_regenerate_request.json)も sales_master の
  依頼として受け付ける。旧方式の画面は合図ファイルが消えたら完了とみなすので、
  合図ファイルはジョブが終わってから消す。

  OneDrive同期で届いたファイルはファイル変更通知(FileSystemWatcher)が来ないことが
  あるため、30秒ごとにフォルダを確認する(存在確認だけなので負荷はほぼない)。

  タスクスケジューラーには「ログオン時」に1回だけ起動するトリガーで登録する
  (watch_regenerate_request.ps1 経由。このプロセスはずっと常駐し続ける)。

.NOTES
  - $SharedMastersPath が実際の同期パスと合っていること。
  - python (3.11目安) と pip install requests が実行できること。
  - regenerate_facts.py は SHARED_MASTERS_DIR=$SharedMastersPath で実行し、同期フォルダの
    CSVを直接読んでJSONも同じフォルダに書き出す(アップロードはOneDrive同期に任せる)。
    そのため AZURE_* の環境変数は不要。
  - Windows PowerShell 5.1 で日本語を正しく読めるよう、このファイルはBOM付きUTF-8で保存する。
#>

$ErrorActionPreference = 'Stop'

# ===== 設定 (環境に合わせて書き換える) =====
$SharedMastersPath = "$env:USERPROFILE\OneDrive - 花岡車輌 株式会社\花岡車輌 - SharedMasters"
$QueueRoot         = Join-Path $SharedMastersPath '_rpa_queue'
$PendingDir        = Join-Path $QueueRoot 'pending'
$RunningDir        = Join-Path $QueueRoot 'running'
$DoneDir           = Join-Path $QueueRoot 'done'
$FailedDir         = Join-Path $QueueRoot 'failed'
$LegacyRequestPath = Join-Path $SharedMastersPath '_regenerate_request.json'
$LogPath           = "$env:USERPROFILE\regenerate_watcher.log"
$RepoRawBase       = 'https://raw.githubusercontent.com/hanaoka-apps/hanaoka-ops/main'
$WorkDir           = "$env:TEMP\hanaoka-regenerate-watcher"
$PollSeconds       = 30
# done / failed の記録を残す日数
$KeepDays          = 30
# 依頼ファイルが読めない(同期途中など)状態が続いたら失敗扱いにするまでの回数
$MaxBadReads       = 3

$script:BadReads = @{}

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $LogPath -Value $line
}

function Read-JsonFile([string]$Path) {
  return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Object) {
  # アプリ(ブラウザ)が読むのでBOMなしUTF-8で書く
  $json = $Object | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Set-Props($Object, [hashtable]$Props) {
  foreach ($k in $Props.Keys) {
    $Object | Add-Member -NotePropertyName $k -NotePropertyValue $Props[$k] -Force
  }
}

# 依頼ファイルに状態を書き込んでから、別のフォルダへ移す。移した先のパスを返す。
function Move-QueueItem([string]$Path, [string]$ToDir, [hashtable]$Props, $Request = $null) {
  if (-not $Request) {
    try { $Request = Read-JsonFile $Path } catch { $Request = [pscustomobject]@{} }
  }
  Set-Props $Request $Props
  Write-JsonFile $Path $Request
  $dest = Join-Path $ToDir (Split-Path -Leaf $Path)
  Move-Item -LiteralPath $Path -Destination $dest -Force
  return $dest
}

# ジョブ定義は常にGitHubのmainから取得する(ジョブの追加はPRのマージだけで反映される)。
# 取得できないときは、このスクリプトと同じフォルダの rpa_jobs.json を使う。
function Get-JobDefinitions {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $path = Join-Path $WorkDir ('rpa_jobs_{0:yyyyMMdd_HHmmss}.json' -f (Get-Date))
  try {
    Invoke-WebRequest -Uri "$RepoRawBase/scripts/rpa_jobs.json" -OutFile $path -UseBasicParsing
    return (Read-JsonFile $path)
  } catch {
    Write-Log "ジョブ定義をGitHubから取得できないため、手元の rpa_jobs.json を使います: $($_.Exception.Message)"
    return (Read-JsonFile (Join-Path $PSScriptRoot 'rpa_jobs.json'))
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Test-FileReadable([string]$Path) {
  # 書き込み中(他プロセスが書き込みロック中)なら開けない
  try {
    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'Read')
    $fs.Close()
    return $true
  } catch {
    return $false
  }
}

# PADフローをURIで起動し、outputs のファイルがすべて起動後に更新され、
# サイズが安定し、書き込み中でなくなるまで待つ。
function Invoke-PadFlow($Def) {
  $flow = [string]$Def.flow
  $outputs = @($Def.outputs)
  if (-not $flow) { throw 'ジョブ定義に flow がありません' }
  if ($outputs.Count -eq 0) { throw 'ジョブ定義に outputs がありません(完了を判断できないため)' }
  $timeoutMinutes = 20
  if ($Def.timeoutMinutes) { $timeoutMinutes = [int]$Def.timeoutMinutes }

  # ファイルの更新日時は秒未満が丸められることがあるため、少し前を基準にする
  $startedAt = (Get-Date).AddSeconds(-2)
  Write-Log "PADフローを起動します: $flow"
  Start-Process ('ms-powerautomate:/console/flow/run?workflowName=' + [uri]::EscapeDataString($flow))

  $deadline = (Get-Date).AddMinutes($timeoutMinutes)
  $lastSnapshot = $null
  $stableCount = 0
  $pending = @()
  $locked = @()
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $pending = @()
    $snapshot = @()
    foreach ($name in $outputs) {
      $item = Get-Item -LiteralPath (Join-Path $SharedMastersPath $name) -ErrorAction SilentlyContinue
      if (-not $item -or $item.LastWriteTime -lt $startedAt) { $pending += $name; continue }
      $snapshot += "$name|$($item.Length)|$($item.LastWriteTime.Ticks)"
    }
    if ($pending.Count -gt 0) { $stableCount = 0; $lastSnapshot = $null; continue }

    # サイズ・更新日時が30秒(3回)変わらず、書き込み中でなければ完了
    $current = $snapshot -join ';'
    if ($current -eq $lastSnapshot) { $stableCount++ } else { $stableCount = 0 }
    $lastSnapshot = $current
    if ($stableCount -ge 3) {
      $locked = @($outputs | Where-Object { -not (Test-FileReadable (Join-Path $SharedMastersPath $_)) })
      if ($locked.Count -eq 0) {
        Write-Log "PADフローの出力を確認しました: $($outputs -join ', ')"
        return
      }
      $stableCount = 0
    }
  }
  throw ("PADフローの出力が{0}分以内に完了しませんでした(未更新/書き込み中: {1})" -f $timeoutMinutes, (($pending + $locked) -join ', '))
}

function Invoke-RegenerateFacts {
  Write-Log 'regenerate_facts.py を取得して実行します'
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  # 毎回別名で取得する。同じ名前に上書きすると、前回のファイルをウイルス対策の
  # スキャンなどが開いていた場合に「別のプロセスで使用されている」で失敗する。
  $stamp = '{0:yyyyMMdd_HHmmss}' -f (Get-Date)
  $scriptPath = Join-Path $WorkDir "regenerate_facts_$stamp.py"
  $outPath = Join-Path $WorkDir "regenerate_facts_$stamp.out.txt"
  $errPath = Join-Path $WorkDir "regenerate_facts_$stamp.err.txt"
  try {
    # 常に最新版を取得してから実行する(手元に古いコピーを置いて動かさない)
    Invoke-WebRequest -Uri "$RepoRawBase/scripts/regenerate_facts.py" -OutFile $scriptPath -UseBasicParsing
    $env:SHARED_MASTERS_DIR = $SharedMastersPath
    # 出力先が画面でないとPythonはcp932で書き出し、絵文字の表示で止まるためUTF-8にする
    $env:PYTHONIOENCODING = 'utf-8'
    $proc = Start-Process -FilePath 'python' -ArgumentList ('"{0}"' -f $scriptPath) -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    if ($proc.ExitCode -ne 0) {
      # 原因を追えるよう、Pythonのエラー出力の最後をログに残す
      $tail = @(Get-Content -LiteralPath $errPath -Tail 8 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' / '
      Write-Log "regenerate_facts.py のエラー出力: $tail"
      throw "regenerate_facts.py が終了コード $($proc.ExitCode) で失敗しました"
    }
  } finally {
    Remove-Item -LiteralPath $scriptPath, $outPath, $errPath -Force -ErrorAction SilentlyContinue
  }
}

# 旧方式の合図ファイルを sales_master の依頼に変換する(合図ファイル自体はジョブ完了まで残す)
function Convert-LegacyRequest {
  if (-not (Test-Path -LiteralPath $LegacyRequestPath)) { return }
  $tracked = @(Get-ChildItem -LiteralPath $PendingDir, $RunningDir -Filter '*_legacy.json' -File -ErrorAction SilentlyContinue)
  if ($tracked.Count -gt 0) { return }
  try { $legacy = Read-JsonFile $LegacyRequestPath } catch { return }  # 同期途中なら次回
  $name = '{0}_sales_master_legacy.json' -f (Get-Date).ToUniversalTime().ToString('yyyyMMdd\THHmmssfff\Z')
  Write-JsonFile (Join-Path $PendingDir $name) ([pscustomobject]@{
    job = 'sales_master'
    requestedBy = [string]$legacy.requestedBy
    requestedAt = [string]$legacy.requestedAt
    app = '旧方式の合図ファイル'
    legacyRequestedAt = [string]$legacy.requestedAt
  })
  Write-Log "旧方式の再集計リクエストを受け付けました: requestedBy=$($legacy.requestedBy) requestedAt=$($legacy.requestedAt)"
}

# 実行中に新しい旧方式リクエストが来ていたら消さない(次の依頼として残す)
function Remove-LegacyRequestIfDone([string]$LegacyRequestedAt) {
  if (-not (Test-Path -LiteralPath $LegacyRequestPath)) { return }
  try { $legacy = Read-JsonFile $LegacyRequestPath } catch { return }
  if ([string]$legacy.requestedAt -eq $LegacyRequestedAt) {
    Remove-Item -LiteralPath $LegacyRequestPath -Force -ErrorAction SilentlyContinue
  }
}

# 待っている依頼を1件(同じジョブはまとめて)実行する。実行したら $true を返す。
function Invoke-NextJob {
  $found = @(Get-ChildItem -LiteralPath $PendingDir -Filter '*.json' -File)
  if ($found.Count -eq 0) { return $false }
  # 名前順＝依頼順。アプリ(rpa_queue.js)の順番表示と合わせるため、文字コード順で並べる
  # (Sort-Object は言語設定に依存した並べ方になるため使わない)
  $names = [string[]]@($found | ForEach-Object { $_.Name })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $items = @(foreach ($n in $names) { $found | Where-Object { $_.Name -eq $n } })

  # 先頭の依頼を読む。同期途中などで読めなければ数回待ってから失敗扱いにする
  $first = $items[0]
  try {
    $firstRequest = Read-JsonFile $first.FullName
    $script:BadReads.Remove($first.Name)
  } catch {
    $script:BadReads[$first.Name] = 1 + [int]$script:BadReads[$first.Name]
    if ($script:BadReads[$first.Name] -lt $MaxBadReads) { return $false }
    $script:BadReads.Remove($first.Name)
    Write-Log "依頼ファイルを読めないため失敗扱いにします: $($first.Name)"
    Move-QueueItem $first.FullName $FailedDir @{ status = 'failed'; finishedAt = (Get-Date).ToString('o'); error = '依頼ファイルを読めませんでした' } ([pscustomobject]@{}) | Out-Null
    return $true
  }
  $jobName = [string]$firstRequest.job

  # 同じジョブの依頼をまとめて実行中にする
  $batch = @()
  foreach ($item in $items) {
    try { $req = Read-JsonFile $item.FullName } catch { continue }
    if ([string]$req.job -eq $jobName) { $batch += [pscustomobject]@{ Path = $item.FullName; Request = $req } }
  }
  $startedAt = (Get-Date).ToString('o')
  $running = @()
  foreach ($b in $batch) {
    $path = Move-QueueItem $b.Path $RunningDir @{ status = 'running'; startedAt = $startedAt; batchSize = $batch.Count } $b.Request
    $running += [pscustomobject]@{ Path = $path; Request = $b.Request }
  }
  $requesters = ($batch | ForEach-Object { $_.Request.requestedBy } | Select-Object -Unique) -join ', '
  Write-Log "ジョブを開始します: $jobName (依頼 $($batch.Count) 件 / $requesters)"

  $errorMessage = $null
  try {
    $def = (Get-JobDefinitions).jobs.$jobName
    if (-not $def) { throw "未定義のジョブです: $jobName" }
    if ($def.after -and $def.after -ne 'regenerate_facts') { throw "未対応の後処理です: $($def.after)" }
    Invoke-PadFlow $def
    if ($def.after -eq 'regenerate_facts') { Invoke-RegenerateFacts }
  } catch {
    $errorMessage = $_.Exception.Message
  }

  $finishedAt = (Get-Date).ToString('o')
  foreach ($r in $running) {
    if ($errorMessage) {
      Move-QueueItem $r.Path $FailedDir @{ status = 'failed'; finishedAt = $finishedAt; error = $errorMessage } $r.Request | Out-Null
    } else {
      Move-QueueItem $r.Path $DoneDir @{ status = 'done'; finishedAt = $finishedAt } $r.Request | Out-Null
    }
    if ($r.Request.legacyRequestedAt) { Remove-LegacyRequestIfDone ([string]$r.Request.legacyRequestedAt) }
  }
  if ($errorMessage) { Write-Log "エラー: ジョブ $jobName が失敗しました: $errorMessage" }
  else { Write-Log "ジョブが完了しました: $jobName" }
  return $true
}

# 前回、実行中のまま止まった依頼は失敗扱いにする(どこまで進んだか分からないため)
function Resolve-InterruptedJobs {
  foreach ($item in @(Get-ChildItem -LiteralPath $RunningDir -Filter '*.json' -File)) {
    Write-Log "前回の実行中に停止した依頼を失敗扱いにします: $($item.Name)"
    Move-QueueItem $item.FullName $FailedDir @{ status = 'failed'; finishedAt = (Get-Date).ToString('o'); error = 'RPA専用機の監視スクリプトが実行中に停止したため中断しました。必要ならもう一度依頼してください' } | Out-Null
  }
}

function Remove-OldItems {
  $limit = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem -LiteralPath $DoneDir, $FailedDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $limit } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

foreach ($d in $PendingDir, $RunningDir, $DoneDir, $FailedDir) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Resolve-InterruptedJobs
Remove-OldItems
$lastCleanup = Get-Date
Write-Log "監視を開始します: $QueueRoot"

while ($true) {
  $worked = $false
  try {
    Convert-LegacyRequest
    $worked = Invoke-NextJob
  } catch {
    Write-Log "エラー: $($_.Exception.Message)"
  }
  # 実行した直後は、待っている次の依頼をすぐ確認する
  if (-not $worked) { Start-Sleep -Seconds $PollSeconds }
  if (((Get-Date) - $lastCleanup).TotalHours -ge 1) {
    Remove-OldItems
    $lastCleanup = Get-Date
  }
}
