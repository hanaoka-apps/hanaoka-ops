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
    (steps があれば、各手順のPADフロー起動と出力待ちを順に行ってから after の処理。
     flow も steps も無いジョブは after の処理だけ)
  after には regenerate_facts(ダッシュボード用JSON)と build_ec_index(EC売上用の軽量ファイル ec_smile_index.json)が使える。
  schedules に書いたジョブは、毎日その時刻に自分で依頼する(例: 1:00 に facts_only、1:10 に ec_index)。
    (URIで起動したPADフローは完了を待たずに戻るため、出力ファイルで完了を判断する)

  PADは同時に1つのフローしか動かせないので、1件ずつ順番に処理する。
  同じジョブの依頼が複数待っていたら、まとめて1回だけ実行する。
  ただし "type": "import"（SMILEへの取込）のジョブは、依頼ごとに別の仕事（batchId が違う）なので
  まとめず、1件ずつ実行する。

  取込ジョブ(type=import。EC売上の ec_smile_import)は、出力ファイルでは完了を判断できないため、
  SharedMasters\_rpa_import\<バッチ番号>\ の result.json の出現で判断する。流れ:
    管理者確認 → 二重取込確認 → manifest と実ファイルの照合 → 固定フォルダへ配置
    → PADフローを順に起動(納品先にエラーがあれば受注は実行しない) → result.json を書く
    → _rpa_import\done\ または failed\ へ移す(30日で削除) → 成功なら ec_smile_verify_export を依頼に追加
  約束事は scripts/rpa_setup/EC売上_RPA専用機への依頼内容.md、PADフローの作り方は scripts/rpa_setup/ec_import.md。

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
# EC売上の取込(type=import のジョブ)
$ImportRoot        = Join-Path $SharedMastersPath '_rpa_import'
$ImportAdminsPath  = Join-Path $QueueRoot 'ec_import_admins.json'
# PADに渡す固定フォルダ(毎回同じ名前でファイルを置く。取込が終わったら中身は消す)
$EcImportCurrentDir = 'C:\RPA\ec_import\current'
# 動いている印(アプリ側の rpa_queue.js が、20分以上更新されていなければ「応答なし」と表示する)
$HeartbeatPath     = Join-Path $QueueRoot 'heartbeat.json'
$LogPath           = "$env:USERPROFILE\regenerate_watcher.log"
$RepoRawBase       = 'https://raw.githubusercontent.com/hanaoka-apps/hanaoka-ops/main'
$WorkDir           = "$env:TEMP\hanaoka-regenerate-watcher"
$PollSeconds       = 30
# done / failed の記録を残す日数
$KeepDays          = 30
# 依頼ファイルが読めない(同期途中など)状態が続いたら失敗扱いにするまでの回数
$MaxBadReads       = 3
# 定時のジョブを今日依頼したかの記録(同期フォルダやTEMPには置かない)
$ScheduleStatePath = "$env:LOCALAPPDATA\hanaoka-rpa\schedule_state.json"
# 稼働の印に書く「対応している機能」を有効にするファイル(専用機の中だけ。Get-WorkerFeatures)
$WorkerFeaturesPath = "$env:LOCALAPPDATA\hanaoka-rpa\features.json"

$script:BadReads = @{}
$script:JobDefsCache = $null
$script:JobDefsCachedAt = [datetime]::MinValue
$script:BadScheduleLogged = @{}
$script:HeartbeatAt = [datetime]::MinValue

# ログは記録用なので、書けなくても本来の処理は止めない。
# (ほかのプロセスがログを開いている瞬間に書くと失敗し、以前はそれで常駐スクリプトごと止まった)
function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  for ($i = 0; $i -lt 5; $i++) {
    try { Add-Content -Path $LogPath -Value $line -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 300 }
  }
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

# 動いている印を書く。OneDriveの同期を増やしすぎないよう、5分に1回まで(-Force で今すぐ)。
# 書けなくても本来の処理は止めない。
function Update-Heartbeat([string]$Job = '', [switch]$Force) {
  if (-not $Force -and ((Get-Date) - $script:HeartbeatAt).TotalMinutes -lt 5) { return }
  try {
    $hb = [pscustomobject]@{
      updatedAt = (Get-Date).ToString('o')
      host = $env:COMPUTERNAME
      job = $Job
    }
    # 専用機が対応している機能(アプリが切り替えに使う)。専用機の中のファイルでだけ有効にする(下の Get-WorkerFeatures)
    $features = @(Get-WorkerFeatures)
    if ($features.Count -gt 0) { $hb | Add-Member -NotePropertyName features -NotePropertyValue $features }
    Write-JsonFile $HeartbeatPath $hb
    $script:HeartbeatAt = Get-Date
  } catch { }
}

# 稼働の印(heartbeat.json)に書く「対応している機能」。専用機の中のファイル $WorkerFeaturesPath でだけ有効にする
# (例 { "features": ["tempDeliveryCodes"] })。リポジトリには書かない＝動作確認が済んだ専用機で、ファイルを置いたときだけ有効。
# ファイルを消せば、次の書き込み(5分以内)で印から消え、アプリは自動で元の動き(アプリが納品先の番号を決める)に戻る。
# この常駐スクリプトが実装している機能の名前だけを書く(知らない名前・形の違う値は無視する)
$KnownWorkerFeatures = @('tempDeliveryCodes')
function Get-WorkerFeatures {
  if (-not $WorkerFeaturesPath -or -not (Test-Path -LiteralPath $WorkerFeaturesPath)) { return @() }
  try { $o = Read-JsonFile $WorkerFeaturesPath } catch { return @() }
  $list = if ($o -is [System.Array]) { @($o) } else { @($o.features) }
  return @($list | ForEach-Object { [string]$_ } | Where-Object { $KnownWorkerFeatures -contains $_ } | Select-Object -Unique)
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
    Update-Heartbeat $flow
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

# SMILEのメイン画面(題名がちょうど windowTitle のウィンドウ)が開いているか。
# 出力画面などを開いていると .NET の MainWindowTitle はそちらの題名になるため、
# UI オートメーションでプロセスのトップレベルウィンドウをすべて見る。
function Test-SmileReady($Cfg) {
  $procs = @(Get-Process -Name ([string]$Cfg.process) -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return $false }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($p in $procs) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
      if ($w.Current.Name -eq [string]$Cfg.windowTitle) { return $true }
    }
  }
  return $false
}

# SMILEを使うジョブの前に、SMILEが起動してログイン済みかを確かめる。
# 起動していなければ起動用のPADフロー(ログインと業務予定通知を閉じるまで)を動かして待つ。
# (PC再起動後やSMILEの自動更新後に、SMILEが閉じたままでジョブが失敗しないように)
function Ensure-Smile($Cfg) {
  if (Test-SmileReady $Cfg) { return }
  $timeoutMinutes = 5
  if ($Cfg.timeoutMinutes) { $timeoutMinutes = [int]$Cfg.timeoutMinutes }
  $settleSeconds = 30
  if ($Cfg.settleSeconds) { $settleSeconds = [int]$Cfg.settleSeconds }
  Write-Log "SMILEが起動していないため、PADフローで起動します: $($Cfg.startFlow)"
  Start-Process ('ms-powerautomate:/console/flow/run?workflowName=' + [uri]::EscapeDataString([string]$Cfg.startFlow))
  $deadline = (Get-Date).AddMinutes($timeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    Update-Heartbeat ([string]$Cfg.startFlow)
    if (Test-SmileReady $Cfg) {
      # メイン画面が出たあと、起動フローが業務予定通知を閉じ終わるまで待つ
      Start-Sleep -Seconds $settleSeconds
      Write-Log 'SMILEの起動を確認しました'
      return
    }
  }
  throw "SMILEを${timeoutMinutes}分以内に起動できませんでした(起動フロー: $($Cfg.startFlow))"
}

# ジョブの手順(PADフローと出力ファイルの組)を返す。
# steps があればその順に、なければ flow / outputs の1手順。timeoutMinutes は手順になければジョブの値を使う。
function Get-JobSteps($Def) {
  # flow も steps も無いジョブは、PADを動かさず after の処理だけを行う(例: facts_only)
  if (-not $Def.steps -and -not $Def.flow) {
    if (-not $Def.after) { throw 'ジョブ定義に flow / steps / after のどれもありません' }
    return
  }
  if (-not $Def.steps) { return , $Def }
  $steps = @($Def.steps)
  if ($steps.Count -eq 0) { throw 'ジョブ定義の steps が空です' }
  foreach ($s in $steps) {
    if (-not $s.timeoutMinutes -and $Def.timeoutMinutes) {
      $s | Add-Member -NotePropertyName timeoutMinutes -NotePropertyValue $Def.timeoutMinutes -Force
    }
  }
  return $steps
}

# リポジトリの scripts/<名前> (Python) を GitHub の main から取得して、専用機の Python で実行する。
# SHARED_MASTERS_DIR で同期フォルダを直接読み書きする(アップロードは OneDrive 同期に任せる)
# $ConfigFile(リポジトリ内のパス。例 ec_sales_config.json)を渡すと、SharedMasters に同名のファイルがあればそれを、無ければ main から取得したものを
# --config <パス> としてスクリプトに渡す(得意先コードなどをスクリプトに埋め込まないため。アプリも同じ優先順位で設定を読む)
# $ExtraArgs＝スクリプトに渡す追加の引数(空白を含む値は呼び出し側で " で囲む)。-ShowOutput を付けると、失敗したとき標準出力の最後の1行を
# 例外のメッセージに含める(post_teams.py のように、URL などの秘密を出力しないと決めてあるスクリプトだけに使う)
function Invoke-RepoPython([string]$ScriptName, [string]$ConfigFile = '', [string[]]$ExtraArgs = @(), [switch]$ShowOutput) {
  Write-Log "$ScriptName を取得して実行します"
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  # 毎回別名で取得する。同じ名前に上書きすると、前回のファイルをウイルス対策の
  # スキャンなどが開いていた場合に「別のプロセスで使用されている」で失敗する。
  $stamp = '{0:yyyyMMdd_HHmmss}' -f (Get-Date)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($ScriptName)
  $scriptPath = Join-Path $WorkDir "${base}_$stamp.py"
  $outPath = Join-Path $WorkDir "${base}_$stamp.out.txt"
  $errPath = Join-Path $WorkDir "${base}_$stamp.err.txt"
  $configPath = ''
  $configIsTemp = $false
  try {
    # 常に最新版を取得してから実行する(手元に古いコピーを置いて動かさない)
    Invoke-WebRequest -Uri "$RepoRawBase/scripts/$ScriptName" -OutFile $scriptPath -UseBasicParsing
    $argText = '"{0}"' -f $scriptPath
    if ($ConfigFile) {
      $shared = Join-Path $SharedMastersPath ([System.IO.Path]::GetFileName($ConfigFile))
      if (Test-Path -LiteralPath $shared) { $configPath = $shared }
      else {
        $configPath = Join-Path $WorkDir "${base}_$stamp.config.json"
        $configIsTemp = $true
        Invoke-WebRequest -Uri "$RepoRawBase/$ConfigFile" -OutFile $configPath -UseBasicParsing
        # 設定の indexAlsoConfigs(同じフォルダの別の設定ファイル。例: furusato_config.json)も、同じ作業フォルダに取得する
        $also = @((Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).indexAlsoConfigs)
        foreach ($name in $also) {
          if (-not $name -or $name -notmatch '^[\w.-]+\.json$') { continue }
          $dir = [System.IO.Path]::GetDirectoryName($ConfigFile) -replace '\\', '/'
          $rel = if ($dir) { "$dir/$name" } else { $name }
          Invoke-WebRequest -Uri "$RepoRawBase/$rel" -OutFile (Join-Path $WorkDir $name) -UseBasicParsing
        }
      }
      $argText += ' --config "{0}"' -f $configPath
    }
    if ($ExtraArgs.Count -gt 0) { $argText += ' ' + ($ExtraArgs -join ' ') }
    $env:SHARED_MASTERS_DIR = $SharedMastersPath
    # 出力先が画面でないとPythonはcp932で書き出し、絵文字の表示で止まるためUTF-8にする
    $env:PYTHONIOENCODING = 'utf-8'
    $proc = Start-Process -FilePath 'python' -ArgumentList $argText -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    if ($proc.ExitCode -ne 0) {
      # 原因を追えるよう、Pythonのエラー出力の最後をログに残す
      # (Python が失敗の理由を標準出力に出すスクリプトもあるので、両方の最後を残す。build_ec_index.py は件数だけで個人情報は出さない)
      $tail = @(Get-Content -LiteralPath $outPath -Tail 4 -Encoding UTF8 -ErrorAction SilentlyContinue) + @(Get-Content -LiteralPath $errPath -Tail 8 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ' / '
      Write-Log "$ScriptName のエラー出力: $tail"
      $reason = ''
      if ($ShowOutput) {
        $last = @(Get-Content -LiteralPath $outPath -Tail 1 -Encoding UTF8 -ErrorAction SilentlyContinue) -join ''
        if ($last.Length -gt 300) { $last = $last.Substring(0, 300) }
        if ($last) { $reason = ': ' + $last }
      }
      throw "$ScriptName が終了コード $($proc.ExitCode) で失敗しました$reason"
    }
  } finally {
    Remove-Item -LiteralPath $scriptPath, $outPath, $errPath -Force -ErrorAction SilentlyContinue
    if ($configIsTemp) { Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-RegenerateFacts { Invoke-RepoPython 'regenerate_facts.py' }

# 後処理(after)の名前 → 実行する関数。増やすときはここと Invoke-After に足す
$AfterJobs = @('regenerate_facts', 'build_ec_index')
function Invoke-After([string]$After) {
  switch ($After) {
    'regenerate_facts' { Invoke-RegenerateFacts }
    # EC売上用の軽量ファイル ec_smile_index.json を作る(受注明細出力・納品先マスタ・品目マスタ・入金明細出力から)
    # EC の得意先・テスト送信用の得意先は ec_sales_config.json から読む(スクリプトには埋め込まない)
    'build_ec_index'   { Invoke-RepoPython 'build_ec_index.py' 'ec_sales_config.json' }
  }
}

# 報告ジョブ(type: notify。EC売上の ec_report)：依頼の params.parts(報告の本文の配列)を Teams のチャネルへ投稿する。PAD は使わない。
# 投稿先 URL は専用機の環境変数(既定 EC_TEAMS_WEBHOOK_URL)だけに置く。この中でも、URL をログ・エラー文に出さない。
# 未設定なら、投稿せずに理由を例外にする(依頼の failed の error として、アプリの「報告に失敗」に出る)。
function Invoke-Notify($Def, $Request) {
  $parts = @($Request.params.parts | Where-Object { $null -ne $_ })
  if ($parts.Count -eq 0) { throw '報告の本文(params.parts)がありません' }
  $total = 0
  foreach ($p in $parts) {
    if (-not ([string]$p).Trim()) { throw '報告の本文に空の部分があります' }
    $total += ([string]$p).Length
  }
  if ($total -gt 60000) { throw '報告の本文が長すぎます' }
  $script = 'post_teams.py'
  if ($Def.script) { $script = [string]$Def.script }
  if ($script -notmatch '^[A-Za-z0-9_]+\.py$') { throw "報告のスクリプト名が正しくありません: $script" }
  $envName = 'EC_TEAMS_WEBHOOK_URL'
  if ($Def.webhookEnv) { $envName = [string]$Def.webhookEnv }
  if ($envName -notmatch '^[A-Za-z0-9_]+$') { throw "環境変数の名前が正しくありません: $envName" }
  # 常駐スクリプトの起動後にユーザー環境変数を設定した場合も、再ログオンなしで使えるようにする(値はログに出さない)
  if (-not [Environment]::GetEnvironmentVariable($envName, 'Process')) {
    $u = [Environment]::GetEnvironmentVariable($envName, 'User')
    if ($u) { [Environment]::SetEnvironmentVariable($envName, $u, 'Process') }
  }
  if (-not [Environment]::GetEnvironmentVariable($envName, 'Process')) {
    throw "Teams への投稿先が未設定です(専用機の環境変数 $envName に Teams の Webhook の URL を設定してください)"
  }
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $inPath = Join-Path $WorkDir ('report_{0}.json' -f [Guid]::NewGuid().ToString('N'))
  try {
    # mention＝依頼者へのメンション { id(メール), name }。無い・不正でも投稿は成功する(post_teams.py がメンションなしにする)
    Write-JsonFile $inPath ([pscustomobject]@{ parts = $parts; mention = $Request.params.mention })
    Invoke-RepoPython $script '' @('--input', ('"{0}"' -f $inPath), '--webhook-env', $envName) -ShowOutput
  } finally {
    Remove-Item -LiteralPath $inPath -Force -ErrorAction SilentlyContinue
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

# ===== EC売上: SMILEへの取込(type=import) =====

function Test-ImportAdmin([string]$Email) {
  # 管理者の一覧は専用機側で管理する(リポジトリには置かない)。{ "admins": ["a@...", ...] } か、メールの配列
  if (-not $Email -or -not (Test-Path -LiteralPath $ImportAdminsPath)) { return $false }
  try { $o = Read-JsonFile $ImportAdminsPath } catch { return $false }
  $list = if ($o -is [System.Array]) { @($o) } else { @($o.admins) }
  foreach ($m in $list) { if ([string]$m -and ([string]$m).ToLower() -eq $Email.ToLower()) { return $true } }
  return $false
}

# UTF-16(BOMつき)の取込ファイルを読んで、見出し・データ行を返す
function Read-ImportTable([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0xFF -or $bytes[1] -ne 0xFE) { throw 'UTF-16(BOMつき)ではありません' }
  $text = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  $lines = @($text -split "`r`n" | Where-Object { $_ -ne '' })
  if ($lines.Count -eq 0) { throw '中身が空です' }
  $head = $lines[0] -split "`t"
  $rows = @()
  if ($lines.Count -gt 1) { $rows = @($lines[1..($lines.Count - 1)] | ForEach-Object { ,($_ -split "`t") }) }
  return [pscustomobject]@{ Head = $head; Rows = $rows }
}

# ===== 新しい納品先のコードは、取込の直前に専用機で決める =====
# アプリは新しい納品先に仮の番号(例 N00001)を入れて送る。SMILEの納品先マスター取込には自動採番がなく、
# 既にあるコードはエラーチェックで「納品先が存在します」になる(上書きはしない)。そこで、取込の直前に
# 最新の ec_smile_index.json から空いている番号を決めて、nouhin.txt と juchu.txt の納品先コードの列だけを置き換える。
# 番号がぶつかったら(PADが「納品先が存在します」だけのエラーと報告したら)、番号を進めてやり直す。
# 番号の決め方はアプリ(ec_sales_core.js の indexDeliveryMaster / planDeliveries)と同じ：
#   得意先ごとに、使われている番号のうち予約(reservedDeliveryCodes)を除き上限(deliveryCodeLimit)以下の最大を起点に、
#   予約・使用済みを飛ばして順に振る。予約と上限は ec_sales_config.json から読む(アプリと食い違わないように)。
$EcDeliveryTempPattern = '^N\d{5}$'
$EcDeliveryCodeColumn  = '納品先コード'
$EcCustomerColumn      = '得意先コード'

# ec_sales_config.json を読む(SharedMasters にあればそれ、なければ GitHub の main、だめなら手元のリポジトリ)
function Get-EcSalesConfig {
  $shared = Join-Path $SharedMastersPath 'ec_sales_config.json'
  if (Test-Path -LiteralPath $shared) { return (Read-JsonFile $shared) }
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $path = Join-Path $WorkDir ('ec_sales_config_{0:yyyyMMdd_HHmmss}.json' -f (Get-Date))
  try {
    Invoke-WebRequest -Uri "$RepoRawBase/ec_sales_config.json" -OutFile $path -UseBasicParsing
    return (Read-JsonFile $path)
  } catch {
    Write-Log "ec_sales_config.json をGitHubから取得できないため、手元のファイルを使います: $($_.Exception.Message)"
    return (Read-JsonFile (Join-Path (Split-Path $PSScriptRoot -Parent) 'ec_sales_config.json'))
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

function Get-EcSmileIndex { return (Read-JsonFile (Join-Path $SharedMastersPath 'ec_smile_index.json')) }

# 取込ファイル(UTF-16・タブ区切り)の1つの値。前後の " は外して比べる
function Get-FieldValue([string]$Field) { $v = $Field.Trim(); if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }; return $v }

# 仮の番号の一覧(nouhin.txt の出てくる順)と、ファイルの問題(文字列の配列)を返す
function Get-TempDeliveryCodes([string]$BatchDir) {
  $temps = @(); $problems = @(); $seen = @{}
  $np = Join-Path $BatchDir 'nouhin.txt'; $jp = Join-Path $BatchDir 'juchu.txt'
  if (Test-Path -LiteralPath $np) {
    $t = Read-ImportTable $np
    $ci = [Array]::IndexOf([string[]]$t.Head, $EcCustomerColumn); $di = [Array]::IndexOf([string[]]$t.Head, $EcDeliveryCodeColumn)
    if ($ci -lt 0 -or $di -lt 0) { return [pscustomobject]@{ Temps = @(); Problems = @("nouhin.txt に「$EcCustomerColumn」「$EcDeliveryCodeColumn」の見出しがありません") } }
    foreach ($r in $t.Rows) {
      $code = Get-FieldValue $r[$di]
      if ($code -notmatch $EcDeliveryTempPattern) { continue }
      $key = (Get-FieldValue $r[$ci]) + '|' + $code
      if ($seen.ContainsKey($key)) { $problems += "nouhin.txt に同じ仮の番号が2行あります($key)"; continue }
      $seen[$key] = 1
      $temps += [pscustomobject]@{ customer = (Get-FieldValue $r[$ci]); temp = $code }
    }
  }
  if (Test-Path -LiteralPath $jp) {
    $t = Read-ImportTable $jp
    $ci = [Array]::IndexOf([string[]]$t.Head, $EcCustomerColumn); $di = [Array]::IndexOf([string[]]$t.Head, $EcDeliveryCodeColumn)
    if ($ci -lt 0 -or $di -lt 0) { $problems += "juchu.txt に「$EcCustomerColumn」「$EcDeliveryCodeColumn」の見出しがありません" }
    else {
      foreach ($r in $t.Rows) {
        $code = Get-FieldValue $r[$di]
        if ($code -notmatch $EcDeliveryTempPattern) { continue }
        $key = (Get-FieldValue $r[$ci]) + '|' + $code
        if (-not $seen.ContainsKey($key)) { $problems += "juchu.txt の仮の番号が nouhin.txt にありません($key)"; $seen[$key] = 1 }
      }
    }
  }
  return [pscustomobject]@{ Temps = $temps; Problems = $problems }
}

# 仮の番号ごとに、SMILEで空いている番号を決める。$Avoid(得意先|番号)は、前回ぶつかった番号(使わない)
function New-DeliveryCodePlan($Temps, $Index, $Config, [hashtable]$Avoid) {
  $cfg = $Config.config
  $reserved = @{}; foreach ($c in @($cfg.reservedDeliveryCodes)) { $reserved[[string]$c] = 1 }
  $limit = [int]([string]$cfg.deliveryCodeLimit)
  $cols = @($Index.nouhin.cols); $ci = [Array]::IndexOf([string[]]$cols, $EcCustomerColumn); $di = [Array]::IndexOf([string[]]$cols, $EcDeliveryCodeColumn)
  if ($ci -lt 0 -or $di -lt 0) { throw 'ec_smile_index.json の納品先に得意先コード・納品先コードの列がありません' }
  $used = @{}; $max = @{}
  foreach ($r in @($Index.nouhin.rows)) {
    $cc = [string]$r[$ci]; $code = ([string]$r[$di]).Trim()
    if ($code -notmatch '^\d+$') { continue }
    $used["$cc|$code"] = 1
    if (-not $reserved.ContainsKey($code) -and [int]$code -le $limit -and (-not $max.ContainsKey($cc) -or [int]$code -gt $max[$cc])) { $max[$cc] = [int]$code }
  }
  $next = @{}; $plan = @()
  foreach ($t in @($Temps)) {
    $cc = [string]$t.customer
    if (-not $next.ContainsKey($cc)) { $next[$cc] = $(if ($max.ContainsKey($cc)) { $max[$cc] } else { 0 }) }
    do {
      $next[$cc]++
      $code = '{0:D6}' -f $next[$cc]
    } while ($reserved.ContainsKey($code) -or $used.ContainsKey("$cc|$code") -or ($Avoid -and $Avoid.ContainsKey("$cc|$code")))
    if ($next[$cc] -gt $limit) { throw "得意先 $cc の納品先コードが連番の上限($($cfg.deliveryCodeLimit))を超えます" }
    $used["$cc|$code"] = 1
    $plan += [pscustomobject]@{ customer = $cc; temp = [string]$t.temp; code = $code }
  }
  return $plan
}

# 取込ファイルの納品先コードの列だけを、得意先とセットで置き換えて書き出す(ほかの列・行の並び・改行・BOMはそのまま)
function Write-AssignedImportFile([string]$Src, [string]$Dst, $Plan) {
  $map = @{}; foreach ($p in @($Plan)) { $map["$($p.customer)|$($p.temp)"] = $p.code }
  $bytes = [System.IO.File]::ReadAllBytes($Src)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0xFF -or $bytes[1] -ne 0xFE) { throw "$([System.IO.Path]::GetFileName($Src)) が UTF-16(BOMつき)ではありません" }
  $lines = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2) -split "`r`n"
  $head = $lines[0] -split "`t"
  $ci = [Array]::IndexOf([string[]]$head, $EcCustomerColumn); $di = [Array]::IndexOf([string[]]$head, $EcDeliveryCodeColumn)
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '') { continue }
    $f = $lines[$i] -split "`t"
    $code = Get-FieldValue $f[$di]
    if ($code -notmatch $EcDeliveryTempPattern) { continue }
    $key = (Get-FieldValue $f[$ci]) + '|' + $code
    if (-not $map.ContainsKey($key)) { throw "仮の番号 $key の置き換え先がありません" }
    $f[$di] = $f[$di].Replace($code, $map[$key])
    $lines[$i] = $f -join "`t"
  }
  $out = [System.Text.Encoding]::Unicode.GetBytes($lines -join "`r`n")
  [System.IO.File]::WriteAllBytes($Dst, ([byte[]](0xFF, 0xFE) + $out))
}

# 置き換えたファイルの納品先コードの列に、仮の番号の形が残っていないか(残っていたら SMILE に進まない)
function Test-TempCodesLeft([string]$Path) {
  $t = Read-ImportTable $Path
  $di = [Array]::IndexOf([string[]]$t.Head, $EcDeliveryCodeColumn)
  if ($di -lt 0) { return 0 }
  return @($t.Rows | Where-Object { (Get-FieldValue $_[$di]) -match $EcDeliveryTempPattern }).Count
}

# 置き換えの準備。仮の番号がなければ Active=$false(今までどおり、ファイルをそのまま使う)
function Initialize-DeliveryAssignment([string]$BatchDir, $Def) {
  $st = [pscustomobject]@{ Active = $false; Temps = @(); Plan = @(); Avoid = @{}; Retries = 0; MaxRetries = 10; Dir = (Join-Path $BatchDir 'assigned'); Index = $null; Config = $null }
  if ($Def.deliveryCodeRetries) { $st.MaxRetries = [int]$Def.deliveryCodeRetries }
  $g = Get-TempDeliveryCodes $BatchDir
  if (@($g.Problems).Count -gt 0) { throw (@($g.Problems) -join ' / ') }
  if (@($g.Temps).Count -eq 0) { return $st }
  $st.Active = $true; $st.Temps = @($g.Temps)
  $st.Config = Get-EcSalesConfig
  $st.Index = Get-EcSmileIndex
  Update-DeliveryAssignment $st $BatchDir
  return $st
}

# 番号を決め直して、置き換えたファイルを assigned\ に書き、残っていないかを確かめる
function Update-DeliveryAssignment($St, [string]$BatchDir) {
  $St.Plan = @(New-DeliveryCodePlan $St.Temps $St.Index $St.Config $St.Avoid)
  New-Item -ItemType Directory -Force -Path $St.Dir | Out-Null
  foreach ($n in 'nouhin.txt', 'juchu.txt') {
    $src = Join-Path $BatchDir $n
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $St.Dir $n
    Write-AssignedImportFile $src $dst $St.Plan
    $left = Test-TempCodesLeft $dst
    if ($left -gt 0) { throw "$n の納品先コードに仮の番号が $left 行残っています" }
  }
  Write-Log ('納品先の番号を決めました: ' + ((@($St.Plan) | ForEach-Object { "$($_.customer) $($_.temp)→$($_.code)" }) -join ', '))
}

# PADの結果が「納品先が存在します」だけのエラーで、実行を押す前に止まったか(番号がぶつかった)。
# PADはエラーチェックの画面のエラー件数(errorCount)と、エラーリストで「存在します」を検索した件数(existsCount)を書く
function Test-DeliveryCodeConflict($R) {
  if (-not ($R.executed -is [bool]) -or $R.executed) { return $false }
  $names = $R.PSObject.Properties.Name
  if (-not ($names -contains 'errorCount') -or -not ($names -contains 'existsCount')) { return $false }
  $e = 0; $x = 0
  if (-not [int]::TryParse([string]$R.errorCount, [ref]$e) -or -not [int]::TryParse([string]$R.existsCount, [ref]$x)) { return $false }
  return ($e -gt 0 -and $x -eq $e)
}

# manifest と実ファイルの照合。問題の一覧(文字列の配列)を返す。空なら問題なし
function Test-ImportBatch([string]$BatchDir, [string]$BatchId, $Def) {
  $problems = @()
  $manifestPath = Join-Path $BatchDir 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return @('manifest.json がありません') }
  try { $manifest = Read-JsonFile $manifestPath } catch { return @('manifest.json を読めません') }
  if ([string]$manifest.batchId -ne $BatchId) { $problems += 'manifest の batchId が依頼と違います' }
  $files = @($manifest.files)
  if (-not ($files | Where-Object { $_.name -eq 'juchu.txt' })) { $problems += 'manifest に juchu.txt がありません' }
  foreach ($step in @($Def.steps)) {
    $f = $files | Where-Object { $_.name -eq $step.file } | Select-Object -First 1
    if (-not $f) { continue }   # 納品先は新規がなければ無い
    $path = Join-Path $BatchDir $step.file
    if (-not (Test-Path -LiteralPath $path)) { $problems += "$($step.file) がありません"; continue }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne ([string]$f.sha256).ToLower()) { $problems += "$($step.file) の sha256 が manifest と違います"; continue }
    try { $t = Read-ImportTable $path } catch { $problems += "$($step.file): $($_.Exception.Message)"; continue }
    if ($t.Head.Count -ne [int]$step.columns) { $problems += "$($step.file) の列数が $($t.Head.Count) です($($step.columns) のはず)"; continue }
    if ($t.Rows.Count -ne [int]$f.rows) { $problems += "$($step.file) の行数が $($t.Rows.Count) です(manifest は $($f.rows))"; continue }
    if ($t.Rows.Count -eq 0) { $problems += "$($step.file) にデータ行がありません"; continue }
    $bad = 0
    foreach ($r in $t.Rows) { if ($r.Count -ne $t.Head.Count) { $bad++ } }
    if ($bad -gt 0) { $problems += "$($step.file) に列数の合わない行が $bad 行あります"; continue }
    foreach ($col in @($step.required)) {
      $idx = [Array]::IndexOf([string[]]$t.Head, [string]$col)
      if ($idx -lt 0) { $problems += "$($step.file) に見出し「$col」がありません"; continue }
      $empty = 0
      foreach ($r in $t.Rows) { if (-not ([string]$r[$idx]).Trim()) { $empty++ } }
      if ($empty -gt 0) { $problems += "$($step.file) の「$col」が空の行が $empty 行あります" }
    }
    # 伝票の数(slips)：取込ファイル内の仮の受注№の種類の数が、manifest の slips と合うこと(旧形式の manifest は slips が無いので見ない)
    if ($step.slipColumn -and $null -ne $f.slips -and "$($f.slips)" -ne '') {
      $si = [Array]::IndexOf([string[]]$t.Head, [string]$step.slipColumn)
      if ($si -lt 0) { $problems += "$($step.file) に見出し「$($step.slipColumn)」がありません" }
      else {
        $kinds = @{}
        foreach ($r in $t.Rows) { $kinds[[string]$r[$si]] = 1 }
        if ($kinds.Count -ne [int]$f.slips) { $problems += "$($step.file) の伝票の数が $($kinds.Count) です(manifest の slips は $($f.slips))" }
      }
    }
  }
  return $problems
}

# executed = SMILEの「実行」を押したか。$false(押す前に止まった)の failed だけ、アプリが再実行を許す。
# $true、または不明のとき(結果ファイルが出ない・旧形式)は、一部が入っているかもしれないので要確認(partial)で止める
# $Executed が $null(押したか不明)のときは executed のキー自体を書かない(アプリは false 以外を要確認で止める)
function Write-ImportResult([string]$BatchDir, [string]$BatchId, [string]$State, [string]$Message, $Files, [string]$StartedAt, $Executed) {
  $obj = [pscustomobject]@{
    batchId = $BatchId; state = $State; message = $Message; files = @($Files)
    startedAt = $StartedAt; finishedAt = (Get-Date).ToString('o')
  }
  if ($null -ne $Executed) { $obj | Add-Member -NotePropertyName executed -NotePropertyValue ([bool]$Executed) }
  # 新しい納品先の番号を専用機で決めたときは、仮の番号→SMILEの番号の対応と、ぶつかってやり直した回数を書く(アプリが突き合わせ・表示に使う)
  $as = $script:EcImportAssign
  if ($as -and $as.Active) {
    $obj | Add-Member -NotePropertyName assigned -NotePropertyValue @(@($as.Plan) | ForEach-Object { [pscustomobject]@{ customer = $_.customer; temp = $_.temp; code = $_.code } })
    $obj | Add-Member -NotePropertyName retries -NotePropertyValue ([int]$as.Retries)
  }
  Write-JsonFile (Join-Path $BatchDir 'result.json') $obj
  return $obj
}

# 取込フォルダを done / failed へ移す(同じ名前が failed にあれば入れ替える)。30日の削除は Remove-OldImports
function Move-ImportBatch([string]$BatchId, [string]$ToName) {
  $src = Join-Path $ImportRoot $BatchId
  if (-not (Test-Path -LiteralPath $src)) { return }
  $toDir = Join-Path $ImportRoot $ToName
  New-Item -ItemType Directory -Force -Path $toDir | Out-Null
  $dest = Join-Path $toDir $BatchId
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $src -Destination $dest
  (Get-Item -LiteralPath $dest).LastWriteTime = Get-Date   # 30日の数え始め
}

# PADフローを起動し、結果ファイル(PADが書く result_*.json)が起動後に現れて読めるようになるまで待つ。
# 現れたら中身を返す。時間内に出なければ $null
function Invoke-PadImportStep([string]$Flow, [string]$ResultPath, [int]$TimeoutMinutes) {
  if (Test-Path -LiteralPath $ResultPath) { Remove-Item -LiteralPath $ResultPath -Force }
  $startedAt = (Get-Date).AddSeconds(-2)
  Write-Log "PADフローを起動します: $Flow"
  Start-Process ('ms-powerautomate:/console/flow/run?workflowName=' + [uri]::EscapeDataString($Flow))
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $item = Get-Item -LiteralPath $ResultPath -ErrorAction SilentlyContinue
    if (-not $item -or $item.LastWriteTime -lt $startedAt) { continue }
    if (-not (Test-FileReadable $ResultPath)) { continue }
    try { return (Read-JsonFile $ResultPath) } catch { continue }   # 書き込み途中なら次の確認で
  }
  return $null
}

# 固定フォルダに残ったお客様のデータ(納品先.txt・受注.txt と PADの結果ファイル)を消す。$Def があれば、その steps のファイル名も消す
function Clear-EcCurrentDir($Def = $null) {
  $names = @('納品先.txt', '受注.txt', 'result_nouhin.json', 'result_juchu.json')
  if ($Def -and $Def.steps) {
    foreach ($s in @($Def.steps)) { $names += [string]$s.copyAs; $names += [string]$s.result }
  }
  foreach ($n in ($names | Where-Object { $_ } | Select-Object -Unique)) {
    Remove-Item -LiteralPath (Join-Path $EcImportCurrentDir $n) -Force -ErrorAction SilentlyContinue
  }
}

# result.json が書かれないまま止まった取込を、result.json つきで failed へ移す(アプリは result.json で完了を判断する)。
# 取込フォルダが無い・すでに result.json がある(その state のとおり done / failed へ移すだけ)ときも安全に扱う。
# $Executed は $true / $false / $null(不明。result.json に executed のキーを書かない＝アプリは要確認で止める)
function Complete-ImportWithoutResult([string]$BatchId, [string]$State, [string]$Message, $Executed, $Files = @()) {
  if ($BatchId -notmatch '^ec-[0-9a-f]{16}$') { return }
  $batchDir = Join-Path $ImportRoot $BatchId
  if (-not (Test-Path -LiteralPath $batchDir)) { return }
  $resultPath = Join-Path $batchDir 'result.json'
  if (Test-Path -LiteralPath $resultPath) {
    $st = ''
    try { $st = [string](Read-JsonFile $resultPath).state } catch { }
    if ($st -eq 'done' -or $st -eq 'failed' -or $st -eq 'partial') { Move-ImportBatch $BatchId $(if ($st -eq 'done') { 'done' } else { 'failed' }); return }
  }
  Write-ImportResult $batchDir $BatchId $State $Message $Files (Get-Date).ToString('o') $Executed | Out-Null
  Move-ImportBatch $BatchId 'failed'
}

# 取込ジョブ本体。戻り値 { State; Message }。どの経路で終わっても(予期しない例外も)、取込フォルダがあれば result.json を書いて
# done / failed へ移し、固定フォルダを空にする。SMILEのPADフローを1つでも起動したあとの例外は partial(要確認)、起動前は failed(executed:false)。
# $SmileCfg があれば、確認(管理者・二重取込・中身)が済んだあとで SMILE を自動起動する(権限のない依頼でSMILEを起動しない)。
function Invoke-EcImport($Def, $Request, $SmileCfg = $null) {
  $batchId = [string]$Request.batchId
  $script:EcImportLaunched = $false    # PADフローを起動したか
  $script:EcImportExecuted = $null     # SMILEの「実行」を押したか($null は不明)
  $script:EcImportFiles = @()          # ここまでの結果
  $script:EcImportAssign = $null       # 新しい納品先の番号の置き換え(Initialize-DeliveryAssignment)
  try {
    return (Invoke-EcImportCore $Def $Request $SmileCfg)
  } catch {
    $msg = $_.Exception.Message
    Write-Log "エラー: 取込の途中で予期しない例外が出ました($batchId): $msg"
    $out = $null
    try {
      if ($script:EcImportLaunched) {
        $text = "取込の途中で予期しないエラーが出ました。SMILEにどこまで入ったか不明です。SMILE を見て判断してください: $msg"
        Complete-ImportWithoutResult $batchId 'partial' $text $script:EcImportExecuted $script:EcImportFiles
        $out = [pscustomobject]@{ State = 'partial'; Message = $text }
      } else {
        $text = "取込を始める前にエラーが出ました(SMILEには触っていません): $msg"
        Complete-ImportWithoutResult $batchId 'failed' $text $false @()
        $out = [pscustomobject]@{ State = 'failed'; Message = $text }
      }
    } catch {
      Write-Log "エラー: result.json を書けませんでした: $($_.Exception.Message)"
    }
    if (-not $out) { $out = [pscustomobject]@{ State = 'failed'; Message = $msg } }
    return $out
  } finally {
    # お客様の名前・住所・電話が入っているので、どの経路でも固定フォルダには残さない
    try { Clear-EcCurrentDir $Def } catch { }
  }
}

function Invoke-EcImportCore($Def, $Request, $SmileCfg) {
  $batchId = [string]$Request.batchId
  $startedAt = (Get-Date).ToString('o')
  # batchId はフォルダ名になるので、決まった形以外は受け付けない(../ などの混入を防ぐ)
  if ($batchId -notmatch '^ec-[0-9a-f]{16}$') {
    return [pscustomobject]@{ State = 'failed'; Message = 'バッチ番号が正しくありません' }
  }
  $batchDir = Join-Path $ImportRoot $batchId
  $fail = {
    param([string]$msg)
    if (Test-Path -LiteralPath $batchDir) {
      Write-ImportResult $batchDir $batchId 'failed' $msg @() $startedAt $false | Out-Null
      Move-ImportBatch $batchId 'failed'
    }
    return [pscustomobject]@{ State = 'failed'; Message = $msg }
  }

  # 1. 押した人が管理者か
  if (-not (Test-ImportAdmin ([string]$Request.requestedBy))) { return (& $fail '権限なし(依頼した人が管理者ではありません)') }
  # 2. 二重取込の確認
  if (Test-Path -LiteralPath (Join-Path $ImportRoot "done\$batchId")) { return (& $fail '取込済み(同じバッチ番号が done にあります)') }
  if (-not (Test-Path -LiteralPath $batchDir)) { return [pscustomobject]@{ State = 'failed'; Message = 'ファイル不整合(取込フォルダがありません)' } }
  # failed にある同じバッチ：「実行」を押す前に止まったもの(executed:false)だけ再実行を許す。
  # 実行済み・不明・旧形式(executed なし)は、一部が入っているかもしれないので再実行しない(failed の記録もそのまま残す)
  $oldFailed = Join-Path $ImportRoot "failed\$batchId"
  $oldFailedRemove = $false
  if (Test-Path -LiteralPath $oldFailed) {
    $oldExecuted = $true
    $oldResult = Join-Path $oldFailed 'result.json'
    if (Test-Path -LiteralPath $oldResult) {
      try { $o = Read-JsonFile $oldResult; if ($o.executed -is [bool] -and -not $o.executed) { $oldExecuted = $false } } catch { }
    }
    if ($oldExecuted) {
      $m = '前回の取込はSMILEの実行まで進んでいる(または不明)ため、再実行しません。SMILE を見て判断してください'
      Write-ImportResult $batchDir $batchId 'partial' $m @() $startedAt $true | Out-Null
      return [pscustomobject]@{ State = 'partial'; Message = $m }
    }
    $oldFailedRemove = $true
  }
  # 3. 中身の確認(だめなら SMILE には触らない)
  $problems = @(Test-ImportBatch $batchDir $batchId $Def)
  if ($problems.Count -gt 0) { return (& $fail ('ファイル不整合: ' + ($problems -join ' / '))) }
  # 3a. 新しい納品先の仮の番号(N00001 など)を、SMILEで空いている番号に置き換える(manifest の確認は置き換える前のファイルで済ませた)。
  #     置き換えたファイルは取込フォルダの assigned\ に置く(done / failed に一緒に残る)。仮の番号が残っていたら SMILE に進まない
  try { $script:EcImportAssign = Initialize-DeliveryAssignment $batchDir $Def }
  catch { $script:EcImportAssign = $null; return (& $fail ('納品先の番号を決められませんでした(SMILEには触っていません): ' + $_.Exception.Message)) }
  $assign = $script:EcImportAssign

  # 3b. SMILEが閉じていれば起動する(確認がすべて済んだあと)。失敗してもSMILEには触っていないので、やり直しOK(executed:false)
  if ($SmileCfg) {
    try { Ensure-Smile $SmileCfg }
    catch { return (& $fail ("SMILEを起動できませんでした(SMILEには触っていません): " + $_.Exception.Message)) }
  }
  # 再実行の結果と混ざらないよう、前回失敗した同じバッチの記録を消す(再実行が確定してから)
  if ($oldFailedRemove) { Remove-Item -LiteralPath $oldFailed -Recurse -Force }

  # 4. 固定フォルダへ配置(毎回同じ名前。前回の残りは先に消す)
  New-Item -ItemType Directory -Force -Path $EcImportCurrentDir | Out-Null
  Clear-EcCurrentDir $Def
  $manifest = Read-JsonFile (Join-Path $batchDir 'manifest.json')
  $present = @($manifest.files | ForEach-Object { $_.name })
  $files = @()
  $stop = $false
  $hadTimeout = $false
  $executed = $false
  $stopMessage = ''
  $assignError = $null
  $stepTimeout = 15
  if ($Def.stepTimeoutMinutes) { $stepTimeout = [int]$Def.stepTimeoutMinutes }
  # 5. PADフローを順番に。納品先にエラーがあれば受注は実行しない
  foreach ($step in @($Def.steps)) {
    if ($present -notcontains $step.file) { continue }
    if ($stop) { break }
    while ($true) {
      # 新しい納品先の番号を置き換えたときは、置き換えたファイル(assigned\)を使う
      $srcFile = Join-Path $batchDir $step.file
      if ($assign -and $assign.Active) { $af = Join-Path $assign.Dir $step.file; if (Test-Path -LiteralPath $af) { $srcFile = $af } }
      Copy-Item -LiteralPath $srcFile -Destination (Join-Path $EcImportCurrentDir $step.copyAs) -Force
      $script:EcImportLaunched = $true     # ここから先で例外が出たら、SMILEにどこまで入ったか分からない
      # 押したか不明。ただし前のフローで押していれば、全体としては実行済み
      $script:EcImportExecuted = $(if ($executed) { $true } else { $null })
      $r = Invoke-PadImportStep ([string]$step.flow) (Join-Path $EcImportCurrentDir $step.result) $stepTimeout
      # 番号がぶつかった(エラーが全部「納品先が存在します」で、実行を押す前に止まった)：SMILEには何も入っていないので、番号を進めてやり直す
      if ($r -and $assign -and $assign.Active -and $step.file -eq 'nouhin.txt' -and (Test-DeliveryCodeConflict $r) -and $assign.Retries -lt $assign.MaxRetries) {
        foreach ($p in @($assign.Plan)) { $assign.Avoid["$($p.customer)|$($p.code)"] = 1 }
        $assign.Retries++
        Write-Log "納品先の番号がぶつかったため、番号を進めてやり直します($($assign.Retries)/$($assign.MaxRetries)回目)"
        try { Update-DeliveryAssignment $assign $batchDir }
        catch { $assignError = $_.Exception.Message; break }   # 決め直せない(上限など)。SMILEには入っていないので、実行前に止まった扱いのまま
        continue
      }
      break
    }
    if (-not $r) {
      # 結果が出ない = SMILEにどこまで入ったか分からない。再実行させず、人が見て判断する
      $files += [pscustomobject]@{ name = $step.file; executed = $true; imported = 0; errors = 0; errorRows = @() }
      $executed = $true   # 不明は実行済みとして扱う
      $stop = $true
      $stopMessage = "$($step.flow) の結果ファイルが $stepTimeout 分以内に出ませんでした。SMILE を見て判断してください"
      $hadTimeout = $true
      $script:EcImportFiles = $files
      break
    }
    $imp = [int]$r.imported
    $err = [int]$r.errors
    # PADの結果の executed が false のときだけ「押す前に止まった」。無い(旧形式)・true は実行済み扱い
    $stepExecuted = $true
    if ($r.executed -is [bool] -and -not $r.executed) { $stepExecuted = $false }
    if ($stepExecuted) { $executed = $true }
    $files += [pscustomobject]@{ name = $step.file; executed = $stepExecuted; imported = $imp; errors = $err; errorRows = @($r.errorRows) }
    $script:EcImportFiles = $files
    $script:EcImportExecuted = $(if ($executed) { $true } else { $false })
    $mf = @($manifest.files | Where-Object { $_.name -eq $step.file })[0]
    $hasCount = [bool]($r.PSObject.Properties.Name -contains 'imported' -and $null -ne $r.imported -and "$($r.imported)" -ne '')   # 件数を取れない旧形式は比べない
    if (-not $stepExecuted) {
      # SMILEの「実行」を押す前に止まった(PADが executed:false と、止まった工程を errorRows に書く)。成功扱いにしない・以降は実行しない
      $stop = $true
      $why = @($r.errorRows | Where-Object { $_ -and $_.message } | ForEach-Object { [string]$_.message })[0]
      if (-not $why) { $why = '止まった工程は不明です' }
      if ($assign -and $assign.Active -and $step.file -eq 'nouhin.txt' -and (Test-DeliveryCodeConflict $r)) {
        $why = "納品先の番号がSMILEの既存の番号とぶつかりました(番号を進めて $($assign.Retries) 回やり直しました)"
        if ($assignError) { $why += "。番号を決め直せませんでした: $assignError" }
      }
      $stopMessage = "$($step.file) は SMILE の実行を押す前に止まりました：$why"
      if ($executed) { $stopMessage += $(if ($step.file -eq 'juchu.txt') { '（納品先は取り込み済み、受注は実行されていません）' } else { "（先に実行した分は取り込み済みで、$($step.file) は実行されていません）" }) }
    } elseif ($err -gt 0) {
      $stop = $true; $stopMessage = "$($step.file) の取込にエラーが $err 件ありました" + $(if ($step.file -eq 'nouhin.txt') { '(受注は実行していません)' } else { '' })
    } elseif ($hasCount -and $mf) {
      # 実行したのに、取込件数が合わない(0件のまま終わった、など)。done にせず要確認。
      # 比べる件数：受注は manifest の slips(伝票の数＝SMILEの「正常件数」。PADが返す imported は伝票の数)、納品先は rows(1行＝1件)。
      # slips が無い旧形式の manifest の受注は、行数と伝票数が違うので比べない(誤って partial にしない。比べなかったことをログに残す)
      $expectCount = $null
      $unit = '行'
      if ($step.slipColumn) {
        if ($null -ne $mf.slips -and "$($mf.slips)" -ne '') { $expectCount = [int]$mf.slips; $unit = '伝票' }
        else { Write-Log "取込件数を比べません: $($step.file) の manifest に slips がありません(旧形式)" }
      } elseif ($null -ne $mf.rows) { $expectCount = [int]$mf.rows }
      if ($null -ne $expectCount -and $expectCount -ne $imp) {
        $stop = $true; $stopMessage = "$($step.file) の件数が合いません(manifest $($expectCount)$($unit)／取込 $($imp)件)。SMILE を見て判断してください"
      }
    }
  }
  Clear-EcCurrentDir $Def

  # 6. 結果。止まったとき、SMILEの「実行」を押す前なら failed(再実行OK)。押したあと(または不明)は、
  #    取込件数に関係なく partial(要確認。再実行しない)
  if (-not $stop) { $state = 'done'; $message = ''; $executed = $true }
  elseif ($executed) { $state = 'partial'; $message = $stopMessage }
  else { $state = 'failed'; $message = $stopMessage }
  Write-ImportResult $batchDir $batchId $state $message $files $startedAt $executed | Out-Null
  Move-ImportBatch $batchId $(if ($state -eq 'done') { 'done' } else { 'failed' })
  return [pscustomobject]@{ State = $state; Message = $message }
}

# 取込のあと、確認用の出力(ec_smile_verify_export)を依頼に追加する(アプリが待たなくてよいように)
function Add-VerifyRequest([string]$Job, [string]$RequestedBy) {
  $exists = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*_$($Job)_*.json" -File -ErrorAction SilentlyContinue)
  if ($exists.Count -gt 0) { return }
  $rand = [Guid]::NewGuid().ToString('N').Substring(0, 4)
  $name = '{0}_{1}_{2}.json' -f (Get-Date).ToUniversalTime().ToString('yyyyMMdd\THHmmssfff\Z'), $Job, $rand
  Write-JsonFile (Join-Path $PendingDir $name) ([pscustomobject]@{
    job = $Job; requestedBy = $RequestedBy; requestedAt = (Get-Date).ToUniversalTime().ToString('o'); app = 'EC売上(取込のあとの確認)'
  })
  Write-Log "確認用の出力を依頼に追加しました: $name"
}

# 待っている依頼を1件(同じジョブはまとめて。取込ジョブはまとめず1件ずつ)実行する。実行したら $true を返す。
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

  # ジョブ定義(取込ジョブかどうかを先に知る)。取得できなければ従来どおり(失敗は実行時に記録される)
  $defs = $null
  try { $defs = Get-JobDefinitions } catch { Write-Log "ジョブ定義を読めません: $($_.Exception.Message)" }
  $isImport = [bool]($defs -and $defs.jobs.$jobName -and $defs.jobs.$jobName.type -eq 'import')
  $isNotify = [bool]($defs -and $defs.jobs.$jobName -and $defs.jobs.$jobName.type -eq 'notify')

  # 同じジョブの依頼をまとめて実行中にする(取込は依頼ごとに別の仕事なので、先頭の1件だけ)
  $batch = @()
  foreach ($item in $items) {
    if (($isImport -or $isNotify) -and $batch.Count -ge 1) { break }   # 取込・報告は依頼ごとに別の仕事なので、1件ずつ
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
  Update-Heartbeat $jobName -Force

  $errorMessage = $null
  $importDone = $false
  try {
    $defs = Get-JobDefinitions
    $def = $defs.jobs.$jobName
    if (-not $def) { throw "未定義のジョブです: $jobName" }
    if ($def.type -eq 'import') {
      # SMILEに取り込むジョブ。SMILEが閉じていれば、確認(管理者・二重取込・中身)のあとで起動してから、取込のPADフローを順に動かす
      # (権限のない依頼でSMILEを起動しない。起動に失敗しても result.json を書いて failed へ移す)
      $smileCfg = $null
      if ($defs.smile -and $def.needsSmile -ne $false) { $smileCfg = $defs.smile }
      # 完了の判断は result.json(Invoke-EcImport が必ず書く)。失敗・一部だけ入った場合も記録に理由を残す
      $out = Invoke-EcImport $def $running[0].Request $smileCfg
      if ($out.State -eq 'done') { $importDone = $true }
      else { $errorMessage = "$($out.State): $($out.Message)" }
    } elseif ($def.type -eq 'notify') {
      # Teams への報告。SMILE も PAD も使わない
      Invoke-Notify $def $running[0].Request
    } else {
      if ($def.after -and $AfterJobs -notcontains [string]$def.after) { throw "未対応の後処理です: $($def.after)" }
      $steps = @(Get-JobSteps $def)
      # PADフローを動かすジョブは、SMILEを使わないと書いたもの(needsSmile: false)以外、先にSMILEを起動しておく
      if ($steps.Count -gt 0 -and $defs.smile -and $def.needsSmile -ne $false) { Ensure-Smile $defs.smile }
      for ($i = 0; $i -lt $steps.Count; $i++) {
        try {
          Invoke-PadFlow $steps[$i]
        } catch {
          # 複数手順のジョブは、どの手順で止まったかを残す
          if ($steps.Count -gt 1) { throw ("手順{0}/{1}（{2}）: {3}" -f ($i + 1), $steps.Count, $steps[$i].flow, $_.Exception.Message) }
          throw
        }
      }
      if ($def.after) { Invoke-After ([string]$def.after) }
    }
  } catch {
    $errorMessage = $_.Exception.Message
    # 取込の依頼が Invoke-EcImport に入る前に落ちたとき(ジョブ定義を取れない等)も、result.json を書いて取込フォルダを残さない(SMILEには触っていない)
    if (-not $isNotify -and ($isImport -or [string]$running[0].Request.batchId)) {
      try { Complete-ImportWithoutResult ([string]$running[0].Request.batchId) 'failed' ("取込を始める前にエラーが出ました(SMILEには触っていません): " + $errorMessage) $false } catch { Write-Log "result.json を書けませんでした: $($_.Exception.Message)" }
    }
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
  if ($importDone -and $def.then) {
    try { Add-VerifyRequest ([string]$def.then) ([string]$running[0].Request.requestedBy) } catch { Write-Log "確認用の出力を依頼に追加できませんでした: $($_.Exception.Message)" }
  }
  Update-Heartbeat -Force
  if ($errorMessage) { Write-Log "エラー: ジョブ $jobName が失敗しました: $errorMessage" }
  else { Write-Log "ジョブが完了しました: $jobName" }
  return $true
}

# 定時のジョブ(rpa_jobs.json の schedules)を確認するときのジョブ定義。
# 30秒ごとにGitHubへ取りに行かないよう、10分間は前回の内容を使う。
function Get-JobDefinitionsCached {
  if (-not $script:JobDefsCache -or ((Get-Date) - $script:JobDefsCachedAt).TotalMinutes -ge 10) {
    $script:JobDefsCache = Get-JobDefinitions
    $script:JobDefsCachedAt = Get-Date
  }
  return $script:JobDefsCache
}

# schedules の時刻を過ぎていて、今日まだ依頼していなければ、そのジョブを自分で依頼する。
# PCが止まっていて時刻を過ぎた場合も、その日のうちに起動すれば依頼する(取りこぼし防止)。
function Invoke-Schedules {
  $schedules = @((Get-JobDefinitionsCached).schedules | Where-Object { $_ })
  if ($schedules.Count -eq 0) { return }
  $state = [pscustomobject]@{}
  if (Test-Path -LiteralPath $ScheduleStatePath) {
    try { $state = Read-JsonFile $ScheduleStatePath } catch { $state = [pscustomobject]@{} }
  }
  $now = Get-Date
  $today = $now.ToString('yyyy-MM-dd')
  foreach ($s in $schedules) {
    try { $at = [datetime]::ParseExact([string]$s.time, 'HH:mm', $null) } catch {
      # 30秒ごとに同じ警告を出し続けないよう、1つの書き間違いにつき1回だけログに残す
      $badKey = "$($s.job)@$($s.time)"
      if (-not $script:BadScheduleLogged.ContainsKey($badKey)) {
        $script:BadScheduleLogged[$badKey] = $true
        Write-Log "定時の時刻が読めません(HH:mm で書く): job=$($s.job) time=$($s.time)"
      }
      continue
    }
    if ($now -lt $at) { continue }
    $key = "$($s.job)@$($s.time)"
    if ($state.$key -eq $today) { continue }
    # 末尾は定時の時刻(同じ瞬間に複数の定時を依頼しても名前が重ならないように)
    $name = '{0}_{1}_s{2}.json' -f $now.ToUniversalTime().ToString('yyyyMMdd\THHmmssfff\Z'), $s.job, $at.ToString('HHmm')
    Write-JsonFile (Join-Path $PendingDir $name) ([pscustomobject]@{
      job = [string]$s.job
      app = 'RPA専用機の定時実行'
      requestedBy = "定時 $($s.time)"
      requestedAt = $now.ToUniversalTime().ToString('o')
    })
    Set-Props $state @{ $key = $today }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ScheduleStatePath) | Out-Null
    Write-JsonFile $ScheduleStatePath $state
    Write-Log "定時のジョブを依頼しました: $($s.job) ($($s.time))"
  }
}

# 前回、実行中のまま止まった依頼は失敗扱いにする(どこまで進んだか分からないため)
function Resolve-InterruptedJobs {
  foreach ($item in @(Get-ChildItem -LiteralPath $RunningDir -Filter '*.json' -File)) {
    Write-Log "前回の実行中に停止した依頼を失敗扱いにします: $($item.Name)"
    # SMILEへの取込は、どこまで入ったか分からない。result.json(partial・executed は不明)を書いて failed へ移し、
    # 取込フォルダを _rpa_import 直下に残さない(残すと、もう一度押したときに取り込めてしまう)。固定フォルダの中身も消す
    try {
      $req = Read-JsonFile $item.FullName
      $importDef = $null
      try { $importDef = (Get-JobDefinitions).jobs.([string]$req.job) } catch { }
      if (([string]$req.batchId) -and (($importDef -and $importDef.type -eq 'import') -or -not $importDef)) {
        Complete-ImportWithoutResult ([string]$req.batchId) 'partial' 'RPA専用機の常駐スクリプトが取込の途中で停止したため、SMILEにどこまで入ったか不明です。SMILE を見て判断してください' $null
        Clear-EcCurrentDir $importDef
      }
    } catch { Write-Log "中断された取込の記録を書けませんでした: $($_.Exception.Message)" }
    Move-QueueItem $item.FullName $FailedDir @{ status = 'failed'; finishedAt = (Get-Date).ToString('o'); error = 'RPA専用機の監視スクリプトが実行中に停止したため中断しました。必要ならもう一度依頼してください' } | Out-Null
  }
}

function Remove-OldItems {
  $limit = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem -LiteralPath $DoneDir, $FailedDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $limit } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

# 取込ファイルにはお客様の名前・住所・電話が入っているので、done / failed に移して30日たったら消す。
# 依頼されないまま残った取込フォルダも、30日たったら消す
function Remove-OldImports {
  if (-not (Test-Path -LiteralPath $ImportRoot)) { return }
  $limit = (Get-Date).AddDays(-$KeepDays)
  foreach ($sub in 'done', 'failed') {
    $dir = Join-Path $ImportRoot $sub
    Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt $limit } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -LiteralPath $ImportRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^ec-[0-9a-f]{16}$' -and $_.LastWriteTime -lt $limit } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# 二重に起動しない(タスクを止めても、起動用の wscript だけが終わって前の常駐スクリプトが
# 残ることがある。2つ同時に動くと同じ依頼を取り合う)。プロセスが終われば自動で解放される。
$script:SingleInstance = New-Object System.Threading.Mutex($false, 'Local\HanaokaRpaQueueWorker')
$owned = $false
try { $owned = $script:SingleInstance.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
  Write-Log "ほかの常駐スクリプトがすでに動いているため、起動を取りやめます (PID $PID)"
  exit 0
}

foreach ($d in $PendingDir, $RunningDir, $DoneDir, $FailedDir) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
Resolve-InterruptedJobs
Remove-OldItems
Remove-OldImports
$lastCleanup = Get-Date
Write-Log "監視を開始します: $QueueRoot"

while ($true) {
  $worked = $false
  Update-Heartbeat
  try {
    Convert-LegacyRequest
    Invoke-Schedules
    $worked = Invoke-NextJob
  } catch {
    Write-Log "エラー: $($_.Exception.Message)"
  }
  # 実行した直後は、待っている次の依頼をすぐ確認する
  if (-not $worked) { Start-Sleep -Seconds $PollSeconds }
  if (((Get-Date) - $lastCleanup).TotalHours -ge 1) {
    Remove-OldItems
    Remove-OldImports
    $lastCleanup = Get-Date
  }
}
