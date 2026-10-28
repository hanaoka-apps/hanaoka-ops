# 常駐スクリプト(scripts/rpa_queue_worker.ps1)の「新しい納品先の番号を専用機で決める」動作確認。
# 使い方: powershell -File tests/test_rpa_worker_assign.ps1 [-Repo <リポジトリ>] [-Scratch <作業フォルダ>]
# 失敗が0なら OK。node は不要(模擬の取込ファイルはこの中で作る。実データなし)。PAD・SMILE・OneDrive は使わない。
param([string]$Repo = (Split-Path $PSScriptRoot -Parent), [string]$Scratch = (Join-Path $env:TEMP "ec_worker_assign_test_$PID"))
$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $Repo 'scripts\rpa_queue_worker.ps1'
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($workerPath, [ref]$tokens, [ref]$errs)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $f.Extent.Text }
# スクリプト冒頭の設定のうち、ここで使うもの
$EcDeliveryTempPattern = '^N\d{5}$'; $EcDeliveryCodeColumn = '納品先コード'; $EcCustomerColumn = '得意先コード'

New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
$SharedMastersPath = Join-Path $Scratch 'sm'; if (Test-Path $SharedMastersPath) { Remove-Item $SharedMastersPath -Recurse -Force }
$ImportRoot = Join-Path $SharedMastersPath '_rpa_import'; $QueueRoot = Join-Path $SharedMastersPath '_rpa_queue'; $PendingDir = Join-Path $QueueRoot 'pending'
New-Item -ItemType Directory -Force -Path $ImportRoot, $PendingDir | Out-Null
$ImportAdminsPath = Join-Path $QueueRoot 'ec_import_admins.json'
$EcImportCurrentDir = Join-Path $Scratch 'current'; $WorkDir = Join-Path $Scratch 'work'
$LogPath = Join-Path $Scratch 'test.log'; $KeepDays = 30; $RepoRawBase = 'http://127.0.0.1:9/none'
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText($ImportAdminsPath, '{"admins":["admin@example.com"]}', $utf8)
Copy-Item (Join-Path $Repo 'ec_sales_config.json') (Join-Path $SharedMastersPath 'ec_sales_config.json')
$def = (Get-Content -LiteralPath (Join-Path $Repo 'scripts\rpa_jobs.json') -Raw -Encoding UTF8 | ConvertFrom-Json).jobs.ec_smile_import

$fail = 0
function Check([string]$name, $cond) { if ($cond) { Write-Host "OK  $name" } else { Write-Host "NG  $name"; $script:fail++ } }
function Req([string]$id) { return [pscustomobject]@{ job = 'ec_smile_import'; requestedBy = 'admin@example.com'; batchId = $id } }
function Result([string]$id, [string]$where) { return (Get-Content -LiteralPath (Join-Path $ImportRoot "$where\$id\result.json") -Raw -Encoding UTF8 | ConvertFrom-Json) }

# ----- 模擬の取込ファイル(見出しは必要な列だけ名前を付け、残りは「列n」) -----
function Head([int]$n, [string[]]$names) { $h = @(); for ($i = 0; $i -lt $n; $i++) { $h += $(if ($i -lt $names.Count) { $names[$i] } else { "列$i" }) }; return $h }
$nHead = Head 42 @('得意先コード', '納品先コード', '納品先名', '納品先索引')
$jHead = Head 121 @('受注№', '得意先コード', '納品先コード', '品目コード', '数量', '納期', '備考')
function Row([string[]]$head, [hashtable]$v) { return (($head | ForEach-Object { if ($v.ContainsKey($_)) { $v[$_] } else { '' } }) -join "`t") }
function Utf16([string[]]$lines) { return ([byte[]](0xFF, 0xFE) + [Text.Encoding]::Unicode.GetBytes(($lines -join "`r`n") + "`r`n")) }
$script:seq = 0
function Make-Batch($nouhinRows, $juchuRows) {
  $script:seq++
  $id = 'ec-' + ('{0:x16}' -f ([int64]0x1000 + $script:seq))
  $dir = Join-Path $ImportRoot $id; New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $files = @()
  if (@($nouhinRows).Count -gt 0) {
    $b = Utf16 (@($nHead -join "`t") + @($nouhinRows | ForEach-Object { Row $nHead $_ })); [IO.File]::WriteAllBytes((Join-Path $dir 'nouhin.txt'), $b)
    $files += [ordered]@{ name = 'nouhin.txt'; rows = @($nouhinRows).Count; sha256 = (Get-FileHash (Join-Path $dir 'nouhin.txt') -Algorithm SHA256).Hash.ToLower() }
  }
  $b = Utf16 (@($jHead -join "`t") + @($juchuRows | ForEach-Object { Row $jHead $_ })); [IO.File]::WriteAllBytes((Join-Path $dir 'juchu.txt'), $b)
  $slips = @($juchuRows | ForEach-Object { $_['受注№'] } | Select-Object -Unique).Count
  $files += [ordered]@{ name = 'juchu.txt'; rows = @($juchuRows).Count; slips = $slips; sha256 = (Get-FileHash (Join-Path $dir 'juchu.txt') -Algorithm SHA256).Hash.ToLower() }
  [IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), ([ordered]@{ batchId = $id; files = $files } | ConvertTo-Json -Depth 5), $utf8)
  return $id
}
function N([string]$cust, [string]$code, [string]$name) { return @{ '得意先コード' = $cust; '納品先コード' = $code; '納品先名' = $name; '納品先索引' = 'ﾃｽﾄ' } }
function J([string]$no, [string]$cust, [string]$code, [string]$item = 'FR') { return @{ '受注№' = $no; '得意先コード' = $cust; '納品先コード' = $code; '品目コード' = $item; '数量' = '1'; '納期' = '20261030'; '備考' = 'N00001' } }

# ----- 模擬の ec_smile_index.json(納品先だけ) -----
function Write-Index($rows) {
  $o = [ordered]@{ generatedAt = '2026-10-23T00:00:00Z'; nouhin = [ordered]@{ cols = @('得意先コード', '納品先コード', '納品先名'); rows = @($rows); maxCode = @{} } }
  [IO.File]::WriteAllText((Join-Path $SharedMastersPath 'ec_smile_index.json'), ($o | ConvertTo-Json -Depth 6), $utf8)
}
Write-Index @(, @('599802', '000769', 'A'), @('599802', '000770', 'B'), @('599802', '001000', '予約'), @('599802', '999998', 'テスト'), @('599801', '000998', 'C'), @('599801', '000999', 'D'))

# ----- PADの模擬：呼ばれるたびに、置かれた 納品先.txt / 受注.txt の納品先コードを記録し、計画どおりの結果を返す -----
$script:padCalls = @(); $script:seen = @(); $script:nouhinPlan = @(); $script:nouhinIdx = 0
function Codes([string]$path) { $t = Read-ImportTable $path; $di = [Array]::IndexOf([string[]]$t.Head, '納品先コード'); return (@($t.Rows | ForEach-Object { $_[$di] }) -join ',') }
function Invoke-PadImportStep([string]$Flow, [string]$ResultPath, [int]$TimeoutMinutes) {
  $script:padCalls += $Flow
  if ($Flow -eq 'Smile_EC納品先取込') {
    $script:seen += 'N:' + (Codes (Join-Path $EcImportCurrentDir '納品先.txt'))
    $p = $(if ($script:nouhinIdx -lt $script:nouhinPlan.Count) { $script:nouhinPlan[$script:nouhinIdx] } else { 'ok' }); $script:nouhinIdx++
    if ($p -eq 'conflict') { return [pscustomobject]@{ executed = $false; imported = 0; errors = 1; errorCount = 1; existsCount = 1; errorRows = @(@{ row = 0; message = 'エラーチェック: 納品先が存在します' }) } }
    if ($p -eq 'other') { return [pscustomobject]@{ executed = $false; imported = 0; errors = 1; errorCount = 2; existsCount = 1; errorRows = @(@{ row = 0; message = 'エラーチェック: 不備あり' }) } }
    $n = (Read-ImportTable (Join-Path $EcImportCurrentDir '納品先.txt')).Rows.Count
    return [pscustomobject]@{ executed = $true; imported = $n; errors = 0; errorRows = @() }
  }
  $jp = Join-Path $EcImportCurrentDir '受注.txt'
  $script:seen += 'J:' + (Codes $jp)
  $t = Read-ImportTable $jp; $si = [Array]::IndexOf([string[]]$t.Head, '受注№')
  return [pscustomobject]@{ executed = $true; imported = @($t.Rows | ForEach-Object { $_[$si] } | Select-Object -Unique).Count; errors = 0; errorRows = @() }
}
function Reset([string[]]$plan = @()) { $script:padCalls = @(); $script:seen = @(); $script:nouhinPlan = @($plan); $script:nouhinIdx = 0 }

# 1. 仮の番号なし(既存の納品先だけ)：今までどおり。assigned は書かない
Reset
$id = Make-Batch @() @((J '1' '599802' '000770'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'done'
Check '1 仮の番号なし: done・受注だけ起動・コードはそのまま' ($r.State -eq 'done' -and ($script:padCalls -join ',') -eq 'Smile_EC受注取込' -and $script:seen[0] -eq 'J:000770')
Check '1 仮の番号なし: result.json に assigned・retries が無い・assigned\ も無い' (-not ($res.PSObject.Properties.Name -contains 'assigned') -and -not (Test-Path (Join-Path $ImportRoot "done\$id\assigned")))

# 2. 仮の番号あり：得意先ごとに空いている番号へ置き換える(予約・999998 は連番に数えない)。受注も同じ番号に
Reset
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様1'), (N '599801' 'N00002' '新しいお客様2')) @((J '1' '599802' 'N00001'), (J '1' '599802' 'N00001'), (J '2' '599801' 'N00002'), (J '3' '599802' '000769'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'done'
Check '2 置き換え: done' ($r.State -eq 'done')
Check '2 置き換え: 599802 は 000771、599801 は予約の 001000 を飛ばして 001001' ($script:seen[0] -eq 'N:000771,001001')
Check '2 置き換え: 受注の納品先コードも同じ番号に(既存の 000769 はそのまま)' ($script:seen[1] -eq 'J:000771,000771,001001,000769')
Check '2 結果: assigned に 得意先・仮の番号・番号、retries は 0' (@($res.assigned).Count -eq 2 -and $res.assigned[0].customer -eq '599802' -and $res.assigned[0].temp -eq 'N00001' -and $res.assigned[0].code -eq '000771' -and $res.assigned[1].code -eq '001001' -and $res.retries -eq 0)
$aj = Read-ImportTable (Join-Path $ImportRoot "done\$id\assigned\juchu.txt"); $oj = Read-ImportTable (Join-Path $ImportRoot "done\$id\juchu.txt")
Check '2 置き換えたファイルは assigned\ に残り、元のファイルはそのまま(sha256 の確認用)' ($oj.Rows[0][2] -eq 'N00001' -and $aj.Rows[0][2] -eq '000771')
Check '2 納品先コードの列だけを置き換える(備考の「N00001」・列数・行数はそのまま)' ($aj.Rows[0][6] -eq 'N00001' -and $aj.Head.Count -eq 121 -and $aj.Rows.Count -eq 4)
Check '2 固定フォルダは空' (-not (Test-Path (Join-Path $EcImportCurrentDir '納品先.txt')) -and -not (Test-Path (Join-Path $EcImportCurrentDir '受注.txt')))

# 3. 番号がぶつかった(エラーが全部「納品先が存在します」)→ 番号を進めて、受注を起動する前にやり直す
Reset @('conflict', 'conflict', 'ok')
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'done'
Check '3 ぶつかり2回のあと成功: done・retries 2' ($r.State -eq 'done' -and $res.retries -eq 2)
Check '3 納品先は 000771→000772→000773 と進み、受注は最後の番号で1回だけ' (($script:seen -join ' ') -eq 'N:000771 N:000772 N:000773 J:000773' -and ($script:padCalls -join ',') -eq 'Smile_EC納品先取込,Smile_EC納品先取込,Smile_EC納品先取込,Smile_EC受注取込')
Check '3 assigned は最後に使った番号' ($res.assigned[0].code -eq '000773')

# 4. 10回やり直してもぶつかる → 実行前に止まった扱い(failed・executed:false)。受注は起動しない
Reset; $script:nouhinPlan = @(1..20 | ForEach-Object { 'conflict' })
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'failed'
Check '4 やり直しの上限: failed・executed:false・retries 10' ($r.State -eq 'failed' -and $res.executed -eq $false -and $res.retries -eq 10)
Check '4 納品先は 1+10 回、受注は起動しない' (@($script:padCalls | Where-Object { $_ -eq 'Smile_EC納品先取込' }).Count -eq 11 -and -not ($script:padCalls -contains 'Smile_EC受注取込'))
Check '4 理由: 番号がぶつかった・やり直した回数' ($res.message -match '既存の番号とぶつかりました' -and $res.message -match '10 回やり直しました')

# 5. ほかのエラーもある(エラー件数と「存在します」の件数が違う)→ やり直さず止める
Reset @('other')
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'failed'
Check '5 ほかのエラー: やり直さない(納品先1回だけ)・failed・executed:false・retries 0' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 1 -and $res.executed -eq $false -and $res.retries -eq 0 -and $res.message -notmatch 'ぶつかりました')

# 6. 受注の仮の番号が納品先にない → SMILEに触らず failed
Reset
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00002'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'failed'
Check '6 受注の仮の番号が納品先にない: failed・SMILEに触らない' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 0 -and $res.executed -eq $false -and $res.message -match 'nouhin\.txt にありません')
Check '6 失敗のときは assigned を書かない' (-not ($res.PSObject.Properties.Name -contains 'assigned'))

# 7. 置き換えが漏れた(仮の番号が残った)→ SMILEに進まない
Reset
$realWrite = ${function:Write-AssignedImportFile}
function Write-AssignedImportFile([string]$Src, [string]$Dst, $Plan) { Copy-Item -LiteralPath $Src -Destination $Dst -Force }
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id); $res = Result $id 'failed'
Set-Item Function:\Write-AssignedImportFile $realWrite
Check '7 仮の番号が残った: failed・SMILEに触らない・理由' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 0 -and $res.executed -eq $false -and $res.message -match '仮の番号が 1 行残っています')

# 8. ec_smile_index.json が無い → SMILEに触らず failed
Reset
Move-Item (Join-Path $SharedMastersPath 'ec_smile_index.json') (Join-Path $Scratch 'index.bak') -Force
$id = Make-Batch @((N '599802' 'N00001' '新しいお客様')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id)
Move-Item (Join-Path $Scratch 'index.bak') (Join-Path $SharedMastersPath 'ec_smile_index.json') -Force
Check '8 索引が無い: failed・SMILEに触らない' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 0 -and $r.Message -match '納品先の番号を決められませんでした')

# 9. 同じ仮の番号が納品先に2行 → failed
Reset
$id = Make-Batch @((N '599802' 'N00001' 'A'), (N '599802' 'N00001' 'B')) @((J '1' '599802' 'N00001'))
$r = Invoke-EcImport $def (Req $id)
Check '9 同じ仮の番号が2行: failed・SMILEに触らない' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 0 -and $r.Message -match '同じ仮の番号が2行')

# 10. 判定の部品
Check '10 ぶつかり判定: executed:false・エラー件数=存在します件数>0 のときだけ' ((Test-DeliveryCodeConflict ([pscustomobject]@{ executed = $false; errorCount = 2; existsCount = 2 })) -and -not (Test-DeliveryCodeConflict ([pscustomobject]@{ executed = $false; errorCount = 2; existsCount = 1 })) -and -not (Test-DeliveryCodeConflict ([pscustomobject]@{ executed = $true; errorCount = 1; existsCount = 1 })) -and -not (Test-DeliveryCodeConflict ([pscustomobject]@{ executed = $false; errorCount = 0; existsCount = 0 })) -and -not (Test-DeliveryCodeConflict ([pscustomobject]@{ executed = $false; errors = 1 })))
$plan = New-DeliveryCodePlan @([pscustomobject]@{ customer = '599803'; temp = 'N00001' }) (Read-JsonFile (Join-Path $SharedMastersPath 'ec_smile_index.json')) (Read-JsonFile (Join-Path $SharedMastersPath 'ec_sales_config.json')) @{}
Check '10 索引にまだ無い得意先は 000001 から' ($plan[0].code -eq '000001')

# 11. 稼働の印(heartbeat.json)の features：専用機の中のファイルがあるときだけ、知っている機能名だけを書く
$KnownWorkerFeatures = @('tempDeliveryCodes')
$HeartbeatPath = Join-Path $Scratch 'heartbeat.json'; $WorkerFeaturesPath = Join-Path $Scratch 'features.json'
function HB { Update-Heartbeat '' -Force; return (Get-Content -LiteralPath $HeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
$hb = HB
Check '11 ファイルなし: features を書かない' (-not ($hb.PSObject.Properties.Name -contains 'features') -and $hb.updatedAt)
[IO.File]::WriteAllText($WorkerFeaturesPath, '{"features":["tempDeliveryCodes","unknownFeature"]}', $utf8)
$hb = HB
Check '11 ファイルあり: 知っている機能だけを書く' (@($hb.features).Count -eq 1 -and $hb.features[0] -eq 'tempDeliveryCodes')
[IO.File]::WriteAllText($WorkerFeaturesPath, '{ こわれた', $utf8)
$hb = HB
Check '11 ファイルが壊れていても印は書く(features なし)' (-not ($hb.PSObject.Properties.Name -contains 'features') -and $hb.updatedAt)
Remove-Item $WorkerFeaturesPath -Force; $hb = HB
Check '11 ファイルを消せば features が消える' (-not ($hb.PSObject.Properties.Name -contains 'features'))

Remove-Item $Scratch -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "失敗: $fail"
if ($fail -gt 0) { exit 1 }
