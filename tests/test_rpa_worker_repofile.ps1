# 常駐スクリプト(scripts/rpa_queue_worker.ps1)の「リポジトリのファイルを取り出す」動作確認（Get-RepoFile）。
# 使い方: powershell -File tests/test_rpa_worker_repofile.ps1 [-Repo <リポジトリ>] [-Scratch <作業フォルダ>]
# 失敗が0なら OK。git が要る。インターネット・GitHub・OneDrive は使わない（手元に作った架空のリポジトリだけ）。
param([string]$Repo = (Split-Path $PSScriptRoot -Parent), [string]$Scratch = (Join-Path $env:TEMP "rpa_repofile_test_$PID"))
$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $Repo 'scripts\rpa_queue_worker.ps1'
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($workerPath, [ref]$tokens, [ref]$errs)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $f.Extent.Text }

$fail = 0
function Check([string]$name, $cond) { if ($cond) { Write-Host "OK  $name" } else { Write-Host "NG  $name"; $script:fail++ } }
function Run-Git([string]$dir) { $a = $args; $ErrorActionPreference = 'Continue'; & git.exe -C $dir @a 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $a failed in $dir" } }

if (Test-Path $Scratch) { Remove-Item $Scratch -Recurse -Force }
# 複製の置き場所は、本番と同じく日本語と空白を含む名前にする
$base = Join-Path $Scratch 'OneDrive - 花岡 テスト'
$origin = Join-Path $base 'origin.git'; $work = Join-Path $base 'work'; $clone = Join-Path $base 'clone repo'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$ErrorActionPreference = 'Continue'; & git.exe init -q --bare -b main $origin 2>&1 | Out-Null
Run-Git $work init -q -b main
Run-Git $work config user.email 'test@example.com'
Run-Git $work config user.name 'テスト'
Run-Git $work config core.autocrlf false
New-Item -ItemType Directory -Force -Path (Join-Path $work 'scripts') | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
$py1 = "print('架空の1版目')`n"
[IO.File]::WriteAllText((Join-Path $work 'scripts\job.py'), $py1, $utf8)
[IO.File]::WriteAllText((Join-Path $work 'scripts\rpa_jobs.json'), "{`"jobs`":{}}`n", $utf8)
[IO.File]::WriteAllText((Join-Path $work 'conf.json'), "{`"name`":`"架空`"}`r`n", $utf8)
Run-Git $work add -A
Run-Git $work commit -q -m first
Run-Git $work remote add origin $origin
Run-Git $work push -q origin main
& git.exe clone -q $origin $clone 2>&1 | Out-Null; $ErrorActionPreference = 'Stop'

$LogPath = Join-Path $Scratch 'test.log'; $WorkDir = Join-Path $Scratch 'out'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$RepoRawBase = 'http://127.0.0.1:9/none'      # 予備の raw は届かない場所にする（複製から取れることを確かめるため）
$RepoFetchSeconds = 60
$RepoRoot = $clone
$script:RepoFetchedAt = [datetime]::MinValue

# 1. 複製の main から、そのまま取り出せる（改行・日本語を変えない）
$o = Join-Path $WorkDir 'job.py'
Get-RepoFile 'scripts/job.py' $o
Check '取り出した中身が main と同じ（LF・日本語）' ([IO.File]::ReadAllText($o, $utf8) -eq $py1)
$o2 = Join-Path $WorkDir 'conf.json'
Get-RepoFile 'conf.json' $o2
Check 'CRLF のファイルも変わらない' ([IO.File]::ReadAllBytes($o2).Length -eq $utf8.GetBytes("{`"name`":`"架空`"}`r`n").Length)
$o3 = Join-Path $WorkDir 'jobs.json'
Get-RepoFile 'scripts\rpa_jobs.json' $o3
Check '区切りが \ でも取り出せる' (Test-Path $o3)

# 2. GitHub（ここでは origin）に新しい版が入ったら、取り込んでから取り出す
$py2 = "print('架空の2版目')`n"
[IO.File]::WriteAllText((Join-Path $work 'scripts\job.py'), $py2, $utf8)
Run-Git $work commit -q -am second
Run-Git $work push -q origin main
$script:RepoFetchedAt = [datetime]::MinValue
Get-RepoFile 'scripts/job.py' $o
Check '新しい版を取り込んでから取り出す' ([IO.File]::ReadAllText($o, $utf8) -eq $py2)

# 3. 取り込みの間隔の中では、取りに行かない（前回取り込んだ main を使う）
$py3 = "print('架空の3版目')`n"
[IO.File]::WriteAllText((Join-Path $work 'scripts\job.py'), $py3, $utf8)
Run-Git $work commit -q -am third
Run-Git $work push -q origin main
Get-RepoFile 'scripts/job.py' $o
Check '間隔の中では前回の main を使う' ([IO.File]::ReadAllText($o, $utf8) -eq $py2)

# 4. 取り込みに失敗しても（GitHub に届かない）、前回取り込んだ main で動く
Run-Git $clone remote set-url origin (Join-Path $base 'no-such.git')
$script:RepoFetchedAt = [datetime]::MinValue
Get-RepoFile 'scripts/job.py' $o
Check '取り込めなくても前回の main で動く' ([IO.File]::ReadAllText($o, $utf8) -eq $py2)
Check '取り込めなかったことをログに残す' ((Get-Content -LiteralPath $LogPath -Raw) -match 'main を取り込めませんでした')   # ログは Add-Content の既定の文字コードで書かれる

# 5. main に無いファイル・複製が無いときは、予備の raw を試し、それも届かなければ例外（呼ぶ側の予備の動きに任せる）
$threw = $false
try { Get-RepoFile 'scripts/none.py' (Join-Path $WorkDir 'none.py') } catch { $threw = $true }
Check 'main に無いファイルは例外' $threw
Check '失敗したときに空のファイルを残さない' (-not (Test-Path (Join-Path $WorkDir 'none.py')))
$RepoRoot = ''
$threw = $false
try { Get-RepoFile 'scripts/job.py' (Join-Path $WorkDir 'x.py') } catch { $threw = $true }
Check '複製が無いときは raw を試す（届かなければ例外）' $threw

Remove-Item $Scratch -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -eq 0) { Write-Host 'すべて OK' } else { Write-Host "失敗 $fail 件"; exit 1 }
