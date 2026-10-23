# 常駐スクリプト(scripts/rpa_queue_worker.ps1)の取込ジョブの動作確認。使い方: powershell -File tests/test_rpa_worker_import.ps1 [-Repo <リポジトリ>] [-Scratch <作業フォルダ>]
# 失敗が0なら OK。node が必要(模擬の取込ファイルを tests/ec_import_batch_maker.cjs で作る)。
param([string]$Repo = (Split-Path $PSScriptRoot -Parent), [string]$Scratch = (Join-Path $env:TEMP "ec_worker_test_$PID"))
# 常駐スクリプトの取込まわりの関数だけを取り出して、一時フォルダで動かす（PAD・SMILE・OneDrive は使わない。PADは模擬）
$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $Repo 'scripts\rpa_queue_worker.ps1'
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($workerPath, [ref]$tokens, [ref]$errs)
$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($f in $funcs) { Invoke-Expression $f.Extent.Text }

New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
$T = Join-Path $Scratch 'sm'; if (Test-Path $T) { Remove-Item $T -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $T '_rpa_queue\pending'), (Join-Path $T '_rpa_import') | Out-Null
$ImportRoot = Join-Path $T '_rpa_import'; $QueueRoot = Join-Path $T '_rpa_queue'; $PendingDir = Join-Path $QueueRoot 'pending'
$ImportAdminsPath = Join-Path $QueueRoot 'ec_import_admins.json'
$EcImportCurrentDir = Join-Path $Scratch 'current'
$LogPath = Join-Path $Scratch 'test.log'; $KeepDays = 30
[System.IO.File]::WriteAllText($ImportAdminsPath, '{"admins":["Admin@Example.com"]}', (New-Object System.Text.UTF8Encoding $false))
$def = (Get-Content -LiteralPath (Join-Path $Repo 'scripts\rpa_jobs.json') -Raw -Encoding UTF8 | ConvertFrom-Json).jobs.ec_smile_import

# PADの模擬：コピーされたファイルがあれば、設定したとおりの result_*.json を書く
$script:padCalls = @()
$script:padPlan = @{ 'Smile_EC納品先取込' = @{ imported = 1; errors = 0 }; 'Smile_EC受注取込' = @{ imported = 1; errors = 0 } }
function Invoke-PadImportStep([string]$Flow, [string]$ResultPath, [int]$TimeoutMinutes) {
  $script:padCalls += $Flow
  $p = $script:padPlan[$Flow]
  if ($p -eq 'timeout') { return $null }
  $rows = @(); if ($p.errors -gt 0) { $rows = @(@{ row = 5; message = 'テストのエラー' }) }
  $obj = @{ errors = $p.errors; errorRows = $rows }
  if ($p.ContainsKey('imported')) { $obj.imported = $p.imported }   # 無ければ「件数を取れない旧形式」
  if ($p.ContainsKey('errorRows')) { $obj.errorRows = $p.errorRows }
  if ($p.ContainsKey('executed')) { $obj.executed = $p.executed }   # 無ければ旧形式（executed なし）
  return ([pscustomobject]$obj)
}

function Make-Batch([string]$mode) {
  $id = (& node (Join-Path $PSScriptRoot 'ec_import_batch_maker.cjs') $Repo $ImportRoot $mode).Trim()
  return $id
}
$fail = 0
function Check([string]$name, $cond) { if ($cond) { Write-Host "OK  $name" } else { Write-Host "NG  $name"; $script:fail++ } }
function Req([string]$id, [string]$by) { return [pscustomobject]@{ job = 'ec_smile_import'; requestedBy = $by; batchId = $id } }
function Result([string]$id, [string]$where) { return (Get-Content -LiteralPath (Join-Path $ImportRoot "$where\$id\result.json") -Raw -Encoding UTF8 | ConvertFrom-Json) }

# 1. 正常
$id = Make-Batch 'ok'
$r = Invoke-EcImport $def (Req $id 'admin@example.com')
Check '正常: done' ($r.State -eq 'done')
Check '正常: 納品先→受注の順に起動' (($script:padCalls -join ',') -eq 'Smile_EC納品先取込,Smile_EC受注取込')
$res = Result $id 'done'
Check '正常: result.json が done/ にあり、件数が入る' ($res.state -eq 'done' -and $res.files.Count -eq 2 -and $res.files[1].imported -eq 1 -and $res.batchId -eq $id)
Check '正常: 取込元フォルダは移動済み' (-not (Test-Path (Join-Path $ImportRoot $id)))
# 2. 二重取込（done にある同じ番号）
$null = & node (Join-Path $PSScriptRoot 'ec_import_batch_maker.cjs') $Repo $ImportRoot 'ok'
$script:padCalls = @()
$r = Invoke-EcImport $def (Req $id 'admin@example.com')
Check '二重取込: failed・SMILEに触らない' ($r.State -eq 'failed' -and $r.Message -match '取込済み' -and $script:padCalls.Count -eq 0)
Check '二重取込: done の記録は消えない' ((Result $id 'done').state -eq 'done')
# 3. 管理者でない
$id2 = Make-Batch 'emptyqty'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id2 'other@example.com')
Check '権限なし: failed' ($r.State -eq 'failed' -and $r.Message -match '権限なし' -and $script:padCalls.Count -eq 0)
Check '権限なし: failed/ に result.json' ((Result $id2 'failed').message -match '権限なし')
# 4. 必須項目が空
Remove-Item (Join-Path $ImportRoot "failed\$id2") -Recurse -Force
$id2 = Make-Batch 'emptyqty'
$r = Invoke-EcImport $def (Req $id2 'admin@example.com')
Check '必須が空: ファイル不整合で SMILE に触らない' ($r.State -eq 'failed' -and $r.Message -match '数量' -and $script:padCalls.Count -eq 0)
# 5. sha256 不一致
$id3 = Make-Batch 'v3'; Add-Content -LiteralPath (Join-Path $ImportRoot "$id3\juchu.txt") -Value 'x'
$r = Invoke-EcImport $def (Req $id3 'admin@example.com')
Check 'sha256不一致: failed' ($r.State -eq 'failed' -and $r.Message -match 'sha256' -and $script:padCalls.Count -eq 0)
# 6. バッチ番号が不正（パス混入）
$r = Invoke-EcImport $def (Req '..\..\x' 'admin@example.com')
Check '不正なバッチ番号は受け付けない' ($r.State -eq 'failed' -and $r.Message -match 'バッチ番号')
# 7. 納品先にエラー → 受注は実行しない（取込0件なら failed）
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 2; executed = $false }
$id4 = Make-Batch 'v1'
$script:padCalls = @()
$r = Invoke-EcImport $def (Req $id4 'admin@example.com')
Check '納品先エラー: 受注フローは起動しない・failed' ($r.State -eq 'failed' -and ($script:padCalls -join ',') -eq 'Smile_EC納品先取込')
Check '納品先エラー: errorRows が残る' ((Result $id4 'failed').files[0].errorRows[0].row -eq 5)
Check 'executed:false の failed: result.json の executed が false' ((Result $id4 'failed').executed -eq $false -and (Result $id4 'failed').state -eq 'failed')
# 7b. 同じバッチを再実行：executed:false の failed は許す（今度は成功）
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 1; errors = 0; executed = $true }
$script:padPlan['Smile_EC受注取込'] = @{ imported = 1; errors = 0; executed = $true }
$null = Make-Batch 'v1'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id4 'admin@example.com')
Check '再実行: executed:false の failed は許す → done' ($r.State -eq 'done' -and $script:padCalls.Count -eq 2 -and (Result $id4 'done').executed -eq $true)
Check '再実行: 古い failed の記録は消える' (-not (Test-Path (Join-Path $ImportRoot "failed\$id4")))
# 7c. 押したあと（executed:true）に止まった → 取込0件でも partial。同じバッチの再実行は許さない
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 1; executed = $true }
$id6 = Make-Batch 'v6'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id6 'admin@example.com')
Check '実行後の失敗: partial（再実行させない）' ($r.State -eq 'partial' -and (Result $id6 'failed').executed -eq $true)
$null = Make-Batch 'v6'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id6 'admin@example.com')
Check '実行済みの failed と同じバッチ: SMILEに触らず partial' ($r.State -eq 'partial' -and $script:padCalls.Count -eq 0 -and $r.Message -match '再実行しません')
Check '実行済みの failed の記録は消えない' (Test-Path (Join-Path $ImportRoot "failed\$id6\result.json"))
# 7d. 旧形式（PADの結果に executed なし）→ 実行済み扱いで partial
Remove-Item (Join-Path $ImportRoot "failed\$id6") -Recurse -Force; Remove-Item (Join-Path $ImportRoot $id6) -Recurse -Force -ErrorAction SilentlyContinue
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 1 }
$id7 = Make-Batch 'v7'
$r = Invoke-EcImport $def (Req $id7 'admin@example.com')
Check '旧形式(executed なし): partial で止める' ($r.State -eq 'partial')
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 1; errors = 0; executed = $true }
# 8. 一部だけ入った（納品先OK・受注にエラー）→ partial
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 1; errors = 0 }
$script:padPlan['Smile_EC受注取込'] = @{ imported = 2; errors = 1 }
Remove-Item (Join-Path $ImportRoot "failed\$id4") -Recurse -Force -ErrorAction SilentlyContinue
$id5 = Make-Batch 'v2'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id5 'admin@example.com')
Check '一部だけ: partial' ($r.State -eq 'partial' -and (Result $id5 'failed').state -eq 'partial')
# 9. PADの結果が出ない → partial（SMILEの状態が不明）
$script:padPlan['Smile_EC受注取込'] = 'timeout'
Remove-Item (Join-Path $ImportRoot "failed\$id5") -Recurse -Force
$id5 = Make-Batch 'v2'
$r = Invoke-EcImport $def (Req $id5 'admin@example.com')
Check '結果が出ない: partial で止める' ($r.State -eq 'partial' -and $r.Message -match 'SMILE を見て')
Check '固定フォルダに顧客データを残さない' (-not (Test-Path (Join-Path $EcImportCurrentDir '受注.txt')) -and -not (Test-Path (Join-Path $EcImportCurrentDir '納品先.txt')))
# ===== result.json が書かれないまま終わる3つの経路 =====
$script:smileCalls = 0; $script:smileFail = $false
function Ensure-Smile($Cfg) { $script:smileCalls++; if ($script:smileFail) { throw 'SMILEを5分以内に起動できませんでした' } }
$smileCfg = [pscustomobject]@{ process = 'x' }
$script:padPlan['Smile_EC納品先取込'] = @{ imported = 1; errors = 0; executed = $true }
$script:padPlan['Smile_EC受注取込'] = @{ imported = 1; errors = 0; executed = $true }
# 経路1: SMILEの自動起動に失敗 → SMILEには触っていないので failed・executed:false の result.json
$id8 = Make-Batch 'v8'; $script:padCalls = @(); $script:smileFail = $true
$r = Invoke-EcImport $def (Req $id8 'admin@example.com') $smileCfg
Check '起動失敗: failed・PADは起動しない' ($r.State -eq 'failed' -and $script:padCalls.Count -eq 0 -and $script:smileCalls -eq 1)
$res = Result $id8 'failed'
Check '起動失敗: result.json に executed:false と理由・取込フォルダは残らない' ($res.state -eq 'failed' -and $res.executed -eq $false -and $res.message -match 'SMILEを起動できませんでした' -and -not (Test-Path (Join-Path $ImportRoot $id8)))
# 起動失敗のあと executed:false なので同じバッチを再実行できる
$script:smileFail = $false; $null = Make-Batch 'v8'
$r = Invoke-EcImport $def (Req $id8 'admin@example.com') $smileCfg
Check '起動失敗のあとの再実行: done' ($r.State -eq 'done' -and (Result $id8 'done').executed -eq $true)
# 権限のない依頼ではSMILEを起動しない（確認が先）
$script:smileCalls = 0; $id9 = Make-Batch 'v9'
$r = Invoke-EcImport $def (Req $id9 'other@example.com') $smileCfg
Check '権限なし: SMILEを起動しない' ($r.State -eq 'failed' -and $script:smileCalls -eq 0)
# 二重取込・ファイル不整合でもSMILEを起動しない
$null = Make-Batch 'v8'; $r = Invoke-EcImport $def (Req $id8 'admin@example.com') $smileCfg
Check '二重取込: SMILEを起動しない' ($r.State -eq 'failed' -and $script:smileCalls -eq 0)
$id10 = Make-Batch 'v10'; Add-Content -LiteralPath (Join-Path $ImportRoot "$id10\juchu.txt") -Value 'x'
$r = Invoke-EcImport $def (Req $id10 'admin@example.com') $smileCfg
Check 'ファイル不整合: SMILEを起動しない' ($r.State -eq 'failed' -and $script:smileCalls -eq 0)

# 経路3: Invoke-EcImport の中の予期しない例外
# 3a) PADを起動する前（Copy-Item が失敗）→ failed・executed:false
function Copy-Item { throw 'ファイルが別のプロセスで使用されています' }
$id11 = Make-Batch 'v11'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id11 'admin@example.com')
Remove-Item Function:\Copy-Item
$res = Result $id11 'failed'
Check '例外(起動前): failed・executed:false・理由つき・取込フォルダは残らない' ($r.State -eq 'failed' -and $res.state -eq 'failed' -and $res.executed -eq $false -and $res.message -match '使用されています' -and $script:padCalls.Count -eq 0 -and -not (Test-Path (Join-Path $ImportRoot $id11)))
Check '例外(起動前): 固定フォルダは空' (-not (Test-Path (Join-Path $EcImportCurrentDir '納品先.txt')))
# 3b) 納品先を取り込んだあと、受注の起動で例外 → partial（実行済みの印あり）
$realPad = ${function:Invoke-PadImportStep}
function Invoke-PadImportStep([string]$Flow, [string]$ResultPath, [int]$TimeoutMinutes) {
  $script:padCalls += $Flow
  if ($Flow -eq 'Smile_EC受注取込') { throw 'PADを起動できませんでした' }
  return ([pscustomobject]@{ executed = $true; imported = 1; errors = 0; errorRows = @() })
}
$id12 = Make-Batch 'v12'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id12 'admin@example.com')
$res = Result $id12 'failed'
Check '例外(起動後): partial・executed:true・取込済みの結果を残す' ($r.State -eq 'partial' -and $res.state -eq 'partial' -and $res.executed -eq $true -and $res.message -match 'PADを起動できませんでした' -and $res.files[0].imported -eq 1 -and -not (Test-Path (Join-Path $ImportRoot $id12)))
# 3c) 最初のフローを起動した直後の例外（押したか不明）→ partial・executed のキーなし
function Invoke-PadImportStep([string]$Flow, [string]$ResultPath, [int]$TimeoutMinutes) { $script:padCalls += $Flow; throw 'PADが応答しません' }
$id13 = Make-Batch 'v13'
$r = Invoke-EcImport $def (Req $id13 'admin@example.com')
$res = Result $id13 'failed'
Check '例外(起動直後): partial・executed のキー自体がない(不明)' ($r.State -eq 'partial' -and $res.state -eq 'partial' -and -not ($res.PSObject.Properties.Name -contains 'executed'))
Set-Item Function:\Invoke-PadImportStep $realPad

# ===== PADのステップが「実行」を押す前に止まった／取込件数が合わない（本番の試運転で見つかった不具合） =====
function PlanReset { $script:padPlan['Smile_EC納品先取込'] = @{ imported = 1; errors = 0; executed = $true }; $script:padPlan['Smile_EC受注取込'] = @{ imported = 1; errors = 0; executed = $true } }
$stopRow = @(@{ row = 0; message = '画面を開く(取込画面の待ち): ' })
# (a) 納品先は取り込めたが、受注は取込画面を開く工程で止まり「実行」を押さなかった（executed=false・errorRows に工程）→ done にせず partial
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 0; errors = 0; executed = $false; errorRows = $stopRow }
$ida = Make-Batch 'v20'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $ida 'admin@example.com'); $res = Result $ida 'failed'
Check '(a) 受注が実行前に止まった: done にせず partial' ($r.State -eq 'partial' -and $res.state -eq 'partial' -and -not (Test-Path (Join-Path $ImportRoot "done\$ida")))
Check '(a) 全体の executed は true（納品先は実行済み）・受注の executed は false' ($res.executed -eq $true -and $res.files[0].executed -eq $true -and $res.files[1].executed -eq $false)
Check '(a) 理由：実行を押す前に止まった工程と、納品先は取込済み・受注は未実行' ($res.message -match 'juchu\.txt は SMILE の実行を押す前に止まりました：画面を開く\(取込画面の待ち\)' -and $res.message -match '納品先は取り込み済み、受注は実行されていません')
$null = Make-Batch 'v20'
Check '(a) 同じバッチは再実行させない（executed:true なので partial で止まる）' ((Invoke-EcImport $def (Req $ida 'admin@example.com')).State -eq 'partial')
# (b) 最初のステップ（納品先）が実行前に止まった → failed・executed:false。受注は実行しない。やり直しOK
PlanReset; $script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 0; executed = $false; errorRows = @(@{ row = 0; message = 'ファイルの指定(ダイアログの待ち)' }) }
$idb = Make-Batch 'v21'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $idb 'admin@example.com'); $res = Result $idb 'failed'
Check '(b) 納品先が実行前に止まった: failed・executed:false' ($r.State -eq 'failed' -and $res.state -eq 'failed' -and $res.executed -eq $false)
Check '(b) 受注のフローは起動しない' (($script:padCalls -join ',') -eq 'Smile_EC納品先取込')
Check '(b) 理由に止まった工程が入る' ($res.message -match 'nouhin\.txt は SMILE の実行を押す前に止まりました：ファイルの指定' -and $res.message -notmatch '取り込み済み')
PlanReset; $null = Make-Batch 'v21'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $idb 'admin@example.com')
Check '(b) executed:false の failed は、同じバッチを再実行できる → done' ($r.State -eq 'done' -and $script:padCalls.Count -eq 2)
# (b2) 工程名がない（errorRows が空）でも止める
PlanReset; $script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 0; executed = $false }
$idb2 = Make-Batch 'v22'; $r = Invoke-EcImport $def (Req $idb2 'admin@example.com')
Check '(b2) 工程名がなくても failed・理由は「止まった工程は不明」' ($r.State -eq 'failed' -and $r.Message -match '止まった工程は不明です')
# (c) 実行したのに取込件数が manifest の行数と合わない（0件のまま終わった）→ partial（要確認）
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 0; errors = 0; executed = $true }
$idc = Make-Batch 'v23'
$r = Invoke-EcImport $def (Req $idc 'admin@example.com'); $res = Result $idc 'failed'
Check '(c) 受注の取込件数が合わない: partial・executed:true' ($r.State -eq 'partial' -and $res.executed -eq $true)
Check '(c) 理由に manifest の行数と取込件数が入る' ($res.message -match 'juchu\.txt の件数が合いません\(manifest 1伝票／取込 0件\)')
PlanReset; $script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 0; executed = $true }; $script:padCalls = @()
$idc2 = Make-Batch 'v24'; $r = Invoke-EcImport $def (Req $idc2 'admin@example.com')
Check '(c) 納品先の件数が合わない: partial・受注は実行しない' ($r.State -eq 'partial' -and $r.Message -match 'nouhin\.txt の件数が合いません\(manifest 1行／取込 0件\)' -and ($script:padCalls -join ',') -eq 'Smile_EC納品先取込')
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 3; errors = 0; executed = $true }
$idc3 = Make-Batch 'v25'; $r = Invoke-EcImport $def (Req $idc3 'admin@example.com')
Check '(c) 件数が多すぎても合わない扱い（partial）' ($r.State -eq 'partial' -and $r.Message -match 'manifest 1伝票／取込 3件')
# 件数を取れない旧形式（imported が無い）は比べない
PlanReset; $script:padPlan['Smile_EC納品先取込'] = @{ errors = 0; executed = $true }; $script:padPlan['Smile_EC受注取込'] = @{ errors = 0; executed = $true }
$idc4 = Make-Batch 'v26'; $r = Invoke-EcImport $def (Req $idc4 'admin@example.com')
Check '(c) 件数なしの旧形式は比べず done' ($r.State -eq 'done')
# (d) 正常 → done
PlanReset; $script:padCalls = @()
$idd = Make-Batch 'v27'; $r = Invoke-EcImport $def (Req $idd 'admin@example.com'); $res = Result $idd 'done'
Check '(d) 正常: done・executed:true・件数が入る' ($r.State -eq 'done' -and $res.state -eq 'done' -and $res.executed -eq $true -and $res.files[0].imported -eq 1 -and $res.files[1].imported -eq 1 -and $res.message -eq '')
Check '(d) 納品先→受注の順に起動' (($script:padCalls -join ',') -eq 'Smile_EC納品先取込,Smile_EC受注取込')
PlanReset

# ===== 受注の取込件数は「伝票の数」（manifest の slips）と比べる（納品先は行数）。PAD が返す受注の imported は SMILE の正常件数＝伝票の数 =====
function ManifestPath([string]$bid) { return (Join-Path $ImportRoot "$bid\manifest.json") }
function EditManifest([string]$bid, [scriptblock]$edit) {
  $mp = ManifestPath $bid; $mo = Get-Content -LiteralPath $mp -Raw -Encoding UTF8 | ConvertFrom-Json; & $edit $mo
  [System.IO.File]::WriteAllText($mp, ($mo | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false))
}
$idm = Make-Batch 'v30'
$mo0 = Get-Content -LiteralPath (ManifestPath $idm) -Raw -Encoding UTF8 | ConvertFrom-Json
$mj0 = @($mo0.files | Where-Object { $_.name -eq 'juchu.txt' })[0]; $mn0 = @($mo0.files | Where-Object { $_.name -eq 'nouhin.txt' })[0]
Check 'manifest: 受注は 2行1伝票（rows=2・slips=1）、納品先は slips なし' ($mj0.rows -eq 2 -and $mj0.slips -eq 1 -and -not ($mn0.PSObject.Properties.Name -contains 'slips'))
# 2行1伝票で imported=1（SMILEの正常件数）→ 取込が成功なら done（今まで「manifest 2行／取込 1件」で partial になっていた）
PlanReset; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $idm 'admin@example.com')
Check '受注 2行1伝票・imported=1 → done' ($r.State -eq 'done' -and (Result $idm 'done').files[1].imported -eq 1)
# imported=0 → partial（メッセージは伝票の数で）
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 0; errors = 0; executed = $true }
$idm2 = Make-Batch 'v31'; $r = Invoke-EcImport $def (Req $idm2 'admin@example.com')
Check '受注 imported=0 → partial・「manifest 1伝票／取込 0件」' ($r.State -eq 'partial' -and $r.Message -match 'manifest 1伝票／取込 0件')
# 行数と同じ 2 を返しても（伝票は1）合わない扱い
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 2; errors = 0; executed = $true }
$idm3 = Make-Batch 'v32'; $r = Invoke-EcImport $def (Req $idm3 'admin@example.com')
Check '受注 imported=2（行数）は伝票の数1と合わない → partial' ($r.State -eq 'partial')
# 旧形式の manifest（slips なし）の受注：件数を比べない（0でも2でも done）。比べなかったことをログに残す
$idm4 = Make-Batch 'v33'; EditManifest $idm4 { param($mo) $mo.files | Where-Object { $_.name -eq 'juchu.txt' } | ForEach-Object { $_.PSObject.Properties.Remove('slips') } }
if (Test-Path $LogPath) { Remove-Item $LogPath -Force }
PlanReset; $script:padPlan['Smile_EC受注取込'] = @{ imported = 0; errors = 0; executed = $true }
$r = Invoke-EcImport $def (Req $idm4 'admin@example.com')
Check '旧形式 manifest（slips なし）の受注は件数を比べず done' ($r.State -eq 'done')
Check '旧形式: 比べなかったことをログに残す' ((Test-Path $LogPath) -and ((Get-Content $LogPath -Raw) -match '取込件数を比べません: juchu\.txt の manifest に slips がありません'))
# 旧形式でも納品先は rows と比べる
PlanReset; $script:padPlan['Smile_EC納品先取込'] = @{ imported = 0; errors = 0; executed = $true }
$idm5 = Make-Batch 'v34'; EditManifest $idm5 { param($mo) $mo.files | Where-Object { $_.name -eq 'juchu.txt' } | ForEach-Object { $_.PSObject.Properties.Remove('slips') } }
$r = Invoke-EcImport $def (Req $idm5 'admin@example.com')
Check '旧形式でも納品先は rows と比べる → partial' ($r.State -eq 'partial' -and $r.Message -match 'nouhin\.txt の件数が合いません\(manifest 1行／取込 0件\)')
# ファイル確認：manifest の slips と、実ファイルの仮の受注№の種類の数が合わなければ SMILE に触らず failed
PlanReset; $script:padCalls = @()
$idm6 = Make-Batch 'v35'; EditManifest $idm6 { param($mo) $mo.files | Where-Object { $_.name -eq 'juchu.txt' } | ForEach-Object { $_.slips = 2 } }
$r = Invoke-EcImport $def (Req $idm6 'admin@example.com'); $res = Result $idm6 'failed'
Check 'manifest の slips と実ファイルの伝票の数が違う → ファイル不整合で failed・SMILE に触らない' ($r.State -eq 'failed' -and $r.Message -match 'ファイル不整合' -and $r.Message -match '伝票の数が 1 です\(manifest の slips は 2\)' -and $script:padCalls.Count -eq 0 -and $res.executed -eq $false)
PlanReset

# 経路2: 取込の途中で常駐スクリプトが止まった（running に残った依頼）
$RunningDir = Join-Path $QueueRoot 'running'; $FailedDir = Join-Path $QueueRoot 'failed'
New-Item -ItemType Directory -Force -Path $RunningDir, $FailedDir, $EcImportCurrentDir | Out-Null
function Get-JobDefinitions { return [pscustomobject]@{ jobs = [pscustomobject]@{ ec_smile_import = $def } } }
$id14 = Make-Batch 'v14'
[IO.File]::WriteAllText((Join-Path $EcImportCurrentDir '受注.txt'), 'お客様のデータ')
[IO.File]::WriteAllText((Join-Path $EcImportCurrentDir 'result_nouhin.json'), '{}')
$q = '20261020T010101000Z_ec_smile_import_ab12.json'
[IO.File]::WriteAllText((Join-Path $RunningDir $q), (@{ job = 'ec_smile_import'; requestedBy = 'admin@example.com'; batchId = $id14; status = 'running' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
Resolve-InterruptedJobs
$res = Result $id14 'failed'
Check '中断: partial・executed のキーなし・理由つきの result.json が failed/ に' ($res.state -eq 'partial' -and -not ($res.PSObject.Properties.Name -contains 'executed') -and $res.message -match '停止した')
Check '中断: 取込フォルダが _rpa_import 直下に残らない（もう一度押しても取り込めない）' (-not (Test-Path (Join-Path $ImportRoot $id14)))
Check '中断: 固定フォルダの顧客データを消す' (-not (Test-Path (Join-Path $EcImportCurrentDir '受注.txt')) -and -not (Test-Path (Join-Path $EcImportCurrentDir 'result_nouhin.json')))
Check '中断: 依頼ファイルは failed に移る' ((Test-Path (Join-Path $FailedDir $q)) -and -not (Test-Path (Join-Path $RunningDir $q)))
# 中断された取込と同じバッチを再実行しようとしても、executed が不明なので止まる
$null = Make-Batch 'v14'; $script:padCalls = @()
$r = Invoke-EcImport $def (Req $id14 'admin@example.com')
Check '中断のあとの再実行: SMILEに触らず partial で止まる' ($r.State -eq 'partial' -and $script:padCalls.Count -eq 0)
# 取込ではない依頼（batchId なし）は従来どおり failed に移すだけ
$q2 = '20261020T010102000Z_facts_only_ab12.json'
[IO.File]::WriteAllText((Join-Path $RunningDir $q2), '{"job":"facts_only"}', (New-Object System.Text.UTF8Encoding $false))
function Get-JobDefinitions { return [pscustomobject]@{ jobs = [pscustomobject]@{ facts_only = [pscustomobject]@{ after = 'regenerate_facts' } } } }
Resolve-InterruptedJobs
Check '中断: 取込以外の依頼は従来どおり failed へ' (Test-Path (Join-Path $FailedDir $q2))

# 10. 確認用出力の依頼追加（重複しない）
Add-VerifyRequest 'ec_smile_verify_export' 'admin@example.com'; Add-VerifyRequest 'ec_smile_verify_export' 'admin@example.com'
$pend = @(Get-ChildItem $PendingDir -Filter '*.json')
Check '確認用出力の依頼は1件だけ追加される' ($pend.Count -eq 1 -and $pend[0].Name -match '^\d{8}T\d{9}Z_ec_smile_verify_export_[0-9a-f]{4}\.json$')
# 11. 30日たった done/failed を消す
(Get-Item (Join-Path $ImportRoot "done\$id")).LastWriteTime = (Get-Date).AddDays(-31)
Remove-OldImports
Check '30日を過ぎた done は消える' (-not (Test-Path (Join-Path $ImportRoot "done\$id")))
Write-Host "失敗: $fail"
